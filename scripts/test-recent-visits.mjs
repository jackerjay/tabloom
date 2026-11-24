#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, tab } from './lifecycle-fixture.mjs';

const uiSource = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

function loadFormatRelativeAccessTime() {
  const ctx = vm.createContext({
    URL,
    document: { createElement: () => ({ style: {} }), querySelectorAll: () => [], documentElement: { dataset: {} }, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    chrome: { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } },
  });
  vm.runInContext(uiSource, ctx);
  return ctx.formatRelativeAccessTime;
}

test('onActivated and active onCreated stamp recentTabVisits immediately and onRemoved cleans up', async () => {
  const f = fixture([
    tab(1, { windowId: 1, groupId: -1, url: 'https://example.test/a', lastAccessed: 1000 }),
    tab(2, { windowId: 1, groupId: -1, url: 'https://example.test/b', lastAccessed: 1000 }),
  ], []);

  f.tick(5000);
  const tA = f.now();
  await f.activate(1);
  f.tick(8000);
  const tB = f.now();
  await f.activate(2);

  await new Promise(r => setImmediate(r));
  const stored = f.stores.session.recentTabVisits;
  assert.ok(stored && typeof stored === 'object');
  assert.equal(stored[1], tA);
  assert.equal(stored[2], tB);
  assert.ok(stored[2] > stored[1], 'switching from tab 1 to tab 2 preserves real-time MRU ordering');

  // Removing tab 1 removes its stale visit entry cleanly
  await f.chrome.tabs.remove(1);
  await new Promise(r => setImmediate(r));
  assert.equal(1 in f.stores.session.recentTabVisits, false);
  assert.equal(f.stores.session.recentTabVisits[2], tB);
});

test('formatRelativeAccessTime formats zh/en relative durations accurately and ignores invalid timestamps', () => {
  const fmt = loadFormatRelativeAccessTime();
  const now = 1_795_000_000_000;
  assert.equal(fmt(now - 3000, { now, lang: 'zh' }), '刚刚');
  assert.equal(fmt(now - 3000, { now, lang: 'en' }), 'just now');
  assert.equal(fmt(now - 42000, { now, lang: 'zh' }), '42秒前');
  assert.equal(fmt(now - 42000, { now, lang: 'en' }), '42s ago');
  assert.equal(fmt(now - 5 * 60000, { now, lang: 'zh' }), '5分钟前');
  assert.equal(fmt(now - 5 * 60000, { now, lang: 'en' }), '5m ago');
  assert.equal(fmt(now - 3 * 3600000, { now, lang: 'zh' }), '3小时前');
  assert.equal(fmt(now - 3 * 3600000, { now, lang: 'en' }), '3h ago');
  assert.equal(fmt(now - 2 * 86400000, { now, lang: 'zh' }), '2天前');
  assert.equal(fmt(now - 2 * 86400000, { now, lang: 'en' }), '2d ago');

  // Invalid / unknown / tiny synthetic timestamps never produce misleading output
  assert.equal(fmt(0, { now }), '');
  assert.equal(fmt(900, { now }), '');
  assert.equal(fmt(undefined, { now }), '');
  assert.equal(fmt(now + 120000, { now }), '');
});
