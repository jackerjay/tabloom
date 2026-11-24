#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, tab } from './lifecycle-fixture.mjs';

const uiSource = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

function loadUiResolveTitle() {
  const ctx = vm.createContext({
    URL,
    document: { createElement: () => ({ style: {} }), querySelectorAll: () => [], documentElement: { dataset: {} }, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    chrome: { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } },
  });
  vm.runInContext(uiSource, ctx);
  return ctx.resolveTabDisplayTitle;
}

test('tab-rename supports independent names for same-URL multi-open tabs and protects against AI overwrite', async () => {
  const sharedUrl = 'https://console.example.com/deploy/config/namespace/prod';
  const f = fixture([
    tab(1, { windowId: 1, groupId: -1, url: sharedUrl, title: 'ConfigSys · Deploy Console' }),
    tab(2, { windowId: 1, groupId: -1, url: sharedUrl, title: 'ConfigSys · Deploy Console' }),
    tab(3, { windowId: 1, groupId: -1, url: 'https://example.test/doc', title: 'Doc 3' }),
  ], []);

  const missing = await f.send({ type: 'tab-rename', tabId: 999, title: 'Nope' });
  assert.equal(missing.ok, false);
  const blank = await f.send({ type: 'tab-rename', tabId: 1, title: '   ' });
  assert.equal(blank.ok, false);

  const r1 = await f.send({ type: 'tab-rename', tabId: 1, title: 'EU Promo Rollout' });
  const r2 = await f.send({ type: 'tab-rename', tabId: 2, title: 'US Promo Control' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(f.stores.local.manualTabTitles[1].title, 'EU Promo Rollout');
  assert.equal(f.stores.local.manualTabTitles[2].title, 'US Promo Control');

  // writeTabTitles skips manually renamed tab 1 & 2, updates tab 3 only
  const scripted = [];
  f.chrome.scripting.executeScript = async ({ target, args }) => {
    scripted.push({ tabId: target.tabId, args });
    return [{ result: { status: 'updated' } }];
  };
  const proposal = {
    windowId: 1,
    analysisGuards: [
      { id: 1, url: sharedUrl, snippet: 'body1' },
      { id: 2, url: sharedUrl, snippet: 'body2' },
      { id: 3, url: 'https://example.test/doc', snippet: 'body3' },
    ],
    tabTitles: [
      { id: 1, title: 'AI 覆盖尝试1', source: 'ai' },
      { id: 2, title: 'AI 覆盖尝试2', source: 'ai' },
      { id: 3, title: 'AI 新标题 3', source: 'ai' },
    ],
  };
  const stats = await f.context.writeTabTitles(proposal, new Set([1, 2, 3]));
  assert.equal(stats.unchanged, 2);
  assert.equal(stats.updated, 1);
  assert.deepEqual(scripted.map(s => s.tabId), [3]);
});

test('manualTabTitles survives same-URL hash change and prunes on navigation or tab removal', async () => {
  const f = fixture([
    tab(1, { windowId: 1, groupId: -1, url: 'https://console.example.com/deploy/config/namespace/prod', title: 'Console' }),
  ], []);

  await f.send({ type: 'tab-rename', tabId: 1, title: 'Creator Promo · EU' });
  assert.equal(f.stores.local.manualTabTitles[1].title, 'Creator Promo · EU');

  // Hash-only navigation preserves manual title
  await f.chrome.tabs.update(1, { url: 'https://console.example.com/deploy/config/namespace/prod#detail' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.stores.local.manualTabTitles[1]?.title, 'Creator Promo · EU');

  // Different URL navigation prunes manual title
  await f.chrome.tabs.update(1, { url: 'https://console.example.com/deploy/config/other' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.stores.local.manualTabTitles[1], undefined);

  // Rename again then close tab -> pruned cleanly
  await f.send({ type: 'tab-rename', tabId: 1, title: '其他配置' });
  assert.equal(f.stores.local.manualTabTitles[1]?.title, '其他配置');
  await f.chrome.tabs.remove(1);
  await new Promise(r => setImmediate(r));
  assert.equal(f.stores.local.manualTabTitles[1], undefined);
});

test('resolveTabDisplayTitle prefers manualTabTitles over AI tabMetaCache and cleanTitle', () => {
  const resolveTabDisplayTitle = loadUiResolveTitle();
  const url = 'https://console.example.com/deploy/config/namespace/prod';
  const t = { id: 42, url, title: 'ConfigSys · Deploy Console' };
  const metaMap = { [url]: { title: 'AI 标题', source: 'ai' } };
  const manualMap = { 42: { title: '我的自定义名称', url } };

  assert.equal(resolveTabDisplayTitle(t, metaMap, manualMap), '我的自定义名称');
  assert.equal(resolveTabDisplayTitle({ id: 99, url, title: 'Raw' }, metaMap, manualMap), 'AI 标题');
  assert.equal(resolveTabDisplayTitle(t, metaMap, { 42: { title: '过期名', url: 'https://other.test/' } }), 'AI 标题');
});
