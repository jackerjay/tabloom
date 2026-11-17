#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, tab } from './lifecycle-fixture.mjs';
const close = (f, extra = {}) => f.send({ type: 'group-archive-close', groupIds: [10], windowId: 1, ...extra });
const restore = (f, id, extra = {}) => f.send({ type: 'group-archive-restore', id, ...extra });
test('archives authenticate and reject fake, missing, cross-window IDs and unsafe URLs before persistence/removal', async () => {
  const f = fixture();
  assert.equal((await f.send({ type: 'group-archive-close', groupIds: [10] }, {})).ok, false);
  for (const groupIds of [[-1], ['10'], [999], [], Array.from({ length: 51 }, (_, i) => i)]) assert.equal((await close(f, { groupIds })).ok, false);
  assert.equal((await close(f, { windowId: 2 })).ok, false);
  f.tabs.get(1).url = 'javascript:alert(1)'; assert.equal((await close(f)).ok, false); assert.deepEqual(f.calls.remove, []);
  for (const type of ['group-archive-list', 'group-archive-restore', 'group-archive-delete']) assert.equal((await f.send({ type, id: 'x' }, {})).ok, false);
});
test('persist failure/quota limits refuse close, preserving undo/space/history', async () => {
  const f = fixture(); f.stores.session.undo = { keep: true }; f.stores.local.spaces = [{ id: 'keep' }]; f.stores.local.orgHistory = [{ id: 'keep' }];
  f.hooks.beforeSet = (area, values) => { if (area === 'local' && values.groupArchives) throw Error('disk full'); };
  assert.equal((await close(f)).ok, false); assert.deepEqual(f.calls.remove, []);
  delete f.hooks.beforeSet; f.stores.local.groupArchives = Array.from({ length: 20 }, (_, i) => ({ id: String(i), groups: [] }));
  assert.equal((await close(f)).ok, false); assert.deepEqual(f.calls.remove, []); assert.deepEqual(f.stores.session.undo, { keep: true }); assert.deepEqual(f.stores.local.spaces, [{ id: 'keep' }]); assert.deepEqual(f.stores.local.orgHistory, [{ id: 'keep' }]);
});
test('full snapshot precedes removal; duplicate concurrent close/restore perform once with ordered metadata', async () => {
  const f = fixture([tab(1, { url: 'chrome://settings/' }), tab(2)]); let persisted = false;
  f.hooks.afterSet = (area, values) => { if (area === 'local' && values.groupArchives?.length) persisted = true; };
  f.hooks.beforeRemove = () => assert.equal(persisted, true);
  const [a, b] = await Promise.all([close(f), close(f)]); assert.equal(a.ok, true); assert.equal(a.id, b.id); assert.equal(a.closedTabs, 2); assert.equal(a.closedGroups, 1); assert.deepEqual(f.calls.remove, [1, 2]);
  const list = await f.send({ type: 'group-archive-list' }); assert.equal(list.archives[0].tabCount, 2); assert.equal(list.archives[0].groups[0].title, 'Research'); assert.equal(list.archives[0].groups[0].tabs, undefined);
  const [r, s] = await Promise.all([restore(f, a.id, { targetWindowId: 2 }), restore(f, a.id, { targetWindowId: 2 })]); assert.equal(r.ok, true); assert.deepEqual(r, s); assert.equal(r.restoredTabs, 2); assert.equal(r.restoredGroups, 1);
  assert.equal(f.calls.create.length, 2); assert.ok(f.calls.create.every(t => t.active === false && t.windowId === 2)); const g = [...f.groups.values()][0]; assert.equal(g.title, 'Research'); assert.equal(g.color, 'purple'); assert.equal(g.collapsed, true); assert.deepEqual([...f.tabs.values()].map(t => t.url), ['chrome://settings/', 'https://example.test/2']);
  assert.equal((await f.send({ type: 'group-archive-list' })).archives.length, 0); assert.equal((await restore(f, a.id)).ok, false);
});
test('partial close and stale moved/new members never close or recreate live tabs', async () => {
  const f = fixture([tab(1), tab(2), tab(3)]);
  let changed = false; f.hooks.afterSet = (area, values) => { if (area === 'local' && values.groupArchives?.length && !changed) { changed = true; f.tabs.get(2).windowId = 2; f.tabs.get(2).groupId = 20; f.groups.set(20, { id: 20, windowId: 2, title: 'Moved', color: 'red' }); f.tabs.set(9, tab(9)); } };
  f.hooks.beforeRemove = id => { if (id === 3) throw Error('remove denied'); };
  const a = await close(f); assert.equal(a.ok, true); assert.equal(a.partial, true); assert.equal(a.closedTabs, 1); assert.deepEqual(f.calls.remove, [1, 3]); assert.ok(f.tabs.has(2) && f.tabs.has(3) && f.tabs.has(9));
  delete f.hooks.beforeRemove; const r = await restore(f, a.id); assert.equal(r.ok, true); assert.equal(r.restoredTabs, 1); assert.equal(f.calls.create.length, 1); assert.equal(f.tabs.get(2).windowId, 2); assert.equal(f.tabs.get(9).groupId, 10);
});
test('failed restore retains journal; retry after worker restart reuses only its inactive tabs without duplicates', async () => {
  const f = fixture(); const a = await close(f);
  f.hooks.beforeGroup = () => { throw Error('group denied'); };
  const fail = await restore(f, a.id); assert.equal(fail.ok, false); assert.ok(f.stores.local.groupArchives.some(x => x.id === a.id)); assert.equal(f.calls.create.length, 2);
  delete f.hooks.beforeGroup; f.restart(); const r = await restore(f, a.id); assert.equal(r.ok, true); assert.equal(r.restoredTabs, 2); assert.equal(f.calls.create.length, 2);
});
test('interruption before mapping commit recovers unique placeholder; original IDs are never trusted after browser restart', async () => {
  const f = fixture(); const a = await close(f); let failed = false;
  f.hooks.beforeSet = (area, values) => { if (area === 'local' && values.groupArchives?.[0]?.restore?.mapping && Object.keys(values.groupArchives[0].restore.mapping).length && !failed) { failed = true; throw Error('journal denied'); } };
  const fail = await restore(f, a.id); assert.equal(fail.ok, false); assert.equal(f.calls.create.length, 1);
  delete f.hooks.beforeSet; f.restart(); assert.equal((await restore(f, a.id)).ok, true); assert.equal(f.calls.create.length, 2);
  const g = fixture(); const b = await close(g); g.restart({ browser: true }); g.tabs.set(1, tab(1, { url: 'https://unrelated.test/' })); assert.equal((await restore(g, b.id)).restoredTabs, 2); assert.equal(g.tabs.get(1).url, 'https://unrelated.test/');
});
test('create with uncommitted blank URL and pending marker still navigates every real saved link', async () => {
  for (const provisionalUrl of ['about:blank', '']) {
    const f = fixture(); const a = await close(f); const create = f.chrome.tabs.create;
    f.chrome.tabs.create = async props => { const t = await create(props); Object.assign(t, { url: provisionalUrl, pendingUrl: props.url, status: 'loading' }); Object.assign(f.tabs.get(t.id), t); return t; };
    f.hooks.beforeUpdate = id => { delete f.tabs.get(id).pendingUrl; };
    const r = await restore(f, a.id); assert.equal(r.ok, true); assert.equal(r.restoredTabs, 2);
    assert.deepEqual(f.calls.update.map(t => t.url), ['https://example.test/1', 'https://example.test/2']); assert.deepEqual([...f.tabs.values()].map(t => t.url), ['https://example.test/1', 'https://example.test/2']);
  }
});
test('retry accepts mapped provisional blank plus pending marker without creating duplicates', async () => {
  for (const provisionalUrl of ['about:blank', '']) {
    const f = fixture([tab(1)]); const a = await close(f); const create = f.chrome.tabs.create;
    f.chrome.tabs.create = async props => { const t = await create(props); Object.assign(t, { url: provisionalUrl, pendingUrl: props.url, status: 'loading' }); Object.assign(f.tabs.get(t.id), t); return t; };
    f.hooks.beforeUpdate = () => { throw Error('navigation denied'); };
    const fail = await restore(f, a.id); assert.equal(fail.ok, false); assert.ok(f.stores.local.groupArchives.some(t => t.id === a.id));
    f.hooks.beforeUpdate = id => { delete f.tabs.get(id).pendingUrl; }; f.restart(); const r = await restore(f, a.id); assert.equal(r.ok, true); assert.equal(f.calls.create.length, 1); assert.equal([...f.tabs.values()][0].url, 'https://example.test/1');
  }
});
test('restore preserves separate same-name native groups, order, original positions and collapsed state', async () => {
  const f = fixture([tab(9, { pinned: true, groupId: -1, index: 0 }), tab(1, { index: 1 }), tab(2, { index: 2 }), tab(3, { index: 3, groupId: 20 }), tab(4, { index: 4, groupId: 20 })], [{ id: 10, windowId: 1, title: 'Same', color: 'red', collapsed: true }, { id: 20, windowId: 1, title: 'Same', color: 'blue', collapsed: false }]);
  const a = await close(f, { groupIds: [20, 10] }); const r = await restore(f, a.id); assert.equal(r.restoredGroups, 2);
  const restored = [...f.tabs.values()].filter(t => !t.pinned).sort((a, b) => a.index - b.index); assert.deepEqual(restored.map(t => t.url), [1, 2, 3, 4].map(i => `https://example.test/${i}`)); assert.notEqual(restored[0].groupId, restored[2].groupId); assert.equal(f.groups.get(restored[0].groupId).collapsed, true); assert.equal(f.groups.get(restored[2].groupId).color, 'blue'); assert.deepEqual(f.calls.move.map(c => c.index), [1, 3]); assert.equal(f.tabs.get(9).index, 0);
});
test('membership changing during persistence is revalidated immediately before remove', async () => {
  const f = fixture(); let changed = false;
  f.hooks.afterSet = (area, value) => { if (area === 'local' && value.groupArchives?.[0]?.groups[0].tabs[0].state === 'closing' && !changed) { changed = true; f.tabs.get(1).groupId = -1; } };
  const a = await close(f); assert.equal(a.closedTabs, 1); assert.deepEqual(f.calls.remove, [2]); assert.equal((await restore(f, a.id)).restoredTabs, 1); assert.equal(f.tabs.get(1).groupId, -1);
});
test('total tab and UTF-8 byte bounds refuse before any destructive operation', async () => {
  const f = fixture(); f.stores.local.groupArchives = [{ id: 'old', groups: [{ tabs: Array.from({ length: 2000 }, (_, i) => ({ id: i, url: 'https://old.test' })) }] }]; assert.equal((await close(f)).ok, false); assert.deepEqual(f.calls.remove, []);
  f.stores.local.groupArchives = []; f.tabs.get(1).title = '界'.repeat(3_000_000); assert.equal((await close(f)).ok, false); assert.deepEqual(f.calls.remove, []);
});
test('restoration suppresses only its own auto work, survives worker restart, and genuine navigation resumes scheduling', async () => {
  const f = fixture(); await f.enableAuto(); const settings = structuredClone(f.stores.sync.settings); const a = await close(f); assert.equal((await restore(f, a.id)).ok, true); assert.deepEqual(f.stores.sync.settings, settings); assert.equal(f.calls.fetch.length, 0); assert.equal(Object.values(f.stores.session.autoOrganizeState.tabs).filter(t => t.dirty).length, 0);
  f.restart(); await f.ready(); assert.equal(Object.values(f.stores.session.autoOrganizeState.tabs).filter(t => t.dirty).length, 0);
  const first = [...f.tabs.values()][0]; await f.chrome.tabs.update(first.id, { url: 'https://changed.test' }); assert.equal(f.stores.session.autoOrganizeState.tabs[first.id].dirty, true); assert.equal(f.stores.session.archiveRestoredTabs[first.id], undefined);
});
test('initial provisional URL and redirects never trigger auto work; retry keeps redirected restored links', async () => {
  const f = fixture([tab(1)]); await f.enableAuto(); const a = await close(f);
  f.hooks.beforeUpdate = async (id, props) => {
    if (!props.url) return; const t = f.tabs.get(id); t.pendingUrl = props.url; t.status = 'loading';
    await f.chrome.tabs.onUpdated.emit(id, { status: 'loading' }, structuredClone(t));
  };
  f.hooks.beforeGroup = () => { throw Error('group denied'); }; assert.equal((await restore(f, a.id)).ok, false);
  const t = [...f.tabs.values()][0]; t.url = 'https://redirected.test/final'; delete t.pendingUrl; t.status = 'complete'; await f.chrome.tabs.onUpdated.emit(t.id, { url: t.url, status: 'complete' }, structuredClone(t));
  assert.equal(Object.values(f.stores.session.autoOrganizeState.tabs).filter(row => row.dirty).length, 0);
  delete f.hooks.beforeGroup; assert.equal((await restore(f, a.id)).ok, true); assert.equal(f.calls.create.length, 1); assert.equal(t.url, 'https://redirected.test/final'); assert.equal(f.calls.fetch.length, 0);
});
test('placeholder completion does not end initial auto suppression before real saved navigation', async () => {
  const f = fixture([tab(1)]); await f.enableAuto(); const a = await close(f); let completed = false;
  f.hooks.afterSet = async (area, values) => {
    if (area !== 'session' || !values.archiveRestoredTabs || completed) return;
    completed = true; const t = [...f.tabs.values()][0]; t.status = 'complete'; await f.chrome.tabs.onUpdated.emit(t.id, { status: 'complete' }, structuredClone(t));
  };
  f.hooks.beforeUpdate = async (id, props) => {
    if (!props.url) return; const t = f.tabs.get(id); t.pendingUrl = props.url; t.status = 'loading'; await f.chrome.tabs.onUpdated.emit(id, { status: 'loading' }, structuredClone(t));
  };
  const r = await restore(f, a.id); assert.equal(r.ok, true); assert.equal(Object.values(f.stores.session.autoOrganizeState.tabs).filter(t => t.dirty).length, 0); assert.ok(f.stores.session.archiveRestoredTabs[100]);
});
test('worker startup with completed placeholder keeps initial auto suppression until saved URL loads', async () => {
  const f = fixture([tab(1)]); await f.enableAuto(); const a = await close(f); f.hooks.beforeUpdate = () => { throw Error('navigation denied'); };
  assert.equal((await restore(f, a.id)).ok, false); const t = [...f.tabs.values()][0]; t.status = 'complete'; f.restart(); await f.ready(); assert.equal(f.stores.session.archiveRestoredTabs[t.id].initialLoad, true);
  delete f.hooks.beforeUpdate; assert.equal((await restore(f, a.id)).ok, true); assert.equal(Object.values(f.stores.session.autoOrganizeState.tabs).filter(t => t.dirty).length, 0);
});
test('partial restore is not resumed by unsafe recycled IDs across browser sessions; archive remains', async () => {
  const f = fixture(); const a = await close(f); f.hooks.beforeGroup = () => { throw Error('denied'); }; await restore(f, a.id); delete f.hooks.beforeGroup; f.restart({ browser: true });
  const r = await restore(f, a.id); assert.equal(r.ok, false); assert.equal(r.partial, true); assert.ok(f.stores.local.groupArchives.some(x => x.id === a.id)); assert.equal(f.calls.create.length, 2);
});
