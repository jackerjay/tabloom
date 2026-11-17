#!/usr/bin/env node
// Offline background-only proof: no browser, service, dependencies, or disk writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const extensionId = 'browser-search-test';
const root = `chrome-extension://${extensionId}/`;
const searchUrl = root + 'search.html';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const event = () => ({
  listeners: [],
  addListener(fn) { this.listeners.push(fn); },
  async emit(...args) { return await Promise.all(this.listeners.map(fn => fn(...args))); },
});
const uiSender = (page = 'popup.html', tab) => ({ id: extensionId, url: root + page, frameId: 0, ...(tab ? { tab } : {}) });

function fixture() {
  const windows = new Map([
    [1, { id: 1, type: 'normal', focused: true, state: 'normal', left: 100, top: 80, width: 1200, height: 900 }],
    [2, { id: 2, type: 'normal', focused: false, state: 'normal', left: -1200, top: 0, width: 1200, height: 900 }],
  ]);
  const tabs = new Map([
    [11, { id: 11, windowId: 1, active: true, url: 'https://example.test/', groupId: -1 }],
    [12, { id: 12, windowId: 1, active: false, url: 'chrome://settings/', groupId: -1 }],
    [21, { id: 21, windowId: 2, active: true, url: 'chrome://extensions/', groupId: -1 }],
  ]);
  const stores = { session: {}, sync: {}, local: {} };
  const calls = { creates: [], removes: [], windowUpdates: [], tabUpdates: [], messages: [], injections: [], warnings: [] };
  const hooks = {};
  const pendingEvents = [];
  let focusOrder = [2, 1], nextWindow = 10, nextTab = 100, context;
  const focus = id => {
    for (const win of windows.values()) win.focused = win.id === id;
    if (windows.has(id)) focusOrder = [...focusOrder.filter(other => other !== id), id];
  };
  const liveWindow = id => { if (!windows.has(id)) throw Error(`missing window ${id}`); return windows.get(id); };
  const liveTab = id => { if (!tabs.has(id)) throw Error(`missing tab ${id}`); return tabs.get(id); };
  const storage = Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  }]));
  const chrome = {
    storage,
    runtime: {
      id: extensionId,
      getURL: path => root + path,
      async sendMessage(message) {
        calls.messages.push(structuredClone(message));
        return hooks.onNotification ? await hooks.onNotification(message) : undefined;
      },
    },
    commands: { async getAll() { return hooks.commands || [{ name: 'search-tabs', shortcut: 'Command+K' }]; } },
    windows: {
      async get(id) { return structuredClone(liveWindow(id)); },
      async getLastFocused({ windowTypes } = {}) {
        const id = [...focusOrder].reverse().find(id => windows.has(id) && (!windowTypes || windowTypes.includes(windows.get(id).type)));
        if (id == null) throw Error('no window');
        return structuredClone(liveWindow(id));
      },
      async create(options) {
        calls.creates.push(structuredClone(options));
        hooks.createStarted?.resolve();
        if (hooks.beforeCreate) await hooks.beforeCreate();
        const id = nextWindow++, tabId = nextTab++;
        const win = { id, state: 'normal', ...options };
        delete win.url;
        windows.set(id, win);
        tabs.set(tabId, { id: tabId, windowId: id, active: true, url: options.url, groupId: -1 });
        if (options.focused) focus(id);
        return structuredClone(win);
      },
      async update(id, options) {
        calls.windowUpdates.push({ id, ...structuredClone(options) });
        Object.assign(liveWindow(id), options);
        if (options.focused) focus(id);
        return structuredClone(liveWindow(id));
      },
      async remove(id) {
        calls.removes.push(id);
        nativeClose(id);
      },
    },
    tabs: {
      async query({ windowId, active, url } = {}) {
        return structuredClone([...tabs.values()].filter(tab => (windowId == null || tab.windowId === windowId)
          && (active == null || tab.active === active) && (url == null || tab.url === url)));
      },
      async get(id) { return structuredClone(liveTab(id)); },
      async update(id, options) {
        calls.tabUpdates.push({ id, ...structuredClone(options) });
        if (hooks.beforeTabUpdate) await hooks.beforeTabUpdate(id);
        const tab = liveTab(id);
        if (options.active) for (const other of tabs.values()) if (other.windowId === tab.windowId) other.active = false;
        Object.assign(tab, options);
        return structuredClone(tab);
      },
    },
    scripting: { async executeScript(options) { calls.injections.push(options); throw Error('search must never inject'); } },
    alarms: {},
  };
  function nativeClose(id, nextFocus) {
    const wasFocused = liveWindow(id).focused;
    windows.delete(id);
    for (const [tabId, tab] of tabs) if (tab.windowId === id) tabs.delete(tabId);
    focusOrder = focusOrder.filter(other => other !== id);
    if (nextFocus !== undefined) focus(nextFocus);
    else if (wasFocused) focus(focusOrder.at(-1));
    pendingEvents.push(chrome.windows.onRemoved.emit(id));
  }
  function restart() {
    chrome.runtime.onMessage = event();
    chrome.runtime.onInstalled = event();
    if (chrome.commands) chrome.commands.onCommand = event();
    chrome.windows.onRemoved = event();
    chrome.tabs.onCreated = event();
    chrome.tabs.onRemoved = event();
    chrome.tabs.onUpdated = event();
    chrome.alarms.onAlarm = event();
    context = vm.createContext({ chrome, URL, AbortController, setTimeout: () => 0, clearTimeout() {},
      console: { ...console, warn: (...args) => calls.warnings.push(args) } });
    vm.runInContext(source, context);
  }
  restart();
  return {
    chrome, stores, windows, tabs, calls, hooks, focus, restart, nativeClose,
    get context() { return context; },
    async flush() { await Promise.all(pendingEvents.splice(0)); },
    tab(id) { return structuredClone(liveTab(id)); },
    searchSender(windowId = stores.session.browserSearch?.windowId) {
      const tab = [...tabs.values()].find(tab => tab.windowId === windowId && tab.url === searchUrl);
      assert.ok(tab, 'fixture needs a live search tab');
      return uiSender('search.html', structuredClone(tab));
    },
    // Legacy lifecycle coverage intentionally invokes the retained native helper.
    // The real commands event now belongs to test-page-search.mjs (never a popup).
    async command(tab, command = 'search-tabs') {
      if (command === 'search-tabs') await context.openBrowserSearch(tab, { toggle: true });
      else await chrome.commands.onCommand.emit(command, tab);
    },
    async message(message, sender = uiSender()) {
      assert.equal(chrome.runtime.onMessage.listeners.length, 1);
      return await new Promise(resolve => {
        const async = chrome.runtime.onMessage.listeners[0](message, sender, response => resolve(plain(response)));
        assert.equal(async, true);
      });
    },
  };
}

async function open(f) {
  const result = await f.message({ type: 'browser-search-open' }, uiSender('popup.html'));
  assert.equal(result.ok, true, result.message);
  return result;
}

test('legacy: browser-scoped command has exact suggested keys, Chinese description, no extra permission', async () => {
  assert.deepEqual(manifest.commands['search-tabs'].suggested_key, { default: 'Ctrl+K', mac: 'Command+K' });
  assert.match(manifest.commands['search-tabs'].description, /[\u4e00-\u9fff]/);
  assert.equal(Object.hasOwn(manifest.commands['search-tabs'], 'global'), false);
  assert.deepEqual(manifest.permissions, ['tabs', 'tabGroups', 'storage', 'sidePanel', 'alarms', 'favicon', 'bookmarks', 'history', 'scripting']);
  const f = fixture();
  assert.equal(f.chrome.commands.onCommand.listeners.length, 1);
  await f.command(f.tab(11), 'unrelated-command');
  assert.equal(f.calls.creates.length, 0);
});

for (const url of ['https://example.test/', 'chrome://settings/', 'chrome://extensions/', root + 'home.html']) {
  test(`legacy: command receives source tab and opens native centered popup from ${url}`, async () => {
    const f = fixture();
    f.tabs.get(11).url = url;
    await f.command(f.tab(11));
    assert.deepEqual(f.calls.creates, [{ url: searchUrl, type: 'popup', focused: true, width: 680, height: 560, left: 360, top: 250 }]);
    assert.deepEqual(f.stores.session.browserSearch, { windowId: 10, sourceWindowId: 1, sourceTabId: 11 });
    assert.equal(f.calls.injections.length, 0);
    assert.equal(f.calls.warnings.length, 0);
  });
}

for (const page of ['popup.html', 'sidepanel.html', 'home.html']) {
  test(`legacy: ${page} message uses the same open entry and real source, not caller-supplied IDs`, async () => {
    const f = fixture();
    const result = await f.message({ type: 'browser-search-open', windowId: 999, sourceTabId: 999 }, uiSender(page));
    assert.equal(result.ok, true);
    assert.equal(result.currentTabId, 11);
    assert.equal(result.sourceWindowId, 1);
    assert.equal(f.calls.creates.length, 1);
  });
}

test('legacy: focused shortcut toggles closed and restores original window and tab exactly once', async () => {
  const f = fixture();
  await f.command(f.tab(11));
  const sender = f.searchSender();
  f.tabs.get(11).active = false;
  f.tabs.get(12).active = true;
  await f.command(sender.tab);
  await f.flush();
  assert.deepEqual(f.calls.removes, [10]);
  assert.equal(f.stores.session.browserSearch, undefined);
  assert.deepEqual(f.calls.tabUpdates, [{ id: 11, active: true }]);
  assert.deepEqual(f.calls.windowUpdates, [{ id: 1, focused: true }]);
  assert.equal(f.windows.get(1).focused, true);
});

test('legacy: unfocused popup is reused, restores from minimized, records new source, sends reset/focus', async () => {
  const f = fixture();
  await open(f);
  f.windows.get(10).state = 'minimized';
  f.focus(2);
  await f.command(f.tab(21));
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.windows.get(10).focused, true);
  assert.deepEqual(f.calls.windowUpdates, [{ id: 10, focused: true, state: 'normal' }]);
  assert.deepEqual(f.stores.session.browserSearch, { windowId: 10, sourceWindowId: 2, sourceTabId: 21 });
  assert.deepEqual(f.calls.messages, [{ type: 'browser-search-focus', windowId: 10, reset: true }]);
  const state = await f.message({ type: 'browser-search-state' }, f.searchSender());
  assert.deepEqual(state, { ok: true, sourceWindowId: 2, currentTabId: 21 });
});

test('legacy: UI open while focused means focus/reset, not command toggle; notification cannot deadlock queue', async () => {
  const f = fixture();
  await open(f);
  const notification = deferred();
  f.hooks.onNotification = () => notification.promise;
  const result = await f.message({ type: 'browser-search-open' }, f.searchSender());
  assert.equal(result.reused, true);
  assert.equal(f.calls.removes.length, 0);
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(await f.message({ type: 'browser-search-state' }, f.searchSender()), { ok: true, sourceWindowId: 1, currentTabId: 11 });
  notification.resolve();
});

test('legacy: concurrent command/UI opens share creation lock and never create or toggle duplicates', async () => {
  const f = fixture();
  const gate = deferred();
  f.hooks.createStarted = deferred();
  f.hooks.beforeCreate = () => gate.promise;
  const first = f.message({ type: 'browser-search-open' });
  await f.hooks.createStarted.promise;
  const command = f.command(f.tab(11));
  const second = f.message({ type: 'browser-search-open' });
  assert.equal(f.calls.creates.length, 1);
  gate.resolve();
  const [a, , b] = await Promise.all([first, command, second]);
  assert.equal(a.windowId, b.windowId);
  assert.equal(f.calls.creates.length, 1);
  assert.equal(f.calls.removes.length, 0);
});

test('legacy: service worker restart preserves source context and reuses the live popup', async () => {
  const f = fixture();
  await open(f);
  const sender = f.searchSender();
  f.restart();
  assert.deepEqual(await f.message({ type: 'browser-search-state' }, sender), { ok: true, sourceWindowId: 1, currentTabId: 11 });
  f.focus(2);
  await f.command(f.tab(21));
  assert.equal(f.calls.creates.length, 1);
  assert.deepEqual(f.stores.session.browserSearch, { windowId: 10, sourceWindowId: 2, sourceTabId: 21 });
});

test('legacy: orphaned popup is recovered by URL when session is absent or stale', async () => {
  for (const saved of [undefined, { windowId: 999, sourceWindowId: 999, sourceTabId: 999 }]) {
    const f = fixture();
    await open(f);
    f.stores.session.browserSearch = saved;
    f.restart();
    const result = await f.message({ type: 'browser-search-open' });
    assert.equal(result.ok, true);
    assert.equal(result.reused, true);
    assert.equal(result.windowId, 10);
    assert.equal(f.calls.creates.length, 1);
    assert.deepEqual(f.stores.session.browserSearch, { windowId: 10, sourceWindowId: 1, sourceTabId: 11 });
  }
});

test('legacy: popup with only pendingUrl is reused before search.html commits', async () => {
  const f = fixture();
  await open(f);
  const sender = f.searchSender();
  Object.assign(f.tabs.get(sender.tab.id), { url: '', pendingUrl: searchUrl });
  const result = await f.message({ type: 'browser-search-open' });
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.windowId, 10);
  assert.equal(f.calls.creates.length, 1);
});

test('legacy: home message uses its actual sender tab, not another active normal window', async () => {
  const f = fixture();
  f.tabs.get(11).url = root + 'home.html';
  f.focus(2);
  const result = await f.message({ type: 'browser-search-open' }, uiSender('home.html', f.tab(11)));
  assert.equal(result.sourceWindowId, 1);
  assert.equal(result.currentTabId, 11);
  assert.equal(f.calls.creates[0].left, 360);
});

test('legacy: stale session and a normal browser tab named search.html are never adopted/closed', async () => {
  const f = fixture();
  f.tabs.get(12).url = searchUrl;
  f.stores.session.browserSearch = { windowId: 1, sourceWindowId: 2, sourceTabId: 21 };
  const result = await open(f);
  assert.equal(result.reused, false);
  assert.equal(result.windowId, 10);
  assert.equal(f.windows.has(1), true);
  assert.equal(f.calls.removes.length, 0);
});

test('legacy: Escape close restores source; jump close does not reactivate or refocus old source', async () => {
  for (const restoreFocus of [true, false]) {
    const f = fixture();
    await open(f);
    const sender = f.searchSender();
    if (!restoreFocus) f.focus(2); // UI has already focused its selected result.
    const result = await f.message({ type: 'browser-search-close', restoreFocus }, sender);
    await f.flush();
    assert.deepEqual(result, { ok: true, closed: true });
    assert.equal(f.stores.session.browserSearch, undefined);
    assert.deepEqual(f.calls.tabUpdates, restoreFocus ? [{ id: 11, active: true }] : []);
    assert.deepEqual(f.calls.windowUpdates, restoreFocus ? [{ id: 1, focused: true }] : []);
    assert.equal(f.windows.get(restoreFocus ? 1 : 2).focused, true);
  }
});

test('legacy: failed window removal preserves session and later close can retry', async () => {
  const f = fixture();
  await open(f);
  const sender = f.searchSender();
  const remove = f.chrome.windows.remove;
  f.chrome.windows.remove = async () => { throw Error('mock removal denied'); };
  const result = await f.message({ type: 'browser-search-close', restoreFocus: true }, sender);
  assert.equal(result.ok, false);
  assert.match(result.message, /mock removal denied/);
  assert.equal(f.stores.session.browserSearch.windowId, 10);
  f.chrome.windows.remove = remove;
  assert.equal((await f.message({ type: 'browser-search-close', restoreFocus: false }, sender)).ok, true);
  await f.flush();
  assert.equal(f.stores.session.browserSearch, undefined);
  assert.deepEqual(f.calls.windowUpdates, []);
});

test('legacy: native close cleans state after SW restart and restores only when source already focused', async () => {
  for (const nextFocus of [1, 2, null]) {
    const f = fixture();
    await open(f);
    f.restart();
    f.nativeClose(10, nextFocus);
    await f.flush();
    assert.equal(f.stores.session.browserSearch, undefined);
    assert.deepEqual(f.calls.tabUpdates, nextFocus === 1 ? [{ id: 11, active: true }] : []);
    assert.deepEqual(f.calls.windowUpdates, []);
  }
});

test('legacy: closed/moved source tab is skipped safely; surviving source window can still restore', async () => {
  for (const moved of [false, true]) {
    const f = fixture();
    await open(f);
    const sender = f.searchSender();
    if (moved) f.tabs.get(11).windowId = 2;
    else f.tabs.delete(11);
    assert.deepEqual(await f.message({ type: 'browser-search-state' }, sender), { ok: true, sourceWindowId: 1, currentTabId: null });
    assert.equal((await f.message({ type: 'browser-search-close', restoreFocus: true }, sender)).ok, true);
    await f.flush();
    assert.deepEqual(f.calls.tabUpdates, []);
    assert.deepEqual(f.calls.windowUpdates, [{ id: 1, focused: true }]);
  }
});

test('legacy: deleted source window yields null state and close succeeds without stealing another window', async () => {
  const f = fixture();
  await open(f);
  const sender = f.searchSender();
  f.nativeClose(1);
  await f.flush();
  assert.deepEqual(await f.message({ type: 'browser-search-state' }, sender), { ok: true, sourceWindowId: null, currentTabId: null });
  assert.equal((await f.message({ type: 'browser-search-close', restoreFocus: true }, sender)).ok, true);
  await f.flush();
  assert.deepEqual(f.calls.tabUpdates, []);
  assert.deepEqual(f.calls.windowUpdates, []);
});

test('legacy: source tab disappearing during restoration does not prevent surviving window restoration', async () => {
  const f = fixture();
  await open(f);
  const sender = f.searchSender();
  f.hooks.beforeTabUpdate = id => { f.tabs.delete(id); };
  assert.equal((await f.message({ type: 'browser-search-close', restoreFocus: true }, sender)).ok, true);
  await f.flush();
  assert.deepEqual(f.calls.windowUpdates, [{ id: 1, focused: true }]);
});

test('legacy: close/state strictly authenticate search URL, extension, top frame, live tab and popup window', async () => {
  const f = fixture();
  await open(f);
  const valid = f.searchSender();
  const invalid = [
    {}, uiSender(), uiSender('home.html', f.tab(11)),
    { ...valid, id: 'other-extension' },
    { ...valid, frameId: 1 },
    { ...valid, url: 'https://attacker.test/' },
    { ...valid, tab: { ...valid.tab, url: 'https://attacker.test/' } },
    { ...valid, tab: { ...valid.tab, windowId: 2 } },
    { ...valid, tab: { ...valid.tab, id: 11 } },
    { ...valid, tab: { ...valid.tab, id: 999 } },
    uiSender('search.html', { ...f.tab(12), url: searchUrl }),
  ];
  for (const sender of invalid) {
    for (const type of ['browser-search-state', 'browser-search-close']) {
      const result = await f.message({ type, restoreFocus: true }, sender);
      assert.equal(result.ok, false, JSON.stringify(sender));
      assert.equal(Object.hasOwn(result, 'sourceWindowId'), false);
      assert.equal(f.windows.has(10), true);
      assert.deepEqual(f.calls.removes, []);
    }
  }
  f.tabs.get(valid.tab.id).url = 'https://navigated-away.test/';
  assert.equal((await f.message({ type: 'browser-search-state' }, valid)).ok, false);
  assert.equal((await f.message({ type: 'browser-search-close', restoreFocus: true }, valid)).ok, false);
  assert.deepEqual(f.calls.removes, []);
});

test('legacy: ordinary webpage/content-script sender cannot open/close/read state or shortcut', async () => {
  const f = fixture();
  const sender = { id: extensionId, url: 'https://example.test/', tab: f.tab(11), frameId: 0 };
  for (const type of ['browser-search-open', 'browser-search-close', 'browser-search-state', 'browser-search-shortcut']) {
    assert.equal((await f.message({ type, restoreFocus: true }, sender)).ok, false);
  }
  assert.equal(f.calls.creates.length, 0);
});

test('legacy: close requires explicit boolean restoreFocus; no accidental navigation focus restoration', async () => {
  const f = fixture();
  await open(f);
  for (const restoreFocus of [undefined, null, 0, 'false']) {
    assert.equal((await f.message({ type: 'browser-search-close', restoreFocus }, f.searchSender())).ok, false);
  }
  assert.equal(f.calls.removes.length, 0);
});

test('legacy: shortcut reports actual assigned command only, never suggested default or other commands', async () => {
  const f = fixture();
  for (const [commands, shortcut] of [
    [[{ name: 'search-tabs', shortcut: 'Ctrl+Shift+J' }], 'Ctrl+Shift+J'],
    [[{ name: 'search-tabs', shortcut: '' }], ''],
    [[{ name: 'other-command', shortcut: 'Ctrl+K' }], ''],
    [[], ''],
  ]) {
    f.hooks.commands = commands;
    assert.deepEqual(await f.message({ type: 'browser-search-shortcut' }), { ok: true, shortcut });
  }
  f.chrome.commands.getAll = async () => { throw Error('commands unavailable'); };
  assert.deepEqual(await f.message({ type: 'browser-search-shortcut' }), { ok: true, shortcut: '' });
  delete f.chrome.commands;
  f.restart();
  assert.deepEqual(await f.message({ type: 'browser-search-shortcut' }), { ok: true, shortcut: '' });
});

test('legacy: small/negative-coordinate source window bounds stay centered; no-source uses safe default', async () => {
  const f = fixture();
  Object.assign(f.windows.get(1), { left: -800, top: -100, width: 320, height: 240 });
  await open(f);
  assert.deepEqual(f.calls.creates[0], { url: searchUrl, type: 'popup', focused: true, width: 320, height: 240, left: -800, top: -100 });
  const empty = fixture();
  empty.windows.clear();
  empty.tabs.clear();
  const result = await empty.message({ type: 'browser-search-open' });
  assert.equal(result.ok, true);
  assert.equal(result.sourceWindowId, null);
  assert.equal(result.currentTabId, null);
  assert.deepEqual(empty.calls.creates[0], { url: searchUrl, type: 'popup', focused: true, width: 680, height: 560 });
});

test('legacy: organize skips own search page including query/hash/pending URL before any model/group work', async () => {
  for (const extra of [{ url: searchUrl }, { url: searchUrl + '?mode=all#query' }, { url: '', pendingUrl: searchUrl }]) {
    const f = fixture();
    await open(f);
    Object.assign(f.tabs.get(f.searchSender().tab.id), extra);
    // No fetch/tabGroups mock exists: touching either would make this test fail.
    const result = await f.context.organize({ apply: true, incremental: true, windowId: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
  }
  const legacy = fixture();
  delete legacy.chrome.runtime.getURL;
  assert.equal(legacy.context.isBrowserSearchUrl('https://example.test/'), false);
});

test('legacy: failed creation releases open lock; retry succeeds and keeps old unrelated session entries', async () => {
  const f = fixture();
  f.stores.session.proposal = { preserve: true };
  f.hooks.beforeCreate = () => { throw Error('mock create denied'); };
  const failed = await f.message({ type: 'browser-search-open' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /mock create denied/);
  delete f.hooks.beforeCreate;
  assert.equal((await f.message({ type: 'browser-search-open' })).ok, true);
  assert.equal(f.calls.creates.length, 2);
  assert.deepEqual(f.stores.session.proposal, { preserve: true });
});
