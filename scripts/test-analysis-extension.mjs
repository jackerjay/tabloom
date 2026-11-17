#!/usr/bin/env node
// Offline MV3/DOM contract proof. No dependencies, server, real browser or model calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const AUTO = 'ai-tab-auto-organize';
const STATE = 'autoOrganizeState';
const plain = value => JSON.parse(JSON.stringify(value));
const tab = (id, extra = {}) => ({ id, windowId: 1, groupId: -1, title: `Original ${id}`, url: `https://example.test/${id}`, pinned: false, status: 'complete', ...extra });
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { return await Promise.all(this.listeners.map(fn => fn(...args))); } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fakePage(t, notify) {
  const observers = [], notifications = [], listeners = new Map();
  let title = t.title, pending = false, body = `Fresh body ${t.id}`, main = '', description = 'Page description';
  const location = { href: t.url };
  const document = {
    head: {},
    get title() { return title; },
    set title(value) { title = String(value); t.title = title; pending = true; },
    body: { get innerText() { return body; } },
    querySelector(selector) {
      if (selector === 'main, article') return main ? { innerText: main } : null;
      if (selector === 'meta[name="description"]') return { getAttribute() { return description; } };
      return null;
    },
    querySelectorAll(selector) { return selector === 'h1,h2' ? [{ textContent: 'Heading' }] : []; },
  };
  class MutationObserver {
    constructor(fn) { this.fn = fn; this.active = false; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.active = true; }
    disconnect() { this.active = false; }
  }
  const context = vm.createContext({ document, location, MutationObserver,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    chrome: { runtime: { async sendMessage(message) { notifications.push(plain(message)); return await notify?.(message); } } },
  });
  return {
    document, location, context, observers, notifications,
    get body() { return body; }, set body(value) { body = value; },
    set main(value) { main = value; }, set description(value) { description = value; },
    run(func, args = []) { return vm.runInContext(`(${func.toString()})(...${JSON.stringify(args)})`, context); },
    flush() {
      for (let i = 0; pending && i < 10; i++) {
        pending = false;
        for (const observer of observers) if (observer.active) observer.fn([{ target: document.head }]);
      }
      assert.equal(pending, false, 'title observer must settle without a mutation loop');
    },
  };
}

function fixture({ tabs: initial = [tab(1)], groups: initialGroups = [], settings = {}, saved = null } = {}) {
  let now = 1_000_000, context, nextGroup = 100;
  const tabs = new Map(initial.map(t => [t.id, structuredClone(t)]));
  const windows = new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]);
  const groups = new Map(initialGroups.map(g => [g.id, { color: 'blue', collapsed: false, windowId: 1, ...g }]));
  const stores = { session: saved ? { [STATE]: structuredClone(saved) } : {}, local: {}, sync: { settings: { autoOrganize: false, ...settings } } };
  const alarms = new Map(), pages = new Map(), modelCache = new Map();
  const calls = { requests: [], writes: [], reads: [], groups: [], groupUpdates: [], moves: [], creates: [], clears: [], warnings: [], notifications: [] };
  const hooks = {}, pendingMessages = [];
  const chrome = { runtime: { id: 'analysis-test', getURL: path => `chrome-extension://analysis-test/${path}` }, tabs: {}, windows: {}, alarms: {}, storage: {} };
  const indices = () => { let index = 0; for (const t of tabs.values()) t.index = index++; };
  const get = id => { const t = tabs.get(id); if (!t) throw Error('missing tab'); return t; };
  function addPage(t) {
    pages.set(t.id, fakePage(t, message => {
      const task = send(message, { id: chrome.runtime.id, url: t.url, tab: structuredClone(t), frameId: 0 });
      pendingMessages.push(task); return task;
    }));
  }
  for (const t of tabs.values()) addPage(t);
  for (const [name, values] of Object.entries(stores)) chrome.storage[name] = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(values[k])])); },
    async set(value) { Object.assign(values, structuredClone(value)); },
    async remove(key) { delete values[key]; },
  };
  Object.assign(chrome.tabs, {
    async query({ windowId, groupId, active } = {}) { return structuredClone([...tabs.values()].filter(t => (windowId == null || t.windowId === windowId) && (groupId == null || t.groupId === groupId) && (active == null || t.active === active))); },
    async get(id) { return structuredClone(get(id)); },
    async group(options) {
      calls.groups.push(plain(options));
      if (hooks.groupError) throw Error(hooks.groupError);
      const id = options.groupId ?? nextGroup++;
      if (!groups.has(id)) groups.set(id, { id, windowId: options.createProperties.windowId, title: '', color: 'grey', collapsed: false });
      for (const tid of options.tabIds) get(tid).groupId = id;
      return id;
    },
    async move(id, props) { calls.moves.push({ id, ...props }); get(id).index = props.index; return structuredClone(get(id)); },
    async update(_id, props) { assert.equal(Object.hasOwn(props, 'title'), false, 'a real browser cannot tabs.update({title})'); },
  });
  Object.assign(chrome.windows, {
    async get(id) { if (!windows.has(id)) throw Error('missing window'); return structuredClone(windows.get(id)); },
    async getAll({ windowTypes } = {}) { return structuredClone([...windows.values()].filter(w => !windowTypes || windowTypes.includes(w.type))); },
    async getLastFocused() { return { id: 1, type: 'normal' }; },
  });
  Object.assign(chrome.alarms, {
    async create(name, options) { calls.creates.push({ name, ...plain(options) }); alarms.set(name, plain(options)); },
    async clear(name) { calls.clears.push(name); return alarms.delete(name); },
    async getAll() { return [...alarms].map(([name, props]) => ({ name, ...props })); },
  });
  chrome.tabGroups = {
    async query({ windowId }) { return structuredClone([...groups.values()].filter(g => g.windowId === windowId)); },
    async update(id, values) { calls.groupUpdates.push({ id, ...plain(values) }); Object.assign(groups.get(id), values); },
    async move(id, props) { calls.moves.push({ groupId: id, ...props }); },
  };
  chrome.scripting = {
    async executeScript({ target, func, args = [] }) {
      const t = get(target.tabId);
      if (hooks.restricted?.has(t.id)) throw Error('Cannot access page');
      if (args[0]) { calls.writes.push(t.id); await hooks.beforeWrite?.(t.id); }
      else calls.reads.push(t.id);
      return [{ result: pages.get(t.id).run(func, args) }];
    },
  };
  chrome.bookmarks = { async getTree() { return []; } };
  chrome.action = { async setBadgeText() {}, async setBadgeBackgroundColor() {} };
  class Clock extends Date { static now() { return now; } }
  async function send(message, sender = {}) {
    return await new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, sender, result => resolve(plain(result))));
  }
  function restart() {
    for (const [api, names] of [[chrome.runtime, ['onMessage', 'onInstalled']], [chrome.tabs, ['onCreated', 'onUpdated', 'onRemoved']], [chrome.windows, ['onRemoved']], [chrome.alarms, ['onAlarm']], [chrome.storage, ['onChanged']]]) for (const name of names) api[name] = event();
    context = vm.createContext({ chrome, URL, AbortController, Date: Clock, setTimeout: () => 1, clearTimeout() {},
      console: { warn: (...args) => calls.warnings.push(args) },
      async fetch(_url, options) {
        const payload = JSON.parse(options.body);
        calls.requests.push(payload);
        if (hooks.fetchError) throw Error(hooks.fetchError);
        const hitTabIds = [], missTabIds = [];
        for (const t of payload.tabs) {
          const key = JSON.stringify([t.url, t.snippet, t.bookmarkPath]);
          (modelCache.has(key) ? hitTabIds : missTabIds).push(t.id);
          modelCache.set(key, true);
        }
        const result = {
          source: 'ai', backend: 'offline-mock', elapsedMs: 1,
          groups: [{ name: hooks.groupName || 'Reading', color: 'blue', tabIds: payload.tabs.map(t => t.id) }],
          tabTitles: payload.tabs.map(t => ({ id: t.id, title: `AI ${t.id}`, source: 'ai' })),
          cache: { hits: hitTabIds.length, misses: missTabIds.length, hitTabIds, missTabIds },
        };
        await hooks.onFetch?.(payload, result);
        return { ok: true, async json() { return result; } };
      },
    });
    vm.runInContext(source, context);
  }
  indices(); restart();
  return {
    chrome, stores, tabs, groups, windows, pages, calls, hooks, alarms, restart, send,
    get context() { return context; },
    tick(ms) { now += ms; },
    async ready() { await vm.runInContext('autoReady', context); await vm.runInContext('autoQueue', context); await Promise.all(pendingMessages.splice(0)); },
    async configure(values) {
      const before = structuredClone(stores.sync.settings);
      Object.assign(stores.sync.settings, values);
      await chrome.storage.onChanged.emit({ settings: { oldValue: before, newValue: structuredClone(stores.sync.settings) } }, 'sync');
    },
    async fire(name = `${AUTO}:1`) { alarms.delete(name); await chrome.alarms.onAlarm.emit({ name }); },
    async update(id, info) { Object.assign(get(id), info); if (info.url) pages.get(id).location.href = info.url; await chrome.tabs.onUpdated.emit(id, info, structuredClone(get(id))); },
    async add(t) { tabs.set(t.id, structuredClone(t)); addPage(get(t.id)); indices(); await chrome.tabs.onCreated.emit(structuredClone(t)); },
    async close(id) { tabs.delete(id); await chrome.tabs.onRemoved.emit(id); },
  };
}

test('delay accepts custom integer seconds in [5, 3600], canonicalizes strings, rejects coercion tricks', async () => {
  const f = fixture(); await f.ready();
  for (const value of [undefined, null, true, 0, -1, 1, 4, 30.5, 3601, Infinity, NaN, {}, [], 'oops', '0x20']) assert.equal(f.context.normalizeAutoDelay(value), 30);
  for (const value of [5, 29, 30, 60, 120, 300, 900, 3600, '60', '120', '300']) assert.equal(f.context.normalizeAutoDelay(value), Number(value));
  await f.configure({ autoOrganizeDelaySeconds: '120', autoOrganize: true });
  assert.equal(f.stores.sync.settings.autoOrganizeDelaySeconds, 120);
  assert.equal(f.alarms.get(`${AUTO}:1`).when, 1_120_000);
});

test('enable, delay changes, disable and reenable reschedule existing dirty pages and clear pending alarms', async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.alarms.size, 0);
  await f.configure({ autoOrganize: true });
  assert.equal(f.alarms.get(`${AUTO}:1`).when, 1_030_000);
  f.tick(5000); await f.configure({ autoOrganizeDelaySeconds: 900 });
  assert.equal(f.alarms.get(`${AUTO}:1`).when, 1_905_000);
  f.alarms.set(AUTO, {});
  await f.configure({ autoOrganize: false });
  assert.equal(f.alarms.size, 0);
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  await f.fire(AUTO); assert.equal(f.calls.requests.length, 0);
  await f.configure({ autoOrganize: true, autoOrganizeDelaySeconds: 60 });
  assert.equal(f.alarms.get(`${AUTO}:1`).when, 1_065_000);
});

test('each normal window has its own debounce; popup/extension/search pages are never queued', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  const first = f.alarms.get(`${AUTO}:1`).when;
  f.tick(5000); await f.add(tab(2, { windowId: 2 }));
  assert.equal(f.alarms.get(`${AUTO}:1`).when, first);
  assert.equal(f.alarms.get(`${AUTO}:2`).when, first + 5000);
  await f.add(tab(3, { windowId: 3 }));
  await f.add(tab(4, { url: 'chrome-extension://analysis-test/search.html' }));
  await f.add(tab(5, { url: 'chrome://newtab/' }));
  assert.equal(f.alarms.has(`${AUTO}:3`), false);
  assert.equal(f.stores.session[STATE].tabs[4], undefined);
  await f.fire(AUTO);
  assert.deepEqual(f.calls.requests.map(r => r.tabs.map(t => t.id)).sort(), [[1], [2]]);
  assert.equal(f.stores.local.orgHistory.length, 2, 'concurrent window completions must preserve both history snapshots');
});

test('pure title updates, including our injected AI title, do not queue or reset debounce', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  const before = structuredClone(f.stores.session[STATE]);
  const creates = f.calls.creates.length;
  await f.update(1, { title: 'AI own title' });
  assert.deepEqual(f.stores.session[STATE], before);
  assert.equal(f.calls.creates.length, creates);
  await f.fire();
  await f.update(1, { title: 'AI 1' });
  assert.equal(f.stores.session[STATE].tabs[1].dirty, false);
  assert.equal(f.alarms.size, 0);
  await f.update(1, { status: 'loading' });
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
});

test('session recovery preserves deadlines/config and removed tabs clean dirty records and alarms', async () => {
  const f = fixture({ settings: { autoOrganize: true, autoOrganizeDelaySeconds: 300 } }); await f.ready();
  const deadline = f.alarms.get(`${AUTO}:1`).when;
  f.tick(10000); f.alarms.clear(); f.restart(); await f.ready();
  assert.equal(f.alarms.get(`${AUTO}:1`).when, deadline);
  await f.close(1);
  assert.equal(f.stores.session[STATE].tabs[1], undefined);
  assert.equal(f.alarms.size, 0);
});

test('failed automatic requests keep dirty, retry once, stay exhausted across restart, recover on navigation', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  f.hooks.fetchError = 'offline';
  await f.fire(); assert.equal(f.calls.requests.length, 1);
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
  await f.fire(); assert.equal(f.calls.requests.length, 2);
  assert.equal(f.alarms.size, 0);
  f.restart(); await f.ready(); await f.fire(); await f.fire(AUTO);
  assert.equal(f.calls.requests.length, 2);
  delete f.hooks.fetchError; await f.update(1, { status: 'complete' }); await f.fire();
  assert.equal(f.calls.requests.length, 3);
  assert.equal(f.stores.session[STATE].tabs[1].dirty, false);
});

test('interrupted request recovery gets only its remaining bounded attempt', async () => {
  const saved = { version: 1, tabs: { 1: { windowId: 1, url: 'https://example.test/1', revision: 4, dirty: true } }, windows: { 1: { attempts: 1, generation: 4, dueAt: null, inFlight: true } } };
  const f = fixture({ saved, settings: { autoOrganize: true } }); await f.ready();
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
  f.hooks.fetchError = 'still offline'; await f.fire();
  assert.equal(f.stores.session[STATE].windows[1].attempts, 2);
  f.restart(); await f.ready(); assert.equal(f.alarms.size, 0);
});

test('native grouping failures retain dirty and undo, without successful history', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  f.hooks.groupError = 'mock denied'; await f.fire();
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  assert.equal(f.stores.local.orgHistory, undefined);
  assert.equal(f.stores.session.undo.snapshot.version, 2);
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
});

test('new navigation arriving during analysis is not cleared by an older successful result', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  f.hooks.onFetch = async () => { await f.update(1, { status: 'complete' }); };
  await f.fire();
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
  delete f.hooks.onFetch; await f.fire();
  assert.equal(f.stores.session[STATE].tabs[1].dirty, false);
  assert.equal(f.calls.groups.length, 1, 'the second cached analysis must not regroup');
});

test('preview stores title/analysis guards but never writes; apply writes and exposes lastRun stats/cache', async () => {
  const f = fixture(); await f.ready();
  const preview = await f.context.organize({ apply: false });
  assert.equal(preview.applied, false); assert.equal(f.calls.writes.length, 0);
  assert.equal(f.stores.session.proposal.tabTitles[0].source, 'ai');
  assert.match(f.stores.session.proposal.analysisGuards[0].snippet, /Fresh body/);
  const result = await f.send({ type: 'apply' });
  assert.equal(result.ok, true); assert.equal(result.titleStats.updated, 1);
  assert.equal(f.pages.get(1).document.title, 'AI 1');
  assert.deepEqual(f.stores.session.lastRun.titleStats, { updated: 1, unchanged: 0, skipped: 0 });
  assert.equal(f.stores.session.lastRun.cache.misses, 1);
});

test('content/URL changed after preview is guarded before application and never receives stale title/group', async () => {
  for (const kind of ['content', 'url']) {
    const f = fixture(); await f.ready(); await f.context.organize();
    if (kind === 'content') f.pages.get(1).body = 'Changed after preview';
    else await f.update(1, { url: 'https://other.test/' });
    const result = await f.send({ type: 'apply' });
    assert.equal(result.titleStats.skipped, 1);
    assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.groups.length, 0);
    assert.equal(f.stores.session.undo, undefined);
  }
});

test('injected function rechecks exact URL AND snippet after tabs.get validation', async () => {
  for (const kind of ['content', 'url']) {
    const f = fixture(); await f.ready();
    f.hooks.beforeWrite = () => {
      if (kind === 'content') f.pages.get(1).body = 'Changed immediately before injection';
      else f.pages.get(1).location.href += '#new';
    };
    const result = await f.context.organize({ apply: true });
    assert.equal(result.titleStats.skipped, 1);
    assert.equal(f.pages.get(1).document.title, 'Original 1');
  }
});

test('fresh snippets detect same-URL changes; original title prevents an AI rewrite feeding the next request', async () => {
  const f = fixture(); await f.ready();
  await f.context.organize({ apply: true });
  f.pages.get(1).body = 'Entirely new content at the identical URL';
  await f.context.organize({ apply: true }); await f.ready();
  assert.notEqual(f.calls.requests[0].tabs[0].snippet, f.calls.requests[1].tabs[0].snippet);
  assert.equal(f.calls.requests[1].tabs[0].title, 'Original 1');
  assert.equal(f.stores.session.lastRun.cache.misses, 1);
});

test('extractor prefers main/article, includes description/headings and caps at 1200 codepoints', async () => {
  const f = fixture(); await f.ready();
  f.pages.get(1).body = 'NAVIGATION JUNK'; f.pages.get(1).main = '正文😀'.repeat(1000);
  f.pages.get(1).description = '介绍'.repeat(300);
  await f.context.organize();
  const snippet = f.calls.requests[0].tabs[0].snippet;
  assert.equal(Array.from(snippet).length <= 1200, true);
  assert.match(snippet, /介绍/); assert.match(snippet, /Heading/); assert.match(snippet, /正文/);
  assert.doesNotMatch(snippet, /NAVIGATION JUNK/);
});

test('real injected title assignment is plain text, strips controls, caps 48 codepoints and maintains only one head observer', async () => {
  const f = fixture(); await f.ready();
  f.hooks.onFetch = (_payload, result) => { result.tabTitles[0].title = '\u0000<b>😀'.repeat(40); };
  const first = await f.context.organize({ apply: true });
  const page = f.pages.get(1);
  assert.equal(first.titleStats.updated, 1);
  assert.equal(Array.from(page.document.title).length, 48);
  assert.equal(page.document.title.includes('\u0000'), false);
  assert.match(page.document.title, /<b>/, 'markup is literal title text, not HTML');
  page.flush();
  const second = await f.context.organize({ apply: true });
  assert.equal(second.titleStats.unchanged, 1); page.flush();
  assert.equal(page.observers.filter(o => o.active).length, 1);
  assert.equal(page.observers.filter(o => o.active)[0].target, page.document.head);
  page.document.title = 'Site tries a long new title'; page.flush();
  assert.equal(page.document.title, page.document.__aiTabTitleState.aiTitle);
  assert.equal(page.document.__aiTabTitleState.originalTitle, 'Site tries a long new title');
  assert.equal(page.observers.some(o => o.target === page.document.body), false);
});

test('title maintainer yields to rapid site rewrites rather than fighting another observer forever', async () => {
  const f = fixture(); await f.ready(); await f.context.organize({ apply: true });
  const page = f.pages.get(1); page.flush();
  for (let i = 0; i < 6; i++) { page.document.title = `Site enforced ${i}`; page.flush(); }
  assert.equal(page.observers.filter(observer => observer.active).length, 0);
  assert.equal(page.document.__aiTabTitleState.active, false);
  assert.equal(page.document.title, 'Site enforced 5');
});

test('observer stops on same-URL content change or SPA URL change, does not restore stale AI title and reports dirty', async () => {
  for (const kind of ['content', 'url']) {
    const f = fixture(); await f.ready(); await f.context.organize({ apply: true });
    const page = f.pages.get(1); page.flush();
    if (kind === 'content') page.body = 'A different article now';
    else { page.location.href = 'https://example.test/new'; f.tabs.get(1).url = page.location.href; }
    page.document.title = 'New original page title'; page.flush(); await f.ready();
    assert.equal(page.document.title, 'New original page title');
    assert.equal(page.observers.filter(o => o.active).length, 0);
    assert.equal(page.notifications.at(-1).type, 'analysis-page-changed');
    assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  }
});

test('row source, not response source, controls cached AI title trust; unreadable pages are honestly skipped', async () => {
  const f = fixture({ tabs: [tab(1), tab(2), tab(3)] }); await f.ready();
  f.hooks.restricted = new Set([3]);
  f.hooks.onFetch = (_payload, result) => { result.source = 'heuristic'; result.tabTitles[1].source = 'heuristic'; };
  const result = await f.context.organize({ apply: true });
  assert.deepEqual(plain(result.titleStats), { updated: 1, unchanged: 0, skipped: 2 });
  assert.deepEqual(f.calls.writes, [1]);
  assert.equal(f.calls.requests[0].tabs.find(t => t.id === 3).snippet, null);
});

test('cached dirty navigation in existing groups does not natively regroup, even if cached group name differs', async () => {
  const f = fixture({ tabs: [tab(1, { groupId: 10 })], groups: [{ id: 10, title: 'User group', color: 'red' }], settings: { autoOrganize: true } }); await f.ready();
  // Warm the mocked server cache without applying a grouping proposal.
  await f.context.organize();
  f.stores.session.undo = { marker: 'keep undo' };
  await f.update(1, { status: 'complete' }); await f.fire();
  assert.equal(f.calls.groups.length, 0); assert.equal(f.calls.groupUpdates.length, 0);
  assert.equal(f.tabs.get(1).groupId, 10);
  assert.deepEqual(f.stores.session.undo, { marker: 'keep undo' });
  assert.equal(f.stores.local.orgHistory, undefined);
  assert.equal(f.stores.session.lastRun.cache.hits, 1);
  assert.equal(f.stores.session[STATE].tabs[1].dirty, false);
});

test('manual all-hit consistent grouping is a no-op with stats but no new undo/history; reload/duplicate rewrite titles', async () => {
  const f = fixture(); await f.ready(); await f.context.organize({ apply: true });
  const undo = structuredClone(f.stores.session.undo), history = structuredClone(f.stores.local.orgHistory);
  f.pages.get(1).document.title = 'Original after reload';
  const result = await f.context.organize({ apply: true });
  assert.equal(result.empty, true); assert.equal(result.cache.hits, 1); assert.equal(result.titleStats.updated, 1);
  assert.equal(f.calls.groups.length, 1);
  assert.deepEqual(f.stores.session.undo, undo); assert.deepEqual(f.stores.local.orgHistory, history);
  await f.add(tab(2, { url: f.tabs.get(1).url })); f.pages.get(2).body = f.pages.get(1).body;
  const duplicate = await f.context.organize({ apply: true, incremental: true });
  assert.equal(duplicate.cache.hits, 1); assert.equal(duplicate.titleStats.updated, 1);
  assert.equal(f.calls.groups.length, 2, 'a new ungrouped cache hit still joins its native group');
  assert.equal(f.pages.get(2).document.title, 'AI 2');
});

test('concurrent manual/cache completions in one window cannot create duplicate native groups or history', async () => {
  const f = fixture(); await f.ready();
  const results = await Promise.all([f.context.organize({ apply: true }), f.context.organize({ apply: true })]);
  assert.equal(results.every(r => r.ok), true);
  assert.equal(f.calls.groups.length, 1); assert.equal(f.stores.local.orgHistory.length, 1);
  assert.equal(f.pages.get(1).observers.filter(o => o.active).length, 1);
});

test('dirty same-URL content miss in an existing group is eligible to move to a newly analyzed group', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready(); await f.fire();
  f.pages.get(1).body = 'New document on same URL'; f.hooks.groupName = 'New topic';
  await f.update(1, { status: 'complete' }); await f.fire(); await f.ready();
  assert.equal(f.stores.session.lastRun.cache.misses, 1);
  assert.equal(f.calls.groups.length, 2);
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, 'New topic');
});

test('malformed or incomplete service results retain dirty and use the same bounded retry policy', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  f.hooks.onFetch = (_payload, result) => { result.groups = []; };
  await f.fire(); await f.fire(); await f.fire();
  assert.equal(f.calls.requests.length, 2); assert.equal(f.stores.session[STATE].tabs[1].dirty, true);
  assert.equal(f.stores.session.proposal, undefined); assert.equal(f.calls.writes.length, 0);
});

test('turning auto off while inference is in flight prevents grouping/titles, retains dirty, but manual incremental still applies', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  const started = deferred(), finish = deferred();
  f.hooks.onFetch = async () => { started.resolve(); await finish.promise; };
  const running = f.fire(); await started.promise;
  await f.configure({ autoOrganize: false }); finish.resolve(); await running;
  assert.equal(f.calls.groups.length, 0); assert.equal(f.calls.writes.length, 0);
  assert.equal(f.stores.session[STATE].tabs[1].dirty, true); assert.equal(f.alarms.size, 0);
  delete f.hooks.onFetch;
  const manual = await f.context.organize({ apply: true, incremental: true });
  assert.equal(manual.applied, true); assert.equal(manual.cache.hits, 1); assert.equal(manual.titleStats.updated, 1);
});

test('legacy stored proposals without analysis guards still apply through the message router', async () => {
  const f = fixture(); await f.ready();
  f.stores.session.proposal = { windowId: 1, groups: [{ name: 'Legacy', color: 'blue', tabIds: [1] }], tabCount: 1, source: 'ai' };
  const result = await f.send({ type: 'apply' });
  assert.equal(result.ok, true); assert.equal(result.applied, true);
  assert.equal(f.groups.get(f.tabs.get(1).groupId).title, 'Legacy');
  assert.equal(f.calls.writes.length, 0); assert.equal(f.stores.session.undo.snapshot.version, 2);
});

test('single-shot alarm consumed during a slow request is rearmed for new dirty work, without overlapping requests', async () => {
  const f = fixture({ settings: { autoOrganize: true } }); await f.ready();
  const started = deferred(), finish = deferred();
  f.hooks.onFetch = async () => { started.resolve(); await finish.promise; };
  const running = f.fire(); await started.promise;
  await f.update(1, { status: 'complete' }); f.tick(31000); await f.fire();
  assert.equal(f.calls.requests.length, 1);
  finish.resolve(); await running;
  assert.equal(f.alarms.has(`${AUTO}:1`), true);
  delete f.hooks.onFetch; await f.fire(); assert.equal(f.calls.requests.length, 2);
});

test('check-home-auto-organize only organizes when newly added ungrouped tabs appear, saving tokens on unchanged or reduced tabs', async () => {
  const f = fixture({ settings: { autoOrganize: false, autoOrganizeOnHome: true } }); await f.ready();
  const homeSender = { id: f.chrome.runtime.id, url: `${f.chrome.runtime.getURL('home.html')}`, frameId: 0 };
  const denied = await f.send({ type: 'check-home-auto-organize', windowId: 1 });
  assert.equal(denied.ok, false);
  const first = await f.send({ type: 'check-home-auto-organize', windowId: 1 }, homeSender);
  assert.equal(first.shouldOrganize, true);
  assert.equal(first.newCount, 1);
  // Repeating without adding new tabs must NOT re-trigger AI organize
  const unchanged = await f.send({ type: 'check-home-auto-organize', windowId: 1 }, homeSender);
  assert.equal(unchanged.shouldOrganize, false);
  assert.equal(unchanged.newCount, 0);
  // Closing a tab reduces count and must NOT trigger organize
  await f.add(tab(50, { url: 'https://example.test/50' }));
  await f.close(50);
  const reduced = await f.send({ type: 'check-home-auto-organize', windowId: 1 }, homeSender);
  assert.equal(reduced.shouldOrganize, false);
  // Adding a brand new ungrouped tab triggers incremental organize once
  await f.add(tab(51, { url: 'https://example.test/51' }));
  const added = await f.send({ type: 'check-home-auto-organize', windowId: 1 }, homeSender);
  assert.equal(added.shouldOrganize, true);
  assert.equal(added.newCount, 1);
});
