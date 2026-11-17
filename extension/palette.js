/* Command+K 统一搜索：网址直达 / 标签 / 书签 / 浏览历史 / 分组 / 命令 / 网页搜索
 * 共享组件：home / sidepanel / popup 自动按 body class 识别表面。
 * ↑↓ 选择、↵ 执行、esc 关闭；分组结果定位到对应卡片并闪烁提示。 */
(() => {
  const surface = ['home', 'sidepanel', 'popup', 'search-window'].find(name => document.body.classList.contains(name));
  // Web pages host an isolated extension-origin frame, never the search DOM itself.
  if (!surface || !location.href.startsWith(chrome.runtime.getURL(''))) return;
  const standalone = surface === 'search-window';
  const params = new URL(location.href).searchParams;
  const framed = typeof self !== 'undefined' && typeof top !== 'undefined' && self !== top;
  const embedded = standalone && (params.has('embedded') || framed);
  const embeddedNonce = params.getAll('embedded').length === 1 ? params.get('embedded') : '';
  if (embedded) document.body.classList.add('search-embedded');
  let sourceWindowId = null, currentTabId = null, sourceReady = false, activating = false;
  let authorizationFailed = false, disposed = false, localTabId = null;
  let sideSearchBusy = false, sideSearchQueued = false, mainSearchPending = false;
  let open = false, view = [], sel = 0, selectionTouched = false, browserWideTabs = standalone;
  let generation = 0, previousFocus = null, composing = false;
  let pendingFocusToken = 0, pendingFocusTabId = null;
  let loading = false, loadFailed = false, currentWindowId = null;
  let data = { tabs: [], groups: [], tabMeta: {}, history: [], bookmarks: [] };
  let baseProvider = 'all', bookmarkToken = 0, bookmarkTimer = null, bookmarkQuery = '', remoteBookmarks = [];
  let historyToken = 0, historyTimer = null, historyQuery = '', remoteHistory = [];
  let pendingDestination = null, activationToken = 0;
  function cancelBookmarkSearch() {
    ++bookmarkToken;
    if (bookmarkTimer !== null) clearTimeout(bookmarkTimer);
    bookmarkTimer = null;
  }
  function cancelHistorySearch() {
    ++historyToken;
    if (historyTimer !== null) clearTimeout(historyTimer);
    historyTimer = null;
  }
  // Keep the user's command intact; a prefix overrides only this input, never the session's base source.
  function searchInput() { return parseSearchInput(input.value, baseProvider); }
  function searchQuery() { return searchInput().query; }
  function hasBookmarks() { const { provider } = searchInput(); return provider === 'all' || provider === 'bookmarks'; }
  function hasHistory() { const { provider } = searchInput(); return provider === 'all' || provider === 'history'; }
  function isOwnSearch(url) { return String(url || '').startsWith(chrome.runtime.getURL('search.html')); }
  const BOOKMARK_TYPE_ICO = '<svg class="bookmark-type-ico" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#F59E0B"/><path d="M8 6.8h8a1 1 0 0 1 1 1v10l-5-3-5 3v-10a1 1 0 0 1 1-1Z" fill="#fff"/></svg>';
  function flattenBookmarksTree(tree) {
    const out = [];
    const ROOT_TITLES = new Set(['书签栏', 'Bookmarks bar', '其他书签', 'Other bookmarks', '移动设备书签', 'Mobile bookmarks']);
    const walk = (nodes, trail) => {
      for (const n of nodes || []) {
        if (!n) continue;
        if (n.url && /^https?:\/\//i.test(n.url)) {
          out.push({
            id: String(n.id || n.url),
            title: String(n.title || n.url),
            url: n.url,
            folderPath: trail.join(' / '),
            dateAdded: Number(n.dateAdded) || 0,
          });
        } else if (n.children) {
          const name = String(n.title || '').trim();
          const nextTrail = name && !ROOT_TITLES.has(name) ? [...trail, name] : trail;
          walk(n.children, nextTrail);
        }
      }
    };
    walk(tree, []);
    return out;
  }
  const windowReady = embedded ? Promise.resolve() : chrome.windows.getCurrent()
    .then(win => { currentWindowId = win.id; if (surface === 'sidepanel') consumeSideSearch(); }).catch(() => {});
  const localTabReady = !standalone && chrome.tabs.getCurrent
    ? chrome.tabs.getCurrent().then(tab => { localTabId = tab?.id; }).catch(() => {}) : Promise.resolve();
  function embeddedRequest(type, detail = {}) { return { type, ...detail, ...(embedded ? { nonce: embeddedNonce } : {}) }; }
  function closeRequest(restoreFocus) {
    return embeddedRequest(embedded ? 'page-search-close' : 'browser-search-close', { restoreFocus });
  }
  function trustedRuntimeSender(sender) {
    return !sender?.tab && (!sender?.id || sender.id === chrome.runtime.id);
  }

  const el = document.createElement('div');
  el.id = 'palette';
  el.className = 'palette hidden';
  el.innerHTML = `
    <div class="palette-panel" role="dialog" aria-modal="true" aria-label="快速搜索">
      <div class="palette-input-row">
        ${icon('search', 16)}
        <input id="paletteInput" type="text" placeholder="搜索标签、书签或网页…" autocomplete="off" spellcheck="false" autofocus role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="paletteList" aria-label="搜索标签、书签或网页">
        <kbd>esc</kbd>
      </div>
      <ul id="paletteList" role="listbox" aria-label="搜索结果"></ul>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>⌘</kbd><kbd>C</kbd> 复制</span>
        <span><kbd>esc</kbd> 关闭</span>
        <span class="palette-count" id="paletteCount" role="status" aria-live="polite"></span>
      </div>
    </div>`;
  document.body.appendChild(el);
  const input = el.querySelector('#paletteInput');
  const list = el.querySelector('#paletteList');
  const countEl = el.querySelector('#paletteCount');

  function focusInput() {
    if (!open || disposed) return;
    try { input.focus({ preventScroll: true }); } catch { input.focus(); }
  }

  function itemUrl(it) {
    if (!it) return '';
    if (it.kind === 'url') return it.matchedTab?.url || it.url || '';
    if (it.kind === 'tab') return it.tab?.url || '';
    if (it.kind === 'history') return it.item?.url || '';
    if (it.kind === 'bookmark') return it.bookmark?.url || '';
    return '';
  }

  async function writeClipboardText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* Fall back to synchronous execCommand inside active gesture. */ }
    }
    if (typeof document.execCommand === 'function' && document.body?.appendChild) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand('copy') === true; } catch { copied = false; }
      area.remove?.();
      focusInput();
      if (copied) return true;
    }
    return false;
  }

  async function copyItemUrl(it, btnEl = null) {
    const url = itemUrl(it);
    if (!url || !open || disposed) return false;
    const isEn = typeof getUiLanguage === 'function' && getUiLanguage() === 'en';
    const tr = typeof translateUiText === 'function' ? translateUiText : s => s;
    const ok = await writeClipboardText(url);
    if (!open || disposed) return ok;
    if (!ok) {
      toast(tr('复制失败，请手动复制'), 'err');
      return false;
    }
    const targetBtn = btnEl || list.querySelector(`.palette-row[data-i="${sel}"] .palette-copy`);
    if (targetBtn) {
      targetBtn.classList.add('copied');
      targetBtn.innerHTML = `${icon('check', 12)}<span>${escapeHtml(tr('已复制'))}</span>`;
      setTimeout(() => {
        if (targetBtn.isConnected) {
          targetBtn.classList.remove('copied');
          targetBtn.innerHTML = `${icon('copy', 12)}<span>${escapeHtml(tr('复制链接'))}</span>`;
        }
      }, 1400);
    }
    toast(isEn ? `Copied URL: ${url}` : `已复制链接：${url}`, 'ok');
    focusInput();
    return true;
  }

  async function loadData() {
    const historyPromise = typeof chrome !== 'undefined' && chrome.history?.search
      ? chrome.history.search({ text: '', maxResults: 150, startTime: Date.now() - 180 * 86400000 }).catch(() => [])
      : Promise.resolve([]);
    const bookmarksPromise = typeof chrome !== 'undefined' && chrome.bookmarks?.getTree
      ? chrome.bookmarks.getTree().then(flattenBookmarksTree).catch(() => [])
      : Promise.resolve([]);
    const [tabs, groups, state, localMeta, history, bookmarks] = await Promise.all([
      chrome.tabs.query({}), chrome.tabGroups.query({}),
      standalone && !embedded ? chrome.runtime.sendMessage({ type: 'browser-search-state' }).catch(() => null) : null,
      chrome.storage?.local?.get?.('tabMetaCache')?.catch?.(() => ({})) || Promise.resolve({}),
      historyPromise,
      bookmarksPromise,
    ]);
    const tabMeta = (localMeta?.tabMetaCache && typeof localMeta.tabMetaCache === 'object') ? localMeta.tabMetaCache : {};
    return { tabs, groups, state, tabMeta, history: Array.isArray(history) ? history : [], bookmarks: Array.isArray(bookmarks) ? bookmarks : [] };
  }

  function openSidePanel() {
    const fallback = () => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
    // Cache the window before the gesture: awaiting getCurrent here loses activation.
    if (!Number.isInteger(currentWindowId)) return fallback();
    try { return chrome.sidePanel.open({ windowId: currentWindowId }).catch(fallback); }
    catch { return fallback(); }
  }

  function focusGroup(group) {
    const detail = { groupId: group.id, windowId: group.windowId };
    // A listener must synchronously preventDefault() to claim responsibility.
    // Sidepanel only renders its own window; popup has no group listener.
    const local = surface === 'home' || (surface === 'sidepanel' && group.windowId === currentWindowId);
    if (local && !document.dispatchEvent(new CustomEvent('tt-focus-group', { detail, cancelable: true }))) return;
    const query = new URLSearchParams({ focusGroup: String(group.id), windowId: String(group.windowId) });
    return chrome.tabs.create({ url: chrome.runtime.getURL('home.html') + '?' + query });
  }

  const trText = s => (typeof translateUiText === 'function' ? translateUiText(s) : s);
  function commands() {
    const cmds = [
      { id: 'organize', label: trText('立即整理'), hint: trText('AI 语义分组并应用'), ic: 'refresh', run: () => (document.getElementById('organize') || document.getElementById('regroup'))?.click() },
      { id: 'dedup', label: trText('一键去重'), hint: trText('关闭重复标签，可恢复'), ic: 'close', run: () => document.getElementById('dedup')?.click() },
      { id: 'undo', label: trText('撤销上次整理'), hint: trText('恢复到整理前'), ic: 'undo', run: async () => { const r = await chrome.runtime.sendMessage({ type: 'undo' }); toast(r?.ok ? '已撤销' : (r?.message || '没有可撤销的操作'), r?.ok ? 'ok' : 'err'); } },
      { id: 'theme', label: trText('循环切换主题'), hint: trText('自动 → 浅色 → 深色'), ic: 'moon', run: () => { const order = ['auto', 'light', 'dark']; setThemeMode(order[(order.indexOf(themeMode) + 1) % order.length]); } },
      { id: 'lang', label: trText('切换语言（中文 / English）'), hint: trText('实时切换中英文界面'), ic: 'moon', run: () => { if (typeof setUiLang === 'function' && typeof getUiLang === 'function') setUiLang(getUiLang() === 'en' ? 'zh' : 'en'); } },
    ];
    if (surface !== 'home') cmds.push({ id: 'home', label: trText('打开首页工作台'), hint: trText('全窗口标签聚合'), ic: 'arrowRight', run: () => chrome.tabs.create({ url: chrome.runtime.getURL('home.html') }) });
    if (surface !== 'sidepanel') cmds.push({ id: 'sidepanel', label: trText('打开 AI 侧边栏'), hint: trText('实时分组视图'), ic: 'arrowRight', run: openSidePanel });
    return cmds;
  }

  const RECENT_TAB_LIMIT = 5;
  function directUrlTarget(query = searchQuery()) {
    if (typeof parseDirectUrl !== 'function') return null;
    const { provider, prefix } = searchInput();
    if (prefix || !['all', 'tabs'].includes(provider)) return null;
    return parseDirectUrl(query);
  }
  function urlMatchesDirectFilter(candidateUrl, direct) {
    if (!candidateUrl || !direct) return false;
    if (typeof urlsMatchForDirectJump === 'function' && urlsMatchForDirectJump(candidateUrl, direct.url)) return true;
    const cand = typeof normalizeUrlForMatch === 'function' ? normalizeUrlForMatch(candidateUrl) : null;
    if (!cand) return false;
    if (direct.hasExplicitPath) {
      const targetNorm = direct.normalized.replace(/\/+$/, '');
      if (cand.hostPath === targetNorm || cand.hostPath.startsWith(targetNorm + '/') || cand.hostPath.startsWith(targetNorm + '?')) return true;
      return false;
    }
    return cand.host === direct.host || cand.host.endsWith('.' + direct.host);
  }
  function scoreFields(query, fields) {
    const q = String(query || '').trim();
    if (!q) return 1;
    if (typeof vectorSearchScore === 'function') return vectorSearchScore(q, fields);
    const needle = q.toLowerCase();
    let best = 0;
    for (const f of fields) {
      const text = String(f?.text || f || '').toLowerCase();
      const w = Number(f?.weight) || 1;
      let s = 0;
      if (text.startsWith(needle)) s = 4 * w;
      else if (text.includes(needle)) s = 3 * w;
      if (s > best) best = s;
    }
    return best;
  }

  function buildNativeItems(q, direct = null, excludeTabId = null) {
    const { provider } = searchInput();
    if (provider === 'bookmarks' || provider === 'google' || provider === 'history') {
      return { recentItems: [], tabItems: [], groupItems: [], cmdItems: [], openUrls: new Set() };
    }
    const query = q.trim();
    const gname = new Map(data.groups.map(g => [g.id, g.title || '未命名组']));
    const tabMeta = data.tabMeta || {};
    const eligibleTabs = data.tabs.filter(t => !isOwnSearch(t.url) && (browserWideTabs ? !!t.url : /^https?:/.test(t.url || '')));
    const openUrls = new Set(eligibleTabs.map(t => t.url).filter(Boolean));
    // 划分「最近打开」集合（按 lastAccessed 倒序取前 RECENT_TAB_LIMIT 条，排除当前所在页避免自跳转干扰）
    const recentIds = new Set(
      eligibleTabs
        .filter(t => !(standalone && t.id === currentTabId) && Number.isFinite(t.lastAccessed) && t.lastAccessed > 0)
        .sort((a, b) => b.lastAccessed - a.lastAccessed)
        .slice(0, RECENT_TAB_LIMIT)
        .map(t => t.id),
    );
    const recentItems = [];
    const tabItems = [];
    for (const t of eligibleTabs) {
      if (excludeTabId != null && t.id === excludeTabId) continue;
      const title = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(t, tabMeta) : cleanTitle(t.title, t.url);
      const summary = typeof resolveTabSummary === 'function' ? resolveTabSummary(t, tabMeta) : '';
      const groupTitle = gname.get(t.groupId) || '';
      const s = direct
        ? (urlMatchesDirectFilter(t.url, direct) ? 10 : 0)
        : query
          ? scoreFields(query, [
              { text: title, weight: 1.0 },
              { text: summary, weight: 0.85 },
              { text: t.title && t.title !== title ? t.title : '', weight: 0.75 },
              ...(standalone ? [{ text: groupTitle, weight: 0.6 }] : []),
              { text: t.url, weight: 0.4 },
            ])
          : 1;
      if ((query || direct) && s <= 0) continue;
      const item = {
        kind: 'tab',
        section: recentIds.has(t.id) ? 'recent' : 'tab',
        score: s,
        tab: t,
        title,
        summary,
        group: groupTitle,
      };
      if (item.section === 'recent') recentItems.push(item);
      else tabItems.push(item);
    }
    const sortTabsByVector = (a, b) => (b.score - a.score)
      || ((b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0));
    recentItems.sort(query ? sortTabsByVector : (a, b) => (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0));
    tabItems.sort(
      query
        ? sortTabsByVector
        : (a, b) => (standalone ? Number(a.tab.id === currentTabId) - Number(b.tab.id === currentTabId) : 0)
          || ((b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0)),
    );
    if (standalone) {
      return {
        recentItems,
        tabItems: tabItems.slice(0, Math.max(0, 100 - recentItems.length)),
        groupItems: [],
        cmdItems: [],
        openUrls,
      };
    }
    const groupItems = [];
    if (!direct) {
      for (const g of data.groups) {
        const n = data.tabs.filter(t => t.groupId === g.id).length;
        if (!n) continue;
        const s = query ? scoreFields(query, [{ text: g.title || '未命名组', weight: 1.0 }]) : 1;
        if (query && s <= 0) continue;
        groupItems.push({ kind: 'group', section: 'group', score: s, group: g, count: n });
      }
      groupItems.sort((a, b) => b.score - a.score || b.count - a.count);
    }

    const cmdItems = [];
    if (!direct) {
      for (const c of commands()) {
        const s = query ? scoreFields(query, [{ text: c.label, weight: 1.0 }, { text: c.hint, weight: 0.55 }]) : 1;
        if (query && s <= 0) continue;
        cmdItems.push({ kind: 'cmd', section: 'cmd', score: s, cmd: c });
      }
      if (query) cmdItems.sort((a, b) => b.score - a.score);
    }

    return {
      recentItems,
      tabItems: tabItems.slice(0, 35),
      groupItems: groupItems.slice(0, 12),
      cmdItems: cmdItems.slice(0, 10),
      openUrls,
    };
  }

  function buildHistoryItems(q, openUrls, direct = null) {
    const { provider } = searchInput();
    if (!hasHistory()) return [];
    const query = q.trim();
    const tabMeta = data.tabMeta || {};
    const seen = new Set();
    const pool = [...(Array.isArray(data.history) ? data.history : []), ...(query && query === historyQuery ? remoteHistory : [])];
    const items = [];
    for (const h of pool) {
      const url = String(h?.url || '');
      if (!url || isOwnSearch(url) || !/^https?:/.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      if (provider === 'all' && openUrls?.has(url)) continue;
      const meta = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle({ title: h.title, url }, tabMeta) : (h.title || url);
      const summary = typeof resolveTabSummary === 'function' ? resolveTabSummary({ url }, tabMeta) : '';
      const displayTitle = meta || cleanTitle(h.title || url, url);
      const s = direct
        ? (urlMatchesDirectFilter(url, direct) ? 10 : 0)
        : query
          ? scoreFields(query, [
              { text: displayTitle, weight: 1.0 },
              { text: summary, weight: 0.78 },
              { text: h.title && h.title !== displayTitle ? h.title : '', weight: 0.7 },
              { text: url, weight: 0.5 },
            ])
          : 1;
      if ((query || direct) && s <= 0) continue;
      items.push({
        kind: 'history',
        section: 'history',
        score: s,
        title: displayTitle,
        summary,
        item: {
          id: String(h.id || url),
          url,
          title: h.title || displayTitle,
          lastVisitTime: Number(h.lastVisitTime) || 0,
          visitCount: Number(h.visitCount) || 0,
        },
      });
    }
    items.sort((a, b) => (b.score - a.score)
      || ((b.item.visitCount || 0) - (a.item.visitCount || 0))
      || ((b.item.lastVisitTime || 0) - (a.item.lastVisitTime || 0)));
    return query ? items.slice(0, provider === 'history' ? 40 : 12) : items.slice(0, provider === 'history' ? 30 : 6);
  }

  function buildDirectItem(direct) {
    if (!direct) return null;
    const gname = new Map(data.groups.map(g => [g.id, g.title || '未命名组']));
    const tabMeta = data.tabMeta || {};
    const eligibleTabs = data.tabs.filter(t => !isOwnSearch(t.url) && /^https?:/.test(t.url || ''));
    const matchedTab = eligibleTabs.find(t => (typeof urlsMatchForDirectJump === 'function' ? urlsMatchForDirectJump(t.url, direct.url) : t.url === direct.url)) || null;
    if (matchedTab) {
      const title = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(matchedTab, tabMeta) : cleanTitle(matchedTab.title, matchedTab.url);
      return {
        kind: 'url',
        section: 'direct',
        url: direct.url,
        host: direct.host,
        matchedTab,
        title,
        group: gname.get(matchedTab.groupId) || '',
      };
    }
    const pool = [...(Array.isArray(data.history) ? data.history : []), ...remoteHistory];
    const matchedHist = pool.find(h => (typeof urlsMatchForDirectJump === 'function' ? urlsMatchForDirectJump(h?.url, direct.url) : h?.url === direct.url));
    const historyTitle = matchedHist ? (typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle({ title: matchedHist.title, url: matchedHist.url }, tabMeta) : (matchedHist.title || '')) : '';
    return {
      kind: 'url',
      section: 'direct',
      url: direct.url,
      host: direct.host,
      matchedTab: null,
      title: direct.url,
      historyTitle: historyTitle && historyTitle !== direct.url ? historyTitle : '',
    };
  }

  function buildBookmarkItems(q, openUrls = null, direct = null) {
    const { provider } = searchInput();
    if (!hasBookmarks() || direct) return [];
    const query = String(q || '').trim();
    if (!query && provider !== 'bookmarks') return [];
    const seen = new Set();
    const pool = [...(Array.isArray(data.bookmarks) ? data.bookmarks : []), ...(bookmarkQuery === query ? remoteBookmarks : [])];
    const items = [];
    for (const b of pool) {
      const url = String(b?.url || '');
      if (!/^https?:\/\//.test(url) || isOwnSearch(url) || seen.has(url)) continue;
      if (provider === 'all' && openUrls?.has(url)) continue;
      seen.add(url);
      const title = String(b.title || domainOf(url) || url);
      const folderPath = String(b.folderPath || '');
      const s = query
        ? scoreFields(query, [
            { text: title, weight: 1.0 },
            { text: folderPath, weight: 0.65 },
            { text: url, weight: 0.5 },
          ])
        : 1;
      if (query && s <= 0) continue;
      items.push({
        kind: 'bookmark',
        section: 'bookmark',
        score: s,
        title,
        bookmark: { id: String(b.id || url), title, url, folderPath, dateAdded: Number(b.dateAdded) || 0 },
      });
    }
    items.sort((a, b) => (b.score - a.score) || ((b.bookmark.dateAdded || 0) - (a.bookmark.dateAdded || 0)));
    return query ? items.slice(0, provider === 'bookmarks' ? 30 : 10) : items.slice(0, 20);
  }

  function buildItems(q) {
    if (embedded && !sourceReady) return [];
    const { provider } = searchInput();
    const query = q.trim();
    const direct = directUrlTarget(query);
    if (provider === 'history') return buildHistoryItems(q, null, typeof parseDirectUrl === 'function' ? parseDirectUrl(query) : null);
    if (provider === 'bookmarks') return buildBookmarkItems(q, null, typeof parseDirectUrl === 'function' ? parseDirectUrl(query) : null);
    const directItem = buildDirectItem(direct);
    const { recentItems, tabItems, groupItems, cmdItems, openUrls } = buildNativeItems(q, direct, directItem?.matchedTab?.id ?? null);
    const bookmarkItems = buildBookmarkItems(q, openUrls, direct);
    const historyItems = buildHistoryItems(q, openUrls, direct);
    // 严格按「网址直达(当输入为 URL) -> 最近打开 -> 标签页 -> 书签 -> 浏览历史 -> 分组 -> 命令 -> Google」层级输出
    const out = directItem ? [directItem, ...recentItems, ...tabItems] : [...recentItems, ...tabItems];
    if (!query) return [...out, ...bookmarkItems, ...historyItems, ...groupItems, ...cmdItems];
    if (bookmarkItems.length) out.push(...bookmarkItems);
    if (historyItems.length) out.push(...historyItems);
    if (!standalone) out.push(...groupItems, ...cmdItems);
    if (!direct && (provider === 'all' || provider === 'google')) out.push({ kind: 'google', section: 'google', query });
    return out;
  }

  function itemKey(item) {
    if (!item) return '';
    if (item.kind === 'url') return 'url:' + item.url;
    if (item.kind === 'tab') return 'tab:' + item.tab.id;
    if (item.kind === 'bookmark') return 'bookmark:' + item.bookmark.url;
    if (item.kind === 'history') return 'history:' + item.item.url;
    if (item.kind === 'group') return 'group:' + item.group.id;
    if (item.kind === 'cmd') return 'cmd:' + item.cmd.id;
    return item.kind + ':' + item.query;
  }

  function scheduleBookmarks() {
    const query = searchQuery();
    cancelBookmarkSearch();
    remoteBookmarks = [];
    bookmarkQuery = query;
    if (!open || (embedded && !sourceReady) || !hasBookmarks() || !query || composing || directUrlTarget(query)) return;
    if (typeof chrome === 'undefined' || typeof chrome.bookmarks?.search !== 'function') return;
    const token = bookmarkToken, session = generation;
    bookmarkTimer = setTimeout(async () => {
      bookmarkTimer = null;
      if (!open || token !== bookmarkToken || session !== generation || !hasBookmarks() || composing || query !== searchQuery()) return;
      try {
        const res = await chrome.bookmarks.search({ query });
        if (!open || token !== bookmarkToken || session !== generation || query !== searchQuery()) return;
        const folderByUrl = new Map((data.bookmarks || []).map(b => [b.url, b.folderPath]));
        remoteBookmarks = (Array.isArray(res) ? res : [])
          .filter(b => b?.url && /^https?:\/\//i.test(b.url))
          .map(b => ({
            id: String(b.id || b.url),
            title: String(b.title || b.url),
            url: b.url,
            folderPath: folderByUrl.get(b.url) || '',
            dateAdded: Number(b.dateAdded) || 0,
          }));
        bookmarkQuery = query;
        refresh(selectionTouched);
      } catch { /* ignore bookmark query failures */ }
    }, 100);
  }

  function scheduleHistory() {
    const query = searchQuery();
    cancelHistorySearch();
    remoteHistory = [];
    historyQuery = query;
    if (!open || (embedded && !sourceReady) || !hasHistory() || !query || composing) return;
    if (typeof chrome === 'undefined' || typeof chrome.history?.search !== 'function') return;
    const token = historyToken, session = generation;
    historyTimer = setTimeout(async () => {
      historyTimer = null;
      if (!open || token !== historyToken || session !== generation || !hasHistory() || composing || query !== searchQuery()) return;
      try {
        const res = await chrome.history.search({ text: query, maxResults: 50, startTime: 0 });
        if (!open || token !== historyToken || session !== generation || query !== searchQuery()) return;
        remoteHistory = Array.isArray(res) ? res : [];
        historyQuery = query;
        refresh(selectionTouched);
      } catch { /* ignore history query failures */ }
    }, 120);
  }

  function mark(text, q) {
    const raw = String(text || '');
    const tokens = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return escapeHtml(raw);
    const lower = raw.toLowerCase();
    const ranges = [];
    for (const tok of tokens) {
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(tok, from);
        if (idx < 0) break;
        ranges.push([idx, idx + tok.length]);
        from = idx + tok.length;
      }
    }
    if (!ranges.length) return escapeHtml(raw);
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const [start, end] of ranges) {
      if (!merged.length || start > merged.at(-1)[1]) merged.push([start, end]);
      else merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    }
    let out = '', pos = 0;
    for (const [start, end] of merged) {
      if (start > pos) out += escapeHtml(raw.slice(pos, start));
      out += '<mark>' + escapeHtml(raw.slice(start, end)) + '</mark>';
      pos = end;
    }
    if (pos < raw.length) out += escapeHtml(raw.slice(pos));
    return out;
  }

  const SECTION = { direct: '网址直达', recent: '最近打开', tab: '标签页', bookmark: '书签', history: '浏览历史', group: '分组', cmd: '命令', google: '网页搜索' };
  const SOURCE_LABEL = { all: '全部', tabs: '标签', bookmarks: '书签', history: '历史', google: 'Google' };
  const PREFIX_HINT = 'b 空格 书签 · h 空格 历史 · g 空格 Google';
  function render() {
    const isEn = typeof getUiLang === 'function' && getUiLang() === 'en';
    const { query: q, provider, prefix } = searchInput();
    const emptyPrefixHint = prefix && !q ? trText(`请输入${SOURCE_LABEL[provider]}搜索词`) : '';
    const placeholder = provider === 'all' ? trText('搜索标签、书签或浏览历史…') : provider === 'tabs' ? trText('搜索标签、分组或命令…') : provider === 'bookmarks' ? trText('搜索书签…') : provider === 'history' ? trText('搜索浏览历史…') : trText(`输入${SOURCE_LABEL[provider]}搜索词…`);
    const hintText = isEn ? 'b: Bookmarks · h: History · g: Google' : PREFIX_HINT;
    input.setAttribute('placeholder', isEn ? `${placeholder} (${hintText})` : `${placeholder}（${PREFIX_HINT}）`);
    list.innerHTML = '';
    let lastSection = null;
    view.forEach((it, i) => {
      const secKey = it.section || it.kind;
      if (secKey !== lastSection) {
        lastSection = secKey;
        const sec = document.createElement('li');
        sec.className = 'palette-sec';
        sec.setAttribute('role', 'presentation');
        sec.setAttribute('aria-hidden', 'true');
        sec.textContent = trText(SECTION[secKey] || SECTION[it.kind]);
        list.appendChild(sec);
      }
      const li = document.createElement('li');
      li.id = `palette-option-${i}`;
      li.className = 'palette-row' + (i === sel ? ' sel' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel));
      li.dataset.i = i;
      li.dataset.kind = it.kind;
      li.dataset.key = itemKey(it);
      let ic = 'info', main = '', sub = '', tag = '';
      if (it.kind === 'url') {
        ic = it.matchedTab ? 'arrowRight' : 'globe';
        if (it.matchedTab) {
          main = isEn ? `Switch to open tab: ${escapeHtml(it.title)}` : `切换到已打开网页：${escapeHtml(it.title)}`;
          sub = escapeHtml(it.matchedTab.url || it.url);
          tag = it.group ? escapeHtml(it.group) : trText('已打开直达');
        } else {
          main = isEn ? `Open URL: ${escapeHtml(it.url)}` : `打开网址：${escapeHtml(it.url)}`;
          sub = it.historyTitle
            ? (isEn ? `Visited "${escapeHtml(it.historyTitle)}" · Press Enter to open` : `曾访问「${escapeHtml(it.historyTitle)}」· 按 Enter 在新标签页打开`)
            : (isEn ? `Press Enter to open ${escapeHtml(it.host)}` : `按 Enter 在新标签页打开 ${escapeHtml(it.host)}`);
          tag = trText('网址直达');
        }
      } else if (it.kind === 'tab') {
        ic = 'signal';
        main = mark(it.title, q);
        const addr = escapeHtml(standalone ? it.tab.url : domainOf(it.tab.url));
        sub = it.summary ? `${mark(it.summary, q)} · ${addr}` : addr;
        tag = it.group ? escapeHtml(it.group) : trText('未分组');
        if (standalone) {
          const windows = [...new Set(data.tabs.filter(t => !t.url?.startsWith(chrome.runtime.getURL('search.html'))).map(t => t.windowId))];
          const winNum = windows.indexOf(it.tab.windowId) + 1;
          const windowLabel = it.tab.windowId === sourceWindowId ? trText('当前窗口') : (isEn ? `Window ${winNum}` : `窗口 ${winNum}`);
          tag = it.group ? `${escapeHtml(it.group)} / ${windowLabel}` : windowLabel;
        }
        if (it.tab?.discarded) {
          li.classList.add('is-discarded');
          tag = `${tag} · ${trText('已休眠')}`;
        }
      } else if (it.kind === 'group') {
        ic = 'chevron';
        main = mark(it.group.title || trText('未命名组'), q);
        sub = trText('定位到该分组');
        tag = trText(it.count + ' 标签');
      } else if (it.kind === 'bookmark') {
        ic = 'info';
        main = mark(it.title, q);
        const addr = escapeHtml(standalone ? it.bookmark.url : domainOf(it.bookmark.url));
        sub = it.bookmark.folderPath ? `${escapeHtml(it.bookmark.folderPath)} · ${addr}` : addr;
        const leaf = it.bookmark.folderPath ? it.bookmark.folderPath.split(' / ').pop() : '';
        tag = leaf ? `${trText('书签')} · ${escapeHtml(leaf)}` : trText('书签');
      } else if (it.kind === 'history') {
        ic = 'info';
        main = mark(it.title, q);
        const addr = escapeHtml(standalone ? it.item.url : domainOf(it.item.url));
        sub = it.summary ? `${mark(it.summary, q)} · ${addr}` : addr;
        tag = trText('浏览历史');
      } else if (it.kind === 'google') {
        ic = 'search';
        main = escapeHtml(trText(`Google 搜索「${it.query}」`));
        sub = trText('按 Enter 在新标签页搜索网页');
        tag = 'Google';
      } else {
        ic = it.cmd.ic;
        main = mark(it.cmd.label, q);
        sub = escapeHtml(it.cmd.hint);
        tag = trText('命令');
      }
      const glyph = it.kind === 'bookmark'
        ? BOOKMARK_TYPE_ICO
        : standalone && (it.kind === 'tab' || it.kind === 'history')
          ? `<img class="palette-favicon" src="${chrome.runtime.getURL('_favicon/')}?pageUrl=${encodeURIComponent(it.kind === 'tab' ? it.tab.url : it.item.url)}&size=32" alt="">`
          : icon(ic, 14);
      li.innerHTML = `<span class="palette-ico">${glyph}</span><span class="palette-main"><span class="palette-title">${main}</span><span class="palette-sub">${sub}</span></span><span class="palette-tag">${tag}</span>`;
      const copyUrl = itemUrl(it);
      let copyBtn = null;
      if (copyUrl && typeof li.appendChild === 'function') {
        copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'palette-copy';
        copyBtn.tabIndex = -1;
        copyBtn.setAttribute('aria-label', `${trText('复制链接')} ${copyUrl}`);
        copyBtn.title = `${trText('复制链接')} (⌘/Ctrl+C)`;
        copyBtn.innerHTML = `${icon('copy', 12)}<span>${escapeHtml(trText('复制链接'))}</span>`;
        copyBtn.addEventListener('click', e => {
          e.stopPropagation?.();
          e.preventDefault?.();
          selectionTouched = true;
          if (sel !== i) { sel = i; paintSel(); }
          copyItemUrl(it, copyBtn);
        });
        li.appendChild(copyBtn);
      }
      li.title = it.kind === 'url' ? (it.matchedTab ? `${it.title}\n${it.matchedTab.url}` : it.url) : it.kind === 'tab' ? `${it.title}\n${it.tab.url}` : it.kind === 'history' ? `${it.title}\n${it.item.url}` : it.kind === 'bookmark' ? `${it.title}\n${it.bookmark.url}` : '';
      li.querySelector('.palette-favicon')?.addEventListener('error', e => { e.currentTarget.hidden = true; });
      li.addEventListener('click', e => {
        if (e.defaultPrevented || (copyBtn && (e.target === copyBtn || e.target?.closest?.('.palette-copy')))) return;
        run(i);
      });
      li.addEventListener('mousemove', () => { selectionTouched = true; if (sel !== i) { sel = i; paintSel(); } });
      list.appendChild(li);
    });
    if (!view.length) {
      const li = document.createElement('li');
      li.className = 'palette-empty';
      li.textContent = authorizationFailed ? '无法验证搜索浮层，请关闭后使用快捷键重试' : loading ? '正在加载标签和分组…' : loadFailed ? '加载失败，请关闭后重新打开重试' : emptyPrefixHint || '没有匹配的结果';
      list.appendChild(li);
    }
    const baseStatus = authorizationFailed ? trText('搜索浮层未授权，请关闭后重试') : loading ? trText('正在加载…') : loadFailed ? trText('标签加载失败，请关闭后重试') : view.length ? trText(`${view.length} 项`) : emptyPrefixHint || trText('没有匹配的结果');
    countEl.textContent = [baseStatus, trText(`来源：${SOURCE_LABEL[provider]}`), isEn ? 'b Bookmarks · h History · g Google' : PREFIX_HINT].filter(Boolean).join(' · ');
    paintSel();
  }

  function paintSel() {
    if (open && view[sel]) input.setAttribute('aria-activedescendant', `palette-option-${sel}`);
    else input.removeAttribute('aria-activedescendant');
    list.querySelectorAll('.palette-row').forEach(r => {
      const on = Number(r.dataset.i) === sel;
      r.classList.toggle('sel', on);
      r.setAttribute('aria-selected', String(on));
      if (on) r.scrollIntoView({ block: 'nearest' });
    });
  }

  async function openDestination(it) {
    if (embedded && !sourceReady) return;
    const session = generation, operation = ++activationToken;
    const current = () => open && session === generation && operation === activationToken;
    activating = true;
    input.setAttribute('aria-busy', 'true');
    try {
      let tab = it.kind === 'tab' ? it.tab : it.kind === 'url' ? it.matchedTab : null;
      const key = itemKey(it);
      if (!tab && pendingDestination?.key === key) tab = pendingDestination.tab;
      if (!tab && it.kind === 'url') {
        if (!/^https?:\/\//.test(it.url || '')) throw new Error('无效的跳转地址');
        tab = (await chrome.tabs.query({})).find(candidate => !isOwnSearch(candidate.url) && (typeof urlsMatchForDirectJump === 'function' ? urlsMatchForDirectJump(candidate.url, it.url) : candidate.url === it.url));
        if (!current()) return;
      }
      if (!tab && it.kind === 'bookmark') {
        const targetUrl = String(it.bookmark?.url || '');
        if (!/^https?:/.test(targetUrl)) throw new Error('无效的书签地址');
        tab = (await chrome.tabs.query({})).find(candidate => !isOwnSearch(candidate.url) && candidate.url === targetUrl);
        if (!current()) return;
      }
      if (!tab && it.kind === 'history') {
        const targetUrl = String(it.item?.url || '');
        if (!/^https?:/.test(targetUrl)) throw new Error('无效的历史记录地址');
        tab = (await chrome.tabs.query({})).find(candidate => !isOwnSearch(candidate.url) && candidate.url === targetUrl);
        if (!current()) return;
      }
      let windowId;
      if (tab) {
        // Preserve native ordering: tab update -> owning window focus -> close(false).
        await chrome.tabs.update(tab.id, { active: true });
        if (!current()) return;
        windowId = tab.windowId;
      } else {
        if (standalone && !sourceReady) {
          toast(loading ? '正在加载来源窗口，请稍后重试' : '来源窗口不可用，请重新打开搜索重试', 'err');
          return;
        }
        if (!standalone && !Number.isInteger(currentWindowId)) await windowReady;
        windowId = standalone ? sourceWindowId : currentWindowId;
        if (!Number.isInteger(windowId)) throw new Error('无法确定来源窗口，请重试');
        const url = it.kind === 'url'
          ? (/^https?:\/\//.test(it.url || '') ? it.url : null)
          : it.kind === 'bookmark'
            ? (String(it.bookmark?.url || '').match(/^https?:\/\/.*/) ? it.bookmark.url : null)
            : it.kind === 'history'
              ? (String(it.item?.url || '').match(/^https?:\/\/.*/) ? it.item.url : null)
              : 'https://www.google.com/search?q=' + encodeURIComponent(it.query);
        if (!url) throw new Error('无效的跳转地址');
        const created = await chrome.tabs.create({ windowId, active: true, url });
        if (!current()) return;
        if (Number.isInteger(created?.id)) pendingDestination = { key, tab: { id: created.id, windowId } };
      }
      await chrome.windows.update(windowId, { focused: true });
      if (!current()) return;
      if (standalone) {
        const closed = await chrome.runtime.sendMessage(closeRequest(false));
        if (!current()) return;
        if (!closed?.ok) throw new Error(closed?.message || '无法关闭搜索窗口');
        finishClose(false);
      } else close(false);
      pendingDestination = null;
    } catch {
      if (current()) toast('打开失败，请重试；搜索窗口已保留', 'err');
    } finally {
      if (operation === activationToken) {
        activating = false;
        input.removeAttribute('aria-busy');
      }
    }
  }

  function run(i) {
    const it = view[i];
    if (!open || !it || activating || composing || (embedded && !sourceReady)) return;
    selectionTouched = true;
    if (it.kind === 'url' || it.kind === 'bookmark' || it.kind === 'history' || it.kind === 'google' || (standalone && it.kind === 'tab')) {
      openDestination(it);
      return;
    }
    close();
    try {
      let result;
      if (it.kind === 'tab') {
        result = Promise.all([
          chrome.tabs.update(it.tab.id, { active: true }),
          chrome.windows.update(it.tab.windowId, { focused: true }),
        ]);
      } else if (it.kind === 'group') result = focusGroup(it.group);
      else result = it.cmd.run();
      Promise.resolve(result).catch(() => toast('操作失败，请重试', 'err'));
    } catch { toast('操作失败，请重试', 'err'); }
  }

  function refresh(preserve = false) {
    if (!open) return;
    const selected = preserve ? itemKey(view[sel]) : '';
    view = buildItems(searchQuery());
    const index = selected ? view.findIndex(item => itemKey(item) === selected) : -1;
    sel = index >= 0 ? index : 0;
    render();
  }

  async function openPalette(force = false, detail = {}) {
    if (disposed || (open && !force)) return;
    const drawer = surface === 'home' ? document.getElementById('settingsDrawer') : null;
    if (drawer?.matches(':popover-open')) drawer.hidePopover();
    const token = ++generation;
    sourceWindowId = currentTabId = null;
    sourceReady = false;
    authorizationFailed = false;
    pendingFocusToken = 0;
    pendingFocusTabId = null;
    ++activationToken;
    activating = false;
    input.removeAttribute('aria-busy');
    cancelBookmarkSearch();
    cancelHistorySearch();
    remoteBookmarks = [];
    bookmarkQuery = '';
    remoteHistory = [];
    historyQuery = '';
    if (!open) previousFocus = document.activeElement;
    open = true;
    baseProvider = ['all', 'tabs', 'bookmarks', 'history', 'google'].includes(detail.provider) ? detail.provider : 'all';
    browserWideTabs = standalone || detail.pageSearch === true;
    pendingDestination = null;
    composing = false;
    selectionTouched = false;
    loading = true;
    loadFailed = false;
    data = { tabs: [], groups: [], tabMeta: {}, history: [], bookmarks: [] };
    el.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    list.setAttribute('aria-busy', 'true');
    input.value = typeof detail.query === 'string' ? detail.query : '';
    scheduleBookmarks();
    scheduleHistory();
    refresh();
    focusInput();
    globalThis.requestAnimationFrame?.(() => {
      if (open && token === generation && !disposed && document.activeElement !== input) focusInput();
    });
    try {
      if (embedded) {
        // search.html is web-accessible: its URL alone grants no access to tabs or bookmarks.
        if (!embeddedNonce || embeddedNonce.length > 256) throw new Error('Missing frame authorization');
        const state = await chrome.runtime.sendMessage(embeddedRequest('page-search-state'));
        if (!open || token !== generation || disposed) return;
        if (!state?.ok || !Number.isInteger(state.sourceWindowId) || !Number.isInteger(state.currentTabId)) throw new Error('Frame not authorized');
        sourceWindowId = state.sourceWindowId;
        currentTabId = state.currentTabId;
        sourceReady = true;
        if (pendingFocusToken === token && pendingFocusTabId === currentTabId) {
          pendingFocusToken = 0;
          pendingFocusTabId = null;
          focusInput();
        }
        scheduleBookmarks();
        scheduleHistory();
      }
      const loaded = await loadData();
      if (!open || token !== generation) return;
      data = { tabs: loaded.tabs, groups: loaded.groups, tabMeta: loaded.tabMeta || {}, history: loaded.history || [], bookmarks: loaded.bookmarks || [] };
      if (!embedded && loaded.state?.ok && Number.isInteger(loaded.state.sourceWindowId)) {
        sourceWindowId = loaded.state.sourceWindowId;
        currentTabId = loaded.state.currentTabId;
        sourceReady = true;
      }
    } catch {
      if (!open || token !== generation) return;
      loadFailed = true;
      if (embedded && !sourceReady) {
        authorizationFailed = true;
        data = { tabs: [], groups: [], tabMeta: {}, history: [], bookmarks: [] };
        cancelBookmarkSearch();
        cancelHistorySearch();
      }
    }
    if (!open || token !== generation) return;
    loading = false;
    list.setAttribute('aria-busy', 'false');
    refresh(selectionTouched);
    // Never focus after an await: the user may have closed or moved on.
  }
  function finishClose(restoreFocus) {
    open = false;
    ++generation;
    pendingFocusToken = 0;
    pendingFocusTabId = null;
    sourceWindowId = currentTabId = null;
    sourceReady = false;
    cancelBookmarkSearch();
    cancelHistorySearch();
    remoteBookmarks = [];
    remoteHistory = [];
    composing = false;
    el.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    list.setAttribute('aria-busy', 'false');
    const target = previousFocus;
    previousFocus = null;
    if (restoreFocus && target?.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function close(restoreFocus = true) {
    if (!open) return;
    if (standalone) {
      if (activating && !embedded) return;
      activating = true;
      const operation = ++activationToken;
      ++generation;
      sourceWindowId = currentTabId = null;
      sourceReady = false;
      cancelBookmarkSearch();
      cancelHistorySearch();
      chrome.runtime.sendMessage(closeRequest(restoreFocus))
        .then(result => {
          if (operation !== activationToken) return;
          if (result?.ok) finishClose(false);
          else toast(embedded ? '无法关闭搜索浮层，请重试' : '无法关闭搜索窗口，请使用窗口关闭按钮', 'err');
        })
        .catch(() => { if (operation === activationToken) toast(embedded ? '无法关闭搜索浮层，请重试' : '无法关闭搜索窗口，请使用窗口关闭按钮', 'err'); })
        .finally(() => { if (operation === activationToken) activating = false; });
      return;
    }
    finishClose(restoreFocus);
  }

  async function openMainSearch() {
    if (disposed || surface !== 'sidepanel') return;
    // Keep Chrome's persistent sidebar, but never leave its old inline search open.
    close(false);
    if (mainSearchPending) return;
    mainSearchPending = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'page-search-open' });
      if (!disposed && !result?.ok) toast('无法在主标签页打开搜索，请切换到目标标签页后再次按 ⌘/Ctrl+K 重试', 'err');
    } catch {
      if (!disposed) toast('无法在主标签页打开搜索，请切换到目标标签页后再次按 ⌘/Ctrl+K 重试', 'err');
    } finally { mainSearchPending = false; }
  }

  async function consumeSideSearch() {
    if (disposed || surface !== 'sidepanel' || !Number.isInteger(currentWindowId)) return;
    if (sideSearchBusy) { sideSearchQueued = true; return; }
    sideSearchBusy = true;
    const session = generation;
    try {
      const state = await chrome.runtime.sendMessage({ type: 'page-search-sidepanel-state', windowId: currentWindowId });
      if (disposed || session !== generation) return;
      const pending = state?.ok && state.pending;
      if (!pending || pending.windowId !== currentWindowId || pending.sourceWindowId !== currentWindowId ||
          !Number.isInteger(pending.currentTabId) || !['string', 'number'].includes(typeof pending.id)) return;
      // Acknowledge this exact request, not a newer command that arrived during the read.
      const ack = await chrome.runtime.sendMessage({ type: 'page-search-sidepanel-state', windowId: currentWindowId, ack: true, pendingId: pending.id });
      if (!disposed && session === generation && ack?.ok && ack.pending?.id === pending.id) openPalette(true, { ...pending, pageSearch: true });
    } catch { /* The sidepanel remains usable even if a pending command expired. */ }
    finally {
      sideSearchBusy = false;
      if (sideSearchQueued) { sideSearchQueued = false; consumeSideSearch(); }
    }
  }

  input.addEventListener('input', () => { selectionTouched = false; scheduleBookmarks(); scheduleHistory(); refresh(); });
  input.addEventListener('compositionstart', () => { composing = true; cancelBookmarkSearch(); cancelHistorySearch(); refresh(true); });
  input.addEventListener('compositionend', () => { composing = false; scheduleBookmarks(); scheduleHistory(); refresh(); });
  input.addEventListener('keydown', e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); selectionTouched = true; sel = (sel + 1) % Math.max(view.length, 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selectionTouched = true; sel = (sel - 1 + Math.max(view.length, 1)) % Math.max(view.length, 1); paintSel(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) run(sel); }
  });
  el.addEventListener('mousedown', e => {
    if (e.target === el) { e.preventDefault(); close(); }
  });
  document.addEventListener('focusin', e => {
    if (open && !el.contains(e.target)) focusInput();
  });
  globalThis.addEventListener?.('focus', () => {
    if (open && !disposed) focusInput();
  });
  document.addEventListener('visibilitychange', () => {
    if (open && !disposed && !document.hidden) focusInput();
  });
  document.addEventListener('tt-open-palette', event => openPalette(!!event.detail, event.detail || {}));
  document.addEventListener('tt-lang-change', () => { if (open) refresh(true); });
  if (surface === 'sidepanel') document.addEventListener('tt-open-main-search', openMainSearch);
  chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
    if (disposed || !trustedRuntimeSender(sender)) return;
    if (embedded) {
      if (message?.type === 'page-search-focus' && open && message.nonce === embeddedNonce) {
        if (sourceReady && message.targetTabId === currentTabId) focusInput();
        else if (!sourceReady && !authorizationFailed && Number.isInteger(message.targetTabId)) {
          pendingFocusToken = generation;
          pendingFocusTabId = message.targetTabId;
        }
      }
      return;
    }
    if (standalone) {
      if (message?.type === 'browser-search-focus' && message.windowId === currentWindowId) openPalette(true);
      return;
    }
    if (surface === 'sidepanel' && message?.type === 'page-search-sidepanel' && message.windowId === currentWindowId) consumeSideSearch();
    if (message?.type === 'page-search-local' && (surface === 'home' || surface === 'sidepanel')) {
      if (typeof sender?.id !== 'string' || sender.id !== chrome.runtime.id ||
          !Number.isInteger(message.windowId) || !Number.isInteger(message.targetTabId)) return;
      // These cached identity promises never wait on a background search lock.
      Promise.all([windowReady, localTabReady]).then(() => {
        // Native sidebars have no tab identity and must not steal the main tab's ACK.
        if (disposed || message.windowId !== currentWindowId || !Number.isInteger(localTabId) || message.targetTabId !== localTabId) return;
        if (open) { browserWideTabs = true; refresh(true); input.focus(); }
        else openPalette(false, { pageSearch: true });
        sendResponse?.({ ok: true, claimed: true, windowId: currentWindowId, targetTabId: localTabId,
          ...(message.requestId !== undefined ? { requestId: message.requestId } : {}) });
      });
      // Unmatched extension documents stay silent; only the matching tab responds.
      return true;
    }
  });
  if (standalone) openPalette();
  // Never accept parent postMessage. A detached/navigating frame cannot resume late work.
  globalThis.addEventListener?.('pagehide', () => {
    disposed = true;
    ++activationToken;
    finishClose(false);
    data = { tabs: [], groups: [], tabMeta: {}, history: [], bookmarks: [] };
    remoteBookmarks = [];
    pendingDestination = null;
  });
  document.addEventListener('keydown', e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'c' && open && view[sel] && itemUrl(view[sel])) {
      const hasInputSelection = typeof input.selectionStart === 'number'
        && typeof input.selectionEnd === 'number'
        && input.selectionStart !== input.selectionEnd;
      if (e.shiftKey || !hasInputSelection) {
        e.preventDefault();
        copyItemUrl(view[sel]);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (surface === 'sidepanel') { if (!e.repeat) openMainSearch(); }
      else open ? close() : openPalette();
    } else if (open && e.key === 'Tab') {
      // The combobox is the dialog's sole tab stop; rows use active-descendant.
      e.preventDefault();
      input.focus();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  });
})();
