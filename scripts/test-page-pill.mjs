#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../extension/page-pill.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function pillHarness({ themeMode = 'dark', uiLang = 'zh', show = true, osDark = true } = {}) {
  const listeners = { storage: [], mq: [], window: new Map(), runtime: [] };
  const sent = [];
  let mqMatches = osDark;
  const stores = { settings: { showPageSearchPill: show, pillHiddenHosts: [] }, themeMode, uiLang };

  class MockNode {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attrs = {};
      this.listeners = new Map();
      this.style = {
        props: {},
        cssText: '',
        setProperty(k, v) { this.props[k] = v; },
      };
      this.captures = new Set();
      this.top = 240;
    }
    get isConnected() { return this._connected !== false; }
    append(...nodes) {
      for (const n of nodes) {
        n.parent = this;
        n._connected = true;
        this.children.push(n);
      }
    }
    attachShadow() {
      this._shadow = new MockNode('shadow');
      return this._shadow;
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
    dispatch(type, ev = {}) {
      ev.type = type;
      ev.target ||= this;
      ev.preventDefault ||= () => { ev.defaultPrevented = true; };
      ev.stopPropagation ||= () => {};
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    getBoundingClientRect() {
      const m = String(this.style.props.top || '').match(/([\d.]+)px/);
      return { top: m ? Number(m[1]) : this.top, left: 1160, width: 140, height: 36 };
    }
    contains(target) { return target === this || this.children.some(c => c.contains(target)); }
    remove() { this._connected = false; }
  }

  const body = new MockNode('body');
  const document = {
    body,
    createElement: tag => new MockNode(tag),
  };

  const chrome = {
    runtime: {
      sendMessage: async msg => { sent.push(msg); return { ok: true }; },
      onMessage: { addListener: fn => listeners.runtime.push(fn) },
    },
    storage: {
      sync: {
        get: async keys => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) out[k] = stores[k];
          return out;
        },
      },
      onChanged: {
        addListener: fn => listeners.storage.push(fn),
      },
    },
  };

  const matchMedia = () => ({
    get matches() { return mqMatches; },
    addEventListener(type, fn) { if (type === 'change') listeners.mq.push(fn); },
  });

  const windowObj = {
    get top() { return windowObj; },
    innerHeight: 800,
    addEventListener: (t, fn) => listeners.window.set(t, fn),
  };

  const ctx = vm.createContext({
    globalThis: {},
    window: windowObj,
    document,
    location: { protocol: 'https:', hostname: 'example.com' },
    navigator: { platform: 'MacIntel' },
    chrome,
    matchMedia,
    requestAnimationFrame: fn => fn(),
  });
  ctx.globalThis = ctx;

  vm.runInContext(source, ctx);

  const getBtn = () => {
    const host = body.children[0];
    return host?._shadow?.children?.find(c => c.className === 'pill') || null;
  };

  return {
    body,
    sent,
    stores,
    listeners,
    getHost: () => body.children[0] || null,
    getBtn,
    setOsDark: val => { mqMatches = val; for (const fn of listeners.mq) fn({ matches: val }); },
    changeSync: async patch => {
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        changes[k] = { oldValue: stores[k], newValue: v };
        stores[k] = v;
      }
      for (const fn of listeners.storage) fn(changes, 'sync');
      await settle();
    },
  };
}

test('page-pill follows light/dark/auto themeMode and zh/en uiLang reactively', async () => {
  const h = pillHarness({ themeMode: 'light', uiLang: 'en' });
  await settle();
  const btn = h.getBtn();
  assert.ok(btn, 'expected floating pill to mount');
  assert.equal(btn.dataset.theme, 'light');
  assert.equal(btn.children[2].textContent, 'Search Tabs / Bookmarks');

  await h.changeSync({ themeMode: 'dark', uiLang: 'zh' });
  assert.equal(btn.dataset.theme, 'dark');
  assert.equal(btn.children[2].textContent, '搜索标签 / 书签');

  await h.changeSync({ themeMode: 'auto' });
  h.setOsDark(false);
  assert.equal(btn.dataset.theme, 'light');
  h.setOsDark(true);
  assert.equal(btn.dataset.theme, 'dark');
});

test('page-pill triggers search reliably on click (even with minor jitter) and suppresses click only after real vertical drag', async () => {
  const h = pillHarness({ themeMode: 'light' });
  await settle();
  const btn = h.getBtn();
  const icon = btn.children[0];

  // Slight <=6px trackpad tap jitter still activates Cmd+K search without seizing pointer capture early
  btn.dispatch('pointerdown', { button: 0, pointerId: 1, clientY: 250, target: icon });
  assert.equal(btn.captures.size, 0);
  btn.dispatch('pointermove', { pointerId: 1, clientY: 254 });
  btn.dispatch('pointerup', { pointerId: 1, clientY: 254 });
  btn.dispatch('click', { target: icon });
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [{ type: 'page-search-pill-trigger' }]);

  // Dragging vertically (> 6px) repositions the pill and suppresses click
  btn.dispatch('pointerdown', { button: 0, pointerId: 2, clientY: 250, target: btn });
  btn.dispatch('pointermove', { pointerId: 2, clientY: 290 });
  assert.equal(btn.captures.has(2), true);
  assert.equal(h.getHost().style.props.top, '280px');
  btn.dispatch('pointerup', { pointerId: 2, clientY: 290 });
  btn.dispatch('click', { target: btn });
  assert.equal(h.sent.length, 1);
});
