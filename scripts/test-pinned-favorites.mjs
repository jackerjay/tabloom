#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, tab } from './lifecycle-fixture.mjs';

const uiSource = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

function loadUiFavoritesHelpers() {
  const ctx = vm.createContext({
    URL,
    document: { createElement: () => ({ style: {} }), querySelectorAll: () => [], documentElement: { dataset: {} }, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    chrome: { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } },
  });
  vm.runInContext(uiSource, ctx);
  return { favoriteKeyOf: ctx.favoriteKeyOf };
}

test('favorite-toggle persists canonical entries, rejects non-HTTP URLs, and toggles cleanly', async () => {
  const f = fixture([], []);

  const bad = await f.send({ type: 'favorite-toggle', url: 'chrome://settings/', title: 'Settings' });
  assert.equal(bad.ok, false);

  const add1 = await f.send({
    type: 'favorite-toggle',
    url: 'https://console.example.com/deploy/config/namespace/prod#section1',
    title: 'ConfigSys Prod',
  });
  assert.equal(add1.ok, true);
  assert.equal(add1.pinned, true);
  assert.equal(add1.favorites.length, 1);
  assert.equal(add1.favorites[0].key, 'https://console.example.com/deploy/config/namespace/prod');

  // Re-toggling same canonical URL (without hash) removes it cleanly
  const remove1 = await f.send({
    type: 'favorite-toggle',
    url: 'https://console.example.com/deploy/config/namespace/prod',
  });
  assert.equal(remove1.ok, true);
  assert.equal(remove1.pinned, false);
  assert.deepEqual(remove1.favorites, []);

  // Explicit pinned:true is idempotent without creating duplicate entries
  await f.send({ type: 'favorite-toggle', url: 'https://github.com/jackerjay/tabloom', title: 'TabLoom', pinned: true });
  const idem = await f.send({ type: 'favorite-toggle', url: 'https://github.com/jackerjay/tabloom#readme', title: 'TabLoom Updated', pinned: true });
  assert.equal(idem.ok, true);
  assert.equal(idem.pinned, true);
  assert.equal(idem.favorites.length, 1);
  assert.equal(idem.favorites[0].title, 'TabLoom Updated');
});

test('favorite-open switches to an already-open tab (preferring requested window) and reopens closed favorites', async () => {
  const f = fixture([
    tab(1, { windowId: 1, groupId: -1, url: 'https://console.example.com/deploy/config/namespace/prod', active: false }),
    tab(2, { windowId: 2, groupId: -1, url: 'https://console.example.com/deploy/config/namespace/prod', active: false }),
    tab(3, { windowId: 1, groupId: -1, url: 'https://example.test/home', active: true }),
  ], []);

  await f.send({
    type: 'favorite-toggle',
    url: 'https://console.example.com/deploy/config/namespace/prod',
    title: 'ConfigSys Prod',
    pinned: true,
  });

  // Open in window 2 -> prefers window 2's existing tab rather than creating a duplicate
  const sw = await f.send({
    type: 'favorite-open',
    url: 'https://console.example.com/deploy/config/namespace/prod',
    windowId: 2,
  });
  assert.equal(sw.ok, true);
  assert.equal(sw.action, 'switched');
  assert.equal(sw.tabId, 2);
  assert.equal(sw.windowId, 2);
  assert.equal(f.calls.create.length, 0);

  // Close all matching tabs -> favorite-open reopens cleanly as an active tab
  await f.chrome.tabs.remove([1, 2]);
  const reopen = await f.send({
    type: 'favorite-open',
    url: 'https://console.example.com/deploy/config/namespace/prod',
    windowId: 1,
  });
  assert.equal(reopen.ok, true);
  assert.equal(reopen.action, 'opened');
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.tabs.get(reopen.tabId)?.url, 'https://console.example.com/deploy/config/namespace/prod');
  assert.equal(f.tabs.get(reopen.tabId)?.active, true);
});

test('favoriteKeyOf strips URL fragments consistently with backend normalization', () => {
  const { favoriteKeyOf } = loadUiFavoritesHelpers();
  assert.equal(
    favoriteKeyOf('https://console.example.com/deploy/config/namespace/prod?env=boe#heading'),
    'https://console.example.com/deploy/config/namespace/prod?env=boe',
  );
});
