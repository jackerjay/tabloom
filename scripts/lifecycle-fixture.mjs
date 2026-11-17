// Shared offline fixture for the three lifecycle contracts; no real Chrome or network.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
export const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
export const plain = v => JSON.parse(JSON.stringify(v));
export const tab = (id, extra = {}) => ({ id, windowId: 1, groupId: 10, index: id - 1, title: `Tab ${id}`, url: `https://example.test/${id}`, active: false, pinned: false, audible: false, status: 'complete', ...extra });
export const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, async emit(...args) { await Promise.all(this.listeners.map(fn => fn(...args))); } });
export const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
export function fixture(initial = [tab(1), tab(2)], initialGroups = [{ id: 10, windowId: 1, title: 'Research', color: 'purple', collapsed: true }]) {
  const tabs = new Map(initial.map(t => [t.id, structuredClone(t)]));
  const groups = new Map(initialGroups.map(g => [g.id, structuredClone(g)]));
  const windows = new Map([[1, { id: 1, type: 'normal' }], [2, { id: 2, type: 'normal' }], [3, { id: 3, type: 'popup' }]]);
  const stores = { session: {}, local: {}, sync: { settings: { autoOrganize: false } } };
  const calls = { remove: [], create: [], move: [], group: [], update: [], fetch: [], warnings: [] }, hooks = {};
  let context, nextTab = 100, nextGroup = 1000, focused = 1, now = 2_000_000_000_000, nonce = 0;
  const chrome = { tabs: {}, windows: {}, tabGroups: {}, storage: {}, runtime: { id: 'lifecycle', getURL: p => `chrome-extension://lifecycle/${p}` } };
  const get = id => { const t = tabs.get(id); if (!t) throw Error(`missing tab ${id}`); return t; };
  const reindex = () => { for (const wid of windows.keys()) [...tabs.values()].filter(t => t.windowId === wid).sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; }); };
  const gc = () => { for (const id of groups.keys()) if (![...tabs.values()].some(t => t.groupId === id)) groups.delete(id); };
  for (const [area, data] of Object.entries(stores)) chrome.storage[area] = {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); },
    async set(values) { await hooks.beforeSet?.(area, values); Object.assign(data, structuredClone(values)); await hooks.afterSet?.(area, values); },
    async remove(key) { delete data[key]; },
  };
  Object.assign(chrome.tabs, {
    async query(query = {}) { await hooks.beforeQuery?.(query); return structuredClone([...tabs.values()].filter(t => Object.entries(query).every(([k, v]) => v == null || t[k] === v))); },
    async get(id) { const value = structuredClone(get(id)); await hooks.beforeGet?.(id); return value; },
    async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) { calls.remove.push(id); await hooks.beforeRemove?.(id); tabs.delete(id); gc(); await chrome.tabs.onRemoved.emit(id, {}); } },
    async create(props) { calls.create.push(plain(props)); await hooks.beforeCreate?.(props); const t = tab(nextTab++, { ...props, groupId: -1, index: [...tabs.values()].filter(t => t.windowId === props.windowId).length }); tabs.set(t.id, t); await chrome.tabs.onCreated.emit(structuredClone(t)); return structuredClone(t); },
    async update(id, props) { calls.update.push({ id, ...plain(props) }); await hooks.beforeUpdate?.(id, props); Object.assign(get(id), props); await chrome.tabs.onUpdated.emit(id, props, structuredClone(get(id))); return structuredClone(get(id)); },
    async group({ tabIds, groupId, createProperties }) { calls.group.push({ tabIds, groupId }); await hooks.beforeGroup?.(); groupId ??= nextGroup++; if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: createProperties.windowId, title: '', color: 'grey', collapsed: false }); for (const id of tabIds) get(id).groupId = groupId; gc(); return groupId; },
    async move(id, props) { calls.move.push({ id, ...props }); Object.assign(get(id), props); return structuredClone(get(id)); },
  });
  Object.assign(chrome.tabGroups, {
    async query({ windowId } = {}) { return structuredClone([...groups.values()].filter(g => windowId == null || g.windowId === windowId)); },
    async update(id, props) { await hooks.beforeGroupUpdate?.(); Object.assign(groups.get(id), props); },
    async move(id, props) { calls.move.push({ groupId: id, ...props }); const members = [...tabs.values()].filter(t => t.groupId === id).sort((a, b) => a.index - b.index); members.forEach((t, i) => { t.index = props.index + i; }); reindex(); },
  });
  Object.assign(chrome.windows, {
    async get(id) { if (!windows.has(id)) throw Error('missing window'); return structuredClone(windows.get(id)); },
    async getLastFocused() { return structuredClone(windows.get(focused)); },
    async getAll({ windowTypes } = {}) { return structuredClone([...windows.values()].filter(w => !windowTypes || windowTypes.includes(w.type))); },
  });
  chrome.scripting = { async executeScript() { return [{ result: {} }]; } };
  chrome.bookmarks = { async getTree() { return []; } };
  chrome.action = { async setBadgeText() {}, async setBadgeBackgroundColor() {} };
  chrome.alarms = { onAlarm: event() };
  async function send(message, sender = { id: 'lifecycle', url: 'chrome-extension://lifecycle/home.html', frameId: 0 }) {
    return new Promise(resolve => chrome.runtime.onMessage.listeners[0](message, sender, result => resolve(plain(result))));
  }
  function restart({ browser = false } = {}) {
    if (browser) stores.session = {};
    if (browser) { const data = stores.session; chrome.storage.session = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); }, async set(v) { Object.assign(data, structuredClone(v)); }, async remove(k) { delete data[k]; } }; }
    for (const [api, names] of [[chrome.runtime, ['onMessage', 'onInstalled']], [chrome.tabs, ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onAttached', 'onDetached']], [chrome.windows, ['onRemoved', 'onFocusChanged']], [chrome.storage, ['onChanged']], [chrome.alarms, ['onAlarm']]]) for (const name of names) api[name] = event();
    class Clock extends Date { static now() { return now; } }
    context = vm.createContext({ chrome, URL, Date: Clock, AbortController, crypto: { randomUUID: () => `offline-${++nonce}` }, setTimeout: () => 1, clearTimeout() {}, console: { warn: (...a) => calls.warnings.push(a) }, async fetch(url, opts) { calls.fetch.push({ url, ...opts }); if (hooks.fetchResult) return { ok: true, async json() { return structuredClone(hooks.fetchResult); } }; throw Error('unexpected network'); } });
    vm.runInContext(source, context);
  }
  restart();
  return { chrome, stores, tabs, groups, windows, calls, hooks, send, restart,
    async enableAuto() { Object.assign(chrome.alarms, { async create() {}, async clear() {}, async getAll() { return []; } }); stores.sync.settings.autoOrganize = true; restart(); await vm.runInContext('autoReady', context); },
    get context() { return context; }, now: () => now, tick: n => { now += n; }, focus: id => { focused = id; }, async activate(id) { const t = get(id); for (const v of tabs.values()) if (v.windowId === t.windowId) v.active = v.id === id; await chrome.tabs.onActivated.emit({ tabId: id, windowId: t.windowId }); }, async ready() { await vm.runInContext('autoReady', context); },
  };
}
