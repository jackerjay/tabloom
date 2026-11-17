// Dependency-free behavior tests; runs palette.js in a synthetic DOM, never Chrome.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const uiSource = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
const parserStart = uiSource.indexOf('function parseSearchInput(');
const parserEnd = uiSource.indexOf('/* Search command diagnostics', parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, 'load the real shared search parser from ui.js');
const source = uiSource.slice(parserStart, parserEnd) + '\n' + await readFile(new URL('../extension/palette.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

class FakeEvent {
  constructor(type, init = {}) { Object.assign(this, { type, cancelable: true, defaultPrevented: false }, init); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class Element {
  constructor(tag, doc) {
    this.tagName = tag;
    this.doc = doc;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.value = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(x => x !== name).join(' '); },
      toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  get isConnected() { return this === this.doc.body || !!this.parent?.isConnected; }
  set innerHTML(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    // Only the initial fixed template needs parsing; row markup is decorative.
    if (value.includes('id="paletteInput"')) {
      for (const [tag, id] of [['input', 'paletteInput'], ['ul', 'paletteList'], ['span', 'paletteCount']]) {
        const child = new Element(tag, this.doc);
        child.id = id;
        this.appendChild(child);
      }
    }
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
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
  focus() { this.doc.activeElement = this; this.dispatchEvent(new FakeEvent('focusin')); }
  click() { this.dispatchEvent(new FakeEvent('click')); }
  scrollIntoView() {}
}
function harness({ surface = 'home', tabs, groups, windowId = 1, windowPromise, extension = true, runtimeMessage } = {}) {
  const document = new Element('document', null);
  document.doc = document;
  document.body = new Element('body', document);
  document.body.className = 'other ' + surface;
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.body.querySelector('#' + id);
  const trigger = document.body.appendChild(document.createElement('button'));
  document.activeElement = trigger;
  const calls = { creates: [], updates: [], windowUpdates: [], panels: [], toasts: [], queries: [], messages: [], sequence: [], messageListener: null };
  const chrome = {
    runtime: {
      getURL: path => 'chrome-extension://test/' + path,
      sendMessage: async message => { calls.messages.push(message); calls.sequence.push(message.type); return runtimeMessage ? runtimeMessage(message) : { ok: true }; },
      onMessage: { addListener: listener => { calls.messageListener = listener; } },
    },
    tabs: {
      query: query => { calls.queries.push(query); return tabs ? tabs() : Promise.resolve([{ id: 2, title: '测试标签', url: 'https://example.com', groupId: 8, windowId: 1 }]); },
      create: async options => { calls.creates.push(options); },
      update: async (...args) => { calls.updates.push(args); calls.sequence.push('activate-tab'); },
    },
    tabGroups: { query: () => groups ? groups() : Promise.resolve([{ id: 8, title: '测试分组', windowId: 1 }]) },
    windows: {
      getCurrent: () => windowPromise || Promise.resolve({ id: windowId }),
      update: async (...args) => { calls.windowUpdates.push(args); calls.sequence.push('focus-window'); },
    },
    sidePanel: { open: async options => { calls.panels.push(options); } },
  };
  vm.runInNewContext(source, {
    document, chrome, location: { href: extension ? chrome.runtime.getURL(surface + '.html') : 'https://example.com' },
    CustomEvent: FakeEvent, URLSearchParams, URL, setTimeout, clearTimeout, icon: () => '', escapeHtml: text => String(text),
    cleanTitle: title => title, domainOf: url => new URL(url).hostname,
    toast: (...args) => calls.toasts.push(args), themeMode: 'auto', setThemeMode() {},
  });
  const input = document.getElementById('paletteInput');
  const list = document.getElementById('paletteList');
  const palette = document.getElementById('palette');
  const key = (key, init = {}) => {
    const event = new FakeEvent('keydown', { key, ...init });
    (document.activeElement || document).dispatchEvent(event);
    return event;
  };
  const search = value => { input.value = value; input.dispatchEvent(new FakeEvent('input')); };
  const open = async () => { document.dispatchEvent(new FakeEvent('tt-open-palette')); await settle(); };
  return { document, trigger, input, list, palette, key, search, open, calls };
}

test('clickable event opens immediately, traps Tab/Shift-Tab and outside focus, restores trigger', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.key('Tab').defaultPrevented, true);
  assert.equal(h.key('Tab', { shiftKey: true }).defaultPrevented, true);
  h.trigger.focus();
  assert.equal(h.document.activeElement, h.input);
  h.key('Escape');
  assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.input.getAttribute('aria-expanded'), 'false');
  assert.equal(h.input.getAttribute('aria-activedescendant'), null);
});

test('option ids, keyboard and hover selection keep aria-activedescendant valid; empty clears it', async () => {
  const h = harness();
  await h.open();
  const rows = h.list.querySelectorAll('.palette-row');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(h.input.getAttribute('aria-activedescendant'), rows[0].id);
  h.key('ArrowDown');
  assert.equal(h.input.getAttribute('aria-activedescendant'), rows[1].id);
  rows[2].dispatchEvent(new FakeEvent('mousemove'));
  assert.equal(h.input.getAttribute('aria-activedescendant'), rows[2].id);
  assert.equal(rows[2].getAttribute('aria-selected'), 'true');
  h.search('不存在xyz');
  assert.equal(h.list.querySelectorAll('.palette-row').length, 1, 'unmatched all-source query retains only the explicit Google action while Bookmarks search automatically');
  h.document.dispatchEvent(new FakeEvent('tt-open-palette', { detail: { query: '不存在xyz', provider: 'tabs' } }));
  await settle();
  assert.equal(h.input.getAttribute('aria-activedescendant'), null, 'tabs-only empty results still clear the active descendant');
});

test('close while loading never steals focus when pending data resolves', async () => {
  const pending = deferred();
  const h = harness({ tabs: () => pending.promise });
  h.document.dispatchEvent(new FakeEvent('tt-open-palette'));
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.list.getAttribute('aria-busy'), 'true');
  h.key('Escape');
  pending.resolve([]);
  await settle();
  assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.palette.classList.contains('hidden'), true);
  assert.equal(h.input.getAttribute('aria-activedescendant'), null);
});

test('superseded load cannot overwrite reopened palette or focus', async () => {
  const old = deferred(), fresh = deferred();
  let n = 0;
  const h = harness({ tabs: () => (++n === 1 ? old.promise : fresh.promise) });
  h.document.dispatchEvent(new FakeEvent('tt-open-palette'));
  h.key('Escape');
  h.document.dispatchEvent(new FakeEvent('tt-open-palette'));
  fresh.resolve([{ id: 30, title: '新结果', url: 'https://new.test', windowId: 1 }]);
  await settle();
  old.resolve([{ id: 20, title: '旧结果', url: 'https://old.test', windowId: 1 }]);
  await settle();
  h.search('新结果');
  h.key('Enter');
  assert.equal(h.calls.updates[0][0], 30);
});

test('failed loading is recoverable, announces error, retains commands and does not steal focus', async () => {
  const h = harness({ tabs: () => Promise.reject(new Error('denied')) });
  await h.open();
  assert.match(h.document.getElementById('paletteCount').textContent, /加载失败/);
  assert.equal(h.list.getAttribute('aria-busy'), 'false');
  h.key('Escape');
  await h.open();
  h.search('打开 AI 侧边栏');
  h.key('Enter');
  await settle();
  assert.equal(h.calls.panels[0].windowId, 1);
});

test('IME composition, isComposing and legacy 229 Enter never execute', async () => {
  const h = harness();
  await h.open();
  h.search('测试标签');
  h.input.dispatchEvent(new FakeEvent('compositionstart'));
  h.key('Enter');
  h.key('Escape');
  assert.equal(h.palette.classList.contains('hidden'), false);
  h.input.dispatchEvent(new FakeEvent('compositionend'));
  h.key('Enter', { isComposing: true });
  h.key('Enter', { keyCode: 229 });
  assert.equal(h.calls.updates.length, 0);
  h.key('Enter');
  assert.equal(h.calls.updates[0][0], 2);
});

test('home cancelable focus event supplies windowId and honors listener acknowledgement', async () => {
  const h = harness();
  let detail;
  h.document.addEventListener('tt-focus-group', e => { detail = e.detail; e.preventDefault(); });
  await h.open();
  h.search('测试分组');
  h.key('Enter');
  assert.equal(detail.groupId, 8);
  assert.equal(detail.windowId, 1);
  assert.equal(h.calls.creates.length, 0);
});

for (const surface of ['home', 'sidepanel', 'popup']) {
  test(`${surface}: unhandled group opens home with exact group and window`, async () => {
    const h = harness({ surface });
    await h.open();
    h.search('测试分组');
    h.key('Enter');
    assert.equal(h.calls.creates[0].url, 'chrome-extension://test/home.html?focusGroup=8&windowId=1');
  });
}

test('sidepanel cross-window group bypasses its current-window listener', async () => {
  const h = harness({ surface: 'sidepanel', groups: async () => [{ id: 8, title: '测试分组', windowId: 9 }] });
  let dispatched = false;
  h.document.addEventListener('tt-focus-group', e => { dispatched = true; e.preventDefault(); });
  await h.open();
  h.search('测试分组');
  h.key('Enter');
  assert.equal(dispatched, false);
  assert.match(h.calls.creates[0].url, /windowId=9$/);
});

test('sidepanel command uses cached windowId without awaiting during gesture', async () => {
  const h = harness({ windowId: 42 });
  await h.open();
  h.search('打开 AI 侧边栏');
  h.key('Enter');
  assert.equal(h.calls.panels[0].windowId, 42);
});

test('sidepanel unavailable window falls back without an empty open argument', async () => {
  const pending = deferred();
  const h = harness({ windowPromise: pending.promise });
  await h.open();
  h.search('打开 AI 侧边栏');
  h.key('Enter');
  assert.equal(h.calls.panels.length, 0);
  assert.equal(h.calls.creates[0].url, 'chrome-extension://test/sidepanel.html');
  pending.resolve({ id: 1 });
});

test('shortcut toggles extension pages only; non-extension document has no interface/listeners', async () => {
  const h = harness();
  h.key('k', { metaKey: true });
  await settle();
  assert.equal(h.document.activeElement, h.input);
  h.key('k', { ctrlKey: true });
  assert.equal(h.palette.classList.contains('hidden'), true);
  const page = harness({ extension: false });
  assert.equal(page.palette, null);
  assert.equal(page.document.listeners.size, 0);
});

test('sidepanel shortcut handoff closes inline without restoring focus or retaining its focus trap', async () => {
  const pending = deferred();
  const h = harness({ surface: 'sidepanel', runtimeMessage: message => message.type === 'page-search-open' ? pending.promise : { ok: true } });
  let restored = 0; h.trigger.addEventListener('focusin', () => { ++restored; });
  await h.open(); assert.equal(h.document.activeElement, h.input);
  const event = h.key('k', { ctrlKey: true });
  assert.equal(event.defaultPrevented, true); assert.equal(h.palette.classList.contains('hidden'), true);
  assert.equal(restored, 0, 'handoff uses close(false), not ordinary close focus restoration');
  assert.equal(h.input.getAttribute('aria-expanded'), 'false'); assert.equal(h.input.getAttribute('aria-activedescendant'), null);
  assert.equal(h.calls.messages.filter(message => message.type === 'page-search-open').length, 1);
  h.trigger.focus(); assert.equal(h.document.activeElement, h.trigger); assert.equal(h.key('Tab').defaultPrevented, false);
  pending.resolve({ ok: true }); await settle(); assert.equal(h.document.activeElement, h.trigger);
  assert.equal(h.palette.classList.contains('hidden'), true, 'a successful main-page request never revives the inline side palette');
});

test('browser search opens automatically, searches internal pages and excludes its own window', async () => {
  const h = harness({ surface: 'search-window', tabs: () => Promise.resolve([
    { id: 8, title: 'Chrome 扩展管理', url: 'chrome://extensions/', windowId: 1, groupId: -1 },
    { id: 9, title: '当前网页', url: 'https://example.com', windowId: 1, groupId: -1 },
    { id: 10, title: '搜索浏览器标签', url: 'chrome-extension://test/search.html', windowId: 4, groupId: -1 },
  ]), runtimeMessage: async () => ({ ok: true, sourceWindowId: 1, currentTabId: 9 }) });
  await settle();
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.list.querySelectorAll('.palette-row').length, 2, 'tabs only; no commands/group rows');
  h.search('Chrome 扩展');
  h.key('Enter');
  await settle();
  assert.equal(h.calls.updates[0][0], 8);
  assert.deepEqual(h.calls.sequence.slice(-3), ['activate-tab', 'focus-window', 'browser-search-close']);
  assert.equal(h.calls.messages.at(-1).restoreFocus, false, 'jump must not focus original tab again');
});

test('browser search Escape restores source and focus message refreshes/reset query', async () => {
  const h = harness({ surface: 'search-window' });
  await settle();
  h.search('old query');
  h.calls.messageListener({ type: 'browser-search-focus', windowId: 1, reset: true });
  await settle();
  assert.equal(h.input.value, '');
  assert.equal(h.document.activeElement, h.input);
  h.key('Escape');
  await settle();
  assert.equal(h.calls.messages.at(-1).type, 'browser-search-close');
  assert.equal(h.calls.messages.at(-1).restoreFocus, true);
});

test('browser search IME Enter cannot jump and rapid Enter cannot jump twice', async () => {
  const h = harness({ surface: 'search-window' });
  await settle();
  h.key('Enter', { isComposing: true });
  assert.equal(h.calls.updates.length, 0);
  h.key('Enter'); h.key('Enter');
  await settle();
  assert.equal(h.calls.updates.length, 1);
});
