#!/usr/bin/env node
/**
 * TabLoom CLI — 只读检查标签页详情、页面正文摘要、分组蒸馏画像与聚合健康度，
 * 并可从本地/Agent 上下文触发按完整信息重新整理。
 *
 * 用法:
 *   node scripts/tab-cli.mjs summary [--json] [--snapshot path]
 *   node scripts/tab-cli.mjs groups [--json]
 *   node scripts/tab-cli.mjs tabs [--group 名称] [--host 域名] [--prefix 前缀] [--search 关键词] [--hibernated] [--ungrouped] [--limit 50] [--json]
 *   node scripts/tab-cli.mjs tab <id[,id2,...]> [--json]
 *   node scripts/tab-cli.mjs audit [--fix] [--json]
 *   node scripts/tab-cli.mjs reorganize [--mode full|incremental] [--json]
 */

import { readFileSync } from 'node:fs';
import {
  auditGroupAggregation,
  buildBatchPrefixClusters,
  consolidateAndAuditGroups,
  distillGroupProfiles,
  extractUrlProfile,
  normalizeAggregationRules,
  resolveTabAggregationIdentity,
} from '../server/tab-intelligence.mjs';

const DEFAULT_SERVER = process.env.TABLOOM_SERVER_URL || 'http://127.0.0.1:8787';

function parseArgs(argv) {
  const opts = {
    _: [],
    json: false,
    fix: false,
    hibernated: false,
    ungrouped: false,
    rules: [],
    server: DEFAULT_SERVER,
    snapshot: process.env.TABLOOM_SNAPSHOT_FILE || '',
    mode: 'full',
    limit: 80,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fix') opts.fix = true;
    else if (a === '--hibernated') opts.hibernated = true;
    else if (a === '--ungrouped') opts.ungrouped = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--rule' && argv[i + 1]) opts.rules.push(argv[++i]);
    else if ((a === '--snapshot' || a === '--input') && argv[i + 1]) opts.snapshot = argv[++i];
    else if (a === '--server' && argv[i + 1]) opts.server = argv[++i];
    else if (a === '--group' && argv[i + 1]) opts.group = argv[++i];
    else if (a === '--host' && argv[i + 1]) opts.host = argv[++i];
    else if (a === '--prefix' && argv[i + 1]) opts.prefix = argv[++i];
    else if ((a === '--search' || a === '-q') && argv[i + 1]) opts.search = argv[++i];
    else if (a === '--mode' && argv[i + 1]) opts.mode = argv[++i];
    else if (a === '--limit' && argv[i + 1]) opts.limit = Math.max(1, Number(argv[++i]) || 80);
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opts[k] = v;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

async function loadSnapshot(opts) {
  if (opts.snapshot) {
    const raw = readFileSync(opts.snapshot, 'utf8');
    return JSON.parse(raw);
  }
  const base = opts.server.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${base}/snapshot`, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    throw new Error(`无法获取标签页快照（${err?.message || err}）。请先打开浏览器扩展触发一次整理/同步，或传入 --snapshot <file>`);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSnapshot(raw, cliRules = []) {
  const aggregationRules = normalizeAggregationRules([
    ...(Array.isArray(cliRules) ? cliRules : []),
    ...(Array.isArray(raw?.aggregationRules) ? raw.aggregationRules : []),
  ]);
  const tabs = Array.isArray(raw?.tabs) ? raw.tabs.map(t => {
    const prof = t.urlProfile || extractUrlProfile(t.url);
    const idn = aggregationRules.length ? resolveTabAggregationIdentity({ ...t, urlProfile: prof }, aggregationRules) : null;
    return {
      ...t,
      id: Number(t.id),
      urlProfile: prof,
      ...(idn?.matched ? { aggregationKey: idn.aggregationKey, identityParams: idn.paramSummary } : {}),
    };
  }) : [];

  const groupsRaw = Array.isArray(raw?.groups) ? raw.groups : [];
  let groups = groupsRaw.map(g => ({ ...g }));
  if (!groups.length && tabs.some(t => t.groupName)) {
    const byName = new Map();
    for (const t of tabs) {
      const name = String(t.groupName || '').trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, { id: t.groupId ?? name, name, pinned: false, tabIds: [] });
      byName.get(name).tabIds.push(t.id);
    }
    groups = [...byName.values()];
  }
  const groupNameById = new Map(groups.map(g => [g.id, g.name || g.title]));
  for (const t of tabs) {
    if (!t.groupName && t.groupId != null && t.groupId !== -1) {
      t.groupName = groupNameById.get(t.groupId) || '';
    }
  }
  const forceRecompute = cliRules.length > 0;
  const anchors = !forceRecompute && Array.isArray(raw?.distilledGroups)
    ? raw.distilledGroups
    : distillGroupProfiles(groups, tabs, { aggregationRules });
  const audit = (!forceRecompute && raw?.audit) || auditGroupAggregation(
    groups.map(g => ({
      name: g.name || g.title,
      color: g.color,
      pinned: g.pinned,
      tabIds: Array.isArray(g.tabIds) ? g.tabIds : tabs.filter(t => t.groupId === g.id).map(t => t.id),
    })),
    tabs,
    { aggregationRules },
  );
  return { ...raw, aggregationRules, tabs, groups, distilledGroups: anchors, audit };
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function cmdSummary(snap, opts) {
  const prefixClusters = buildBatchPrefixClusters(snap.tabs, { aggregationRules: snap.aggregationRules });
  const out = {
    updatedAt: snap.updatedAt || null,
    windowId: snap.windowId ?? null,
    totalTabs: snap.tabs.length,
    hibernatedTabs: snap.tabs.filter(t => t.discarded).length,
    withSnippet: snap.tabs.filter(t => Boolean(t.snippet)).length,
    withCachedSummary: snap.tabs.filter(t => Boolean(t.cachedSummary)).length,
    groupCount: snap.distilledGroups.length,
    topPrefixClusters: prefixClusters.slice(0, 8),
    aggregationAudit: {
      ok: snap.audit.ok,
      issueCount: snap.audit.issueCount,
      issues: snap.audit.issues.slice(0, 12),
    },
  };
  if (opts.json) return printJson(out);

  console.log(`TabLoom 快照摘要 · 共 ${out.totalTabs} 个标签页（休眠 ${out.hibernatedTabs}，含正文 ${out.withSnippet}，含缓存摘要 ${out.withCachedSummary}）· ${out.groupCount} 个分组`);
  if (prefixClusters.length) {
    console.log('\n主要 URL 前缀 / 系统聚合：');
    for (const c of prefixClusters.slice(0, 8)) {
      console.log(`  - ${c.key} (${c.count}页): ids=[${c.tabIds.join(',')}] · ${c.sampleTitles.join(' | ')}`);
    }
  }
  console.log(`\n聚合检查：${out.aggregationAudit.ok ? '正常（无拆分组或泛域名杂烩）' : `发现 ${out.aggregationAudit.issueCount} 处聚合问题`}`);
  for (const iss of out.aggregationAudit.issues.slice(0, 10)) {
    console.log(`  - [${iss.severity}] ${iss.type}: ${iss.key} -> groups=${JSON.stringify(iss.groups)}`);
  }
}

function cmdGroups(snap, opts) {
  if (opts.json) return printJson({ groups: snap.distilledGroups });
  if (!snap.distilledGroups.length) {
    console.log('当前没有已命名的标签组。');
    return;
  }
  for (const g of snap.distilledGroups) {
    const tag = g.pinned ? '[固定]' : g.genericDomain ? '[泛域名]' : '[项目]';
    console.log(`\n${tag} ${g.name} (${g.tabCount}页)`);
    console.log(`  描述: ${g.description}`);
    if (g.topPrefixes?.length) {
      console.log(`  主链接前缀: ${g.topPrefixes.map(p => `${p.prefix}(${p.count})`).join(', ')}`);
    }
    if (g.keywords?.length) {
      console.log(`  关键词: ${g.keywords.join(', ')}`);
    }
    for (const s of g.samples || []) {
      console.log(`  - #${s.id} ${s.title}${s.urlPrefix ? ` [${s.urlPrefix}]` : ''}${s.summary ? ` :: ${s.summary}` : ''}`);
    }
  }
}

function cmdTabs(snap, opts) {
  let list = snap.tabs;
  if (opts.group) {
    const gq = String(opts.group).toLowerCase();
    list = list.filter(t => String(t.groupName || '').toLowerCase().includes(gq));
  }
  if (opts.host) {
    const hq = String(opts.host).toLowerCase();
    list = list.filter(t => String(t.urlProfile?.host || '').toLowerCase().includes(hq));
  }
  if (opts.prefix) {
    const pq = String(opts.prefix).toLowerCase();
    list = list.filter(t => String(t.urlProfile?.urlPrefix || '').toLowerCase().includes(pq) || String(t.url || '').toLowerCase().includes(pq));
  }
  if (opts.hibernated) list = list.filter(t => Boolean(t.discarded));
  if (opts.ungrouped) list = list.filter(t => !t.groupName && (t.groupId == null || t.groupId === -1));
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    list = list.filter(t => `${t.title || ''} ${t.manualTitle || ''} ${t.url || ''} ${t.snippet || ''} ${t.cachedSummary || ''} ${t.groupName || ''}`.toLowerCase().includes(q));
  }

  const sliced = list.slice(0, opts.limit).map(t => ({
    id: t.id,
    title: t.manualTitle || t.title || '',
    group: t.groupName || '未分组',
    host: t.urlProfile?.host || '',
    urlPrefix: t.urlProfile?.urlPrefix || '',
    ...(t.aggregationKey ? { aggregationKey: t.aggregationKey } : {}),
    ...(t.identityParams ? { identityParams: t.identityParams } : {}),
    url: t.url || '',
    discarded: Boolean(t.discarded),
    hasSnippet: Boolean(t.snippet),
    summary: t.cachedSummary || (t.snippet ? String(t.snippet).slice(0, 120) : ''),
  }));

  if (opts.json) return printJson({ total: list.length, shown: sliced.length, tabs: sliced });
  console.log(`共匹配 ${list.length} 个标签页（显示前 ${sliced.length} 条）：`);
  for (const t of sliced) {
    const state = t.discarded ? ' [休眠]' : t.hasSnippet ? ' [含正文]' : '';
    console.log(`#${t.id}${state} [${t.group}] ${t.title}`);
    console.log(`   ${t.aggregationKey ? `key=${t.aggregationKey} · ` : t.urlPrefix ? `prefix=${t.urlPrefix} · ` : ''}${t.url}`);
    if (t.summary) console.log(`   摘要: ${t.summary}`);
  }
}

function cmdTab(snap, idArg, opts) {
  const wantIds = String(idArg || '').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
  if (!wantIds.length) {
    console.error('请提供标签 ID，例如：node scripts/tab-cli.mjs tab 101,102');
    process.exitCode = 1;
    return;
  }
  const byId = new Map(snap.tabs.map(t => [t.id, t]));
  const items = wantIds.map(id => byId.get(id)).filter(Boolean);
  if (opts.json) return printJson({ tabs: items, missingIds: wantIds.filter(id => !byId.has(id)) });
  if (!items.length) {
    console.error(`未找到 ID 为 ${wantIds.join(',')} 的标签页`);
    process.exitCode = 1;
    return;
  }
  for (const t of items) {
    console.log(`\n=== Tab #${t.id} ===`);
    console.log(`标题: ${t.title || ''}${t.manualTitle ? ` (手动重命名: ${t.manualTitle})` : ''}`);
    if (t.originalTitle && t.originalTitle !== t.title) console.log(`原标题: ${t.originalTitle}`);
    console.log(`分组: ${t.groupName || '未分组'} | 状态: ${t.discarded ? '已休眠' : '活跃/可读取'} | 固定: ${t.pinned ? '是' : '否'}`);
    console.log(`URL: ${t.url || ''}`);
    console.log(`前缀聚合: ${t.urlProfile?.urlPrefix || '-'} | 系统配置页: ${t.urlProfile?.isConfigSystem ? '是' : '否'}`);
    if (t.aggregationKey) console.log(`标识层级 Key: ${t.aggregationKey}${t.identityParams ? ` (${t.identityParams})` : ''}`);
    if (t.bookmarkPath) console.log(`书签路径: ${t.bookmarkPath}`);
    if (t.cachedSummary) console.log(`缓存摘要: ${t.cachedSummary}`);
    if (t.snippet) console.log(`完整正文内容:\n${t.snippet}`);
    else console.log('完整正文内容: (暂无实时正文，页面可能已休眠或受限)');
  }
}

function cmdAudit(snap, opts) {
  const inputGroups = snap.groups.map(g => ({
    name: g.name || g.title,
    color: g.color,
    pinned: g.pinned,
    tabIds: Array.isArray(g.tabIds) ? g.tabIds : snap.tabs.filter(t => t.groupId === g.id).map(t => t.id),
  }));
  const consolidated = opts.fix ? consolidateAndAuditGroups(inputGroups, snap.tabs, { aggregationRules: snap.aggregationRules }) : null;
  const result = opts.fix
    ? { audit: snap.audit, consolidated }
    : { audit: snap.audit };
  if (opts.json) return printJson(result);

  console.log(`聚合检查结果：${snap.audit.ok ? 'PASS（无聚合异常）' : `WARN（发现 ${snap.audit.issueCount} 处聚合问题）`}`);
  for (const iss of snap.audit.issues) {
    console.log(`- [${iss.severity}] ${iss.type}: ${iss.key}`);
    if (iss.groups) console.log(`  涉及分组: ${iss.groups.join(' / ')}`);
    if (iss.suggestedName) console.log(`  建议重命名: ${iss.suggestedName}`);
  }
  if (consolidated) {
    console.log(`\n模拟合并修复：共调整 ${consolidated.consolidatedCount} 处，修复后剩余问题 ${consolidated.auditAfter.issueCount} 处`);
    for (const g of consolidated.groups) {
      console.log(`  - ${g.name} (${g.tabIds.length}页): [${g.tabIds.join(',')}]`);
    }
  }
}

async function cmdReorganize(snap, opts) {
  const base = opts.server.replace(/\/+$/, '');
  const payload = {
    tabs: snap.tabs.map(t => ({
      id: t.id,
      title: t.manualTitle || t.title,
      url: t.url,
      bookmarkPath: t.bookmarkPath || null,
      snippet: t.snippet || null,
      ...(t.cachedSummary ? { cachedSummary: t.cachedSummary } : {}),
      ...(t.urlProfile?.urlPrefix ? { urlPrefix: t.urlProfile.urlPrefix } : {}),
      ...(t.discarded ? { discarded: true } : {}),
    })),
    existingGroups: snap.distilledGroups.filter(g => g.pinned || !g.genericDomain).map(g => g.name),
    aggregationRules: (snap.aggregationRules || []).map(({ regex: _r, ...rest }) => rest),
    context: {
      existingGroupAnchors: snap.distilledGroups,
    },
    mode: opts.mode === 'incremental' ? 'incremental' : 'full',
    language: 'zh',
  };
  const res = await fetch(`${base}/organize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  if (opts.json) return printJson(data);
  console.log(`重新整理完成（${data.source}, ${data.backend || 'heuristic'}, ${data.elapsedMs}ms），共 ${data.groups.length} 组：`);
  for (const g of data.groups) {
    console.log(`- ${g.name} (${g.tabIds.length}页): [${g.tabIds.join(',')}]`);
  }
  if (data.aggregationAudit) {
    console.log(`\n聚合检查：自动合并 ${data.aggregationAudit.consolidatedCount} 处，剩余异常 ${data.aggregationAudit.remainingIssues?.length || 0} 处`);
  }
}

function showHelp() {
  console.log(`TabLoom CLI — 标签页内容详情 / 分组蒸馏 / 聚合检查工具

用法:
  node scripts/tab-cli.mjs summary [--json]
  node scripts/tab-cli.mjs groups [--json]
  node scripts/tab-cli.mjs tabs [--group G] [--host H] [--prefix P] [--search Q] [--hibernated] [--ungrouped] [--json]
  node scripts/tab-cli.mjs tab <id[,id2,...]> [--json]
  node scripts/tab-cli.mjs audit [--fix] [--json]
  node scripts/tab-cli.mjs reorganize [--mode full|incremental] [--json]

公共选项:
  --snapshot <file>   从指定快照 JSON 读取（Agent 只读沙箱模式推荐）
  --rule <spec>       临时指定聚合标识层级规则（可多次传，如 "https://host/path/*|depth=4|params=workspaceId,region"）
  --server <url>      本地服务地址（默认 ${DEFAULT_SERVER}）
  --json              输出结构化 JSON`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'summary';
  if (opts.help || cmd === 'help') {
    showHelp();
    return;
  }
  const raw = await loadSnapshot(opts);
  const snap = normalizeSnapshot(raw, opts.rules);
  if (cmd === 'summary' || cmd === 'overview') return cmdSummary(snap, opts);
  if (cmd === 'groups') return cmdGroups(snap, opts);
  if (cmd === 'tabs' || cmd === 'list') return cmdTabs(snap, opts);
  if (cmd === 'tab' || cmd === 'get') return cmdTab(snap, opts._[1], opts);
  if (cmd === 'audit' || cmd === 'check') return cmdAudit(snap, opts);
  if (cmd === 'reorganize') return await cmdReorganize(snap, opts);
  throw new Error(`未知命令: ${cmd}（运行 --help 查看帮助）`);
}

main().catch(err => {
  console.error(`[tab-cli] ${err?.message || err}`);
  process.exit(1);
});
