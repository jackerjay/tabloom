#!/usr/bin/env node
// Focused, offline regression proof: no server, browser, dependencies or disk writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  auditGroupAggregation,
  buildBatchPrefixClusters,
  clusterTabsByContentTheme,
  consolidateAndAuditGroups,
  distillGroupProfiles,
  extractSystemTokens,
  extractUrlProfile,
  inferTabContentTopic,
  isGenericDomainGroupName,
  normalizeAggregationRules,
  resolveTabAggregationIdentity,
  suggestLabelForTabs,
} from '../server/tab-intelligence.mjs';

const serverSource = readFileSync(new URL('../server/server.mjs', import.meta.url), 'utf8');
const backgroundSource = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const server = vm.createContext({
  URL,
  auditGroupAggregation,
  buildBatchPrefixClusters,
  clusterTabsByContentTheme,
  consolidateAndAuditGroups,
  distillGroupProfiles,
  extractSystemTokens,
  extractUrlProfile,
  inferTabContentTopic,
  isGenericDomainGroupName,
  normalizeAggregationRules,
  resolveTabAggregationIdentity,
  suggestLabelForTabs,
});
vm.runInContext(
  serverSource.slice(serverSource.indexOf('const COLORS ='), serverSource.indexOf('/* ---------------- ACP'))
  + serverSource.slice(serverSource.indexOf('function normUrl('), serverSource.indexOf('/* ---------------- 业务入口'))
  + serverSource.slice(serverSource.indexOf('function buildMessages('), serverSource.indexOf('async function callModel(')), server);
const plain = value => JSON.parse(JSON.stringify(value));
const tab = (id, groupId = -1, extra = {}) => ({ id, groupId, windowId: 1, title: `Tab ${id}`, url: `https://example.com/${id}`, pinned: false, active: false, ...extra });

function fixture(initialTabs, initialGroups = []) {
  let tabs = structuredClone(initialTabs);
  const groups = new Map(initialGroups.map(g => [g.id, { windowId: 1, color: 'grey', collapsed: false, title: '', ...g }]));
  let nextId = 100;
  const calls = [], moves = [], groupMoves = [], warnings = [], stores = { session: {}, local: {}, sync: {} };
  const reindex = () => tabs.forEach((t, index) => { t.index = index; });
  const gc = () => { for (const id of groups.keys()) if (!tabs.some(t => t.groupId === id)) groups.delete(id); };
  const get = id => { const t = tabs.find(t => t.id === id); if (!t) throw Error(`missing tab ${id}`); return t; };
  const event = { addListener() {} };
  const storage = Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); },
    async set(value) { Object.assign(data, structuredClone(value)); },
    async remove(key) { delete data[key]; },
  }]));
  const chrome = {
    storage,
    tabs: {
      async query({ windowId, groupId } = {}) { return structuredClone(tabs.filter(t => (windowId == null || t.windowId === windowId) && (groupId == null || t.groupId === groupId))); },
      async get(id) { return structuredClone(get(id)); },
      async ungroup(ids) { ids.forEach(id => { get(id).groupId = -1; }); gc(); },
      async group({ tabIds, groupId, createProperties }) {
        if (groupId == null) { groupId = nextId++; groups.set(groupId, { id: groupId, windowId: createProperties.windowId, title: '', color: 'grey', collapsed: false }); }
        if (!groups.has(groupId)) throw Error(`missing group ${groupId}`);
        // Chrome keeps grouped tabs adjacent; regrouping can shift strip indices.
        const selected = tabIds.map(get);
        const first = tabs.findIndex(t => tabIds.includes(t.id));
        const before = tabs.slice(0, first).filter(t => !tabIds.includes(t.id)).length;
        const remaining = tabs.filter(t => !tabIds.includes(t.id));
        const members = remaining.map((t, i) => t.groupId === groupId ? i : -1).filter(i => i !== -1);
        const insertAt = members.length ? members.at(-1) + 1 : before;
        selected.forEach(t => { t.groupId = groupId; });
        remaining.splice(insertAt, 0, ...selected);
        tabs = remaining; reindex(); gc(); return groupId;
      },
      async move(id, { index }) {
        const t = get(id), oldGroup = t.groupId;
        const members = tabs.filter(member => oldGroup !== -1 && member.groupId === oldGroup);
        const insideOldGroup = members.length && index >= members[0].index && index <= members.at(-1).index;
        moves.push({ id, index, pinned: t.pinned, oldGroup, insideOldGroup: !!insideOldGroup });
        tabs.splice(tabs.indexOf(t), 1);
        // Model Chrome's relevant side effect: leaving a group's range ungroups
        // the tab, and inserting inside another group joins that group.
        if (!insideOldGroup) {
          const left = tabs[index - 1], right = tabs[index];
          t.groupId = left && right && left.groupId === right.groupId ? left.groupId : -1;
        }
        tabs.splice(index, 0, t); reindex(); gc(); return structuredClone(t);
      },
      onCreated: event, onRemoved: event, onUpdated: event,
    },
    tabGroups: {
      async query({ windowId }) { return structuredClone([...groups.values()].filter(g => g.windowId === windowId)); },
      async update(id, props) { if (!groups.has(id)) throw Error(`missing group ${id}`); Object.assign(groups.get(id), props); },
      async move(id, { index }) {
        if (!groups.has(id)) throw Error(`missing group ${id}`);
        groupMoves.push({ id, index });
        const members = tabs.filter(t => t.groupId === id);
        tabs = tabs.filter(t => t.groupId !== id);
        tabs.splice(index, 0, ...members); reindex();
        return structuredClone(groups.get(id));
      },
    },
    scripting: { async executeScript({ target }) { calls.push(target.tabId); return [{ result: { text: `snippet ${target.tabId}` } }]; } },
    bookmarks: { async getTree() { return []; } },
    action: { async setBadgeText({ text }) { stores.badge = text; }, async setBadgeBackgroundColor() {} },
    runtime: { onMessage: event, onInstalled: event },
    alarms: { onAlarm: event },
    windows: { async getLastFocused() { return { id: 1 }; } },
  };
  reindex();
  const context = vm.createContext({ chrome, console: { ...console, warn: (...args) => warnings.push(args) }, URL, AbortController,
    // Successful scripting calls settle immediately; no real 3-second timers.
    setTimeout: () => 0, clearTimeout() {} });
  vm.runInContext(backgroundSource, context);
  return { context, chrome, stores, calls, moves, groupMoves, warnings, groups,
    tabs: () => structuredClone(tabs),
    close(id) { tabs = tabs.filter(t => t.id !== id); reindex(); gc(); },
  };
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function layout(f) {
  return f.tabs().map(t => ({ id: t.id, index: t.index, group: t.groupId === -1 ? null : (({ title, color, collapsed }) => ({ title, color, collapsed }))(f.groups.get(t.groupId)) }));
}

test('same URL across model groups moves IDs, including missing-ID fallback', () => {
  const tabs = [tab(1, -1, { url: 'https://example.com/a#one' }), tab(2, -1, { url: 'https://example.com/a#two' }), tab(3)];
  const out = plain(server.sanitize([{ name: 'A', color: 'blue', tabIds: [1] }, { name: 'B', color: 'red', tabIds: [2, 3] }], tabs));
  assert.deepEqual(out[0].tabIds, [1, 2]);
  assert.deepEqual(out.flatMap(g => g.tabIds).sort(), [1, 2, 3]);
  const missing = plain(server.sanitize([{ name: 'A', tabIds: [1] }], tabs));
  assert.deepEqual(missing[0].tabIds, [1, 2]);
  assert.deepEqual(missing.flatMap(g => g.tabIds).sort(), [1, 2, 3]);
});

test('heuristic groups with conflicting bookmark paths keep duplicate URLs', () => {
  const out = plain(server.heuristicGroups([tab(1, -1, { bookmarkPath: 'A', url: 'https://x.test/a#x' }), tab(2, -1, { bookmarkPath: 'B', url: 'https://x.test/a#y' })]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].tabIds, [1, 2]);
});

test('MAX_GROUPS merging preserves every unique ID', () => {
  const tabs = Array.from({ length: 15 }, (_, i) => tab(i + 1));
  const out = plain(server.sanitize(tabs.map(t => ({ name: String(t.id), tabIds: [t.id] })), tabs));
  assert.equal(out.length, 10);
  assert.deepEqual(out.flatMap(g => g.tabIds).sort((a, b) => a - b), tabs.map(t => t.id));
});

test('proposal undo recreates destroyed groups, metadata, order, ungrouped tabs', async () => {
  const f = fixture([tab(1, 10), tab(2, 10), tab(3), tab(4, 20)], [
    { id: 10, title: 'Original', color: 'purple', collapsed: true },
    { id: 20, title: 'Original', color: 'orange', collapsed: false },
  ]);
  const before = layout(f);
  const snap = await f.context.applyProposal({ windowId: 1, groups: [{ name: 'New', color: 'blue', tabIds: [4, 2, 1, 3] }] });
  assert.equal(snap.version, 2);
  assert.deepEqual(plain(snap.groups).map(g => g.index), [0, 3]);
  assert.equal(f.groups.has(10), false);
  assert.equal(f.groups.has(20), false);
  await f.context.undo();
  assert.deepEqual(layout(f), before);
  assert.notEqual(f.tabs()[0].groupId, f.tabs()[3].groupId, 'same names must not merge original groups');
  assert.equal(f.stores.session.undo, undefined);
});

test('drag undo uses metadata snapshot and skips closed tabs', async () => {
  const f = fixture([tab(1, 10), tab(2), tab(3)], [{ id: 10, title: 'Only', color: 'red', collapsed: true }]);
  await f.context.dragTabMove({ tabId: 1, groupId: null, windowId: 1 });
  assert.equal(f.groups.has(10), false);
  assert.equal(f.stores.local.orgHistory[0].snapshot.version, 2);
  f.close(3);
  await f.context.undo();
  assert.equal(f.groups.get(f.tabs()[0].groupId).title, 'Only');
  assert.equal(f.groups.get(f.tabs()[0].groupId).collapsed, true);
  assert.equal(f.tabs()[1].groupId, -1);
});

test('legacy array snapshots restore membership/order even when old group died', async () => {
  const f = fixture([tab(3, 90), tab(2, 90), tab(1, 90)], [{ id: 90, title: 'Current' }]);
  const restored = await f.context.applySnapshot([{ tabId: 1, groupId: 10, index: 0 }, { tabId: 2, groupId: 10, index: 1 }, { tabId: 3, groupId: -1, index: 2 }], 1);
  assert.deepEqual(f.tabs().map(t => t.id), [1, 2, 3]);
  assert.equal(f.tabs()[0].groupId, f.tabs()[1].groupId);
  assert.notEqual(f.tabs()[0].groupId, -1);
  assert.equal(f.tabs()[2].groupId, -1);
  assert.deepEqual(plain(restored), { groups: 1, tabs: 3 });
});

test('history rollback reports restored counts, strips snapshot in lists, is undoable', async () => {
  const f = fixture([tab(1, 10), tab(2, 20), tab(3)], [{ id: 10, title: 'A', color: 'red' }, { id: 20, title: 'B', color: 'green', collapsed: true }]);
  const original = layout(f);
  const snapshot = await f.context.applyProposal({ windowId: 1, groups: [{ name: 'New', color: 'blue', tabIds: [3, 2, 1] }] });
  const applied = layout(f);
  const run = await f.context.pushHistory({ windowId: 1, groups: [{ name: 'New' }], tabCount: 99, snapshot });
  f.stores.session.proposal = { applied: true };
  const result = await f.context.rollbackHistory(run.id);
  assert.equal(result.groups, 2);
  assert.equal(f.stores.session.lastRun.groups, 2);
  assert.equal(f.stores.session.lastRun.tabs, 3);
  assert.equal(f.stores.session.proposal.applied, false);
  assert.equal(f.stores.badge, '2');
  assert.deepEqual(layout(f), original);
  assert.equal((await f.context.listHistory())[0].snapshot, undefined);
  await f.context.undo();
  assert.deepEqual(layout(f), applied);
});

test('drag reorder snapshots and restores original indices', async () => {
  const f = fixture([tab(1, 10), tab(2), tab(3, 20)], [{ id: 10, title: 'A' }, { id: 20, title: 'B' }]);
  const before = layout(f);
  await f.context.dragGroupReorder({ windowId: 1, order: [20, 10] });
  assert.deepEqual(f.tabs().map(t => t.id), [3, 1, 2]);
  await f.context.undo();
  assert.deepEqual(layout(f), before);
});

test('failed snapshot group restoration rejects and undo keeps its snapshot', async () => {
  const f = fixture([tab(1, 10), tab(2)], [{ id: 10, title: 'Original', color: 'purple' }]);
  await f.context.applyProposal({ windowId: 1, groups: [{ name: 'New', color: 'blue', tabIds: [2, 1] }] });
  const savedUndo = structuredClone(f.stores.session.undo);
  f.stores.session.proposal = { applied: true };
  f.chrome.tabs.group = async () => { throw Error('mock group creation denied'); };
  await assert.rejects(f.context.undo(), /恢复分组失败.*mock group creation denied/);
  assert.deepEqual(f.stores.session.undo, savedUndo);
  assert.equal(f.stores.session.proposal.applied, true, 'failure must not report an unapplied proposal');
  assert.equal(f.stores.badge, '1', 'failure must not clear the existing badge');
  assert.equal(f.warnings.length, 1);
});

test('failed proposal application rejects rather than recording successful application', async () => {
  const f = fixture([tab(1), tab(2)]);
  f.chrome.tabs.group = async () => { throw Error('mock grouping denied'); };
  await assert.rejects(f.context.applyProposal({ windowId: 1, groups: [{ name: 'New', color: 'blue', tabIds: [2, 1] }] }), /应用分组失败.*mock grouping denied/);
  assert.equal(f.stores.session.undo.snapshot.version, 2);
  assert.equal(f.stores.badge, undefined);
  assert.equal(f.stores.local.orgHistory, undefined);
});

test('Chrome mock reproduces membership loss from individual cross-group moves', async () => {
  const f = fixture([tab(1, 10), tab(2, 10), tab(3, 20), tab(4, 20)], [{ id: 10 }, { id: 20 }]);
  await f.chrome.tabs.move(3, { index: 0 });
  assert.notEqual(f.tabs().find(t => t.id === 3).groupId, 20);
  assert.equal(f.moves[0].insideOldGroup, false);
});

test('group reorder moves complete native blocks without membership loss or pinned movement', async () => {
  const f = fixture([tab(9, -1, { pinned: true }), tab(1, 10), tab(2, 10), tab(3, 20), tab(4, 20), tab(5, 20)], [{ id: 10, title: 'A' }, { id: 20, title: 'B', collapsed: true }]);
  await f.context.dragGroupReorder({ windowId: 1, order: [20, 10] });
  assert.deepEqual(f.tabs().map(t => t.id), [9, 3, 4, 5, 1, 2]);
  assert.deepEqual(f.tabs().map(t => t.groupId), [-1, 20, 20, 20, 10, 10]);
  assert.deepEqual(f.groupMoves, [{ id: 20, index: 1 }]);
  assert.equal(f.groups.get(20).collapsed, true);
  assert.equal(f.moves.some(m => m.pinned || (m.oldGroup !== -1 && !m.insideOldGroup)), false);
});

test('applyProposal reorders using post-apply group IDs, with in-group sorting only', async () => {
  const f = fixture([tab(9, -1, { pinned: true }), tab(1, 10), tab(2, 10), tab(3, 20), tab(4, 20)], [{ id: 10, title: 'A' }, { id: 20, title: 'B' }]);
  await f.context.applyProposal({ windowId: 1, groups: [
    { name: 'B', color: 'red', tabIds: [3, 1] },
    { name: 'A', color: 'blue', tabIds: [4, 2] },
  ] });
  assert.deepEqual(f.tabs().map(t => t.id), [9, 3, 1, 4, 2]);
  assert.deepEqual(f.tabs().map(t => t.groupId), [-1, 20, 20, 10, 10]);
  assert.ok(f.groupMoves.some(m => m.id === 20 && m.index === 1));
  assert.equal(f.moves.some(m => m.pinned || (m.oldGroup !== -1 && !m.insideOldGroup)), false);
});

test('partial/interleaved desired IDs coalesce all live group members and sort inside block', async () => {
  const f = fixture([tab(9, -1, { pinned: true }), tab(1, 10), tab(2, 10), tab(3, 20), tab(4, 20), tab(5)], [{ id: 10 }, { id: 20 }]);
  await f.context.reorderStrip(1, [4, 9, 1, 3, 4]);
  assert.deepEqual(f.tabs().map(t => t.id), [9, 4, 3, 1, 2, 5]);
  assert.deepEqual(f.tabs().map(t => t.groupId), [-1, 20, 20, 10, 10, -1]);
  assert.ok(f.groupMoves.some(m => m.id === 20 && m.index === 1));
  assert.ok(f.moves.some(m => m.id === 4 && m.insideOldGroup));
  assert.equal(f.moves.some(m => m.pinned || (m.oldGroup !== -1 && !m.insideOldGroup)), false);
});

test('cross-window and stale drag targets reject before overwriting undo', async () => {
  const f = fixture([tab(1), tab(2, 20, { windowId: 2 })], [{ id: 20, windowId: 2, title: 'Other window' }]);
  f.stores.session.undo = { marker: 'keep-existing-undo' };
  await assert.rejects(f.context.dragTabMove({ tabId: 2, windowId: 1 }), /跨窗口/);
  await assert.rejects(f.context.dragTabMove({ tabId: 1, groupId: 20, windowId: 1 }), /不在当前窗口/);
  await assert.rejects(f.context.dragGroupReorder({ windowId: 1, order: [20] }), /不在当前窗口/);
  await assert.rejects(f.context.dragGroupReorder({ windowId: 1, order: [999] }), /不在当前窗口/);
  assert.deepEqual(f.stores.session.undo, { marker: 'keep-existing-undo' });
  assert.equal(f.stores.local.orgHistory, undefined);
  assert.equal(f.tabs()[1].windowId, 2);
});

test('active pinned/already-grouped HTTP tab outside target gets snippet first', async () => {
  const active = tab(9, 30, { active: true, pinned: true });
  const target = [tab(1), tab(2)];
  const f = fixture([...target, active]);
  const { enriched, context } = await f.context.collectContext(target, [...target, active]);
  assert.equal(f.calls[0], 9);
  assert.equal(context.activeTab.id, 9);
  assert.equal(context.activeTab.snippet, 'snippet 9');
  assert.equal(context.activePageStatus, 'active-webpage');
  assert.deepEqual(plain(enriched).map(t => t.id), [1, 2]);
  assert.equal(f.calls.filter(id => id === 9).length, 1);
  assert.equal(f.stores.session.lastContext.withSnippet, 2);
});

test('active workbench does not invent previous webpage and model sees honest note', async () => {
  const target = [tab(1)];
  const active = tab(9, -1, { active: true, url: 'chrome-extension://test/home.html' });
  const f = fixture([...target, active]);
  const { context } = await f.context.collectContext(target, [...target, active]);
  assert.equal(context.activeTab, null);
  assert.equal(context.activePageStatus, 'non-http-active-previous-page-unknown');
  assert.deepEqual(f.calls, [1]);
  assert.equal(f.stores.session.lastContext.activeUrl, null);
  const prompt = server.buildMessages(target, { context })[1].content;
  assert.match(prompt, /不知道此前浏览的页面/);
  assert.doesNotMatch(prompt, /当前正在浏览：/);
});

let passed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log(`ok ${passed} - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
console.log(`PASS ${passed}/${tests.length} focused reliability regressions (VM + Chrome mock; no server/browser)`);
