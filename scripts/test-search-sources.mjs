// Deterministic synthetic DOM + mock Chrome only: no browser, HTTP server or remote API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const uiSource = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
const parserStart = uiSource.indexOf('function parseSearchInput(');
const parserEnd = uiSource.indexOf('/* Search command diagnostics', parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, 'load the real shared search parser from ui.js');
const vectorStart = uiSource.indexOf('function vectorSearchScore(');
const vectorEnd = uiSource.indexOf('/* 统一描边图标系统');
const source = uiSource.slice(parserStart, parserEnd)
  + (vectorStart >= 0 && vectorEnd > vectorStart ? '\n' + uiSource.slice(vectorStart, vectorEnd) : '')
  + '\n' + await readFile(new URL('../extension/palette.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const bm = (id, extra = {}) => ({
  id: String(id),
  title: 'Bookmark ' + id,
  url: 'https://docs.example.com/' + id,
  dateAdded: 1700000000000,
  ...extra,
});

class Event {
  constructor(type, init = {}) { Object.assign(this, { type, cancelable: true, defaultPrevented: false }, init); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class Element {
  constructor(tag, owner) {
    Object.assign(this, { tagName: tag, doc: owner, children: [], listeners: new Map(), attributes: new Map(), dataset: {}, className: '', value: '', textContent: '' });
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  get isConnected() { return this === this.doc.body || !!this.parent?.isConnected; }
  get innerHTML() { return this.html; }
  set innerHTML(value) {
    this.html = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (value.includes('id="paletteInput"')) {
      for (const [tag, id] of [['input', 'paletteInput'], ['ul', 'paletteList'], ['span', 'paletteCount']]) {
        const child = new Element(tag, this.doc);
        child.id = id;
        const attrs = value.match(new RegExp('<' + tag + '[^>]*id="' + id + '"[^>]*>'))?.[0] || '';
        for (const [, key, attr] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(key, attr);
        this.appendChild(child);
      }
    }
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const fn of this.listeners.get(event.type) || []) fn(event);
    if (this.parent) this.parent.dispatchEvent(event);
    else if (this !== this.doc) this.doc.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('#') ? child.id === selector.slice(1) : child.classList.contains(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.doc.activeElement = this; this.dispatchEvent(new Event('focusin')); }
  click() { this.dispatchEvent(new Event('click')); }
  scrollIntoView() {}
}

function harness({ surface = 'home', initialBookmarks = [], bookmarkSearch, initialTabs, initialHistory, queryTabs, createTab, focusWindow, closeSearch, state, windowId = 4 } = {}) {
  const document = new Element('document', null);
  document.doc = document;
  document.body = new Element('body', document);
  document.body.className = surface;
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.body.querySelector('#' + id);
  const trigger = document.body.appendChild(document.createElement('button'));
  document.activeElement = trigger;
  let now = 0, timerId = 0;
  const timers = new Map();
  const calls = { messages: [], searches: [], creates: [], updates: [], focuses: [], sequence: [], toasts: [], queries: [] };
  const tabs = initialTabs || [
    { id: 10, title: 'roadmap 标签', url: 'https://example.com/roadmap', windowId: 7, groupId: 2 },
    { id: 11, title: '自身搜索', url: 'chrome-extension://fake/search.html?reopen=1', windowId: 4, groupId: -1 },
  ];
  const chrome = {
    runtime: {
      getURL: path => 'chrome-extension://fake/' + path,
      onMessage: { addListener: fn => { calls.messageListener = fn; } },
      sendMessage: async message => {
        calls.messages.push(message);
        calls.sequence.push(message.type);
        if (message.type === 'browser-search-state') return state ? state() : { ok: true, sourceWindowId: 7, currentTabId: 10 };
        if (message.type === 'browser-search-close') return closeSearch ? closeSearch(message) : { ok: true };
        return { ok: true };
      },
    },
    windows: {
      getCurrent: async () => ({ id: windowId, type: surface === 'search-window' ? 'popup' : 'normal' }),
      update: async (id, options) => { calls.focuses.push({ id, ...options }); calls.sequence.push('focus-window'); if (focusWindow) return focusWindow(id, options); },
    },
    tabs: {
      query: async options => { calls.queries.push(options); return queryTabs ? queryTabs(calls.queries.length) : tabs; },
      create: async options => { calls.creates.push(options); calls.sequence.push('create-tab'); if (createTab) return createTab(options); return { id: 100, windowId: options.windowId, url: options.url }; },
      update: async (id, options) => { calls.updates.push({ id, ...options }); calls.sequence.push('activate-tab'); },
    },
    bookmarks: {
      getTree: async () => [{ children: [{ title: 'Dev', children: initialBookmarks }] }],
      search: async ({ query }) => {
        calls.searches.push({ query });
        if (bookmarkSearch) return bookmarkSearch(query);
        const q = String(query || '').toLowerCase();
        return initialBookmarks.filter(b => `${b.title || ''} ${b.url || ''}`.toLowerCase().includes(q));
      },
    },
    history: {
      search: async ({ text }) => {
        const items = initialHistory || [];
        if (!text) return items;
        const q = String(text).toLowerCase();
        return items.filter(h => `${h.title || ''} ${h.url || ''}`.toLowerCase().includes(q));
      },
    },
    tabGroups: { query: async () => [{ id: 2, title: 'roadmap 分组', windowId: 7 }] },
    sidePanel: { open: async () => {} },
  };
  vm.runInNewContext(source, {
    document, chrome, location: { href: chrome.runtime.getURL(surface + '.html') }, URL, URLSearchParams, CustomEvent: Event,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    icon: () => '', escapeHtml, cleanTitle: title => title, domainOf: url => new URL(url).hostname,
    toast: (...args) => calls.toasts.push(args), themeMode: 'auto', setThemeMode() {},
  });
  const input = document.getElementById('paletteInput'), list = document.getElementById('paletteList'), palette = document.getElementById('palette');
  const rows = kind => list.querySelectorAll('.palette-row').filter(row => !kind || row.dataset.kind === kind);
  const selected = () => rows().find(row => row.getAttribute('aria-selected') === 'true');
  const key = (key, init = {}) => { const event = new Event('keydown', { key, ...init }); (document.activeElement || document).dispatchEvent(event); return event; };
  const open = async detail => { document.dispatchEvent(new Event('tt-open-palette', detail ? { detail } : {})); await settle(); };
  const search = value => { input.value = value; input.dispatchEvent(new Event('input')); };
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn();
    await settle();
  };
  const choose = (kind, index = 0) => {
    const row = rows(kind)[index];
    assert.ok(row, `expected ${kind} row ${index}`);
    row.dispatchEvent(new Event('mousemove'));
    return row;
  };
  return { document, trigger, input, list, palette, rows, selected, key, open, search, advance, choose, calls, timers, count: () => document.getElementById('paletteCount').textContent };
}

for (const surface of ['home', 'sidepanel', 'popup', 'search-window']) {
  test(`${surface}: b command prefix preserves raw input and searches only Bookmarks after 100ms`, async () => {
    for (const prefix of ['b', 'B']) {
      const h = harness({ surface, bookmarkSearch: () => [bm('prefix', { title: 'Roadmap Bookmark' })] });
      const raw = ` \t${prefix}\t roadmap  `;
      await h.open({ query: raw, provider: 'all' });
      assert.equal(h.input.value, raw);
      assert.equal(h.rows().length, 0, 'prefix must hide matching native tabs/groups and Google');
      await h.advance(99); assert.equal(h.calls.searches.length, 0);
      await h.advance(1);
      assert.deepEqual(h.calls.searches, [{ query: 'roadmap' }]);
      assert.deepEqual(h.rows().map(row => row.dataset.kind), ['bookmark']);
      assert.match(h.count(), /来源：书签/);
      assert.match(h.count(), /b 空格 书签 · h 空格 历史 · g 空格 Google/);
      assert.equal(h.calls.creates.length, 0);
    }
  });

  test(`${surface}: g overrides every base source, never searches bookmarks and requires explicit Enter for encoded Google query`, async () => {
    for (const provider of ['all', 'tabs', 'bookmarks', 'google']) {
      const query = 'roadmap &?# 中文 ' + '🧪'.repeat(10), raw = `  G  ${query}  `;
      const h = harness({ surface, bookmarkSearch: () => { throw new Error('Google prefix must never call bookmarks.search'); } });
      await h.open({ query: raw, provider });
      await h.advance(500);
      assert.equal(h.input.value, raw);
      assert.equal(h.calls.searches.length, 0);
      assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']);
      assert.equal(h.calls.creates.length, 0);
      assert.match(h.count(), /来源：Google/);
      h.key('Enter'); h.key('Enter'); await settle();
      assert.equal(h.calls.creates.length, 1);
      assert.equal(h.calls.creates[0].url, 'https://www.google.com/search?q=' + encodeURIComponent(query));
      assert.equal(h.calls.creates[0].windowId, surface === 'search-window' ? 7 : 4);
    }
  });
}

test('prefix removal restores each base provider and close/reopen resets any temporary override', async () => {
  for (const provider of ['all', 'tabs', 'bookmarks', 'google']) {
    const h = harness({ bookmarkSearch: () => [bm('base', { title: 'Roadmap Guide', url: 'https://react.dev/roadmap' })] });
    await h.open({ query: 'b roadmap', provider }); await h.advance(120);
    assert.deepEqual(h.rows().map(row => row.dataset.kind), ['bookmark']);
    h.search('g roadmap'); await h.advance(120);
    assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']);
    h.search('roadmap'); await h.advance(120);
    assert.equal(h.rows('tab').length > 0, ['all', 'tabs'].includes(provider));
    assert.equal(h.rows('bookmark').length > 0, ['all', 'bookmarks'].includes(provider));
    assert.equal(h.rows('google').length > 0, ['all', 'google'].includes(provider));
    h.search('g roadmap'); h.key('Escape'); await h.open(); h.search('roadmap'); await h.advance(120);
    assert.equal(h.rows('tab').length, 1); assert.equal(h.rows('bookmark').length, 1); assert.equal(h.rows('google').length, 1);
  }
});

test('ordinary words, bare command letters, URLs, unknown commands and literal slashes are not prefixes', async () => {
  const h = harness();
  for (const query of ['google', 'bookmark', 'bookmarks', 'localhost', 'x foo', 'b/h roadmap', 'g/foo', 'b', 'h', 'g']) {
    const raw = ['b', 'h', 'g'].includes(query) ? `  ${query}` : `  ${query}  `;
    await h.open({ query: raw }); await h.advance(120);
    assert.equal(h.calls.searches.at(-1).query, query);
    assert.equal(h.rows('google')[0].dataset.key, 'google:' + query);
  }
  const beforeSearches = h.calls.searches.length;
  await h.open({ query: '  https://g.test/b  ' }); await h.advance(120);
  assert.equal(h.calls.searches.length, beforeSearches);
  assert.equal(h.rows('url')[0].dataset.key, 'url:https://g.test/b');
});

test('empty b/h/g prefixes announce an honest source-specific query hint without RPC, native rows or navigation', async () => {
  for (const raw of ['b ', ' H\t  ', ' G\n ']) {
    const h = harness(); await h.open({ query: raw, provider: 'all' }); await h.advance(300);
    h.key('Enter'); await settle();
    assert.equal(h.input.value, raw); assert.equal(h.rows().length, 0);
    assert.equal(h.calls.searches.length, 0); assert.equal(h.calls.creates.length, 0); assert.equal(h.calls.updates.length, 0);
    assert.match(h.count(), /请输入.*搜索词/); assert.doesNotMatch(h.count(), /没有匹配|失败/);
  }
});

test('same-query b to g invalidates a pending bookmark response and never renders stale results', async () => {
  const pending = deferred(), h = harness({ bookmarkSearch: () => pending.promise });
  await h.open({ query: 'b roadmap' }); await h.advance(100);
  assert.equal(h.calls.searches[0].query, 'roadmap');
  h.search('g roadmap'); await h.advance(300);
  assert.equal(h.calls.searches.length, 1); assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']);
  const selected = h.selected().dataset.key;
  pending.resolve([bm('must-not-render', { title: 'Must Not Render' })]); await settle();
  assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']); assert.equal(h.selected().dataset.key, selected);
});

test('effective trimmed native queries retain tab/group/command filtering and highlight without raw whitespace', async () => {
  const h = harness(); await h.open({ query: ' \troadmap  ', provider: 'tabs' });
  assert.equal(h.rows('tab').length, 1); assert.equal(h.rows('group').length, 1);
  assert.match(h.rows('tab')[0].innerHTML, /<mark>roadmap<\/mark>/);
  assert.match(h.rows('group')[0].innerHTML, /<mark>roadmap<\/mark>/);
  h.search('  立即整理  '); assert.equal(h.rows('cmd').length, 1); assert.match(h.rows('cmd')[0].innerHTML, /<mark>立即整理<\/mark>/);
});

test('orders results strictly as 最近打开 -> 标签页 -> 书签 -> 浏览历史 -> 网页搜索 and ranks each tier by keyword score', async () => {
  const base = Date.now();
  const initialTabs = [
    { id: 1, title: 'Current Active', url: 'https://current.test', windowId: 7, groupId: -1, lastAccessed: base },
    { id: 11, title: 'General workspace notes mentioning async hooks and misc topics archive', url: 'https://a.test/notes', windowId: 7, groupId: -1, lastAccessed: base - 1000 },
    { id: 12, title: 'Filler One', url: 'https://b.test/1', windowId: 7, groupId: -1, lastAccessed: base - 2000 },
    { id: 13, title: 'Filler Two', url: 'https://b.test/2', windowId: 7, groupId: -1, lastAccessed: base - 3000 },
    { id: 14, title: 'Async Hooks Reference', url: 'https://c.test/async-hooks', windowId: 7, groupId: -1, lastAccessed: base - 4000 },
    { id: 15, title: 'Filler Three', url: 'https://b.test/3', windowId: 7, groupId: -1, lastAccessed: base - 5000 },
    { id: 21, title: 'Older broad guide archive mentioning async hooks once at the very end', url: 'https://old1.test/doc', windowId: 7, groupId: -1, lastAccessed: base - 60000 },
    { id: 22, title: 'Async Hooks Guide', url: 'https://old2.test/guide', windowId: 7, groupId: -1, lastAccessed: base - 90000 },
  ];
  const initialBookmarks = [
    { id: 'bm-weak', title: 'Random Dev Links Collection mentioning async hooks somewhere', url: 'https://mdn.example/links', folderPath: 'Reading' },
    { id: 'bm-strong', title: 'Async Hooks API', url: 'https://nodejs.org/api/async_hooks.html', folderPath: 'Docs' },
  ];
  const initialHistory = [
    { id: 'h1', title: 'Long history page mentioning async hooks somewhere inside notes', url: 'https://hist.test/long', lastVisitTime: 2000, visitCount: 5 },
    { id: 'h2', title: 'Async Hooks Spec', url: 'https://hist.test/spec', lastVisitTime: 1000, visitCount: 2 },
  ];
  const h = harness({ surface: 'search-window', initialTabs, initialBookmarks, initialHistory });
  await h.open({ query: 'async hooks' });
  await h.advance(200);

  const sections = h.list.querySelectorAll('.palette-sec').map(el => el.textContent);
  assert.deepEqual(sections, ['最近打开', '标签页', '书签', '浏览历史', '网页搜索']);

  const allKeys = h.rows().map(r => r.dataset.key);
  assert.deepEqual(allKeys, [
    'tab:14',
    'tab:11',
    'tab:22',
    'tab:21',
    'bookmark:https://nodejs.org/api/async_hooks.html',
    'bookmark:https://mdn.example/links',
    'history:https://hist.test/spec',
    'history:https://hist.test/long',
    'google:async hooks',
  ]);
});

test('omnibox shows matching browsing history in all mode and isolates history with h prefix', async () => {
  const initialHistory = [
    { id: 'h1', title: 'Long archive mentioning roadmap notes', url: 'https://hist.test/long', lastVisitTime: 2000, visitCount: 5 },
    { id: 'h2', title: 'React Roadmap 2026', url: 'https://example.com/roadmap', lastVisitTime: 3000, visitCount: 9 },
  ];
  const h = harness({ surface: 'search-window', initialHistory });
  await h.open({ query: 'roadmap' });
  await h.advance(200);

  // Prefix 'h roadmap' searches ONLY browsing history (even for open-tab URLs) without bookmarks/Google calls
  h.search('h roadmap');
  await h.advance(200);
  const histKeys = h.rows('history').map(r => r.dataset.key);
  assert.equal(histKeys[0], 'history:https://example.com/roadmap');
  assert.match(h.count(), /来源：历史/);
  // Pressing Enter on a history URL that is already open focuses the open tab instead of duplicating
  h.key('Enter');
  await settle();
  assert.equal(h.calls.updates.length, 1);
  assert.equal(h.calls.creates.length, 0);
});

test('standalone Escape cancels in-flight bookmark rendering and closes with restoreFocus(true)', async () => {
  const pending = deferred();
  const h = harness({ surface: 'search-window', bookmarkSearch: () => pending.promise });
  await h.open({ query: 'cancel', provider: 'bookmarks' });
  await h.advance(100);
  h.key('Escape');
  await settle();
  pending.resolve([bm('late-bm', { title: 'Late Bookmark' })]);
  await settle();
  assert.equal(h.rows('bookmark').length, 0);
  assert.equal(h.palette.classList.contains('hidden'), true);
  assert.equal(h.calls.messages.at(-1).type, 'browser-search-close');
  assert.equal(h.calls.messages.at(-1).restoreFocus, true);
});
