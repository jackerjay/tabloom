#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fixture, tab } from './lifecycle-fixture.mjs';

const uiSource = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');

function loadFormatWhitelistLabel() {
  const ctx = vm.createContext({
    URL,
    document: { createElement: () => ({ style: {} }), querySelectorAll: () => [], documentElement: { dataset: {} }, addEventListener() {} },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    chrome: { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } },
  });
  vm.runInContext(uiSource, ctx);
  return ctx.formatWhitelistLabel;
}

function checkWhitelist(f, url) {
  return vm.runInContext(
    `isUrlWhitelisted(${JSON.stringify(url)}, ${JSON.stringify(f.stores.sync.settings.dedupWhitelist || [])})`,
    f.context,
  );
}

test('wildcard path rule allows multi-open under matched path while still intercepting other paths on same host', async () => {
  const f = fixture([
    tab(1, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/prod', active: false }),
    tab(2, { groupId: -1, url: 'https://console.example.com/deploy/config/other', active: false }),
  ], []);

  const add = await f.send({
    type: 'dup-whitelist-add',
    url: 'https://console.example.com/deploy/config/namespace/*',
  });
  assert.equal(add.ok, true);
  assert.equal(add.ruleType, 'wildcard');
  assert.deepEqual(add.whitelist, ['https://console.example.com/deploy/config/namespace/*']);

  // Duplicate under whitelisted path is NOT intercepted or closed
  const allowed = await f.chrome.tabs.create({
    windowId: 1,
    url: 'https://console.example.com/deploy/config/namespace/prod',
    active: true,
  });
  await new Promise(r => setImmediate(r));
  assert.equal(f.tabs.has(allowed.id), true);

  // Also check query/subpath under the same whitelisted namespace path
  const sub1 = await f.chrome.tabs.create({
    windowId: 1,
    url: 'https://console.example.com/deploy/config/namespace/boe/detail?env=1',
    active: false,
    openerTabId: 1,
  });
  const sub2 = await f.chrome.tabs.create({
    windowId: 1,
    url: 'https://console.example.com/deploy/config/namespace/boe/detail?env=1',
    active: true,
  });
  await new Promise(r => setImmediate(r));
  assert.equal(f.tabs.has(sub1.id), true);
  assert.equal(f.tabs.has(sub2.id), true);

  // Stock dup-count ignores all tabs matching the wildcard path rule
  const cntBefore = await f.send({ type: 'dup-count', windowId: 1 });
  assert.equal(cntBefore.count, 0);

  // Duplicate on a different path of the SAME host IS still intercepted and closed
  const blocked = await f.chrome.tabs.create({
    windowId: 1,
    url: 'https://console.example.com/deploy/config/other',
    active: true,
  });
  await new Promise(r => setImmediate(r));
  assert.equal(f.tabs.has(blocked.id), false);

  // Removing the rule restores stock duplicate detection and interception
  const rm = await f.send({
    type: 'dup-whitelist-remove',
    url: 'https://console.example.com/deploy/config/namespace/*',
  });
  assert.equal(rm.ok, true);
  assert.deepEqual(rm.whitelist, []);

  const cntAfter = await f.send({ type: 'dup-count', windowId: 1 });
  assert.equal(cntAfter.count, 2);

  const interceptedAfterRemove = await f.chrome.tabs.create({
    windowId: 1,
    url: 'https://console.example.com/deploy/config/namespace/prod',
    active: true,
  });
  await new Promise(r => setImmediate(r));
  assert.equal(f.tabs.has(interceptedAfterRemove.id), false);
});

test('scheme-less wildcard, host wildcard, regex literal, regex: prefix and raw regex match accurately', async () => {
  const f = fixture([], []);

  // 1) Scheme-less path wildcard matches http and https
  await f.send({ type: 'dup-whitelist-add', url: 'console.example.com/deploy/config/namespace/*' });
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/ns1'), true);
  assert.equal(checkWhitelist(f, 'http://console.example.com/deploy/config/namespace/ns1'), true);
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/other'), false);

  // 2) Host wildcard must not match path spoofing on another domain
  await f.send({ type: 'dup-whitelist-remove', url: 'console.example.com/deploy/config/namespace/*' });
  await f.send({ type: 'dup-whitelist-add', url: '*.example.com/deploy/*' });
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config'), true);
  assert.equal(checkWhitelist(f, 'https://evil.com/x.example.com/deploy/config'), false);

  // 3) Slash regex literal preserves case & flags, ignores g/y statefulness
  await f.send({ type: 'dup-whitelist-remove', url: '*.example.com/deploy/*' });
  const litAdd = await f.send({ type: 'dup-whitelist-add', url: '/deploy\\/config\\/(Namespace|Env)\\/\\d+/ig' });
  assert.equal(litAdd.ok, true);
  assert.equal(litAdd.ruleType, 'regex');
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/42'), true);
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/42'), true);
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/abc'), false);

  // 4) regex: prefix and raw regex (e.g. .*)
  await f.send({ type: 'dup-whitelist-remove', url: '/deploy\\/config\\/(Namespace|Env)\\/\\d+/ig' });
  const preAdd = await f.send({ type: 'dup-whitelist-add', url: 'regex:^https://console\\.example\\.com/deploy/config/namespace/.*' });
  assert.equal(preAdd.ok, true);
  assert.equal(preAdd.ruleType, 'regex');
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/abc'), true);

  await f.send({ type: 'dup-whitelist-remove', url: preAdd.rule });
  const rawAdd = await f.send({ type: 'dup-whitelist-add', url: 'https://console.example.com/deploy/config/namespace/.*' });
  assert.equal(rawAdd.ok, true);
  assert.equal(rawAdd.ruleType, 'regex');
  assert.equal(checkWhitelist(f, 'https://console.example.com/deploy/config/namespace/xyz'), true);

  // 5) Invalid regex is rejected without mutating saved whitelist
  const beforeInvalid = [...f.stores.sync.settings.dedupWhitelist];
  const bad1 = await f.send({ type: 'dup-whitelist-add', url: '/[unclosed/' });
  const bad2 = await f.send({ type: 'dup-whitelist-add', url: 'regex:(unclosed' });
  const bad3 = await f.send({ type: 'dup-whitelist-add', url: '   ' });
  assert.equal(bad1.ok, false);
  assert.equal(bad2.ok, false);
  assert.equal(bad3.ok, false);
  assert.deepEqual(f.stores.sync.settings.dedupWhitelist, beforeInvalid);

  // 6) Wikipedia URL with parentheses is treated as exact URL, not regex
  const wikiAdd = await f.send({ type: 'dup-whitelist-add', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
  assert.equal(wikiAdd.ok, true);
  assert.equal(wikiAdd.ruleType, 'url');
  assert.equal(checkWhitelist(f, 'https://en.wikipedia.org/wiki/Foo_(bar)'), true);
  assert.equal(checkWhitelist(f, 'https://en.wikipedia.org/wiki/Other'), false);
});

test('formatWhitelistLabel preserves path wildcards and regex rules instead of collapsing to host only', () => {
  const formatWhitelistLabel = loadFormatWhitelistLabel();
  assert.equal(formatWhitelistLabel('github.com'), 'github.com');
  assert.equal(formatWhitelistLabel('https://www.youtube.com/'), 'youtube.com');
  assert.equal(
    formatWhitelistLabel('https://console.example.com/deploy/config/namespace/*'),
    'console.example.com/deploy/config/namespace/*',
  );
  assert.equal(
    formatWhitelistLabel('/deploy\\/config\\/namespace\\/.*/i'),
    '/deploy\\/config\\/namespace\\/.*/i',
  );
  assert.equal(
    formatWhitelistLabel('regex:^https://console\\.example\\.com/'),
    'regex:^https://console\\.example\\.com/',
  );
});

test('dup-whitelist-test evaluates candidate or saved rules against currently open HTTP tabs', async () => {
  const f = fixture([
    tab(1, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/ns-alpha', title: 'Config Alpha' }),
    tab(2, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/ns-beta?env=boe', title: 'Config Beta' }),
    tab(3, { groupId: -1, url: 'https://console.example.com/deploy/config/other', title: 'Config Other' }),
    tab(4, { groupId: -1, url: 'https://github.com/jackerjay/tabloom', title: 'GitHub' }),
    tab(5, { groupId: -1, url: 'chrome://settings/', title: 'Settings' }),
  ], []);

  // 1) Empty input when no rules saved returns clear validation error
  const emptyRes = await f.send({ type: 'dup-whitelist-test', rule: '' });
  assert.equal(emptyRes.ok, false);

  // 2) Invalid regex test is rejected cleanly
  const badRes = await f.send({ type: 'dup-whitelist-test', rule: '/[unclosed/' });
  assert.equal(badRes.ok, false);

  // 3) Single rule dry-run against currently open HTTP tabs (ignores chrome:// internal pages)
  const singleRes = await f.send({
    type: 'dup-whitelist-test',
    rule: 'https://console.example.com/deploy/config/namespace/*',
  });
  assert.equal(singleRes.ok, true);
  assert.equal(singleRes.mode, 'single');
  assert.equal(singleRes.totalTabs, 4);
  assert.equal(singleRes.matchedCount, 2);
  assert.deepEqual(singleRes.matches.map(m => m.id), [1, 2]);
  assert.deepEqual(singleRes.matches[0].matchedRules, ['https://console.example.com/deploy/config/namespace/*']);

  // 4) Empty rule tests all saved rules and reports matchedRules per tab
  await f.send({ type: 'dup-whitelist-add', url: 'https://console.example.com/deploy/config/namespace/*' });
  await f.send({ type: 'dup-whitelist-add', url: 'github.com' });
  const allRes = await f.send({ type: 'dup-whitelist-test', rule: '' });
  assert.equal(allRes.ok, true);
  assert.equal(allRes.mode, 'all');
  assert.equal(allRes.ruleCount, 2);
  assert.equal(allRes.totalTabs, 4);
  assert.equal(allRes.matchedCount, 3);
  assert.deepEqual(allRes.matches.map(m => ({ id: m.id, rules: m.matchedRules })), [
    { id: 1, rules: ['https://console.example.com/deploy/config/namespace/*'] },
    { id: 2, rules: ['https://console.example.com/deploy/config/namespace/*'] },
    { id: 4, rules: ['github.com'] },
  ]);
});

test('dup-whitelist-suggest recommends path-level wildcards, refines overly broad domain rules, and never whitelists doc hubs', async () => {
  const f = fixture([
    tab(1, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.rule_config', title: 'Promo rule_config' }),
    tab(2, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api', title: 'Promo service_api' }),
    tab(3, { groupId: -1, url: 'https://docs.google.com/document/d/doxcn1', title: 'Cloud Doc A' }),
    tab(4, { groupId: -1, url: 'https://docs.google.com/document/d/doxcn2', title: 'Cloud Doc B' }),
  ], []);

  // 1) Recommends https://console.example.com/deploy/config/* and skips docs.google.com
  const sug1 = await f.send({ type: 'dup-whitelist-suggest', useAi: false });
  assert.equal(sug1.ok, true);
  assert.ok(sug1.suggestions.some(s => s.rule === 'https://console.example.com/deploy/config/*' && s.kind === 'add' && s.matchedCount === 2));
  assert.equal(sug1.suggestions.some(s => /docs\.google\.com|notion\.so/i.test(s.rule)), false);

  // 2) If user has an overly broad host rule "console.example.com", recommends refining it to path wildcard
  await f.send({ type: 'dup-whitelist-add', url: 'console.example.com' });
  const sug2 = await f.send({ type: 'dup-whitelist-suggest', useAi: false });
  const refine = sug2.suggestions.find(s => s.kind === 'refine' && s.replaces === 'console.example.com');
  assert.ok(refine, 'should recommend refining broad host rule console.example.com');
  assert.equal(refine.rule, 'https://console.example.com/deploy/config/*');

  // 3) Applying refine suggestion atomically replaces broad rule with path wildcard
  const applied = await f.send({
    type: 'dup-whitelist-apply-suggestion',
    rule: refine.rule,
    replaces: refine.replaces,
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.whitelist, ['https://console.example.com/deploy/config/*']);
});

test('aggregation-rule-suggest extracts live page content snippets and applies suggested rules atomically', async () => {
  const f = fixture([
    tab(11, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/100?workspaceId=903702&site=eu-west&utm_source=msg', title: '发布详情' }),
    tab(12, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/200?workspaceId=903702&site=eu-west&utm_source=copy', title: '发布详情' }),
    tab(13, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/300?workspaceId=555888&site=us-east', title: '发布详情' }),
  ], []);

  // Mock chrome.scripting.executeScript to verify live page snippet extraction feeds suggestion & metadata cache
  let extractCalls = 0;
  f.chrome.scripting = {
    executeScript: async ({ target }) => {
      extractCalls += 1;
      const texts = {
        11: '欧洲区 eu-west Creator Promo发布记录',
        12: '欧洲区 eu-west Creator Promo变更审批',
        13: '美区 us-east 优惠券线上发布流水线',
      };
      return [{ result: { originalTitle: '发布详情', snippet: texts[target.tabId] || '' } }];
    },
  };

  const sug = await f.send({ type: 'aggregation-rule-suggest', useAi: false });
  assert.equal(sug.ok, true);
  assert.ok(extractCalls >= 3, 'aggregation-rule-suggest must extract live page content snippets for uncached tabs');
  assert.ok(sug.suggestions.length >= 1);
  const first = sug.suggestions[0];
  assert.ok(first.rule.queryKeys.includes('workspaceId'));
  assert.ok(first.rule.queryKeys.includes('site'));
  assert.equal(first.distinctKeysCount, 2);
  assert.match(first.reason, /正文内容|参数/);

  // Apply suggested rule via aggregation-rule-apply-suggestion
  const applied = await f.send({
    type: 'aggregation-rule-apply-suggestion',
    rule: first.rule,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.rules.length, 1);

  const listed = await f.send({ type: 'aggregation-rule-list' });
  assert.equal(listed.rules.length, 1);
  assert.deepEqual(listed.rules[0].queryKeys, first.rule.queryKeys);
});

test('batch one-click apply-all and iterative rule-optimization-hints stay synced as new tabs open', async () => {
  const f = fixture([
    tab(21, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/100?workspaceId=903702&site=eu-west', title: 'EU 1' }),
    tab(22, { groupId: -1, url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/200?workspaceId=111222&site=us-east', title: 'US 1' }),
    tab(23, { groupId: -1, url: 'https://console.cloud.example.net/project/cluster-a', title: 'Cluster A' }),
    tab(24, { groupId: -1, url: 'https://console.cloud.example.net/project/cluster-b', title: 'Cluster B' }),
  ], []);

  // Pre-seed overly broad host whitelist + partial aggregation rule (workspaceId only, missing site)
  await f.send({ type: 'dup-whitelist-add', url: 'console.example.com' });
  await f.send({
    type: 'aggregation-rule-add',
    pattern: 'https://console.example.com/deploy/config/*',
    pathDepth: 4,
    queryKeys: 'workspaceId',
  });

  // Hints detect pending optimization opportunities across newly opened tabs without invoking AI
  const hintsBefore = await f.send({ type: 'rule-optimization-hints' });
  assert.equal(hintsBefore.ok, true);
  assert.ok(hintsBefore.whitelistCount >= 1, 'should flag pending whitelist suggestions');
  assert.ok(hintsBefore.aggregationCount >= 1, 'should flag pending aggregation overlay suggestion (+site)');

  // Batch apply whitelist suggestions atomically
  const wlSug = await f.send({ type: 'dup-whitelist-suggest', useAi: false });
  const wlBatch = await f.send({ type: 'dup-whitelist-apply-all', items: wlSug.suggestions });
  assert.equal(wlBatch.ok, true);
  assert.equal(wlBatch.appliedCount, wlSug.suggestions.length);
  assert.equal(wlBatch.whitelist.includes('console.example.com'), false, 'broad host rule must be atomically replaced');

  // Batch apply aggregation overlay suggestions atomically (preserves workspaceId and adds site)
  const aggSug = await f.send({ type: 'aggregation-rule-suggest', useAi: false });
  assert.equal(aggSug.suggestions[0]?.kind, 'refine');
  assert.deepEqual(aggSug.suggestions[0]?.rule?.queryKeys, ['workspaceId', 'site']);
  const aggBatch = await f.send({ type: 'aggregation-rule-apply-all', items: aggSug.suggestions });
  assert.equal(aggBatch.ok, true);
  assert.equal(aggBatch.appliedCount, aggSug.suggestions.length);
  assert.deepEqual(aggBatch.rules[0].queryKeys, ['workspaceId', 'site']);

  // Hints drop cleanly to 0 once all iterative optimizations are applied
  const hintsAfter = await f.send({ type: 'rule-optimization-hints' });
  assert.equal(hintsAfter.whitelistCount, 0);
  assert.equal(hintsAfter.aggregationCount, 0);
  assert.equal(hintsAfter.totalCount, 0);
});
