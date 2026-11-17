// Offline synthetic DOM + mock Chrome only. Never opens a browser or calls an API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const uiSource = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
const parserStart = uiSource.indexOf('function parseSearchInput(');
const parserEnd = uiSource.indexOf('/* Search command diagnostics', parserStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart, 'load the real shared search parser from ui.js');
const source = uiSource.slice(parserStart, parserEnd) + '\n' + await readFile(new URL('../extension/palette.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../extension/styles.css', import.meta.url), 'utf8');
const nonce = 'trusted-frame-nonce';
const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const authorized = (extra = {}) => ({ ok: true, sourceWindowId: 7, currentTabId: 10, ...extra });
const bm = (id, title = '书签 ' + id, url = 'https://docs.example.com/' + id) => ({ id, title, url });
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
class Event {
  constructor(type, init = {}) { Object.assign(this, { type, cancelable: true, defaultPrevented: false }, init); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class Element {
  constructor(tag, owner) {
    Object.assign(this, { tagName: tag, doc: owner, children: [], listeners: new Map(), attributes: new Map(), dataset: {}, className: '', value: '', textContent: '', focusCount: 0 });
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
        const child = new Element(tag, this.doc); child.id = id;
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
    if (this.parent) this.parent.dispatchEvent(event); else if (this !== this.doc) this.doc.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  querySelectorAll(selector) {
    const matches = child => selector.startsWith('#') ? child.id === selector.slice(1) : child.classList.contains(selector.slice(1));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { ++this.focusCount; this.doc.activeElement = this; this.dispatchEvent(new Event('focusin')); }
  click() { this.dispatchEvent(new Event('click')); }
  scrollIntoView() {}
}
function harness({ surface = 'search-window', suffix = '?embedded=' + nonce, framed = surface === 'search-window', state = () => authorized(), initialBookmarks = [], bookmarkSearch, pendingState, windowId = 7, localTabId = 10, localTabPromise, windowPromise, initialTabs, queryTabs, pageSearchOpen = () => ({ ok: true }), closeSearch = () => ({ ok: true }), clipboard } = {}) {
  const document = new Element('document', null); document.doc = document;
  document.body = new Element('body', document); document.body.className = surface;
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.body.querySelector('#' + id);
  const trigger = document.body.appendChild(document.createElement('button')); document.activeElement = trigger;
  const calls = { sequence: [], messages: [], searches: [], bookmarkQueries: [], queries: [], groups: [], creates: [], updates: [], focuses: [], removes: [], toasts: [], responses: [], copied: [], currentTabReads: 0, currentWindowReads: 0, listeners: new Map(), messageListener: null };
  const navigatorMock = { clipboard: { writeText: async text => { if (clipboard) return clipboard(text); calls.copied.push(text); } } };
  const tabs = initialTabs || [{ id: 10, title: 'Engineering roadmap', url: 'https://example.com/roadmap', groupId: 2, windowId: 7 }];
  let now = 0, timerId = 0; const timers = new Map();
  const chrome = {
    runtime: {
      id: 'fake', getURL: path => 'chrome-extension://fake/' + path,
      onMessage: { addListener: fn => { calls.messageListener = fn; } },
      sendMessage: async message => {
        calls.messages.push(message); calls.sequence.push(message.type);
        if (message.type === 'page-search-state' || message.type === 'browser-search-state') return state(message);
        if (message.type === 'page-search-close' || message.type === 'browser-search-close') return closeSearch(message);
        if (message.type === 'page-search-sidepanel-state') return pendingState ? pendingState(message) : { ok: true, pending: null };
        if (message.type === 'page-search-open') return pageSearchOpen(message, { document, calls });
        return { ok: true };
      },
    },
    bookmarks: {
      getTree: async () => [{ children: [{ title: 'Dev', children: initialBookmarks }] }],
      search: async q => { calls.searches.push(q); calls.bookmarkQueries.push(q); return bookmarkSearch ? bookmarkSearch(q) : []; },
    },
    tabs: {
      getCurrent: async () => { ++calls.currentTabReads; return localTabPromise || (localTabId === null ? undefined : { id: localTabId }); },
      query: async options => { calls.queries.push(options); calls.sequence.push('tabs-query'); return queryTabs ? queryTabs(calls.queries.length) : tabs; },
      create: async options => { calls.creates.push(options); calls.sequence.push('create-tab'); return { id: 90, ...options }; },
      update: async (id, options) => { calls.updates.push({ id, ...options }); calls.sequence.push('activate-tab'); },
    },
    tabGroups: { query: async options => { calls.groups.push(options); calls.sequence.push('groups-query'); return [{ id: 2, title: '工程分组', windowId: 7 }]; } },
    windows: {
      getCurrent: async () => { ++calls.currentWindowReads; return windowPromise || { id: windowId }; },
      update: async (id, options) => { calls.focuses.push({ id, ...options }); calls.sequence.push('focus-window'); },
      remove: async id => { calls.removes.push(id); throw new Error('Embedded search must not close a window'); },
    },
    sidePanel: { open: async () => {} },
  };
  const self = {}, top = framed ? {} : self;
  vm.runInNewContext(source, {
    document, chrome, navigator: navigatorMock, location: { href: chrome.runtime.getURL(surface === 'search-window' ? 'search.html' : surface + '.html') + suffix }, self, top,
    URL, URLSearchParams, CustomEvent: Event,
    addEventListener: (type, fn) => calls.listeners.set(type, fn),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    icon: () => '', escapeHtml, cleanTitle: title => title, domainOf: value => new URL(value).hostname,
    toast: (...args) => calls.toasts.push(args), themeMode: 'auto', setThemeMode() {},
  });
  const input = document.getElementById('paletteInput'), list = document.getElementById('paletteList'), palette = document.getElementById('palette');
  const rows = kind => list.querySelectorAll('.palette-row').filter(row => !kind || row.dataset.kind === kind);
  const key = (key, init = {}) => { const event = new Event('keydown', { key, ...init }); (document.activeElement || document).dispatchEvent(event); return event; };
  const open = async detail => { document.dispatchEvent(new Event('tt-open-palette', { detail })); await settle(); };
  const search = value => { input.value = value; input.dispatchEvent(new Event('input')); };
  const advance = async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await settle(); };
  const choose = kind => { const row = rows(kind)[0]; assert.ok(row, 'expected ' + kind); row.dispatchEvent(new Event('mousemove')); return row; };
  const message = (message, sender = { id: 'fake' }, respond) => calls.messageListener(message, sender, response => {
    calls.responses.push({ request: message, response }); respond?.(response);
  });
  return { document, trigger, input, list, palette, rows, key, open, search, advance, choose, message, calls, timers, count: () => document.getElementById('paletteCount').textContent };
}

test('embedded b: real shared parser strips query, retains raw input and preserves debounce/IME for bookmarks', async () => {
  const h = harness({ bookmarkSearch: () => [bm('prefix', 'Roadmap Bookmark', 'https://react.dev/roadmap')] }); await settle();
  const raw = '  B\t roadmap  ';
  h.input.dispatchEvent(new Event('compositionstart')); h.search(raw); await h.advance(1000);
  assert.equal(h.calls.searches.length, 0); h.key('Enter'); assert.equal(h.calls.creates.length, 0);
  h.input.dispatchEvent(new Event('compositionend')); await h.advance(99); assert.equal(h.calls.searches.length, 0);
  await h.advance(1);
  assert.deepEqual({ ...h.calls.searches[0] }, { query: 'roadmap' });
  assert.equal(h.input.value, raw); assert.deepEqual(h.rows().map(row => row.dataset.kind), ['bookmark']);
  assert.match(h.count(), /来源：书签/); assert.match(h.count(), /b 空格 书签 · h 空格 历史 · g 空格 Google/);
});

test('embedded g overrides all base sources, has no bookmark/native results and navigates stripped encoded query only on Enter', async () => {
  for (const provider of ['all', 'tabs', 'bookmarks', 'google']) {
    const h = harness(); await settle(); const query = 'roadmap &?# 中文 ' + '🧪'.repeat(31), raw = ` G  ${query} `;
    await h.open({ query: raw, provider }); await h.advance(1000);
    assert.equal(h.calls.searches.length, 0); assert.equal(h.input.value, raw);
    assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']); assert.equal(h.calls.creates.length, 0);
    h.key('Enter'); h.key('Enter'); await settle();
    assert.equal(h.calls.creates.length, 1); assert.equal(h.calls.creates[0].url, 'https://www.google.com/search?q=' + encodeURIComponent(query));
    assert.equal(h.calls.creates[0].windowId, 7); assert.equal(h.calls.messages.at(-1).nonce, nonce);
    assert.deepEqual(h.calls.sequence.slice(-3), ['create-tab', 'focus-window', 'page-search-close']);
  }
});

test('embedded pending authorization cannot be bypassed by prefixes and uses latest effective provider when ready', async () => {
  const pending = deferred(), h = harness({ state: () => pending.promise });
  await h.open({ query: 'b roadmap', provider: 'google' }); await h.advance(1000); assertNoPrivateAccess(h);
  h.search('g roadmap'); h.key('Enter'); assertNoPrivateAccess(h);
  pending.resolve(authorized()); await settle(); await h.advance(1000);
  assert.equal(h.calls.searches.length, 0); assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']);
  h.key('Enter'); await settle(); assert.equal(h.calls.creates[0].url, 'https://www.google.com/search?q=roadmap');
});

test('embedded empty prefixes have source-specific hints, no remote calls and no Google or native navigation', async () => {
  const h = harness(); await settle();
  for (const raw of ['b ', ' H\t ', ' G\n ']) {
    await h.open({ query: raw, provider: 'all' }); await h.advance(1000); h.key('Enter'); await settle();
    assert.equal(h.rows().length, 0); assert.equal(h.calls.searches.length, 0); assert.equal(h.calls.creates.length, 0);
    assert.match(h.count(), /请输入.*搜索词/); assert.doesNotMatch(h.count(), /没有匹配|失败|CLI/);
  }
});

test('embedded same-query prefix switches reject old response while Google is effective and reset base provider on reopen', async () => {
  const pending = deferred(), h = harness({ bookmarkSearch: () => pending.promise }); await settle();
  await h.open({ query: 'b roadmap', provider: 'tabs' }); await h.advance(120);
  h.search('g roadmap'); await h.advance(1000); assert.equal(h.calls.searches.length, 1);
  pending.resolve([bm('must-not-render', 'Must Not Render', 'https://react.dev/stale')]); await settle();
  assert.deepEqual(h.rows().map(row => row.dataset.kind), ['google']);
  h.search('roadmap'); assert.equal(h.rows('tab').length, 1); assert.equal(h.rows('google').length, 0);
  h.search('g roadmap'); h.key('Escape'); await settle(); await h.open(); h.search('roadmap');
  assert.equal(h.rows('tab').length, 1); assert.equal(h.rows('google').length, 1);
});

function assertNoPrivateAccess(h) {
  assert.equal(h.calls.queries.length, 0); assert.equal(h.calls.groups.length, 0); assert.equal(h.calls.searches.length, 0);
  assert.equal(h.calls.creates.length, 0); assert.equal(h.calls.updates.length, 0); assert.equal(h.calls.focuses.length, 0);
  assert.equal(h.rows().length, 0);
}

test('embedded state authorization precedes every tabs/groups/bookmark request and explicit navigation', async () => {
  const pending = deferred(); const h = harness({ state: () => pending.promise });
  assert.deepEqual(h.calls.sequence, ['page-search-state']);
  assert.equal(h.document.body.classList.contains('search-window'), true);
  assert.equal(h.document.body.classList.contains('search-embedded'), true);
  await h.open({ query: 'roadmap' });
  await h.advance(1000); h.key('Enter'); assertNoPrivateAccess(h);
  pending.resolve(authorized()); await settle(); await h.advance(120);
  assert.equal(h.calls.queries.length, 1); assert.equal(h.calls.groups.length, 1); assert.equal(h.calls.searches.length, 1);
  assert.ok(h.calls.messages.filter(message => message.type === 'page-search-state').every(message => message.nonce === nonce));
  assert.equal(h.calls.messages.some(message => message.type === 'browser-search-state'), false);
  assert.equal(h.calls.creates.length, 0, 'authorization never implicitly navigates');
});

for (const failure of ['denied', 'rejected', 'missing-tab', 'missing-window']) {
  test(`${failure}: unauthorized embedded frame exposes no results and permits no private requests or Google action`, async () => {
    const h = harness({ state: () => {
      if (failure === 'rejected') throw new Error('PRIVATE server detail');
      return failure === 'denied' ? { ok: false, message: 'PRIVATE error detail', results: [bm('secret')] } : authorized(failure === 'missing-tab' ? { currentTabId: null } : { sourceWindowId: null });
    } });
    await settle(); h.search('私密'); await h.advance(1000); h.key('Enter');
    assertNoPrivateAccess(h); assert.match(h.count(), /未授权.*关闭/); assert.doesNotMatch(h.count(), /PRIVATE/);
    assert.equal(h.input.getAttribute('aria-activedescendant'), null); assert.equal(h.list.getAttribute('aria-busy'), 'false');
  });
}

for (const suffix of ['', '?embedded=', '?embedded=one&embedded=two']) {
  test(`framed URL ${suffix || '(no nonce)'} never falls through to legacy standalone permissions`, async () => {
    const h = harness({ suffix }); await settle(); h.search('secret'); await h.advance(1000); h.key('Enter');
    assertNoPrivateAccess(h); assert.equal(h.calls.messages.some(message => /browser-search/.test(message.type)), false);
    assert.match(h.count(), /未授权/);
  });
}

test('top-level no-nonce helper alone retains legacy browser-search-state and close', async () => {
  const h = harness({ suffix: '', framed: false }); await settle();
  assert.equal(h.document.body.classList.contains('search-embedded'), false); assert.equal(h.rows('tab').length, 1);
  assert.equal(h.calls.messages[0].type, 'browser-search-state'); h.key('Escape'); await settle();
  assert.equal(h.calls.messages.at(-1).type, 'browser-search-close');
});

for (const trigger of ['Escape', 'scrim']) {
  test(`${trigger}: embedded close sends restoreFocus(true), never windows.remove; late authorization cannot query`, async () => {
    const pending = deferred(), h = harness({ state: () => pending.promise });
    if (trigger === 'Escape') h.key('Escape'); else h.palette.dispatchEvent(new Event('mousedown'));
    await settle(); assert.equal(h.calls.messages.at(-1).type, 'page-search-close');
    assert.equal(h.calls.messages.at(-1).nonce, nonce); assert.equal(h.calls.messages.at(-1).restoreFocus, true);
    pending.resolve(authorized()); await settle(); assertNoPrivateAccess(h);
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.removes.length, 0);
    assert.notEqual(h.document.activeElement, h.trigger, 'bridge, not the iframe, owns host previousFocus restoration');
  });
}

for (const kind of ['tab', 'bookmark', 'google']) {
  test(`${kind}: explicit activation focuses destination then page-search-close(false), keeping the source window`, async () => {
    const h = harness({ windowId: 55, bookmarkSearch: () => [bm('chosen', 'Chosen Bookmark', 'https://react.dev/chosen')] }); await settle();
    if (kind !== 'tab') { await h.open({ query: 'chosen', provider: kind === 'bookmark' ? 'bookmarks' : 'google' }); await h.advance(120); }
    h.choose(kind).click(); h.key('Enter'); await settle();
    if (kind === 'tab') assert.equal(h.calls.updates[0].id, 10);
    else { assert.equal(h.calls.creates.length, 1); assert.equal(h.calls.creates[0].windowId, 7); assert.equal(h.calls.creates[0].active, true); }
    assert.deepEqual(h.calls.sequence.slice(-3), [kind === 'tab' ? 'activate-tab' : 'create-tab', 'focus-window', 'page-search-close']);
    assert.equal(h.calls.focuses.at(-1).id, 7); assert.equal(h.calls.messages.at(-1).restoreFocus, false); assert.equal(h.calls.messages.at(-1).nonce, nonce);
    assert.equal(h.calls.removes.length, 0); assert.equal(h.palette.classList.contains('hidden'), true);
  });
}

test('focus runtime only accepts this nonce, current authorized source tab and extension background sender; no parent messages', async () => {
  const h = harness(); await settle(); h.search('keep query');
  const before = h.input.focusCount, messagesBefore = h.calls.messages.length;
  for (const bad of [
    { type: 'page-search-focus', nonce: 'spoof', targetTabId: 10 },
    { type: 'page-search-focus', nonce, targetTabId: 99 },
    { type: 'browser-search-focus', windowId: 7 },
    { type: 'page-search-local', windowId: 7, targetTabId: 10 },
  ]) h.message(bad);
  h.message({ type: 'page-search-focus', nonce, targetTabId: 10 }, { id: 'other' });
  h.message({ type: 'page-search-focus', nonce, targetTabId: 10 }, { id: 'fake', tab: { id: 10 } });
  assert.equal(h.input.focusCount, before); assert.equal(h.calls.listeners.has('message'), false);
  h.message({ type: 'page-search-focus', nonce, targetTabId: 10 }); assert.equal(h.input.focusCount, before + 1);
  assert.equal(h.input.value, 'keep query'); assert.equal(h.calls.messages.length, messagesBefore, 'focus must not trigger a fresh auth/data load');
});

test('pagehide invalidates authorization and all delayed work; neither runtime focus nor local events revive the frame', async () => {
  const pending = deferred(), h = harness({ state: () => pending.promise });
  h.calls.listeners.get('pagehide')(); const focuses = h.input.focusCount;
  pending.resolve(authorized()); await settle(); await h.open({ query: 'do not revive', online: true });
  h.message({ type: 'page-search-focus', nonce, targetTabId: 10 }); await h.advance(1000);
  assertNoPrivateAccess(h); assert.equal(h.input.focusCount, focuses); assert.equal(h.palette.classList.contains('hidden'), true);
});

test('late bookmark response after frame pagehide cannot render cached bookmarks or steal focus', async () => {
  const pending = deferred(), h = harness({ bookmarkSearch: () => pending.promise }); await settle();
  await h.open({ query: 'private', provider: 'bookmarks' }); await h.advance(120);
  const html = h.list.innerHTML; h.calls.listeners.get('pagehide')(); const focuses = h.input.focusCount;
  pending.resolve([bm('late', 'Late Bookmark', 'https://github.com/late')]); await settle();
  assert.equal(h.rows('bookmark').length, 0); assert.equal(h.list.innerHTML, html); assert.equal(h.input.focusCount, focuses); assert.equal(h.palette.classList.contains('hidden'), true);
});

test('Escape during an embedded destination lookup cancels late navigation and never closes the browser window', async () => {
  const pending = deferred();
  const h = harness({ queryTabs: count => count === 3 ? pending.promise : [], bookmarkSearch: () => [bm('cancel', 'Cancel Bookmark', 'https://github.com/cancel')] });
  await settle(); await h.open({ query: 'cancel', provider: 'bookmarks' }); await h.advance(120);
  h.choose('bookmark').click(); h.key('Escape'); await settle();
  pending.resolve([]); await settle();
  assert.equal(h.calls.creates.length, 0); assert.equal(h.calls.focuses.length, 0); assert.equal(h.calls.removes.length, 0);
  assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.messages.at(-1).type, 'page-search-close'); assert.equal(h.calls.messages.at(-1).restoreFocus, true);
});

test('embedded close failure preserves a navigated destination for retry without duplicate creation', async () => {
  let closes = 0;
  const h = harness({ closeSearch: () => ({ ok: ++closes > 1 }) });
  await h.open({ query: 'retry', provider: 'google' }); h.choose('google').click(); await settle();
  assert.equal(h.palette.classList.contains('hidden'), false); assert.equal(h.calls.creates.length, 1); assert.equal(h.calls.toasts.length, 1);
  h.key('Enter'); await settle(); assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.creates.length, 1);
  assert.equal(h.calls.messages.at(-1).restoreFocus, false); assert.equal(h.calls.removes.length, 0);
});

test('force reopen drops prior authorization; stale state may not query or re-enable Google before current state', async () => {
  const old = deferred(), fresh = deferred(); let requests = 0;
  const h = harness({ state: () => ++requests === 1 ? old.promise : fresh.promise });
  await h.open({ query: 'new source', provider: 'google' }); old.resolve(authorized({ sourceWindowId: 99 })); await settle();
  h.key('Enter'); await h.advance(1000); assertNoPrivateAccess(h);
  fresh.resolve(authorized({ sourceWindowId: 22, currentTabId: 30 })); await settle();
  const focuses = h.input.focusCount; h.message({ type: 'page-search-focus', nonce, targetTabId: 10 }); assert.equal(h.input.focusCount, focuses);
  h.choose('google').click(); await settle(); assert.equal(h.calls.creates[0].windowId, 22);
});

test('embedded keeps IME protections, stable async selection, one combobox tab stop and focus trap', async () => {
  const pending = deferred(), h = harness({ bookmarkSearch: () => pending.promise }); await settle();
  h.input.dispatchEvent(new Event('compositionstart')); h.search('roadmap'); await h.advance(350);
  h.key('Enter'); h.key('Escape'); assert.equal(h.calls.searches.length, 0); assert.equal(h.palette.classList.contains('hidden'), false);
  h.input.dispatchEvent(new Event('compositionend')); await h.advance(120); assert.equal(h.calls.searches.length, 1);
  h.choose('google'); const selectedKey = h.choose('google').dataset.key; pending.resolve([bm('insert', 'Insert Bookmark', 'https://react.dev/insert')]); await settle();
  const selected = h.rows().find(row => row.getAttribute('aria-selected') === 'true');
  assert.equal(selected.dataset.key, selectedKey); assert.equal(h.input.getAttribute('aria-activedescendant'), selected.id);
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) h.key('Enter', init);
  assert.equal(h.calls.creates.length, 0); assert.equal(h.key('Tab').defaultPrevented, true); assert.equal(h.key('Tab', { shiftKey: true }).defaultPrevented, true);
  h.trigger.focus(); assert.equal(h.document.activeElement, h.input);
  assert.equal(h.input.getAttribute('role'), 'combobox'); assert.equal(h.list.getAttribute('role'), 'listbox');
  h.key('ArrowUp'); assert.notEqual(h.input.getAttribute('aria-activedescendant'), selected.id);
});

test('embedded bookmark query failure degrades cleanly without disabling native tabs or Google', async () => {
  let request = 0;
  const h = harness({ bookmarkSearch: () => {
    if (++request === 1) return [bm('A', 'Roadmap Bookmark A', 'https://react.dev/a')];
    throw new Error('bookmark permission unavailable');
  } });
  await h.open({ query: 'roadmap' }); await h.advance(120); assert.equal(h.rows('bookmark').length, 1);
  h.search('roadmap'); await h.advance(120);
  assert.equal(h.rows('bookmark').length, 0);
  assert.equal(h.rows('tab').length, 1);
  assert.equal(h.rows('google').length, 1);
});

const sidePending = (extra = {}) => ({ id: 'pending-1', windowId: 7, sourceWindowId: 7, currentTabId: 10, query: 'roadmap', provider: 'all', ...extra });
function pendingRPC(initial) {
  let pending = initial;
  return message => {
    const result = pending;
    if (message.ack && pending?.id === message.pendingId) pending = null;
    return { ok: true, pending: result };
  };
}
test('sidepanel initialization consumes pending exactly once by ID and opens inline without a new window', async () => {
  const h = harness({ surface: 'sidepanel', suffix: '', pendingState: pendingRPC(sidePending()) }); await settle();
  const states = h.calls.messages.filter(message => message.type === 'page-search-sidepanel-state');
  assert.equal(states.length, 2); assert.equal(states[0].windowId, 7); assert.equal(states[1].ack, true); assert.equal(states[1].pendingId, 'pending-1');
  assert.equal(h.palette.classList.contains('hidden'), false); assert.equal(h.input.value, 'roadmap');
  h.key('Escape'); h.message({ type: 'page-search-sidepanel', windowId: 7 }); await settle();
  assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.removes.length, 0); assert.equal(h.calls.creates.length, 0);
});

test('sidepanel runtime notification must match its actual window and cannot consume another window pending', async () => {
  let pending = null;
  const h = harness({ surface: 'sidepanel', suffix: '', pendingState: message => {
    const result = pending; if (message.ack && pending?.id === message.pendingId) pending = null;
    return { ok: true, pending: result };
  } }); await settle();
  const before = h.calls.messages.length; pending = sidePending({ windowId: 8, sourceWindowId: 8 });
  h.message({ type: 'page-search-sidepanel', windowId: 8 }); await settle(); assert.equal(h.calls.messages.length, before);
  h.message({ type: 'page-search-sidepanel', windowId: 7 }); await settle(); assert.equal(h.palette.classList.contains('hidden'), true);
  pending = sidePending(); h.message({ type: 'page-search-sidepanel', windowId: 7 }); await settle(); assert.equal(h.palette.classList.contains('hidden'), false);
});

test('sidepanel raced pending read/notification never double-opens; stale acknowledgment cannot consume new generation', async () => {
  const read = deferred(); let pending = sidePending(), reads = 0;
  const h = harness({ surface: 'sidepanel', suffix: '', pendingState: message => {
    if (!message.ack && ++reads === 1) return read.promise;
    const result = pending; if (message.ack && pending?.id === message.pendingId) pending = null;
    return { ok: true, pending: result };
  } }); await settle(); h.message({ type: 'page-search-sidepanel', windowId: 7 });
  read.resolve({ ok: true, pending }); await settle();
  assert.equal(h.calls.messages.filter(message => message.ack).length, 1); assert.equal(h.calls.queries.length, 1);
  h.key('Escape');
  const stale = harness({ surface: 'sidepanel', suffix: '', pendingState: message => ({ ok: true, pending: sidePending({ id: message.ack ? 'newer-id' : 'old-id' }) }) });
  await settle(); assert.equal(stale.palette.classList.contains('hidden'), true); assert.equal(stale.calls.queries.length, 0);
});

for (const surface of ['home', 'sidepanel']) {
  test(`${surface}: runtime local command stays inline and only a trusted exact tab/window match ACKs`, async () => {
    const h = harness({ surface, suffix: '', initialTabs: [
      { id: 10, title: '被 Chrome 隐藏扩展 URL 的首页', url: 'chrome://newtab/', windowId: 7, groupId: -1 },
    ] }); await settle();
    const request = { type: 'page-search-local', windowId: 7, targetTabId: 10, requestId: 'local-request-1' };
    for (const extra of [{ windowId: 8 }, { targetTabId: 99 }, { targetTabId: undefined }, { targetTabId: '10' }, { windowId: '7' }]) h.message({ ...request, ...extra });
    for (const sender of [{ id: 'other' }, { id: 'fake', tab: { id: 10 } }, {}, null]) h.message(request, sender);
    await settle();
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.responses.length, 0); assert.equal(h.calls.queries.length, 0);
    assert.equal(h.message(request, { id: 'fake' }, () => assert.equal(h.document.activeElement, h.input)), true, 'keep the async runtime response channel alive');
    await settle();
    assert.equal(h.palette.classList.contains('hidden'), false); assert.equal(h.calls.creates.length, 0); assert.equal(h.calls.removes.length, 0);
    assert.equal(h.calls.responses.length, 1);
    assert.deepEqual({ ...h.calls.responses[0].response }, { ok: true, claimed: true, windowId: 7, targetTabId: 10, requestId: 'local-request-1' });
    assert.equal(h.rows('tab').length, 1, 'local identity comes from getCurrent, not a possibly masked chrome://newtab Tab.url');
    h.search('keep query'); const focuses = h.input.focusCount;
    h.message({ ...request, requestId: 'local-request-2' }); await settle();
    assert.equal(h.input.value, 'keep query'); assert.equal(h.input.focusCount, focuses + 1); assert.equal(h.calls.queries.length, 1);
    assert.equal(h.calls.responses.length, 2); assert.equal(h.calls.responses[1].response.requestId, 'local-request-2');
    const { requestId, ...legacyRequest } = request; h.message(legacyRequest); await settle();
    assert.deepEqual({ ...h.calls.responses[2].response }, { ok: true, claimed: true, windowId: 7, targetTabId: 10 });
  });
}

for (const surface of ['home', 'sidepanel']) {
  test(`${surface}: first local command waits for cached tab/window ready but not locked sidepanel-state`, async () => {
    const tabReady = deferred(), winReady = deferred(), lockedState = deferred();
    const h = harness({ surface, suffix: '', localTabPromise: tabReady.promise, windowPromise: winReady.promise, pendingState: () => lockedState.promise });
    const request = { type: 'page-search-local', windowId: 7, targetTabId: 10, requestId: 'first-request' };
    assert.equal(h.message(request), true); await settle();
    assert.equal(h.calls.responses.length, 0); assert.equal(h.palette.classList.contains('hidden'), true);
    tabReady.resolve({ id: 10, url: 'chrome://newtab/' }); await settle();
    assert.equal(h.calls.responses.length, 0); assert.equal(h.calls.queries.length, 0);
    winReady.resolve({ id: 7 }); await settle();
    assert.equal(h.calls.responses.length, 1); assert.equal(h.calls.responses[0].response.requestId, 'first-request');
    assert.equal(h.document.activeElement, h.input); assert.equal(h.calls.currentTabReads, 1); assert.equal(h.calls.currentWindowReads, 1);
    assert.equal(h.calls.messages.some(message => message.type === 'page-search-open'), false, 'local ACK must not recurse through the background route');
  });
}

for (const localTabId of [null, '10', 10.5]) {
  test(`native/invalid sidepanel identity ${localTabId}: never opens or ACKs the main tab's local request`, async () => {
    const h = harness({ surface: 'sidepanel', suffix: '', localTabId }); await settle();
    h.message({ type: 'page-search-local', windowId: 7, targetTabId: 10, requestId: 'not-this-document' });
    h.message({ type: 'page-search-local', windowId: 7 }); await settle();
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.responses.length, 0); assert.equal(h.calls.queries.length, 0);
    assert.equal(h.document.activeElement, h.trigger);
  });
}

test('native sidepanel first local request stays unclaimed when getCurrent later resolves undefined', async () => {
  const ready = deferred(), h = harness({ surface: 'sidepanel', suffix: '', localTabPromise: ready.promise });
  h.message({ type: 'page-search-local', windowId: 7, targetTabId: 10, requestId: 'native-first' });
  ready.resolve(undefined); await settle();
  assert.equal(h.calls.responses.length, 0); assert.equal(h.calls.queries.length, 0); assert.equal(h.palette.classList.contains('hidden'), true);
});

test('pending local identity cannot open or ACK after pagehide', async () => {
  const ready = deferred(), h = harness({ surface: 'home', suffix: '', localTabPromise: ready.promise });
  h.message({ type: 'page-search-local', windowId: 7, targetTabId: 10, requestId: 'disposed-first' });
  h.calls.listeners.get('pagehide')(); ready.resolve({ id: 10 }); await settle();
  assert.equal(h.calls.responses.length, 0); assert.equal(h.calls.queries.length, 0); assert.equal(h.palette.classList.contains('hidden'), true);
});

for (const entry of ['pending', 'local', 'keyboard-forwarded-fallback']) {
  test(`sidepanel ${entry}: browser-wide page-search session includes chrome:// tabs and excludes its own search frame`, async () => {
    let pending = entry === 'pending' ? sidePending({ query: '', provider: 'tabs' }) : null;
    const h = harness({ surface: 'sidepanel', suffix: '', localTabId: entry === 'local' ? 10 : null, initialTabs: [
      { id: 81, title: 'Chrome 内置扩展页', url: 'chrome://extensions/', windowId: 7, groupId: -1 },
      { id: 82, title: '普通网页', url: 'https://example.com/', windowId: 7, groupId: -1 },
      { id: 83, title: '自身搜索', url: 'chrome-extension://fake/search.html?embedded=other', windowId: 7, groupId: -1 },
    ], pendingState: message => {
      const result = pending; if (message.ack && pending?.id === message.pendingId) pending = null;
      return { ok: true, pending: result };
    }, pageSearchOpen: () => { pending = sidePending({ query: '', provider: 'tabs' }); return { ok: true, mode: 'sidepanel' }; } });
    await settle();
    if (entry === 'local') { h.message({ type: 'page-search-local', windowId: 7, targetTabId: 10 }); await settle(); }
    if (entry === 'keyboard-forwarded-fallback') {
      h.key('k', { metaKey: true }); await settle();
      assert.equal(h.calls.messages.filter(message => message.type === 'page-search-open').length, 1);
      assert.equal(h.palette.classList.contains('hidden'), true, 'forwarding alone cannot silently open the sidebar');
      h.message({ type: 'page-search-sidepanel', windowId: 7 }); await settle();
    }
    assert.equal(h.rows('tab').length, 2); assert.ok(h.rows('tab').some(row => row.title.includes('chrome://extensions/')));
    assert.equal(h.rows('tab').some(row => row.title.includes('自身搜索')), false);
    h.search('Chrome 内置扩展页'); h.choose('tab').click(); await settle(); assert.equal(h.calls.updates[0].id, 81);
    await h.open({ provider: 'tabs' }); assert.equal(h.rows('tab').length, 1, 'ordinary inline sessions retain their historical HTTP-only scope');
  });
}

for (const entry of ['CtrlK', 'CmdK', 'tt-open-main-search']) {
  test(`native sidepanel ${entry}: forwards once while pending, never opens its own palette`, async () => {
    const pending = deferred();
    const h = harness({ surface: 'sidepanel', suffix: '', localTabId: null, pageSearchOpen: () => pending.promise }); await settle();
    const dispatch = () => entry === 'tt-open-main-search'
      ? h.document.dispatchEvent(new Event(entry)) : h.key('k', { [entry === 'CtrlK' ? 'ctrlKey' : 'metaKey']: true });
    dispatch(); dispatch(); await settle();
    const requests = h.calls.messages.filter(message => message.type === 'page-search-open');
    assert.equal(requests.length, 1); assert.deepEqual({ ...requests[0] }, { type: 'page-search-open' });
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.queries.length, 0); assert.equal(h.calls.responses.length, 0);
    pending.resolve({ ok: true, mode: 'page' }); await settle(); dispatch(); await settle();
    assert.equal(h.calls.messages.filter(message => message.type === 'page-search-open').length, 2, 'settled requests permit an explicit retry');
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.toasts.length, 0);
  });
}

for (const failure of ['response', 'rejection']) {
  test(`sidepanel handoff ${failure}: closes inline before RPC without focus restoration or automatic fallback; retry remains available`, async () => {
    const pending = deferred(); let opened = 0;
    const h = harness({ surface: 'sidepanel', suffix: '', localTabId: null, pageSearchOpen: (_, { document }) => {
      assert.equal(document.getElementById('palette').classList.contains('hidden'), true, 'close inline before calling the background');
      return ++opened === 1 ? pending.promise : { ok: true };
    } }); await h.open({ query: 'private', provider: 'bookmarks' });
    const triggerFocus = h.trigger.focusCount, queries = h.calls.queries.length;
    h.document.dispatchEvent(new Event('tt-open-main-search')); await settle();
    assert.equal(opened, 1); assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.trigger.focusCount, triggerFocus);
    if (failure === 'response') pending.resolve({ ok: false, message: 'restricted-or-unavailable' }); else pending.reject(new Error('route failed'));
    await settle();
    assert.equal(h.palette.classList.contains('hidden'), true); assert.equal(h.calls.queries.length, queries); assert.equal(h.trigger.focusCount, triggerFocus);
    assert.equal(h.calls.toasts.length, 1); assert.match(h.calls.toasts[0][0], /主标签页/); assert.match(h.calls.toasts[0][0], /重试/); assert.equal(h.calls.toasts[0][1], 'err');
    h.document.dispatchEvent(new Event('tt-open-main-search')); await settle(); assert.equal(opened, 2); assert.equal(h.palette.classList.contains('hidden'), true);
    await h.open({ query: 'explicit-inline', provider: 'google' });
    assert.equal(h.palette.classList.contains('hidden'), false); assert.equal(h.input.value, 'explicit-inline');
    assert.equal(opened, 2, 'legacy tt-open-palette remains a separate local control');
  });
}

for (const surface of ['home', 'popup', 'search-window']) {
  test(`${surface}: tt-open-main-search does not replace ordinary local or embedded controls`, async () => {
    const h = harness({ surface, suffix: surface === 'search-window' ? '?embedded=' + nonce : '' }); await settle();
    const before = h.input.focusCount;
    h.document.dispatchEvent(new Event('tt-open-main-search')); await settle();
    assert.equal(h.calls.messages.some(message => message.type === 'page-search-open'), false); assert.equal(h.input.focusCount, before);
    await h.open({ query: 'local control', provider: 'google' }); assert.equal(h.input.value, 'local control'); assert.equal(h.palette.classList.contains('hidden'), false);
  });
}

test('sidepanel main-search handoff preserves composition, isComposing and legacy 229 guards', async () => {
  const h = harness({ surface: 'sidepanel', suffix: '', localTabId: null }); await settle();
  for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(h.key('k', { ctrlKey: true, ...init }).defaultPrevented, false);
  }
  await h.open(); h.input.dispatchEvent(new Event('compositionstart'));
  assert.equal(h.key('k', { metaKey: true }).defaultPrevented, false); assert.equal(h.palette.classList.contains('hidden'), false);
  assert.equal(h.calls.messages.some(message => message.type === 'page-search-open'), false);
  h.input.dispatchEvent(new Event('compositionend')); h.key('k', { metaKey: true }); await settle();
  assert.equal(h.calls.messages.filter(message => message.type === 'page-search-open').length, 1); assert.equal(h.palette.classList.contains('hidden'), true);
});

test('embedded layout is transparent scrim plus constrained token-based card, with 16px narrow-screen gutters and no glass', () => {
  const embeddedCSS = css.slice(css.indexOf('/* The extension-origin frame'));
  assert.match(embeddedCSS, /\.search-window\.search-embedded\s*\{[^}]*min-width:\s*0[^}]*background:\s*transparent/s);
  assert.match(embeddedCSS, /\.search-embedded \.palette\s*\{[^}]*position:\s*fixed[^}]*align-items:\s*center[^}]*padding:\s*var\(--space-md\)/s);
  assert.match(embeddedCSS, /\.search-embedded \.palette-panel\s*\{[^}]*width:\s*min\(680px, 100%\)[^}]*height:\s*auto[^}]*max-height:\s*76vh/s);
  assert.match(embeddedCSS, /@media \(max-width: 700px\)/); assert.doesNotMatch(embeddedCSS, /backdrop-filter|#[0-9a-f]{3,8}\b|rgba?\(/i);
});


test('authorized embedded typing waits 100ms, queries bookmarks and renders items without another click', async () => {
  const h = harness({ bookmarkSearch: () => [bm('direct', 'Roadmap Bookmark', 'https://react.dev/roadmap')] }); await settle(); h.search('roadmap');
  assert.equal(h.rows('tab').length, 1);
  await h.advance(99); assert.equal(h.calls.searches.length, 0); await h.advance(1);
  assert.deepEqual({ ...h.calls.searches[0] }, { query: 'roadmap' });
  assert.equal(h.rows('bookmark').length, 1); assert.equal(h.calls.creates.length, 0);
});

test('embedded source authorization gates automatic queries and updates once ready', async () => {
  const pending = deferred(), h = harness({ state: () => pending.promise, bookmarkSearch: () => [bm('direct', 'Roadmap Bookmark', 'https://react.dev/roadmap')] });
  await h.open({ query: 'roadmap', provider: 'bookmarks' }); await h.advance(1000); assertNoPrivateAccess(h);
  pending.resolve(authorized()); await settle(); await h.advance(99); assert.equal(h.calls.searches.length, 0);
  await h.advance(1); assert.equal(h.calls.searches.length, 1);
});

test('pasting a URL promotes direct jump at top, suppresses unrelated tab/bookmark noise, and reuses open tabs', async () => {
  const pasted = 'https://github.com/facebook/react/issues/31415';
  const tabs = [
    { id: 10, windowId: 7, groupId: 1, title: 'Current Page', url: 'https://example.com/cur', lastAccessed: 900 },
    { id: 11, windowId: 7, groupId: 1, title: 'MDN Web Docs Reference', url: 'https://developer.mozilla.org/en-US/docs/Web', lastAccessed: 890 },
    { id: 12, windowId: 8, groupId: 2, title: 'Vite Guide', url: 'https://vite.dev/guide/', lastAccessed: 880 },
  ];
  const h = harness({ surface: 'home', suffix: '', initialTabs: tabs, bookmarkSearch: () => [bm('should-not-run')] });
  await settle();
  await h.open();
  await h.advance(10);
  h.search(pasted);
  await h.advance(400);
  // 1) Long pasted URL skips remote bookmark search
  assert.equal(h.calls.searches.length, 0);
  // 2) Only the direct URL item appears cleanly at row 0 (unrelated tabs filtered out)
  assert.equal(h.rows('url').length, 1);
  assert.equal(h.rows('tab').length, 0);
  assert.match(h.rows('url')[0].html, /打开网址：https:\/\/github\.com\/facebook\/react\/issues\/31415/);
  assert.equal(h.palette.querySelectorAll('.palette-row')[0].dataset.kind, 'url');
  h.key('Enter');
  await settle();
  assert.equal(h.calls.creates.at(-1)?.url, pasted);

  // 3) When the target URL is already open, row 0 promotes switching directly to that open tab without creating a duplicate
  tabs.push({ id: 25, windowId: 9, groupId: 1, title: 'React StrictMode Issue', url: pasted, lastAccessed: 950 });
  await h.open();
  await h.advance(10);
  h.search('github.com/facebook/react/issues/31415');
  await settle();
  assert.equal(h.rows('url').length, 1);
  assert.match(h.rows('url')[0].html, /切换到已打开网页：React StrictMode Issue/);
  const createsBefore = h.calls.creates.length;
  h.key('Enter');
  await settle();
  assert.equal(h.calls.creates.length, createsBefore);
});

test('early page-search-focus before sourceReady resolves applies after matching authorization, and window focus refocuses open input only', async () => {
  const pending = deferred();
  const h = harness({ state: () => pending.promise });
  const before = h.input.focusCount;
  // Spoofed/mismatched early focus must still be ignored after auth resolves.
  h.message({ type: 'page-search-focus', nonce: 'spoof', targetTabId: 10 });
  h.message({ type: 'page-search-focus', nonce, targetTabId: 99 });
  assert.equal(h.input.focusCount, before);

  // Valid early focus arrives before page-search-state finishes; applies once authorized.
  h.message({ type: 'page-search-focus', nonce, targetTabId: 10 });
  assert.equal(h.input.focusCount, before);
  pending.resolve(authorized());
  await settle();
  assert.equal(h.input.focusCount, before + 1);

  // Host iframe/window gaining focus while palette is open moves focus into #paletteInput.
  const winFocus = h.calls.listeners.get('focus');
  assert.equal(typeof winFocus, 'function');
  h.trigger.focus();
  assert.equal(h.document.activeElement, h.input);
  const countOpen = h.input.focusCount;
  winFocus();
  assert.equal(h.input.focusCount, countOpen + 1);

  // Never steals focus after pagehide / close.
  h.calls.listeners.get('pagehide')();
  winFocus();
  assert.equal(h.input.focusCount, countOpen + 1);
});

test('palette quick-copy URL button and Cmd+C copy row URL without closing or navigating, and respect text selection', async () => {
  const h = harness({
    initialTabs: [{ id: 10, title: 'TabLoom Docs', url: 'https://github.com/facebook/react', groupId: 2, windowId: 7 }],
  });
  await settle();
  const row = h.rows('tab')[0];
  const copyBtn = row.querySelector('.palette-copy');
  assert.ok(copyBtn, 'expected .palette-copy button on URL-bearing row');
  copyBtn.click();
  await settle();
  assert.deepEqual(h.calls.copied, ['https://github.com/facebook/react']);
  assert.equal(h.calls.updates.length, 0, 'copy button must not activate/navigate tab');
  assert.equal(h.palette.classList.contains('hidden'), false, 'palette remains open after copying URL');
  assert.equal(h.document.activeElement, h.input, 'focus returns cleanly to #paletteInput');
  assert.equal(copyBtn.classList.contains('copied'), true);
  await h.advance(1500);
  assert.equal(copyBtn.classList.contains('copied'), false);

  // Cmd+C when input has no selection copies selected row URL; with input selection, native copy is left untouched unless Shift is held
  h.input.value = 'roadmap';
  h.input.selectionStart = 0;
  h.input.selectionEnd = 0;
  const cmdC = h.key('c', { metaKey: true });
  await settle();
  assert.equal(cmdC.defaultPrevented, true);
  assert.equal(h.calls.copied.length, 2);

  h.input.selectionStart = 0;
  h.input.selectionEnd = 4;
  const nativeCopy = h.key('c', { metaKey: true });
  await settle();
  assert.equal(nativeCopy.defaultPrevented, false);
  assert.equal(h.calls.copied.length, 2);

  const forceCopy = h.key('c', { metaKey: true, shiftKey: true });
  await settle();
  assert.equal(forceCopy.defaultPrevented, true);
  assert.equal(h.calls.copied.length, 3);
});

test('palette renders bookmark icons/folder tags and hibernated outer ring markers on discarded tabs', async () => {
  const h = harness({
    initialTabs: [
      { id: 10, title: 'Sleeping Doc', url: 'https://example.com/sleeping', groupId: 2, windowId: 7, discarded: true },
    ],
    initialBookmarks: [
      { id: 'b1', title: 'React Docs Reference', url: 'https://react.dev/reference' },
      { id: 'b2', title: 'MDN React Guide', url: 'https://developer.mozilla.org/en-US/docs/Learn/Tools/React' },
    ],
  });
  await settle();
  await h.open({ query: 'b React', provider: 'all' });
  await h.advance(120);
  const bmRows = h.rows('bookmark');
  assert.equal(bmRows.length, 2);
  assert.match(bmRows[0].html, /#F59E0B/); assert.match(bmRows[0].html, /书签/);

  // Discarded tab gets .is-discarded + 已休眠 marker
  h.search('Sleeping');
  await settle();
  const tabRow = h.rows('tab')[0];
  assert.ok(tabRow, 'expected hibernated tab row');
  assert.equal(tabRow.classList.contains('is-discarded'), true);
  assert.match(tabRow.html, /已休眠/);
});
