#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, tab, deferred, plain } from './lifecycle-fixture.mjs';
const work = (f, windowId = 1) => f.send({ type: 'active-work-tab', windowId });
test('active work context is owned-top-only, read-only and reports live groupId', async () => {
  const f = fixture([tab(1, { active: true }), tab(2)]);
  assert.equal((await f.send({ type: 'active-work-tab' }, {})).ok, false);
  const before = plain([...f.tabs.values()]); const r = await work(f); assert.deepEqual(r, { ok: true, tabId: 1, windowId: 1, groupId: 10, mode: 'active' });
  f.tabs.get(1).groupId = 12; assert.equal((await work(f)).groupId, 12); assert.deepEqual(f.calls.move, []); assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.group, []); assert.equal(before[0].id, [...f.tabs.values()][0].id);
});
test('home/newtab returns observed recent work; remove/move invalidate old window and use actual live context', async () => {
  const f = fixture([tab(1), tab(2, { url: 'chrome-extension://lifecycle/home.html' }), tab(3, { windowId: 2, active: true, groupId: 20 })]);
  await f.activate(1); await f.activate(2); assert.equal((await work(f)).tabId, 1); assert.equal((await work(f)).mode, 'recent');
  f.tabs.get(1).windowId = 2; await f.chrome.tabs.onDetached.emit(1, { oldWindowId: 1 }); assert.equal((await work(f)).mode, 'none');
  f.focus(2); await f.chrome.windows.onFocusChanged.emit(2); assert.equal((await work(f, null)).tabId, 3);
  f.tabs.delete(3); await f.chrome.tabs.onRemoved.emit(3); assert.notEqual((await work(f, 2)).tabId, 3);
});
test('first recent fallback uses valid real lastAccessed only, never LLM lastContext', async () => {
  const f = fixture([tab(1, { lastAccessed: 100 }), tab(2, { lastAccessed: 200 }), tab(3, { active: true, url: 'chrome://newtab/' }), tab(4, { lastAccessed: Infinity })]);
  f.stores.session.lastContext = { activeUrl: 'https://fake.test', tabId: 1 };
  assert.deepEqual(await work(f), { ok: true, tabId: 2, windowId: 1, groupId: 10, mode: 'recent' });
  f.tabs.get(2).url = 'chrome-extension://lifecycle/search.html'; await f.chrome.tabs.onUpdated.emit(2, { url: f.tabs.get(2).url }, structuredClone(f.tabs.get(2))); assert.equal((await work(f)).tabId, 1);
  f.tabs.get(1).lastAccessed = undefined; f.tabs.delete(2); f.restart({ browser: true }); assert.equal((await work(f)).mode, 'none');
});
test('slow stale activation cannot overwrite newer observation, request order and tab strip stay unchanged', async () => {
  const f = fixture([tab(1), tab(2), tab(3, { url: 'chrome://newtab/' })]); const gate = deferred(), entered = deferred(); let delayed = false;
  f.hooks.beforeGet = async id => { if (id === 1 && !delayed) { delayed = true; entered.resolve(); await gate.promise; } };
  const old = f.activate(1); await entered.promise; const newer = f.activate(2); gate.resolve(); await Promise.all([old, newer]); await f.activate(3);
  assert.equal((await work(f)).tabId, 2); assert.deepEqual([...f.tabs.keys()], [1, 2, 3]); assert.deepEqual(f.calls.move, []);
});
test('repeated read RPCs do not emit self-triggering activeWorkTabs storage changes', async () => {
  const f = fixture([tab(1, { active: true })]); let writes = 0;
  f.hooks.beforeSet = (area, value) => { if (area === 'session' && value.activeWorkTabs) writes++; };
  await work(f); f.tick(10); await work(f); f.tick(10); await f.activate(1); assert.equal(writes, 1);
  f.restart(); await work(f); assert.equal(writes, 1);
});
