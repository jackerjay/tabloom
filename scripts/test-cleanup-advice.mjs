#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, tab } from './lifecycle-fixture.mjs';
const DAY = 86400000;
test('cleanup requires owned top extension page and never calls destructive/model APIs', async () => {
  const f = fixture();
  for (const sender of [{}, { id: 'lifecycle', url: 'https://example.test', frameId: 0 }, { id: 'lifecycle', url: 'chrome-extension://lifecycle/search.html?embedded=x', frameId: 2 }]) assert.equal((await f.send({ type: 'cleanup-advice' }, sender)).ok, false);
  const r = await f.send({ type: 'cleanup-advice', windowId: 1 });
  assert.equal(r.ok, true); assert.equal(r.basis, 'lastAccessed'); assert.equal(r.thresholdDays, 7);
  assert.deepEqual(f.calls.remove, []); assert.deepEqual(f.calls.fetch, []);
});
test('7-day boundary, exclusions and unknown timestamps are honest and window scoped', async () => {
  const f = fixture([]); const now = f.now();
  const rows = [tab(1, { lastAccessed: now - 7 * DAY }), tab(2, { lastAccessed: now - 7 * DAY + 1 }), ...['active', 'pinned', 'audible'].map((key, i) => tab(3 + i, { [key]: true, lastAccessed: now - 20 * DAY })), ...[undefined, null, '123', NaN, Infinity, -1, now + 1].map((lastAccessed, i) => tab(10 + i, { lastAccessed })), tab(20, { url: 'chrome://settings/', lastAccessed: now - 9 * DAY }), tab(21, { windowId: 2, lastAccessed: now - 9 * DAY })];
  rows.forEach(t => f.tabs.set(t.id, t));
  const r = await f.send({ type: 'cleanup-advice', windowId: 1 });
  assert.equal(r.eligibleCount, 1); assert.equal(r.unknownCount, 7); assert.equal(r.candidates[0].id, 1); assert.equal(r.candidates[0].idleDays, 7); assert.equal(r.evaluatedAt, now);
  assert.equal(f.stores.session.lastCleanupAdvice.basis, 'lastAccessed');
  assert.equal((await f.send({ type: 'cleanup-advice', windowId: '1' })).ok, false);
});
test('cached successful organize includes advice in result and lastRun without changing model payload or undo', async () => {
  const f = fixture([tab(1, { lastAccessed: 1 })]); f.stores.session.undo = { keep: true };
  f.hooks.fetchResult = { source: 'ai', groups: [{ name: 'Research', color: 'purple', tabIds: [1] }], cache: { hits: 1, misses: 0, hitTabIds: [1] } };
  const r = await f.send({ type: 'organize', windowId: 1, apply: true }); assert.equal(r.ok, true); assert.equal(r.empty, true); assert.equal(r.cleanup.eligibleCount, 1); assert.equal(f.stores.session.lastRun.cleanup.basis, 'lastAccessed'); assert.deepEqual(f.stores.session.undo, { keep: true });
  const payload = JSON.parse(f.calls.fetch[0].body); assert.equal(payload.cleanup, undefined); assert.equal(payload.tabs[0].lastAccessed, undefined); assert.deepEqual(Object.keys(payload).sort(), ['context', 'existingGroups', 'language', 'mode', 'tabs']);
});
test('bounded oldest-first advice and empty organize share original target window without model calls', async () => {
  const f = fixture([]); for (let i = 1; i <= 70; i++) f.tabs.set(i, tab(i, { lastAccessed: f.now() - (8 + i) * DAY }));
  const r = await f.send({ type: 'cleanup-advice', windowId: 1 }); assert.equal(r.eligibleCount, 70); assert.equal(r.candidates.length, 50); assert.equal(r.candidates[0].id, 70);
  f.tabs.clear(); const empty = await f.send({ type: 'organize', windowId: 2, apply: true }); assert.equal(empty.ok, true); assert.equal(empty.empty, true); assert.equal(empty.cleanup.windowId, 2); assert.equal(empty.cleanup.eligibleCount, 0); assert.equal(f.stores.session.lastCleanupAdvice.windowId, 2); assert.equal(f.calls.fetch.length, 0);
});

test('cleanup-close removes eligible idle tabs and refreshes advice while shielding active/pinned/audible', async () => {
  const f = fixture([]); const now = f.now();
  [
    tab(1, { lastAccessed: now - 10 * DAY }),
    tab(2, { active: true, lastAccessed: now - 15 * DAY }),
    tab(3, { pinned: true, lastAccessed: now - 15 * DAY }),
    tab(4, { audible: true, lastAccessed: now - 15 * DAY }),
    tab(5, { lastAccessed: now - 2 * DAY }),
  ].forEach(t => f.tabs.set(t.id, t));
  const res = await f.send({ type: 'cleanup-close', windowId: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.closed, 1);
  assert.deepEqual(f.calls.remove, [1]);
  assert.equal(res.advice.eligibleCount, 0);
});

test('discard-tabs hibernates eligible inactive tabs and autoDiscard threshold normalizes [5, 43200]', async () => {
  const f = fixture([]); const now = f.now();
  const discarded = [];
  f.chrome.tabs.discard = async id => { discarded.push(id); f.tabs.get(id).discarded = true; return f.tabs.get(id); };
  [
    tab(1, { lastAccessed: now - 90 * 60_000 }),
    tab(2, { active: true, lastAccessed: now - 90 * 60_000 }),
    tab(3, { pinned: true, lastAccessed: now - 90 * 60_000 }),
    tab(4, { discarded: true, lastAccessed: now - 90 * 60_000 }),
    tab(5, { lastAccessed: now - 10 * 60_000 }),
  ].forEach(t => f.tabs.set(t.id, t));
  const res = await f.send({ type: 'discard-tabs', windowId: 1, minIdleMinutes: 60 });
  assert.equal(res.ok, true);
  assert.equal(res.discarded, 1);
  assert.deepEqual(discarded, [1]);
  assert.equal(f.context.normalizeAutoDiscardMinutes(4), 60);
  assert.equal(f.context.normalizeAutoDiscardMinutes(120), 120);
  assert.equal(f.context.normalizeAutoDiscardMinutes(43200), 43200);
  assert.equal(f.context.normalizeAutoDiscardMinutes(43201), 60);
});
