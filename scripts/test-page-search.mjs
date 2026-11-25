#!/usr/bin/env node
// Real commands-event + isolated bridge contract proof; no browser/server/API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../extension/page-overlay.js', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const id = 'page-search-test', root = `chrome-extension://${id}/`;
const plain = value => JSON.parse(JSON.stringify(value));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
  async emit(...args) { return await Promise.all(this.listeners.map(fn => fn(...args))); } });
const ui = (page = 'home.html', tab) => ({ id, url: root + page, frameId: 0, ...(tab ? { tab } : {}) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const localAck = (message, extra = {}) => ({ ok: true, claimed: true, windowId: message.windowId,
  targetTabId: message.targetTabId, requestId: message.requestId, ...extra });

function fakePage(tab, notify) {
  const nodes = [], listeners = new Map(), timers = new Map();
  let timerId = 0;
  const previous = { isConnected: true, calls: [], focus(options) { this.calls.push(options); } };
  const document = { activeElement: previous };
  class Node {
    constructor(tag) { this.tagName = tag; this.style = {}; this.children = []; this.listeners = new Map(); this.isConnected = false; this.focuses = 0; this.open = false; nodes.push(this); }
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; child.isConnected = this.isConnected; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.isConnected = false; }
    attachShadow({ mode }) { assert.equal(mode, 'closed'); this.shadow = new Node('#shadow'); this.shadow.parent = this; return this.shadow; }
    get shadowRoot() { return null; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    emit(name, extra = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...extra }); }
    focus() { this.focuses++; }
    showModal() { this.open = true; this.modalCalls = (this.modalCalls || 0) + 1; }
    close() { this.open = false; this.closeCalls = (this.closeCalls || 0) + 1; }
  }
  document.documentElement = new Node('html'); document.documentElement.isConnected = true;
  document.createElement = tag => new Node(tag);
  const location = new URL(tab.url);
  const context = vm.createContext({ document, location,
    chrome: { runtime: { getURL: path => root + path, sendMessage: notify } },
    setTimeout(fn) { const n = ++timerId; timers.set(n, fn); return n; }, clearTimeout(n) { timers.delete(n); },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  });
  return { context, document, nodes, previous, timers, listeners,
    get host() { return document.documentElement.children[0]; },
    get iframe() { return nodes.filter(n => n.tagName === 'iframe').at(-1); },
    get dialog() { return nodes.filter(n => n.tagName === 'dialog').at(-1); },
    run(func, args = []) { return vm.runInContext(`(${func.toString()})(...${JSON.stringify(args)})`, context); },
  };
}

function fixture() {
  const windows = new Map([[1, { id: 1, type: 'normal', focused: true, state: 'normal' }], [2, { id: 2, type: 'normal', focused: false, state: 'normal' }]]);
  const tabs = new Map([[11, { id: 11, windowId: 1, active: true, url: 'https://example.test/', groupId: -1 }],
    [12, { id: 12, windowId: 1, active: false, url: 'https://example.test/other', groupId: -1 }],
    [21, { id: 21, windowId: 2, active: true, url: 'https://second.test/', groupId: -1 }]]);
  const stores = { session: {}, sync: {}, local: {} }, pages = new Map(), hooks = {}, pending = [], timers = new Map();
  const calls = { creates: [], tabCreates: [], removes: [], injections: [], sideOpens: [], messages: [], fetches: [], tabUpdates: [], windowUpdates: [], badge: [], warnings: [], order: [] };
  let context, timerId = 0, focusedId = 1, topDocument = new Map([[11, 'top-11'], [12, 'top-12'], [21, 'top-21']]);
  const live = (map, key) => { if (!map.has(key)) throw Error('missing ' + key); return map.get(key); };
  const chrome = {
    storage: Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, {
      async get(keys) { calls.order.push('storage'); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); },
      async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; },
    }])),
    runtime: { id, getURL: path => root + path, async sendMessage(msg) {
      calls.messages.push(plain(msg)); return await hooks.onNotification?.(msg);
    } },
    commands: { async getAll() { return []; } },
    windows: {
      async get(windowId) { calls.order.push('window-get'); return structuredClone(live(windows, windowId)); },
      async getLastFocused() { calls.order.push('last-focused'); return structuredClone(live(windows, focusedId)); },
      async update(windowId, props) { calls.windowUpdates.push({ windowId, ...plain(props) }); Object.assign(live(windows, windowId), props); if (props.focused) focusedId = windowId; return plain(live(windows, windowId)); },
      async create(props) { calls.creates.push(props); throw Error('new search windows are forbidden'); },
      async remove(windowId) { calls.removes.push(windowId); throw Error('must not close the source window'); },
    },
    tabs: {
      async get(tabId) { calls.order.push('tab-get'); return structuredClone(live(tabs, tabId)); },
      async query({ windowId, active } = {}) { calls.order.push('tabs-query'); return structuredClone([...tabs.values()].filter(t => (windowId == null || t.windowId === windowId) && (active == null || t.active === active))); },
      async update(tabId, props) { calls.tabUpdates.push({ tabId, ...plain(props) }); Object.assign(live(tabs, tabId), props); },
      async create(props) { calls.tabCreates.push(props); throw Error('home fallback is forbidden'); },
    },
    sidePanel: { async open(props) { calls.sideOpens.push(plain(props)); calls.order.push('side-open'); if (hooks.sideError) throw Error('gesture unavailable'); }, async setPanelBehavior() {} },
    action: { async setBadgeText(value) { calls.badge.push(plain(value)); }, async setBadgeBackgroundColor() {}, async setTitle() {} },
    alarms: {},
  };
  const topSender = tabId => ({ id, url: live(tabs, tabId).url, tab: plain(live(tabs, tabId)), frameId: 0, documentId: topDocument.get(tabId) });
  function page(tabId) {
    if (!pages.has(tabId)) pages.set(tabId, fakePage(live(tabs, tabId), msg => {
      const task = message(msg, topSender(tabId)); pending.push(task); return task;
    }));
    return pages.get(tabId);
  }
  chrome.scripting = { async executeScript(options) {
    calls.injections.push(options); calls.order.push('inject');
    assert.equal(options.world, 'ISOLATED');
    const tabId = options.target.tabId; live(tabs, tabId);
    if (hooks.beforeInject) await hooks.beforeInject(options);
    if (hooks.injectError) throw Error('Cannot access page');
    if (options.target.documentIds && options.target.documentIds[0] !== topDocument.get(tabId)) throw Error('old document');
    const p = page(tabId);
    if (options.files) { assert.deepEqual(plain(options.files), ['page-overlay.js']); vm.runInContext(bridge, p.context); }
    const result = options.func ? p.run(options.func, options.args) : undefined;
    return [{ frameId: 0, documentId: topDocument.get(tabId), result }];
  } };
  async function message(msg, sender = ui()) {
    return await new Promise(resolve => chrome.runtime.onMessage.listeners[0](msg, sender, result => resolve(plain(result))));
  }
  function restart() {
    chrome.runtime.onMessage = event(); chrome.runtime.onInstalled = event();
    chrome.commands.onCommand = event(); chrome.windows.onRemoved = event();
    for (const name of ['onCreated', 'onRemoved', 'onUpdated', 'onAttached']) chrome.tabs[name] = event();
    chrome.alarms.onAlarm = event();
    context = vm.createContext({ chrome, crypto: { randomUUID }, URL, AbortController,
      setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); }, console: { warn: (...args) => calls.warnings.push(args) },
      async fetch(url, options) { calls.fetches.push({ url, options: plain(options) }); return { async json() { return { ok: true, results: [] }; } }; },
    });
    vm.runInContext(source, context);
  }
  restart();
  return { chrome, stores, tabs, windows, calls, hooks, page, pages, message, restart, topSender, timers,
    expire(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.fn(); } },
    record(tabId = 11) { return stores.session.pageSearchRecords?.[tabId]; },
    tab(tabId = 11) { return plain(live(tabs, tabId)); },
    frame(tabId = 11, extra = {}) { const record = stores.session.pageSearchRecords?.[tabId]; return { id, url: root + 'search.html?embedded=' + record?.nonce,
      tab: plain(live(tabs, tabId)), frameId: 3, documentId: 'frame-doc-' + tabId, documentLifecycle: 'active', ...extra }; },
    command(tabId = 11) { return chrome.commands.onCommand.emit('search-tabs', tabId === null ? undefined : plain(live(tabs, tabId))); },
    async flush() { await Promise.all(pending.splice(0)); },
    focus(windowId) { focusedId = windowId; for (const w of windows.values()) w.focused = w.id === windowId; },
    async navigate(tabId, url) { Object.assign(live(tabs, tabId), { url }); await chrome.tabs.onUpdated.emit(tabId, { url, status: 'loading' }, plain(live(tabs, tabId))); topDocument.set(tabId, 'new-' + topDocument.get(tabId)); pages.delete(tabId); },
  };
}
async function authorize(f, tabId = 11) {
  const result = await f.message({ type: 'page-search-state', nonce: f.record(tabId).nonce }, f.frame(tabId));
  assert.deepEqual(result, { ok: true, sourceWindowId: f.tab(tabId).windowId, currentTabId: tabId, embedded: true });
  return f.frame(tabId);
}

test('0.3 manifest adds only HTTP(S) search HTML WAR, no permissions or manifest content scripts', () => {
  assert.equal(manifest.version, '0.4.0');
  assert.deepEqual(manifest.permissions, ['tabs', 'tabGroups', 'storage', 'sidePanel', 'alarms', 'favicon', 'bookmarks', 'history', 'sessions', 'scripting']);
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ['search.html'], matches: ['http://*/*', 'https://*/*'] }]);
  assert.equal(Object.hasOwn(manifest, 'content_scripts'), false);
});

test('actual CmdK event mounts one closed-shadow top-layer iframe in current HTTP tab, never creates windows/tabs', async () => {
  const f = fixture(); await f.command();
  const record = f.record(), p = f.page(11);
  assert.match(record.nonce, /^[a-f0-9-]{36}$/); assert.equal(record.topDocumentId, 'top-11');
  assert.equal(record.sourceTabId, 11); assert.equal(record.windowId, 1);
  assert.equal(record.frameId, null); assert.equal(record.documentId, null);
  assert.equal(p.host.shadowRoot, null); assert.equal(p.iframe.src, root + 'search.html?embedded=' + record.nonce);
  assert.equal(p.dialog.modalCalls, 1); assert.equal(p.dialog.open, true);
  assert.equal(p.iframe.children.length, 0); assert.equal(p.host.children.length, 0);
  assert.equal(f.calls.injections.length, 2); assert.equal(f.calls.sideOpens.length, 0);
  assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []);
  p.iframe.emit('load'); await f.flush();
  assert.ok(p.iframe.focuses >= 1);
  assert.deepEqual(f.calls.messages.at(-1), { type: 'page-search-focus', nonce: record.nonce, targetTabId: 11 });
});

test('private services reject unregistered WAR iframes and pre-handshake requests, then authorize only the bound nonce/frame/document', async () => {
  const f = fixture();
  const malicious = { id, url: root + 'search.html?embedded=attacker', frameId: 4, documentId: 'attacker', tab: f.tab() };
  for (const type of ['page-search-state', 'page-search-close', 'browser-search-open', 'page-search-reset', 'reset', 'dup-count', 'state']) {
    assert.equal((await f.message({ type, nonce: 'attacker', restoreFocus: true }, malicious)).ok, false, type);
  }
  await f.command(); const nonce = f.record().nonce;
  for (const type of ['page-search-close']) {
    assert.equal((await f.message({ type, nonce, restoreFocus: true }, f.frame())).ok, false, type);
  }
  assert.equal(f.calls.fetches.length, 0);
  const frame = await authorize(f);
  assert.equal(f.record().frameId, 3); assert.equal(f.record().documentId, frame.documentId);
  assert.equal(f.page(11).timers.size, 0, 'handshake cancels CSP watchdog');
  await authorize(f); // Same document may recheck state, but never rebind.
  for (const extra of [{ id: 'other' }, { frameId: 0 }, { frameId: 9 }, { documentId: 'reloaded' }, { documentId: '' },
    { url: root + 'search.html?embedded=' + nonce + '#extra' }, { url: root + 'search.html?embedded=other' },
    { tab: { ...f.tab(), id: 12 } }, { tab: { ...f.tab(), windowId: 2 } }, { documentLifecycle: 'prerender' }]) {
    for (const type of ['page-search-state', 'page-search-close']) {
      assert.equal((await f.message({ type, nonce, restoreFocus: true }, { ...frame, ...extra })).ok, false, JSON.stringify({ type, extra }));
    }
  }
  assert.equal(f.calls.fetches.length, 0);
});

test('forged nonce/URL/top frame can never win first handshake binding', async () => {
  const f = fixture(); await f.command(); const nonce = f.record().nonce;
  for (const sender of [f.frame(11, { id: 'other' }), f.frame(11, { frameId: 0 }), f.frame(11, { url: root + 'search.html' }),
    f.frame(11, { url: root + 'search.html?embedded=bad' }), f.frame(11, { documentId: undefined }), f.frame(11, { tab: f.tab(12) })]) {
    assert.equal((await f.message({ type: 'page-search-state', nonce }, sender)).ok, false);
    assert.equal(f.record().frameId, null);
  }
  assert.equal((await f.message({ type: 'page-search-state', nonce: 'external' }, f.frame())).ok, false);
  await authorize(f);
});

test('Esc/scrim close restores previous DOM focus; successful result close never steals source tab/window or DOM focus', async () => {
  for (const restoreFocus of [true, false]) {
    const f = fixture(); await f.command(); const sender = await authorize(f), nonce = f.record().nonce, p = f.page(11);
    if (!restoreFocus) f.focus(2);
    const result = await f.message({ type: 'page-search-close', nonce, restoreFocus }, sender);
    assert.deepEqual(result, { ok: true, closed: true }); assert.equal(f.record(), undefined);
    assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, restoreFocus ? 1 : 0);
    assert.equal(p.dialog.closeCalls || 0, restoreFocus ? 1 : 0);
    assert.deepEqual(f.calls.tabUpdates, []); assert.deepEqual(f.calls.windowUpdates, []); assert.deepEqual(f.calls.removes, []);
  }
});

test('native dialog cancel is authenticated top-document dismissal, with no page postMessage listener', async () => {
  const f = fixture(); await f.command(); await authorize(f); const nonce = f.record().nonce, p = f.page(11);
  assert.equal(p.listeners.has('message'), false);
  assert.equal((await f.message({ type: 'page-search-overlay-dismiss', nonce }, { ...f.topSender(11), documentId: 'wrong' })).ok, false);
  p.dialog.emit('cancel'); await f.flush();
  assert.equal(f.record(), undefined); assert.equal(p.previous.calls.length, 1);
});

test('repeated command toggles same tab, cross-tab overlays remain independent, SW restart retains exact bindings', async () => {
  const f = fixture(); await f.command(); const sender = await authorize(f), nonce = f.record().nonce;
  await f.command(12); const secondNonce = f.record(12).nonce;
  assert.notEqual(nonce, secondNonce); assert.ok(f.record());
  f.restart();
  assert.equal((await f.message({ type: 'page-search-state', nonce }, sender)).ok, true);
  assert.equal((await f.message({ type: 'page-search-state', nonce }, { ...sender, documentId: 'new-child' })).ok, false);
  await f.command(); assert.equal(f.record(), undefined); assert.ok(f.record(12));
  assert.equal(f.page(11).previous.calls.length, 1); assert.equal(f.page(12).host.isConnected, true);
  assert.deepEqual(f.calls.creates, []);
});

test('concurrent command opens coalesce without toggling the just-created iframe', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.hooks.beforeInject = async options => { if (options.files) { entered.resolve(); await gate.promise; } };
  const first = f.command(); await entered.promise; const second = f.command(); gate.resolve();
  await Promise.all([first, second]); assert.ok(f.record());
  assert.equal(f.calls.injections.filter(call => call.files).length, 1);
});

test('extension-owned page open ignores external nonce/source IDs, reuses and focuses current overlay without toggle', async () => {
  const f = fixture(); await f.command(); await authorize(f); const nonce = f.record().nonce;
  const result = await f.message({ type: 'page-search-open', nonce: 'attacker', windowId: 2, sourceTabId: 21 }, ui('popup.html', f.tab()));
  assert.equal(result.ok, true); assert.equal(result.reused, true); assert.equal(f.record().nonce, nonce);
  assert.deepEqual(f.calls.messages.at(-1), { type: 'page-search-focus', nonce, targetTabId: 11 });
  for (const sender of [{ id, url: f.tab().url, tab: f.tab(), frameId: 0 }, f.frame()]) {
    assert.equal((await f.message({ type: 'page-search-open' }, sender)).ok, false);
  }
});

test('navigation/pagehide/tab removal clears record/container without source focus restoration, including after restart', async () => {
  for (const mode of ['navigation', 'pagehide', 'tab-close']) {
    const f = fixture(); await f.command(); const sender = await authorize(f), nonce = f.record().nonce, p = f.page(11); f.restart();
    if (mode === 'navigation') await f.navigate(11, 'https://new.test/');
    if (mode === 'pagehide') { p.listeners.get('pagehide')(); await f.flush(); }
    if (mode === 'tab-close') { f.tabs.delete(11); p.listeners.get('pagehide')(); await f.chrome.tabs.onRemoved.emit(11); await f.flush(); }
    assert.equal(f.record(), undefined); assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, 0);
    assert.equal((await f.message({ type: 'page-search-state', nonce }, sender)).ok, false);
    assert.deepEqual(f.calls.windowUpdates, []); assert.deepEqual(f.calls.tabUpdates, []);
  }
});

for (const url of ['chrome://settings/', 'chrome://extensions/', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test']) {
  test(`restricted ${url} calls sidePanel.open synchronously in command event, never injects or opens window/home`, async () => {
    const f = fixture(); f.tabs.get(11).url = url; f.calls.order.length = 0;
    const operation = f.command(); assert.deepEqual(f.calls.sideOpens, [{ windowId: 1 }]);
    assert.equal(f.calls.order[0], 'side-open'); await operation;
    assert.equal(f.calls.injections.length, 0); assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []);
    const pending = f.stores.session.pendingSideSearch[1];
    assert.equal(pending.windowId, 1); assert.equal(pending.currentTabId, 11); assert.equal(pending.query, ''); assert.equal(pending.provider, 'all');
    assert.deepEqual(f.calls.messages.at(-1), { type: 'page-search-sidepanel', windowId: 1 });
  });
}

test('sidepanel pending is window-scoped, owner-only, recoverable after initialization and explicitly acknowledged', async () => {
  const f = fixture(); f.tabs.get(11).url = 'chrome://settings/'; await f.command();
  f.tabs.get(21).url = 'chrome://extensions/'; await f.command(21); f.restart();
  const first = await f.message({ type: 'page-search-sidepanel-state', windowId: 1 }, ui('sidepanel.html'));
  assert.equal(first.pending.windowId, 1); assert.equal(first.pending.currentTabId, 11);
  assert.equal((await f.message({ type: 'page-search-sidepanel-state', windowId: 2 }, ui('sidepanel.html'))).pending.currentTabId, 21);
  for (const [sender, windowId] of [[ui('home.html'), 1], [ui('sidepanel.html', f.tab(21)), 1], [ui('sidepanel.html'), 999], [f.frame(), 1]]) {
    assert.equal((await f.message({ type: 'page-search-sidepanel-state', windowId }, sender)).ok, false);
  }
  assert.equal((await f.message({ type: 'page-search-sidepanel-state', windowId: 1, ack: true, pendingId: 'stale' }, ui('sidepanel.html'))).ok, false);
  assert.equal((await f.message({ type: 'page-search-sidepanel-state', windowId: 1, ack: true, pendingId: first.pending.id }, ui('sidepanel.html'))).pending.id, first.pending.id);
  assert.equal((await f.message({ type: 'page-search-sidepanel-state', windowId: 1 }, ui('sidepanel.html'))).pending, null);
  assert.ok(f.stores.session.pendingSideSearch[2]);
});

test('injection denial and CSP handshake timeout clean overlay state then offer honest sidepanel fallback; gesture failure only badges', async () => {
  for (const mode of ['injection', 'CSP']) {
    const f = fixture(); f.hooks.sideError = true;
    if (mode === 'injection') f.hooks.injectError = true;
    await f.command();
    if (mode === 'CSP') {
      const p = f.page(11); p.iframe.emit('load'); await f.flush(); assert.ok(f.record());
      for (const fn of p.timers.values()) fn(); await f.flush();
      assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, 0);
    }
    assert.equal(f.record(), undefined); assert.equal(f.calls.sideOpens.length, 1); assert.ok(f.calls.badge.some(b => b.text === '!'));
    assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []);
  }
});

test('undefined command tab uses last-focused existing normal window and never creates a fallback window', async () => {
  const f = fixture(); f.focus(2); await f.command(null); assert.ok(f.record(21)); assert.equal(f.record(), undefined);
  f.windows.clear(); f.tabs.clear(); await f.command(null); assert.ok(f.calls.badge.length); assert.deepEqual(f.calls.creates, []);
});

for (const url of ['chrome://newtab', 'chrome://newtab/', 'chrome://new-tab-page/', 'brave://newtab/',
  'brave://new-tab-page/', 'edge://newtab/', 'edge://new-tab-page/', 'vivaldi://newtab/', 'opera://newtab/']) {
  test(`masked home ${url} command waits for exact main-tab claim without first opening Sidebar`, async () => {
    const f = fixture(), gate = deferred(), entered = deferred(); f.tabs.get(11).url = url;
    f.hooks.onNotification = async msg => {
      if (msg.type !== 'page-search-local') return;
      entered.resolve(msg); await gate.promise; return localAck(msg);
    };
    const operation = f.command();
    assert.deepEqual(f.calls.sideOpens, [], 'newtab candidates cannot pre-open native Sidebar');
    const request = await entered.promise;
    assert.equal(request.windowId, 1); assert.equal(request.targetTabId, 11); assert.equal(typeof request.requestId, 'string');
    gate.resolve(); const [result] = await operation;
    assert.equal(result.inline, true); assert.equal(result.ok, true);
    assert.equal(f.calls.injections.length, 0); assert.deepEqual(f.calls.sideOpens, []);
    assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []); assert.equal(f.timers.size, 0);
  });
}

for (const page of ['home.html', 'sidepanel.html']) {
  test(`canonical ${page} requires matching ACK before reporting inline; native Sidebar is not its consumer`, async () => {
    const f = fixture(); f.tabs.get(11).url = root + page;
    const consumers = [{ surface: 'sidepanel', windowId: 1, tabId: undefined }, { surface: page, windowId: 1, tabId: 11 }];
    const claimed = [];
    f.hooks.onNotification = msg => {
      if (msg.type !== 'page-search-local') return;
      for (const client of consumers) {
        if (!Number.isInteger(client.tabId) || client.tabId !== msg.targetTabId || client.windowId !== msg.windowId) continue;
        claimed.push(client.surface); return localAck(msg);
      }
    };
    const [result] = await f.command(); assert.equal(result.inline, true); assert.deepEqual(claimed, [page]);
    const request = f.calls.messages.at(-1);
    assert.equal(request.type, 'page-search-local'); assert.equal(request.targetTabId, 11); assert.equal(request.windowId, 1);
    assert.equal(typeof request.requestId, 'string'); assert.equal(f.calls.injections.length, 0); assert.deepEqual(f.calls.sideOpens, []);
    assert.equal(f.timers.size, 0);
  });
}

for (const entry of ['native-sidepanel', 'command-without-tab']) {
  test(`${entry} selects actual active main tab for masked newtab claim and ignores supplied IDs`, async () => {
    const f = fixture(); f.focus(2); f.tabs.get(21).url = 'chrome://newtab/';
    f.hooks.onNotification = msg => msg.type === 'page-search-local' ? localAck(msg) : undefined;
    const result = entry === 'native-sidepanel'
      ? await f.message({ type: 'page-search-open', windowId: 1, sourceTabId: 11 }, ui('sidepanel.html'))
      : (await f.command(null))[0];
    assert.deepEqual(plain(result), { ok: true, inline: true, sourceWindowId: 2, currentTabId: 21 });
    const request = f.calls.messages.at(-1); assert.equal(request.targetTabId, 21); assert.equal(request.windowId, 2);
    assert.deepEqual(f.calls.sideOpens, []); assert.equal(f.calls.injections.length, 0);
    assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []);
  });
}

for (const [name, reply] of [
  ['no consumer', () => undefined], ['not claimed', msg => localAck(msg, { claimed: false })],
  ['error ACK', msg => localAck(msg, { ok: false })], ['wrong tab', msg => localAck(msg, { targetTabId: 12 })],
  ['wrong window', msg => localAck(msg, { windowId: 2 })], ['stale request', msg => localAck(msg, { requestId: 'stale' })],
  ['missing request', msg => { const ack = localAck(msg); delete ack.requestId; return ack; }],
  ['string tab', msg => localAck(msg, { targetTabId: String(msg.targetTabId) })],
  ['throw', () => { throw Error('missing receiver'); }],
]) {
  for (const url of ['chrome://newtab/', root + 'home.html']) {
    test(`${name} on ${url} never falsely reports inline and honestly falls back without injection`, async () => {
      const f = fixture(); f.tabs.get(11).url = url;
      f.hooks.onNotification = msg => msg.type === 'page-search-local' ? reply(msg) : undefined;
      const result = await f.message({ type: 'page-search-open' }, ui('sidepanel.html'));
      assert.notEqual(result.inline, true); assert.equal(result.sidepanel, true); assert.equal(result.ok, true);
      assert.ok(f.calls.messages.some(msg => msg.type === 'page-search-local'), 'loaded home must be given a claim attempt');
      assert.equal(f.calls.injections.length, 0); assert.deepEqual(f.calls.sideOpens, [{ windowId: 1 }]);
      assert.deepEqual(f.calls.creates, []); assert.deepEqual(f.calls.tabCreates, []); assert.equal(f.timers.size, 0);
    });
  }
}

test('unanswered local claim expires at 600ms, coalesces opening, and ignores an old late ACK', async () => {
  const f = fixture(), requests = [], entered = deferred(); f.tabs.get(11).url = 'chrome://newtab/';
  f.hooks.onNotification = msg => {
    if (msg.type !== 'page-search-local') return;
    const reply = deferred(); requests.push({ msg, reply }); entered.resolve(); return reply.promise;
  };
  const first = f.command(); await entered.promise; const duplicate = f.command();
  assert.deepEqual([...f.timers.values()].map(timer => timer.delay), [600]);
  assert.deepEqual(f.calls.sideOpens, []); f.expire(600);
  const [[result]] = await Promise.all([first, duplicate]);
  assert.notEqual(result.inline, true); assert.equal(result.sidepanel, true); assert.equal(requests.length, 1);
  f.hooks.onNotification = msg => msg.type === 'page-search-local' ? localAck(msg) : undefined;
  const [next] = await f.command(); assert.equal(next.inline, true);
  const nextRequest = f.calls.messages.findLast(msg => msg.type === 'page-search-local');
  assert.notEqual(nextRequest.requestId, requests[0].msg.requestId);
  requests[0].reply.resolve(localAck(requests[0].msg)); await Promise.resolve();
  assert.equal(f.calls.sideOpens.length, 1); assert.equal(f.timers.size, 0);
});

test('successful home claim or HTTP overlay clears only its window pending Sidebar request, including queued sidepanel reads', async () => {
  for (const route of ['home', 'new-http', 'reused-http']) {
    const f = fixture(); if (route === 'reused-http') await f.command();
    f.tabs.get(11).url = 'chrome://settings/'; await f.command();
    f.tabs.get(21).url = 'chrome://extensions/'; await f.command(21);
    const otherPending = plain(f.stores.session.pendingSideSearch[2]);
    let sideRead;
    if (route === 'home') {
      f.tabs.get(11).url = 'chrome://newtab/';
      f.hooks.onNotification = msg => {
        if (msg.type !== 'page-search-local') return;
        sideRead = f.message({ type: 'page-search-sidepanel-state', windowId: 1 }, ui('sidepanel.html'));
        return localAck(msg);
      };
    } else f.tabs.get(11).url = 'https://example.test/';
    const result = await f.message({ type: 'page-search-open' }, ui('sidepanel.html', f.tab()));
    assert.equal(result.ok, true); assert.equal(route === 'home' ? result.inline : result.embedded, true);
    assert.equal(f.stores.session.pendingSideSearch[1], undefined);
    assert.deepEqual(f.stores.session.pendingSideSearch[2], otherPending);
    if (sideRead) assert.equal((await sideRead).pending, null, 'queued old sidebar work cannot reopen after a home claim');
  }
});

test('home command stays inline and window removal revokes page and pending records without closing other browser windows', async () => {
  const f = fixture(); f.tabs.get(11).url = root + 'home.html';
  f.hooks.onNotification = msg => msg.type === 'page-search-local' ? localAck(msg) : undefined;
  await f.command(); assert.equal(f.calls.messages.at(-1).type, 'page-search-local'); assert.equal(f.calls.injections.length, 0);
  await f.command(12); f.tabs.get(11).url = 'chrome://settings/'; await f.command();
  await f.chrome.windows.onRemoved.emit(1);
  assert.equal(f.record(12), undefined); assert.equal(f.stores.session.pendingSideSearch[1], undefined); assert.deepEqual(f.calls.removes, []);
});

test('cross-window tab attachment closes the old overlay and authorization without migrating stale iframe context or restoring focus', async () => {
  const f = fixture(); await f.command(); const sender = await authorize(f), nonce = f.record().nonce, p = f.page(11);
  f.restart(); f.tabs.get(11).windowId = 2;
  await f.chrome.tabs.onAttached.emit(11, { newWindowId: 2, newPosition: 0 });
  assert.equal(f.record(), undefined); assert.equal(p.host, undefined);
  assert.equal(p.previous.calls.length, 0); assert.equal(p.dialog.closeCalls || 0, 0);
  assert.equal((await f.message({ type: 'page-search-close', nonce, restoreFocus: true }, { ...sender, tab: f.tab() })).ok, false);
  assert.equal((await f.message({ type: 'search-documents', nonce, query: 'private' }, { ...sender, tab: f.tab() })).ok, false);
  assert.deepEqual(f.calls.tabUpdates, []); assert.deepEqual(f.calls.windowUpdates, []); assert.deepEqual(f.calls.creates, []);
});

test('old window closes before onAttached: surviving moved tab loses the actual modal, not just its session record', async () => {
  const f = fixture(); await f.command(); await authorize(f); const p = f.page(11);
  f.tabs.get(11).windowId = 2; f.windows.delete(1);
  await f.chrome.windows.onRemoved.emit(1);
  assert.equal(f.record(), undefined); assert.equal(p.host, undefined);
  await f.chrome.tabs.onAttached.emit(11, { newWindowId: 2, newPosition: 0 });
  assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, 0);
});

test('trusted onAttached clears a live orphan after old-window cleanup loses its record or temporary scripting fails', async () => {
  for (const mode of ['missing-record', 'scripting-failed']) {
    const f = fixture(); await f.command(); await authorize(f); const p = f.page(11);
    f.tabs.get(11).windowId = 2;
    if (mode === 'missing-record') delete f.stores.session.pageSearchRecords[11];
    else {
      f.hooks.injectError = true; await f.chrome.windows.onRemoved.emit(1); f.hooks.injectError = false;
    }
    assert.equal(f.record(), undefined); assert.ok(p.host, 'reproduction needs a live orphan modal');
    await f.chrome.tabs.onAttached.emit(11, { newWindowId: 2, newPosition: 0 });
    assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, 0);
    assert.deepEqual(f.calls.tabUpdates, []); assert.deepEqual(f.calls.windowUpdates, []); assert.deepEqual(f.calls.creates, []);
  }
});

test('native dialog cancel removes its modal synchronously even if the extension worker cannot receive dismissal', async () => {
  const f = fixture(); await f.command(); await authorize(f); const p = f.page(11);
  p.context.chrome.runtime.sendMessage = () => { throw Error('extension worker unavailable'); };
  p.dialog.emit('cancel');
  assert.equal(p.host, undefined); assert.equal(p.previous.calls.length, 1);
  assert.equal(p.timers.size, 0); assert.equal(p.listeners.has('pagehide'), false);
});
