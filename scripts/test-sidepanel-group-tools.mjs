#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {};
    this.style = { setProperty() {} }; this.className = ''; this.value = ''; this.textContent = '';
    this.disabled = false; this.checked = false; this.scrolls = []; this._html = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => { const add = force ?? !this.classList.contains(name); this.classList[add ? 'add' : 'remove'](name); return add; },
    };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  querySelectorAll(selector) { return descendants(this).filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  scrollIntoView(options) { this.scrolls.push(options); }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.focusCalls++; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function matches(node, selector) {
  const data = selector.match(/\[data-(group|tab)-id="([^"]+)"\]/);
  if (data && node.dataset[`${data[1]}Id`] !== data[2]) return false;
  const attr = selector.match(/\[aria-current="([^"]+)"\]/);
  if (attr && node.getAttribute('aria-current') !== attr[1]) return false;
  const cls = selector.match(/^\.([\w-]+)/);
  if (cls && !node.classList.contains(cls[1])) return false;
  const tag = selector.match(/^[a-z]+/i);
  return !tag || node.tagName === tag[0].toUpperCase();
}
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } });
async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function harness(options = {}) {
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  // Keep the initial tests executable before the matching markup is implemented.
  for (const id of ['archiveClose', 'clearGroupSelection', 'archiveStatus', 'archiveCount', 'archiveList', 'archiveListStatus', 'refreshArchives', 'cleanupCount', 'cleanupList', 'cleanupStatus', 'refreshCleanup']) nodes[id] ??= new Element();
  nodes.deckToggle.append(new Element('span')); nodes.deckToggle.children[0].className = 'chev';
  const docEvents = new Map();
  const document = {
    activeElement: null, focusCalls: 0,
    getElementById: id => nodes[id],
    createElement: tag => { const node = new Element(tag); node.ownerDocument = document; return node; },
    addEventListener: (type, fn) => docEvents.set(type, fn),
    dispatchEvent: e => docEvents.get(e.type)?.(e),
    querySelector: selector => Object.values(nodes).flatMap(root => [root, ...descendants(root)]).find(node => matches(node, selector)) || null,
  };
  for (const node of Object.values(nodes)) node.ownerDocument = document;
  const calls = { messages: [], nativeUpdates: [], tabUpdates: [], nativeMoves: [], confirm: [], toast: [], windows: 0 };
  const state = {
    tabs: [
      { id: 1, windowId: 7, groupId: 10, title: 'Alpha', url: 'https://alpha.test', active: false },
      { id: 2, windowId: 7, groupId: 20, title: 'Beta', url: 'https://beta.test', active: true },
      { id: 3, windowId: 7, groupId: -1, title: 'Loose', url: 'https://loose.test', active: false },
    ],
    groups: [{ id: 10, windowId: 7, title: 'Research', color: 'blue', collapsed: false }, { id: 20, windowId: 7, title: 'Work', color: 'grey', collapsed: true }],
    currentWindow: 7, confirm: true, archiveResponse: { ok: true, id: 'saved', closedTabs: 1, closedGroups: 1 },
    restoreResponse: { ok: true, restoredTabs: 2, restoredGroups: 1 },
    archives: [{ id: 'archive-1', at: 1700000000000, groupCount: 1, tabCount: 2, groups: [{ title: 'Saved work', tabCount: 2 }], url: 'https://private-metadata-must-not-render.test' }],
    advice: { ok: true, basis: 'lastAccessed', thresholdDays: 7, unknownCount: 2, candidates: [{ id: 50, title: 'Read later', idleDays: 9, url: 'https://private-advice-must-not-render.test' }] },
    ...options,
  };
  const tabs = { onActivated: event(), onUpdated: event() };
  for (const type of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved']) tabs[type] = event();
  tabs.query = async query => state.tabs.filter(tab => tab.windowId === query.windowId && (!query.active || tab.active));
  tabs.update = async (...args) => calls.tabUpdates.push(args);
  tabs.remove = async () => { throw Error('tests must never close real tabs'); };
  tabs.create = async () => {};
  const tabGroups = { query: async ({ windowId }) => state.groups.filter(group => group.windowId === windowId), update: async (...args) => calls.nativeUpdates.push(args), move: async (...args) => calls.nativeMoves.push(args) };
  for (const type of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) tabGroups[type] = event();
  const storage = { onChanged: event(), sync: { get: async () => ({ settings: {} }), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}) } };
  const chrome = {
    tabs, tabGroups, storage,
    windows: { getCurrent: async () => { calls.windows++; return { id: state.currentWindow }; }, update: async () => {} },
    runtime: { id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`, sendMessage: async message => {
      calls.messages.push(message);
      if (message.type === 'active-work-tab') {
        if (state.contextError) throw Error('background unavailable');
        const tab = state.tabs.find(item => item.active && item.windowId === message.windowId);
        return state.activeContext || { ok: true, tabId: tab?.id ?? null, windowId: message.windowId, groupId: tab?.groupId ?? -1, mode: tab ? 'active' : 'none' };
      }
      if (message.type === 'group-archive-list') return state.listError ? { ok: false, message: 'List failed' } : { ok: true, archives: state.archives };
      if (message.type === 'group-archive-close') return state.archiveResponse;
      if (message.type === 'group-archive-restore') return state.restoreResponse;
      if (message.type === 'cleanup-advice') return state.advice;
      if (message.type === 'organize') return { ok: true, groups: [] };
      return { ok: true, count: 0, undoCount: 0 };
    } },
  };
  let timerId = 0; const timers = new Map();
  const ctx = vm.createContext({
    chrome, document, window: { addEventListener() {} }, innerHeight: 800,
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    COLOR_HEX: { blue: '#00f', grey: '#888' }, tint: value => value, icon: () => '', cleanTitle: title => title,
    toast: (...args) => calls.toast.push(args), analysisSummary: () => '', normalizeAutoDelay: () => 30, paintAutoDelay() {}, AUTO_DELAY_OPTIONS: [],
    refreshHealthPill: async () => {}, initModelSelect() {}, refreshSearchCommand: async () => ({}),
    CSS: { escape: value => value }, CustomEvent: class { constructor(type, args = {}) { this.type = type; this.detail = args.detail; } },
    confirm: message => { calls.confirm.push(message); return state.confirm; },
    console,
  });
  vm.runInContext(source, ctx); await settle();
  return { ctx, nodes, calls, state, chrome, document, evaluate: code => vm.runInContext(code, ctx),
    refresh: async () => { await ctx.refresh(); await settle(); },
    flushRefresh: async () => { const pending = [...timers.entries()].filter(([, item]) => item.delay === 300); for (const [id, item] of pending) { timers.delete(id); await item.fn(); } await settle(); },
    groups: () => nodes.list.children.filter(node => node.classList.contains('sp-group')),
  };
}
const textTree = root => [root.textContent, ...root.children.map(textTree)].join(' ');
const groupCheck = (fixture, id) => fixture.groups().find(group => group.dataset.groupId === String(id))?.querySelector('input');
const select = (fixture, id, checked = true) => { const input = groupCheck(fixture, id); assert(input, `native group ${id} has a checkbox`); input.checked = checked; input.onchange(); };

// No browser, server, network, real tab closing, or real storage is used here.
test('onActivated refreshes and promotes the actual group in a copy, with accessible active row and UI-only expansion', async () => {
  const f = await harness();
  assert.equal(f.chrome.tabs.onActivated.listeners.length, 1, 'regression: onActivated previously had no listener');
  assert.equal(f.groups()[0].dataset.groupId, '20');
  assert(f.groups()[0].classList.contains('active-group'));
  assert.equal(f.groups()[0].querySelector('.sp-tabs').style.display || '', '');
  const active = f.groups()[0].querySelector('li[data-tab-id="2"]');
  assert.equal(active.getAttribute('aria-current'), 'page');
  assert.deepEqual(JSON.parse(f.evaluate('JSON.stringify(lastData.groups.map(group => group.id))')), [10, 20]);
  assert.deepEqual(f.calls.nativeMoves, []); assert.deepEqual(f.calls.nativeUpdates, []);
  f.state.tabs[0].active = true; f.state.tabs[1].active = false;
  f.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 7 }); await f.flushRefresh();
  assert.equal(f.groups()[0].dataset.groupId, '10');
  assert.equal(f.groups()[0].querySelector('li[data-tab-id="1"]').getAttribute('aria-current'), 'page');
});

test('same activation never scrolls twice or steals input focus; filtering remains intact and excludes nonmatches', async () => {
  const f = await harness();
  const first = f.groups()[0].querySelector('li[data-tab-id="2"]');
  const firstScrollCount = first?.scrolls.length || 0;
  assert.equal(firstScrollCount, 1);
  f.nodes.search.focus(); const focusCalls = f.document.focusCalls;
  f.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 7 }); await f.flushRefresh();
  assert.equal(f.groups()[0].querySelector('li[data-tab-id="2"]').scrolls.length, 0);
  assert.equal(f.document.activeElement, f.nodes.search); assert.equal(f.document.focusCalls, focusCalls);
  f.nodes.search.value = 'Alpha'; f.nodes.search.oninput();
  f.chrome.tabs.onActivated.emit({ tabId: 2, windowId: 7 }); await f.flushRefresh();
  assert.equal(f.nodes.search.value, 'Alpha'); assert.equal(f.evaluate('searchTerm'), 'Alpha');
  assert.equal(f.groups().length, 1); assert.equal(f.groups()[0].dataset.groupId, '10');
  assert.equal(f.document.querySelector('li[data-tab-id="2"]'), null);
});

test('native sidebar stays in its own window and shell tabs use honest recent context; unavailable BG falls back to actual tab', async () => {
  const f = await harness();
  f.state.currentWindow = 99;
  f.chrome.tabs.onActivated.emit({ tabId: 99, windowId: 99 }); await f.flushRefresh(); await f.refresh();
  assert.equal(f.evaluate('windowId'), 7); assert.equal(f.calls.windows, 1);
  f.state.tabs[1].active = false;
  f.state.tabs.push({ id: 4, windowId: 7, groupId: -1, active: true, title: 'RootApp', url: 'chrome-extension://fixture/home.html' });
  f.state.activeContext = { ok: true, tabId: 2, windowId: 7, groupId: 20, mode: 'recent' }; await f.refresh();
  const recent = f.groups()[0].querySelector('li[data-tab-id="2"]');
  assert(recent.classList.contains('recent')); assert.equal(recent.getAttribute('aria-current'), null);
  assert.match(textTree(recent), /最近浏览/); assert.equal(f.groups()[0].dataset.groupId, '20');
  f.state.contextError = true; f.state.tabs[0].active = true; f.state.tabs[3].active = false; await f.refresh();
  assert.equal(f.groups()[0].querySelector('li[data-tab-id="1"]').getAttribute('aria-current'), 'page');
});

test('batch controls select native integer groups only, confirm before RPC, and retain selection on failure for retry', async () => {
  const f = await harness({ groups: [{ id: 10, windowId: 7, title: 'Native', color: 'blue' }, { id: 'model-1', windowId: 7, title: 'Pseudo', color: 'grey' }, { id: -1, windowId: 7, title: 'Ungrouped' }] });
  assert.equal(f.nodes.archiveClose.disabled, true);
  assert.equal(f.groups().flatMap(group => group.querySelectorAll('input')).length, 1);
  select(f, 10); assert.match(f.nodes.archiveClose.textContent, /1 组/);
  assert.equal(groupCheck(f, 10).parentElement.tagName, 'LABEL');
  assert.notEqual(groupCheck(f, 10).parentElement.parentElement.tagName, 'BUTTON');
  f.state.confirm = false; await f.nodes.archiveClose.onclick();
  assert.equal(f.calls.messages.filter(message => message.type === 'group-archive-close').length, 0);
  assert.match(f.calls.confirm[0], /保存链接与分组，不保存未提交内容/);
  f.state.confirm = true; f.state.archiveResponse = { ok: false, message: 'Archive failed; retry' };
  await f.nodes.archiveClose.onclick(); await settle();
  const message = f.calls.messages.find(item => item.type === 'group-archive-close');
  assert.deepEqual(JSON.parse(JSON.stringify(message)), { type: 'group-archive-close', groupIds: [10], windowId: 7 });
  assert.equal(groupCheck(f, 10).checked, true); assert.equal(f.nodes.archiveClose.disabled, false);
  assert.match(f.nodes.archiveStatus.textContent, /Archive failed/);
  f.state.groups = []; await f.refresh(); assert.equal(f.nodes.archiveClose.disabled, true); assert.match(f.nodes.archiveClose.textContent, /0 组/);
});

test('archive close/restore are pending-disabled, metadata-only, bounded, refresh on storage, and restore errors retry', async () => {
  const f = await harness();
  assert.match(textTree(f.nodes.archiveList), /Saved work/);
  assert(!textTree(f.nodes.archiveList).includes('private-'));
  const closing = deferred(); f.state.archiveResponse = closing.promise; select(f, 20);
  const pending = f.nodes.archiveClose.onclick(); await settle();
  assert.equal(f.nodes.archiveClose.disabled, true); assert.equal(f.nodes.archiveList.querySelector('button').disabled, true);
  closing.resolve({ ok: false, message: 'Try again' }); await pending; await settle();
  assert.equal(f.nodes.archiveClose.disabled, false);
  const restoring = deferred(); f.state.restoreResponse = restoring.promise;
  const restore = f.nodes.archiveList.querySelector('button'); const restored = restore.onclick(); await settle();
  assert.equal(restore.disabled, true); assert.equal(f.nodes.archiveClose.disabled, true);
  restoring.resolve({ ok: false, message: 'Restore failed' }); await restored; await settle();
  assert.equal(f.nodes.archiveList.querySelector('button').disabled, false);
  assert.match(f.nodes.archiveListStatus.textContent, /Restore failed/);
  const message = f.calls.messages.find(item => item.type === 'group-archive-restore');
  assert.equal(message.id, 'archive-1'); assert.equal(message.targetWindowId, 7);
  f.state.archives = Array.from({ length: 15 }, (_, i) => ({ id: `archive-${i}`, at: Date.now(), groupCount: 1, tabCount: 1, groups: [{ title: `Saved ${i}` }] }));
  f.chrome.storage.onChanged.emit({ groupArchives: { newValue: ['private raw data'] } }, 'local'); await settle();
  assert.equal(f.nodes.archiveList.children.length, 10);
  assert(!textTree(f.nodes.archiveList).includes('private raw data'));
  assert.match(f.nodes.archiveListStatus.textContent, /10/);
});

test('archive list failure retains metadata and offers a retry without resetting a restore failure', async () => {
  const f = await harness(); f.state.listError = true;
  await f.nodes.refreshArchives.onclick(); await settle();
  assert.match(textTree(f.nodes.archiveList), /Saved work/); assert.match(f.nodes.archiveListStatus.textContent, /List failed/);
  f.state.listError = false; await f.nodes.refreshArchives.onclick(); await settle();
  assert.match(textTree(f.nodes.archiveList), /Saved work/);
});

test('cleanup advice uses metadata only, states unknown time honestly, bounds titles, and refreshes after organize/lastRun', async () => {
  const f = await harness();
  assert.match(textTree(f.nodes.cleanupList), /Read later/); assert.match(textTree(f.nodes.cleanupList), /9 天未访问/);
  assert.match(f.nodes.cleanupStatus.textContent, /2.*未知/); assert.match(f.nodes.cleanupStatus.textContent, /不推断/);
  assert(!textTree(f.nodes.cleanupList).includes('private-'));
  let count = f.calls.messages.filter(message => message.type === 'cleanup-advice').length;
  f.chrome.storage.onChanged.emit({ lastRun: { newValue: { applied: true, at: 1 } } }, 'session'); await settle();
  assert.equal(f.calls.messages.filter(message => message.type === 'cleanup-advice').length, ++count);
  await f.nodes.regroup.onclick(); await settle();
  assert.equal(f.calls.messages.filter(message => message.type === 'cleanup-advice').length, ++count);
  f.state.advice.candidates = Array.from({ length: 15 }, (_, i) => ({ id: i, title: `Old ${i}`, idleDays: 8 }));
  await f.nodes.refreshCleanup.onclick(); await settle();
  assert.equal(f.nodes.cleanupList.children.length, 10); assert.match(f.nodes.cleanupCount.textContent, /15/);
});

test('overlapping refreshes are latest-wins and activation invalidates an older read before debounce', async () => {
  const f = await harness();
  const send = f.chrome.runtime.sendMessage;
  const old = deferred(); let hold = true;
  f.chrome.runtime.sendMessage = message => message.type === 'active-work-tab' && hold ? old.promise : send(message);
  const oldRefresh = f.ctx.refresh(); await settle();
  f.state.tabs[0].active = true; f.state.tabs[1].active = false; hold = false;
  f.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 7 });
  const previousRow = f.groups()[0];
  old.resolve({ ok: true, tabId: 2, groupId: 20, windowId: 7, mode: 'active' });
  await oldRefresh; await settle();
  assert.equal(f.groups()[0], previousRow, 'invalidated in-flight read must not paint before debounce');
  await f.flushRefresh(); assert.equal(f.groups()[0].dataset.groupId, '10');

  const laterOld = deferred(); hold = true;
  f.chrome.runtime.sendMessage = message => message.type === 'active-work-tab' && hold ? laterOld.promise : send(message);
  const stale = f.ctx.refresh(); await settle();
  f.state.tabs[0].active = false; f.state.tabs[1].active = true; hold = false;
  await f.refresh(); assert.equal(f.groups()[0].dataset.groupId, '20');
  laterOld.resolve({ ok: true, tabId: 1, groupId: 10, windowId: 7, mode: 'active' });
  await stale; await settle(); assert.equal(f.groups()[0].dataset.groupId, '20');
  assert.equal(f.evaluate('lastData.activeId'), 2);
});

test('new activation never clears an existing search or inserts a nonmatching active item', async () => {
  const f = await harness();
  f.nodes.search.value = 'Beta'; f.nodes.search.oninput(); f.nodes.search.focus();
  f.state.tabs[0].active = true; f.state.tabs[1].active = false;
  f.chrome.tabs.onActivated.emit({ tabId: 1, windowId: 7 }); await f.flushRefresh();
  assert.equal(f.nodes.search.value, 'Beta'); assert.equal(f.evaluate('searchTerm'), 'Beta');
  assert.equal(f.groups().length, 1); assert.equal(f.groups()[0].dataset.groupId, '20');
  assert.equal(f.document.querySelector('li[data-tab-id="1"]'), null);
  assert.equal(f.document.querySelector('li[data-tab-id="2"]').scrolls.length, 0);
  assert.equal(f.document.activeElement, f.nodes.search);
});

test('actual active query outranks stale BG context and shell fallback only uses a previously observed tab', async () => {
  const f = await harness({ activeContext: { ok: true, tabId: 1, groupId: 10, windowId: 7, mode: 'recent' } });
  assert.equal(f.groups()[0].dataset.groupId, '20');
  f.state.contextError = true; f.state.tabs[1].active = false;
  f.state.tabs.push({ id: 4, windowId: 7, groupId: -1, active: true, title: 'New tab', url: 'chrome://newtab/' });
  await f.refresh(); assert.equal(f.groups()[0].dataset.groupId, '20');
  assert.equal(f.groups()[0].querySelector('li[data-tab-id="2"]').getAttribute('aria-current'), null);
  assert.match(textTree(f.groups()[0]), /最近浏览/);
  f.state.tabs = f.state.tabs.filter(tab => tab.id === 4); await f.refresh();
  assert.equal(f.groups().length, 1); assert.equal(f.groups()[0].dataset.groupId, 'u-7');
  assert(!f.groups()[0].classList.contains('active-group')); assert.equal(f.evaluate('activeContext.tabId'), null);
});

test('partial close retains existing selected groups for retry; successful close clears selection and reload preserves saved metadata', async () => {
  const f = await harness(); select(f, 10); select(f, 20);
  f.state.archiveResponse = { ok: true, partial: true, closedGroups: 1, closedTabs: 1, message: 'Partially closed' };
  f.state.groups = f.state.groups.filter(group => group.id === 10);
  await f.nodes.archiveClose.onclick(); await settle();
  assert.match(f.nodes.archiveStatus.textContent, /Partially closed/);
  assert.equal(groupCheck(f, 10).checked, true); assert.match(f.nodes.archiveClose.textContent, /1 组/);
  f.state.archiveResponse = { ok: true, closedGroups: 1, closedTabs: 1 };
  await f.nodes.archiveClose.onclick(); await settle();
  assert.equal(f.nodes.archiveClose.disabled, true); assert.equal(groupCheck(f, 10).checked, false);
  const reloaded = await harness({ archives: f.state.archives });
  assert.match(textTree(reloaded.nodes.archiveList), /Saved work/);
});

test('explicit group collapse remains native and same-active refresh respects it; regrouped active tab expands without rescrolling', async () => {
  const f = await harness(); const group = f.groups()[0];
  await group.querySelector('.sp-group-head').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.nativeUpdates)), [[20, { collapsed: true }]]);
  await f.refresh(); assert.equal(f.groups()[0].querySelector('.sp-tabs').style.display, 'none');
  f.state.tabs[1].groupId = 10; f.state.groups[0].collapsed = true;
  await f.refresh(); assert.equal(f.groups()[0].dataset.groupId, '10');
  assert.equal(f.groups()[0].querySelector('.sp-tabs').style.display || '', '');
  assert.equal(f.groups()[0].querySelector('li[data-tab-id="2"]').scrolls.length, 0);
  await f.nodes.collapseAll.onclick(); await settle();
  assert.equal(f.groups()[0].querySelector('.sp-tabs').style.display, 'none');
});

test('successful and partial restores remain window-scoped and show exact returned outcomes', async () => {
  const f = await harness(); f.state.currentWindow = 99;
  f.state.restoreResponse = { ok: true, restoredTabs: 2, restoredGroups: 1 };
  await f.nodes.archiveList.querySelector('button').onclick(); await settle();
  assert.match(f.nodes.archiveListStatus.textContent, /已恢复 1 组、2 个标签/);
  assert.equal(f.nodes.archiveList.querySelector('button').disabled, false);
  f.state.restoreResponse = { ok: true, partial: true, restoredTabs: 1, restoredGroups: 0, message: 'Partial restore; retry remaining' };
  await f.nodes.archiveList.querySelector('button').onclick(); await settle();
  assert.match(f.nodes.archiveListStatus.textContent, /Partial restore/);
  assert.equal(f.nodes.archiveList.querySelector('button').disabled, false);
  for (const message of f.calls.messages.filter(item => item.type === 'group-archive-restore')) assert.equal(message.targetWindowId, 7);
  assert.deepEqual(f.calls.tabUpdates, []); assert.deepEqual(f.calls.nativeUpdates, []);
});

test('an interrupted restore journal is retriable rather than treated as a permanently pending request', async () => {
  const f = await harness({ archives: [{ id: 'partial', at: Date.now(), groupCount: 1, tabCount: 2, restoring: true, groups: [{ title: 'Interrupted' }] }] });
  const button = f.nodes.archiveList.querySelector('button');
  assert.equal(button.disabled, false); assert.equal(button.textContent, '重试恢复');
  assert.match(textTree(f.nodes.archiveList), /恢复未完成，可重试/);
  f.state.restoreResponse = { ok: false, message: 'Restore requires review' };
  await button.onclick(); await settle();
  assert.equal(f.nodes.archiveList.querySelector('button').disabled, false);
  assert.match(f.nodes.archiveListStatus.textContent, /Restore requires review/);
});

test('cleanup total can exceed returned candidates and unknown timestamps never gain inferred age', async () => {
  const f = await harness(); f.state.advice.eligibleCount = 75;
  f.state.advice.candidates = Array.from({ length: 50 }, (_, i) => ({ id: i, title: `Candidate ${i}`, idleDays: 7 + i }));
  await f.nodes.refreshCleanup.onclick(); await settle();
  assert.match(f.nodes.cleanupCount.textContent, /75/); assert.equal(f.nodes.cleanupList.children.length, 10);
  assert.match(f.nodes.cleanupStatus.textContent, /未知，不推断/);
  const prior = textTree(f.nodes.cleanupList);
  f.state.advice = { ok: false, message: 'Advice unavailable' };
  await f.nodes.refreshCleanup.onclick(); await settle();
  assert.equal(textTree(f.nodes.cleanupList), prior); assert.match(f.nodes.cleanupStatus.textContent, /Advice unavailable/);
  assert.equal(f.nodes.refreshCleanup.disabled, false);
});

test('new tools keep all prior control ids, isolate styles, and preserve main-search delegation', () => {
  for (const id of ['model', 'regroup', 'dedup', 'dedupUndo', 'search', 'collapseAll', 'expandAll', 'autoOrganize', 'autoDelay', 'openGlobalSearch', 'searchShortcutSettings', 'deckToggle']) assert(html.includes(`id="${id}"`));
  assert(html.includes('href="sidepanel.css"'));
  assert(html.includes('id="closedGroups"')); assert(html.includes('id="cleanupAdvice"'));
  assert.match(source, /tt-open-main-search/);
});
