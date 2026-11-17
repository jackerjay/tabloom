/* AI 标签整理 — MV3 service worker
 * 职责：收集标签页 → 调本地服务 → 应用 chrome.tabGroups 原生分组 → 撤销 / 自动整理
 */
const DEFAULTS = {
  serviceUrl: 'http://127.0.0.1:8787',
  autoOrganize: false,
  autoOrganizeDelaySeconds: 30,
  autoOrganizeOnHome: true,
  includePinned: false,
  density: 'comfortable',
  dedupWhitelist: [],
  interceptDuplicates: true,
  interceptScope: 'all',
  showPageSearchPill: true,
  pillHiddenHosts: [],
  autoDiscardEnabled: false,
  autoDiscardMinutes: 60,
};
const AUTO_ALARM = 'ai-tab-auto-organize';
const DISCARD_ALARM = 'ai-tab-auto-discard';
const LOCKED_GROUPS_KEY = 'lockedGroupIds';
const MANUAL_NAMED_GROUPS_KEY = 'manualNamedGroups';

async function readLockedGroupIds() {
  try {
    const raw = (await chrome.storage?.local?.get?.(LOCKED_GROUPS_KEY))?.[LOCKED_GROUPS_KEY];
    return new Set(Array.isArray(raw) ? raw.filter(id => Number.isInteger(id) && id >= 0) : []);
  } catch {
    return new Set();
  }
}

async function writeLockedGroupIds(set) {
  const list = [...set].filter(id => Number.isInteger(id) && id >= 0).sort((a, b) => a - b);
  await chrome.storage?.local?.set?.({ [LOCKED_GROUPS_KEY]: list });
  return list;
}

async function readManualNamedGroups() {
  try {
    const raw = (await chrome.storage?.local?.get?.(MANUAL_NAMED_GROUPS_KEY))?.[MANUAL_NAMED_GROUPS_KEY];
    const map = new Map();
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        const id = Number(k);
        const title = typeof v === 'string' ? v.trim() : '';
        if (Number.isInteger(id) && id >= 0 && title) map.set(id, title);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

async function writeManualNamedGroups(map) {
  const obj = {};
  for (const [id, title] of map) {
    if (Number.isInteger(id) && id >= 0 && typeof title === 'string' && title.trim()) {
      obj[String(id)] = title.trim();
    }
  }
  await chrome.storage?.local?.set?.({ [MANUAL_NAMED_GROUPS_KEY]: obj });
  return obj;
}

async function renameTabGroup({ groupId, title }) {
  if (!Number.isInteger(groupId) || groupId < 0) throw new Error('无效的分组 ID');
  const cleanTitle = String(title ?? '').trim().slice(0, 60);
  if (!cleanTitle) throw new Error('分组名称不能为空');
  const groups = await chrome.tabGroups.query({});
  const exists = groups.find(g => g.id === groupId);
  if (!exists) throw new Error('分组不存在或已关闭');
  await chrome.tabGroups.update(groupId, { title: cleanTitle });
  const map = await readManualNamedGroups();
  map.set(groupId, cleanTitle);
  const saved = await writeManualNamedGroups(map);
  return { ok: true, groupId, title: cleanTitle, manualNamedGroups: saved };
}

async function setGroupLock({ groupId, locked }) {
  if (!Number.isInteger(groupId) || groupId < 0) throw new Error('无效的分组 ID');
  const shouldLock = Boolean(locked);
  if (shouldLock) {
    const groups = await chrome.tabGroups.query({});
    if (!groups.some(g => g.id === groupId)) throw new Error('分组已关闭或不存在');
  }
  const set = await readLockedGroupIds();
  if (shouldLock) set.add(groupId);
  else set.delete(groupId);
  const list = await writeLockedGroupIds(set);
  return { ok: true, groupId, locked: shouldLock, lockedGroupIds: list };
}

async function disbandAndCloseGroup({ groupId, windowId = null }) {
  if (!Number.isInteger(groupId) || groupId < 0) throw new Error('无效的分组 ID');
  windowId = lifecycleWindowId(windowId);
  const locked = await readLockedGroupIds();
  if (locked.has(groupId)) {
    throw new Error('该分组已加锁，不允许清理或彻底关闭；请先解锁');
  }
  const groups = await chrome.tabGroups.query(windowId == null ? {} : { windowId });
  const targetGroup = groups.find(g => g.id === groupId);
  if (!targetGroup) throw new Error('分组不存在或已关闭');
  const members = (await chrome.tabs.query({ windowId: targetGroup.windowId, groupId }))
    .filter(t => t.groupId === groupId && t.windowId === targetGroup.windowId);
  const ids = members.map(t => t.id);
  let closedTabs = 0;
  let failed = 0;
  if (ids.length) {
    try {
      await chrome.tabs.remove(ids);
      closedTabs = ids.length;
    } catch {
      for (const id of ids) {
        try {
          await chrome.tabs.remove(id);
          closedTabs++;
        } catch {
          failed++;
        }
      }
    }
  }
  return { ok: closedTabs > 0 || !failed, groupId, closedTabs, failed };
}

/* Toolbar action opens Chrome's native side panel; the legacy popup is not an entry. */
async function configureActionEntry() {
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn('设置工具栏侧边栏入口失败:', error);
  }
  try {
    if (typeof chrome.scripting?.registerContentScripts === 'function') {
      await chrome.scripting.unregisterContentScripts({ ids: ['ai-tab-page-pill'] }).catch(() => {});
      await chrome.scripting.registerContentScripts([{
        id: 'ai-tab-page-pill',
        js: ['page-pill.js'],
        matches: ['http://*/*', 'https://*/*'],
        runAt: 'document_idle',
        world: 'ISOLATED',
      }]);
    }
  } catch { /* ignore if unsupported */ }
}
configureActionEntry();

const AUTO_DELAY_MIN_SECONDS = 5;
const AUTO_DELAY_MAX_SECONDS = 3600;
const AUTO_DISCARD_MIN_MINUTES = 5;
const AUTO_DISCARD_MAX_MINUTES = 43200; // 30 天

function normalizeAutoDelay(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return DEFAULTS.autoOrganizeDelaySeconds;
  const seconds = (typeof value === 'number' || typeof value === 'string') ? Number(String(value).trim()) : NaN;
  return Number.isInteger(seconds) && seconds >= AUTO_DELAY_MIN_SECONDS && seconds <= AUTO_DELAY_MAX_SECONDS
    ? seconds
    : DEFAULTS.autoOrganizeDelaySeconds;
}

function normalizeAutoDiscardMinutes(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return DEFAULTS.autoDiscardMinutes;
  const mins = (typeof value === 'number' || typeof value === 'string') ? Number(String(value).trim()) : NaN;
  return Number.isInteger(mins) && mins >= AUTO_DISCARD_MIN_MINUTES && mins <= AUTO_DISCARD_MAX_MINUTES
    ? mins
    : DEFAULTS.autoDiscardMinutes;
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return {
    ...DEFAULTS,
    ...(settings || {}),
    autoOrganizeDelaySeconds: normalizeAutoDelay(settings?.autoOrganizeDelaySeconds),
    autoDiscardEnabled: Boolean(settings?.autoDiscardEnabled),
    autoDiscardMinutes: normalizeAutoDiscardMinutes(settings?.autoDiscardMinutes),
  };
}

async function currentWindowId() {
  const win = await chrome.windows.getLastFocused();
  return win.id;
}

async function callService(settings, payload) {
  const base = settings.serviceUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 195000);
  let res;
  try {
    res = await fetch(`${base}/organize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('本地服务调用超时');
    throw new Error(`无法连接本地服务 ${base}，请先运行 node server.mjs`);
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `服务返回 ${res.status}`);
  return data;
}

/* ---------------- 整理上下文：书签 + 新鲜页面内容 + 活跃页 ----------------
 * 不缓存 snippet：同 URL 的内容变化必须到达服务端持久分析缓存的 key。 */
const EXTRACT_BUDGET_MS = 6000;
const EXTRACT_CONCURRENCY = 4;

// This function is serialized by executeScript: keep every DOM helper inside it.
// Reading and writing share exactly the same content fingerprint, never the AI title.
function pageExtractor(write = null) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const cut = (s, n) => Array.from(s).slice(0, n).join('');
  const key = '__aiTabTitleState';
  const capture = () => {
    const meta = s => clean(document.querySelector(s)?.getAttribute('content') || '');
    const data = {
      desc: cut(meta('meta[name="description"]'), 200),
      site: cut(meta('meta[property="og:site_name"]'), 60),
      heads: cut([...document.querySelectorAll('h1,h2')].slice(0, 4)
        .map(h => clean(h.textContent)).filter(Boolean).join(' / '), 160),
      text: cut(clean(document.querySelector('main, article')?.innerText || document.body?.innerText || ''), 900),
    };
    data.snippet = cut([data.site, data.desc, data.heads, data.text].filter(Boolean).join(' '), 1200);
    return data;
  };
  const stop = state => {
    if (!state) return;
    state.observer?.disconnect();
    state.observer = null;
    state.active = false;
    if (state.pagehide) globalThis.removeEventListener?.('pagehide', state.pagehide);
  };
  const notifyChanged = snippet => {
    try {
      globalThis.chrome?.runtime?.sendMessage?.({ type: 'analysis-page-changed', url: location.href, snippet })?.catch?.(() => {});
    } catch { /* Worker may have been reloaded; the next navigation still queues. */ }
  };
  const data = capture();
  const previous = document[key];
  const originalTitle = previous && document.title === previous.aiTitle ? previous.originalTitle : document.title;
  if (previous?.active && (previous.url !== location.href || previous.snippet !== data.snippet)) {
    stop(previous); notifyChanged(data.snippet);
  }
  if (!write) return { ...data, url: location.href, originalTitle: clean(originalTitle) };

  const title = cut(clean(String(write.title || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')), 48);
  if (!/^https?:\/\//.test(location.href) || write.url !== location.href || !write.snippet
      || data.snippet !== write.snippet || !title) {
    stop(previous);
    return { status: 'skipped', reason: '页面地址或内容已变化' };
  }
  stop(previous); // At most one observer per document, including repeated cache hits.
  const state = {
    originalTitle: clean(originalTitle), aiTitle: title, url: location.href,
    snippet: data.snippet, observer: null, active: true,
    rewriteWindow: Date.now(), rewrites: 0,
  };
  document[key] = state;
  const unchanged = document.title === title;
  document.title = title; // Plain text, never innerHTML or tabs.update({ title }).
  if (typeof MutationObserver === 'function' && document.head) {
    state.observer = new MutationObserver(() => {
      if (!state.active) return;
      if (state.url !== location.href) { stop(state); notifyChanged(''); return; }
      if (document.title === state.aiTitle) return; // Own mutation: no extra DOM scan.
      const fresh = capture().snippet;
      if (fresh !== state.snippet) { stop(state); notifyChanged(fresh); return; }
      const now = Date.now();
      if (now - state.rewriteWindow >= 1000) { state.rewriteWindow = now; state.rewrites = 0; }
      // Yield to sites enforcing their own title instead of creating an observer ping-pong.
      if (++state.rewrites > 3) { stop(state); return; }
      state.originalTitle = clean(document.title);
      document.title = state.aiTitle;
    });
    // Only head/title, never a whole-body observer, timer or polling loop.
    state.observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    state.pagehide = () => stop(state);
    globalThis.addEventListener?.('pagehide', state.pagehide, { once: true });
  }
  return { status: unchanged ? 'unchanged' : 'updated' };
}

async function extractSnippet(tab) {
  if (!/^https?:\/\//.test(tab.url || '')) return null;
  let timer;
  try {
    const r = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageExtractor }),
      new Promise(res => { timer = setTimeout(() => res(null), 3000); }),
    ]);
    const data = r?.[0]?.result || null;
    return data && (!data.url || data.url === tab.url) ? data : null;
  } catch { return null; /* Restricted pages/PDFs are honestly unavailable. */ }
  finally { clearTimeout(timer); }
}

function snippetText(d) {
  if (!d) return '';
  return Array.from(d.snippet ?? [d.site, d.desc, d.heads, d.text].filter(Boolean).join(' ')).slice(0, 1200).join('');
}

const TAB_META_KEY = 'tabMetaCache';
const TAB_META_LIMIT = 500;
const HOME_SEEN_KEY = 'lastHomeAutoSeen';

function buildSnippetSummary(d) {
  if (!d || typeof d !== 'object') return '';
  const raw = d.snippet
    ? String(d.snippet)
    : [d.desc, d.heads, d.text].filter(Boolean).join(' · ');
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  return cleaned ? Array.from(cleaned).slice(0, 72).join('') : '';
}

async function updateTabMetaCache(updates = []) {
  if (!updates.length || typeof chrome.storage?.local?.get !== 'function') return;
  try {
    const raw = (await chrome.storage.local.get(TAB_META_KEY))?.[TAB_META_KEY];
    const cache = raw && typeof raw === 'object' ? { ...raw } : {};
    const now = Date.now();
    let changed = false;
    for (const item of updates) {
      if (!item?.url || !/^https?:\/\//i.test(item.url)) continue;
      const key = normalizeUrl(item.url);
      if (!key) continue;
      const prev = cache[key] || {};
      const next = { ...prev };
      if (item.title && (item.source === 'ai' || !prev.title)) {
        next.title = String(item.title).trim();
        if (item.source) next.source = item.source;
      }
      if (item.summary && (item.source === 'ai' || prev.source !== 'ai' || !prev.summary)) {
        next.summary = String(item.summary).trim();
      }
      if (!next.title && !next.summary) continue;
      next.updatedAt = now;
      if (next.title !== prev.title || next.summary !== prev.summary || next.source !== prev.source) {
        cache[key] = next;
        changed = true;
      }
    }
    if (!changed) return;
    const entries = Object.entries(cache);
    if (entries.length > TAB_META_LIMIT) {
      entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
      await chrome.storage.local.set({ [TAB_META_KEY]: Object.fromEntries(entries.slice(0, TAB_META_LIMIT)) });
    } else {
      await chrome.storage.local.set({ [TAB_META_KEY]: cache });
    }
  } catch { /* metadata cache never blocks organizing */ }
}

async function checkHomeAutoOrganize(windowId = null) {
  windowId = lifecycleWindowId(windowId) ?? await currentWindowId();
  const settings = await getSettings();
  if (!settings.autoOrganizeOnHome) {
    return { ok: true, shouldOrganize: false, reason: 'disabled' };
  }
  const tabs = await chrome.tabs.query({ windowId });
  const ungrouped = tabs.filter(t => t.groupId === -1 && (settings.includePinned || !t.pinned) && /^https?:\/\//.test(t.url || ''));
  const curKeys = ungrouped.map(t => `${t.id}|${normalizeUrl(t.url)}`);
  const seenMap = ((await chrome.storage.session?.get?.(HOME_SEEN_KEY))?.[HOME_SEEN_KEY]) || {};
  const prevKeys = Array.isArray(seenMap[windowId]) ? seenMap[windowId] : null;
  const prevSet = new Set(prevKeys || []);
  const newKeys = curKeys.filter(k => !prevSet.has(k));
  const shouldOrganize = curKeys.length > 0 && (!prevKeys || newKeys.length > 0);
  seenMap[windowId] = curKeys;
  try { await chrome.storage.session?.set?.({ [HOME_SEEN_KEY]: seenMap }); } catch { /* ignore */ }
  return { ok: true, windowId, shouldOrganize, ungroupedCount: curKeys.length, newCount: newKeys.length };
}

async function collectContext(target, all) {
  const bookmarkOf = new Map();
  const folders = [];
  try {
    const countUrls = n => n.url ? 1 : (n.children || []).reduce((s, c) => s + countUrls(c), 0);
    const walk = (node, path) => {
      const p = node.title ? [...path, node.title] : path;
      if (node.url) bookmarkOf.set(normalizeUrl(node.url), p.join('/'));
      else {
        if (p.length && countUrls(node)) folders.push({ path: p.join('/'), count: countUrls(node) });
        (node.children || []).forEach(c => walk(c, p));
      }
    };
    (await chrome.bookmarks.getTree()).forEach(n => walk(n, []));
  } catch { /* 无书签权限/空书签 */ }
  folders.sort((a, b) => b.count - a.count);

  const active = all.find(t => t.active) || null;
  const activeHttp = active && /^https?:\/\//.test(active.url || '') ? active : null;
  // The actual active webpage may be pinned/already grouped and absent from target.
  // Never substitute a guessed previous page when the workbench itself is active.
  const httpTabs = [
    ...(activeHttp ? [activeHttp] : []),
    ...target.filter(t => t.id !== activeHttp?.id && /^https?:\/\//.test(t.url || '')),
  ];
  const snippets = new Map();
  const deadline = Date.now() + EXTRACT_BUDGET_MS;
  let cursor = 0;
  const worker = async () => {
    while (cursor < httpTabs.length && Date.now() < deadline) {
      const t = httpTabs[cursor++];
      const d = await extractSnippet(t);
      if (d) snippets.set(t.id, d);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, httpTabs.length) }, worker));

  const enriched = target.map(t => ({
    id: t.id, title: snippets.get(t.id)?.originalTitle ?? t.title, url: t.url,
    bookmarkPath: bookmarkOf.get(normalizeUrl(t.url)) || null,
    snippet: snippetText(snippets.get(t.id)) || null,
  }));
  const activePageStatus = activeHttp ? 'active-webpage'
    : active ? 'non-http-active-previous-page-unknown' : 'no-active-tab';
  const context = {
    activePageStatus,
    activePageNote: activeHttp ? null : '当前没有活跃 HTTP 网页；不知道此前浏览的页面，不应推断。',
    activeTab: activeHttp ? {
      id: active.id, title: snippets.get(active.id)?.originalTitle ?? active.title, url: active.url,
      bookmarkPath: bookmarkOf.get(normalizeUrl(active.url)) || null,
      snippet: snippetText(snippets.get(active.id)) || null,
    } : null,
    bookmarkFolders: folders.slice(0, 40),
    bookmarkCount: bookmarkOf.size,
  };
  const metaUpdates = [];
  for (const t of httpTabs) {
    const s = buildSnippetSummary(snippets.get(t.id));
    if (s) metaUpdates.push({ url: t.url, summary: s, source: 'snippet' });
  }
  if (metaUpdates.length) await updateTabMetaCache(metaUpdates);
  await chrome.storage.session.set({
    lastContext: {
      at: Date.now(), tabs: target.length,
      withSnippet: enriched.filter(t => t.snippet).length,
      bookmarked: enriched.filter(t => t.bookmarkPath).length,
      folders: folders.length, activeUrl: activeHttp?.url || null,
      activePageStatus, focusedUrl: active?.url || null,
    },
  });
  return { enriched, context };
}

/** Incremental analysis includes dirty navigations, even in existing groups. */
async function organize({ apply = false, incremental = false, windowId = null, automatic = false } = {}) {
  const settings = await getSettings();
  if (automatic && !settings.autoOrganize) return { ok: true, cancelled: true, applied: false };
  windowId = windowId ?? await currentWindowId();
  await autoReady;
  const all = await chrome.tabs.query({ windowId });
  const [locked, manualNamed] = await Promise.all([readLockedGroupIds(), readManualNamedGroups()]);
  const tabs = all.filter(t => isAnalysisTab(t, settings)
    && !(t.groupId !== -1 && (locked.has(t.groupId) || (incremental && manualNamed.has(t.groupId)))));
  const target = incremental ? tabs.filter(t => t.groupId === -1 || autoState.tabs[t.id]?.dirty) : tabs;
  // Freeze navigation revisions before advice/extraction/service latency, not afterwards.
  const revisions = new Map(target.map(t => [t.id, autoState.tabs[t.id]?.revision ?? null]));
  const cleanup = await organizeCleanup(windowId);
  if (!target.length) {
    return { ok: true, empty: true, cleanup, message: incremental ? '没有待整理的新标签页或内容变化' : '没有可整理的网页标签页' };
  }
  const existing = await chrome.tabGroups.query({ windowId });
  const { enriched, context } = await collectContext(target, all);
  const result = await callService(settings, {
    tabs: enriched, context, mode: incremental ? 'incremental' : 'full',
    existingGroups: existing.map(g => g.title), language: 'zh',
  });
  // Turning auto off cancels only alarm-owned work, never a manual/home request.
  if (automatic && !(await getSettings()).autoOrganize) return { ok: true, cancelled: true, applied: false };
  if (!result || !Array.isArray(result.groups) || !result.groups.length
      || result.groups.some(g => !g || typeof g.name !== 'string' || !Array.isArray(g.tabIds))) {
    throw new Error('整理服务未返回有效分组，保留待整理记录');
  }
  const returnedIds = new Set(result.groups.flatMap(g => g.tabIds));
  if (target.some(t => !returnedIds.has(t.id))) throw new Error('整理服务遗漏标签，保留待整理记录');
  const proposal = {
    windowId, incremental, groups: result.groups, source: result.source, cleanup,
    backend: result.backend || null, note: result.note || null, elapsedMs: result.elapsedMs ?? null,
    cache: result.cache || null, tabTitles: Array.isArray(result.tabTitles) ? result.tabTitles : [],
    analysisGuards: enriched.map(t => ({ id: t.id, url: t.url, snippet: t.snippet, originalTitle: t.title,
      groupId: target.find(tab => tab.id === t.id).groupId, revision: revisions.get(t.id) })),
    titleStats: { updated: 0, unchanged: 0, skipped: 0 },
    tabCount: target.length, createdAt: Date.now(), applied: false,
  };
  await chrome.storage.session.set({ proposal });
  return apply ? await applyOrganizeProposal(proposal, automatic) : { ok: true, ...proposal };
}

async function validateAnalysis(proposal) {
  const live = new Map((await chrome.tabs.query({ windowId: proposal.windowId })).map(t => [t.id, t]));
  const valid = new Set();
  for (const guard of proposal.analysisGuards || []) {
    const tab = live.get(guard.id);
    if (!tab || tab.url !== guard.url || (tab.pendingUrl && tab.pendingUrl !== guard.url) || tab.status === 'loading') continue;
    if (guard.snippet) {
      const fresh = await extractSnippet(tab);
      if (snippetText(fresh) !== guard.snippet) {
        if (fresh) await queueAutoTab(tab, { contentSignal: snippetText(fresh) });
        continue;
      }
    }
    valid.add(guard.id);
  }
  return valid;
}

async function writeTabTitles(proposal, valid) {
  const stats = { updated: 0, unchanged: 0, skipped: 0 };
  const rows = new Map((proposal.tabTitles || []).filter(row => row?.source === 'ai').map(row => [row.id, row]));
  for (const guard of proposal.analysisGuards || []) {
    const row = rows.get(guard.id);
    const title = Array.from(String(row?.title || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 48).join('');
    if (!valid.has(guard.id) || !guard.snippet || !/^https?:\/\//.test(guard.url || '') || !row || !title) {
      stats.skipped++; continue;
    }
    try {
      const tab = await chrome.tabs.get(guard.id);
      if (tab.url !== guard.url || tab.windowId !== proposal.windowId || tab.status === 'loading'
          || (tab.pendingUrl && tab.pendingUrl !== guard.url)) {
        stats.skipped++; valid.delete(guard.id); continue;
      }
      const result = await chrome.scripting.executeScript({ target: { tabId: guard.id }, func: pageExtractor,
        args: [{ title, url: guard.url, snippet: guard.snippet }] });
      const status = result?.[0]?.result?.status;
      if (status === 'updated' || status === 'unchanged') stats[status]++;
      else { stats.skipped++; valid.delete(guard.id); }
    } catch { stats.skipped++; valid.delete(guard.id); }
  }
  return stats;
}

async function applyOrganizeProposal(proposal, automatic = false) {
  const valid = await validateAnalysis(proposal);
  if (automatic && !(await getSettings()).autoOrganize) return { ok: true, cancelled: true, applied: false };
  // Legacy proposals have no capture guards/titles but must remain applicable.
  const snapshot = await applyProposal({ ...proposal, ...(proposal.analysisGuards ? { eligibleTabIds: [...valid] } : {}) });
  proposal.titleStats = await writeTabTitles(proposal, valid);
  proposal.applied = !!snapshot || !proposal.analysisGuards || valid.size > 0;
  const covered = new Set(proposal.groups.flatMap(g => g.tabIds));
  await clearAnalyzedDirty((proposal.analysisGuards || []).filter(g => valid.has(g.id) && covered.has(g.id)));
  if (Array.isArray(proposal.tabTitles) && proposal.tabTitles.length) {
    const guardById = new Map((proposal.analysisGuards || []).map(g => [g.id, g]));
    const metaUpdates = [];
    for (const row of proposal.tabTitles) {
      if (row?.source !== 'ai') continue;
      const guard = guardById.get(row.id);
      if (!guard?.url) continue;
      const summary = typeof row.summary === 'string' ? row.summary.trim() : '';
      metaUpdates.push({
        url: guard.url,
        title: row.title,
        ...(summary ? { summary } : {}),
        source: 'ai',
      });
    }
    if (metaUpdates.length) await updateTabMetaCache(metaUpdates);
  }
  const empty = !snapshot;
  const message = !proposal.applied ? '页面已变化或不可读取，跳过本次应用并保留待整理记录'
    : empty ? (proposal.cache?.hits ? '已复用分析缓存；现有分组无需变更' : '现有分组无需变更') : null;
  await chrome.storage.session.set({ proposal, lastRun: {
    at: Date.now(), applied: proposal.applied, source: proposal.source, backend: proposal.backend,
    groups: proposal.groups.length, tabs: proposal.tabCount, cache: proposal.cache || null,
    titleStats: proposal.titleStats, elapsedMs: proposal.elapsedMs, empty, cleanup: proposal.cleanup || null,
  } });
  if (snapshot) await pushHistory({ source: proposal.source, backend: proposal.backend,
    windowId: proposal.windowId, tabCount: proposal.tabCount, groups: proposal.groups, snapshot });
  return { ok: true, ...proposal, empty, ...(message ? { message } : {}) };
}

/** 把方案落到 chrome.tabGroups：同名组复用，新组建组；先存撤销快照（含位置）。
 *  应用后把标签条重排：组块连续、组内按 URL 排序 → 相同链接挨在一起。 */
const groupApplyQueues = new Map();
function applyProposal(proposal) {
  const previous = groupApplyQueues.get(proposal.windowId) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => applyProposalNow(proposal));
  groupApplyQueues.set(proposal.windowId, result);
  const cleanup = () => { if (groupApplyQueues.get(proposal.windowId) === result) groupApplyQueues.delete(proposal.windowId); };
  result.then(cleanup, cleanup);
  return result;
}

async function applyProposalNow(proposal) {
  const { windowId, groups } = proposal;
  const liveTabs = await chrome.tabs.query({ windowId });
  const byId = new Map(liveTabs.map(t => [t.id, t]));
  const eligible = proposal.eligibleTabIds ? new Set(proposal.eligibleTabIds) : null;
  const hits = new Set(proposal.cache?.hitTabIds || []);
  const guards = new Map((proposal.analysisGuards || []).map(t => [t.id, t]));
  const previouslyGrouped = new Set((proposal.analysisGuards || []).filter(t => t.groupId !== -1).map(t => t.id));
  const [existing, manualNamed] = await Promise.all([
    chrome.tabGroups.query({ windowId }),
    readManualNamedGroups(),
  ]);
  const plans = groups.map(g => {
    const ids = g.tabIds.filter(id => byId.has(id) && (!eligible || eligible.has(id))
      && (!guards.has(id) || (byId.get(id).url === guards.get(id).url && byId.get(id).status !== 'loading'
        && (!byId.get(id).pendingUrl || byId.get(id).pendingUrl === guards.get(id).url)))
      && !(proposal.incremental && hits.has(id) && previouslyGrouped.has(id)));
    // Prefer manually named group matching those tabs or matching target title, never overwriting manual titles.
    const manualMatch = existing.find(e => manualNamed.has(e.id) && (e.title === g.name || ids.some(id => byId.get(id).groupId === e.id)));
    const match = manualMatch
      || existing.find(e => e.title === g.name && ids.every(id => byId.get(id).groupId === e.id))
      || existing.find(e => e.title === g.name);
    const fixedTitle = match && manualNamed.has(match.id) ? manualNamed.get(match.id) : null;
    const targetTitle = fixedTitle ?? g.name;
    const moving = ids.filter(id => byId.get(id).groupId !== match?.id);
    const needsTitleFix = match && match.title !== targetTitle;
    return { g, ids, match, targetTitle, moving, change: ids.length && (!match || moving.length || match.color !== g.color || needsTitleFix) };
  });
  if (!plans.some(p => p.change)) return null; // Do not overwrite undo or invent history on cache-only no-ops.
  const snapshot = await snapshotUndo(windowId, liveTabs);
  const placed = new Set();
  const failures = [];
  for (const { g, ids, match, targetTitle, moving, change } of plans) {
    if (!ids.length) continue;
    if (!change) { ids.forEach(id => placed.add(id)); continue; }
    try {
      let groupId = match?.id;
      if (match) {
        if (moving.length) await chrome.tabs.group({ tabIds: moving, groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      }
      await chrome.tabGroups.update(groupId, { title: targetTitle, color: g.color, collapsed: false });
      ids.forEach(id => placed.add(id));
    } catch (e) {
      failures.push(`${g.name}: ${e?.message || e}`);
      console.warn(`分组 "${g.name}" 应用失败:`, e);
    }
  }
  if (failures.length) throw new Error(`应用分组失败，可撤销已完成的部分：${failures.join('；')}`);
  await reorderStrip(windowId, groups.flatMap(g => g.tabIds).filter(id => placed.has(id)));
  await chrome.action.setBadgeText({ text: String(groups.length) });
  await chrome.action.setBadgeBackgroundColor({ color: '#5B8CFF' });
  return snapshot;
}

/** 按当前原生分组整块重排；固定标签不动，未指定标签按原顺序补齐。 */
async function reorderStrip(windowId, orderedIds) {
  // Always query after grouping: pre-apply groupIds describe the old layout.
  const tabs = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index);
  const byId = new Map(tabs.filter(t => !t.pinned).map(t => [t.id, t]));
  const desired = [...new Set([...orderedIds, ...tabs.map(t => t.id)])].filter(id => byId.has(id));
  const blocks = [];
  const seenGroups = new Set();
  for (const id of desired) {
    const tab = byId.get(id);
    if (tab.groupId === -1) blocks.push({ groupId: -1, ids: [id] });
    else if (!seenGroups.has(tab.groupId)) {
      seenGroups.add(tab.groupId);
      // Include all live members, even when only a subset appeared in the plan.
      blocks.push({ groupId: tab.groupId, ids: desired.filter(member => byId.get(member).groupId === tab.groupId) });
    }
  }
  let index = tabs.filter(t => t.pinned).length;
  for (const block of blocks) {
    try {
      if (block.groupId !== -1) {
        const members = await chrome.tabs.query({ windowId, groupId: block.groupId });
        if (members.length && Math.min(...members.map(t => t.index)) !== index) {
          await chrome.tabGroups.move(block.groupId, { index });
        }
      }
      // A grouped tab may move only within its now-positioned group's range.
      // Moving individual members between blocks makes Chrome change membership.
      for (let offset = 0; offset < block.ids.length; offset++) {
        const cur = await chrome.tabs.get(block.ids[offset]);
        if (!cur.pinned && cur.index !== index + offset) {
          await chrome.tabs.move(cur.id, { index: index + offset });
        }
      }
    } catch (e) {
      console.warn('重排标签块失败:', e);
    }
    index += block.ids.length;
  }
}

/** 按快照恢复分组状态与位置（撤销 / 历史回滚共用） */
async function applySnapshot(snapshot, windowId) {
  // v1 stored only an array of tabs; metadata is unavailable but membership can
  // still be restored, including recreating groups whose IDs no longer exist.
  const entries = Array.isArray(snapshot) ? snapshot : snapshot?.tabs || [];
  const metadata = new Map((snapshot?.groups || []).map(g => [g.id, g]));
  const liveTabs = await chrome.tabs.query({ windowId });
  const liveIds = new Set(liveTabs.map(t => t.id));
  const groups = await chrome.tabGroups.query({ windowId });
  // Keep live metadata as a fallback for legacy snapshots before ungrouping
  // potentially destroys the final tab in an original group.
  for (const g of groups) if (!metadata.has(g.id)) metadata.set(g.id, g);
  const byGroup = new Map();
  for (const { tabId, groupId } of entries) {
    if (!liveIds.has(tabId)) continue;
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(tabId);
  }
  const restoredGroups = [];
  const failures = [];
  // Detach first: restoring one group can otherwise destroy another group's ID.
  const idsToRestore = [...byGroup.values()].flat();
  if (idsToRestore.length) await chrome.tabs.ungroup(idsToRestore);
  // Move detached tabs first: moving a grouped tab across group boundaries can
  // change its membership or expand a collapsed group in Chrome.
  const withIndex = entries.filter(s => Number.isInteger(s.index) && liveIds.has(s.tabId))
    .sort((a, b) => a.index - b.index);
  for (const s of withIndex) {
    try {
      const cur = await chrome.tabs.get(s.tabId);
      if (cur.index !== s.index) await chrome.tabs.move(s.tabId, { index: s.index });
    } catch { /* 标签可能已关闭 */ }
  }
  const valid = new Set((await chrome.tabGroups.query({ windowId })).map(g => g.id));
  for (const [gid, ids] of byGroup) {
    if (gid === -1) continue;
    try {
      const restoredId = valid.has(gid)
        ? await chrome.tabs.group({ tabIds: ids, groupId: gid })
        : await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      const saved = metadata.get(gid);
      if (saved) await chrome.tabGroups.update(restoredId, {
        title: saved.title || '', color: saved.color || 'grey', collapsed: !!saved.collapsed,
      });
      restoredGroups.push(restoredId);
    } catch (e) {
      failures.push(`${gid}: ${e?.message || e}`);
      console.warn('恢复分组部分失败:', e);
    }
  }
  if (failures.length) throw new Error(`恢复分组失败，已保留撤销快照：${failures.join('；')}`);
  return { groups: restoredGroups.length, tabs: idsToRestore.length };
}

/* ---------------- 手动拖拽（首页 DnD → 原生标签条） ---------------- */

async function snapshotUndo(windowId, liveTabs = null) {
  liveTabs = liveTabs || await chrome.tabs.query({ windowId });
  const groups = await chrome.tabGroups.query({ windowId });
  const snapshot = {
    version: 2,
    tabs: liveTabs.map(t => ({ tabId: t.id, groupId: t.groupId, index: t.index })),
    groups: groups.map(g => ({
      id: g.id, title: g.title || '', color: g.color, collapsed: !!g.collapsed,
      index: Math.min(...liveTabs.filter(t => t.groupId === g.id).map(t => t.index)),
    })),
  };
  await chrome.storage.session.set({ undo: { windowId, snapshot, at: Date.now() } });
  return snapshot;
}

async function dragTabMove({ tabId, groupId = null, windowId = null }) {
  const tab = await chrome.tabs.get(tabId);
  windowId = windowId ?? tab.windowId;
  if (tab.windowId !== windowId) throw new Error('不支持跨窗口拖动标签页');
  if (groupId != null) {
    const targetGroups = await chrome.tabGroups.query({ windowId });
    if (!targetGroups.some(g => g.id === groupId)) throw new Error('目标分组不在当前窗口或已不存在');
  }
  const snapshot = await snapshotUndo(windowId);
  if (groupId == null) await chrome.tabs.ungroup([tabId]);
  else await chrome.tabs.group({ tabIds: [tabId], groupId });
  const groups = await chrome.tabGroups.query({ windowId });
  await pushHistory({
    source: 'drag', backend: null, windowId, tabCount: 1,
    groups: groups.map(g => ({ name: g.title, color: g.color, tabIds: [] })), snapshot,
  });
  return { ok: true };
}

async function dragGroupReorder({ windowId, order }) {
  windowId = windowId ?? await currentWindowId();
  const available = new Set((await chrome.tabGroups.query({ windowId })).map(g => g.id));
  if (!Array.isArray(order) || order.some(id => !available.has(id))) {
    throw new Error('拖动排序的分组不在当前窗口或已不存在');
  }
  const snapshot = await snapshotUndo(windowId);
  const tabs = await chrome.tabs.query({ windowId });
  const ordered = [];
  for (const gid of order) {
    ordered.push(...tabs.filter(t => t.groupId === gid).sort((a, b) => a.index - b.index).map(t => t.id));
  }
  await reorderStrip(windowId, ordered);
  const groups = await chrome.tabGroups.query({ windowId });
  await pushHistory({
    source: 'drag', backend: null, windowId, tabCount: ordered.length,
    groups: groups.map(g => ({ name: g.title, color: g.color, tabIds: [] })), snapshot,
  });
  return { ok: true };
}

async function undo() {
  const { undo } = await chrome.storage.session.get('undo');
  if (!undo) return { ok: false, message: '没有可撤销的操作' };
  await applySnapshot(undo.snapshot, undo.windowId);
  await chrome.storage.session.remove('undo');
  const { proposal } = await chrome.storage.session.get('proposal');
  if (proposal) await chrome.storage.session.set({ proposal: { ...proposal, applied: false } });
  await chrome.action.setBadgeText({ text: '' });
  return { ok: true };
}

/* ---------------- 整理历史（持久化，最近 20 次，可回滚） ---------------- */

const HISTORY_KEY = 'orgHistory';
const HISTORY_CAP = 20;
let historyQueue = Promise.resolve();

function pushHistory(entry) {
  // Independent window alarms may finish together; preserve both snapshots.
  const result = historyQueue.then(async () => {
    const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
    const run = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...entry };
    await chrome.storage.local.set({ [HISTORY_KEY]: [run, ...history].slice(0, HISTORY_CAP) });
    return run;
  });
  historyQueue = result.catch(() => {});
  return result;
}

async function listHistory() {
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  return history.map(({ snapshot, ...rest }) => rest); // 列表不带快照，减小消息体积
}

async function rollbackHistory(id) {
  const { [HISTORY_KEY]: history = [] } = await chrome.storage.local.get(HISTORY_KEY);
  const run = history.find(h => h.id === id);
  if (!run) return { ok: false, message: '历史记录不存在' };
  await snapshotUndo(run.windowId);
  const restored = await applySnapshot(run.snapshot, run.windowId);
  const { proposal } = await chrome.storage.session.get('proposal');
  await chrome.storage.session.set({
    ...(proposal ? { proposal: { ...proposal, applied: false } } : {}),
    lastRun: { at: Date.now(), applied: true, source: 'rollback', backend: run.backend, groups: restored.groups, tabs: restored.tabs },
  });
  await chrome.action.setBadgeText({ text: restored.groups ? String(restored.groups) : '' });
  return { ok: true, groups: restored.groups };
}

/* ---------------- 空间（持久化分组快照，可恢复） ---------------- */

const SPACES_KEY = 'spaces';
const SPACES_CAP = 12;

async function saveSpace(name, windowId = null) {
  windowId = windowId ?? await currentWindowId();
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ]);
  const byGroup = new Map(groups.map(g => [g.id, { name: g.title || '未命名组', color: g.color, urls: [] }]));
  const ungrouped = [];
  for (const t of tabs) {
    if (!/^https?:\/\//.test(t.url || '')) continue;
    if (t.groupId !== -1 && byGroup.has(t.groupId)) byGroup.get(t.groupId).urls.push(t.url);
    else ungrouped.push(t.url);
  }
  const saved = [...byGroup.values()].filter(g => g.urls.length);
  if (ungrouped.length) saved.push({ name: '未分组', color: 'grey', urls: ungrouped });
  if (!saved.length) return { ok: false, message: '当前窗口没有可保存的网页标签' };
  const { [SPACES_KEY]: spaces = [] } = await chrome.storage.local.get(SPACES_KEY);
  const space = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: (name || '').trim() || `空间 ${spaces.length + 1}`,
    at: Date.now(),
    groups: saved,
  };
  await chrome.storage.local.set({ [SPACES_KEY]: [space, ...spaces].slice(0, SPACES_CAP) });
  return { ok: true, space };
}

async function listSpaces() {
  const { [SPACES_KEY]: spaces = [] } = await chrome.storage.local.get(SPACES_KEY);
  return spaces.map(s => ({ ...s, tabCount: s.groups.reduce((n, g) => n + g.urls.length, 0) }));
}

async function restoreSpace(id) {
  const { [SPACES_KEY]: spaces = [] } = await chrome.storage.local.get(SPACES_KEY);
  const space = spaces.find(s => s.id === id);
  if (!space) return { ok: false, message: '空间不存在' };
  const windowId = await currentWindowId();
  const existing = await chrome.tabGroups.query({ windowId });
  let tabCount = 0, groupCount = 0;
  for (const g of space.groups) {
    const ids = [];
    for (const url of g.urls) {
      try {
        const t = await chrome.tabs.create({ url, windowId, active: false });
        ids.push(t.id);
        tabCount++;
      } catch { /* URL 可能失效 */ }
    }
    if (!ids.length) continue;
    try {
      const match = existing.find(e => e.title === g.name);
      let groupId;
      if (match) {
        groupId = match.id;
        await chrome.tabs.group({ tabIds: ids, groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        existing.push({ id: groupId, title: g.name });
      }
      await chrome.tabGroups.update(groupId, { title: g.name, color: g.color, collapsed: false });
      groupCount++;
    } catch (e) {
      console.warn('空间建组失败:', e);
    }
  }
  return { ok: true, tabs: tabCount, groups: groupCount, name: space.name };
}

async function deleteSpace(id) {
  const { [SPACES_KEY]: spaces = [] } = await chrome.storage.local.get(SPACES_KEY);
  await chrome.storage.local.set({ [SPACES_KEY]: spaces.filter(s => s.id !== id) });
  return { ok: true };
}

/* ---------------- 生命周期：只读建议、原生分组归档、真实工作标签 ---------------- */
const GROUP_ARCHIVES_KEY = 'groupArchives';
const ARCHIVE_SESSION_KEY = 'groupArchiveBrowserSession';
const ARCHIVE_AUTO_KEY = 'archiveRestoredTabs';
const ACTIVE_WORK_KEY = 'activeWorkTabs';
const ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;
let archiveQueue = Promise.resolve();
const archiveInFlight = new Map();
let archiveSessionReady = null;
let restoredAutoReady = null;
let restoredAutoTabs = {};

function requireLifecycleSender(sender) {
  if (!ownedTopPage(sender)) throw new Error('仅允许扩展自有顶层页面执行此操作');
}
function lifecycleWindowId(id) {
  if (id != null && (!Number.isInteger(id) || id < 0)) throw new Error('窗口 ID 必须为非负整数');
  return id ?? null;
}
function validLastAccessed(value, now) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= now;
}
async function cleanupAdvice(windowId = null) {
  windowId = lifecycleWindowId(windowId);
  const [tabs, locked] = await Promise.all([
    chrome.tabs.query(windowId == null ? {} : { windowId }),
    readLockedGroupIds(),
  ]);
  const evaluatedAt = Date.now(), candidates = [];
  let unknownCount = 0;
  for (const tab of tabs) {
    if (tab.groupId !== -1 && locked.has(tab.groupId)) continue;
    if (!/^https?:\/\//i.test(tab.url || '') || tab.active || tab.pinned || tab.audible) continue;
    if (!validLastAccessed(tab.lastAccessed, evaluatedAt)) { unknownCount++; continue; }
    const idleDays = (evaluatedAt - tab.lastAccessed) / 86400000;
    if (idleDays < 7) continue;
    candidates.push({ id: tab.id, windowId: tab.windowId, groupId: tab.groupId, title: tab.title || '',
      url: tab.url, lastAccessed: tab.lastAccessed, idleDays: Math.floor(idleDays), discarded: !!tab.discarded });
  }
  candidates.sort((a, b) => a.lastAccessed - b.lastAccessed || a.id - b.id);
  const result = { ok: true, windowId, evaluatedAt, basis: 'lastAccessed', thresholdDays: 7,
    unknownCount, eligibleCount: candidates.length, candidates: candidates.slice(0, 50) };
  await chrome.storage.session.set({ lastCleanupAdvice: result });
  return result; // Advice only. Chrome exposes last access, NOT creation age.
}
async function organizeCleanup(windowId) {
  try { return await cleanupAdvice(windowId); }
  catch { return null; } // Advice/storage availability must not change a paid/model operation.
}
async function cleanupClose({ windowId = null, tabIds = null } = {}) {
  windowId = lifecycleWindowId(windowId);
  const locked = await readLockedGroupIds();
  let targetIds = [];
  let skippedLocked = 0;
  if (Array.isArray(tabIds)) {
    const requested = new Set(tabIds.filter(id => Number.isInteger(id) && id > 0));
    if (requested.size) {
      const live = await chrome.tabs.query(windowId == null ? {} : { windowId });
      for (const t of live) {
        if (!requested.has(t.id) || !/^https?:\/\//i.test(t.url || '') || t.active || t.pinned || t.audible) continue;
        if (t.groupId !== -1 && locked.has(t.groupId)) { skippedLocked++; continue; }
        targetIds.push(t.id);
      }
    }
  } else {
    const advice = await cleanupAdvice(windowId);
    targetIds = advice.candidates.filter(c => !(c.groupId !== -1 && locked.has(c.groupId))).map(c => c.id);
  }
  let closed = 0;
  let failed = 0;
  if (targetIds.length) {
    try {
      await chrome.tabs.remove(targetIds);
      closed = targetIds.length;
    } catch {
      for (const id of targetIds) {
        try {
          await chrome.tabs.remove(id);
          closed++;
        } catch {
          failed++;
        }
      }
    }
  }
  const advice = await cleanupAdvice(windowId);
  return { ok: true, windowId, closed, failed, skippedLocked, advice };
}
async function discardIdleTabs({ windowId = null, minIdleMinutes = 0, tabIds = null, skipLocked = false } = {}) {
  windowId = lifecycleWindowId(windowId);
  const minMs = Math.max(0, Number(minIdleMinutes) || 0) * 60_000;
  const requested = Array.isArray(tabIds) ? new Set(tabIds.filter(id => Number.isInteger(id) && id > 0)) : null;
  const now = Date.now();
  const [tabs, locked] = await Promise.all([
    chrome.tabs.query(windowId == null ? {} : { windowId }),
    skipLocked ? readLockedGroupIds() : Promise.resolve(new Set()),
  ]);
  const candidates = tabs.filter(tab => {
    if (requested && !requested.has(tab.id)) return false;
    if (skipLocked && tab.groupId !== -1 && locked.has(tab.groupId)) return false;
    if (!/^https?:\/\//i.test(tab.url || '') || tab.active || tab.pinned || tab.audible || tab.discarded) return false;
    if (minMs > 0) {
      if (!validLastAccessed(tab.lastAccessed, now)) return false;
      if (now - tab.lastAccessed < minMs) return false;
    }
    return true;
  });
  let discarded = 0;
  let failed = 0;
  if (typeof chrome.tabs?.discard === 'function') {
    for (const tab of candidates) {
      try {
        const res = await chrome.tabs.discard(tab.id);
        if (res === null) failed++;
        else discarded++;
      } catch {
        failed++;
      }
    }
  }
  return { ok: true, windowId, eligibleCount: candidates.length, discarded, failed };
}
function archiveLock(key, task) {
  if (archiveInFlight.has(key)) return archiveInFlight.get(key);
  const result = archiveQueue.then(task);
  archiveQueue = result.catch(() => {});
  archiveInFlight.set(key, result);
  const done = () => { if (archiveInFlight.get(key) === result) archiveInFlight.delete(key); };
  result.then(done, done);
  return result;
}
function archiveBrowserSession() {
  return archiveSessionReady ||= (async () => {
    const saved = (await chrome.storage.session.get(ARCHIVE_SESSION_KEY))[ARCHIVE_SESSION_KEY];
    if (typeof saved === 'string' && saved) return saved;
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await chrome.storage.session.set({ [ARCHIVE_SESSION_KEY]: id });
    return id;
  })();
}
function loadRestoredAutoTabs() {
  return restoredAutoReady ||= (async () => {
    restoredAutoTabs = (await chrome.storage.session.get(ARCHIVE_AUTO_KEY))[ARCHIVE_AUTO_KEY] || {};
  })();
}
async function suppressRestoredAuto(tabId, url, windowId) {
  await loadRestoredAutoTabs();
  if (restoredAutoTabs[tabId]?.sourceUrl === url && restoredAutoTabs[tabId]?.windowId === windowId) return;
  restoredAutoTabs[tabId] = { url, sourceUrl: url, windowId, initialLoad: true };
  await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
}
function archivePlaceholderTab(tab, sourceUrl) {
  const marker = value => typeof value === 'string' && value.startsWith('about:blank#ai-group-archive-');
  return marker(tab?.url) || marker(tab?.pendingUrl)
    || ((!tab?.url || tab.url === 'about:blank') && tab?.url !== sourceUrl);
}
function archiveRestorableUrl(value) {
  try {
    const url = new URL(value);
    // Include browser-restricted pages and file links: restoration needs no injection.
    return ['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'brave:', 'edge:', 'vivaldi:', 'opera:', 'chrome-extension:'].includes(url.protocol)
      || (url.protocol === 'about:' && ['blank', 'newtab'].includes(url.pathname));
  } catch { return false; }
}
async function readGroupArchives() {
  const records = (await chrome.storage.local.get(GROUP_ARCHIVES_KEY))[GROUP_ARCHIVES_KEY] || [];
  if (!Array.isArray(records)) throw new Error('分组归档数据损坏，已停止操作');
  return records;
}
function archiveTabCount(records) {
  return records.reduce((n, r) => n + (r.groups || []).reduce((sum, g) => sum + (g.tabs || []).length, 0), 0);
}
async function writeGroupArchives(records) {
  const text = JSON.stringify(records);
  let bytes = 0;
  for (const char of text) { const n = char.codePointAt(0); bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
  // Never silently evict recovery data to make room for a destructive operation.
  if (records.length > 20 || archiveTabCount(records) > 2000 || bytes > ARCHIVE_MAX_BYTES) {
    throw new Error('归档容量不足（最多 20 批、2000 个标签、8 MiB），请先恢复或删除旧归档；未关闭标签');
  }
  await chrome.storage.local.set({ [GROUP_ARCHIVES_KEY]: records });
}
async function liveArchiveTab(id) {
  try { return await chrome.tabs.get(id); } catch { return null; }
}
function closeGroupArchive(msg) {
  const windowId = lifecycleWindowId(msg.windowId);
  if (!Array.isArray(msg.groupIds) || !msg.groupIds.length || msg.groupIds.length > 50
      || msg.groupIds.some(id => !Number.isInteger(id) || id < 0)) throw new Error('请选择最多 50 个真实原生分组');
  const ids = [...new Set(msg.groupIds)].sort((a, b) => a - b);
  return archiveLock(`close:${windowId}:${ids.join(',')}`, async () => {
    const available = await chrome.tabGroups.query(windowId == null ? {} : { windowId });
    if (ids.some(id => !available.some(g => g.id === id))) throw new Error('分组不存在或不在指定窗口；未关闭标签');
    const groups = [];
    for (const id of ids) {
      const group = available.find(g => g.id === id);
      const members = (await chrome.tabs.query({ windowId: group.windowId, groupId: id }))
        .filter(t => t.groupId === id && t.windowId === group.windowId).sort((a, b) => a.index - b.index);
      if (!members.length) throw new Error('分组已为空；未关闭标签');
      if (members.some(t => !archiveRestorableUrl(t.url) || (t.pendingUrl && t.pendingUrl !== t.url))) {
        throw new Error('分组含不可安全恢复的地址或正在跳转；未关闭标签');
      }
      groups.push({ id, windowId: group.windowId, title: group.title || '', color: group.color || 'grey',
        collapsed: !!group.collapsed, index: members[0].index,
        tabs: members.map(t => ({ id: t.id, index: t.index, title: t.title || '', url: t.url, state: 'pending' })) });
    }
    if (groups.reduce((n, g) => n + g.tabs.length, 0) > 1000) throw new Error('每批最多归档 1000 个标签；未关闭标签');
    groups.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
    const records = await readGroupArchives();
    const at = Date.now();
    const archive = { version: 1, id: `archive-${at}-${Math.random().toString(36).slice(2)}`, at,
      browserSession: await archiveBrowserSession(), groups };
    records.unshift(archive);
    await writeGroupArchives(records); // Full durable snapshot BEFORE the first remove.
    let closedTabs = 0, closedGroups = 0, changed = false, error = null;
    for (const group of groups) {
      for (const saved of group.tabs) {
        const live = await liveArchiveTab(saved.id);
        if (!live) { saved.state = 'missing'; changed = true; }
        else if (live.windowId !== group.windowId || live.groupId !== group.id || live.url !== saved.url
            || (live.pendingUrl && live.pendingUrl !== saved.url)) { saved.state = 'live'; changed = true; }
        else {
          try {
            // Checkpoint intent too: if the worker is terminated during remove,
            // same-session recovery checks the real ID; no URL ever disappears.
            saved.state = 'closing'; await writeGroupArchives(records);
            // Storage latency may allow a move/navigation; validate AGAIN after persistence.
            const current = await liveArchiveTab(saved.id);
            if (!current) { saved.state = 'missing'; changed = true; }
            else if (current.windowId !== group.windowId || current.groupId !== group.id || current.url !== saved.url
                || (current.pendingUrl && current.pendingUrl !== saved.url)) { saved.state = 'live'; changed = true; }
            else {
              try { await chrome.tabs.remove(saved.id); } catch (e) { error = e; }
              const remaining = await liveArchiveTab(saved.id);
              saved.state = remaining ? 'live' : 'missing';
              if (!remaining) closedTabs++; else changed = true;
            }
          } catch (e) { error = e; changed = true; break; }
        }
        try { await writeGroupArchives(records); } catch (e) { error = e; changed = true; break; }
      }
      if (error && group.tabs.some(t => t.state === 'closing' || t.state === 'pending')) break;
    }
    for (const group of groups) {
      const members = await chrome.tabs.query({ windowId: group.windowId, groupId: group.id }).catch(() => null);
      if ((!members || !members.length) && group.tabs.every(t => t.state === 'missing')) closedGroups++;
      else changed = true;
    }
    return { ok: closedTabs > 0 || !error, id: archive.id, closedTabs, closedGroups,
      partial: changed || !!error, ...(changed || error ? { message: '部分标签未关闭或已移动；已保留归档，只恢复缺失链接。' } : {}) };
  });
}
function archiveSummary(record) {
  const groups = (record.groups || []).map(g => ({ title: g.title, color: g.color, collapsed: g.collapsed,
    windowId: g.windowId, index: g.index, tabCount: (g.tabs || []).filter(t => t.state !== 'live').length }));
  return { id: record.id, at: record.at, groupCount: groups.filter(g => g.tabCount).length,
    tabCount: groups.reduce((n, g) => n + g.tabCount, 0), groups, restoring: !!record.restore };
}
function listGroupArchives() {
  return archiveLock('list', async () => ({ ok: true, archives: (await readGroupArchives()).map(archiveSummary) }));
}
async function archiveTargetWindow(record, requested) {
  if (requested != null) {
    const win = await getBrowserSearchWindow(lifecycleWindowId(requested));
    if (win?.type !== 'normal') throw new Error('恢复目标必须是仍存在的普通浏览器窗口');
    return win.id;
  }
  for (const group of record.groups) if ((await getBrowserSearchWindow(group.windowId))?.type === 'normal') return group.windowId;
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win?.type === 'normal') return win.id;
  } catch { /* No normal focused window. */ }
  const [win] = await chrome.windows.getAll?.({ windowTypes: ['normal'] }) || [];
  if (win?.type !== 'normal') throw new Error('没有可恢复的普通浏览器窗口');
  return win.id;
}
function restoreGroupArchive(msg) {
  if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 200) throw new Error('归档 ID 无效');
  lifecycleWindowId(msg.targetWindowId);
  return archiveLock(`restore:${msg.id}`, async () => {
    const records = await readGroupArchives();
    const archive = records.find(r => r.id === msg.id);
    if (!archive) return { ok: false, restoredTabs: 0, restoredGroups: 0, message: '归档不存在或已恢复' };
    const browserSession = await archiveBrowserSession();
    if (archive.restore && archive.restore.browserSession !== browserSession) {
      // Native tab IDs are reusable across browser restarts. Never adopt/delete
      // an unrelated live tab or duplicate an uncertain interrupted restoration.
      return { ok: false, restoredTabs: 0, restoredGroups: 0, partial: true,
        message: '上次恢复跨浏览器重启中断；为避免重复恢复，已保留归档，请先检查现有标签。' };
    }
    let restoredTabs = 0, restoredGroups = 0;
    try {
      const windowId = archive.restore?.windowId ?? await archiveTargetWindow(archive, msg.targetWindowId);
      if ((await getBrowserSearchWindow(windowId))?.type !== 'normal') throw new Error('恢复中的目标窗口已关闭，归档仍保留');
      if (!archive.restore) {
        archive.restore = { browserSession, windowId, token: `${Date.now()}-${Math.random().toString(36).slice(2)}`, mapping: {} };
        await writeGroupArchives(records);
      }
      const journal = archive.restore;
      await loadRestoredAutoTabs();
      for (let gi = 0; gi < archive.groups.length; gi++) {
        const group = archive.groups[gi], ids = [];
        for (let ti = 0; ti < group.tabs.length; ti++) {
          const saved = group.tabs[ti], key = `${gi}:${ti}`;
          if (saved.state === 'live') continue;
          // Partial close: live originals (including moved ones) are not recreated.
          if (!journal.mapping[key] && archive.browserSession === browserSession && await liveArchiveTab(saved.id)) continue;
          const marker = `about:blank#ai-group-archive-${journal.token}-${gi}-${ti}`;
          let live = journal.mapping[key] ? await liveArchiveTab(journal.mapping[key].id) : null;
          const suppression = live && restoredAutoTabs[live.id];
          const knownUrls = [saved.url, marker, ...(suppression?.sourceUrl === saved.url ? [suppression.url] : [])];
          const provisional = live && (!live.url || live.url === 'about:blank') && knownUrls.includes(live.pendingUrl);
          if (live && (live.windowId !== windowId || (!knownUrls.includes(live.url) && !provisional)
              || (live.pendingUrl && !knownUrls.includes(live.pendingUrl)))) {
            throw new Error('本次恢复的标签已移动或改变，请检查后重试；不会操作该标签');
          }
          if (!live && journal.mapping[key]) throw new Error('本次恢复的标签已关闭，已保留归档避免重复创建');
          if (!live) {
            // Unique inactive placeholder closes the create -> journal crash gap.
            // On worker restart it is discoverable without trusting recycled IDs.
            live = (await chrome.tabs.query({})).find(t => t.url === marker || t.pendingUrl === marker);
            if (live && live.windowId !== windowId) throw new Error('恢复占位标签已移动，已保留归档且不会重复创建');
            if (!live) live = await chrome.tabs.create({ url: marker, windowId, active: false });
            journal.mapping[key] = { id: live.id };
            await writeGroupArchives(records);
          }
          await suppressRestoredAuto(live.id, saved.url, windowId);
          if ((live.url === marker || live.pendingUrl === marker) && live.pendingUrl !== saved.url) {
            await chrome.tabs.update(live.id, { url: saved.url });
          }
          ids.push(live.id); restoredTabs++;
        }
        if (!ids.length) continue;
        // Reuse only a group composed EXACTLY of this restoration's own tabs.
        // Never merge same-name groups or move unrelated members on retry.
        const live = await chrome.tabs.query({ windowId });
        const own = new Set(ids), possible = live.find(t => own.has(t.id))?.groupId;
        const reusable = Number.isInteger(possible) && possible >= 0
          && live.filter(t => t.groupId === possible).every(t => own.has(t.id))
          && ids.every(id => live.some(t => t.id === id && t.groupId === possible));
        const groupId = reusable ? possible : await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        const pinned = live.filter(t => t.pinned).length;
        const index = Math.max(pinned, Math.min(group.index, Math.max(pinned, live.length - ids.length)));
        await chrome.tabGroups.move(groupId, { index });
        await chrome.tabGroups.update(groupId, { title: group.title, color: group.color, collapsed: !!group.collapsed });
        restoredGroups++;
      }
      await writeGroupArchives(records.filter(r => r.id !== archive.id));
      return { ok: true, restoredTabs, restoredGroups, partial: false };
    } catch (error) {
      // Keep the durable mapping and all original links for an idempotent retry.
      return { ok: false, restoredTabs, restoredGroups, partial: true,
        message: `恢复未完成，归档已保留，可重试且不会重复创建：${error?.message || error}` };
    }
  });
}
function deleteGroupArchive(id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('归档 ID 无效');
  return archiveLock(`delete:${id}`, async () => {
    const records = await readGroupArchives();
    // Queue excludes an actually running restoration. Deleting an interrupted
    // journal deletes only recovery data, NEVER its already-created live tabs.
    await writeGroupArchives(records.filter(r => r.id !== id));
    return { ok: true };
  });
}

let activeWorkQueue = Promise.resolve();
let activeWorkReady = null;
let activeWorkTabs = {};
let activeWorkSaved = '{}';
const activeWorkSeq = new Map();
function withActiveWork(task) {
  const result = activeWorkQueue.then(async () => {
    await (activeWorkReady ||= (async () => {
      activeWorkTabs = (await chrome.storage.session.get(ACTIVE_WORK_KEY))[ACTIVE_WORK_KEY] || {};
      activeWorkSaved = JSON.stringify(activeWorkTabs);
    })());
    return await task();
  });
  activeWorkQueue = result.catch(() => {});
  return result;
}
async function persistActiveWork() {
  const value = JSON.stringify(activeWorkTabs);
  if (value === activeWorkSaved) return; // UI reads after onChanged must not self-trigger an update loop.
  await chrome.storage.session.set({ [ACTIVE_WORK_KEY]: activeWorkTabs });
  activeWorkSaved = value;
}
function rememberActiveWork(windowId, tabId) {
  if (activeWorkTabs[windowId]?.tabId !== tabId) activeWorkTabs[windowId] = { tabId, at: Date.now() };
}
function isWorkTab(tab) {
  if (!tab || typeof tab.url !== 'string' || !tab.url || tab.url.startsWith(chrome.runtime.getURL(''))) return false;
  if (localSearchPage(tab.url) || localSearchPage(tab.pendingUrl)) return false;
  if (/^about:(blank|newtab)(?:[?#]|$)/i.test(tab.url)) return false;
  if (tab.pendingUrl?.startsWith(chrome.runtime.getURL(''))) return false;
  return archiveRestorableUrl(tab.url);
}
async function activeWorkTab(windowId = null) {
  windowId = lifecycleWindowId(windowId);
  return await withActiveWork(async () => {
    if (windowId == null) {
      let focused = null;
      try { focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { /* No focused window. */ }
      if (focused?.type === 'normal') windowId = focused.id;
      else windowId = (await chrome.windows.getAll?.({ windowTypes: ['normal'] }) || []).find(w => w.type === 'normal')?.id ?? null;
    }
    const none = { ok: true, tabId: null, windowId, groupId: -1, mode: 'none' };
    if (windowId == null || (await getBrowserSearchWindow(windowId))?.type !== 'normal') return none;
    const tabs = await chrome.tabs.query({ windowId });
    const active = tabs.find(t => t.active && isWorkTab(t));
    let tab = active;
    if (!tab) {
      tab = tabs.find(t => t.id === activeWorkTabs[windowId]?.tabId && isWorkTab(t));
      if (!tab) {
        delete activeWorkTabs[windowId];
        const now = Date.now();
        tab = tabs.filter(t => isWorkTab(t) && validLastAccessed(t.lastAccessed, now))
          .sort((a, b) => b.lastAccessed - a.lastAccessed || a.index - b.index)[0];
      }
    }
    if (tab) rememberActiveWork(windowId, tab.id);
    await persistActiveWork();
    return tab ? { ok: true, tabId: tab.id, windowId, groupId: tab.groupId ?? -1, mode: active ? 'active' : 'recent' } : none;
  });
}
function observeActiveWork(windowId, tabId = null) {
  const seq = (activeWorkSeq.get(windowId) || 0) + 1;
  activeWorkSeq.set(windowId, seq);
  return withActiveWork(async () => {
    let tab = tabId == null ? (await chrome.tabs.query({ windowId, active: true }))[0] : await liveArchiveTab(tabId);
    if (seq !== activeWorkSeq.get(windowId)) return;
    if (tab?.active && tab.windowId === windowId && isWorkTab(tab)) rememberActiveWork(windowId, tab.id);
    else if (tab && activeWorkTabs[windowId]?.tabId === tab.id && !isWorkTab(tab)) delete activeWorkTabs[windowId];
    await persistActiveWork();
  }).catch(e => console.warn('观察工作标签失败:', e));
}
function forgetActiveWork(tabId, windowId = null) {
  if (windowId != null) activeWorkSeq.set(windowId, (activeWorkSeq.get(windowId) || 0) + 1);
  return withActiveWork(async () => {
    for (const [id, row] of Object.entries(activeWorkTabs)) if (row.tabId === tabId) delete activeWorkTabs[id];
    await persistActiveWork();
  }).catch(e => console.warn('清理工作标签失败:', e));
}
chrome.tabs.onActivated?.addListener(info => observeActiveWork(info.windowId, info.tabId));
chrome.tabs.onUpdated?.addListener((id, info, tab) => {
  if (info.url || info.status || info.groupId != null) {
    if (tab?.windowId != null) return observeActiveWork(tab.windowId, id);
    return liveArchiveTab(id).then(t => t && observeActiveWork(t.windowId, id));
  }
});
chrome.tabs.onRemoved?.addListener(id => forgetActiveWork(id));
chrome.tabs.onDetached?.addListener((id, info) => forgetActiveWork(id, info.oldWindowId));
chrome.tabs.onAttached?.addListener((id, info) => forgetActiveWork(id).then(() => observeActiveWork(info.newWindowId, id)));
chrome.windows.onFocusChanged?.addListener(id => {
  if (Number.isInteger(id) && id >= 0) return observeActiveWork(id);
});
chrome.windows.onRemoved?.addListener(id => withActiveWork(async () => {
  activeWorkSeq.set(id, (activeWorkSeq.get(id) || 0) + 1);
  delete activeWorkTabs[id]; await persistActiveWork();
}).catch(e => console.warn('清理工作窗口失败:', e)));

/* ---------------- 一键去重（保留活跃/最左标签，可恢复） ---------------- */

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = ''; // 同页不同锚点视为重复
    return u.href;
  } catch {
    return url;
  }
}

function isNewTabPageUrl(url) {
  if (typeof url !== 'string' || !url || url.includes('focusGroup=')) return false;
  const clean = url.split(/[?#]/, 1)[0];
  if (chrome.runtime?.getURL && clean === chrome.runtime.getURL('home.html')) return true;
  return /^(?:chrome|brave|edge|vivaldi|opera):\/\/(?:newtab|new-tab-page)\/?$/i.test(clean);
}

function isDedupable(t) {
  if (!t || t.pinned) return false;
  return /^https?:\/\//.test(t.url || '') || isNewTabPageUrl(t.url || t.pendingUrl || '');
}

function dedupKeyForTab(t) {
  const url = t.url || t.pendingUrl || '';
  if (isNewTabPageUrl(url)) return `newtab:${t.windowId ?? 'any'}`;
  return normalizeUrl(url);
}

function isUrlWhitelisted(url, whitelistSet) {
  if (!whitelistSet || !whitelistSet.size) return false;
  const key = normalizeUrl(url);
  if (whitelistSet.has(key)) return true;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const hostPort = u.host.replace(/^www\./, '').toLowerCase();
    if (whitelistSet.has(host) || whitelistSet.has(hostPort) || whitelistSet.has(u.hostname.toLowerCase())) return true;
  } catch { /* ignore */ }
  return false;
}

async function findDuplicates(windowId = null) {
  const settings = await getSettings();
  const whitelist = new Set((settings.dedupWhitelist || []).map(s => String(s || '').trim()));
  const [tabs, locked] = await Promise.all([
    chrome.tabs.query(windowId ? { windowId } : {}),
    readLockedGroupIds(),
  ]);
  const byUrl = new Map();
  for (const t of tabs) {
    if (!isDedupable(t)) continue;
    const url = t.url || t.pendingUrl || '';
    if (!isNewTabPageUrl(url) && isUrlWhitelisted(url, whitelist)) continue;
    const key = dedupKeyForTab(t);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(t);
  }
  const sets = [...byUrl.values()].filter(g => g.length > 1);
  const toClose = [];
  for (const set of sets) {
    const keeper = set.find(t => t.groupId !== -1 && locked.has(t.groupId))
      || set.find(t => t.active)
      || set.slice().sort((a, b) => a.index - b.index)[0];
    for (const t of set) {
      if (t.id === keeper.id) continue;
      if (t.groupId !== -1 && locked.has(t.groupId)) continue;
      toClose.push(t);
    }
  }
  return { sets, toClose };
}

async function dedup({ windowId = null } = {}) {
  const { toClose } = await findDuplicates(windowId);
  if (!toClose.length) return { ok: true, closed: 0 };
  await chrome.storage.session.set({
    dedupUndo: { at: Date.now(), tabs: toClose.map(t => ({ url: t.url, index: t.index, windowId: t.windowId })) },
  });
  await chrome.tabs.remove(toClose.map(t => t.id));
  return { ok: true, closed: toClose.length };
}

const newlyCreatedTabIds = new Map(); // tabId -> createdAt
const forceOpenTabIds = new Set();

async function dedupUndo() {
  const { dedupUndo } = await chrome.storage.session.get('dedupUndo');
  if (!dedupUndo?.tabs?.length) return { ok: false, message: '没有可恢复的标签' };
  let restored = 0;
  for (const t of dedupUndo.tabs) {
    try {
      const created = await chrome.tabs.create({ url: t.url, index: t.index, windowId: t.windowId, active: false });
      if (created?.id != null) forceOpenTabIds.add(created.id);
      restored++;
    } catch {
      try {
        const created = await chrome.tabs.create({ url: t.url, active: false });
        if (created?.id != null) forceOpenTabIds.add(created.id);
        restored++;
      } catch { /* 窗口可能已关闭 */ }
    }
  }
  await chrome.storage.session.remove('dedupUndo');
  return { ok: true, restored };
}

async function maybeInterceptDuplicateTab(tab) {
  if (!tab || tab.id == null || tab.pinned) return false;
  if (typeof chrome.tabs?.remove !== 'function' || typeof chrome.tabs?.update !== 'function') return false;
  if (forceOpenTabIds.has(tab.id)) return false;
  const createdAt = newlyCreatedTabIds.get(tab.id);
  if (!createdAt || Date.now() - createdAt > 15000) {
    if (createdAt) newlyCreatedTabIds.delete(tab.id);
    return false;
  }
  const rawUrl = tab.pendingUrl || tab.url || '';
  if (isNewTabPageUrl(rawUrl)) {
    const settings = await getSettings();
    if (settings.interceptDuplicates === false) return false;
    if (tab.windowId == null) return false;
    const [winTabs, locked] = await Promise.all([
      chrome.tabs.query({ windowId: tab.windowId }),
      readLockedGroupIds(),
    ]);
    const others = winTabs.filter(t =>
      t.id !== tab.id &&
      !t.pinned &&
      isNewTabPageUrl(t.pendingUrl || t.url || '') &&
      !(t.groupId !== -1 && locked.has(t.groupId)),
    );
    if (!others.length) return false;
    newlyCreatedTabIds.delete(tab.id);
    if (tab.active) {
      const removeIds = others.map(t => t.id).filter(id => Number.isInteger(id));
      if (removeIds.length) {
        try { await chrome.tabs.remove(removeIds); } catch { /* ignore */ }
      }
    } else {
      try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
    }
    return true;
  }
  if (!/^https?:\/\//.test(rawUrl)) return false;

  const settings = await getSettings();
  if (settings.interceptDuplicates === false) return false;
  const whitelist = new Set((settings.dedupWhitelist || []).map(s => String(s || '').trim()));
  if (isUrlWhitelisted(rawUrl, whitelist)) return false;

  const targetKey = normalizeUrl(rawUrl);
  const queryOpts = settings.interceptScope === 'window' && tab.windowId != null ? { windowId: tab.windowId } : {};
  const allTabs = await chrome.tabs.query(queryOpts);
  const existing = allTabs.find(t => t.id !== tab.id && isDedupable(t) && normalizeUrl(t.url || '') === targetKey);
  if (!existing) return false;

  newlyCreatedTabIds.delete(tab.id);
  let host = '';
  try { host = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const record = {
    url: rawUrl,
    host,
    existingTabId: existing.id,
    existingTitle: existing.title || rawUrl,
    windowId: existing.windowId,
    at: Date.now(),
  };
  await chrome.storage.session?.set?.({ lastInterceptedDup: record });
  try { await chrome.tabs.update(existing.id, { active: true }); } catch { /* ignore */ }
  if (existing.windowId != null && chrome.windows?.update) {
    try { await chrome.windows.update(existing.windowId, { focused: true }); } catch { /* ignore */ }
  }
  try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ }
  try {
    chrome.tabs.sendMessage?.(existing.id, {
      type: 'show-dup-intercept-toast',
      url: rawUrl,
      host,
      windowId: existing.windowId,
    })?.catch?.(() => {});
  } catch { /* ignore */ }
  return true;
}

/* ---------------- 浏览器级标签搜索（原生 popup，不向网页注入） ---------------- */

let browserSearchQueue = Promise.resolve();
let browserSearchOpening = null;

// Open/close/state/onRemoved share one queue; simultaneous opens additionally
// share the same promise so a repeated command during creation cannot toggle it.
function withBrowserSearchLock(task) {
  const result = browserSearchQueue.then(task);
  browserSearchQueue = result.catch(() => {});
  return result;
}

function isBrowserSearchUrl(url) {
  return typeof url === 'string' && url.split(/[?#]/, 1)[0] === chrome.runtime.getURL?.('search.html');
}

function isExtensionSender(sender) {
  return sender?.id === chrome.runtime.id
    && String(sender.url || sender.tab?.url || '').startsWith(chrome.runtime.getURL(''));
}

function requireSearchSender(sender) {
  if (!isExtensionSender(sender) || !sender.tab || !isBrowserSearchUrl(sender.tab.url)
      || (sender.url && !isBrowserSearchUrl(sender.url)) || (sender.frameId != null && sender.frameId !== 0)) {
    throw new Error('仅允许浏览器搜索页面执行此操作');
  }
}

async function getBrowserSearchWindow(windowId) {
  if (!Number.isInteger(windowId)) return null;
  try { return await chrome.windows.get(windowId); } catch { return null; }
}

async function browserSearchSource(sourceTab, searchWindowId = null) {
  let win = null, tab = null;
  if (Number.isInteger(sourceTab?.id)) {
    try {
      const live = await chrome.tabs.get(sourceTab.id);
      const candidate = await getBrowserSearchWindow(live.windowId);
      if (candidate?.type === 'normal' && candidate.id !== searchWindowId) {
        win = candidate;
        tab = live;
      }
    } catch { /* 来源标签可能恰好已关闭 */ }
  }
  if (!win) {
    try {
      const candidate = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (candidate?.type === 'normal' && candidate.id !== searchWindowId) win = candidate;
    } catch { /* 没有普通浏览器窗口 */ }
    if (win) {
      try { [tab] = await chrome.tabs.query({ windowId: win.id, active: true }); }
      catch { win = null; } // 来源窗口可能在查询前关闭
    }
  }
  return { window: win, sourceWindowId: win?.id ?? null, sourceTabId: tab?.id ?? null };
}

async function findBrowserSearch() {
  const { browserSearch: saved } = await chrome.storage.session.get('browserSearch');
  // Querying the real page also recovers an orphaned popup after SW termination
  // between windows.create() and session.set(). Never adopt a normal browser tab.
  const tabs = (await chrome.tabs.query({})).filter(tab => isBrowserSearchUrl(tab.url) || isBrowserSearchUrl(tab.pendingUrl));
  tabs.sort((a, b) => Number(b.windowId === saved?.windowId) - Number(a.windowId === saved?.windowId));
  for (const tab of tabs) {
    const win = await getBrowserSearchWindow(tab.windowId);
    if (win?.type !== 'popup') continue;
    let state = saved?.windowId === win.id ? saved : null;
    if (!state) {
      const source = await browserSearchSource(null, win.id);
      state = { windowId: win.id, sourceWindowId: source.sourceWindowId, sourceTabId: source.sourceTabId };
      await chrome.storage.session.set({ browserSearch: state });
    }
    return { state, window: win, tab };
  }
  if (saved) await chrome.storage.session.remove('browserSearch');
  return null;
}

async function liveBrowserSearchSource(state) {
  const win = await getBrowserSearchWindow(state.sourceWindowId);
  if (win?.type !== 'normal') return { window: null, tab: null };
  let tab = null;
  if (Number.isInteger(state.sourceTabId)) {
    try {
      const live = await chrome.tabs.get(state.sourceTabId);
      if (live.windowId === win.id) tab = live;
    } catch { /* 来源标签已经关闭；仍可恢复来源窗口 */ }
  }
  return { window: win, tab };
}

async function restoreBrowserSearchSource(state, nativeClose = false) {
  const source = await liveBrowserSearchSource(state);
  if (!source.window) return;
  if (nativeClose) {
    // The native close button has no explicit restore intent. Only restore the
    // source tab if Chrome already returned focus there; never steal another
    // window/application's newly chosen focus.
    let focused;
    try { focused = await chrome.windows.getLastFocused(); } catch { return; }
    if (!focused?.focused || focused.id !== source.window.id) return;
  }
  if (source.tab) {
    try { await chrome.tabs.update(source.tab.id, { active: true }); } catch { /* 标签可能在验证后关闭 */ }
  }
  if (!nativeClose) {
    try { await chrome.windows.update(source.window.id, { focused: true }); } catch { /* 窗口可能在验证后关闭 */ }
  }
}

async function closeBrowserSearchWindow(record, restoreFocus) {
  try { await chrome.windows.remove(record.state.windowId); }
  catch (error) {
    if (await getBrowserSearchWindow(record.state.windowId)) throw error;
  }
  // onRemoved is queued behind this operation: clearing before it runs prevents
  // a second restore, especially the forbidden restore after result navigation.
  await chrome.storage.session.remove('browserSearch');
  if (restoreFocus) await restoreBrowserSearchSource(record.state);
  return { ok: true, closed: true };
}

function browserSearchBounds(source) {
  const width = Math.min(680, Math.max(50, source?.width || 680));
  const height = Math.min(560, Math.max(50, source?.height || 560));
  const bounds = { width, height };
  if (Number.isFinite(source?.left) && Number.isFinite(source?.width)) {
    bounds.left = Math.round(source.left + (source.width - width) / 2);
  }
  if (Number.isFinite(source?.top) && Number.isFinite(source?.height)) {
    bounds.top = Math.round(source.top + (source.height - height) / 2);
  }
  return bounds;
}

function openBrowserSearch(sourceTab = null, { toggle = false } = {}) {
  if (browserSearchOpening) return browserSearchOpening;
  const operation = withBrowserSearchLock(async () => {
    const record = await findBrowserSearch();
    if (record && toggle && record.window.focused) return await closeBrowserSearchWindow(record, true);
    if (record) {
      if (!record.window.focused) {
        const source = await browserSearchSource(sourceTab, record.state.windowId);
        if (source.window) {
          record.state = { windowId: record.state.windowId, sourceWindowId: source.sourceWindowId, sourceTabId: source.sourceTabId };
          await chrome.storage.session.set({ browserSearch: record.state });
        }
      }
      await chrome.windows.update(record.state.windowId, {
        focused: true, ...(record.window.state === 'minimized' ? { state: 'normal' } : {}),
      });
      // Extension pages listen on runtime.onMessage (tabs.sendMessage is for
      // content scripts). No listener yet during loading is harmless.
      try {
        chrome.runtime.sendMessage({ type: 'browser-search-focus', windowId: record.state.windowId, reset: true })?.catch(() => {});
      } catch { /* 新建/加载中的页面自行初始化输入焦点 */ }
      return { ok: true, reused: true, windowId: record.state.windowId, sourceWindowId: record.state.sourceWindowId, currentTabId: record.state.sourceTabId };
    }
    const source = await browserSearchSource(sourceTab);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('search.html'), type: 'popup', focused: true,
      ...browserSearchBounds(source.window),
    });
    const state = { windowId: win.id, sourceWindowId: source.sourceWindowId, sourceTabId: source.sourceTabId };
    await chrome.storage.session.set({ browserSearch: state });
    return { ok: true, reused: false, windowId: win.id, sourceWindowId: state.sourceWindowId, currentTabId: state.sourceTabId };
  });
  browserSearchOpening = operation;
  operation.then(() => { browserSearchOpening = null; }, () => { browserSearchOpening = null; });
  return operation;
}

async function authorizedBrowserSearch(sender) {
  requireSearchSender(sender);
  const record = await findBrowserSearch();
  if (!record || sender.tab.windowId !== record.state.windowId) throw new Error('搜索窗口不匹配或已经关闭');
  const live = await chrome.tabs.get(sender.tab.id);
  if (live.windowId !== record.state.windowId || !isBrowserSearchUrl(live.url)) throw new Error('搜索页面已经关闭或改变');
  return record;
}

async function browserSearchShortcut() {
  let commands = [];
  try { commands = await chrome.commands?.getAll?.() || []; } catch { /* API 不可用时不虚报快捷键 */ }
  return { ok: true, shortcut: commands.find(command => command.name === 'search-tabs')?.shortcut || '' };
}

/* ---------------- 当前页搜索：隔离 iframe + 每标签、可恢复的授权记录 ---------------- */
const PAGE_SEARCH_KEY = 'pageSearchRecords';
const SIDE_SEARCH_KEY = 'pendingSideSearch';
let pageSearchQueue = Promise.resolve();
const pageSearchOpening = new Map();
function withPageSearchLock(task) {
  const result = pageSearchQueue.then(task);
  pageSearchQueue = result.catch(() => {});
  return result;
}
function ownedTopPage(sender) {
  return isExtensionSender(sender) && (sender.frameId == null || sender.frameId === 0)
    && !new URL(sender.url || sender.tab.url).searchParams.has('embedded');
}
function localSearchPage(url) {
  if ([chrome.runtime.getURL('home.html'), chrome.runtime.getURL('sidepanel.html')].includes(String(url).split(/[?#]/, 1)[0])) return true;
  // A new-tab override may render home.html while Tab.url stays a browser alias.
  // These are claim candidates only, never permission to inject an internal page.
  try {
    const u = new URL(url);
    return ['chrome:', 'brave:', 'edge:', 'vivaldi:', 'opera:'].includes(u.protocol)
      && ['newtab', 'new-tab-page'].includes(u.hostname) && ['', '/'].includes(u.pathname);
  } catch { return false; }
}
function injectableSearchPage(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol)
      && u.hostname !== 'chromewebstore.google.com'
      && !(u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  } catch { return false; }
}
async function pageSearchRecords() {
  return (await chrome.storage.session.get(PAGE_SEARCH_KEY))[PAGE_SEARCH_KEY] || {};
}
async function savePageSearchRecords(records) { await chrome.storage.session.set({ [PAGE_SEARCH_KEY]: records }); }
// Serialized in the isolated world; no page-world globals or postMessage bridge.
function pageSearchBridgeAction(action, options) {
  return globalThis.__aiPageSearchBridge?.(action, options) || { ok: false, missing: true };
}
async function callPageBridge(record, action, extra = {}) {
  const target = { tabId: record.sourceTabId,
    ...(record.topDocumentId ? { documentIds: [record.topDocumentId] } : { frameIds: [0] }) };
  const results = await chrome.scripting.executeScript({ target, world: 'ISOLATED', func: pageSearchBridgeAction,
    args: [action, { nonce: record.nonce, targetTabId: record.sourceTabId, ...extra }] });
  return results?.[0]?.result;
}
function pageSearchNotify(message) {
  try { chrome.runtime.sendMessage(message)?.catch?.(() => {}); } catch { /* UI not mounted yet. */ }
}
async function claimLocalPageSearch(tab) {
  const request = { type: 'page-search-local', windowId: tab.windowId, targetTabId: tab.id, requestId: crypto.randomUUID() };
  let timer;
  try {
    // Only this notification waits for a UI response. Sidepanel/focus broadcasts
    // stay fire-and-forget: their UI may call worker RPCs queued behind this lock.
    const reply = await Promise.race([
      chrome.runtime.sendMessage(request),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 600); }),
    ]);
    return reply?.ok === true && reply.claimed === true && reply.windowId === request.windowId
      && reply.targetTabId === request.targetTabId && reply.requestId === request.requestId;
  } catch { return false; /* Missing, unloading or failed client is not an inline open. */ }
  finally { clearTimeout(timer); }
}
async function clearPendingSideSearch(windowId) {
  // Search mutations share withPageSearchLock, including pending-state ACKs, so
  // queued native Sidebar reads cannot resurrect the previous local request.
  const pending = (await chrome.storage.session.get(SIDE_SEARCH_KEY))[SIDE_SEARCH_KEY] || {};
  if (!pending[windowId]) return;
  delete pending[windowId];
  await chrome.storage.session.set({ [SIDE_SEARCH_KEY]: pending });
}
async function removePageSearch(records, record, restoreFocus = false) {
  // Revoke first, even if navigation has already destroyed the isolated world.
  delete records[record.sourceTabId];
  await savePageSearchRecords(records);
  try { await callPageBridge(record, 'close', { restoreFocus }); } catch { /* Navigated/closed. */ }
  return { ok: true, closed: true };
}
function beginSideSearchOpen(windowId) {
  // Called directly in onCommand BEFORE any await: Chrome requires that gesture.
  try {
    if (!chrome.sidePanel?.open) throw new Error('浏览器没有提供侧边栏搜索入口');
    return Promise.resolve(chrome.sidePanel.open({ windowId })).then(() => ({ ok: true }), error => ({ ok: false, error }));
  } catch (error) { return Promise.resolve({ ok: false, error }); }
}
async function restrictedSearchNotice(windowId) {
  await chrome.action?.setBadgeText?.({ text: '!' });
  await chrome.action?.setBadgeBackgroundColor?.({ color: '#B65B32' });
  await chrome.action?.setTitle?.({ title: '此页无法显示搜索，请点击扩展图标打开侧边栏后重试' });
}
async function openSideSearch(source, started = null) {
  if (!source.window || !Number.isInteger(source.sourceTabId)) {
    await restrictedSearchNotice(source.sourceWindowId);
    return { ok: false, restricted: true, message: '没有可用的现有浏览器窗口；不会另开搜索窗口。' };
  }
  const opened = started || beginSideSearchOpen(source.sourceWindowId);
  const pending = (await chrome.storage.session.get(SIDE_SEARCH_KEY))[SIDE_SEARCH_KEY] || {};
  pending[source.sourceWindowId] = { id: crypto.randomUUID(), windowId: source.sourceWindowId,
    sourceWindowId: source.sourceWindowId, currentTabId: source.sourceTabId, query: '', provider: 'all', at: Date.now() };
  await chrome.storage.session.set({ [SIDE_SEARCH_KEY]: pending });
  pageSearchNotify({ type: 'page-search-sidepanel', windowId: source.sourceWindowId });
  const result = await opened;
  if (!result.ok) {
    await restrictedSearchNotice(source.sourceWindowId);
    return { ok: false, restricted: true, message: '此页禁止覆盖，侧边栏未能自动打开；请点击扩展图标后搜索。' };
  }
  return { ok: true, sidepanel: true, sourceWindowId: source.sourceWindowId, currentTabId: source.sourceTabId };
}
async function sideSearchState(sender, msg) {
  if (!ownedTopPage(sender) || String(sender.url).split(/[?#]/, 1)[0] !== chrome.runtime.getURL('sidepanel.html')) {
    throw new Error('仅允许侧边栏读取待打开的搜索');
  }
  if (!Number.isInteger(msg.windowId) || (sender.tab && sender.tab.windowId !== msg.windowId)) throw new Error('侧边栏窗口不匹配');
  const win = await getBrowserSearchWindow(msg.windowId);
  if (win?.type !== 'normal') throw new Error('侧边栏窗口已经关闭或无效');
  const records = (await chrome.storage.session.get(SIDE_SEARCH_KEY))[SIDE_SEARCH_KEY] || {};
  const pending = records[msg.windowId] || null;
  if (pending && (pending.windowId !== msg.windowId || pending.sourceWindowId !== msg.windowId)) throw new Error('搜索来源窗口不匹配');
  if (msg.ack === true && pending) {
    if (msg.pendingId != null && msg.pendingId !== pending.id) throw new Error('待打开搜索已经更新');
    delete records[msg.windowId];
    await chrome.storage.session.set({ [SIDE_SEARCH_KEY]: records });
  }
  return { ok: true, pending };
}
function openPageSearch(sourceTab = null, { toggle = false, sideOpenAttempt = null } = {}) {
  const key = sourceTab?.id ?? 'focused';
  if (pageSearchOpening.has(key)) return pageSearchOpening.get(key);
  const operation = withPageSearchLock(async () => {
    const source = await browserSearchSource(sourceTab);
    if (!source.window || !Number.isInteger(source.sourceTabId)) return await openSideSearch(source, sideOpenAttempt);
    const tab = await chrome.tabs.get(source.sourceTabId);
    // A global invocation may focus an existing window, never create one.
    if (!source.window.focused) await chrome.windows.update(source.window.id, {
      focused: true, ...(source.window.state === 'minimized' ? { state: 'normal' } : {}),
    });
    if ((localSearchPage(tab.url) || localSearchPage(tab.pendingUrl)) && await claimLocalPageSearch(tab)) {
      await clearPendingSideSearch(tab.windowId);
      return { ok: true, inline: true, sourceWindowId: tab.windowId, currentTabId: tab.id };
    }
    if (!injectableSearchPage(tab.url) || (tab.pendingUrl && !injectableSearchPage(tab.pendingUrl))) return await openSideSearch(source, sideOpenAttempt);
    const records = await pageSearchRecords();
    let record = records[tab.id];
    if (record && (record.url !== tab.url || record.windowId !== tab.windowId)) { await removePageSearch(records, record); record = null; }
    if (record) {
      if (toggle) {
        const result = await removePageSearch(records, record, true);
        await clearPendingSideSearch(tab.windowId);
        return result;
      }
      let focused;
      try { focused = await callPageBridge(record, 'focus'); } catch { /* Lost document. */ }
      if (focused?.ok) {
        await clearPendingSideSearch(tab.windowId);
        pageSearchNotify({ type: 'page-search-focus', nonce: record.nonce, targetTabId: tab.id });
        return { ok: true, reused: true, embedded: true, sourceWindowId: tab.windowId, currentTabId: tab.id };
      }
      await removePageSearch(records, record);
    }
    try {
      const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['page-overlay.js'] });
      const topDocumentId = injected?.find(row => row.frameId === 0)?.documentId || injected?.[0]?.documentId;
      if (typeof topDocumentId !== 'string' || !topDocumentId) throw new Error('浏览器未提供页面文档绑定');
      record = { nonce: crypto.randomUUID(), windowId: tab.windowId, sourceTabId: tab.id, url: tab.url,
        topDocumentId, frameId: null, documentId: null, createdAt: Date.now() };
      records[tab.id] = record;
      await savePageSearchRecords(records); // iframe may handshake as soon as it is appended.
      if (!(await callPageBridge(record, 'open'))?.ok) throw new Error('页面浮层注入失败');
      await clearPendingSideSearch(tab.windowId);
      return { ok: true, embedded: true, sourceWindowId: tab.windowId, currentTabId: tab.id };
    } catch (error) {
      if (record) await removePageSearch(records, record);
      console.warn('原位搜索不可用，使用受限侧栏:', error);
      return await openSideSearch(source, sideOpenAttempt);
    }
  });
  pageSearchOpening.set(key, operation);
  const done = () => { if (pageSearchOpening.get(key) === operation) pageSearchOpening.delete(key); };
  operation.then(done, done);
  return operation;
}
async function authorizedPageSearch(sender, msg, bind = false) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id)
      || !Number.isInteger(sender.frameId) || sender.frameId <= 0 || typeof sender.documentId !== 'string' || !sender.documentId
      || (sender.documentLifecycle && sender.documentLifecycle !== 'active')) throw new Error('页面搜索帧未授权');
  const records = await pageSearchRecords();
  const record = records[sender.tab.id];
  if (!record || typeof msg.nonce !== 'string' || msg.nonce !== record.nonce
      || sender.url !== chrome.runtime.getURL('search.html') + '?embedded=' + encodeURIComponent(record.nonce)
      || sender.tab.windowId !== record.windowId || sender.tab.id !== record.sourceTabId) throw new Error('页面搜索来源或令牌不匹配');
  const tab = await chrome.tabs.get(record.sourceTabId);
  if (tab.windowId !== record.windowId || tab.url !== record.url || (tab.pendingUrl && tab.pendingUrl !== record.url)) throw new Error('搜索来源页面已经改变');
  if (record.frameId === null && record.documentId === null && bind) {
    record.frameId = sender.frameId; record.documentId = sender.documentId;
    await savePageSearchRecords(records);
    try {
      if (!(await callPageBridge(record, 'authorized'))?.ok) throw new Error('missing overlay');
    } catch { await removePageSearch(records, record); throw new Error('搜索浮层已经失效'); }
  }
  if (record.frameId !== sender.frameId || record.documentId !== sender.documentId) throw new Error('搜索帧尚未握手或文档绑定不匹配');
  return { records, record };
}
async function pageBridgeNotification(sender, msg) {
  const records = await pageSearchRecords();
  const record = records[sender.tab?.id];
  if (!record || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.documentId !== record.topDocumentId
      || sender.tab.windowId !== record.windowId || sender.url !== record.url || msg.nonce !== record.nonce) throw new Error('浮层桥接来源无效');
  if (msg.type === 'page-search-overlay-loaded') {
    pageSearchNotify({ type: 'page-search-focus', nonce: record.nonce, targetTabId: record.sourceTabId });
    return { ok: true };
  }
  await removePageSearch(records, record, msg.type === 'page-search-overlay-dismiss');
  if (msg.type === 'page-search-overlay-failed') {
    const source = await browserSearchSource(await chrome.tabs.get(record.sourceTabId));
    return await openSideSearch(source);
  }
  return { ok: true };
}
chrome.tabs.onUpdated?.addListener((id, info) => {
  if (!info.url && info.status !== 'loading') return;
  return withPageSearchLock(async () => {
    const records = await pageSearchRecords();
    if (records[id]) await removePageSearch(records, records[id], false);
  }).catch(error => console.warn('清理页面搜索失败:', error));
});
chrome.tabs.onRemoved?.addListener(id => withPageSearchLock(async () => {
  const records = await pageSearchRecords();
  if (records[id]) { delete records[id]; await savePageSearchRecords(records); }
}).catch(error => console.warn('清理页面搜索记录失败:', error)));
chrome.tabs.onAttached?.addListener(id => withPageSearchLock(async () => {
  // Moving to another window invalidates the iframe's frozen source context.
  // Close it instead of granting a moved frame fresh private-search authority.
  const records = await pageSearchRecords();
  if (records[id]) await removePageSearch(records, records[id], false);
  // The old window can close first, or its cleanup script can fail while the
  // tab is detached. This trusted Chrome event may reset an orphan even after
  // its nonce record was lost. Never expose reset as a runtime/page RPC.
  try {
    await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, world: 'ISOLATED',
      func: pageSearchBridgeAction, args: ['reset'] });
  } catch { /* Restricted/closed tab, or no surviving isolated world. */ }
}).catch(error => console.warn('清理跨窗口页面搜索失败:', error)));
chrome.windows.onRemoved?.addListener(id => withPageSearchLock(async () => {
  const records = await pageSearchRecords();
  for (const record of Object.values(records)) if (record.windowId === id) await removePageSearch(records, record, false);
  const pending = (await chrome.storage.session.get(SIDE_SEARCH_KEY))[SIDE_SEARCH_KEY] || {};
  delete pending[id];
  await chrome.storage.session.set({ [SIDE_SEARCH_KEY]: pending });
}).catch(error => console.warn('清理窗口搜索记录失败:', error)));

function handlePageSearchCommand(command, tab) {
  if (command !== 'search-tabs') return;
  const ownPage = typeof tab?.url === 'string' && tab.url.startsWith(chrome.runtime.getURL(''));
  const localCandidate = localSearchPage(tab?.url) || localSearchPage(tab?.pendingUrl);
  const restricted = Number.isInteger(tab?.windowId) && !ownPage && !localCandidate
    && (!injectableSearchPage(tab?.url) || (tab.pendingUrl && !injectableSearchPage(tab.pendingUrl)));
  // Do not move this call behind the async source lookup/storage read.
  const sideOpenAttempt = restricted ? beginSideSearchOpen(tab.windowId) : null;
  return openPageSearch(tab, { toggle: true, sideOpenAttempt }).catch(error => console.warn('打开当前页搜索失败:', error));
}
chrome.commands?.onCommand?.addListener(handlePageSearchCommand);

chrome.windows.onRemoved?.addListener(windowId => withBrowserSearchLock(async () => {
  const { browserSearch } = await chrome.storage.session.get('browserSearch');
  if (browserSearch?.windowId !== windowId) return;
  await chrome.storage.session.remove('browserSearch');
  await restoreBrowserSearchSource(browserSearch, true);
}).catch(error => console.warn('清理浏览器标签搜索失败:', error)));

/* ---------------- 消息路由（popup / sidepanel / home / search） ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // WAR is a loading capability, never authorization. Unregistered extension
    // subframes cannot use legacy/general brokers to read tabs, settings or docs.
    const embeddedCaller = isExtensionSender(sender) && ((sender.frameId != null && sender.frameId !== 0)
      || new URL(sender.url || sender.tab.url).searchParams.has('embedded'));
    const embeddedTypes = ['page-search-state', 'page-search-close'];
    if (embeddedCaller && !embeddedTypes.includes(msg?.type)) throw new Error('嵌入搜索帧不允许执行此操作');
    switch (msg?.type) {
      case 'cleanup-advice':
        requireLifecycleSender(sender);
        return await cleanupAdvice(msg.windowId ?? null);
      case 'check-home-auto-organize':
        requireLifecycleSender(sender);
        return await checkHomeAutoOrganize(msg.windowId ?? null);
      case 'cleanup-close':
        requireLifecycleSender(sender);
        return await cleanupClose({ windowId: msg.windowId ?? null, tabIds: msg.tabIds ?? null });
      case 'discard-tabs':
        requireLifecycleSender(sender);
        return await discardIdleTabs({
          windowId: msg.windowId ?? null,
          minIdleMinutes: msg.minIdleMinutes ?? 0,
          tabIds: msg.tabIds ?? null,
        });
      case 'active-work-tab':
        requireLifecycleSender(sender);
        return await activeWorkTab(msg.windowId ?? null);
      case 'group-archive-close':
        requireLifecycleSender(sender);
        return await closeGroupArchive(msg);
      case 'group-archive-list':
        requireLifecycleSender(sender);
        return await listGroupArchives();
      case 'group-archive-restore':
        requireLifecycleSender(sender);
        return await restoreGroupArchive(msg);
      case 'group-archive-delete':
        requireLifecycleSender(sender);
        return await deleteGroupArchive(msg.id);
      case 'group-lock-set':
        requireLifecycleSender(sender);
        return await setGroupLock(msg);
      case 'group-rename':
        requireLifecycleSender(sender);
        return await renameTabGroup(msg);
      case 'group-force-close':
        requireLifecycleSender(sender);
        return await disbandAndCloseGroup(msg);
      case 'page-search-open': {
        if (!ownedTopPage(sender)) throw new Error('仅允许扩展自有页面打开搜索');
        const [active] = sender.tab ? await chrome.tabs.query({ windowId: sender.tab.windowId, active: true }) : [];
        return await openPageSearch(active || sender.tab || null);
      }
      case 'page-search-state':
        return await withPageSearchLock(async () => {
          const { record } = await authorizedPageSearch(sender, msg, true);
          return { ok: true, sourceWindowId: record.windowId, currentTabId: record.sourceTabId, embedded: true };
        });
      case 'page-search-close':
        return await withPageSearchLock(async () => {
          if (typeof msg.restoreFocus !== 'boolean') throw new Error('restoreFocus 必须为布尔值');
          const { records, record } = await authorizedPageSearch(sender, msg);
          return await removePageSearch(records, record, msg.restoreFocus);
        });
      case 'page-search-sidepanel-state':
        return await withPageSearchLock(() => sideSearchState(sender, msg));
      case 'page-search-overlay-loaded':
      case 'page-search-overlay-failed':
      case 'page-search-overlay-gone':
      case 'page-search-overlay-dismiss':
        return await withPageSearchLock(() => pageBridgeNotification(sender, msg));
      case 'browser-search-open': {
        if (!isExtensionSender(sender)) throw new Error('仅允许扩展页面打开浏览器搜索');
        // UI calls keep their browser-window context even when another window
        // gains focus before the worker receives the request.
        const [active] = sender.tab
          ? await chrome.tabs.query({ windowId: sender.tab.windowId, active: true }) : [];
        return await openBrowserSearch(active || sender.tab || null);
      }
      case 'browser-search-close':
        requireSearchSender(sender);
        return await withBrowserSearchLock(async () => {
          const record = await authorizedBrowserSearch(sender);
          if (typeof msg.restoreFocus !== 'boolean') throw new Error('restoreFocus 必须为布尔值');
          return await closeBrowserSearchWindow(record, msg.restoreFocus);
        });
      case 'browser-search-state':
        requireSearchSender(sender);
        return await withBrowserSearchLock(async () => {
          const record = await authorizedBrowserSearch(sender);
          const source = await liveBrowserSearchSource(record.state);
          return { ok: true, sourceWindowId: source.window?.id ?? null, currentTabId: source.tab?.id ?? null };
        });
      case 'browser-search-shortcut':
        if (!isExtensionSender(sender)) throw new Error('仅允许扩展页面读取搜索快捷键');
        return await browserSearchShortcut();
      case 'analysis-page-changed': {
        if (sender?.id !== chrome.runtime.id || !sender.tab || sender.frameId > 0
            || sender.tab.url !== msg.url || !/^https?:\/\//.test(msg.url || '')) {
          throw new Error('页面分析通知来源无效');
        }
        const tab = await chrome.tabs.get(sender.tab.id);
        if (tab.url === msg.url) await queueAutoTab(tab, { contentSignal: String(msg.snippet || '') });
        return { ok: true };
      }
      case 'organize':
        return await organize({ apply: !!msg.apply, incremental: !!msg.incremental, windowId: msg.windowId ?? null });
      case 'apply': {
        const { proposal } = await chrome.storage.session.get('proposal');
        if (!proposal) return { ok: false, message: '没有待应用的分组方案' };
        return await applyOrganizeProposal(proposal);
      }
      case 'undo':
        return await undo();
      case 'drag-tab-move':
        return await dragTabMove(msg);
      case 'drag-group-reorder':
        return await dragGroupReorder(msg);
      case 'last-context': {
        const { lastContext } = await chrome.storage.session.get('lastContext');
        return { ok: true, context: lastContext || null };
      }
      case 'dedup':
        return await dedup({ windowId: msg.windowId ?? null });
      case 'dedup-undo':
        return await dedupUndo();
      case 'dup-count': {
        const { sets, toClose } = await findDuplicates(msg.windowId ?? null);
        const settings = await getSettings();
        return {
          ok: true,
          count: toClose.length,
          sets: sets.map(s => ({ url: s[0].url, title: s[0].title, count: s.length })),
          whitelist: settings.dedupWhitelist || [],
        };
      }
      case 'dedup-state': {
        const { dedupUndo } = await chrome.storage.session.get('dedupUndo');
        return { ok: true, undoCount: dedupUndo?.tabs?.length || 0 };
      }
      case 'history-list':
        return { ok: true, runs: await listHistory() };
      case 'history-rollback':
        return await rollbackHistory(msg.id);
      case 'space-save':
        return await saveSpace(msg.name, msg.windowId ?? null);
      case 'space-list':
        return { ok: true, spaces: await listSpaces() };
      case 'space-restore':
        return await restoreSpace(msg.id);
      case 'space-delete':
        return await deleteSpace(msg.id);
      case 'dup-whitelist-add': {
        const settings = await getSettings();
        const raw = String(msg.url || msg.host || '').trim();
        const key = /^https?:\/\//i.test(raw) ? normalizeUrl(raw) : raw.replace(/^www\./i, '').toLowerCase();
        if (!key) return { ok: false, message: '域名或网址不能为空' };
        const wl = [...new Set([...(settings.dedupWhitelist || []), key])];
        await chrome.storage.sync.set({ settings: { ...settings, dedupWhitelist: wl } });
        return { ok: true, whitelist: wl };
      }
      case 'dup-whitelist-remove': {
        const settings = await getSettings();
        const raw = String(msg.url || msg.host || '').trim();
        const key = /^https?:\/\//i.test(raw) ? normalizeUrl(raw) : raw.replace(/^www\./i, '').toLowerCase();
        const wl = (settings.dedupWhitelist || []).filter(u => u !== key && u !== raw);
        await chrome.storage.sync.set({ settings: { ...settings, dedupWhitelist: wl } });
        return { ok: true, whitelist: wl };
      }
      case 'page-search-pill-trigger': {
        if (sender?.id !== chrome.runtime.id || !sender.tab) throw new Error('悬浮搜索胶囊来源无效');
        if (!sender.tab.active) {
          try { await chrome.tabs.update(sender.tab.id, { active: true }); } catch { /* ignore */ }
        }
        return await openPageSearch(sender.tab, { toggle: false });
      }
      case 'page-search-pill-hide-host': {
        if (sender?.id !== chrome.runtime.id) throw new Error('来源无效');
        const host = String(msg.host || '').replace(/^www\./i, '').toLowerCase().trim();
        if (!host) return { ok: false };
        const settings = await getSettings();
        const pillHiddenHosts = [...new Set([...(settings.pillHiddenHosts || []), host])];
        await chrome.storage.sync.set({ settings: { ...settings, pillHiddenHosts } });
        return { ok: true, pillHiddenHosts };
      }
      case 'force-open-duplicate': {
        const url = String(msg.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, message: '无效网址' };
        const windowId = Number.isInteger(msg.windowId) ? msg.windowId : await currentWindowId();
        const created = await chrome.tabs.create({ url, windowId, active: true });
        if (created?.id != null) forceOpenTabIds.add(created.id);
        await chrome.storage.session?.remove?.('lastInterceptedDup');
        return { ok: true, tabId: created?.id ?? null };
      }
      case 'last-intercepted-dup': {
        const { lastInterceptedDup } = (await chrome.storage.session?.get?.('lastInterceptedDup')) || {};
        return { ok: true, intercepted: lastInterceptedDup || null };
      }
      case 'clear-intercepted-dup': {
        await chrome.storage.session?.remove?.('lastInterceptedDup');
        return { ok: true };
      }
      case 'reload-extension': {
        setTimeout(() => { try { chrome.runtime.reload?.(); } catch { /* ignore */ } }, 150);
        return { ok: true };
      }
      case 'state': {
        const { proposal, undo, lastInterceptedDup } = await chrome.storage.session.get(['proposal', 'undo', 'lastInterceptedDup']);
        return { ok: true, proposal: proposal || null, hasUndo: !!undo, lastInterceptedDup: lastInterceptedDup || null, settings: await getSettings() };
      }
      case 'open-sidepanel': {
        const windowId = await currentWindowId();
        await chrome.sidePanel.open({ windowId });
        return { ok: true };
      }
      default:
        return { ok: false, message: `未知消息: ${msg?.type}` };
    }
  })()
    .then(sendResponse)
    .catch(e => sendResponse({ ok: false, message: String(e?.message || e) }));
  return true; // 异步响应
});

/* ---------------- 自动整理：每窗口独立、防抖、可恢复、最多一次失败重试 ---------------- */
const AUTO_STATE_KEY = 'autoOrganizeState';
const AUTO_MAX_ATTEMPTS = 2;
let autoState = { version: 1, tabs: {}, windows: {} };
let autoReady = Promise.resolve();
let autoQueue = Promise.resolve();
const autoRunning = new Set();
const autoAvailable = () => !!(chrome.storage.session && chrome.alarms?.create);
const alarmName = windowId => `${AUTO_ALARM}:${windowId}`;
const autoWindow = id => autoState.windows[id] ||= { dueAt: null, attempts: 0, generation: 0 };
const persistAuto = () => chrome.storage.session?.set({ [AUTO_STATE_KEY]: autoState });
function withAutoState(task) {
  const result = autoQueue.then(() => autoReady).then(task);
  autoQueue = result.catch(() => {});
  return result;
}
function isAnalysisTab(tab, settings) {
  return tab?.id != null && /^https?:\/\//.test(tab.url || '') && (settings.includePinned || !tab.pinned)
    && !isBrowserSearchUrl(tab.url) && !isBrowserSearchUrl(tab.pendingUrl)
    && (!tab.pendingUrl || /^https?:\/\//.test(tab.pendingUrl));
}
async function normalWindowIds(tabs = []) {
  if (chrome.windows.getAll) return new Set((await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(w => w.type === 'normal').map(w => w.id));
  const ids = new Set();
  for (const id of new Set(tabs.map(t => t.windowId))) {
    try { if ((await chrome.windows.get?.(id))?.type === 'normal') ids.add(id); } catch { /* Closed window. */ }
  }
  return ids;
}
async function armAuto(windowId, settings, reset = true) {
  const win = autoWindow(windowId);
  if (reset) { win.attempts = 0; win.generation++; }
  win.dueAt = settings.autoOrganize ? Date.now() + settings.autoOrganizeDelaySeconds * 1000 : null;
  if (win.dueAt != null) await chrome.alarms.create(alarmName(windowId), { when: win.dueAt });
  else await chrome.alarms?.clear?.(alarmName(windowId));
}
async function clearAutoAlarms() {
  await chrome.alarms?.clear?.(AUTO_ALARM);
  const names = new Set(Object.keys(autoState.windows).map(id => alarmName(id)));
  for (const alarm of await chrome.alarms?.getAll?.() || []) if (alarm.name.startsWith(`${AUTO_ALARM}:`)) names.add(alarm.name);
  for (const name of names) await chrome.alarms?.clear?.(name);
  for (const win of Object.values(autoState.windows)) win.dueAt = null;
}
async function seedAutoTabs(settings, tabs, normals) {
  const discovered = new Set();
  const live = new Set();
  for (const tab of tabs) {
    const suppressed = restoredAutoTabs[tab.id];
    if (suppressed && (suppressed.initialLoad || suppressed.url === tab.url || suppressed.url === tab.pendingUrl)) {
      if (suppressed.initialLoad && tab.status === 'complete' && !archivePlaceholderTab(tab, suppressed.sourceUrl)) {
        suppressed.initialLoad = false; suppressed.url = tab.url;
        await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
      }
      delete autoState.tabs[tab.id]; continue;
    }
    if (!normals.has(tab.windowId) || !isAnalysisTab(tab, settings)) continue;
    live.add(String(tab.id));
    const old = autoState.tabs[tab.id];
    if ((!old && tab.groupId === -1) || (old && old.url !== tab.url)) {
      autoState.tabs[tab.id] = { windowId: tab.windowId, url: tab.url, dirty: true, revision: (old?.revision || 0) + 1 };
      discovered.add(tab.windowId);
    } else if (old) old.windowId = tab.windowId;
  }
  for (const id of Object.keys(autoState.tabs)) if (!live.has(id)) delete autoState.tabs[id];
  return discovered;
}
async function restoreAutoState() {
  if (!autoAvailable()) return; // Older Chrome mocks/APIs can bootstrap safely.
  await loadRestoredAutoTabs();
  const saved = (await chrome.storage.session.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
  if (saved?.version === 1 && saved.tabs && saved.windows) autoState = saved;
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({});
  const normals = await normalWindowIds(tabs);
  const discovered = await seedAutoTabs(settings, tabs, normals);
  for (const id of Object.keys(autoState.windows)) if (!normals.has(Number(id))) {
    await chrome.alarms?.clear?.(alarmName(id)); delete autoState.windows[id];
  }
  if (!settings.autoOrganize) await clearAutoAlarms();
  else {
    for (const id of discovered) await armAuto(id, settings);
    for (const [id, win] of Object.entries(autoState.windows)) {
      // Interrupted requests get the one remaining attempt; exhausted requests do not loop after restart.
      if (win.inFlight && win.attempts < AUTO_MAX_ATTEMPTS && win.dueAt == null) {
        win.dueAt = Date.now() + settings.autoOrganizeDelaySeconds * 1000;
      }
      win.inFlight = false;
      if (win.dueAt != null && win.attempts < AUTO_MAX_ATTEMPTS && !discovered.has(Number(id))) {
        await chrome.alarms.create(alarmName(id), { when: Math.max(Date.now() + 1000, win.dueAt) });
      }
    }
  }
  await persistAuto();
}
async function queueAutoTab(tab, { contentSignal = null, loadStatus = null } = {}) {
  if (!autoAvailable()) return;
  return await withAutoState(async () => {
    await loadRestoredAutoTabs();
    const suppressed = restoredAutoTabs[tab?.id];
    if (suppressed && (suppressed.initialLoad || ((suppressed.url === tab?.url || suppressed.url === tab?.pendingUrl)
        && contentSignal == null && loadStatus !== 'loading'))) {
      // Cover provisional URLs/redirects in the restoration's initial load only.
      // A later explicit reload/navigation/content change resumes normal auto work.
      const placeholder = archivePlaceholderTab(tab, suppressed.sourceUrl);
      if (suppressed.initialLoad && loadStatus === 'complete' && !placeholder) suppressed.initialLoad = false;
      if (tab?.url && !placeholder) suppressed.url = tab.url;
      await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
      delete autoState.tabs[tab.id]; await persistAuto(); return;
    }
    if (suppressed) {
      delete restoredAutoTabs[tab.id];
      await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
    }
    const settings = await getSettings();
    const normals = await normalWindowIds([tab]);
    if (!normals.has(tab?.windowId) || !isAnalysisTab(tab, settings)) {
      if (tab?.id != null) delete autoState.tabs[tab.id];
      await persistAuto(); return;
    }
    const old = autoState.tabs[tab.id];
    if (contentSignal != null && old?.dirty && old.contentSignal === contentSignal) return;
    autoState.tabs[tab.id] = { windowId: tab.windowId, url: tab.url, dirty: true,
      revision: (old?.revision || 0) + 1, ...(contentSignal != null ? { contentSignal } : {}) };
    await armAuto(tab.windowId, settings);
    await persistAuto();
  });
}
async function clearAnalyzedDirty(guards) {
  if (!autoAvailable()) return;
  await withAutoState(async () => {
    for (const guard of guards) {
      const row = autoState.tabs[guard.id];
      if (row && row.url === guard.url && row.revision === guard.revision) row.dirty = false;
    }
    for (const [id, win] of Object.entries(autoState.windows)) {
      if (!Object.values(autoState.tabs).some(t => t.windowId === Number(id) && t.dirty)) {
        win.dueAt = null; win.attempts = 0;
        await chrome.alarms?.clear?.(alarmName(id));
      }
    }
    await persistAuto();
  });
}
async function reconfigureAuto(changes, area) {
  if (area !== 'sync' || !changes.settings || !autoAvailable()) return;
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};
  const normalized = normalizeAutoDelay(after.autoOrganizeDelaySeconds);
  if (after.autoOrganizeDelaySeconds !== undefined && after.autoOrganizeDelaySeconds !== normalized) {
    await chrome.storage.sync.set({ settings: { ...after, autoOrganizeDelaySeconds: normalized } });
  }
  if (!!before.autoOrganize === !!after.autoOrganize
      && normalizeAutoDelay(before.autoOrganizeDelaySeconds) === normalized) return;
  await withAutoState(async () => {
    const settings = await getSettings();
    await clearAutoAlarms();
    const tabs = await chrome.tabs.query({});
    const normals = await normalWindowIds(tabs);
    await seedAutoTabs(settings, tabs, normals);
    if (settings.autoOrganize) {
      for (const id of new Set(Object.values(autoState.tabs).filter(t => t.dirty).map(t => t.windowId))) await armAuto(id, settings);
    }
    await persistAuto();
  });
}
async function runAutoWindow(windowId) {
  if (autoRunning.has(windowId)) return;
  let generation;
  const run = await withAutoState(async () => {
    const settings = await getSettings();
    const win = autoWindow(windowId);
    if (!settings.autoOrganize || win.dueAt == null || win.attempts >= AUTO_MAX_ATTEMPTS) return false;
    if (!Object.values(autoState.tabs).some(t => t.windowId === windowId && t.dirty)) {
      win.dueAt = null; await persistAuto(); return false;
    }
    generation = win.generation;
    win.dueAt = null; win.attempts++; win.inFlight = true;
    await persistAuto(); return true;
  });
  if (!run) return;
  autoRunning.add(windowId);
  try {
    await organize({ apply: true, incremental: true, windowId, automatic: true });
  } catch (error) {
    console.warn('自动整理失败（保留待整理记录）:', error);
    await withAutoState(async () => {
      const settings = await getSettings();
      const win = autoWindow(windowId);
      if (settings.autoOrganize && win.generation === generation && win.attempts < AUTO_MAX_ATTEMPTS) await armAuto(windowId, settings, false);
      await persistAuto();
    });
  } finally {
    autoRunning.delete(windowId);
    await withAutoState(async () => {
      const win = autoState.windows[windowId];
      if (!win) return;
      win.inFlight = false;
      // A one-shot alarm can fire while the previous ACP call is still running.
      if (win.dueAt != null && win.dueAt <= Date.now() && (await getSettings()).autoOrganize) {
        await chrome.alarms.create(alarmName(windowId), { when: Date.now() + 1000 });
      }
      await persistAuto();
    });
  }
}
async function handleAutoAlarm(alarm) {
  if (!autoAvailable() || (alarm.name !== AUTO_ALARM && !alarm.name.startsWith(`${AUTO_ALARM}:`))) return;
  await autoReady;
  const settings = await getSettings();
  if (!settings.autoOrganize) { await withAutoState(async () => { await clearAutoAlarms(); await persistAuto(); }); return; }
  const tabs = await chrome.tabs.query({});
  const normals = await normalWindowIds(tabs);
  if (alarm.name === AUTO_ALARM) {
    await withAutoState(async () => {
      await seedAutoTabs(settings, tabs, normals);
      for (const id of new Set(Object.values(autoState.tabs).filter(t => t.dirty && normals.has(t.windowId)).map(t => t.windowId))) {
        const win = autoWindow(id);
        if (win.attempts < AUTO_MAX_ATTEMPTS && win.dueAt == null) win.dueAt = Date.now();
      }
      await chrome.alarms?.clear?.(AUTO_ALARM);
      await persistAuto();
    });
    await Promise.all([...normals].map(id => runAutoWindow(id)));
  } else {
    const id = Number(alarm.name.slice(AUTO_ALARM.length + 1));
    if (Number.isInteger(id) && normals.has(id)) await runAutoWindow(id);
  }
}

chrome.tabs.onCreated?.addListener(tab => {
  const createdUrl = tab?.pendingUrl || tab?.url || '';
  if (tab?.id != null && (tab.active === true || tab.openerTabId != null || isNewTabPageUrl(createdUrl)) && typeof chrome.tabs?.remove === 'function') {
    newlyCreatedTabIds.set(tab.id, Date.now());
    maybeInterceptDuplicateTab(tab).catch(e => console.warn('拦截重复新标签失败:', e));
  }
  return queueAutoTab(tab).catch(e => console.warn('排队自动整理失败:', e));
});
chrome.tabs.onUpdated?.addListener(async (id, info, tab) => {
  if (!info.url && info.status !== 'loading' && info.status !== 'complete') return;
  try {
    const liveTab = tab || await chrome.tabs.get(id);
    if (info.url && newlyCreatedTabIds.has(id)) {
      maybeInterceptDuplicateTab(liveTab).catch(e => console.warn('拦截重复新标签失败:', e));
    }
    await queueAutoTab(liveTab, { loadStatus: info.status || null });
  } catch (e) { console.warn('排队自动整理失败:', e); }
});
chrome.tabs.onRemoved?.addListener(id => withAutoState(async () => {
  await loadRestoredAutoTabs();
  if (restoredAutoTabs[id]) {
    delete restoredAutoTabs[id];
    await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
  }
  if (!autoAvailable()) return;
  const row = autoState.tabs[id];
  delete autoState.tabs[id];
  if (row && !Object.values(autoState.tabs).some(t => t.windowId === row.windowId && t.dirty)) {
    autoWindow(row.windowId).dueAt = null;
    await chrome.alarms?.clear?.(alarmName(row.windowId));
  }
  await persistAuto();
}).catch(e => console.warn('清理自动整理标签失败:', e)));
chrome.windows.onRemoved?.addListener(id => withAutoState(async () => {
  if (!autoAvailable()) return;
  delete autoState.windows[id];
  for (const [tabId, row] of Object.entries(autoState.tabs)) if (row.windowId === id) delete autoState.tabs[tabId];
  await chrome.alarms?.clear?.(alarmName(id));
  await persistAuto();
}).catch(e => console.warn('清理自动整理窗口失败:', e)));
async function syncDiscardAlarm(settings = null) {
  if (typeof chrome.alarms?.create !== 'function') return;
  const s = settings || await getSettings();
  if (!s.autoDiscardEnabled) {
    await chrome.alarms.clear?.(DISCARD_ALARM);
    return;
  }
  await chrome.alarms.create(DISCARD_ALARM, { periodInMinutes: 2 });
}
async function handleDiscardAlarm() {
  const s = await getSettings();
  if (!s.autoDiscardEnabled) {
    await chrome.alarms?.clear?.(DISCARD_ALARM);
    return;
  }
  await discardIdleTabs({ windowId: null, minIdleMinutes: s.autoDiscardMinutes, skipLocked: true });
}

chrome.tabGroups?.onRemoved?.addListener?.(group => {
  if (!Number.isInteger(group?.id)) return;
  readLockedGroupIds().then(set => {
    if (set.delete(group.id)) return writeLockedGroupIds(set);
  }).catch(() => {});
  readManualNamedGroups().then(map => {
    if (map.delete(group.id)) return writeManualNamedGroups(map);
  }).catch(() => {});
});

chrome.storage.onChanged?.addListener((changes, area) => Promise.all([
  reconfigureAuto(changes, area).catch(e => console.warn('更新自动整理配置失败:', e)),
  (area === 'sync' && changes.settings)
    ? syncDiscardAlarm({ ...DEFAULTS, ...(changes.settings.newValue || {}), autoDiscardEnabled: Boolean(changes.settings.newValue?.autoDiscardEnabled) })
        .catch(e => console.warn('更新自动休眠定时器失败:', e))
    : Promise.resolve(),
]));
chrome.tabs.onReplaced?.addListener((addedId, removedId) => withAutoState(async () => {
  await loadRestoredAutoTabs();
  if (restoredAutoTabs[removedId]) {
    restoredAutoTabs[addedId] = restoredAutoTabs[removedId];
    delete restoredAutoTabs[removedId];
    await chrome.storage.session.set({ [ARCHIVE_AUTO_KEY]: restoredAutoTabs });
  }
  if (!autoAvailable()) return;
  if (autoState.tabs[removedId]) {
    autoState.tabs[addedId] = autoState.tabs[removedId];
    delete autoState.tabs[removedId];
    await persistAuto();
  }
}).catch(() => {}));
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm?.name === DISCARD_ALARM) {
    return handleDiscardAlarm().catch(e => console.warn('执行自动休眠失败:', e));
  }
  return handleAutoAlarm(alarm).catch(e => console.warn('读取自动整理队列失败:', e));
});
autoReady = restoreAutoState().catch(e => console.warn('恢复自动整理队列失败:', e));
async function dedupExistingNewTabs() {
  if (typeof chrome.tabs?.query !== 'function' || typeof chrome.tabs?.remove !== 'function') return;
  try {
    const settings = await getSettings();
    if (settings.interceptDuplicates === false) return;
    const [tabs, locked] = await Promise.all([chrome.tabs.query({}), readLockedGroupIds()]);
    const byWindow = new Map();
    for (const t of tabs) {
      if (t.pinned || !isNewTabPageUrl(t.url || t.pendingUrl || '')) continue;
      if (t.groupId !== -1 && locked.has(t.groupId)) continue;
      const wid = t.windowId ?? 'any';
      if (!byWindow.has(wid)) byWindow.set(wid, []);
      byWindow.get(wid).push(t);
    }
    const toRemove = [];
    for (const list of byWindow.values()) {
      if (list.length <= 1) continue;
      const keeper = list.find(t => t.active) || list[0];
      for (const t of list) if (t.id !== keeper.id) toRemove.push(t.id);
    }
    if (toRemove.length) await chrome.tabs.remove(toRemove);
  } catch { /* ignore */ }
}
dedupExistingNewTabs();
chrome.runtime.onStartup?.addListener(() => {
  syncDiscardAlarm().catch(() => {});
  dedupExistingNewTabs();
});

chrome.runtime.onInstalled?.addListener(async () => {
  await configureActionEntry();
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) await chrome.storage.sync.set({ settings: DEFAULTS });
  await syncDiscardAlarm();
});