#!/usr/bin/env node
// Tests Hero inline search dropdown parity with Cmd+K palette and Chrome recently-closed sessions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const uiSource = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
const parserStart = uiSource.indexOf('function parseSearchInput(');
const parserEnd = uiSource.indexOf('/* Search command diagnostics', parserStart);
const paletteSource = await readFile(new URL('../extension/palette.js', import.meta.url), 'utf8');
const source = uiSource.slice(parserStart, parserEnd) + '\n' + paletteSource;

const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, { type, cancelable: true, defaultPrevented: false }, init); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
}

class Element {
  constructor(tag, doc, id = '') {
    this.tagName = tag;
    this.doc = doc;
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.textContent = '';
    this.focusCount = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).filter(Boolean).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(x => x && x !== name).join(' '); },
      toggle: (name, on) => (on === undefined ? !this.classList.contains(name) : on) ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  get isConnected() { return this === this.doc.body || !!this.parent?.isConnected; }
  set innerHTML(value) {
    this._html = value;
    for (const child of this.children) child.parent = null;
    this.children = [];
    if (value.includes('id="paletteInput"')) {
      for (const [tag, id] of [['input', 'paletteInput'], ['ul', 'paletteList'], ['span', 'paletteCount']]) {
        const child = new Element(tag, this.doc, id);
        this.appendChild(child);
      }
    } else if (value.includes('id="heroPaletteList"')) {
      const ul = new Element('ul', this.doc, 'heroPaletteList');
      const count = new Element('span', this.doc, 'heroPaletteCount');
      this.appendChild(ul);
      this.appendChild(count);
    }
  }
  get innerHTML() { return this._html || ''; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const fn of this.listeners.get(event.type) || []) fn(event);
    if (!event.propagationStopped) {
      if (this.parent) this.parent.dispatchEvent(event);
      else if (this !== this.doc) this.doc.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  closest(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    let cur = this;
    while (cur) {
      if (cls && cur.classList?.contains(cls)) return cur;
      cur = cur.parent;
    }
    return null;
  }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('#')
      ? child.id === selector.slice(1)
      : selector.includes(' ')
        ? child.classList?.contains(selector.split(/\s+/).pop().slice(1))
        : child.classList?.contains(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.focusCount++; this.doc.activeElement = this; this.dispatchEvent(new FakeEvent('focus')); this.dispatchEvent(new FakeEvent('focusin')); }
  click() { this.dispatchEvent(new FakeEvent('click')); }
  scrollIntoView() {}
}

function harness({ tabs = [], groups = [], history = [], sessions = [], bookmarks = [], favorites = [], restoreResult } = {}) {
  const doc = new Element('document', null);
  doc.doc = doc;
  doc.body = new Element('body', doc);
  doc.body.className = 'home';
  doc.createElement = tag => new Element(tag, doc);
  doc.getElementById = id => doc.body.querySelector('#' + id);

  const heroSection = doc.body.appendChild(new Element('section', doc));
  heroSection.className = 'hero-section';
  const form = heroSection.appendChild(new Element('form', doc, 'workspaceSearch'));
  const provider = form.appendChild(new Element('select', doc, 'searchProvider'));
  provider.value = 'all';
  const search = form.appendChild(new Element('input', doc, 'search'));
  const chips = form.appendChild(new Element('div', doc, 'sourceChips'));
  for (const p of ['all', 'tabs', 'bookmarks', 'history', 'google']) {
    const b = chips.appendChild(new Element('button', doc));
    b.className = 'source-chip' + (p === 'all' ? ' active' : '');
    b.dataset.provider = p;
  }
  const outside = doc.body.appendChild(new Element('button', doc, 'outsideBtn'));
  doc.activeElement = outside;

  const calls = { creates: [], updates: [], wins: [], restores: [], copied: [], toasts: [], focusGroups: [] };
  const chrome = {
    runtime: {
      id: 'hero-test',
      getURL: p => 'chrome-extension://test/' + p,
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener() {} },
    },
    tabs: {
      query: async () => tabs,
      create: async opts => { calls.creates.push(opts); return { id: 99, ...opts }; },
      update: async (...args) => calls.updates.push(args),
    },
    tabGroups: { query: async () => groups },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      update: async (...args) => calls.wins.push(args),
    },
    bookmarks: {
      getTree: async () => bookmarks,
      search: async () => [],
    },
    history: {
      search: async ({ text }) => {
        const q = String(text || '').toLowerCase();
        return history.filter(h => !q || h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q));
      },
    },
    sessions: {
      getRecentlyClosed: async () => sessions,
      restore: async sid => {
        calls.restores.push(sid);
        if (restoreResult instanceof Error) throw restoreResult;
        return restoreResult || { tab: { id: 88, windowId: 1, url: 'https://closed.example.com/page' } };
      },
    },
    storage: {
      local: {
        get: async key => {
          if (key === 'pinnedFavorites') return { pinnedFavorites: favorites };
          return {};
        },
      },
      session: { get: async () => ({ recentTabVisits: {} }) },
    },
  };

  doc.addEventListener('tt-focus-group', e => {
    e.preventDefault();
    calls.focusGroups.push(e.detail);
  });

  vm.runInNewContext(source, {
    document: doc,
    chrome,
    navigator: { clipboard: { writeText: async text => calls.copied.push(text) } },
    location: { href: 'chrome-extension://test/home.html' },
    self: {},
    top: {},
    URL,
    URLSearchParams,
    CustomEvent: FakeEvent,
    setTimeout,
    clearTimeout,
    icon: name => `<i data-ic="${name}"></i>`,
    escapeHtml,
    cleanTitle: t => t,
    domainOf: u => new URL(u).hostname,
    formatRelativeAccessTime: ts => (ts ? '2分钟前' : ''),
    toast: (...args) => calls.toasts.push(args),
    themeMode: 'auto',
    setThemeMode() {},
  });

  const dropdown = doc.getElementById('heroSearchDropdown');
  const heroList = doc.getElementById('heroPaletteList');
  const heroCount = doc.getElementById('heroPaletteCount');
  const palette = doc.getElementById('palette');
  return { doc, form, heroSection, provider, search, dropdown, heroList, heroCount, palette, outside, calls };
}

test('initial programmatic focus does not auto-open dropdown; pointerdown/input/ArrowDown opens it with unified Chrome records & bookmarks', async () => {
  const h = harness({
    tabs: [
      { id: 1, title: 'Open GitHub Issue', url: 'https://github.com/org/repo/issues/1', groupId: 5, windowId: 1, lastAccessed: Date.now() - 10000 },
    ],
    groups: [{ id: 5, title: 'Engineering', windowId: 1 }],
    bookmarks: [
      { title: 'Bookmarks bar', children: [{ title: 'Reading', children: [{ id: 'b1', title: 'MDN Guide', url: 'https://developer.mozilla.org/en-US/' }] }] },
    ],
    sessions: [
      { lastModified: Math.floor((Date.now() - 40000) / 1000), tab: { sessionId: 'sess-tab-1', title: 'Recently Closed PR', url: 'https://github.com/org/repo/pull/42' } },
      { lastModified: Math.floor((Date.now() - 20000) / 1000), tab: { sessionId: 'sess-dup', title: 'Open GitHub Issue', url: 'https://github.com/org/repo/issues/1' } },
    ],
    history: [
      { id: 'h1', title: 'Visited Design Doc', url: 'https://docs.example.com/design', lastVisitTime: Date.now() - 120000, visitCount: 3 },
    ],
  });
  await settle();

  h.search.focus();
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), true);
  assert.equal(h.search.getAttribute('aria-expanded'), 'false');

  h.search.dispatchEvent(new FakeEvent('pointerdown'));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), false);
  assert.equal(h.heroSection.classList.contains('dropdown-open'), true);
  const rows = h.heroList.querySelectorAll('.palette-row');
  assert.ok(rows.some(r => r.dataset.kind === 'tab' && r.dataset.key === 'tab:1'), 'includes recent open tab');
  assert.ok(rows.some(r => r.dataset.kind === 'closed' && r.dataset.key === 'closed:https://github.com/org/repo/pull/42'), 'includes recently closed session tab');
  assert.ok(!rows.some(r => r.dataset.kind === 'closed' && r.dataset.key === 'closed:https://github.com/org/repo/issues/1'), 'deduplicates already-open URL from recently closed');
  assert.ok(rows.some(r => r.dataset.kind === 'history' && r.dataset.key === 'history:https://docs.example.com/design'), 'includes browsing history');
  assert.ok(h.heroCount.textContent.includes('来源：全部'));
});

test('typing, source prefixes (b / h ), keyboard ↑↓ + Enter restores closed session or switches bookmark/history cleanly', async () => {
  const h = harness({
    tabs: [{ id: 1, title: 'Open Tab', url: 'https://open.example.com/', groupId: 5, windowId: 1, lastAccessed: Date.now() - 1000 }],
    groups: [{ id: 5, title: 'Engineering', windowId: 1 }],
    bookmarks: [
      { title: 'Bookmarks bar', children: [{ id: 'b1', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' }] },
    ],
    sessions: [
      { lastModified: Math.floor(Date.now() / 1000), tab: { sessionId: 'sess-restore-9', title: 'Closed Design Review', url: 'https://closed.example.com/page' } },
    ],
    history: [
      { id: 'h1', title: 'Archived Design Notes', url: 'https://notes.example.com/archive', lastVisitTime: Date.now() - 120000, visitCount: 2 },
    ],
  });
  await settle();

  h.search.value = 'Closed Design Review';
  h.search.dispatchEvent(new FakeEvent('input'));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), false);
  assert.equal(h.heroList.querySelectorAll('.palette-row')[0].dataset.kind, 'closed');

  const enterEv = new FakeEvent('keydown', { key: 'Enter' });
  h.search.dispatchEvent(enterEv);
  await settle();
  assert.equal(enterEv.defaultPrevented, true);
  assert.deepEqual(h.calls.restores, ['sess-restore-9']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.wins)), [[1, { focused: true }]]);
  assert.equal(h.dropdown.classList.contains('hidden'), true);
  assert.equal(h.palette.classList.contains('hidden'), true);

  h.search.value = 'b MDN';
  h.search.dispatchEvent(new FakeEvent('input'));
  await settle();
  const bRows = h.heroList.querySelectorAll('.palette-row');
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].dataset.kind, 'bookmark');
  assert.ok(h.heroCount.textContent.includes('来源：书签'));

  h.search.value = 'h Archived';
  h.search.dispatchEvent(new FakeEvent('input'));
  await settle();
  const hRows = h.heroList.querySelectorAll('.palette-row');
  assert.equal(hRows.length, 1);
  assert.equal(hRows[0].dataset.kind, 'history');
  assert.ok(h.heroCount.textContent.includes('来源：历史'));

  const escEv = new FakeEvent('keydown', { key: 'Escape' });
  h.search.dispatchEvent(escEv);
  await settle();
  assert.equal(escEv.defaultPrevented, true);
  assert.equal(h.dropdown.classList.contains('hidden'), true);
});

test('outside pointerdown closes Hero dropdown and opening Cmd+K palette closes Hero dropdown automatically', async () => {
  const h = harness({
    tabs: [{ id: 1, title: 'Tab A', url: 'https://a.example.com', groupId: -1, windowId: 1, lastAccessed: Date.now() }],
  });
  await settle();

  h.search.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), false);

  h.outside.dispatchEvent(new FakeEvent('pointerdown'));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), true);

  h.search.dispatchEvent(new FakeEvent('pointerdown'));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), false);

  h.doc.dispatchEvent(new FakeEvent('tt-open-palette', { detail: { query: 'test' } }));
  await settle();
  assert.equal(h.dropdown.classList.contains('hidden'), true);
  assert.equal(h.palette.classList.contains('hidden'), false);
});
