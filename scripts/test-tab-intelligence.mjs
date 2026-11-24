#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AnalysisCache } from '../server/analysis-cache.mjs';
import { fixture, tab as fixtureTab } from './lifecycle-fixture.mjs';
import {
  auditGroupAggregation,
  buildAggregationRuleSuggestions,
  buildBatchPrefixClusters,
  buildWhitelistSuggestions,
  clusterTabsByContentTheme,
  consolidateAndAuditGroups,
  distillGroupProfiles,
  evaluateAggregationRuleAgainstTabs,
  extractMeaningfulQueryParams,
  extractSystemTokens,
  extractUrlProfile,
  inferTabContentTopic,
  isGenericDomainGroupName,
  normalizeAggregationRules,
  parseAggregationRule,
  resolveTabAggregationIdentity,
  suggestLabelForTabs,
  testAggregationRuleAgainstTabs,
} from '../server/tab-intelligence.mjs';

const sampleTabs = [
  {
    id: 101,
    title: 'ConfigSys · shop.promo.service_api',
    url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api?region=eu',
    groupId: 10,
    groupName: 'example.com',
    discarded: true,
    cachedSummary: 'ConfigSys V3 命名空间 shop.promo.service_api 配置管理，促销后端接口开关',
  },
  {
    id: 102,
    title: 'ConfigSys · shop.promo.rule_config',
    url: 'https://console.example.com/deploy/config/namespace/shop.promo.rule_config?env=prod',
    groupId: 10,
    groupName: 'example.com',
    discarded: true,
    cachedSummary: 'ConfigSys shop.promo.rule_config prod 命名空间配置与发布历史',
  },
  {
    id: 103,
    title: 'EU Creator Promo ConfigSys发布中',
    url: 'https://console.example.com/deploy/config/release/98765432',
    groupId: 11,
    groupName: 'Deploy Release',
    discarded: false,
    snippet: 'Deploy Release：EU Creator Promo ConfigSys 灰度发布中，关联 namespace shop.promo.rule_config',
  },
  {
    id: 104,
    title: 'Creator Promo ConfigSys发布详情',
    url: 'https://console.example.com/deploy/config/detail/445566',
    groupId: 12,
    groupName: 'Config Console',
    discarded: false,
    snippet: 'ConfigSys 促销周期限制配置发布详情页面，检查 diff 与审批状态',
  },
  {
    id: 105,
    title: 'AI Assistant Tasks',
    url: 'https://ai.example.com/workspace/tasks/99',
    groupId: 10,
    groupName: 'example.com',
    discarded: true,
    cachedSummary: 'AI Smart Assistant任务执行工作台',
  },
  {
    id: 106,
    title: 'Unrelated Design Doc A',
    url: 'https://docs.google.com/document/d/AbCdEfGh123456',
    groupId: 20,
    groupName: '方案文档',
    snippet: 'Pipeline Studio Workflow 架构设计与研发排期',
  },
];

function loadServerHelpers() {
  const sourceURL = new URL('../server/server.mjs', import.meta.url);
  const source = readFileSync(sourceURL, 'utf8');
  const offlineSource = source.slice(0, source.indexOf('/* ---------------- HTTP 服务'))
    .replace(/^import\s+(?:[\s\S]*?from\s+)?['"][^'"]+['"];?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
  class NoopAcp { start() {} initialize() {} prompt() { return '{}'; } close() {} }
  const ctx = vm.createContext({
    URL, AbortController, createHash, AnalysisCache, AcpClient: NoopAcp,
    auditGroupAggregation, buildBatchPrefixClusters, clusterTabsByContentTheme, consolidateAndAuditGroups,
    distillGroupProfiles, extractSystemTokens, extractUrlProfile, inferTabContentTopic, isGenericDomainGroupName,
    normalizeAggregationRules, resolveTabAggregationIdentity, suggestLabelForTabs,
    path, os, fileURLToPath, setTimeout, clearTimeout,
    console: { log() {}, error() {} },
    process: { env: {}, pid: process.pid },
    existsSync: () => false, readFileSync: () => '', writeFileSync() {},
    fetch: async () => { throw new Error('no network'); },
  });
  vm.runInContext(`${offlineSource}\nglobalThis.api = { buildMessages, heuristicGroups, organize };`, ctx);
  return ctx.api;
}

test('extractUrlProfile identifies config prefixes and separates doc hubs', () => {
  const cfg = extractUrlProfile(sampleTabs[0].url);
  assert.equal(cfg.host, 'console.example.com');
  assert.equal(cfg.urlPrefix, 'console.example.com/deploy/config');
  assert.equal(cfg.isConfigSystem, true);
  assert.equal(cfg.isDocHub, false);

  const gdoc = extractUrlProfile(sampleTabs[5].url);
  assert.equal(gdoc.isDocHub, true);
  assert.equal(gdoc.isConfigSystem, false);
});

test('distillGroupProfiles produces rich prefix/keyword descriptions', () => {
  const groups = [
    { id: 10, name: 'example.com', tabIds: [101, 102, 105] },
    { id: 12, name: 'Config Console', tabIds: [104] },
  ];
  const distilled = distillGroupProfiles(groups, sampleTabs);
  const exampleDomainGroup = distilled.find(g => g.name === 'example.com');
  assert.equal(exampleDomainGroup.genericDomain, true);
  assert.equal(exampleDomainGroup.tabCount, 3);
  assert.ok(exampleDomainGroup.topPrefixes.some(p => p.prefix === 'console.example.com/deploy/config' && p.count === 2));
  assert.match(exampleDomainGroup.description, /console\.example\.com\/deploy\/config\(2\)/);
  assert.ok(exampleDomainGroup.keywords.some(k => /ConfigSys|shop\.promo/i.test(k)));
});

test('consolidateAndAuditGroups detects and merges split ConfigSys config groups and respects pinned groups', () => {
  const splitGroups = [
    { name: 'example.com', color: 'blue', tabIds: [101, 102, 105] },
    { name: 'Deploy Release', color: 'green', tabIds: [103] },
    { name: 'Config Console', color: 'purple', tabIds: [104] },
  ];
  const result = consolidateAndAuditGroups(splitGroups, sampleTabs);
  assert.ok(result.auditBefore.issues.some(i => i.type === 'split-url-prefix' && i.key === 'console.example.com/deploy/config'));
  assert.ok(result.consolidatedCount > 0);
  const ownersOfCfg = result.groups.filter(g => [101, 102, 103, 104].some(id => g.tabIds.includes(id)));
  assert.equal(ownersOfCfg.length, 1, 'all ConfigSys pages (active + hibernated) consolidate into 1 group');
  assert.ok(!isGenericDomainGroupName(ownersOfCfg[0].name), 'should keep concrete name rather than example.com');

  // Pinned groups retain their own tabs and absorb unpinned matching tabs; two pinned groups never move tabs between them
  const pinnedVsUnpinned = consolidateAndAuditGroups([
    { name: '手动锁定组A', color: 'blue', pinned: true, tabIds: [101, 102] },
    { name: 'Deploy Release', color: 'green', tabIds: [103] },
  ], sampleTabs.slice(0, 3));
  assert.deepEqual(pinnedVsUnpinned.groups.find(g => g.name === '手动锁定组A').tabIds.sort(), [101, 102, 103]);

  const bothPinned = consolidateAndAuditGroups([
    { name: '手动锁定组A', color: 'blue', pinned: true, tabIds: [101, 102] },
    { name: '手动锁定组B', color: 'green', pinned: true, tabIds: [103] },
  ], sampleTabs.slice(0, 3));
  assert.deepEqual(bothPinned.groups.find(g => g.name === '手动锁定组A').tabIds.sort(), [101, 102]);
  assert.deepEqual(bothPinned.groups.find(g => g.name === '手动锁定组B').tabIds.sort(), [103]);
});

test('buildMessages includes distilled anchors, batch prefix clusters, and optional read-only CLI instructions', () => {
  const api = loadServerHelpers();
  const anchors = distillGroupProfiles([{ id: 10, name: 'example.com', tabIds: [101, 102, 105] }], sampleTabs);
  const msgsNoCli = api.buildMessages(sampleTabs.slice(0, 5), {
    mode: 'full',
    context: { existingGroupAnchors: anchors },
  });
  const textNoCli = msgsNoCli.map(m => m.content).join('\n');
  assert.match(textNoCli, /\[泛域名待细化\]/);
  assert.match(textNoCli, /console\.example\.com\/deploy\/config/);
  assert.match(textNoCli, /本批强关联 URL 前缀/);
  assert.match(textNoCli, /不要调用任何工具/);

  const msgsCli = api.buildMessages(sampleTabs.slice(0, 5), {
    mode: 'full',
    cliInspect: { cliScript: '/path/to/tab-cli.mjs', snapshotFile: 'snapshot.json' },
  });
  const textCli = msgsCli.map(m => m.content).join('\n');
  assert.match(textCli, /tab-cli\.mjs" --snapshot snapshot\.json/);
});

test('heuristicGroups fallback does not dump ConfigSys and AIAssist into bare example.com', () => {
  const api = loadServerHelpers();
  const groups = api.heuristicGroups(sampleTabs.slice(0, 5));
  assert.equal(groups.some(g => g.name === 'example.com'), false);
  const cfgOwner = groups.find(g => g.tabIds.includes(101));
  assert.ok(cfgOwner);
  assert.ok([101, 102, 103, 104].every(id => cfgOwner.tabIds.includes(id)));
  assert.equal(cfgOwner.tabIds.includes(105), false);
});

test('tab-cli.mjs supports summary, groups, tabs, tab details, and audit --fix on snapshots', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tabloom-cli-test-'));
  try {
    const snapFile = path.join(dir, 'snapshot.json');
    writeFileSync(snapFile, JSON.stringify({
      updatedAt: '2026-11-19T12:00:00Z',
      windowId: 1,
      tabs: sampleTabs,
      groups: [
        { id: 10, name: 'example.com', color: 'blue', tabIds: [101, 102, 105] },
        { id: 11, name: 'Deploy Release', color: 'green', tabIds: [103] },
        { id: 12, name: 'Config Console', color: 'purple', tabIds: [104] },
        { id: 20, name: '方案文档', color: 'cyan', tabIds: [106] },
      ],
    }));

    const cli = fileURLToPath(new URL('./tab-cli.mjs', import.meta.url));
    const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, '--snapshot', snapFile, ...args, '--json'], { encoding: 'utf8' }));

    const sum = run('summary');
    assert.equal(sum.totalTabs, 6);
    assert.equal(sum.hibernatedTabs, 3);
    assert.equal(sum.aggregationAudit.ok, false);

    const cfgTabs = run('tabs', '--prefix', 'deploy/config');
    assert.equal(cfgTabs.total, 4);

    const detail = run('tab', '103,104');
    assert.equal(detail.tabs.length, 2);
    assert.match(detail.tabs[0].snippet, /EU Creator Promo ConfigSys/);

    const groups = run('groups');
    assert.ok(groups.groups.some(g => g.name === 'example.com' && g.genericDomain));

    const fixed = run('audit', '--fix');
    assert.ok(fixed.consolidated.consolidatedCount > 0);
    const mergedCfg = fixed.consolidated.groups.filter(g => [101, 102, 103, 104].some(id => g.tabIds.includes(id)));
    assert.equal(mergedCfg.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregationRules separate same-path tabs by query params (workspaceId/site) while aggregating same pipeline across path depth', () => {
  const rule = {
    pattern: 'https://console.example.com/deploy/config/*',
    pathDepth: 4,
    queryKeys: ['workspaceId', 'site'],
    label: 'DeployRule',
  };
  const pipelineTabs = [
    {
      id: 201,
      title: 'DeployRule详情 - EU',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/2550844434529248?workspaceId=903702631682&site=eu-west&site=online&site=prod',
    },
    {
      id: 202,
      title: 'ConfigSys配置列表 - EU',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api?workspaceId=903702631682&site=prod&site=eu-west&site=online',
    },
    {
      id: 203,
      title: 'DeployRule详情 - US',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/2550844434529999?workspaceId=555666777&site=us-east&site=prod',
    },
  ];

  const id1 = resolveTabAggregationIdentity(pipelineTabs[0], [rule]);
  const id2 = resolveTabAggregationIdentity(pipelineTabs[1], [rule]);
  const id3 = resolveTabAggregationIdentity(pipelineTabs[2], [rule]);
  assert.equal(id1.matched, true);
  assert.equal(id1.aggregationKey, id2.aggregationKey, 'different path depth under same depth=4 & sorted multi-value query params share identity');
  assert.notEqual(id1.aggregationKey, id3.aggregationKey, 'different workspaceId/site under same namespace yields distinct aggregationKey');
  assert.match(id1.aggregationKey, /workspaceId=903702631682&site=eu-west,online,prod/);

  // Batch clusters preserve two separate clusters rather than fusing distinct pipelines
  const clusters = buildBatchPrefixClusters(pipelineTabs, { aggregationRules: [rule] });
  assert.ok(clusters.some(c => c.kind === 'aggregation-rule' && c.tabIds.includes(201) && c.tabIds.includes(202) && !c.tabIds.includes(203)));

  // Consolidation merges split same-key tabs (201+202) WITHOUT merging different workspaceId (203)
  const splitCandidate = [
    { name: 'EU流水线A', color: 'blue', tabIds: [201] },
    { name: 'EU零散页', color: 'cyan', tabIds: [202] },
    { name: 'US流水线B', color: 'green', tabIds: [203] },
  ];
  const consolidated = consolidateAndAuditGroups(splitCandidate, pipelineTabs, { aggregationRules: [rule] });
  assert.equal(consolidated.groups.length, 2, 'should merge EU pair into 1 group while preserving US pipeline separately');
  assert.equal(consolidated.auditAfter.issueCount, 0);

  // Consolidation also splits an unpinned group that mistakenly mixed distinct rule-keyed pipelines (201+202 vs 203)
  const mixedLump = [
    { name: 'Config Deploy Bundle', color: 'blue', tabIds: [201, 202, 203] },
  ];
  const splitFromLump = consolidateAndAuditGroups(mixedLump, pipelineTabs, { aggregationRules: [rule] });
  assert.ok(splitFromLump.auditBefore.issues.some(i => i.type === 'mixed-aggregation-keys'));
  assert.equal(splitFromLump.groups.length, 2, 'must split mixed rule keys into 2 separate pipeline groups');
  assert.deepEqual(splitFromLump.groups.find(g => g.tabIds.includes(201)).tabIds.sort(), [201, 202]);
  assert.deepEqual(splitFromLump.groups.find(g => g.tabIds.includes(203)).tabIds, [203]);
  assert.equal(splitFromLump.auditAfter.issueCount, 0);

  // Shorthand rule syntax & testAggregationRuleAgainstTabs
  const shorthand = parseAggregationRule('https://console.example.com/deploy/config/* | depth=4 | params=workspaceId,site', { strict: true });
  assert.equal(shorthand.ok, true);
  const preview = testAggregationRuleAgainstTabs(shorthand.rule, pipelineTabs);
  assert.equal(preview.matchedCount, 3);
  assert.equal(preview.distinctKeysCount, 2);

  // buildMessages surfaces configured rule keys and distinct identityParams
  const api = loadServerHelpers();
  const msgs = api.buildMessages(pipelineTabs, { aggregationRules: [rule] });
  const text = msgs.map(m => m.content).join('\n');
  assert.match(text, /标签聚合标识层级规则/);
  assert.match(text, /workspaceId=903702631682/);
  assert.match(text, /workspaceId=555666777/);
});

test('extension background RPC manages aggregationRules and previews live tab identity buckets', async () => {
  const f = fixture([
    fixtureTab(1, { url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/100?workspaceId=903702631682&site=eu-west&site=prod' }),
    fixtureTab(2, { url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/200?workspaceId=903702631682&site=prod&site=eu-west' }),
    fixtureTab(3, { url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/300?workspaceId=888999&site=us-east' }),
    fixtureTab(4, { url: 'https://example.com/other' }),
  ], []);

  const added = await f.send({
    type: 'aggregation-rule-add',
    pattern: 'https://console.example.com/deploy/config/*',
    pathDepth: 4,
    queryKeys: 'workspaceId,site',
  });
  assert.equal(added.ok, true);
  assert.equal(added.rules.length, 1);

  // Adding same pattern without trailing wildcard or lowercase queryKeys replaces rule and matches child paths case-insensitively
  const updated = await f.send({
    type: 'aggregation-rule-add',
    pattern: 'https://console.example.com/deploy/config',
    pathDepth: 4,
    queryKeys: 'workspaceid,REGION',
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.rules.length, 1, 'updating pattern parameters replaces existing rule instead of leaving shadowed duplicates');

  const tested = await f.send({ type: 'aggregation-rule-test' });
  assert.equal(tested.ok, true);
  assert.equal(tested.matchedCount, 3);
  assert.equal(tested.distinctKeysCount, 2);
  assert.equal(tested.buckets[0].count, 2);

  const removed = await f.send({ type: 'aggregation-rule-remove', id: updated.rule.id });
  assert.equal(removed.ok, true);
  assert.equal(removed.rules.length, 0);
});

test('tab-cli.mjs supports --rule overrides to compute scoped aggregationKey and distinct pipeline buckets', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tabloom-cli-rule-test-'));
  try {
    const snapFile = path.join(dir, 'snapshot.json');
    writeFileSync(snapFile, JSON.stringify({
      tabs: [
        {
          id: 301,
          title: 'Publish EU 1',
          url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/1?workspaceId=903702631682&site=eu-west&site=prod',
          groupId: 1,
          groupName: 'EU 发布',
        },
        {
          id: 302,
          title: 'Publish US 1',
          url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/2?workspaceId=111222&site=us-east&site=prod',
          groupId: 2,
          groupName: 'US 发布',
        },
      ],
      groups: [
        { id: 1, name: 'EU 发布', tabIds: [301] },
        { id: 2, name: 'US 发布', tabIds: [302] },
      ],
    }));
    const cli = fileURLToPath(new URL('./tab-cli.mjs', import.meta.url));
    const res = JSON.parse(execFileSync(process.execPath, [
      cli,
      '--snapshot', snapFile,
      '--rule', 'https://console.example.com/deploy/config/*|depth=4|params=workspaceId,site',
      'tabs', '--json',
    ], { encoding: 'utf8' }));
    assert.notEqual(res.tabs[0].aggregationKey, res.tabs[1].aggregationKey);
    const audit = JSON.parse(execFileSync(process.execPath, [
      cli,
      '--snapshot', snapFile,
      '--rule', 'https://console.example.com/deploy/config/*|depth=4|params=workspaceId,site',
      'audit', '--json',
    ], { encoding: 'utf8' }));
    assert.equal(audit.audit.ok, true, 'EU and US pipeline groups should pass audit as distinct scopes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('docs.google.com / notion.so doc bucket is split by content relevance rather than grouped by domain', () => {
  const docHubTabs = [
    { id: 501, title: '【最佳实践】把你的数字员工做成一个可协作的 git 仓库 - Cloud Docs', url: 'https://docs.google.com/document/d/doxcnGitAgent1', snippet: '数字员工与 Agent 协作仓库最佳实践' },
    { id: 502, title: '零信任办公安全方案', url: 'https://docs.google.com/document/d/doxcnSec1', discarded: true, cachedSummary: '零信任办公安全加固合规方案' },
    { id: 503, title: 'PluginHub External Agent Integration：功能、架构与接入方式', url: 'https://docs.google.com/document/d/docPluginHub1', discarded: true },
    { id: 504, title: 'PluginHub Agent CLI Guide', url: 'https://docs.google.com/document/d/docPluginHub2', discarded: true },
    { id: 505, title: 'Cloud Docs Home·营销项目导航', url: 'https://docs.google.com/drive/home', discarded: true },
    { id: 506, title: '商家营销秒杀冲突提示PRD', url: 'https://docs.google.com/document/d/doxcnPromo1', discarded: true },
    { id: 507, title: '多商品视频BMSM凑单PRD', url: 'https://docs.google.com/document/d/doxcnPromo2', discarded: true },
    { id: 508, title: 'Workflow IDE · 智能体工作流引擎 - Cloud Docs', url: 'https://docs.google.com/document/d/docStudio1', discarded: true },
  ];

  // 1. If a generic domain group "docs.google.com" exists, consolidateAndAuditGroups splits it by content relevance
  const consolidated = consolidateAndAuditGroups([
    { name: 'docs.google.com', color: 'red', tabIds: docHubTabs.map(t => t.id) },
  ], docHubTabs);
  assert.equal(consolidated.groups.some(g => /docs\.google\.com|notion\.so|云文档/i.test(g.name)), false, 'must never keep domain/carrier group name');
  const agentGroup = consolidated.groups.find(g => g.tabIds.includes(501));
  const promoGroup = consolidated.groups.find(g => g.tabIds.includes(506));
  const secGroup = consolidated.groups.find(g => g.tabIds.includes(502));
  assert.ok(agentGroup && [501, 503, 504, 508].every(id => agentGroup.tabIds.includes(id)), 'Agent/CLI/Workflow docs cluster together');
  assert.ok(promoGroup && [505, 506, 507].every(id => promoGroup.tabIds.includes(id)), 'Marketing/Flash-sale/BMSM PRD docs cluster together');
  assert.ok(secGroup && secGroup.tabIds.includes(502) && !secGroup.tabIds.includes(506), 'Security doc separated from marketing PRDs');

  // 2. Offline heuristicGroups fallback also groups by content relevance, never docs.google.com
  const api = loadServerHelpers();
  const hGroups = api.heuristicGroups(docHubTabs);
  assert.equal(hGroups.some(g => /docs\.google\.com|notion\.so/i.test(g.name)), false);
  assert.ok(hGroups.length >= 3);
});

test('buildAggregationRuleSuggestions inspects page content and query params while ignoring tracking noise', () => {
  const params = extractMeaningfulQueryParams('https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/10?workspaceId=903702&site=eu-west&spm=abc&utm_source=share&from=copy');
  assert.deepEqual(params, { workspaceId: '903702', site: 'eu-west' });

  const tabs = [
    {
      id: 601,
      title: 'Creator Promo ConfigSys 发布详情',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/100?workspaceId=903702&site=eu-west&from=nav',
      snippet: '欧洲站 eu-west Creator Promo发布状态与变更审批流水线',
    },
    {
      id: 602,
      title: 'Creator Promo ConfigSys 发布详情',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/200?workspaceId=903702&site=eu-west&from=nav',
      snippet: '欧洲站 eu-west Creator Promo配置发布回滚历史与灰发布单',
    },
    {
      id: 603,
      title: '美区Promo Rule Config发布详情',
      url: 'https://console.example.com/deploy/config/namespace/shop.promo.service_api/publish-details/300?workspaceId=111222&site=us-east&from=nav',
      snippet: '北美站 us-east 优惠券与店铺券规则线上生效状态',
    },
  ];

  const sug = buildAggregationRuleSuggestions(tabs, { existingRules: [] });
  assert.ok(sug.length >= 1, 'should suggest aggregation rule from shared path + divergent params & page content');
  const first = sug[0];
  assert.equal(first.kind, 'add');
  assert.ok(first.rule.queryKeys.includes('workspaceId'));
  assert.ok(first.rule.queryKeys.includes('site'));
  assert.equal(first.rule.queryKeys.includes('from'), false);
  assert.equal(first.matchedCount, 3);
  assert.equal(first.distinctKeysCount, 2);

  const evalRes = evaluateAggregationRuleAgainstTabs(first.rule, tabs);
  assert.equal(evalRes.ok, true);
  assert.equal(evalRes.distinctKeysCount, 2);

  // If user already has a rule with workspaceId only, and newly opened tabs introduce site=EU/US variance,
  // overlay optimization preserves workspaceId and adds site instead of overwriting!
  const overlaySug = buildAggregationRuleSuggestions(tabs, {
    existingRules: [{ id: 'deploy-ws-only', pattern: 'https://console.example.com/deploy/config/*', pathDepth: 4, queryKeys: ['workspaceId'] }],
  });
  assert.equal(overlaySug[0]?.kind, 'refine');
  assert.equal(overlaySug[0]?.replaces, 'deploy-ws-only');
  assert.deepEqual(overlaySug[0]?.rule?.queryKeys, ['workspaceId', 'site']);
  assert.ok(overlaySug[0]?.changes?.some(c => c.includes('+site')));

  // When newly opened sibling subpaths expand beyond two existing narrow rules, suggest merging them into the parent module
  const narrowWlSug = buildWhitelistSuggestions([
    { id: 701, url: 'https://console.example.com/deploy/namespace/shop.a', title: 'ConfigSys A' },
    { id: 702, url: 'https://console.example.com/deploy/namespace/shop.b', title: 'ConfigSys B' },
    { id: 703, url: 'https://console.example.com/deploy/namespace/shop.c', title: 'ConfigSys C' },
  ], {
    existingWhitelist: [
      'https://console.example.com/deploy/namespace/shop.a/*',
      'https://console.example.com/deploy/namespace/shop.b/*',
    ],
  });
  const consolidated = narrowWlSug.find(s => s.rule === 'https://console.example.com/deploy/namespace/*' && s.kind === 'refine');
  assert.ok(consolidated, 'should recommend consolidating fragmented narrow subpath rules when sibling tabs open');
  assert.equal(consolidated.replacesList?.length, 2);
});
