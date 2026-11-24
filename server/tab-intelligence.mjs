// Shared tab/group URL-profile extraction, group distillation, heuristic naming,
// and aggregation auditing/consolidation (pure JS, zero external dependencies).

const COLORS = ['blue', 'cyan', 'green', 'yellow', 'orange', 'pink', 'purple', 'grey'];
const DOC_HUB_HOSTS = new Set([
  'coda.io', 'quip.com', 'slite.com',
  'docs.google.com', 'drive.google.com', 'notion.so', 'notion.site',
  'yuque.com', 'zhihu.com', 'juejin.cn', 'mp.weixin.qq.com',
  'wikipedia.org', 'medium.com', 'youtube.com', 'bilibili.com',
]);
const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'http', 'https', 'www', 'com', 'net', 'org',
  'app', 'web', 'page', 'home', 'index', 'list', 'detail', 'details', 'view', 'edit', 'main', 'new',
  'console', 'dashboard', 'workspace', 'docs', 'doc', 'settings', 'setting', 'config', 'configs',
  '页面', '网页', '详情', '列表', '配置', '文档', '首页', '控制台', '工作台', '发布', '管理',
]);
const GENERIC_GROUP_NAMES = new Set([
  '其他', '其它', '杂项', '未分类', '未命名', '默认', 'other', 'misc', 'uncategorized', 'ungrouped',
  '云文档', 'docs', 'wiki',
]);

const CONTENT_THEME_RULES = [
  ['配置与发布控制台', 'blue', /(\b(namespace|feature[_-]?flag|remote[_-]?config|helm|k8s)\b|命名空间配置|配置发布|发布控制台)/i],
  ['AI与Agent研发', 'purple', /(\b(agent|mcp|skill|llm|gpt|claude|deepseek|codex|openai|ollama|prompt|rag)\b|智能体|大模型|工作流引擎)/i],
  ['电商与交易产品', 'pink', /(购物车|结账|商品详情|交易链路|商店前台)/i],
  ['营销与增长活动', 'orange', /(\b(bmsm|promotion|campaign|flash[\s_-]?sale|voucher|coupon|discount)\b|营销|秒杀|凑单|满减|促销|优惠券)/i],
  ['安全与权限治理', 'green', /(办公安全|安全方案|权限申请|合规|账号安全|认证授权|零信任)/i],
  ['监控告警与稳定性', 'red', /(告警|监控|埋点|巡检|熔断|性能|看板|稳定性|oncall|grafana|metrics|prometheus|datadog)/i],
  ['代码仓库与评审', 'cyan', /(\b(github\.com|gitlab|bitbucket|merge_request|pull_request|commit|branch)\b|代码仓库|代码库|合并请求|\bMR\b|\bPR\b)/i],
  ['项目排期与技术方案', 'yellow', /(甘特图|排期|周报|双周会|封板|估时|人力|复盘|OKR|路线图|技术方案|架构设计|\bPRD\b|需求文档)/i],
];

function escapeRegExpLiteral(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePatternMatcher(rawPattern, { strict = false } = {}) {
  const trimmed = String(rawPattern || '').trim();
  if (!trimmed) return strict ? { ok: false, message: '匹配模式不能为空' } : { ok: false };
  const slashMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (slashMatch) {
    try {
      const flags = slashMatch[2].replace(/[gy]/g, '');
      const regex = new RegExp(slashMatch[1], flags || 'i');
      return { ok: true, type: 'regex', key: `/${slashMatch[1]}/${flags || 'i'}`, regex };
    } catch (err) {
      return strict ? { ok: false, message: `正则表达式语法无效: ${err?.message || ''}` } : { ok: false };
    }
  }
  if (/^regex:/i.test(trimmed)) {
    const body = trimmed.slice(6).trim();
    if (!body) return strict ? { ok: false, message: 'regex: 后缺少表达式内容' } : { ok: false };
    try {
      const regex = new RegExp(body, 'i');
      return { ok: true, type: 'regex', key: `regex:${body}`, regex };
    } catch (err) {
      return strict ? { ok: false, message: `正则表达式语法无效: ${err?.message || ''}` } : { ok: false };
    }
  }
  if (trimmed.includes('*')) {
    let source = trimmed;
    let prefix = '^https?://(?:www\\.)?';
    if (/^https?:\/\//i.test(source)) {
      prefix = '^https?://(?:www\\.)?';
      source = source.replace(/^https?:\/\/(?:www\.)?/i, '');
    } else if (/^\*\.(?=[a-z0-9-])/i.test(source)) {
      prefix = '^https?://(?:[^/?#]+\\.)?';
      source = source.slice(2);
    } else if (/^\*\//.test(source)) {
      prefix = '^https?://[^/?#]+/';
      source = source.slice(2);
    }
    const regexStr = prefix + source.split('*').map(escapeRegExpLiteral).join('.*') + '$';
    return {
      ok: true,
      type: 'wildcard',
      key: /^https?:\/\//i.test(trimmed) ? trimmed.replace(/^https?:\/\//i, '') : trimmed,
      regex: new RegExp(regexStr, 'i'),
    };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const norm = normUrlKey(trimmed);
    const noProto = norm.replace(/^https?:\/\/(?:www\.)?/i, '');
    return {
      ok: true,
      type: 'url',
      key: norm,
      regex: new RegExp(`^https?://(?:www\\.)?${escapeRegExpLiteral(noProto)}(?:[/?#].*)?$`, 'i'),
    };
  }
  if (trimmed.includes('/')) {
    return {
      ok: true,
      type: 'url',
      key: trimmed,
      regex: new RegExp(`^https?://(?:www\\.)?${escapeRegExpLiteral(trimmed)}(?:[/?#].*)?$`, 'i'),
    };
  }
  const host = trimmed.replace(/^www\./i, '').toLowerCase();
  return {
    ok: true,
    type: 'host',
    key: host,
    regex: new RegExp(`^https?://(?:www\\.)?${escapeRegExpLiteral(host)}(?::\\d+)?(?:/.*)?$`, 'i'),
  };
}

function parseQueryKeyList(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || '').split(/[,，\s&]+/);
  return [...new Set(arr.map(s => String(s || '').trim().replace(/^\?/, '')).filter(Boolean))].slice(0, 12);
}

/**
 * 解析标签聚合标识层级规则，支持对象与简写字符串（例如:
 *   "https://console.example.com/deploy/* | depth=4 | params=workspaceId,region"
 *   "https://console.example.com/deploy/*?workspaceId&region"
 * ）。
 */
export function parseAggregationRule(raw, { strict = false } = {}) {
  if (!raw) return strict ? { ok: false, message: '聚合规则不能为空' } : { ok: false };
  let pattern = '';
  let pathDepth = null;
  let queryKeys = [];
  let label = '';
  let id = '';

  if (typeof raw === 'string') {
    const chunks = raw.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);
    pattern = chunks[0] || '';
    for (const part of chunks.slice(1)) {
      const mDepth = part.match(/^(?:depth|level|pathDepth)\s*=\s*(\d+|auto)$/i);
      if (mDepth) {
        pathDepth = mDepth[1].toLowerCase() === 'auto' ? null : Math.min(8, Math.max(0, Number(mDepth[1])));
        continue;
      }
      const mParams = part.match(/^(?:params?|queryKeys?|keys?)\s*=\s*(.+)$/i);
      if (mParams) {
        queryKeys = parseQueryKeyList(mParams[1]);
        continue;
      }
      const mLabel = part.match(/^label\s*=\s*(.+)$/i);
      if (mLabel) {
        label = mLabel[1].trim().slice(0, 24);
      }
    }
    // Support pattern ending in valueless query key hints: host/path/*?workspaceId&region
    const qIdx = pattern.indexOf('?');
    if (qIdx > -1 && !/^\/.+\/[gimsuy]*$/.test(pattern) && !/^regex:/i.test(pattern)) {
      const qRaw = pattern.slice(qIdx + 1);
      if (qRaw && !qRaw.includes('=')) {
        pattern = pattern.slice(0, qIdx);
        queryKeys = [...new Set([...queryKeys, ...parseQueryKeyList(qRaw)])];
      }
    }
  } else if (typeof raw === 'object') {
    id = String(raw.id || '').trim();
    pattern = String(raw.pattern || '').trim();
    if (raw.pathDepth !== null && raw.pathDepth !== undefined && raw.pathDepth !== '' && raw.pathDepth !== 'auto') {
      const d = Number(raw.pathDepth);
      if (!Number.isInteger(d) || d < 0 || d > 8) {
        return strict ? { ok: false, message: 'Path 层级深度必须是 0~8 的整数或自动' } : { ok: false };
      }
      pathDepth = d;
    }
    queryKeys = parseQueryKeyList(raw.queryKeys ?? raw.params ?? '');
    label = String(raw.label || '').trim().slice(0, 24);
  }

  const matcher = compilePatternMatcher(pattern, { strict });
  if (!matcher.ok) return matcher;
  if (pathDepth === null && !queryKeys.length && typeof raw === 'object' && raw.strictRequireDimension) {
    return { ok: false, message: '请指定 Path 层级深度或至少一个区分查询参数' };
  }

  const stableId = id || `${matcher.key}|d=${pathDepth ?? 'auto'}|q=${queryKeys.join(',')}`;
  return {
    ok: true,
    rule: {
      id: stableId,
      pattern: pattern.trim(),
      pathDepth,
      queryKeys,
      ...(label ? { label } : {}),
    },
    matcher,
  };
}

export function normalizeAggregationRules(rules = []) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(rules) ? rules : []) {
    const parsed = parseAggregationRule(raw, { strict: false });
    if (!parsed.ok || seen.has(parsed.rule.id)) continue;
    seen.add(parsed.rule.id);
    out.push({ ...parsed.rule, regex: parsed.matcher.regex, matcherType: parsed.matcher.type });
  }
  return out;
}

export function resolveTabAggregationIdentity(tab, rawRules = []) {
  const rules = Array.isArray(rawRules) && rawRules.every(r => r?.regex instanceof RegExp)
    ? rawRules
    : normalizeAggregationRules(rawRules);
  const rawUrl = String(tab?.url || tab || '');
  const prof = tab?.urlProfile || extractUrlProfile(rawUrl);
  if (!prof.valid) {
    return { matched: false, aggregationKey: '', pathScope: '', queryPart: '', params: [], rule: null };
  }
  const norm = normUrlKey(rawUrl);
  const matchedRule = rules.find(r => r.regex.test(norm) || (rawUrl !== norm && r.regex.test(rawUrl))) || null;
  if (!matchedRule) {
    return {
      matched: false,
      aggregationKey: prof.urlPrefix || prof.host,
      pathScope: prof.urlPrefix || prof.host,
      queryPart: '',
      params: [],
      rule: null,
    };
  }

  let segs = [];
  if (matchedRule.pathDepth === 0) {
    segs = [];
  } else if (Number.isInteger(matchedRule.pathDepth) && matchedRule.pathDepth > 0) {
    segs = prof.pathSegments.slice(0, matchedRule.pathDepth);
  } else {
    for (const seg of prof.normalizedSegments) {
      if (seg === '*' || segs.length >= 5) break;
      segs.push(seg);
    }
  }
  const pathScope = segs.length ? `${prof.host}/${segs.join('/')}` : prof.host;
  const params = [];
  try {
    const u = new URL(rawUrl);
    const paramSources = [u.searchParams];
    if (u.hash && u.hash.includes('?')) {
      const hashQ = u.hash.slice(u.hash.indexOf('?') + 1);
      if (hashQ) paramSources.push(new URLSearchParams(hashQ));
    }
    for (const key of matchedRule.queryKeys || []) {
      const lowKey = key.toLowerCase();
      const collected = [];
      for (const sp of paramSources) {
        for (const [k, v] of sp.entries()) {
          if (k.toLowerCase() === lowKey && String(v || '').trim()) {
            collected.push(String(v).trim());
          }
        }
      }
      const vals = [...new Set(collected)].sort();
      if (vals.length) params.push({ key, value: vals.join(',') });
    }
  } catch { /* ignore */ }
  const queryPart = params.map(p => `${p.key}=${p.value}`).join('&');
  const aggregationKey = queryPart ? `${pathScope}?${queryPart}` : pathScope;
  const paramSummary = params.map(p => `${p.key}=${p.value}`).join(' · ');

  let suggestedGroupName = matchedRule.label || '';
  if (suggestedGroupName && params.length) {
    suggestedGroupName = `${suggestedGroupName}·${params.map(p => p.value).join('/')}`.slice(0, 24);
  } else if (!suggestedGroupName) {
    const tailSeg = segs.filter(s => !['deploy', 'namespace', 'detail', 'details'].includes(s.toLowerCase())).pop() || prof.appKey;
    if (tailSeg && params.length) {
      suggestedGroupName = `${tailSeg.split('.').pop()}·${params[0].value}`.slice(0, 24);
    } else if (tailSeg) {
      suggestedGroupName = tailSeg.slice(0, 20);
    }
  }

  return {
    matched: true,
    ruleId: matchedRule.id,
    pattern: matchedRule.pattern,
    pathDepth: matchedRule.pathDepth,
    pathScope,
    queryPart,
    params,
    paramSummary,
    aggregationKey,
    ...(suggestedGroupName ? { suggestedGroupName } : {}),
    rule: matchedRule,
  };
}

export function testAggregationRuleAgainstTabs(ruleInput, tabs = []) {
  const parsed = parseAggregationRule(ruleInput, { strict: true });
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const compiled = [{ ...parsed.rule, regex: parsed.matcher.regex, matcherType: parsed.matcher.type }];
  const matches = [];
  const buckets = new Map();
  for (const t of tabs) {
    if (!/^https?:\/\//i.test(String(t?.url || ''))) continue;
    const identity = resolveTabAggregationIdentity(t, compiled);
    if (!identity.matched) continue;
    matches.push({
      id: t.id,
      windowId: t.windowId,
      title: String(t.manualTitle || t.title || t.url),
      url: t.url,
      aggregationKey: identity.aggregationKey,
      pathScope: identity.pathScope,
      paramSummary: identity.paramSummary,
    });
    if (!buckets.has(identity.aggregationKey)) {
      buckets.set(identity.aggregationKey, { aggregationKey: identity.aggregationKey, count: 0, paramSummary: identity.paramSummary, tabIds: [] });
    }
    const b = buckets.get(identity.aggregationKey);
    b.count += 1;
    b.tabIds.push(t.id);
  }
  return {
    ok: true,
    rule: parsed.rule,
    totalTabs: tabs.filter(t => /^https?:\/\//i.test(String(t?.url || ''))).length,
    matchedCount: matches.length,
    distinctKeysCount: buckets.size,
    buckets: [...buckets.values()].sort((a, b) => b.count - a.count),
    matches,
  };
}

export function normUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    return u.href;
  } catch {
    return String(rawUrl || '');
  }
}

export function normalizeGroupNameKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s·•・\-_—–/|&和与及、,:：]+/g, '');
}

function isDynamicIdSegment(seg) {
  if (!seg) return false;
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[0-9a-f]{12,}$/i.test(seg)) return true;
  if (/^[A-Za-z0-9_-]{18,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg)) return true;
  return false;
}

export function isGenericDomainGroupName(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return true;
  if (GENERIC_GROUP_NAMES.has(s)) return true;
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(s);
}

export function extractUrlProfile(rawUrl) {
  const str = String(rawUrl || '');
  if (!/^https?:\/\//i.test(str)) {
    return {
      valid: false,
      url: str,
      host: '',
      subdomain: '',
      apexDomain: '',
      origin: '',
      pathSegments: [],
      normalizedSegments: [],
      urlPrefix: '',
      appKey: '',
      isDocHub: false,
      isConfigSystem: false,
      queryKeys: [],
    };
  }
  try {
    const u = new URL(str);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const parts = host.split('.').filter(Boolean);
    const apexDomain = parts.length >= 2 ? parts.slice(-2).join('.') : host;
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join('.') : '';
    const pathSegments = u.pathname.split('/').filter(Boolean);
    const normalizedSegments = pathSegments.map(seg => (isDynamicIdSegment(seg) ? '*' : seg));

    const isDocHub = DOC_HUB_HOSTS.has(host) || DOC_HUB_HOSTS.has(apexDomain) || host.endsWith('.atlassian.net');
    const isRepoHost = REPO_HOSTS.has(host) || host.includes('gitlab');

    // Determine semantic aggregation prefix & appKey
    let prefixSegs = [];
    let appKey = '';
    if (isRepoHost && normalizedSegments.length >= 2 && normalizedSegments[0] !== '*' && normalizedSegments[1] !== '*') {
      prefixSegs = normalizedSegments.slice(0, 2);
      appKey = `${normalizedSegments[0]}/${normalizedSegments[1]}`;
    } else if (['app', 'console', 'platform'].includes(normalizedSegments[0]) && normalizedSegments[1] && normalizedSegments[1] !== '*') {
      prefixSegs = normalizedSegments.slice(0, 2);
      appKey = normalizedSegments[1];
    } else {
      for (const seg of normalizedSegments) {
        if (seg === '*' || prefixSegs.length >= 2) break;
        prefixSegs.push(seg);
      }
      if (!prefixSegs.length && normalizedSegments[0]) prefixSegs = [normalizedSegments[0]];
      appKey = isDocHub ? '' : (prefixSegs[0] || subdomain || '');
    }

    const urlPrefix = prefixSegs.length ? `${host}/${prefixSegs.join('/')}` : host;
    const lowerPath = `/${normalizedSegments.join('/').toLowerCase()}`;
    const isConfigPath = /\/(app|namespace|config|configs|setting|settings|project|projects|pipeline|pipelines|task|tasks|job|jobs|service|cluster|env|release|deploy|publish)\b/.test(lowerPath);
    const isConfigHost = /^(cloud|console|config|data|metrics|devops|ci|cd)\./.test(host);
    const isConfigSystem = !isDocHub && Boolean(
      (isRepoHost && prefixSegs.length >= 2)
      || isConfigPath
      || (isConfigHost && prefixSegs.length >= 1),
    );

    const queryKeys = [...new Set([...u.searchParams.keys()].slice(0, 8))];
    return {
      valid: true,
      url: str,
      host,
      subdomain,
      apexDomain,
      origin: u.origin,
      pathSegments,
      normalizedSegments,
      urlPrefix,
      appKey,
      isDocHub,
      isConfigSystem,
      queryKeys,
    };
  } catch {
    return {
      valid: false,
      url: str,
      host: '',
      subdomain: '',
      apexDomain: '',
      origin: '',
      pathSegments: [],
      normalizedSegments: [],
      urlPrefix: '',
      appKey: '',
      isDocHub: false,
      isConfigSystem: false,
      queryKeys: [],
    };
  }
}

export function extractSystemTokens(tab) {
  const profile = tab.urlProfile || extractUrlProfile(tab.url);
  const title = String(tab.manualTitle || tab.title || '');
  const snippet = String(tab.snippet || tab.cachedSummary || '');
  const text = `${title} ${snippet} ${tab.url || ''}`;
  const tokens = new Set();

  // Dotted microservice / namespace identifiers like shop.checkout.api -> shop.checkout
  const dottedMatches = text.match(/\b[a-z][a-z0-9_]{1,18}\.[a-z][a-z0-9_]{1,22}(?:\.[a-z0-9_]{2,26})?/gi) || [];
  for (const m of dottedMatches) {
    const low = m.toLowerCase();
    if (/\.(com|net|org|cn|io|dev|test|invalid|js|ts|mjs|css|html|json|png|jpg|svg)$/i.test(low)) continue;
    const segs = low.split('.');
    if (segs.length >= 2 && segs[0].length >= 2 && segs[1].length >= 2) {
      tokens.add(`${segs[0]}.${segs[1]}`);
    }
  }

  // Known/explicit system names & acronyms (e.g. K8S, Grafana, CI, CD, etc.)
  const upperMatches = `${title} ${snippet.slice(0, 180)}`.match(/\b[A-Z][A-Z0-9_-]{1,12}\b/g) || [];
  for (const m of upperMatches) {
    const clean = m.replace(/[-_]+$/, '');
    if (clean.length >= 2 && !STOPWORDS.has(clean.toLowerCase()) && !/^\d+$/.test(clean)) {
      tokens.add(clean.toUpperCase());
    }
  }

  if (profile.isConfigSystem && profile.appKey) {
    tokens.add(profile.appKey.toUpperCase());
  }
  return [...tokens];
}

function extractReadableKeywords(tabs, maxCount = 6) {
  const counts = new Map();
  const add = (tok, weight = 1) => {
    const clean = String(tok || '').trim();
    if (!clean || clean.length < 2) return;
    if (STOPWORDS.has(clean.toLowerCase())) return;
    const key = clean.toLowerCase();
    const cur = counts.get(key) || { label: clean, score: 0 };
    cur.score += weight;
    if (clean.length > cur.label.length && clean.length <= 24) cur.label = clean;
    counts.set(key, cur);
  };

  for (const t of tabs) {
    for (const sys of extractSystemTokens(t)) add(sys, 3);
    const title = String(t.manualTitle || t.title || '');
    const cjkPhrases = title.match(/[\p{Script=Han}]{2,8}/gu) || [];
    for (const p of cjkPhrases) add(p, 1.5);
    const words = title.match(/[A-Za-z][A-Za-z0-9._-]{2,22}/g) || [];
    for (const w of words) add(w, 1);
  }

  return [...counts.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxCount)
    .map(item => item.label);
}

function pickDiverseSamples(tabs, limit = 8) {
  const sorted = [...tabs].sort((a, b) => (b.recentVisitAt || 0) - (a.recentVisitAt || 0) || Number(Boolean(b.snippet || b.cachedSummary)) - Number(Boolean(a.snippet || a.cachedSummary)));
  const seenUrls = new Set();
  const seenTitles = new Set();
  const chosen = [];
  for (const t of sorted) {
    const uKey = normUrlKey(t.url);
    const tKey = String(t.manualTitle || t.title || '').trim().toLowerCase();
    if (seenUrls.has(uKey) || (tKey && seenTitles.has(tKey) && chosen.length >= 3)) continue;
    seenUrls.add(uKey);
    if (tKey) seenTitles.add(tKey);
    chosen.push(t);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

export function distillGroupProfiles(groups = [], tabs = [], { lockedIds = new Set(), manualNames = new Map(), aggregationRules = [] } = {}) {
  const byId = new Map(tabs.map(t => [Number(t.id), t]));
  const compiledRules = normalizeAggregationRules(aggregationRules);
  const profiles = [];

  for (const g of groups) {
    const name = String(g.name ?? g.title ?? '').trim();
    if (!name) continue;
    const memberTabs = Array.isArray(g.tabIds)
      ? g.tabIds.map(id => byId.get(Number(id))).filter(Boolean)
      : tabs.filter(t => t.groupId === g.id);

    const prefixMap = new Map();
    const hostMap = new Map();
    const aggKeyMap = new Map();
    for (const t of memberTabs) {
      const prof = t.urlProfile || extractUrlProfile(t.url);
      if (!prof.valid) continue;
      hostMap.set(prof.host, (hostMap.get(prof.host) || 0) + 1);
      const identity = compiledRules.length ? resolveTabAggregationIdentity(t, compiledRules) : null;
      const customKey = identity?.matched ? identity.aggregationKey : (t.aggregationKey || '');
      if (customKey) {
        const curKey = aggKeyMap.get(customKey) || { key: customKey, count: 0, paramSummary: identity?.paramSummary || '' };
        curKey.count += 1;
        aggKeyMap.set(customKey, curKey);
      }
      if (prof.urlPrefix) {
        const cur = prefixMap.get(prof.urlPrefix) || { prefix: prof.urlPrefix, count: 0, strong: prof.isConfigSystem };
        cur.count += 1;
        cur.strong = cur.strong || prof.isConfigSystem;
        prefixMap.set(prof.urlPrefix, cur);
      }
    }

    const topAggregationKeys = [...aggKeyMap.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const topPrefixes = [...prefixMap.values()]
      .sort((a, b) => Number(b.strong) - Number(a.strong) || b.count - a.count)
      .slice(0, 5);
    const topHosts = [...hostMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([host, count]) => ({ host, count }));
    const keywords = extractReadableKeywords(memberTabs, 6);
    const samples = pickDiverseSamples(memberTabs, 8).map(t => {
      const prof = t.urlProfile || extractUrlProfile(t.url);
      const identity = compiledRules.length ? resolveTabAggregationIdentity(t, compiledRules) : null;
      const aggregationKey = identity?.matched ? identity.aggregationKey : (t.aggregationKey || '');
      const summary = String(t.cachedSummary || t.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 96);
      return {
        id: t.id,
        title: String(t.manualTitle || t.title || '').replace(/\s+/g, ' ').trim().slice(0, 64),
        host: prof.host,
        urlPrefix: prof.urlPrefix,
        ...(aggregationKey ? { aggregationKey } : {}),
        ...(prof.pathSegments.length ? { path: `/${prof.pathSegments.slice(0, 4).join('/')}` } : {}),
        ...(summary ? { summary } : {}),
      };
    });

    const descParts = [`共 ${memberTabs.length} 页`];
    if (topAggregationKeys.length) {
      descParts.push(`标识层级：${topAggregationKeys.slice(0, 2).map(k => `${k.key}(${k.count})`).join('、')}`);
    } else if (topPrefixes.length) {
      descParts.push(`主前缀：${topPrefixes.slice(0, 3).map(p => `${p.prefix}(${p.count})`).join('、')}`);
    }
    if (keywords.length) {
      descParts.push(`关键词：${keywords.slice(0, 5).join(' / ')}`);
    }

    const pinned = Boolean(
      g.pinned
      || (g.id != null && (lockedIds.has(g.id) || manualNames.has(g.id))),
    );

    profiles.push({
      ...(g.id != null ? { id: g.id } : {}),
      name,
      pinned,
      genericDomain: isGenericDomainGroupName(name),
      tabCount: memberTabs.length,
      ...(topAggregationKeys.length ? { topAggregationKeys } : {}),
      topPrefixes,
      topHosts,
      keywords,
      description: descParts.join('；'),
      samples,
    });
  }

  return profiles.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.tabCount - a.tabCount);
}

export function buildBatchPrefixClusters(tabs = [], opts = {}) {
  const compiledRules = normalizeAggregationRules(opts.aggregationRules || opts.rules || []);
  const byPrefix = new Map();
  const bySystem = new Map();

  for (const t of tabs) {
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const prof = t.urlProfile || extractUrlProfile(t.url);
    const identity = compiledRules.length ? resolveTabAggregationIdentity(t, compiledRules) : null;
    const ruleMatchedKey = identity?.matched ? identity.aggregationKey : (t.aggregationKey || '');

    if (ruleMatchedKey) {
      const k = `rule::${ruleMatchedKey}`;
      const cur = byPrefix.get(k) || {
        key: ruleMatchedKey,
        kind: 'aggregation-rule',
        paramSummary: identity?.paramSummary || '',
        host: prof.host,
        tabs: [],
      };
      cur.tabs.push(t);
      byPrefix.set(k, cur);
    } else if (prof.valid && prof.isConfigSystem && prof.urlPrefix) {
      const k = `prefix::${prof.urlPrefix}`;
      const cur = byPrefix.get(k) || { key: prof.urlPrefix, kind: 'prefix', host: prof.host, tabs: [] };
      cur.tabs.push(t);
      byPrefix.set(k, cur);
    }

    // Do not merge different custom aggregationKey pipelines into one generic system cluster
    if (!ruleMatchedKey) {
      for (const tok of extractSystemTokens(t)) {
        if (tok.length < 3 && tok !== 'CI' && tok !== 'CD') continue;
        const isDotted = tok.includes('.');
        const sysKey = isDotted ? `ns:${tok}` : (prof.host ? `${prof.host}::${tok}` : `tok:${tok}`);
        const cur = bySystem.get(sysKey) || { key: sysKey, label: tok, kind: isDotted ? 'namespace' : 'system', host: prof.host, tabs: [] };
        cur.tabs.push(t);
        bySystem.set(sysKey, cur);
      }
    }
  }

  const clusters = [];
  for (const entry of byPrefix.values()) {
    if (entry.tabs.length >= 2) {
      clusters.push({
        key: entry.key,
        kind: entry.kind,
        ...(entry.paramSummary ? { paramSummary: entry.paramSummary } : {}),
        count: entry.tabs.length,
        tabIds: entry.tabs.map(t => Number(t.id)),
        keywords: extractReadableKeywords(entry.tabs, 4),
        sampleTitles: entry.tabs.slice(0, 4).map(t => String(t.manualTitle || t.title || '').slice(0, 40)),
      });
    }
  }
  for (const entry of bySystem.values()) {
    if (entry.tabs.length >= 2) {
      const coveredAlready = clusters.some(c =>
        entry.tabs.every(t => c.tabIds.includes(Number(t.id))),
      );
      if (coveredAlready) continue;
      clusters.push({
        key: entry.label,
        kind: entry.kind,
        count: entry.tabs.length,
        tabIds: entry.tabs.map(t => Number(t.id)),
        keywords: [entry.label],
        sampleTitles: entry.tabs.slice(0, 4).map(t => String(t.manualTitle || t.title || '').slice(0, 40)),
      });
    }
  }

  return clusters.sort((a, b) => Number(b.kind === 'aggregation-rule') - Number(a.kind === 'aggregation-rule') || b.count - a.count).slice(0, 16);
}

function chooseMergedGroupName(groupA, groupB, tabsForCombined) {
  const aGeneric = isGenericDomainGroupName(groupA.name);
  const bGeneric = isGenericDomainGroupName(groupB.name);
  if (groupA.pinned && !groupB.pinned) return groupA.name;
  if (groupB.pinned && !groupA.pinned) return groupB.name;
  if (!aGeneric && bGeneric) return groupA.name;
  if (!bGeneric && aGeneric) return groupB.name;
  if (groupA.tabIds.length !== groupB.tabIds.length) {
    return groupA.tabIds.length > groupB.tabIds.length ? groupA.name : groupB.name;
  }
  if (!aGeneric) return groupA.name;
  return suggestLabelForTabs(tabsForCombined) || groupA.name;
}

export function suggestLabelForTabs(tabs = [], opts = {}) {
  if (!tabs.length) return '未命名';
  const compiledRules = normalizeAggregationRules(opts.aggregationRules || opts.rules || []);
  if (compiledRules.length) {
    const aggLabels = new Map();
    for (const t of tabs) {
      const idn = resolveTabAggregationIdentity(t, compiledRules);
      if (idn.matched && idn.suggestedGroupName) {
        aggLabels.set(idn.suggestedGroupName, (aggLabels.get(idn.suggestedGroupName) || 0) + 1);
      }
    }
    if (aggLabels.size === 1) {
      return [...aggLabels.keys()][0];
    }
  }
  const prefixes = new Map();
  for (const t of tabs) {
    const p = t.urlProfile || extractUrlProfile(t.url);
    if (p.valid && p.appKey && !p.isDocHub) {
      const key = p.appKey.toUpperCase();
      prefixes.set(key, (prefixes.get(key) || 0) + 1);
    }
  }
  const keywords = extractReadableKeywords(tabs, 4);
  const topApp = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topApp && topApp.length >= 2) {
    const extra = keywords.find(k => k.toUpperCase() !== topApp && k.length >= 2 && k.length <= 10);
    if (topApp === 'CONFIG' || keywords.some(k => k.toUpperCase() === 'CONFIG')) {
      return '配置发布';
    }
    return extra ? `${topApp} · ${extra}`.slice(0, 18) : `${topApp} 相关`.slice(0, 18);
  }
  const theme = inferTabContentTopic(tabs[0]);
  if (theme) return theme.name;
  return keywords[0] ? String(keywords[0]).slice(0, 16) : null;
}

function stripCarrierSuffix(text) {
  return String(text || '')
    .replace(/\s*[-·|—_]\s*(云文档|Google Docs|Notion|Confluence)\s*$/gi, '')
    .trim();
}

export function inferTabContentTopic(tab) {
  if (!tab) return null;
  const title = stripCarrierSuffix(tab.manualTitle || tab.title || '');
  const body = stripCarrierSuffix(`${tab.snippet || ''} ${tab.cachedSummary || ''} ${tab.bookmarkPath || ''}`);
  const hay = `${title} ${body} ${tab.url || ''}`;
  for (const [name, color, re] of CONTENT_THEME_RULES) {
    if (re.test(hay)) return { name, color };
  }
  return null;
}

export function clusterTabsByContentTheme(tabs = [], opts = {}) {
  const compiledRules = normalizeAggregationRules(opts.aggregationRules || opts.rules || []);
  const buckets = new Map();
  const add = (name, color, id) => {
    if (!buckets.has(name)) buckets.set(name, { name, color: color || COLORS[buckets.size % COLORS.length], tabIds: [] });
    buckets.get(name).tabIds.push(Number(id));
  };

  for (const t of tabs) {
    if (t.bookmarkPath) {
      const leaf = String(t.bookmarkPath).split('/').filter(Boolean).pop();
      if (leaf && !isGenericDomainGroupName(leaf)) {
        add(leaf.slice(0, 14), COLORS[buckets.size % COLORS.length], t.id);
        continue;
      }
    }
    if (compiledRules.length) {
      const idn = resolveTabAggregationIdentity(t, compiledRules);
      if (idn.matched && idn.suggestedGroupName) {
        add(idn.suggestedGroupName, COLORS[buckets.size % COLORS.length], t.id);
        continue;
      }
    }
    const topic = inferTabContentTopic(t);
    if (topic) {
      add(topic.name, topic.color, t.id);
      continue;
    }
    const prof = t.urlProfile || extractUrlProfile(t.url);
    if (prof.valid && prof.isConfigSystem) {
      const smart = suggestLabelForTabs([t], opts);
      if (smart && !isGenericDomainGroupName(smart)) {
        add(smart, COLORS[buckets.size % COLORS.length], t.id);
        continue;
      }
    }
    const clean = stripCarrierSuffix(t.manualTitle || t.title || '');
    const cjk = (clean.match(/[\p{Script=Han}]{2,6}/gu) || []).find(w => !STOPWORDS.has(w));
    const eng = (clean.match(/[A-Za-z][A-Za-z0-9_-]{2,14}/g) || []).find(w => !STOPWORDS.has(w.toLowerCase()));
    const fallback = cjk ? `${cjk}相关` : eng ? `${eng}相关` : '综合文档与页面';
    add(fallback.slice(0, 16), COLORS[buckets.size % COLORS.length], t.id);
  }

  return [...buckets.values()];
}

function resolveTabClusterKey(t, compiledRules) {
  const prof = t.urlProfile || extractUrlProfile(t.url);
  if (compiledRules.length) {
    const idn = resolveTabAggregationIdentity(t, compiledRules);
    if (idn.matched) {
      return {
        hasRuleMatch: true,
        key: idn.aggregationKey,
        paramSummary: idn.paramSummary || '',
        suggestedGroupName: idn.suggestedGroupName || '',
        strong: true,
        prof,
      };
    }
  }
  if (t.aggregationKey) {
    return {
      hasRuleMatch: true,
      key: t.aggregationKey,
      paramSummary: t.identityParams || '',
      suggestedGroupName: '',
      strong: true,
      prof,
    };
  }
  return {
    hasRuleMatch: false,
    key: prof.valid && prof.isConfigSystem && prof.urlPrefix ? prof.urlPrefix : '',
    paramSummary: '',
    suggestedGroupName: '',
    strong: prof.valid && prof.isConfigSystem,
    prof,
  };
}

export function auditGroupAggregation(groups = [], tabs = [], opts = {}) {
  const byId = new Map(tabs.map(t => [Number(t.id), t]));
  const compiledRules = normalizeAggregationRules(opts.aggregationRules || opts.rules || []);
  const pinnedNames = new Set(
    (Array.isArray(opts.pinnedGroupNames) ? opts.pinnedGroupNames : [])
      .concat((Array.isArray(opts.existingGroupAnchors) ? opts.existingGroupAnchors : []).filter(a => a?.pinned).map(a => a.name))
      .map(s => String(s || '').trim())
      .filter(Boolean),
  );

  const normalizedGroups = groups.map((g, idx) => ({
    index: idx,
    name: String(g.name || g.title || '未命名').trim(),
    color: g.color || COLORS[idx % COLORS.length],
    pinned: Boolean(g.pinned || pinnedNames.has(String(g.name || g.title || '').trim())),
    tabIds: [...new Set((g.tabIds || []).map(Number).filter(id => byId.has(id)))],
  })).filter(g => g.tabIds.length > 0);

  const groupOfTab = new Map();
  for (const g of normalizedGroups) {
    for (const id of g.tabIds) groupOfTab.set(id, g);
  }

  const issues = [];

  // 1. Same normalized URL across multiple groups
  const urlOwners = new Map();
  for (const g of normalizedGroups) {
    for (const id of g.tabIds) {
      const k = normUrlKey(byId.get(id)?.url);
      if (!k) continue;
      if (!urlOwners.has(k)) urlOwners.set(k, new Set());
      urlOwners.get(k).add(g.name);
    }
  }
  for (const [u, owners] of urlOwners.entries()) {
    if (owners.size > 1) {
      issues.push({ type: 'same-url-split', severity: 'high', key: u, groups: [...owners] });
    }
  }

  // 2. Strong URL prefix / configured aggregationKey cluster split across multiple groups
  const prefixClusters = new Map();
  for (const t of tabs) {
    const id = Number(t.id);
    if (!groupOfTab.has(id)) continue;
    const resolved = resolveTabClusterKey(t, compiledRules);
    if (!resolved.key) continue;
    const list = prefixClusters.get(resolved.key) || [];
    list.push({ id, group: groupOfTab.get(id) });
    prefixClusters.set(resolved.key, list);
  }
  for (const [prefix, members] of prefixClusters.entries()) {
    if (members.length < 2) continue;
    const owners = [...new Set(members.map(m => m.group.name))];
    if (owners.length > 1) {
      issues.push({
        type: 'split-url-prefix',
        severity: 'high',
        key: prefix,
        tabCount: members.length,
        groups: owners,
        tabIds: members.map(m => m.id),
      });
    }
  }

  // 3. System / dotted-namespace signature split (skip tabs separated explicitly by aggregationRules)
  const sysClusters = new Map();
  for (const t of tabs) {
    const id = Number(t.id);
    if (!groupOfTab.has(id)) continue;
    const resolved = resolveTabClusterKey(t, compiledRules);
    if (resolved.hasRuleMatch) continue;
    const prof = resolved.prof;
    for (const tok of extractSystemTokens(t)) {
      const isDotted = tok.includes('.');
      const key = isDotted ? `ns:${tok}` : (prof.isConfigSystem || prof.host ? `${prof.apexDomain || prof.host}::${tok}` : '');
      if (!key) continue;
      if (!isDotted && ['API', 'EU', 'US', 'UK', 'V1', 'V2', 'V3', 'ID', 'URL', 'UI', 'QA'].includes(tok)) continue;
      const list = sysClusters.get(key) || [];
      list.push({ id, tok, group: groupOfTab.get(id) });
      sysClusters.set(key, list);
    }
  }
  for (const [sysKey, members] of sysClusters.entries()) {
    if (members.length < 2) continue;
    const owners = [...new Set(members.map(m => m.group.name))];
    if (owners.length > 1) {
      issues.push({
        type: 'split-system-signature',
        severity: 'medium',
        key: sysKey,
        tabCount: members.length,
        groups: owners,
        tabIds: members.map(m => m.id),
      });
    }
  }

  // 4. Generic domain bucket groups (e.g. "console.example.com")
  for (const g of normalizedGroups) {
    if (isGenericDomainGroupName(g.name) && g.tabIds.length >= 2) {
      const memberTabs = g.tabIds.map(id => byId.get(id)).filter(Boolean);
      const distinctApps = new Set(
        memberTabs.map(t => resolveTabClusterKey(t, compiledRules).key || (t.urlProfile || extractUrlProfile(t.url)).host).filter(Boolean),
      );
      issues.push({
        type: 'generic-domain-bucket',
        severity: distinctApps.size > 1 ? 'high' : 'medium',
        key: g.name,
        pinned: g.pinned,
        tabCount: g.tabIds.length,
        distinctPrefixes: [...distinctApps].slice(0, 6),
        suggestedName: suggestLabelForTabs(memberTabs, opts),
        groups: [g.name],
      });
    }
  }

  // 5. Fragmented singleton group sharing strong key/prefix with another group
  for (const g of normalizedGroups) {
    if (g.pinned || g.tabIds.length !== 1) continue;
    const t = byId.get(g.tabIds[0]);
    if (!t) continue;
    const resolved = resolveTabClusterKey(t, compiledRules);
    if (!resolved.key) continue;
    const partner = normalizedGroups.find(other => other !== g && other.tabIds.some(id => {
      const ot = byId.get(id);
      return ot && resolveTabClusterKey(ot, compiledRules).key === resolved.key;
    }));
    if (partner) {
      issues.push({
        type: 'fragmented-singleton',
        severity: 'medium',
        key: resolved.key,
        groups: [g.name, partner.name],
        tabIds: [g.tabIds[0]],
      });
    }
  }

  // 6. Unpinned group mixing distinct rule-configured aggregationKeys (different pipelines/params lumped together)
  for (const g of normalizedGroups) {
    if (g.pinned || g.tabIds.length < 2) continue;
    const ruleKeys = new Map();
    for (const id of g.tabIds) {
      const t = byId.get(id);
      if (!t) continue;
      const resolved = resolveTabClusterKey(t, compiledRules);
      if (!resolved.hasRuleMatch || !resolved.key) continue;
      if (!ruleKeys.has(resolved.key)) ruleKeys.set(resolved.key, []);
      ruleKeys.get(resolved.key).push(id);
    }
    if (ruleKeys.size > 1) {
      issues.push({
        type: 'mixed-aggregation-keys',
        severity: 'high',
        key: g.name,
        groups: [g.name],
        distinctKeys: [...ruleKeys.keys()],
        tabIds: [...ruleKeys.values()].flat(),
      });
    }
  }

  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    issues,
    groupProfiles: distillGroupProfiles(normalizedGroups, tabs, { aggregationRules: compiledRules }),
  };
}

function shortIdentityBadge(resolved) {
  if (resolved.paramSummary) {
    const firstVal = resolved.paramSummary.split('·')[0].split('=')[1] || resolved.paramSummary;
    return String(firstVal).trim().slice(0, 14);
  }
  const segs = String(resolved.key || '').split('?')[0].split('/').filter(Boolean);
  return (segs[segs.length - 1] || '').slice(0, 14);
}

/** Consolidate split config/prefix clusters and return { groups, consolidatedCount, mergedPairs, auditBefore, auditAfter }. */
export function consolidateAndAuditGroups(rawGroups = [], tabs = [], opts = {}) {
  const byId = new Map(tabs.map(t => [Number(t.id), t]));
  const compiledRules = normalizeAggregationRules(opts.aggregationRules || opts.rules || []);
  const auditBefore = auditGroupAggregation(rawGroups, tabs, opts);
  const pinnedNames = new Set(
    (Array.isArray(opts.pinnedGroupNames) ? opts.pinnedGroupNames : [])
      .concat((Array.isArray(opts.existingGroupAnchors) ? opts.existingGroupAnchors : []).filter(a => a?.pinned).map(a => a.name))
      .map(s => String(s || '').trim())
      .filter(Boolean),
  );

  // Build mutable group objects
  const groups = rawGroups
    .map((g, idx) => ({
      name: String(g.name || '未命名').trim() || '未命名',
      color: COLORS.includes(g.color) ? g.color : COLORS[idx % COLORS.length],
      pinned: Boolean(g.pinned || pinnedNames.has(String(g.name || '').trim())),
      tabIds: [...new Set((g.tabIds || []).map(Number).filter(id => byId.has(id)))],
    }))
    .filter(g => g.tabIds.length > 0);

  const mergedPairs = [];

  const groupOf = id => groups.find(g => g.tabIds.includes(id));

  // Move split strong-prefix tabs & fragmented singletons into dominant group when unpinned
  const moveTab = (id, toGroup, reason) => {
    const fromGroup = groupOf(id);
    if (!fromGroup || !toGroup || fromGroup === toGroup) return;
    if (fromGroup.pinned) return;
    fromGroup.tabIds = fromGroup.tabIds.filter(x => x !== id);
    if (!toGroup.tabIds.includes(id)) toGroup.tabIds.push(id);
    mergedPairs.push({ tabId: id, from: fromGroup.name, to: toGroup.name, reason });
  };

  // Pass 0: Split unpinned groups that mixed distinct rule-configured aggregationKeys
  for (const g of [...groups]) {
    if (g.pinned || g.tabIds.length < 2) continue;
    const byRuleKey = new Map();
    for (const id of g.tabIds) {
      const t = byId.get(id);
      if (!t) continue;
      const res = resolveTabClusterKey(t, compiledRules);
      if (!res.hasRuleMatch || !res.key) continue;
      if (!byRuleKey.has(res.key)) byRuleKey.set(res.key, { resolved: res, ids: [] });
      byRuleKey.get(res.key).ids.push(id);
    }
    if (byRuleKey.size <= 1) continue;
    const buckets = [...byRuleKey.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length);
    // Keep the first (largest) bucket in g, split remaining buckets into dedicated groups
    for (const [aggKey, info] of buckets.slice(1)) {
      const existingTarget = groups.find(other => other !== g && !other.pinned && other.tabIds.length > 0 && other.tabIds.every(oid => {
        const ot = byId.get(oid);
        return ot && resolveTabClusterKey(ot, compiledRules).key === aggKey;
      }));
      let targetGroup = existingTarget;
      if (!targetGroup) {
        const badge = shortIdentityBadge(info.resolved);
        const baseName = isGenericDomainGroupName(g.name)
          ? (info.resolved.suggestedGroupName || suggestLabelForTabs(info.ids.map(id => byId.get(id)).filter(Boolean), opts) || '专项流水线')
          : g.name;
        const splitName = badge && !baseName.includes(badge) ? `${baseName}·${badge}`.slice(0, 28) : `${baseName}#${groups.length + 1}`;
        targetGroup = {
          name: splitName,
          color: COLORS[groups.length % COLORS.length],
          pinned: false,
          tabIds: [],
        };
        groups.push(targetGroup);
      }
      for (const id of info.ids) {
        moveTab(id, targetGroup, `split-mixed-aggregation-key:${aggKey}`);
      }
    }
  }

  // Pass 1: Configured aggregationKey or strong URL prefix consolidation
  const prefixClusters = new Map();
  for (const t of tabs) {
    const id = Number(t.id);
    const g = groupOf(id);
    if (!g) continue;
    const resolved = resolveTabClusterKey(t, compiledRules);
    if (!resolved.key) continue;
    const list = prefixClusters.get(resolved.key) || [];
    list.push(id);
    prefixClusters.set(resolved.key, list);
  }

  for (const [prefix, ids] of prefixClusters.entries()) {
    if (ids.length < 2) continue;
    const counts = new Map();
    for (const id of ids) {
      const g = groupOf(id);
      if (!g) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (counts.size <= 1) continue;
    // Choose winning group: pinned > non-generic > higher prefix count > larger group
    const sortedOwners = [...counts.entries()].sort((a, b) => {
      const [ga, ca] = a;
      const [gb, cb] = b;
      return Number(gb.pinned) - Number(ga.pinned)
        || Number(isGenericDomainGroupName(ga.name)) - Number(isGenericDomainGroupName(gb.name))
        || cb - ca
        || gb.tabIds.length - ga.tabIds.length;
    });
    const winner = sortedOwners[0][0];
    for (const id of ids) {
      const cur = groupOf(id);
      if (!cur || cur === winner || cur.pinned) continue;
      const curPrefixRatio = cur.tabIds.filter(tid => ids.includes(tid)).length / cur.tabIds.length;
      if (isGenericDomainGroupName(cur.name) || curPrefixRatio >= 0.5 || cur.tabIds.length <= 3) {
        moveTab(id, winner, `split-url-prefix:${prefix}`);
      }
    }
  }

  // Pass 2: System/namespace consolidation when NOT explicitly keyed by aggregationRules
  const nsClusters = new Map();
  for (const t of tabs) {
    const id = Number(t.id);
    const resolved = resolveTabClusterKey(t, compiledRules);
    if (resolved.hasRuleMatch) continue;
    const prof = resolved.prof;
    for (const tok of extractSystemTokens(t)) {
      if (!tok.includes('.')) continue;
      const key = tok.includes('.') ? `ns:${tok}` : `${prof.apexDomain || prof.host}::${tok}`;
      const list = nsClusters.get(key) || [];
      list.push(id);
      nsClusters.set(key, list);
    }
  }
  for (const [key, ids] of nsClusters.entries()) {
    if (ids.length < 2) continue;
    const counts = new Map();
    for (const id of ids) {
      const g = groupOf(id);
      if (!g) continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (counts.size <= 1) continue;
    const sortedOwners = [...counts.entries()].sort((a, b) => {
      const [ga, ca] = a;
      const [gb, cb] = b;
      return Number(gb.pinned) - Number(ga.pinned)
        || Number(isGenericDomainGroupName(ga.name)) - Number(isGenericDomainGroupName(gb.name))
        || cb - ca
        || gb.tabIds.length - ga.tabIds.length;
    });
    const winner = sortedOwners[0][0];
    for (const id of ids) {
      const cur = groupOf(id);
      if (!cur || cur === winner || cur.pinned) continue;
      // Never pull a tab out of a group whose majority consists of rule-keyed distinct pipelines
      const targetHasRule = winner.tabIds.some(tid => {
        const wt = byId.get(tid);
        return wt && resolveTabClusterKey(wt, compiledRules).hasRuleMatch;
      });
      if (targetHasRule) continue;
      const overlap = cur.tabIds.filter(tid => ids.includes(tid)).length / cur.tabIds.length;
      if (overlap >= 0.5 || cur.tabIds.length <= 2) {
        moveTab(id, winner, `split-system-signature:${key}`);
      }
    }
  }

  // Pass 3: Merge same normalized group names
  const byNormName = new Map();
  const compacted = [];
  for (const g of groups) {
    if (!g.tabIds.length) continue;
    const key = normalizeGroupNameKey(g.name);
    if (key && byNormName.has(key)) {
      const target = byNormName.get(key);
      const preferredName = chooseMergedGroupName(target, g, target.tabIds.concat(g.tabIds).map(id => byId.get(id)).filter(Boolean));
      target.name = preferredName;
      for (const id of g.tabIds) {
        if (!target.tabIds.includes(id)) target.tabIds.push(id);
        mergedPairs.push({ tabId: id, from: g.name, to: preferredName, reason: 'normalized-group-name' });
      }
    } else {
      const entry = { name: g.name, color: g.color, pinned: g.pinned, tabIds: [...g.tabIds] };
      if (key) byNormName.set(key, entry);
      compacted.push(entry);
    }
  }

  // Pass 4: Split or refine unpinned generic domain bucket names (like "docs.google.com" or "notion.so") by content relevance
  const finalCompacted = [];
  for (const g of compacted) {
    if (!g.pinned && isGenericDomainGroupName(g.name) && g.name !== '其他' && g.tabIds.length >= 1) {
      const memberTabs = g.tabIds.map(id => byId.get(id)).filter(Boolean);
      const allDocHub = memberTabs.every(t => (t.urlProfile || extractUrlProfile(t.url)).isDocHub);
      const keys = new Set(memberTabs.map(t => resolveTabClusterKey(t, compiledRules).key || (t.urlProfile || extractUrlProfile(t.url)).urlPrefix).filter(Boolean));
      if (!allDocHub && keys.size === 1) {
        const better = suggestLabelForTabs(memberTabs, opts);
        if (better && !isGenericDomainGroupName(better)) {
          mergedPairs.push({ tabId: null, from: g.name, to: better, reason: 'refine-generic-domain-name' });
          g.name = better;
          finalCompacted.push(g);
          continue;
        }
      }
      // Split generic domain bucket (especially doc hubs like docs.google.com or notion.so) by content theme
      const contentClusters = clusterTabsByContentTheme(memberTabs, opts);
      for (const sub of contentClusters) {
        const existingMatch = finalCompacted.find(other => !other.pinned && normalizeGroupNameKey(other.name) === normalizeGroupNameKey(sub.name))
          || compacted.find(other => other !== g && !other.pinned && normalizeGroupNameKey(other.name) === normalizeGroupNameKey(sub.name));
        if (existingMatch && existingMatch !== g) {
          for (const id of sub.tabIds) {
            if (!existingMatch.tabIds.includes(id)) existingMatch.tabIds.push(id);
            mergedPairs.push({ tabId: id, from: g.name, to: existingMatch.name, reason: `content-split:${sub.name}` });
          }
        } else {
          for (const id of sub.tabIds) {
            mergedPairs.push({ tabId: id, from: g.name, to: sub.name, reason: `content-split:${sub.name}` });
          }
          finalCompacted.push({ name: sub.name, color: sub.color, pinned: false, tabIds: [...sub.tabIds] });
        }
      }
    } else {
      finalCompacted.push(g);
    }
  }

  const finalGroups = finalCompacted.filter(g => g.tabIds.length > 0).map(({ name, color, tabIds }) => ({ name, color, tabIds }));
  const auditAfter = auditGroupAggregation(finalGroups, tabs, opts);

  return {
    groups: finalGroups,
    consolidatedCount: mergedPairs.length,
    mergedPairs: mergedPairs.slice(0, 40),
    auditBefore: { issueCount: auditBefore.issueCount, issues: auditBefore.issues },
    auditAfter,
  };
}

export function evaluateWhitelistPatternAgainstTabs(rawRule, tabs = []) {
  const matcher = compilePatternMatcher(rawRule, { strict: true });
  if (!matcher.ok) return { ok: false, message: matcher.message };
  const matches = [];
  for (const t of tabs) {
    const rawUrl = String(t?.url || '');
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const norm = normUrlKey(rawUrl);
    if (matcher.regex.test(norm) || (rawUrl !== norm && matcher.regex.test(rawUrl))) {
      matches.push(t);
    }
  }
  return {
    ok: true,
    rule: rawRule.trim(),
    matcherType: matcher.type,
    matchedCount: matches.length,
    matchedTabIds: matches.map(t => Number(t.id)),
    sampleTitles: matches.slice(0, 4).map(t => String(t.manualTitle || t.title || t.url).slice(0, 48)),
  };
}

function deriveCandidatePathRule(rawUrl) {
  const prof = extractUrlProfile(rawUrl);
  if (!prof.valid || prof.isDocHub) return null;
  const nonIdSegs = [];
  for (const seg of prof.normalizedSegments) {
    if (seg === '*' || nonIdSegs.length >= 3) break;
    nonIdSegs.push(seg);
  }
  if (!nonIdSegs.length) return null;
  // Prefer depth 3 for /app/<module>/<sub/*>, else depth 2
  const depth = (['app', 'console'].includes(nonIdSegs[0]) && nonIdSegs.length >= 3)
    ? 3
    : Math.min(2, nonIdSegs.length);
  const chosen = nonIdSegs.slice(0, depth);
  return {
    pattern: `https://${prof.host}/${chosen.join('/')}/*`,
    host: prof.host,
    apexDomain: prof.apexDomain,
    isConfigSystem: prof.isConfigSystem,
    prefixLabel: `${prof.host}/${chosen.join('/')}`,
  };
}

export function buildWhitelistSuggestions(tabs = [], { existingWhitelist = [], interceptedDups = [] } = {}) {
  const httpTabs = (Array.isArray(tabs) ? tabs : []).filter(t => /^https?:\/\//i.test(String(t?.url || '')));
  const compiledExisting = (Array.isArray(existingWhitelist) ? existingWhitelist : [])
    .map(r => ({ raw: String(r || '').trim(), compiled: compilePatternMatcher(r, { strict: false }) }))
    .filter(x => x.raw && x.compiled.ok);

  const isAlreadyCoveredByNarrowRule = pattern => {
    const clean = pattern.replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
    return compiledExisting.some(e => {
      if (e.compiled.type === 'host') return false;
      const ek = e.raw.replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
      return ek === clean || e.compiled.regex.test(pattern.replace(/\*+$/, 'test'));
    });
  };

  const candidates = new Map();
  const upsert = (pattern, patch) => {
    const cur = candidates.get(pattern) || {
      rule: pattern,
      kind: 'add',
      replaces: null,
      host: patch.host || '',
      isConfigSystem: Boolean(patch.isConfigSystem),
      interceptCount: 0,
      forcedOpenCount: 0,
      dupUrlCount: 0,
      reasons: new Set(),
    };
    cur.interceptCount += patch.interceptCount || 0;
    cur.forcedOpenCount += patch.forcedOpenCount || 0;
    cur.dupUrlCount += patch.dupUrlCount || 0;
    if (patch.kind === 'refine') {
      cur.kind = 'refine';
      cur.replaces = patch.replaces;
      if (Array.isArray(patch.replacesList) && patch.replacesList.length) {
        cur.replacesList = [...new Set([...(cur.replacesList || []), ...patch.replacesList])];
      } else if (patch.replaces) {
        cur.replacesList = [...new Set([...(cur.replacesList || []), patch.replaces])];
      }
    }
    if (Array.isArray(patch.changes) && patch.changes.length) {
      cur.changes = [...new Set([...(cur.changes || []), ...patch.changes])];
    }
    if (patch.reason) cur.reasons.add(patch.reason);
    candidates.set(pattern, cur);
  };

  // 1. Recently intercepted / force-opened duplicate tabs
  for (const item of Array.isArray(interceptedDups) ? interceptedDups : []) {
    if (!item?.url) continue;
    const cand = deriveCandidatePathRule(item.url);
    if (!cand || isAlreadyCoveredByNarrowRule(cand.pattern)) continue;
    upsert(cand.pattern, {
      host: cand.host,
      isConfigSystem: cand.isConfigSystem,
      interceptCount: Number(item.count) || 1,
      forcedOpenCount: item.forcedOpen ? 1 : 0,
      reason: item.forcedOpen
        ? `你曾在该路径下点击「仍要双开」，建议按路径通配放行多开`
        : `该路径近期触发过重复标签拦截，若需多开对比可放行此路径`,
    });
  }

  // 2. Currently open multi-tab path clusters & exact duplicate URLs
  const byPattern = new Map();
  const byNormUrl = new Map();
  for (const t of httpTabs) {
    const nu = normUrlKey(t.url);
    byNormUrl.set(nu, (byNormUrl.get(nu) || 0) + 1);
    const cand = deriveCandidatePathRule(t.url);
    if (!cand) continue;
    const list = byPattern.get(cand.pattern) || { cand, tabs: [], distinctQueryOrPath: new Set() };
    list.tabs.push(t);
    list.distinctQueryOrPath.add(nu);
    byPattern.set(cand.pattern, list);
  }

  // 3. Check if any existing bare-host whitelist rule is overly broad and can be tightened to active modules (1..3 modules)
  for (const existing of compiledExisting) {
    if (existing.compiled.type !== 'host') continue;
    const hostKey = existing.compiled.key.toLowerCase();
    const matchingPatterns = [...byPattern.values()].filter(
      entry => (entry.cand.host === hostKey || entry.cand.apexDomain === hostKey) && entry.tabs.length >= 2,
    );
    if (matchingPatterns.length >= 1 && matchingPatterns.length <= 3) {
      for (const target of matchingPatterns) {
        upsert(target.cand.pattern, {
          kind: 'refine',
          replaces: existing.raw,
          replacesList: [existing.raw],
          changes: [`收敛整站 ${existing.raw}`],
          host: target.cand.host,
          isConfigSystem: target.cand.isConfigSystem,
          reason: `现有白名单「${existing.raw}」放行整站范围过大，建议结合新开页面收敛为工作路径「${target.cand.prefixLabel}/*」`,
        });
      }
    }
  }

  // 3b. Iterative consolidation: if >=2 narrow subpath rules (or existing + new sibling subpath) share one parent module rule, suggest merging cleanly
  for (const { cand, tabs: memberTabs } of byPattern.values()) {
    if (memberTabs.length < 2) continue;
    const sampleBase = cand.pattern.replace(/\*+$/, '');
    const overlappingNarrow = compiledExisting.filter(e => {
      if (e.compiled.type === 'host' || e.compiled.type === 'regex') return false;
      const cleanExisting = e.raw.replace(/\*+$/, '');
      const cleanBase = sampleBase.replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
      const normExisting = cleanExisting.replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();
      return normExisting.startsWith(cleanBase) && normExisting.length > cleanBase.length;
    });
    if (overlappingNarrow.length >= 2 || (overlappingNarrow.length === 1 && !isAlreadyCoveredByNarrowRule(cand.pattern))) {
      const repList = overlappingNarrow.map(e => e.raw);
      upsert(cand.pattern, {
        kind: 'refine',
        replaces: repList[0],
        replacesList: repList,
        changes: [`叠加合并 ${repList.length} 条子路径`],
        host: cand.host,
        isConfigSystem: cand.isConfigSystem,
        reason: `结合现有规则「${repList[0]}」与新开同模块页面，建议合并为「${cand.prefixLabel}/*」统一放行并保留其余路径防重`,
      });
    }
  }

  // 4. Recommend path wildcard rules for active multi-open config/workbench clusters
  for (const { cand, tabs: memberTabs } of byPattern.values()) {
    if (isAlreadyCoveredByNarrowRule(cand.pattern)) continue;
    const hasExactDup = memberTabs.some(t => (byNormUrl.get(normUrlKey(t.url)) || 0) >= 2);
    const contentSamples = memberTabs
      .map(t => String(t.snippet || t.cachedSummary || t.manualTitle || t.title || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const distinctContentCount = new Set(contentSamples.map(s => s.slice(0, 60).toLowerCase())).size;
    const hasContentVariance = distinctContentCount >= 2;
    if (!cand.isConfigSystem && !hasExactDup && !hasContentVariance && memberTabs.length < 3) continue;
    if (memberTabs.length < 2) continue;
    const BroadHostCovered = compiledExisting.find(
      e => e.compiled.type === 'host' && (e.compiled.key === cand.host || e.compiled.key === cand.apexDomain),
    );
    if (BroadHostCovered && candidates.has(cand.pattern)) continue;
    upsert(cand.pattern, {
      host: cand.host,
      isConfigSystem: cand.isConfigSystem,
      dupUrlCount: hasExactDup ? 1 : 0,
      reason: hasExactDup
        ? `当前窗口已同时多开该路径下的相同链接（${memberTabs.length} 个标签），建议添加路径白名单避免新开被拦截`
        : hasContentVariance
          ? `结合页面内容分析：${memberTabs.length} 个同路径页展示不同配置/上下文，添加路径通配后可自由多开对比`
          : `检测到 ${memberTabs.length} 个同路径配置/工作台标签并行打开，添加路径通配后可在该模块下自由多开对比`,
    });
  }

  const out = [];
  for (const item of candidates.values()) {
    const evalRes = evaluateWhitelistPatternAgainstTabs(item.rule, httpTabs);
    if (!evalRes.ok || evalRes.matchedCount === 0) continue;
    const score = (item.kind === 'refine' ? 40 : 0)
      + item.forcedOpenCount * 35
      + item.interceptCount * 25
      + item.dupUrlCount * 20
      + (item.isConfigSystem ? 15 : 0)
      + evalRes.matchedCount * 3;
    out.push({
      rule: item.rule,
      kind: item.kind,
      ...(item.replaces ? { replaces: item.replaces } : {}),
      ...(item.replacesList?.length ? { replacesList: item.replacesList } : {}),
      ...(item.changes?.length ? { changes: item.changes } : {}),
      reason: [...item.reasons][0] || `匹配当前 ${evalRes.matchedCount} 个并行工作台标签`,
      matchedCount: evalRes.matchedCount,
      matchedTabIds: evalRes.matchedTabIds,
      sampleTitles: evalRes.sampleTitles,
      confidence: score >= 35 ? 'high' : 'medium',
      source: 'heuristic',
      _score: score,
    });
  }

  return out
    .sort((a, b) => b._score - a._score)
    .slice(0, 6)
    .map(({ _score: _s, ...rest }) => rest);
}

const AGGREGATION_NOISE_PARAMS = new Set([
  'spm', 'from', 'ref', 'source', '_t', 't', 'timestamp', 'ts', 'lang', 'locale',
  'theme', 'redirect', 'redirect_uri', 'callback', 'session', 'token', 'code', 'state',
  'x-requested-with', 'v', 'version',
]);

const AGGREGATION_PRIORITY_PARAMS = new Set([
  'spaceid', 'site', 'env', 'stage', 'namespace', 'ns',
  'project', 'projectid', 'appid', 'app', 'cluster', 'region', 'tenant', 'tenantid',
  'branch', 'pipeline', 'pipelineid', 'workspace', 'workspaceid', 'repo', 'org', 'group',
]);

export function extractMeaningfulQueryParams(rawUrl) {
  const map = new Map();
  try {
    const u = new URL(String(rawUrl || ''));
    const sources = [u.searchParams];
    if (u.hash && u.hash.includes('?')) {
      const hq = u.hash.slice(u.hash.indexOf('?') + 1);
      if (hq) sources.push(new URLSearchParams(hq));
    }
    for (const sp of sources) {
      for (const [k, v] of sp.entries()) {
        const key = String(k || '').trim();
        const val = String(v || '').trim();
        if (!key || !val) continue;
        const low = key.toLowerCase();
        if (low.startsWith('utm_') || low.startsWith('spm_') || AGGREGATION_NOISE_PARAMS.has(low)) continue;
        const arr = map.get(key) || [];
        arr.push(val);
        map.set(key, arr);
      }
    }
  } catch { /* ignore */ }
  const out = {};
  for (const [k, vals] of map.entries()) {
    out[k] = [...new Set(vals)].sort().join(',');
  }
  return out;
}

export function evaluateAggregationRuleAgainstTabs(rawRule, tabs = []) {
  const parsed = parseAggregationRule(rawRule, { strict: true });
  if (!parsed.ok) return { ok: false, message: parsed.message || '聚合层级规则无效' };
  const compiled = [{ ...parsed.rule, regex: parsed.matcher.regex, matcherType: parsed.matcher.type }];
  const buckets = new Map();
  const matchedTabIds = [];
  for (const t of Array.isArray(tabs) ? tabs : []) {
    const rawUrl = String(t?.url || '');
    if (!/^https?:\/\//i.test(rawUrl)) continue;
    const idn = resolveTabAggregationIdentity(t, compiled);
    if (!idn.matched) continue;
    matchedTabIds.push(Number(t.id));
    const bucket = buckets.get(idn.aggregationKey) || { aggregationKey: idn.aggregationKey, count: 0, sampleTitles: [] };
    bucket.count += 1;
    const title = String(t.manualTitle || t.title || rawUrl).slice(0, 48);
    if (bucket.sampleTitles.length < 3) bucket.sampleTitles.push(title);
    buckets.set(idn.aggregationKey, bucket);
  }
  const sortedBuckets = [...buckets.values()].sort((a, b) => b.count - a.count || a.aggregationKey.localeCompare(b.aggregationKey));
  return {
    ok: true,
    rule: parsed.rule,
    matchedCount: matchedTabIds.length,
    distinctKeysCount: sortedBuckets.length,
    matchedTabIds,
    buckets: sortedBuckets,
  };
}

function tabContentTokens(tab) {
  const raw = [
    tab?.manualTitle || tab?.title || '',
    tab?.snippet || tab?.cachedSummary || '',
  ].join(' ').toLowerCase();
  const matches = raw.match(/[\p{Script=Han}]{2,6}|[a-z0-9][a-z0-9._-]{2,}/gu) || [];
  return new Set(matches);
}

function tokenJaccard(a, b) {
  if (!a.size || !b.size) return 0.5;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 1;
}

export function buildAggregationRuleSuggestions(tabs = [], { existingRules = [] } = {}) {
  const httpTabs = (Array.isArray(tabs) ? tabs : []).filter(t => /^https?:\/\//i.test(String(t?.url || '')));
  const compiledExisting = normalizeAggregationRules(existingRules);
  const byPattern = new Map();

  for (const t of httpTabs) {
    const prof = t.urlProfile || extractUrlProfile(t.url);
    if (!prof.valid) continue;
    // Skip doc hubs unless explicit business query params differentiate content cleanly
    const qParams = extractMeaningfulQueryParams(t.url);
    const hasParams = Object.keys(qParams).length > 0;
    if (prof.isDocHub && !hasParams) continue;

    const cand = deriveCandidatePathRule(t.url);
    if (!cand) continue;
    const entry = byPattern.get(cand.pattern) || { cand, tabs: [], profs: [], qMaps: [], tokens: [] };
    entry.tabs.push(t);
    entry.profs.push(prof);
    entry.qMaps.push(qParams);
    entry.tokens.push(tabContentTokens(t));
    byPattern.set(cand.pattern, entry);
  }

  const out = [];
  for (const { cand, tabs: memberTabs, profs, qMaps, tokens } of byPattern.values()) {
    if (memberTabs.length < 2) continue;

    // 1. Analyze stable non-ID segment depth across member tabs
    const nonIdDepths = profs.map(p => {
      let d = 0;
      for (const seg of p.normalizedSegments) {
        if (seg === '*' || d >= 5) break;
        d += 1;
      }
      return d;
    });
    const maxNonIdDepth = Math.max(...nonIdDepths, 1);
    let recommendedDepth = null;
    // Find shallowest depth >= 2 where either non-ID segments differentiate modules or path ends before ID
    const minNonIdDepth = Math.min(...nonIdDepths);
    for (let d = Math.max(2, cand.prefixLabel.split('/').length - 1); d <= Math.min(4, maxNonIdDepth); d++) {
      const segVals = new Set(profs.map(p => p.pathSegments.slice(0, d).join('/')));
      if (segVals.size >= 2) {
        recommendedDepth = d;
        break;
      }
    }
    if (recommendedDepth === null && profs.some(p => p.normalizedSegments.includes('*'))) {
      recommendedDepth = Math.min(5, Math.max(2, minNonIdDepth));
    }

    // 2. Analyze query keys by cardinality + priority + content divergence across member tabs
    const keyStats = new Map();
    for (let i = 0; i < memberTabs.length; i++) {
      for (const [k, val] of Object.entries(qMaps[i])) {
        const stat = keyStats.get(k) || { key: k, count: 0, values: new Map() };
        stat.count += 1;
        const list = stat.values.get(val) || [];
        list.push(i);
        stat.values.set(val, list);
        keyStats.set(k, stat);
      }
    }

    const rankedKeys = [];
    for (const stat of keyStats.values()) {
      const distinctValues = stat.values.size;
      const isPriority = AGGREGATION_PRIORITY_PARAMS.has(stat.key.toLowerCase());
      if (distinctValues < 2 && !(isPriority && stat.count >= 2 && profs.some(p => p.normalizedSegments.includes('*')))) {
        continue;
      }
      // Compute whether distinct param values correlate with divergent page content/title
      let crossPairs = 0;
      let crossDissimilar = 0;
      const bucketsIndices = [...stat.values.values()];
      for (let bi = 0; bi < bucketsIndices.length; bi++) {
        for (let bj = bi + 1; bj < bucketsIndices.length; bj++) {
          const ti = bucketsIndices[bi][0];
          const tj = bucketsIndices[bj][0];
          crossPairs += 1;
          if (tokenJaccard(tokens[ti], tokens[tj]) < 0.65) crossDissimilar += 1;
        }
      }
      const contentDivBonus = crossPairs ? (crossDissimilar / crossPairs) * 25 : 0;
      const score = distinctValues * 20 + (isPriority ? 18 : 0) + stat.count * 4 + contentDivBonus;
      rankedKeys.push({ key: stat.key, distinctValues, hasContentDiv: crossDissimilar > 0, score });
    }
    rankedKeys.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    const queryKeys = rankedKeys.slice(0, 3).map(k => k.key);

    const sampleUrl = cand.pattern.replace(/\*+$/, 'sample');
    const refineTarget = compiledExisting.find(ex => ex.regex.test(sampleUrl)) || null;
    const existingKeys = Array.isArray(refineTarget?.queryKeys) ? refineTarget.queryKeys : [];
    const existingKeysLower = new Set(existingKeys.map(k => k.toLowerCase()));
    const mergedQueryKeys = refineTarget
      ? [...existingKeys, ...queryKeys.filter(k => !existingKeysLower.has(k.toLowerCase()))].slice(0, 5)
      : queryKeys;

    const addedKeys = refineTarget
      ? mergedQueryKeys.filter(k => !existingKeysLower.has(k.toLowerCase()))
      : mergedQueryKeys;
    const targetDepth = recommendedDepth !== null ? recommendedDepth : (refineTarget?.pathDepth ?? null);
    const depthChanged = Boolean(refineTarget && (refineTarget.pathDepth ?? null) !== (targetDepth ?? null));

    if (refineTarget && !addedKeys.length && !depthChanged) continue;
    if (!mergedQueryKeys.length && targetDepth === null) continue;

    const targetPattern = refineTarget
      ? (refineTarget.matcherType === 'host' ? cand.pattern : refineTarget.pattern)
      : cand.pattern;
    const candidateRule = {
      pattern: targetPattern,
      pathDepth: targetDepth,
      queryKeys: mergedQueryKeys,
    };
    const evalRes = evaluateAggregationRuleAgainstTabs(candidateRule, httpTabs);
    if (!evalRes.ok || evalRes.matchedCount < 2 || evalRes.distinctKeysCount < 2) continue;

    const kind = refineTarget ? 'refine' : 'add';
    const hasContentSnippet = memberTabs.some(t => Boolean(t.snippet || t.cachedSummary));
    const changes = [];
    if (refineTarget) {
      if (addedKeys.length) changes.push(`+${addedKeys.join(',')}`);
      if (depthChanged) changes.push(`L${refineTarget.pathDepth ?? '自动'}→L${targetDepth ?? '自动'}`);
      if (refineTarget.matcherType === 'host' && targetPattern !== refineTarget.pattern) changes.push('路径收敛');
    }
    const reasonParts = [];
    if (refineTarget) {
      if (addedKeys.length) {
        reasonParts.push(`结合新开页面正文与参数，在保留「${existingKeys.join(',') || targetPattern}」基础上叠加区分参数 ${addedKeys.join('、')}`);
      } else if (depthChanged) {
        reasonParts.push(`结合新开页面路径变化，将 Path 截断从 L${refineTarget.pathDepth ?? '自动'} 调整为 L${targetDepth ?? '自动'}`);
      }
    } else {
      if (mergedQueryKeys.length) {
        reasonParts.push(`按页面内容与参数对比，该路径下 ${mergedQueryKeys.join('、')} 参数对应不同空间/配置环境`);
      }
      if (targetDepth != null) {
        reasonParts.push(`按第 ${targetDepth} 级路径聚合可合并动态详情 ID 并区分核心业务模块`);
      }
    }
    if (!hasContentSnippet && evalRes.distinctKeysCount >= 2) {
      reasonParts.push(`可将 ${evalRes.matchedCount} 个页面清晰拆分为 ${evalRes.distinctKeysCount} 个聚合桶`);
    } else if (hasContentSnippet) {
      reasonParts.push(`正文/标题主题明显分化，拆为 ${evalRes.distinctKeysCount} 个聚合标识后 AI 分组更精准`);
    }

    const score = (kind === 'refine' ? 30 : 0)
      + mergedQueryKeys.length * 22
      + evalRes.distinctKeysCount * 14
      + evalRes.matchedCount * 4
      + (cand.isConfigSystem ? 15 : 0);

    out.push({
      rule: evalRes.rule,
      kind,
      ...(refineTarget ? { replaces: refineTarget.id || refineTarget.pattern, replacesList: [refineTarget.id || refineTarget.pattern] } : {}),
      ...(changes.length ? { changes } : {}),
      reason: reasonParts.join('，').slice(0, 120),
      matchedCount: evalRes.matchedCount,
      distinctKeysCount: evalRes.distinctKeysCount,
      bucketsPreview: evalRes.buckets.slice(0, 5),
      confidence: score >= 55 ? 'high' : 'medium',
      source: 'heuristic',
      _score: score,
    });
  }

  return out
    .sort((a, b) => b._score - a._score)
    .slice(0, 5)
    .map(({ _score: _s, ...rest }) => rest);
}
