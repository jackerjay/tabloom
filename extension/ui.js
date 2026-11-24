/* 共享 UI：状态胶囊、模型选择器、toast */
const COLOR_HEX = {
  grey: '#9aa0a6', blue: '#8ab4f8', red: '#f28b82', yellow: '#fdd663', green: '#81c995',
  pink: '#ff8bcb', purple: '#c58af9', cyan: '#78d9ec', orange: '#fcad70',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 自动整理设置与分析反馈（首页 / 侧边栏共享） */
const AUTO_DELAY_OPTIONS = [
  { seconds: 30, label: '30 秒' }, { seconds: 60, label: '1 分钟' },
  { seconds: 300, label: '5 分钟' }, { seconds: 900, label: '15 分钟' },
];
const AUTO_DELAY_MIN_SECONDS = 5;
const AUTO_DELAY_MAX_SECONDS = 3600;
const AUTO_DISCARD_OPTIONS = [
  { minutes: 15, label: '15 分钟' }, { minutes: 30, label: '30 分钟' },
  { minutes: 60, label: '1 小时' }, { minutes: 240, label: '4 小时' },
  { minutes: 1440, label: '24 小时' },
];
const AUTO_DISCARD_MIN_MINUTES = 5;
const AUTO_DISCARD_MAX_MINUTES = 43200;

function normalizeIntInRange(value, min, max, fallback) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return fallback;
  const num = (typeof value === 'number' || typeof value === 'string') ? Number(String(value).trim()) : NaN;
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback;
}
function normalizeAutoDelay(value) {
  return normalizeIntInRange(value, AUTO_DELAY_MIN_SECONDS, AUTO_DELAY_MAX_SECONDS, 30);
}
function normalizeAutoDiscardMinutes(value) {
  return normalizeIntInRange(value, AUTO_DISCARD_MIN_MINUTES, AUTO_DISCARD_MAX_MINUTES, 60);
}
function formatAutoDelayLabel(seconds) {
  const sec = normalizeAutoDelay(seconds);
  const preset = AUTO_DELAY_OPTIONS.find(option => option.seconds === sec);
  if (preset) return preset.label;
  if (sec >= 60) {
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${mins} 分 ${rem} 秒` : `${mins} 分钟`;
  }
  return `${sec} 秒`;
}
function formatAutoDiscardLabel(minutes) {
  const mins = normalizeAutoDiscardMinutes(minutes);
  const preset = AUTO_DISCARD_OPTIONS.find(option => option.minutes === mins);
  if (preset) return preset.label;
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs} 小时 ${rem} 分钟` : `${hrs} 小时`;
  }
  return `${mins} 分钟`;
}
function paintDurationSelect(select, value, { options, key, normalize, formatLabel, allowCustom = true }) {
  if (!select) return;
  const normalized = normalize(value);
  select.innerHTML = '';
  for (const option of options) select.add(new Option(option.label, String(option[key])));
  if (!options.some(option => option[key] === normalized)) {
    select.add(new Option(`${formatLabel(normalized)}（自定义）`, String(normalized)));
  }
  if (allowCustom && select.dataset?.allowCustomDelay !== 'false') {
    select.add(new Option('自定义时长…', '__custom__'));
  }
  select.value = String(normalized);
  if (typeof syncSearchableSelect === 'function') syncSearchableSelect(select);
}
function paintAutoDelay(select, value, { allowCustom = true } = {}) {
  paintDurationSelect(select, value, {
    options: AUTO_DELAY_OPTIONS,
    key: 'seconds',
    normalize: normalizeAutoDelay,
    formatLabel: formatAutoDelayLabel,
    allowCustom,
  });
}
function paintAutoDiscard(select, value, { allowCustom = true } = {}) {
  paintDurationSelect(select, value, {
    options: AUTO_DISCARD_OPTIONS,
    key: 'minutes',
    normalize: normalizeAutoDiscardMinutes,
    formatLabel: formatAutoDiscardLabel,
    allowCustom,
  });
}
function analysisSummary(result) {
  const titles = result?.titleStats, cache = result?.cache, audit = result?.aggregationAudit, parts = [];
  const count = value => Math.max(0, Number(value) || 0);
  if (titles) {
    parts.push(`更新 ${count(titles.updated)} 个标签标题`);
    if (count(titles.unchanged)) parts.push(`${count(titles.unchanged)} 个标题未变`);
    if (count(titles.skipped)) parts.push(`${count(titles.skipped)} 页保留原标题`);
  }
  if (cache) {
    parts.push(`复用 ${count(cache.hits)} 页缓存`);
    if (count(cache.misses)) parts.push(`${count(cache.misses)} 页未命中缓存`);
  }
  if (audit?.checked) {
    if (count(audit.consolidatedCount) > 0) parts.push(`聚合检查合并 ${count(audit.consolidatedCount)} 处拆分组`);
    else if (count(audit.issueCountAfter) > 0) parts.push(`聚合检查提示 ${count(audit.issueCountAfter)} 处可合并`);
  }
  return parts.join('，');
}

/* Prefixes override the selected source for this input only; ordinary words stay literal. */
function parseSearchInput(value, fallbackProvider = 'all') {
  const raw = String(value ?? '');
  const base = ['all', 'tabs', 'bookmarks', 'history', 'google'].includes(fallbackProvider) ? fallbackProvider : 'all';
  const match = raw.match(/^\s*([bhg])\s+([\s\S]*)$/i);
  if (!match) return { query: raw.trim(), provider: base, prefix: null };
  const cmd = match[1].toLowerCase();
  const provider = cmd === 'g' ? 'google' : cmd === 'h' ? 'history' : 'bookmarks';
  return { query: match[2].trim(), provider, prefix: cmd };
}

const NON_URL_FILE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'html', 'htm',
  'json', 'md', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico',
  'mp4', 'mov', 'webm', 'pdf', 'xml', 'yml', 'yaml', 'py', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'sh', 'zsh', 'lock', 'log', 'map',
]);

function isValidIpv4Host(host) {
  const parts = String(host || '').split('.');
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** 识别完整或省略协议的网址，返回规范化 URL 与匹配信息；普通关键词/代码文件名返回 null。 */
function parseDirectUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const hasExplicitScheme = /^https?:\/\//i.test(raw);
  if (!hasExplicitScheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null;

  let candidate = raw;
  if (!hasExplicitScheme) {
    const isLocalHost = /^localhost(?::\d{1,5}(?:[/?#].*)?|[/?#].*)$/i.test(raw);
    const ipMatch = raw.match(/^((?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:[/?#].*)?$/);
    if (isLocalHost) {
      candidate = `http://${raw}`;
    } else if (ipMatch && isValidIpv4Host(ipMatch[1])) {
      candidate = `http://${raw}`;
    } else {
      const m = raw.match(/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::(\d{1,5}))?([/?#].*)?$/i);
      if (!m) return null;
      const [, host, port, tail] = m;
      const tld = host.split('.').pop().toLowerCase();
      if (!/^[a-z]{2,}$/.test(tld)) return null;
      if (!port && !tail && NON_URL_FILE_EXTS.has(tld)) return null;
      candidate = `https://${raw}`;
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (!host) return null;
  if (host !== 'localhost' && !isValidIpv4Host(host)) {
    const parts = host.split('.');
    if (parts.length < 2 || !/^[a-z]{2,}$/.test(parts[parts.length - 1])) return null;
  }
  const hasExplicitPath = (parsed.pathname && parsed.pathname !== '/') || !!parsed.search || !!parsed.hash;
  const pathPart = parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname;
  return {
    url: parsed.href,
    host,
    origin: parsed.origin,
    hasExplicitPath,
    normalized: `${parsed.host.toLowerCase()}${pathPart}${parsed.search}${parsed.hash}`,
  };
}

function normalizeUrlForMatch(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    const p = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return {
      base: `${u.protocol}//${u.host.toLowerCase()}${p}${u.search}`,
      hostPath: `${u.host.toLowerCase()}${p}${u.search}`,
      host: u.hostname.toLowerCase(),
      hasExplicitPath: (p !== '' && p !== '/') || !!u.search || !!u.hash,
      hash: u.hash || '',
    };
  } catch {
    return null;
  }
}

function urlsMatchForDirectJump(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = normalizeUrlForMatch(a);
  const nb = normalizeUrlForMatch(b);
  if (!na || !nb || na.base !== nb.base) return false;
  if (nb.hash && na.hash !== nb.hash) return false;
  return true;
}

const textVectorCache = new Map();
/** 构建中英文混合稀疏 TF 向量（词项 + 字符双字 n-gram，L2 归一化）。 */
function buildTextVector(text) {
  const s = String(text || '').toLowerCase().trim();
  if (!s) return { map: null, norm: 0 };
  const cached = textVectorCache.get(s);
  if (cached) return cached;
  const tf = new Map();
  const add = (key, weight) => { tf.set(key, (tf.get(key) || 0) + weight); };
  const words = s.match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    add(`w:${w}`, 2.2);
    for (let i = 0; i + 2 <= w.length; i++) add(`c:${w.slice(i, i + 2)}`, 0.75);
  }
  const chars = [...s.replace(/\s+/g, '')];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!/[a-z0-9]/.test(ch)) {
      add(`u:${ch}`, 0.65);
      if (i + 1 < chars.length && !/[a-z0-9]/.test(chars[i + 1])) add(`b:${ch}${chars[i + 1]}`, 1.75);
    }
  }
  let sq = 0;
  for (const [k, raw] of tf) {
    const typeScale = k.startsWith('u:') ? 0.65 : k.startsWith('w:') ? 1.45 : 1.15;
    const w = (1 + Math.log(Math.max(1, raw))) * typeScale;
    tf.set(k, w);
    sq += w * w;
  }
  const vec = { map: tf, norm: Math.sqrt(sq) };
  if (textVectorCache.size > 600) textVectorCache.clear();
  textVectorCache.set(s, vec);
  return vec;
}

function vectorCosineSimilarity(qVec, dVec) {
  if (!qVec?.map || !dVec?.map || !qVec.norm || !dVec.norm) return { cosine: 0, strongHits: 0 };
  let dot = 0;
  let strongHits = 0;
  for (const [k, qw] of qVec.map) {
    const dw = dVec.map.get(k);
    if (dw) {
      dot += qw * dw;
      if (!k.startsWith('u:')) strongHits++;
    }
  }
  return { cosine: dot / (qVec.norm * dVec.norm), strongHits };
}

function scoreSubsequence(hay, needle) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * 关键字向量检索打分：融合多字段加权余弦相似度、词元覆盖率与前缀/精确匹配加权。
 * @param {string} query
 * @param {Array<{text: string, weight?: number}>|string[]} fields
 */
function vectorSearchScore(query, fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  const normalized = (Array.isArray(fields) ? fields : [fields])
    .map(item => (item && typeof item === 'object' ? { text: String(item.text || ''), weight: Number(item.weight) || 1 } : { text: String(item || ''), weight: 1 }))
    .filter(item => item.text.trim().length > 0);
  if (!normalized.length) return 0;

  const qVec = buildTextVector(q);
  const tokens = q.split(/\s+/).filter(Boolean);
  const qLen = [...q.replace(/\s+/g, '')].length;
  let maxLexical = 0;
  let bestWeightedCosine = 0;
  let sumWeightedCosine = 0;
  let maxRawCosine = 0;
  let maxStrongHits = 0;

  const hays = normalized.map(({ text, weight }) => {
    const raw = text.trim().toLowerCase();
    let lex = 0;
    if (raw === q) lex = 2.0;
    else if (raw.startsWith(q)) lex = 1.25;
    else if (raw.includes(q)) lex = 0.65;
    if (lex * weight > maxLexical) maxLexical = lex * weight;
    const { cosine, strongHits } = vectorCosineSimilarity(qVec, buildTextVector(raw));
    const wc = cosine * weight;
    if (wc > bestWeightedCosine) bestWeightedCosine = wc;
    sumWeightedCosine += wc;
    if (cosine > maxRawCosine) maxRawCosine = cosine;
    if (strongHits > maxStrongHits) maxStrongHits = strongHits;
    return { raw, weight };
  });

  let matchedTokens = 0;
  let tokenScoreSum = 0;
  for (const tok of tokens) {
    let bestTok = 0;
    for (const { raw, weight } of hays) {
      let s = 0;
      if (raw.startsWith(tok)) s = 1.0 * weight;
      else if (raw.includes(tok)) s = 0.8 * weight;
      else if (tok.length >= 2 && scoreSubsequence(raw, tok)) s = 0.4 * weight;
      if (s > bestTok) bestTok = s;
    }
    if (bestTok > 0) {
      matchedTokens++;
      tokenScoreSum += bestTok;
    }
  }

  const allTokensMatched = matchedTokens === tokens.length;
  const strongVecHit = maxRawCosine >= 0.28 && maxStrongHits >= (qLen <= 2 ? 1 : 2);
  if (!allTokensMatched && !strongVecHit) return 0;

  const tokenCoverage = tokens.length ? matchedTokens / tokens.length : 0;
  return maxLexical + (tokenScoreSum / Math.max(1, tokens.length)) * 0.55 + tokenCoverage * 0.35 + bestWeightedCosine * 4.5 + sumWeightedCosine * 0.45;
}

/* Search command diagnostics use the loaded manifest, not files on disk. */
function describeSearchShortcut(manifest, commands) {
  const search = commands.find(command => command.name === 'search-tabs');
  const action = commands.find(command => command.name === '_execute_action');
  const label = '打开搜索（标签 / 书签 / Google）';
  if (!manifest.commands?.['search-tabs']) return { state: 'missing', shortcut: '', message: `当前加载的扩展 v${manifest.version || '未知'} 没有搜索命令。请重新加载 v0.3.1；“激活该扩展程序”不是搜索入口。` };
  if (!search) return { state: 'unregistered', shortcut: '', message: '搜索命令已声明但未注册，请检查扩展错误并重新加载。' };
  const version = String(manifest.version || '0').split('.').map(Number);
  if ((version[0] || 0) === 0 && (version[1] || 0) < 3) return { state: 'outdated', shortcut: search.shortcut || '', message: `当前加载 v${manifest.version}，仍是独立搜索窗口版本。请重新加载 v0.3.1，启用当前页内搜索浮层。` };
  if (version[0] === 0 && version[1] === 3 && (version[2] || 0) < 1) return { state: 'outdated', shortcut: search.shortcut || '', message: '当前加载 v0.3.0，侧栏搜索路由仍是旧版。请重新加载 v0.3.1，让搜索转交主页面并居中显示。' };
  if (!search.shortcut) return { state: action?.shortcut ? 'activation-bound' : 'unassigned', shortcut: '', message: action?.shortcut
    ? `“激活该扩展程序”已绑定 ${action.shortcut}，但搜索未绑定。请清除这项绑定，将 ⌘K 绑定到“${label}”。`
    : `搜索尚未绑定快捷键。请在“${label}”一行配置 ⌘K（Windows/Linux 为 Ctrl+K）。` };
  return { state: 'ready', shortcut: search.shortcut, message: `搜索已绑定 ${search.shortcut}。需要跨应用使用时，请在该命令的“范围”中选择“全局”；范围以 Chrome 设置为准。` };
}
async function refreshSearchCommand(statusEl, versionEl = null, hintEl = null) {
  if (!statusEl) return;
  try {
    const manifest = chrome.runtime.getManifest();
    if (versionEl) versionEl.textContent = `已加载 v${manifest.version} · ${chrome.runtime.id}`;
    const diagnosis = describeSearchShortcut(manifest, await chrome.commands.getAll());
    statusEl.textContent = diagnosis.message;
    statusEl.dataset.state = diagnosis.state;
    if (hintEl) hintEl.textContent = diagnosis.shortcut || '未绑定';
    return diagnosis;
  } catch {
    statusEl.dataset.state = 'unknown';
    statusEl.textContent = '无法读取已加载扩展的命令。请在 Chrome 快捷键设置中确认搜索命令，不要绑定“激活该扩展程序”。';
    if (hintEl) hintEl.textContent = '未确认';
  }
}

/* 统一描边图标系统（替代 Unicode 字形 / emoji） */
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  spinner: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  signal: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  starFilled: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/>',
};
function icon(name, size = 14, cls = '') {
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

/* ---------------- 通用可搜索下拉框组件（Progressive Enhancement） ---------------- */
let activeSearchableSelect = null;

function syncSearchableSelect(selectEl) {
  selectEl?._searchableSelect?.sync?.();
}

function closeActiveSearchableSelect({ returnFocus = false } = {}) {
  if (activeSearchableSelect) activeSearchableSelect.close({ returnFocus });
}

let activeGroupCloseMenu = null;
function closeActiveGroupCloseMenu() {
  if (!activeGroupCloseMenu) return;
  const { el, cleanup, anchorEl } = activeGroupCloseMenu;
  activeGroupCloseMenu = null;
  cleanup?.();
  el?.remove?.();
  anchorEl?.setAttribute?.('aria-expanded', 'false');
}

function startInlineRename({
  textEl,
  currentTitle = '',
  inputClass = 'gname-input',
  maxLength = 60,
  ariaLabel = '输入名称',
  placeholder = '输入名称…',
  onSave,
  onFinish,
} = {}) {
  if (!textEl || !textEl.parentElement) return;
  const parent = textEl.parentElement;
  if (parent.querySelector(`.${inputClass}`)) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClass;
  input.maxLength = maxLength;
  input.value = String(currentTitle || '');
  const tr = s => (typeof translateUiText === 'function' ? translateUiText(s) : s);
  input.setAttribute('aria-label', tr(ariaLabel));
  input.placeholder = tr(placeholder);

  let settled = false;
  const finish = async commit => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    textEl.hidden = false;
    input.remove();
    const changed = Boolean(commit && next && next !== String(currentTitle || '').trim());
    if (changed) await onSave?.(next);
    onFinish?.({ committed: changed, next });
  };

  for (const ev of ['click', 'dblclick', 'mousedown', 'pointerdown']) {
    input.addEventListener(ev, e => e.stopPropagation());
  }
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => { finish(true); });

  textEl.hidden = true;
  textEl.insertAdjacentElement('afterend', input);
  input.focus();
  input.select();
}

function startInlineGroupRename({ nameEl, currentTitle = '', onSave, onFinish } = {}) {
  return startInlineRename({
    textEl: nameEl,
    currentTitle,
    inputClass: 'gname-input',
    maxLength: 60,
    ariaLabel: '输入分组名称',
    placeholder: '输入分组名称…',
    onSave,
    onFinish,
  });
}

function bindTabTitleDoubleClick({ titleBtn, currentTitle = '', onActivate, onSave, onFinish } = {}) {
  if (!titleBtn) return;
  let clickTimer = null;
  titleBtn.onclick = e => {
    e.stopPropagation();
    if (e?.detail >= 2) {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      return;
    }
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      clickTimer = null;
      onActivate?.();
    }, 210);
  };
  titleBtn.ondblclick = e => {
    e.stopPropagation();
    e.preventDefault();
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    startInlineRename({
      textEl: titleBtn,
      currentTitle,
      inputClass: 'tname-input',
      maxLength: 80,
      ariaLabel: '输入标签名称',
      placeholder: '输入标签名称…',
      onSave,
      onFinish,
    });
  };
}

function openGroupCloseMenu({
  anchorEl,
  groupTitle = '',
  tabCount = 0,
  locked = false,
  manualNamed = false,
  onRename,
  onSaveClose,
  onForceClose,
  onToggleLock,
} = {}) {
  if (!anchorEl) return;
  if (activeGroupCloseMenu?.anchorEl === anchorEl) {
    closeActiveGroupCloseMenu();
    return;
  }
  closeActiveGroupCloseMenu();
  const tr = s => (typeof translateUiText === 'function' ? translateUiText(s) : s);
  const isEn = typeof getUiLang === 'function' && getUiLang() === 'en';
  const menu = document.createElement('div');
  menu.className = 'group-close-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', tr('关闭或保护分组'));

  const titleRow = document.createElement('div');
  titleRow.className = 'group-close-menu-head';
  const titleSpan = document.createElement('span');
  titleSpan.className = 'group-close-menu-title';
  titleSpan.textContent = groupTitle || tr('未命名组');
  titleRow.appendChild(titleSpan);
  if (locked) {
    const lockTag = document.createElement('span');
    lockTag.className = 'group-close-menu-lock-tag';
    lockTag.innerHTML = `${icon('lock', 11)}<span>${tr('已加锁')}</span>`;
    titleRow.appendChild(lockTag);
  }
  menu.appendChild(titleRow);

  const makeItem = ({ key, ic, title, desc, danger = false, disabled = false, onClick }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `group-close-menu-item${danger ? ' is-danger' : ''}`;
    btn.setAttribute('role', 'menuitem');
    btn.dataset.action = key;
    if (disabled) btn.disabled = true;
    btn.innerHTML = `<span class="gcm-ico">${icon(ic, 14)}</span><span class="gcm-body"><span class="gcm-title">${escapeHtml(title)}</span><span class="gcm-desc">${escapeHtml(desc)}</span></span>`;
    btn.onclick = async e => {
      e.stopPropagation();
      if (btn.disabled) return;
      closeActiveGroupCloseMenu();
      await onClick?.();
    };
    return btn;
  };

  if (onRename) {
    menu.appendChild(makeItem({
      key: 'rename',
      ic: 'edit',
      title: tr('重命名分组（固定名称）'),
      desc: manualNamed
        ? tr('已手动固定名称，AI 整理不再自动改名；点击可修改')
        : tr('自定义分组名称，后续 AI 整理不再自动修改'),
      onClick: onRename,
    }));
  }

  menu.appendChild(makeItem({
    key: 'save-close',
    ic: 'undo',
    title: tr('关闭分组（保留可重新打开）'),
    desc: tr('关闭当前标签并保留分组与链接，可随时从「已关闭分组」一键重开'),
    onClick: onSaveClose,
  }));

  menu.appendChild(makeItem({
    key: 'force-close',
    ic: 'close',
    title: tr('解散并关闭所有标签页'),
    desc: locked
      ? tr('分组已加锁，解锁后才可彻底关闭')
      : (isEn ? `Permanently close all ${tabCount} tabs without saving` : `彻底关闭组内全部 ${tabCount} 个标签页，不保留恢复记录`),
    danger: true,
    disabled: locked,
    onClick: onForceClose,
  }));

  const sep = document.createElement('div');
  sep.className = 'group-close-menu-sep';
  menu.appendChild(sep);

  menu.appendChild(makeItem({
    key: 'toggle-lock',
    ic: locked ? 'unlock' : 'lock',
    title: locked ? tr('解锁分组') : tr('加锁保护分组'),
    desc: locked
      ? tr('解除加锁，允许自动清理、去重与彻底关闭')
      : tr('锁定后不允许自动清理、去重关闭或自动移出组内标签'),
    onClick: onToggleLock,
  }));

  document.body.appendChild(menu);
  anchorEl.setAttribute('aria-expanded', 'true');

  const position = () => {
    const r = anchorEl.getBoundingClientRect();
    const mw = Math.min(288, Math.max(230, window.innerWidth - 16));
    menu.style.width = `${mw}px`;
    const mh = menu.offsetHeight || 190;
    const left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw));
    const openAbove = r.bottom + mh + 10 > window.innerHeight && r.top > mh + 10;
    const top = openAbove ? Math.max(8, r.top - mh - 6) : Math.min(window.innerHeight - mh - 8, r.bottom + 6);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  };
  position();

  const onDown = e => {
    if (menu.contains(e.target) || anchorEl.contains(e.target)) return;
    closeActiveGroupCloseMenu();
  };
  const onKey = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeActiveGroupCloseMenu();
      anchorEl.focus?.();
    }
  };
  const onScroll = () => closeActiveGroupCloseMenu();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);

  activeGroupCloseMenu = {
    el: menu,
    anchorEl,
    cleanup() {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    },
  };
}

function enhanceSelect(selectEl, opts = {}) {
  if (typeof document === 'undefined' || !selectEl || selectEl.nodeName !== 'SELECT') return null;
  if (selectEl._searchableSelect) {
    selectEl._searchableSelect.updateOptions(opts);
    selectEl._searchableSelect.sync();
    return selectEl._searchableSelect;
  }

  let config = {
    variant: selectEl.classList.contains('tab-move') ? 'move' : selectEl.classList.contains('sm') ? 'sm' : 'default',
    searchPlaceholder: '搜索选项…',
    emptyText: '没有匹配项',
    minMenuWidth: 200,
    maxMenuHeight: 270,
    ...opts,
  };

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `ui-ss-trigger is-${config.variant}`;
  if (selectEl.getAttribute('aria-label')) trigger.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
  if (selectEl.getAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', selectEl.getAttribute('aria-describedby'));
  if (selectEl.title) trigger.title = selectEl.title;
  trigger.innerHTML = `<span class="ui-ss-val"></span><span class="ui-ss-chev">${icon('chevron', 12)}</span>`;

  selectEl.classList.add('ui-ss-native');
  selectEl.tabIndex = -1;
  selectEl.setAttribute('aria-hidden', 'true');
  selectEl.insertAdjacentElement('afterend', trigger);

  // 点击关联 <label> 仅聚焦触发器，不自动弹出下拉菜单（仅限点击 select 框本身展开）
  if (selectEl.id) {
    document.querySelectorAll(`label[for="${CSS.escape(selectEl.id)}"]`).forEach(lbl => {
      if (!lbl.dataset.uiSsBound) {
        lbl.dataset.uiSsBound = '1';
        lbl.addEventListener('click', e => {
          e.preventDefault();
          trigger.focus({ preventScroll: true });
        });
      }
    });
  }

  let menu = null;
  let searchInput = null;
  let listEl = null;
  let activeIndex = -1;
  let renderedItems = [];
  let cleanupFns = [];

  function trText(s) {
    return typeof translateUiText === 'function' ? translateUiText(s) : s;
  }

  function selectedOptionText() {
    const selected = selectEl.selectedOptions?.[0] || selectEl.options?.[selectEl.selectedIndex];
    const txt = selected ? selected.textContent.trim() : (config.placeholder || '请选择');
    return trText(txt);
  }

  function sync() {
    trigger.querySelector('.ui-ss-val').textContent = selectedOptionText();
    trigger.disabled = !!selectEl.disabled;
    trigger.setAttribute('aria-expanded', String(Boolean(menu)));
    trigger.classList.toggle('is-open', Boolean(menu));
    if (selectEl.title) trigger.title = trText(selectEl.title);
    if (searchInput) searchInput.placeholder = trText(config.searchPlaceholder || '搜索可用选项…');
    if (menu) renderList(searchInput?.value || '');
  }

  function buildGroups() {
    const groups = [];
    for (const child of selectEl.children) {
      if (child.tagName === 'OPTGROUP') {
        const items = [];
        for (const opt of child.children) {
          if (opt.tagName === 'OPTION') {
            items.push({ value: opt.value, label: trText(opt.textContent.trim()), disabled: opt.disabled || child.disabled, group: trText(child.label || '') });
          }
        }
        groups.push({ label: trText(child.label || ''), items });
      } else if (child.tagName === 'OPTION') {
        let ungrouped = groups.find(g => g.label === '');
        if (!ungrouped) {
          ungrouped = { label: '', items: [] };
          groups.push(ungrouped);
        }
        ungrouped.items.push({ value: child.value, label: trText(child.textContent.trim()), disabled: child.disabled, group: '' });
      }
    }
    return groups;
  }

  function matchesQuery(item, tokens) {
    if (!tokens.length) return true;
    const hay = `${item.label} ${item.value} ${item.group}`.toLowerCase();
    return tokens.every(t => hay.includes(t));
  }

  function renderHighlighted(text, tokens) {
    const span = document.createElement('span');
    span.className = 'ui-ss-opt-text';
    if (!tokens.length) {
      span.textContent = text;
      return span;
    }
    const lower = text.toLowerCase();
    const first = tokens.find(t => t && lower.includes(t));
    if (!first) {
      span.textContent = text;
      return span;
    }
    const idx = lower.indexOf(first);
    if (idx > 0) span.append(document.createTextNode(text.slice(0, idx)));
    const mark = document.createElement('mark');
    mark.className = 'ui-ss-mark';
    mark.textContent = text.slice(idx, idx + first.length);
    span.append(mark);
    if (idx + first.length < text.length) span.append(document.createTextNode(text.slice(idx + first.length)));
    return span;
  }

  function setHighlight(nextIdx) {
    if (!renderedItems.length) {
      activeIndex = -1;
      return;
    }
    activeIndex = (nextIdx + renderedItems.length) % renderedItems.length;
    renderedItems.forEach((entry, idx) => {
      entry.btn.classList.toggle('is-active', idx === activeIndex);
    });
    renderedItems[activeIndex]?.btn?.scrollIntoView?.({ block: 'nearest' });
  }

  function selectValue(val) {
    const changed = selectEl.value !== val;
    selectEl.value = val;
    close({ returnFocus: false });
    if (changed || config.alwaysEmitChange) {
      selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync();
  }

  function renderList(rawQuery = '') {
    if (!listEl) return;
    const tokens = String(rawQuery || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const groups = buildGroups();
    listEl.replaceChildren();
    renderedItems = [];
    activeIndex = -1;

    let selectedSeenIdx = -1;
    for (const g of groups) {
      const visible = g.items.filter(item => {
        if (config.hidePlaceholderOption && !item.value) return false;
        return matchesQuery(item, tokens);
      });
      if (!visible.length) continue;
      if (g.label) {
        const hdr = document.createElement('div');
        hdr.className = 'ui-ss-group';
        hdr.textContent = g.label;
        listEl.append(hdr);
      }
      for (const item of visible) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-ss-opt';
        btn.setAttribute('role', 'option');
        const isSelected = item.value === selectEl.value;
        btn.setAttribute('aria-selected', String(isSelected));
        if (isSelected) btn.classList.add('is-selected');
        if (item.disabled) btn.disabled = true;

        const labelEl = renderHighlighted(item.label, tokens);
        const checkEl = document.createElement('span');
        checkEl.className = 'ui-ss-check';
        checkEl.innerHTML = isSelected ? icon('check', 13) : '';
        btn.append(labelEl, checkEl);

        if (!item.disabled) {
          const itemIdx = renderedItems.length;
          renderedItems.push({ btn, item });
          if (isSelected && selectedSeenIdx < 0) selectedSeenIdx = itemIdx;
          btn.onmouseenter = () => setHighlight(itemIdx);
          btn.onclick = e => {
            e.stopPropagation();
            selectValue(item.value);
          };
        }
        listEl.append(btn);
      }
    }

    if (!renderedItems.length) {
      const empty = document.createElement('div');
      empty.className = 'ui-ss-empty';
      empty.textContent = config.emptyText;
      listEl.append(empty);
    } else {
      setHighlight(selectedSeenIdx >= 0 ? selectedSeenIdx : 0);
    }
  }

  function positionMenu() {
    if (!menu) return;
    if (!trigger.isConnected) {
      close({ returnFocus: false });
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(vw - 16, Math.max(rect.width, config.minMenuWidth || 200));
    menu.style.width = `${Math.round(width)}px`;

    const menuHeight = Math.min(menu.offsetHeight || 320, config.maxMenuHeight + 60);
    const spaceBelow = vh - rect.bottom - 10;
    const spaceAbove = rect.top - 10;
    const openUp = spaceBelow < Math.min(menuHeight, 220) && spaceAbove > spaceBelow;
    const top = openUp
      ? Math.max(8, rect.top - menuHeight - 5)
      : Math.min(vh - menuHeight - 8, rect.bottom + 5);
    const left = Math.max(8, Math.min(vw - width - 8, rect.left));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function open() {
    if (selectEl.disabled) return;
    if (activeSearchableSelect && activeSearchableSelect !== api) {
      activeSearchableSelect.close({ returnFocus: false });
    }
    if (menu) return;

    menu = document.createElement('div');
    menu.className = 'ui-ss-menu';
    menu.setAttribute('role', 'listbox');
    menu.onclick = e => e.stopPropagation();

    const searchWrap = document.createElement('div');
    searchWrap.className = 'ui-ss-search-wrap';
    searchWrap.innerHTML = `<span class="ui-ss-search-ico">${icon('search', 13)}</span>`;
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ui-ss-search';
    searchInput.placeholder = trText(config.searchPlaceholder);
    searchInput.autocomplete = 'off';
    searchInput.setAttribute('aria-label', trText(config.searchPlaceholder));
    searchWrap.append(searchInput);

    listEl = document.createElement('div');
    listEl.className = 'ui-ss-list';
    listEl.style.maxHeight = `${config.maxMenuHeight}px`;

    menu.append(searchWrap, listEl);
    const portalHost = selectEl.closest('dialog, [popover]:popover-open') || document.body;
    portalHost.append(menu);
    activeSearchableSelect = api;
    renderList('');
    sync();
    positionMenu();

    searchInput.focus({ preventScroll: true });
    searchInput.oninput = () => {
      renderList(searchInput.value);
      positionMenu();
    };
    searchInput.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(activeIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(activeIndex - 1);
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0 && renderedItems[activeIndex]) {
          e.preventDefault();
          selectValue(renderedItems[activeIndex].item.value);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close({ returnFocus: true });
      }
    };

    const onDocPointer = e => {
      if (!menu) return;
      if (menu.contains(e.target) || trigger.contains(e.target)) return;
      close({ returnFocus: false });
    };
    const onWinScroll = e => {
      if (!menu) return;
      if (e.target && menu.contains(e.target)) return;
      positionMenu();
    };
    const onWinResize = () => positionMenu();
    document.addEventListener('pointerdown', onDocPointer, true);
    window.addEventListener('scroll', onWinScroll, true);
    window.addEventListener('resize', onWinResize);
    cleanupFns.push(() => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      window.removeEventListener('scroll', onWinScroll, true);
      window.removeEventListener('resize', onWinResize);
    });
  }

  function close({ returnFocus = false } = {}) {
    if (!menu) return;
    cleanupFns.forEach(fn => fn());
    cleanupFns = [];
    menu.remove();
    menu = null;
    searchInput = null;
    listEl = null;
    renderedItems = [];
    activeIndex = -1;
    if (activeSearchableSelect === api) activeSearchableSelect = null;
    sync();
    if (returnFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function toggle() {
    if (menu) close({ returnFocus: false });
    else open();
  }

  trigger.onclick = e => {
    e.stopPropagation();
    toggle();
  };
  trigger.onkeydown = e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    } else if (e.key === 'Escape' && menu) {
      e.preventDefault();
      close({ returnFocus: true });
    }
  };

  if (typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver(() => sync());
    obs.observe(selectEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'title'] });
  }
  selectEl.addEventListener('change', () => sync());
  document.addEventListener('tt-lang-change', () => sync());

  const api = {
    trigger,
    sync,
    open,
    close,
    updateOptions(nextOpts = {}) {
      config = { ...config, ...nextOpts };
      trigger.className = `ui-ss-trigger is-${config.variant}`;
      sync();
    },
  };
  selectEl._searchableSelect = api;
  sync();
  return api;
}

function initDurationControl({
  selectEl,
  customRowEl,
  valueInputEl,
  unitSelectEl,
  applyBtnEl,
  cancelBtnEl,
  initialValue,
  min,
  max,
  normalize,
  paint,
  formatLabel,
  preferAltUnit,
  altUnitValue = 'min',
  baseUnitValue = 'sec',
  altMultiplier = 60,
  searchPlaceholder = '搜索时长…',
  invalidMessage,
  toastPrefix,
  onSave,
} = {}) {
  if (!selectEl) return null;
  let current = normalize(initialValue);

  if (typeof enhanceSelect === 'function') {
    enhanceSelect(selectEl, { variant: 'sm', searchPlaceholder, minMenuWidth: 195 });
    if (unitSelectEl) {
      enhanceSelect(unitSelectEl, { variant: 'sm', searchPlaceholder: '单位…', minMenuWidth: 110 });
    }
  }

  const hideCustom = () => {
    customRowEl?.classList.add('hidden');
  };

  const openCustom = () => {
    if (!customRowEl || !valueInputEl) return;
    const useAlt = preferAltUnit(current);
    if (unitSelectEl) {
      unitSelectEl.value = useAlt ? altUnitValue : baseUnitValue;
      syncSearchableSelect(unitSelectEl);
    }
    valueInputEl.value = String(useAlt ? Math.round(current / altMultiplier) : current);
    customRowEl.classList.remove('hidden');
    valueInputEl.focus();
    valueInputEl.select?.();
  };

  const commitCustom = async () => {
    if (!valueInputEl) return;
    const rawNum = Number(String(valueInputEl.value || '').trim());
    const useAlt = unitSelectEl?.value === altUnitValue;
    const rawVal = useAlt ? Math.round(rawNum * altMultiplier) : Math.round(rawNum);
    if (!Number.isFinite(rawNum) || rawNum <= 0 || rawVal < min || rawVal > max) {
      toast(invalidMessage, 'err');
      valueInputEl.focus();
      return;
    }
    current = normalize(rawVal);
    paint(selectEl, current);
    hideCustom();
    await onSave?.(current);
    toast(`${toastPrefix}：${formatLabel(current)}`, 'ok');
  };

  const applyValue = value => {
    const next = normalize(value);
    if (next === current) return;
    current = next;
    paint(selectEl, current);
    hideCustom();
  };

  selectEl.onchange = async () => {
    if (selectEl.value === '__custom__') {
      paint(selectEl, current);
      openCustom();
      return;
    }
    current = normalize(selectEl.value);
    paint(selectEl, current);
    hideCustom();
    await onSave?.(current);
    toast(`${toastPrefix}：${formatLabel(current)}`, 'ok');
  };

  if (applyBtnEl) applyBtnEl.onclick = commitCustom;
  if (cancelBtnEl) cancelBtnEl.onclick = hideCustom;
  if (valueInputEl) {
    valueInputEl.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitCustom();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideCustom();
      }
    };
  }

  paint(selectEl, current);
  return {
    setValue: applyValue,
    getValue: () => current,
    openCustom,
    hideCustom,
  };
}

function initAutoDelayControl(opts = {}) {
  return initDurationControl({
    ...opts,
    initialValue: opts.initialValue ?? 30,
    min: AUTO_DELAY_MIN_SECONDS,
    max: AUTO_DELAY_MAX_SECONDS,
    normalize: normalizeAutoDelay,
    paint: paintAutoDelay,
    formatLabel: formatAutoDelayLabel,
    preferAltUnit: v => v >= 60 && v % 60 === 0,
    altUnitValue: 'min',
    baseUnitValue: 'sec',
    altMultiplier: 60,
    searchPlaceholder: '搜索等待时长…',
    invalidMessage: '请输入 5 秒 ~ 60 分钟之间的有效时长',
    toastPrefix: '自动整理等待',
  });
}

function initAutoDiscardControl(opts = {}) {
  return initDurationControl({
    ...opts,
    initialValue: opts.initialValue ?? 60,
    min: AUTO_DISCARD_MIN_MINUTES,
    max: AUTO_DISCARD_MAX_MINUTES,
    normalize: normalizeAutoDiscardMinutes,
    paint: paintAutoDiscard,
    formatLabel: formatAutoDiscardLabel,
    preferAltUnit: v => v >= 60 && v % 60 === 0,
    altUnitValue: 'hour',
    baseUnitValue: 'min',
    altMultiplier: 60,
    searchPlaceholder: '搜索休眠阈值…',
    invalidMessage: '请输入 5 分钟 ~ 30 天（43200 分钟）之间的有效时长',
    toastPrefix: '空闲休眠阈值',
  });
}

function shortModel(m) {
  return String(m || '').split('/').pop().slice(0, 24);
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function formatWhitelistLabel(rule) {
  const s = String(rule || '').trim();
  if (!s) return '';
  if (/^\/.+\/[gimsuy]*$/.test(s) || /^regex:/i.test(s) || s.includes('*')) {
    return /^https?:\/\//i.test(s) ? s.replace(/^https?:\/\//i, '') : s;
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if ((!u.pathname || u.pathname === '/') && !u.search) return u.hostname.replace(/^www\./, '');
      return `${u.host.replace(/^www\./, '')}${u.pathname}${u.search}`;
    } catch { /* fall through */ }
  }
  return domainOf(s) || s;
}

function renderWhitelistTestResult(container, res, { onSelectTab } = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!res) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'wl-test-head';
  const summary = document.createElement('span');
  summary.className = 'wl-test-summary';
  if (!res.ok) {
    summary.classList.add('is-err');
    summary.textContent = res.message || '规则测试失败';
  } else if (res.mode === 'single') {
    const label = formatWhitelistLabel(res.rule) || res.rule;
    summary.textContent = `检查 ${res.totalTabs} 个已打开页面，命中 ${res.matchedCount} 个（${label}）`;
  } else {
    summary.textContent = `检查 ${res.totalTabs} 个已打开页面，命中 ${res.matchedCount} 个（${res.ruleCount} 条规则）`;
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wl-test-close';
  closeBtn.textContent = '×';
  closeBtn.title = '收起测试结果';
  closeBtn.setAttribute('aria-label', '收起测试结果');
  closeBtn.onclick = () => {
    container.innerHTML = '';
    container.classList.add('hidden');
  };
  head.append(summary, closeBtn);
  container.appendChild(head);

  if (!res.ok) return;
  const matches = Array.isArray(res.matches) ? res.matches : [];
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'wl-test-empty';
    empty.textContent = '当前已打开页面中暂无命中项';
    container.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'wl-test-list';
  for (const item of matches.slice(0, 20)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'wl-test-item';
    row.title = item.url;
    const title = document.createElement('span');
    title.className = 'wl-test-title';
    title.textContent = item.title || item.url;
    const url = document.createElement('span');
    url.className = 'wl-test-url';
    const matchedHint = res.mode === 'all' && Array.isArray(item.matchedRules) && item.matchedRules.length
      ? `[${item.matchedRules.map(formatWhitelistLabel).join(', ')}] `
      : '';
    url.textContent = `${matchedHint}${item.url}`;
    row.append(title, url);
    row.onclick = () => onSelectTab?.(item);
    list.appendChild(row);
  }
  if (matches.length > 20) {
    const more = document.createElement('div');
    more.className = 'wl-test-empty';
    more.textContent = `仅展示前 20 项，共命中 ${matches.length} 个页面`;
    list.appendChild(more);
  }
  container.appendChild(list);
}

function buildSuggestionShell(container, res, { emptyText, summaryText, onApplyAll } = {}) {
  if (!container) return null;
  container.innerHTML = '';
  if (!res) {
    container.classList.add('hidden');
    return null;
  }
  container.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'wl-test-head';
  const summary = document.createElement('span');
  summary.className = 'wl-test-summary';
  const suggestions = Array.isArray(res.suggestions) ? res.suggestions : [];
  if (!res.ok) {
    summary.classList.add('is-err');
    summary.textContent = res.message || '获取建议失败';
  } else {
    const srcLabel = res.source === 'ai' ? 'AI Agent' : '内容分析';
    summary.textContent = suggestions.length
      ? `${srcLabel} ${summaryText(suggestions.length)}`
      : `${srcLabel}：${emptyText}`;
  }
  const headActions = document.createElement('span');
  headActions.className = 'wl-head-actions';
  if (res.ok && suggestions.length && typeof onApplyAll === 'function') {
    const applyAllBtn = document.createElement('button');
    applyAllBtn.type = 'button';
    applyAllBtn.className = 'mini-btn primary wl-apply-all-btn';
    applyAllBtn.textContent = suggestions.length > 1 ? `一键采纳 (${suggestions.length})` : '一键采纳';
    applyAllBtn.title = '一键全部应用或叠加更新当前列出的规则建议';
    applyAllBtn.onclick = async () => {
      applyAllBtn.disabled = true;
      try {
        const appliedRes = await onApplyAll(suggestions);
        if (appliedRes?.ok !== false) {
          container.innerHTML = '';
          container.classList.add('hidden');
        }
      } finally {
        applyAllBtn.disabled = false;
      }
    };
    headActions.appendChild(applyAllBtn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wl-test-close';
  closeBtn.textContent = '×';
  closeBtn.title = '收起建议';
  closeBtn.onclick = () => {
    container.innerHTML = '';
    container.classList.add('hidden');
  };
  headActions.appendChild(closeBtn);
  head.append(summary, headActions);
  container.appendChild(head);
  if (!res.ok || !suggestions.length) return null;

  const list = document.createElement('div');
  list.className = 'wl-test-list';
  container.appendChild(list);
  return { list, suggestions };
}

function appendSuggestionCard(list, { badgeClass, badgeText, countText, ruleText, ruleTitle, reasonText, previewLabel, applyLabel, extraNode = null, onPreview, onApply, container }) {
  const card = document.createElement('div');
  card.className = 'wl-suggest-card';

  const top = document.createElement('div');
  top.className = 'wl-suggest-top';
  const badge = document.createElement('span');
  badge.className = `wl-suggest-badge ${badgeClass}`;
  badge.textContent = badgeText;
  const countSpan = document.createElement('span');
  countSpan.className = 'wl-suggest-count';
  countSpan.textContent = countText;
  top.append(badge, countSpan);

  const ruleCode = document.createElement('div');
  ruleCode.className = 'wl-suggest-rule';
  ruleCode.textContent = ruleText;
  ruleCode.title = ruleTitle || ruleText;

  const reason = document.createElement('div');
  reason.className = 'wl-suggest-reason';
  reason.textContent = reasonText || '';

  const actions = document.createElement('div');
  actions.className = 'wl-suggest-actions';
  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'mini-btn';
  previewBtn.textContent = previewLabel || '预览命中';
  previewBtn.onclick = () => onPreview?.();
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'mini-btn primary';
  applyBtn.textContent = applyLabel;
  applyBtn.onclick = async () => {
    applyBtn.disabled = true;
    try {
      const res = await onApply?.();
      if (res?.ok !== false) {
        card.remove();
        if (!list.children.length) {
          container.innerHTML = '';
          container.classList.add('hidden');
        }
      }
    } finally {
      applyBtn.disabled = false;
    }
  };
  actions.append(previewBtn, applyBtn);

  card.append(top, ruleCode);
  if (extraNode) card.appendChild(extraNode);
  card.append(reason, actions);
  list.appendChild(card);
}

function renderWhitelistSuggestions(container, res, { onApply, onApplyAll, onPreview } = {}) {
  const shell = buildSuggestionShell(container, res, {
    summaryText: n => `生成 ${n} 条防重白名单建议`,
    emptyText: '当前暂无需要额外放行多开或收敛的路径',
    onApplyAll,
  });
  if (!shell) return;
  for (const item of shell.suggestions) {
    const diffLabel = Array.isArray(item.changes) && item.changes.length ? item.changes.join(' · ') : '';
    appendSuggestionCard(shell.list, {
      container,
      badgeClass: item.kind === 'refine' ? 'is-refine' : 'is-add',
      badgeText: item.kind === 'refine'
        ? (diffLabel ? `叠加优化 · ${diffLabel}` : (item.replaces ? `收敛替换 ${formatWhitelistLabel(item.replaces)}` : '叠加优化规则'))
        : '建议放行多开',
      countText: `命中 ${item.matchedCount || 0} 页`,
      ruleText: item.rule,
      ruleTitle: item.rule,
      reasonText: item.reason,
      previewLabel: '预览命中',
      applyLabel: item.kind === 'refine' ? '替换采纳' : '+ 采纳',
      onPreview: () => onPreview?.(item),
      onApply: () => onApply?.(item),
    });
  }
}

function formatAggregationRuleLabel(rule) {
  if (!rule) return '';
  if (typeof rule === 'string') return formatWhitelistLabel(rule);
  const pat = formatWhitelistLabel(rule.pattern || '');
  const depth = rule.pathDepth != null ? `L${rule.pathDepth}` : '自动';
  const qs = Array.isArray(rule.queryKeys) && rule.queryKeys.length ? `?${rule.queryKeys.join(',')}` : '';
  return `${pat} [${depth}${qs}]`;
}

function renderAggregationSuggestions(container, res, { onApply, onApplyAll, onPreview } = {}) {
  const shell = buildSuggestionShell(container, res, {
    summaryText: n => `生成 ${n} 条聚合标识规则建议`,
    emptyText: '结合当前页面内容与 URL 结构，暂无需新增聚合拆分规则',
    onApplyAll,
  });
  if (!shell) return;
  for (const item of shell.suggestions) {
    let bucketRow = null;
    if (Array.isArray(item.bucketsPreview) && item.bucketsPreview.length) {
      bucketRow = document.createElement('div');
      bucketRow.className = 'agg-test-buckets';
      for (const b of item.bucketsPreview.slice(0, 4)) {
        const tag = document.createElement('div');
        tag.className = 'agg-bucket-pill';
        tag.title = b.aggregationKey;
        tag.textContent = `${b.aggregationKey} (${b.count})`;
        bucketRow.appendChild(tag);
      }
    }
    const diffLabel = Array.isArray(item.changes) && item.changes.length ? ` · ${item.changes.join(' · ')}` : '';
    appendSuggestionCard(shell.list, {
      container,
      badgeClass: item.kind === 'refine' ? 'is-refine' : 'is-add',
      badgeText: item.kind === 'refine' ? `叠加优化已有规则${diffLabel}` : '新增聚合标识规则',
      countText: `拆分为 ${item.distinctKeysCount || 0} 组 · 命中 ${item.matchedCount || 0} 页`,
      ruleText: formatAggregationRuleLabel(item.rule),
      ruleTitle: `${item.rule?.pattern || ''} (depth=${item.rule?.pathDepth ?? 'auto'}, params=${(item.rule?.queryKeys || []).join(',')})`,
      extraNode: bucketRow,
      reasonText: item.reason,
      previewLabel: '预览拆分',
      applyLabel: item.kind === 'refine' ? '叠加更新' : '+ 采纳',
      onPreview: () => onPreview?.(item),
      onApply: () => onApply?.(item),
    });
  }
}

function bindSuggestButtonCore({ btn, resultEl, suggest, renderFn, apply, applyAll, formatAppliedToast, onPreview, onApplied } = {}) {
  if (!btn || !resultEl) return;
  if (!btn.dataset.baseLabel) btn.dataset.baseLabel = String(btn.textContent || 'AI 建议').trim();
  btn.onclick = async () => {
    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'AI 分析中…';
    try {
      const res = await suggest();
      renderFn(resultEl, res, {
        onPreview: item => onPreview?.(item),
        onApply: async item => {
          const applied = await apply(item);
          if (!applied?.ok) {
            toast(applied?.message || '采纳失败', 'err');
            return applied;
          }
          toast(formatAppliedToast(applied, item, false), 'ok');
          await onApplied?.(applied, [item]);
          return applied;
        },
        onApplyAll: typeof applyAll === 'function' ? async items => {
          const applied = await applyAll(items);
          if (!applied?.ok) {
            toast(applied?.message || '一键采纳失败', 'err');
            return applied;
          }
          toast(formatAppliedToast(applied, items, true), 'ok');
          await onApplied?.(applied, items);
          return applied;
        } : undefined,
      });
    } finally {
      btn.disabled = false;
      btn.textContent = btn.dataset.hintCount && Number(btn.dataset.hintCount) > 0
        ? `${btn.dataset.baseLabel} · ${btn.dataset.hintCount}`
        : (btn.dataset.baseLabel || prevLabel);
    }
  };
}

function bindWhitelistSuggestButton(opts = {}) {
  return bindSuggestButtonCore({
    ...opts,
    renderFn: renderWhitelistSuggestions,
    formatAppliedToast: (applied, itemOrItems, isBatch) => {
      if (isBatch) return `已一键采纳 ${applied.appliedCount || itemOrItems.length} 条白名单规则`;
      return itemOrItems?.replaces
        ? `已叠加收敛为「${applied.rule}」`
        : `已采纳白名单规则：${applied.rule}`;
    },
  });
}

function bindAggregationSuggestButton(opts = {}) {
  if (typeof enhanceSelect === 'function' && opts.depthSelectEl) {
    enhanceSelect(opts.depthSelectEl, {
      variant: 'sm',
      searchPlaceholder: '搜索 Path 层级…',
      minMenuWidth: 165,
    });
  }
  return bindSuggestButtonCore({
    ...opts,
    renderFn: renderAggregationSuggestions,
    formatAppliedToast: (applied, itemOrItems, isBatch) => {
      if (isBatch) return `已一键采纳并优化 ${applied.appliedCount || itemOrItems.length} 条聚合标识规则`;
      return `已采纳聚合规则：${formatAggregationRuleLabel(applied.rule || itemOrItems?.rule)}`;
    },
  });
}

function setSuggestButtonHintCount(btn, count) {
  if (!btn) return;
  const n = Math.max(0, Number(count) || 0);
  if (!btn.dataset.baseLabel) btn.dataset.baseLabel = String(btn.textContent || 'AI 建议').replace(/\s*·\s*\d+$/, '').trim();
  btn.dataset.hintCount = String(n);
  btn.classList.toggle('is-suggest-pending', n > 0);
  if (!btn.disabled) {
    btn.textContent = n > 0 ? `${btn.dataset.baseLabel} · ${n}` : btn.dataset.baseLabel;
  }
}

function renderAggregationRuleTestResult(container, res, { onSelectTab } = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!res) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  const head = document.createElement('div');
  head.className = 'wl-test-head';
  const summary = document.createElement('span');
  summary.className = 'wl-test-summary';
  if (!res.ok) {
    summary.classList.add('is-err');
    summary.textContent = res.message || '聚合层级规则测试失败';
  } else {
    summary.textContent = `检查 ${res.totalTabs} 个页面，命中 ${res.matchedCount} 个 → 识别为 ${res.distinctKeysCount || 0} 个聚合标识`;
  }
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'wl-test-close';
  closeBtn.textContent = '×';
  closeBtn.title = '收起测试结果';
  closeBtn.onclick = () => {
    container.innerHTML = '';
    container.classList.add('hidden');
  };
  head.append(summary, closeBtn);
  container.appendChild(head);
  if (!res.ok) return;

  const matches = Array.isArray(res.matches) ? res.matches : [];
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'wl-test-empty';
    empty.textContent = '当前已打开页面中暂无命中该路径的标签页';
    container.appendChild(empty);
    return;
  }

  const buckets = Array.isArray(res.buckets) ? res.buckets : [];
  if (buckets.length) {
    const bucketWrap = document.createElement('div');
    bucketWrap.className = 'agg-test-buckets';
    for (const b of buckets.slice(0, 8)) {
      const tag = document.createElement('div');
      tag.className = 'agg-bucket-pill';
      tag.title = b.aggregationKey;
      tag.textContent = `${b.aggregationKey} (${b.count})`;
      bucketWrap.appendChild(tag);
    }
    container.appendChild(bucketWrap);
  }

  const list = document.createElement('div');
  list.className = 'wl-test-list';
  for (const item of matches.slice(0, 20)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'wl-test-item';
    row.title = item.url;
    const title = document.createElement('span');
    title.className = 'wl-test-title';
    title.textContent = item.title || item.url;
    const keyLine = document.createElement('span');
    keyLine.className = 'wl-test-url';
    keyLine.textContent = `标识: ${item.aggregationKey}`;
    row.append(title, keyLine);
    row.onclick = () => onSelectTab?.(item);
    list.appendChild(row);
  }
  container.appendChild(list);
}

function favoriteKeyOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    u.hash = '';
    return u.href;
  } catch {
    return s;
  }
}

function formatRelativeAccessTime(ts, { now = Date.now(), lang } = {}) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n < 946684800000 || n > now + 60000) return '';
  const isEn = (lang || (typeof getUiLang === 'function' ? getUiLang() : 'zh')) === 'en';
  const diffSec = Math.max(0, Math.floor((now - n) / 1000));
  if (diffSec < 10) return isEn ? 'just now' : '刚刚';
  if (diffSec < 60) return isEn ? `${diffSec}s ago` : `${diffSec}秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return isEn ? `${diffMin}m ago` : `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return isEn ? `${diffHour}h ago` : `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  return isEn ? `${diffDay}d ago` : `${diffDay}天前`;
}

function renderFavoritesStrip(container, favorites, openTabKeys, { onOpen, onRemove } = {}) {
  if (!container) return;
  const list = Array.isArray(favorites) ? favorites : [];
  container.innerHTML = '';
  container.classList.toggle('hidden', !list.length);
  if (!list.length) return;

  const head = document.createElement('span');
  head.className = 'fav-bar-label';
  head.innerHTML = `${icon('starFilled', 12)}<span>置顶收藏</span>`;
  container.appendChild(head);

  const items = document.createElement('div');
  items.className = 'fav-bar-items';
  const liveSet = openTabKeys instanceof Set ? openTabKeys : new Set();

  for (const fav of list) {
    const key = favoriteKeyOf(fav.key || fav.url);
    const isLive = liveSet.has(key);
    const chip = document.createElement('div');
    chip.className = 'fav-chip' + (isLive ? ' is-live' : '');
    chip.dataset.favKey = key;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fav-chip-main';
    btn.title = isLive
      ? `${fav.title || fav.url}\n${fav.url}\n已打开，点击快速切换`
      : `${fav.title || fav.url}\n${fav.url}\n未打开，点击打开并切换`;

    const img = document.createElement('img');
    img.src = typeof faviconUrl === 'function' ? faviconUrl(fav.url) : '';
    img.alt = '';
    img.onerror = () => {
      img.onerror = null;
      if (typeof fallbackFaviconDataUrl === 'function') img.src = fallbackFaviconDataUrl(fav.url);
      else img.style.visibility = 'hidden';
    };

    const dot = document.createElement('span');
    dot.className = 'fav-live-dot';
    dot.setAttribute('aria-hidden', 'true');

    const title = document.createElement('span');
    title.className = 'fav-title';
    title.textContent = fav.title || domainOf(fav.url) || fav.url;

    btn.append(img, dot, title);
    btn.onclick = () => onOpen?.(fav);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'fav-chip-remove';
    rm.innerHTML = icon('close', 11);
    rm.title = '取消置顶收藏';
    rm.setAttribute('aria-label', `取消置顶收藏 ${fav.title || fav.url}`);
    rm.onclick = e => {
      e.stopPropagation();
      onRemove?.(fav);
    };

    chip.append(btn, rm);
    items.appendChild(chip);
  }
  container.appendChild(items);
}

function fallbackFaviconDataUrl(url) {
  const d = domainOf(url).toLowerCase();
  let bg = '#3b4866';
  let fg = '#ffffff';
  let label = (d.charAt(0) || 'W').toUpperCase();
  if (d.includes('notion.')) {
    bg = '#24292f';
    label = 'N';
  } else if (d.includes('google.')) {
    bg = '#4285f4';
    label = 'G';
  } else if (d.includes('github.com')) {
    bg = '#24292f';
    label = 'GH';
  } else if (d.includes('linear.app')) {
    bg = '#5e6ad2';
    label = 'L';
  } else if (d.includes('figma.com')) {
    bg = '#a259ff';
    label = 'F';
  } else if (d) {
    let h = 0;
    for (let i = 0; i < d.length; i++) h = (h * 31 + d.charCodeAt(i)) % 360;
    bg = `hsl(${h}, 42%, 34%)`;
    fg = `hsl(${h}, 85%, 90%)`;
  }
  const fontSize = label.length > 1 ? 9 : 12;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><rect width="26" height="26" rx="7" fill="${bg}"/><text x="13" y="13.5" text-anchor="middle" dominant-baseline="central" fill="${fg}" font-family="-apple-system,BlinkMacSystemFont,PingFang SC,sans-serif" font-size="${fontSize}" font-weight="700">${escapeHtml(label)}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

/* 展示用精简标题：去掉站点后缀/通知计数，一眼看清内容；完整标题保留在 title 属性 */
const TITLE_SITE_WORDS = /^(github|gitlab|youtube|gmail|google|google 账号|google accounts|wikipedia|stack overflow|stack exchange|chrome for developers|chrome developers|mozilla|mdn|twitter|x|reddit|bilibili|哔哩哔哩|淘宝|天猫|京东|知乎|微博|豆瓣|网易|腾讯|百度|谷歌|账号|登录|sign in|log in|login|home|homepage|welcome|overview|dashboard|docs|documentation|api reference|hacker news|news|blog|medium|notion|figma|vercel|netlify|npm|deepseek|openai|chatgpt|claude|anthropic|slack|discord|telegram|instagram|facebook|linkedin|spotify|netflix|twitch|vimeo|youku|爱奇艺|腾讯视频|优酷|抖音|tiktok|快手|小红书|携程|美团|大众点评|饿了么|example domain|example domains|outlook|yahoo|mail|drive|google drive|onedrive|dropbox|jira|confluence|linear|trello|asana|bitbucket|codepen|codesandbox|quora|imdb|substack|wordpress|safari|firefox|edge|brave|arc|windows|macos|android|ios)$/i;
function cleanTitle(title, url) {
  let s = String(title || '').replace(/\s+/g, ' ').trim();
  if (!s) return domainOf(url) || '(无标题)';
  s = s.replace(/^\(\d+\)\s*/, '');
  const host = domainOf(url);
  const hostLabel = host.split('.').slice(-2, -1)[0] || '';
  for (const sep of [' - ', ' | ', ' · ', ' – ', ' — ', ' :: ', ' ~-', ' • ']) {
    const i = s.lastIndexOf(sep);
    if (i <= 0) continue;
    const tail = s.slice(i + sep.length).trim();
    if (!tail) continue;
    const tl = tail.toLowerCase();
    if (TITLE_SITE_WORDS.test(tail) || tl === host.toLowerCase() || (hostLabel && tl.includes(hostLabel.toLowerCase()))) {
      s = s.slice(0, i).trim();
    }
  }
  return s || String(title || '').replace(/\s+/g, ' ').trim();
}

function normalizeTabUrl(url) {
  try {
    const u = new URL(String(url || ''));
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '').split('#', 1)[0];
  }
}

function resolveTabDisplayTitle(tab, metaMap = null, manualTabMap = null) {
  const manual = manualTabMap && tab?.id != null ? manualTabMap[tab.id] : null;
  if (manual?.title) {
    const norm = tab?.url ? normalizeTabUrl(tab.url) : '';
    if (!manual.url || !norm || manual.url === norm) return String(manual.title).trim();
  }
  const meta = metaMap && tab?.url ? metaMap[normalizeTabUrl(tab.url)] : null;
  if (meta?.source === 'ai' && meta?.title) return String(meta.title).trim();
  return cleanTitle(tab?.title, tab?.url);
}

function resolveTabSummary(tab, metaMap = null) {
  const meta = metaMap && tab?.url ? metaMap[normalizeTabUrl(tab.url)] : null;
  return String(meta?.summary || '').trim();
}

function fuzzyMatchScore(query, ...fields) {
  if (typeof vectorSearchScore === 'function') {
    return vectorSearchScore(query, fields.map((text, idx) => ({ text, weight: Math.max(0.4, 1 - idx * 0.15) })));
  }
  const raw = String(query || '').trim().toLowerCase();
  if (!raw) return 1;
  return fields.some(f => String(f || '').toLowerCase().includes(raw)) ? 1 : 0;
}

/** 组色低透明度着色（分组头背景） */
function tint(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 数字滚动动画（首页统计用，首次渲染直接显示数值避免闪烁） */
function countUp(el, to) {
  const hadVal = el.dataset.v !== undefined;
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (!hadVal || from === to) { el.textContent = to; return; }
  const t0 = performance.now();
  const dur = 350;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur);
    el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function toast(msg, kind = 'info') {
  const translated = typeof translateUiText === 'function' ? translateUiText(msg) : msg;
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.innerHTML = icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info', 14) + '<span class="toast-msg"></span>';
  el.querySelector('.toast-msg').textContent = translated;
  el.className = `show ${kind}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; }, 3400);
}

const NATIVE_HOST_NAME = 'com.aitab.organizer';

async function buildDaemonInstallCommand() {
  const runtimeId = chrome?.runtime?.id || '';
  const originFlag = runtimeId ? ` --origin chrome-extension://${runtimeId}/` : '';
  return `git clone https://github.com/jackerjay/tabloom.git ~/tabloom && ~/tabloom/install.sh${originFlag}`;
}

async function tryWakeLocalService() {
  if (!chrome?.runtime?.sendNativeMessage) {
    return { ok: false, reason: 'no_api', message: '当前环境不支持 Native Messaging 唤醒' };
  }
  try {
    if (chrome?.permissions?.contains && chrome?.permissions?.request) {
      const hasPerm = await chrome.permissions.contains({ permissions: ['nativeMessaging'] });
      if (!hasPerm) {
        const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
        if (!granted) {
          return { ok: false, reason: 'permission_denied', message: '未授予 Native 唤醒权限，无法从浏览器直接启动本机进程' };
        }
      }
    }
  } catch { /* fallback if optional permission API unavailable */ }

  return new Promise(resolve => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'start' }, response => {
        const err = chrome.runtime?.lastError;
        if (err) {
          const msg = String(err.message || '');
          const missing = /not found|forbidden|specified native messaging host|access.*denied/i.test(msg);
          return resolve({
            ok: false,
            reason: missing ? 'no_host' : 'failed',
            message: msg || 'Native 唤醒宿主未响应',
          });
        }
        if (response?.ok) return resolve({ ok: true, ...response });
        return resolve({
          ok: false,
          reason: 'failed',
          message: response?.message || response?.error || '本机服务启动未完成',
        });
      });
    } catch (err) {
      resolve({ ok: false, reason: 'no_host', message: err?.message || 'Native 唤醒调用失败' });
    }
  });
}

async function refreshHealthPill(el, { onStartRequest } = {}) {
  if (!el) return null;
  el.className = 'pill';
  el.onclick = null;
  el.innerHTML = icon('spinner', 12) + '<span class="pill-text">检测中…</span>';
  try {
    const h = await apiFetch('/health', { timeout: 5000 });
    if (h.ai) {
      const model = h.currentModel || h.backend?.model || '';
      const cliLabel = h.backend?.type === 'cli' && h.backend?.cli
        ? `${h.backend.cli} CLI`
        : h.backend?.type === 'acp'
          ? 'ACP'
          : 'AI';
      el.className = 'pill ok';
      el.innerHTML = icon('signal', 12) + `<span class="pill-text"><span class="pill-cli">${escapeHtml(cliLabel)}</span> <span class="pill-model">${escapeHtml(shortModel(model))}</span></span>`;
      el.title = h.backend?.invocationPreview || `${h.backend?.type || ''} ${model}`;
    } else {
      el.className = 'pill warn';
      el.innerHTML = icon('alert', 12) + '<span class="pill-text">规则模式</span>';
      el.title = '未连接本地模型 / CLI';
    }
    return h;
  } catch {
    el.className = onStartRequest ? 'pill bad clickable' : 'pill bad';
    el.innerHTML = icon('alert', 12) + '<span class="pill-text">服务未启动</span>';
    el.title = onStartRequest
      ? '本机服务未启动；点击尝试一键唤醒'
      : '请先在 server 目录运行 node server.mjs 或 npm run service:install';
    if (onStartRequest) {
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.onclick = () => onStartRequest();
    }
    return null;
  }
}

/** 模型选择器：拉取 /models，按路由前缀分组，切换走 POST /model */
async function initModelSelect(selectEl, { refreshBtn, metaEl, pillEl, cliContainerEl } = {}) {
  let currentValue = null;

  const paintCliCards = (availableClis = [], activeCli = null) => {
    if (!cliContainerEl || !Array.isArray(availableClis) || !availableClis.length) return;
    cliContainerEl.innerHTML = availableClis.map(c => {
      const active = c.id === activeCli;
      const statusText = c.installed ? '就绪' : '未安装';
      const statusCls = c.installed ? 'ok' : 'off';
      return `<button type="button" class="cli-card${active ? ' active' : ''}" data-cli-id="${escapeHtml(c.id)}" ${c.installed ? '' : 'disabled'} title="${escapeHtml(c.desc || c.name)}">
        <div class="cli-card-top">
          <span class="cli-card-name">${escapeHtml(c.name || c.id)}</span>
          <span class="cli-card-badge ${statusCls}">● ${statusText}</span>
        </div>
        <div class="cli-card-sub">${escapeHtml(c.activeModel || c.desc || '')}</div>
      </button>`;
    }).join('');
    cliContainerEl.querySelectorAll('button[data-cli-id]').forEach(btn => {
      btn.onclick = async () => {
        const cliId = btn.dataset.cliId;
        if (!cliId) return;
        btn.disabled = true;
        try {
          await apiFetch('/cli', { method: 'POST', body: { preferredCli: cliId }, timeout: 6000 });
          toast(`已切换 AI 引擎通道：${cliId} CLI`, 'ok');
          await load();
          if (pillEl) refreshHealthPill(pillEl);
        } catch (err) {
          toast(`切换 CLI 失败：${err.message}`, 'err');
          btn.disabled = false;
        }
      };
    });
  };

  const load = async () => {
    selectEl.disabled = true;
    if (refreshBtn) refreshBtn.classList.add('spinning');
    try {
      const data = await apiFetch('/models', { timeout: 12000 });
      currentValue = data.current || null;
      if (data.availableClis) paintCliCards(data.availableClis, data.cli);
      selectEl.innerHTML = '';
      if (!data.models.length) {
        selectEl.add(new Option(data.note || '无法获取模型列表', ''));
        selectEl.disabled = true;
      } else {
        const buckets = new Map();
        for (const m of data.models) {
          const g = m.id.includes('/') ? m.id.split('/')[0] + '/' : '默认路由';
          if (!buckets.has(g)) buckets.set(g, []);
          buckets.get(g).push(m);
        }
        const order = ['默认路由', 'auto/', 'openai/', 'anthropic/'];
        const keys = [...buckets.keys()].sort((a, b) => {
          const ia = order.indexOf(a), ib = order.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
        });
        for (const k of keys) {
          const og = document.createElement('optgroup');
          og.label = k;
          for (const m of buckets.get(k)) og.appendChild(new Option(m.name || m.id, m.id));
          selectEl.appendChild(og);
        }
        if (currentValue && ![...selectEl.options].some(o => o.value === currentValue)) {
          selectEl.add(new Option(currentValue, currentValue), 0);
        }
        selectEl.value = currentValue || selectEl.options[0]?.value || '';
        selectEl.disabled = false;
      }
      if (metaEl) {
        metaEl.textContent = data.invocationPreview
          ? `调用：${data.invocationPreview}（临时空目录只读执行）`
          : currentValue
            ? `当前：${currentValue}`
            : (data.note || '');
      }
      if (pillEl && pillEl.classList.contains('bad')) {
        refreshHealthPill(pillEl);
      }
    } catch {
      if (cliContainerEl) cliContainerEl.innerHTML = '';
      selectEl.innerHTML = '';
      selectEl.add(new Option('服务未连接，请先启动本机服务', ''));
      selectEl.disabled = true;
      if (metaEl) metaEl.textContent = '127.0.0.1:8787 离线；启动后将自动加载 codex / claude CLI 通道';
    }
    if (refreshBtn) refreshBtn.classList.remove('spinning');
    syncSearchableSelect(selectEl);
  };

  selectEl.onchange = async () => {
    const model = selectEl.value;
    if (!model) return;
    selectEl.disabled = true;
    try {
      await apiFetch('/model', { method: 'POST', body: { model }, timeout: 8000 });
      currentValue = model;
      toast(`模型已切换：${shortModel(model)}，下次整理生效`, 'ok');
      await load();
      if (pillEl) refreshHealthPill(pillEl);
    } catch (e) {
      toast(`切换失败：${e.message}`, 'err');
      selectEl.value = currentValue || '';
    }
    selectEl.disabled = false;
    syncSearchableSelect(selectEl);
  };

  if (refreshBtn) refreshBtn.onclick = load;
  if (typeof enhanceSelect === 'function') {
    enhanceSelect(selectEl, {
      variant: 'default',
      searchPlaceholder: '搜索模型名称或路由前缀…',
      minMenuWidth: 260,
    });
  }
  await load();
  syncSearchableSelect(selectEl);
  return { reload: async () => { await load(); syncSearchableSelect(selectEl); } };
}

async function initUpdateCard({
  statusEl,
  checkBtn,
  applyBtn,
  dotEl,
  titleEl,
  actionsEl,
  startBtn,
  setupBoxEl,
  cmdEl,
  copyCmdBtn,
  retryBtn,
  pillEl,
  badgeEls = [],
  onServiceOnline,
} = {}) {
  if (!statusEl) return null;
  let wasOffline = false;
  const badges = (Array.isArray(badgeEls) ? badgeEls : [badgeEls]).filter(Boolean);
  const paintBadges = res => {
    const has = Boolean(res?.hasUpdate);
    for (const el of badges) {
      el.classList.toggle('hidden', !has);
      const host = el.closest?.('button');
      if (host) {
        host.classList.toggle('has-update', has);
        if (has) {
          const hint = res.remoteCommit ? `发现新版本：${res.remoteCommit}` : '发现新版本，点击检查并一键升级';
          el.title = hint;
          if (!host.dataset.origTitle) host.dataset.origTitle = host.getAttribute('title') || '';
          host.title = hint;
        } else if (host.dataset.origTitle != null) {
          host.title = host.dataset.origTitle;
        }
      }
    }
  };

  const paintOffline = async ({ showSetup = false } = {}) => {
    wasOffline = true;
    if (dotEl) dotEl.className = 'service-dot bad';
    if (titleEl) titleEl.textContent = '本机服务未启动（127.0.0.1:8787 离线）';
    statusEl.textContent = `未连接本机服务（开发者模式 v${chrome.runtime?.getManifest?.()?.version || '0.4.0'}）；启动后即可连接 AI CLI`;
    if (applyBtn) applyBtn.classList.add('hidden');
    if (actionsEl) actionsEl.classList.remove('hidden');
    if (setupBoxEl) setupBoxEl.classList.toggle('hidden', !showSetup);
    if (cmdEl) cmdEl.textContent = await buildDaemonInstallCommand();
  };

  const applyCheckResult = res => {
    if (dotEl) dotEl.className = 'service-dot ok';
    if (titleEl) {
      titleEl.textContent = res.daemonInstalled
        ? (res.nativeHostInstalled ? 'LaunchAgent 常驻 + Native 唤醒已就绪' : 'LaunchAgent 开机常驻已启用')
        : (res.nativeHostInstalled ? '本机服务在线 · Native 唤醒已就绪' : '本机服务已在线（未启用开机常驻）');
    }
    statusEl.textContent = res.message || `当前版本 v${res.version || '0.4.0'}`;
    if (actionsEl) actionsEl.classList.add('hidden');
    if (setupBoxEl) setupBoxEl.classList.add('hidden');
    if (applyBtn) {
      applyBtn.classList.toggle('hidden', !res.hasUpdate);
      if (res.hasUpdate) {
        applyBtn.textContent = res.gitAvailable === false
          ? '查看最新安装包说明'
          : '↑ 立即拉取更新并重启重载';
      }
    }
    paintBadges(res);
    if (pillEl && pillEl.classList.contains('bad')) {
      refreshHealthPill(pillEl);
    }
    if (wasOffline) {
      wasOffline = false;
      if (onServiceOnline) onServiceOnline(res);
    }
  };

  const check = async (fetchRemote = false) => {
    if (checkBtn) { checkBtn.disabled = true; checkBtn.textContent = '检查中…'; }
    try {
      const res = await apiFetch(`/update/status${fetchRemote ? '?fetch=1' : ''}`, { timeout: 10000 });
      applyCheckResult(res);
      try {
        chrome.storage?.local?.set?.({ updateStatusCache: { ...res, checkedAtMs: Date.now() } });
      } catch { /* ignore */ }
      if (fetchRemote) toast(res.hasUpdate ? '发现新版本，可点击一键拉取更新' : '当前已是最新版本', res.hasUpdate ? 'info' : 'ok');
      else {
        chrome.runtime?.sendMessage?.({ type: 'update-check-bg', force: false })?.then?.(bgRes => {
          if (bgRes?.ok) applyCheckResult(bgRes);
        })?.catch?.(() => {});
      }
      return true;
    } catch {
      await paintOffline({ showSetup: setupBoxEl ? !setupBoxEl.classList.contains('hidden') : false });
      try {
        const cached = (await chrome.storage?.local?.get?.('updateStatusCache'))?.updateStatusCache;
        if (cached?.hasUpdate) paintBadges(cached);
      } catch { /* ignore */ }
      return false;
    } finally {
      if (checkBtn) { checkBtn.disabled = false; checkBtn.textContent = '检查更新'; }
    }
  };

  const attemptWake = async () => {
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '正在唤醒本机服务…';
    }
    const wake = await tryWakeLocalService();
    if (wake.ok) {
      toast(wake.alreadyRunning ? '本机服务已在线' : '本机服务已一键启动', 'ok');
      await check(false);
      if (pillEl) await refreshHealthPill(pillEl, { onStartRequest: attemptWake });
      if (onServiceOnline) onServiceOnline(wake.health || wake);
    } else if (wake.reason === 'no_host') {
      await paintOffline({ showSetup: true });
      setupBoxEl?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      toast('尚未注册 Native 唤醒宿主，请复制下方一行命令完成首次安装', 'info');
    } else {
      toast(wake.message || '一键启动未成功，请尝试手动运行安装命令', 'err');
      if (wake.reason === 'failed') await paintOffline({ showSetup: true });
    }
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = '▶ 一键启动服务';
    }
    return wake;
  };

  if (checkBtn) checkBtn.onclick = () => check(true);
  if (startBtn) startBtn.onclick = attemptWake;
  if (retryBtn) {
    retryBtn.onclick = async () => {
      retryBtn.disabled = true;
      const ok = await check(false);
      if (pillEl) await refreshHealthPill(pillEl, { onStartRequest: attemptWake });
      if (ok && onServiceOnline) onServiceOnline();
      else if (!ok) toast('暂未检测到 127.0.0.1:8787，请确认终端命令已完成', 'info');
      retryBtn.disabled = false;
    };
  }
  if (copyCmdBtn) {
    copyCmdBtn.onclick = async () => {
      const cmd = cmdEl?.textContent || await buildDaemonInstallCommand();
      try {
        await navigator.clipboard.writeText(cmd);
        toast('已复制安装并启动命令，粘贴到终端回车即可', 'ok');
      } catch {
        toast('复制失败，请手动选中命令复制', 'err');
      }
    };
  }
  if (applyBtn) {
    applyBtn.onclick = async () => {
      applyBtn.disabled = true;
      applyBtn.textContent = '拉取更新中…';
      try {
        const res = await apiFetch('/update/apply', { method: 'POST', body: { confirm: true }, timeout: 22000 });
        statusEl.textContent = res.message || '已更新';
        if (!res.ok || res.applied === false) {
          toast(res.message || '拉取未完成，请检查本地改动', 'err');
          if (res.reloadExtension && res.gitAvailable === false && setupBoxEl) {
            setupBoxEl.classList.remove('hidden');
            if (cmdEl) cmdEl.textContent = await buildDaemonInstallCommand();
          }
          return;
        }
        try {
          await chrome.storage?.local?.set?.({ updateStatusCache: { ...res, hasUpdate: false, behindCount: 0, checkedAtMs: Date.now() } });
        } catch { /* ignore */ }
        paintBadges({ hasUpdate: false });
        applyBtn.classList.add('hidden');
        toast(res.message || '升级完成，正在重载扩展', 'ok');
        if (res.reloadExtension) {
          const waitMs = res.daemonRestarting ? 750 : 120;
          setTimeout(() => chrome.runtime?.sendMessage?.({ type: 'reload-extension' }), waitMs);
        }
      } catch (e) {
        toast(`升级失败：${e.message}`, 'err');
      } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = '↑ 立即拉取更新并重启重载';
      }
    };
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.updateStatusCache?.newValue) {
        const next = changes.updateStatusCache.newValue;
        paintBadges(next);
        if (next.ok && !wasOffline) {
          statusEl.textContent = next.message || statusEl.textContent;
          if (applyBtn) applyBtn.classList.toggle('hidden', !next.hasUpdate);
        }
      }
    });
  }
  await check(false);
  return { reload: () => check(false), checkRemote: () => check(true), attemptWake, isOffline: () => wasOffline };
}

/* ---------------- 主题：auto / light / dark ----------------
 * 真值存 chrome.storage.sync.themeMode（独立于 settings，避免整对象写覆盖）；
 * localStorage 存镜像供 theme-boot.js 首帧同步读取；
 * auto 跟随 prefers-color-scheme，系统翻转实时生效；
 * storage.onChanged 让 popup / 侧边栏 / 首页三块表面实时互相同步。 */
const THEME_MODES = [
  { id: 'auto', label: '自动', icon: 'monitor', title: '跟随系统外观' },
  { id: 'light', label: '浅色', icon: 'sun', title: '始终浅色' },
  { id: 'dark', label: '深色', icon: 'moon', title: '始终深色' },
];
const themeMQ = window.matchMedia('(prefers-color-scheme: dark)');
let themeMode = 'dark';

function resolvedTheme() {
  return themeMode === 'auto' ? (themeMQ.matches ? 'dark' : 'light') : themeMode;
}

function paintThemeSeg() {
  const tr = s => (typeof translateUiText === 'function' ? translateUiText(s) : s);
  document.querySelectorAll('[data-theme-seg]').forEach(seg => {
    for (const b of seg.querySelectorAll('button')) {
      const on = b.dataset.themeMode === themeMode;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      const mode = THEME_MODES.find(m => m.id === b.dataset.themeMode);
      if (mode) {
        b.title = tr(mode.title);
        const span = b.querySelector('span');
        if (span) span.textContent = tr(mode.label);
      }
    }
  });
}

function applyTheme(animate = false) {
  const root = document.documentElement;
  const next = resolvedTheme();
  if (animate && root.dataset.theme && root.dataset.theme !== next) {
    root.classList.add('theme-switching');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove('theme-switching'), 360);
  }
  root.dataset.theme = next;
  try { localStorage.setItem('themeMode', themeMode); } catch { /* 忽略 */ }
  paintThemeSeg();
}

async function setThemeMode(mode) {
  const m = THEME_MODES.find(x => x.id === mode);
  if (!m || mode === themeMode) return;
  themeMode = mode;
  applyTheme(true);
  try { await chrome.storage.sync.set({ themeMode: mode }); } catch { /* 忽略 */ }
  toast(mode === 'auto'
    ? `主题：跟随系统（当前${resolvedTheme() === 'dark' ? '深色' : '浅色'}）`
    : `主题：${m.label}`, 'ok');
}

function buildThemeSegs() {
  document.querySelectorAll('[data-theme-seg]').forEach(seg => {
    seg.innerHTML = THEME_MODES.map(m =>
      `<button type="button" role="radio" aria-checked="false" data-theme-mode="${m.id}" title="${m.title}">${icon(m.icon, 14)}<span>${m.label}</span></button>`
    ).join('');
    seg.addEventListener('click', e => {
      const b = e.target.closest('button[data-theme-mode]');
      if (b) setThemeMode(b.dataset.themeMode);
    });
    seg.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const i = THEME_MODES.findIndex(m => m.id === themeMode);
      const d = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      const next = THEME_MODES[(i + d + THEME_MODES.length) % THEME_MODES.length];
      setThemeMode(next.id);
      seg.querySelector(`button[data-theme-mode="${next.id}"]`)?.focus();
    });
  });
}

async function initTheme() {
  buildThemeSegs();
  try {
    const { themeMode: stored } = await chrome.storage.sync.get('themeMode');
    if (THEME_MODES.some(m => m.id === stored)) themeMode = stored;
  } catch { /* 忽略 */ }
  applyTheme();
  const healAuto = () => { if (themeMode === 'auto') applyTheme(true); };
  themeMQ.addEventListener('change', healAuto);
  // 兜底自愈：个别嵌入/无头环境系统翻转可能漏发 change；回到前台时重新解析 auto
  window.addEventListener('focus', healAuto);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) healAuto(); });
  document.addEventListener('tt-lang-change', () => paintThemeSeg());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.themeMode) {
      const v = changes.themeMode.newValue;
      if (v !== themeMode && THEME_MODES.some(m => m.id === v)) {
        themeMode = v;
        applyTheme(true);
      }
    }
  });
}
initTheme();