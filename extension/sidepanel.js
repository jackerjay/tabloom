/* AI 侧边栏：实时分组视图 + 模型选择 + 搜索 + 折叠控制 + 自动整理开关 */
const $ = id => document.getElementById(id);
let windowId = null;
let refreshTimer = null;
let lastData = { tabs: [], groups: [], activeId: null };
let searchTerm = '';
let panelWindowRequest = null;
let refreshRevision = 0;
let activeContext = { tabId: null, groupId: -1, mode: 'none' };
let lastFollowTabId = null;
let lastFollowGroupId = -1;
let followExpandedGroupId = null;
let lastScrolledTabId = null;
let lastPaintedSpMode = null;
let pendingFollowScroll = false;
let followScrollRaf = null;
const selectedGroupIds = new Set();
const ARCHIVE_LIST_LIMIT = 10;
let archives = [];
let archivePending = false;
let restoringArchiveId = null;
let archiveListRevision = 0;
let cleanupRevision = 0;

const isNativeGroup = group => Number.isInteger(group?.id) && group.id >= 0;
let tablistDeckOpen = false;
let lastRenderedOnHome = null;
let autoDelayCtrl = null;
let autoDiscardCtrl = null;
let tabMeta = {};
let lockedGroupIds = new Set();
let manualNamedGroups = new Map();

function isShellTab(tab) {
  const url = tab?.url || '';
  const cleanUrl = url.split(/[?#]/)[0];
  const ownHome = chrome.runtime.getURL('home.html');
  const ownPanel = chrome.runtime.getURL('sidepanel.html');
  return url === 'about:blank' || /^chrome(?:-search)?:\/\/(?:newtab|new-tab-page|local-ntp)(?:[/?#]|$)/.test(url) ||
    cleanUrl === ownHome || cleanUrl === ownPanel;
}

// Resolve the hosting window once. Another window gaining focus must not retarget this sidebar.
async function panelWindowId() {
  if (!panelWindowRequest) panelWindowRequest = chrome.windows.getCurrent().then(win => win.id).catch(error => {
    panelWindowRequest = null;
    throw error;
  });
  return panelWindowRequest;
}

function displayContext(context, tabs, actualId) {
  const actual = tabs.find(tab => tab.id === actualId);
  // Chrome's window-scoped active query wins over a delayed/recent BG context.
  if (actual && !isShellTab(actual)) return { tabId: actual.id, groupId: actual.groupId, mode: 'active' };
  const candidate = tabs.find(tab => tab.id === context?.tabId);
  if (context?.ok && context.windowId === windowId && candidate && !isShellTab(candidate) &&
      (context.mode === 'active' || context.mode === 'recent')) {
    // Never call a recent tab actually active, even if an older RPC response says so.
    return { tabId: candidate.id, groupId: candidate.groupId, mode: candidate.id === actualId ? 'active' : 'recent' };
  }
  // Only fall back to a real tab observed by this UI, never an AI/model context.
  const previous = tabs.find(tab => tab.id === activeContext.tabId);
  if (!context?.ok && previous && !isShellTab(previous)) return { tabId: previous.id, groupId: previous.groupId, mode: 'recent' };
  return { tabId: null, groupId: -1, mode: 'none' };
}

function faviconUrl(url) {
  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url || '')}&size=32`;
}

function matches(t) {
  if (!searchTerm) return true;
  const displayTitle = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(t, tabMeta) : cleanTitle(t.title, t.url);
  const summary = typeof resolveTabSummary === 'function' ? resolveTabSummary(t, tabMeta) : '';
  const groupTitle = lastData.groups.find(g => g.id === t.groupId)?.title || '';
  if (typeof fuzzyMatchScore === 'function') {
    return fuzzyMatchScore(searchTerm, displayTitle, t.title, summary, t.url, groupTitle) > 0;
  }
  const s = searchTerm.toLowerCase();
  return displayTitle.toLowerCase().includes(s) || (t.title || '').toLowerCase().includes(s)
    || summary.toLowerCase().includes(s) || (t.url || '').toLowerCase().includes(s) || groupTitle.toLowerCase().includes(s);
}

function renderGroup(title, color, tabs, group, idx, activeId) {
  const box = document.createElement('section');
  box.className = 'sp-group';
  box.style.setProperty('--i', idx);
  box.dataset.groupId = String(group?.id ?? `u-${windowId}`);
  const native = isNativeGroup(group);
  const isLocked = native && lockedGroupIds.has(group.id);
  const isManualNamed = native && manualNamedGroups.has(group.id);
  const expanded = !group?.collapsed || followExpandedGroupId === group?.id;
  box.classList.toggle('active-group', native && group.id === activeContext.groupId);
  box.classList.toggle('is-selected', native && selectedGroupIds.has(group.id));
  box.classList.toggle('is-locked', isLocked);
  box.classList.toggle('is-manual-named', isManualNamed);
  const top = document.createElement('div');
  top.className = 'sp-group-top';
  if (native) {
    const label = document.createElement('label');
    label.className = 'sp-group-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedGroupIds.has(group.id);
    checkbox.disabled = archivePending;
    checkbox.setAttribute('aria-label', `选择分组 ${title || '未命名组'}`);
    checkbox.onchange = () => {
      if (archivePending) return;
      if (checkbox.checked) selectedGroupIds.add(group.id);
      else selectedGroupIds.delete(group.id);
      box.classList.toggle('is-selected', checkbox.checked);
      updateArchiveControls();
    };
    label.append(checkbox);
    top.append(label);
  }
  const head = document.createElement('div');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.className = 'sp-group-head';
  const hex = COLOR_HEX[color] || COLOR_HEX.grey;
  head.style.background = tint(hex, .12);
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = hex;
  const name = document.createElement('span');
  name.className = 'gname';
  name.textContent = title || '未命名组';
  const triggerRename = () => {
    if (!native || typeof startInlineGroupRename !== 'function') return;
    startInlineGroupRename({
      nameEl: name,
      currentTitle: title || '',
      onSave: async nextTitle => {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'group-rename', groupId: group.id, title: nextTitle });
          if (!res?.ok) throw new Error(res?.message || '重命名失败');
          manualNamedGroups.set(group.id, res.title);
          toast(`已固定分组名称为「${res.title}」`, 'ok');
          refresh();
        } catch (err) {
          toast(err?.message || '重命名失败', 'err');
        }
      },
    });
  };
  const count = document.createElement('span');
  count.className = 'gcount';
  count.textContent = tabs.length;
  const chev = document.createElement('span');
  chev.className = 'chev' + (expanded ? '' : ' collapsed');
  chev.innerHTML = icon('chevron', 12);
  head.append(chev, dot, name);
  if (native) {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'group-rename-btn';
    renameBtn.innerHTML = icon('edit', 11);
    renameBtn.title = isManualNamed ? '已手动固定分组名称，AI 不再自动改名；点击修改' : '重命名分组并固定名称';
    renameBtn.setAttribute('aria-label', `重命名分组 ${title || '未命名组'}`);
    renameBtn.onclick = e => { e.stopPropagation(); triggerRename(); };
    head.append(renameBtn);
  }
  head.append(count);
  head.setAttribute('aria-expanded', String(expanded));
  head.setAttribute('aria-label', `${title || '未命名组'}，${tabs.length} 个标签`);

  const ul = document.createElement('ul');
  ul.className = 'sp-tabs';
  if (!expanded) ul.style.display = 'none';
  head.onclick = async () => {
    const hidden = ul.style.display === 'none';
    ul.style.display = hidden ? '' : 'none';
    chev.classList.toggle('collapsed', !hidden);
    head.setAttribute('aria-expanded', String(hidden));
    if (!native) return;
    followExpandedGroupId = null;
    // Explicit user collapse remains native; automatic following is UI-only.
    try { await chrome.tabGroups.update(group.id, { collapsed: !hidden }); }
    catch { scheduleRefresh(); }
  };
  head.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      head.click();
    }
  };

  for (const t of tabs) {
    const li = document.createElement('li');
    li.dataset.tabId = String(t.id);
    if (t.discarded) li.classList.add('is-discarded');
    if (t.id === activeId && activeContext.mode === 'active') {
      li.classList.add('active');
      li.setAttribute('aria-current', 'page');
    } else if (t.id === activeId && activeContext.mode === 'recent') {
      li.classList.add('recent');
    }
    const img = document.createElement('img');
    img.src = faviconUrl(t.url);
    img.alt = '';
    img.onerror = () => {
      img.onerror = null;
      if (typeof fallbackFaviconDataUrl === 'function') img.src = fallbackFaviconDataUrl(t.url);
      else img.style.visibility = 'hidden';
    };
    const displayTitle = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(t, tabMeta) : cleanTitle(t.title, t.url);
    const summary = typeof resolveTabSummary === 'function' ? resolveTabSummary(t, tabMeta) : '';
    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 't';
    titleBtn.textContent = displayTitle;
    titleBtn.title = summary ? `${t.title || t.url || ''}\n摘要：${summary}` : (t.title || t.url || '');
    const activate = () => {
      chrome.tabs.update(t.id, { active: true });
      chrome.windows.update(windowId, { focused: true });
    };
    titleBtn.onclick = e => { e.stopPropagation(); activate(); };
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.innerHTML = icon('close', 12);
    close.title = '关闭标签';
    close.setAttribute('aria-label', '关闭标签 ' + (t.title || t.url || ''));
    close.onclick = e => { e.stopPropagation(); chrome.tabs.remove(t.id); };
    li.onclick = activate;
    li.append(img, titleBtn);
    if (t.discarded) {
      const asleep = document.createElement('span');
      asleep.className = 'hibernated-badge';
      asleep.textContent = '已休眠';
      asleep.title = '该标签已休眠释放内存，点击切换时自动唤醒';
      li.append(asleep);
    }
    if (t.id === activeId && activeContext.mode === 'recent') {
      const recent = document.createElement('span');
      recent.className = 'sp-context-label';
      recent.textContent = '最近浏览';
      li.append(recent);
    }
    li.append(close);
    ul.appendChild(li);
  }
  top.append(head);
  if (native) {
    const actions = document.createElement('div');
    actions.className = 'sp-group-actions';
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'group-lock-btn' + (isLocked ? ' is-locked' : '');
    lockBtn.innerHTML = icon(isLocked ? 'lock' : 'unlock', 12);
    lockBtn.title = isLocked ? '已加锁保护（禁止自动清理/去重）；点击解锁' : '加锁保护分组（禁止自动清理该分组标签）';
    lockBtn.setAttribute('aria-label', isLocked ? `解锁分组 ${title || '未命名组'}` : `加锁保护分组 ${title || '未命名组'}`);
    lockBtn.setAttribute('aria-pressed', String(isLocked));
    lockBtn.onclick = async e => {
      e.stopPropagation();
      lockBtn.disabled = true;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'group-lock-set', groupId: group.id, locked: !isLocked });
        if (!res?.ok) throw new Error(res?.message || '操作失败');
        lockedGroupIds = new Set(res.lockedGroupIds || []);
        toast(res.locked ? `已加锁「${title || '未命名组'}」` : `已解锁「${title || '未命名组'}」`, 'ok');
        paint();
        refreshCleanupAdvice();
      } catch (err) {
        toast(err?.message || '操作失败', 'err');
        lockBtn.disabled = false;
      }
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'group-close-btn';
    closeBtn.innerHTML = icon('close', 12);
    closeBtn.title = '快速关闭或保存分组';
    closeBtn.setAttribute('aria-label', `快速关闭分组 ${title || '未命名组'}`);
    closeBtn.setAttribute('aria-haspopup', 'menu');
    closeBtn.setAttribute('aria-expanded', 'false');
    closeBtn.onclick = e => {
      e.stopPropagation();
      if (typeof openGroupCloseMenu !== 'function') return;
      openGroupCloseMenu({
        anchorEl: closeBtn,
        groupTitle: title,
        tabCount: tabs.length,
        locked: isLocked,
        manualNamed: isManualNamed,
        onRename: triggerRename,
        onToggleLock: () => lockBtn.click(),
        onSaveClose: async () => {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'group-archive-close', groupIds: [group.id], windowId });
            if (!res?.ok) throw new Error(res?.message || '关闭分组失败');
            selectedGroupIds.delete(group.id);
            toast(`已关闭分组「${title || '未命名组'}」（可在「已关闭分组」重开）`, 'ok');
            refresh();
            refreshArchives();
          } catch (err) {
            toast(err?.message || '关闭分组失败', 'err');
          }
        },
        onForceClose: async () => {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'group-force-close', groupId: group.id, windowId });
            if (!res?.ok) throw new Error(res?.message || '解散关闭失败');
            selectedGroupIds.delete(group.id);
            toast(`已解散分组「${title || '未命名组'}」并关闭全部标签页`, 'ok');
            refresh();
            refreshCleanupAdvice();
          } catch (err) {
            toast(err?.message || '解散关闭失败', 'err');
          }
        },
      });
    };
    actions.append(lockBtn, closeBtn);
    top.append(actions);
  }
  box.append(top, ul);
  return box;
}

function scrollActiveTabIntoView(tabId) {
  if (document.body?.dataset?.spMode === 'settings' || document.hidden || searchTerm || tabId == null) return false;
  const row = $('list')?.querySelector(`li[data-tab-id="${tabId}"]`);
  if (!row) return false;
  if (typeof row.getBoundingClientRect !== 'function') {
    row.scrollIntoView({ block: 'nearest' });
    return true;
  }
  const rect = row.getBoundingClientRect();
  if (rect.height <= 0) return false;
  const headBottom = document.querySelector('.side-head')?.getBoundingClientRect()?.bottom || 0;
  const minTop = headBottom + 8;
  const maxBottom = (window.innerHeight || document.documentElement?.clientHeight || 800) - 12;
  if (rect.top < minTop || rect.bottom > maxBottom) {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }
  return true;
}

function paint() {
  const { tabs, groups } = lastData;
  const activeId = activeContext.tabId;
  const followChanged = activeId !== lastFollowTabId;
  const groupChanged = lastFollowGroupId !== activeContext.groupId;
  if (followChanged || groupChanged) {
    lastFollowTabId = activeId;
    lastFollowGroupId = activeContext.groupId;
    followExpandedGroupId = activeContext.groupId >= 0 ? activeContext.groupId : null;
  }
  const spMode = document.body?.dataset?.spMode || 'tablist';
  const enteredTablist = lastPaintedSpMode === 'settings' && spMode === 'tablist';
  lastPaintedSpMode = spMode;
  if (activeId !== null && (followChanged || enteredTablist || activeId !== lastScrolledTabId)) {
    pendingFollowScroll = true;
  }
  const validGroupIds = new Set(groups.filter(isNativeGroup).map(group => group.id));
  for (const id of selectedGroupIds) if (!validGroupIds.has(id)) selectedGroupIds.delete(id);
  updateArchiveControls();
  const byGroup = new Map(groups.filter(isNativeGroup).map(g => [g.id, g]));
  const buckets = new Map();
  const ungrouped = [];
  for (const t of tabs) {
    if (t.groupId !== -1 && byGroup.has(t.groupId)) {
      if (!buckets.has(t.groupId)) buckets.set(t.groupId, []);
      buckets.get(t.groupId).push(t);
    } else {
      ungrouped.push(t);
    }
  }
  const list = $('list');
  list.innerHTML = '';
  let idx = 0, shown = 0;
  // Promote only in the view: never mutate the native array or move Chrome groups/tabs.
  const orderedGroups = [...groups].filter(isNativeGroup).sort((a, b) =>
    Number(b.id === activeContext.groupId) - Number(a.id === activeContext.groupId));
  for (const g of orderedGroups) {
    const filtered = (buckets.get(g.id) || []).filter(matches);
    if (!filtered.length) continue;
    list.appendChild(renderGroup(g.title, g.color, filtered, g, idx++, activeId));
    shown += filtered.length;
  }
  const filteredUngrouped = ungrouped.filter(matches);
  if (filteredUngrouped.length) {
    list.appendChild(renderGroup('未分组', 'grey', filteredUngrouped, null, idx++, activeId));
    shown += filteredUngrouped.length;
  }
  if (!shown) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = searchTerm ? '没有匹配的标签' : '当前窗口没有标签';
    list.appendChild(empty);
  }
  $('sp-status').textContent =
    `${tabs.length} 个标签、${groups.length} 个分组${searchTerm ? `、匹配 ${shown}` : ''}`;
  updateLastRun();
  if (pendingFollowScroll && activeId !== null && document.body?.dataset?.spMode !== 'settings' && !document.hidden && !searchTerm) {
    if (followScrollRaf !== null) globalThis.cancelAnimationFrame?.(followScrollRaf);
    const schedule = globalThis.requestAnimationFrame || (fn => { fn(); return null; });
    followScrollRaf = schedule(() => {
      followScrollRaf = null;
      if (activeContext.tabId !== activeId) return;
      if (scrollActiveTabIntoView(activeId)) {
        pendingFollowScroll = false;
        lastScrolledTabId = activeId;
      }
    });
  }
}

async function updateLastRun() {
  const { lastRun } = await chrome.storage.session.get('lastRun');
  if (lastRun?.applied) {
    const time = new Date(lastRun.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    $('sp-status').textContent += `、上次整理 ${time}（${lastRun.source === 'ai' ? 'AI' : '规则'}）`;
  }
}

async function refresh() {
  const revision = ++refreshRevision;
  try {
    const hostWindowId = await panelWindowId();
    if (revision !== refreshRevision) return;
    windowId = hostWindowId;
    const [tabs, groups, active, context, localMeta] = await Promise.all([
      chrome.tabs.query({ windowId: hostWindowId }),
      chrome.tabGroups.query({ windowId: hostWindowId }),
      chrome.tabs.query({ windowId: hostWindowId, active: true }),
      chrome.runtime.sendMessage({ type: 'active-work-tab', windowId: hostWindowId }).catch(() => null),
      chrome.storage?.local?.get?.(['tabMetaCache', 'lockedGroupIds', 'manualNamedGroups'])?.catch?.(() => ({})) || Promise.resolve({}),
    ]);
    if (revision !== refreshRevision) return;
    tabMeta = (localMeta?.tabMetaCache && typeof localMeta.tabMetaCache === 'object') ? localMeta.tabMetaCache : {};
    lockedGroupIds = new Set(Array.isArray(localMeta?.lockedGroupIds) ? localMeta.lockedGroupIds.filter(id => Number.isInteger(id) && id >= 0) : []);
    manualNamedGroups = new Map(
      Object.entries(localMeta?.manualNamedGroups && typeof localMeta.manualNamedGroups === 'object' ? localMeta.manualNamedGroups : {})
        .map(([k, v]) => [Number(k), String(v || '').trim()])
        .filter(([id, v]) => Number.isInteger(id) && id >= 0 && v),
    );
    const ownTabs = tabs.filter(tab => tab.windowId === hostWindowId);
    const actualTab = active.find(tab => tab.windowId === hostWindowId) || null;
    const actualId = actualTab?.id ?? null;
    const onHome = isShellTab(actualTab);
    if (document.body?.dataset) {
      document.body.dataset.spMode = onHome ? 'settings' : 'tablist';
    }
    if ($('spModeChip')) {
      $('spModeChip').textContent = onHome ? '设置模式 · 唯一设置归宿' : '标签列表 · Tab List';
    }
    if ($('spModeReason')) {
      $('spModeReason').textContent = onHome
        ? '当前在主页，侧边栏展示完整设置；切到普通网页时自动变为 Tab List'
        : '当前在普通网页，侧边栏切回标签列表（Tab List）';
    }
    if (onHome) {
      setDeck(true, false);
    } else if (lastRenderedOnHome !== false) {
      setDeck(tablistDeckOpen, false);
    }
    lastRenderedOnHome = onHome;
    activeContext = displayContext(context, ownTabs, actualId);
    lastData = { tabs: ownTabs, groups: groups.filter(group => isNativeGroup(group) && group.windowId === hostWindowId), activeId: actualId };
    paint();
    updateDupUI();
  } catch (error) {
    if (revision === refreshRevision) toast(`读取标签失败：${error.message}，请重试`, 'err');
  }
}

/* ---------------- 真实分组：保存、关闭与恢复 ---------------- */
function toolStatus(id, message, error = false) {
  $(id).textContent = message;
  $(id).classList.toggle('is-error', error);
}

function updateArchiveControls() {
  $('archiveClose').disabled = archivePending || selectedGroupIds.size === 0;
  $('archiveClose').textContent = archivePending && !restoringArchiveId ? '保存并关闭中…' : `保存并关闭 ${selectedGroupIds.size} 组`;
  $('clearGroupSelection').disabled = archivePending || selectedGroupIds.size === 0;
  for (const input of $('list').querySelectorAll('input')) input.disabled = archivePending;
  for (const button of $('archiveList').querySelectorAll('.sp-restore')) {
    button.disabled = archivePending;
    button.textContent = restoringArchiveId === button.dataset.archiveId ? '恢复中…' :
      button.dataset.restoring === 'true' ? '重试恢复' : '恢复';
  }
}

function paintArchives() {
  const list = $('archiveList');
  list.replaceChildren();
  $('archiveCount').textContent = `${archives.length} 条记录`;
  for (const archive of archives.slice(0, ARCHIVE_LIST_LIMIT)) {
    const row = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'sp-archive-info';
    const title = document.createElement('span');
    title.className = 'sp-archive-title';
    const names = (Array.isArray(archive.groups) ? archive.groups : []).slice(0, 3).map(group => group.title || '未命名组');
    title.textContent = names.length ? names.join('、').slice(0, 160) : '已保存分组';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const date = new Date(archive.at);
    const at = Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '保存时间未知';
    meta.textContent = `${at} · ${archive.groupCount ?? 0} 组 · ${archive.tabCount ?? 0} 个标签${archive.restoring ? ' · 恢复未完成，可重试' : ''}`;
    info.append(title, meta);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'ghost sp-restore';
    restore.dataset.archiveId = archive.id;
    restore.dataset.restoring = String(!!archive.restoring);
    restore.setAttribute('aria-label', `恢复分组 ${title.textContent}`);
    restore.onclick = () => restoreArchive(archive.id);
    row.append(info, restore);
    list.append(row);
  }
  updateArchiveControls();
}

async function refreshArchives() {
  const revision = ++archiveListRevision;
  $('refreshArchives').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'group-archive-list' });
    if (revision !== archiveListRevision) return;
    if (!response?.ok || !Array.isArray(response.archives)) throw new Error(response?.message || '读取保存记录失败');
    archives = [...response.archives].filter(archive => typeof archive?.id === 'string' && archive.id)
      .sort((a, b) => (Number(new Date(b.at)) || 0) - (Number(new Date(a.at)) || 0));
    paintArchives();
    toolStatus('archiveListStatus', !archives.length ? '还没有记录。勾选真实 Chrome 分组，保存后可在这里恢复。' :
      archives.length > ARCHIVE_LIST_LIMIT ? `仅显示最近 ${ARCHIVE_LIST_LIMIT} 条记录。` : '');
  } catch (error) {
    if (revision === archiveListRevision) {
      $('archiveCount').textContent = archives.length ? `${archives.length} 条记录` : '读取失败';
      toolStatus('archiveListStatus', `${error.message}；请刷新记录重试。`, true);
    }
  } finally {
    if (revision === archiveListRevision) $('refreshArchives').disabled = false;
  }
}

$('archiveClose').onclick = async () => {
  if (archivePending) return;
  const validIds = new Set(lastData.groups.filter(isNativeGroup).map(group => group.id));
  for (const id of selectedGroupIds) if (!validIds.has(id)) selectedGroupIds.delete(id);
  const groupIds = [...selectedGroupIds];
  updateArchiveControls();
  if (!groupIds.length || !confirm(`保存并关闭 ${groupIds.length} 个 Chrome 分组？\n\n保存链接与分组，不保存未提交内容。请先保存正在编辑的内容。`)) return;
  archivePending = true;
  updateArchiveControls();
  toolStatus('archiveStatus', '正在本机保存分组，保存成功后关闭…');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'group-archive-close', groupIds, windowId });
    if (!response?.ok) throw new Error(response?.message || '保存并关闭失败');
    if (!response.partial) for (const id of groupIds) selectedGroupIds.delete(id);
    toolStatus('archiveStatus', response.partial ? (response.message || '分组已保存，但部分标签未关闭；请检查后重试。') :
      `已保存并关闭 ${response.closedGroups ?? 0} 组、${response.closedTabs ?? 0} 个标签。`, !!response.partial);
    await Promise.all([refresh(), refreshArchives()]);
  } catch (error) {
    toolStatus('archiveStatus', `${error.message}；选择已保留，可重试。`, true);
  } finally {
    archivePending = false;
    updateArchiveControls();
  }
};

async function restoreArchive(id) {
  if (archivePending) return;
  archivePending = true;
  restoringArchiveId = id;
  updateArchiveControls();
  toolStatus('archiveListStatus', '正在恢复链接与分组…');
  try {
    const targetWindowId = await panelWindowId();
    const response = await chrome.runtime.sendMessage({ type: 'group-archive-restore', id, targetWindowId });
    if (!response?.ok) throw new Error(response?.message || '恢复失败');
    await Promise.all([refresh(), refreshArchives()]);
    toolStatus('archiveListStatus', response.partial ? (response.message || '部分标签未恢复，记录已保留，可重试。') :
      `已恢复 ${response.restoredGroups ?? 0} 组、${response.restoredTabs ?? 0} 个标签。`, !!response.partial);
  } catch (error) {
    toolStatus('archiveListStatus', `${error.message}；记录已保留，可重试恢复。`, true);
  } finally {
    archivePending = false;
    restoringArchiveId = null;
    updateArchiveControls();
  }
}

$('clearGroupSelection').onclick = () => {
  if (archivePending) return;
  selectedGroupIds.clear();
  paint();
};
$('refreshArchives').onclick = refreshArchives;

/* ---------------- 生命周期：只建议，不关闭，不调用模型 ---------------- */
async function refreshCleanupAdvice() {
  const revision = ++cleanupRevision;
  $('refreshCleanup').disabled = true;
  try {
    const hostWindowId = await panelWindowId();
    const response = await chrome.runtime.sendMessage({ type: 'cleanup-advice', windowId: hostWindowId });
    if (revision !== cleanupRevision) return;
    if (!response?.ok || response.basis !== 'lastAccessed' || !Array.isArray(response.candidates)) {
      throw new Error(response?.message || '读取清理建议失败');
    }
    const candidates = response.candidates;
    const count = Number.isInteger(response.eligibleCount) ? response.eligibleCount : candidates.length;
    $('cleanupCount').textContent = `${count} 个标签`;
    if ($('cleanupCloseAllBtn')) $('cleanupCloseAllBtn').disabled = !count;
    $('cleanupList').replaceChildren();
    for (const candidate of candidates.slice(0, 10)) {
      const row = document.createElement('li');
      const title = document.createElement('span');
      title.className = 'sp-cleanup-title';
      title.textContent = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(candidate, tabMeta) : cleanTitle(candidate.title, candidate.url);
      const days = document.createElement('span');
      days.className = 'sp-idle-days';
      days.textContent = `${candidate.idleDays} 天未访问`;
      row.append(title, days);
      $('cleanupList').append(row);
    }
    const note = count ? `最近 ${response.thresholdDays} 天未访问${count > 10 ? '；仅显示最久未访问的 10 个' : ''}。` : `没有可建议清理的 ${response.thresholdDays} 天未访问标签。`;
    toolStatus('cleanupStatus', `${note} ${response.unknownCount ?? 0} 个标签访问时间未知，不推断未访问时长。`);
  } catch (error) {
    if (revision === cleanupRevision) {
      $('cleanupCount').textContent = '读取失败';
      toolStatus('cleanupStatus', `${error.message}；请刷新建议重试。`, true);
    }
  } finally {
    if (revision === cleanupRevision) $('refreshCleanup').disabled = false;
  }
}
$('refreshCleanup').onclick = refreshCleanupAdvice;

async function spFreeMemory(triggerBtn) {
  const orig = triggerBtn?.textContent;
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '释放中…'; }
  try {
    const hostWindowId = await panelWindowId();
    const res = await chrome.runtime.sendMessage({ type: 'discard-tabs', windowId: hostWindowId });
    if (!res?.ok) throw new Error(res?.message || '释放内存失败');
    toast(res.discarded ? `已休眠 ${res.discarded} 个标签以释放内存` : '当前没有可休眠的后台标签', res.discarded ? 'ok' : 'info');
    refresh();
    refreshCleanupAdvice();
  } catch (err) {
    toast(`释放内存失败：${err.message}`, 'err');
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; if (orig) triggerBtn.textContent = orig; }
  }
}
if ($('spFreeMemoryBtn')) $('spFreeMemoryBtn').onclick = () => spFreeMemory($('spFreeMemoryBtn'));
if ($('tlFreeMemoryBtn')) $('tlFreeMemoryBtn').onclick = () => spFreeMemory($('tlFreeMemoryBtn'));
if ($('cleanupCloseAllBtn')) {
  $('cleanupCloseAllBtn').onclick = async () => {
    const btn = $('cleanupCloseAllBtn');
    btn.disabled = true;
    try {
      const hostWindowId = await panelWindowId();
      const res = await chrome.runtime.sendMessage({ type: 'cleanup-close', windowId: hostWindowId });
      if (!res?.ok) throw new Error(res?.message || '清理失败');
      toast(res.closed ? `已一键清理 ${res.closed} 个闲置标签` : '没有可清理的闲置标签', res.closed ? 'ok' : 'info');
      refresh();
      refreshCleanupAdvice();
    } catch (err) {
      toast(`清理失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  };
}
if ($('autoDiscardEnabled')) {
  $('autoDiscardEnabled').onchange = async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    const enabled = $('autoDiscardEnabled').checked;
    await chrome.storage.sync.set({ settings: { ...(settings || {}), autoDiscardEnabled: enabled } });
    toast(enabled ? '已开启空闲标签自动休眠模式' : '已关闭空闲标签自动休眠模式', 'ok');
  };
}

async function updateDupUI() {
  const [cnt, st] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'dup-count', windowId }),
    chrome.runtime.sendMessage({ type: 'dedup-state' }),
  ]);
  const badge = $('dupCount');
  badge.textContent = cnt?.count ?? 0;
  badge.classList.toggle('zero', !cnt?.count);
  $('dedup').disabled = !cnt?.count;
  $('dedupUndo').classList.toggle('hidden', !st?.undoCount);
  if ($('spWhitelistList') && Array.isArray(cnt?.whitelist)) {
    const wlEl = $('spWhitelistList');
    wlEl.innerHTML = '';
    for (const u of cnt.whitelist) {
      const chip = document.createElement('span');
      chip.className = 'wl-item';
      const txt = document.createElement('span');
      txt.textContent = domainOf(u) || u;
      txt.title = u;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.title = '移除白名单';
      rm.onclick = async () => {
        await chrome.runtime.sendMessage({ type: 'dup-whitelist-remove', url: u, host: u });
        toast(`已移除白名单：${u}`, 'info');
        updateDupUI();
      };
      chip.append(txt, rm);
      wlEl.append(chip);
    }
  }
}

$('dedup').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'dedup', windowId });
  if (!res?.ok) return toast(res?.message || '去重失败', 'err');
  toast(res.closed ? `已关闭 ${res.closed} 个重复标签` : '没有重复标签', res.closed ? 'ok' : 'info');
  refresh();
};

$('dedupUndo').onclick = async () => {
  const res = await chrome.runtime.sendMessage({ type: 'dedup-undo' });
  if (!res?.ok) return toast(res?.message || '恢复失败', 'err');
  toast(`已恢复 ${res.restored} 个标签`, 'ok');
  refresh();
};

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
}

for (const ev of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved']) {
  chrome.tabs[ev].addListener(scheduleRefresh);
}
chrome.tabs.onActivated.addListener(info => {
  if (windowId !== null && info.windowId !== windowId) return;
  // Invalidate in-flight snapshots immediately, before the debounced read starts.
  refreshRevision++;
  scheduleRefresh();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.status === 'complete' || info.groupId !== undefined || info.active) scheduleRefresh();
});
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) {
  chrome.tabGroups[ev].addListener(scheduleRefresh);
}
chrome.windows?.onFocusChanged?.addListener(focusedWindowId => {
  if (windowId !== null && focusedWindowId === windowId) scheduleRefresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleRefresh();
});

/* ---------------- 控制区 ---------------- */

$('regroup').onclick = async () => {
  const btn = $('regroup');
  btn.disabled = true;
  btn.textContent = 'AI 整理中…';
  $('analysisMeta').textContent = '读取页面并检查缓存，仅新内容交给 AI 分析…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'organize', apply: true });
    if (res?.ok) {
      const summary = analysisSummary(res);
      if (summary) $('analysisMeta').textContent = summary;
      toast(res.empty ? res.message : `整理完成：${res.groups?.length ?? 0} 组`, res.empty ? 'info' : 'ok');
      refreshCleanupAdvice();
    } else {
      $('analysisMeta').textContent = '本次整理未完成，请重试。';
      toast(`整理失败：${res?.message || '未知错误'}`, 'err');
    }
  } catch (err) {
    $('analysisMeta').textContent = '本次整理未完成，请重试。';
    toast(`整理失败：${err.message}`, 'err');
  }
  finally {
    btn.disabled = false;
    btn.textContent = '立即整理';
    refresh();
    refreshHealthPill($('health'));
  }
};

$('search').oninput = () => {
  searchTerm = $('search').value.trim();
  paint();
};

$('collapseAll').onclick = async () => {
  followExpandedGroupId = null;
  for (const g of lastData.groups) {
    try { await chrome.tabGroups.update(g.id, { collapsed: true }); } catch { /* 组可能已消失 */ }
  }
  refresh();
};

$('expandAll').onclick = async () => {
  followExpandedGroupId = null;
  for (const g of lastData.groups) {
    try { await chrome.tabGroups.update(g.id, { collapsed: false }); } catch { /* 组可能已消失 */ }
  }
  refresh();
};

$('autoOrganize').onchange = async () => {
  const { settings } = await chrome.storage.sync.get('settings');
  const next = { ...(settings || {}), autoOrganize: $('autoOrganize').checked };
  await chrome.storage.sync.set({ settings: next });
  toast(next.autoOrganize ? '自动整理已开启' : '自动整理已关闭');
};

if ($('autoDelay') && typeof initAutoDelayControl !== 'function') {
  $('autoDelay').onchange = async () => {
    const delay = normalizeAutoDelay($('autoDelay').value);
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...(settings || {}), autoOrganizeDelaySeconds: delay } });
    const label = typeof formatAutoDelayLabel === 'function' ? formatAutoDelayLabel(delay) : `${delay} 秒`;
    toast(`自动整理等待：${label}`, 'ok');
  };
}
if ($('interceptDuplicates')) {
  $('interceptDuplicates').onchange = async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    const next = { ...(settings || {}), interceptDuplicates: $('interceptDuplicates').checked };
    await chrome.storage.sync.set({ settings: next });
    toast(next.interceptDuplicates ? '新开重复标签实时拦截已开启' : '新开重复标签实时拦截已关闭', 'ok');
  };
}
if ($('spShowPagePill')) {
  $('spShowPagePill').onchange = async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    const next = { ...(settings || {}), showPageSearchPill: $('spShowPagePill').checked };
    await chrome.storage.sync.set({ settings: next });
    toast(next.showPageSearchPill ? '普通网页右侧悬浮搜索胶囊已开启' : '普通网页右侧悬浮搜索胶囊已隐藏', 'ok');
  };
}
if ($('spDensity')) {
  $('spDensity').onchange = async () => {
    const { settings } = await chrome.storage.sync.get('settings');
    const density = $('spDensity').checked ? 'compact' : 'comfortable';
    await chrome.storage.sync.set({ settings: { ...(settings || {}), density } });
    toast(density === 'compact' ? '已开启紧凑卡片密度' : '已切换为标准卡片密度', 'ok');
  };
}
if ($('spWhitelistAddBtn') && $('spWhitelistInput')) {
  $('spWhitelistAddBtn').onclick = async () => {
    const val = ($('spWhitelistInput').value || '').trim();
    if (!val) return toast('请输入域名或网址', 'info');
    const res = await chrome.runtime.sendMessage({ type: 'dup-whitelist-add', url: val, host: val });
    if (!res?.ok) return toast(res?.message || '添加失败', 'err');
    $('spWhitelistInput').value = '';
    toast(`已加入去重白名单：${val}`, 'ok');
    updateDupUI();
  };
}
async function refreshSidepanelBookmarkStatus() {
  if (!$('spBookmarkStatus')) return;
  try {
    if (!chrome.bookmarks?.getTree) { $('spBookmarkStatus').textContent = '本地书签与历史检索已就绪（b / h / g）'; return; }
    const tree = await chrome.bookmarks.getTree();
    let count = 0;
    const walk = nodes => { for (const n of nodes || []) { if (n.url) count++; if (n.children) walk(n.children); } };
    walk(tree);
    $('spBookmarkStatus').textContent = `已索引 ${count} 条本地书签，支持 b / h / g 前缀直搜`;
  } catch {
    $('spBookmarkStatus').textContent = '无法读取本地书签统计';
  }
}
if ($('spBookmarkCheckBtn') && $('spBookmarkStatus')) {
  $('spBookmarkCheckBtn').onclick = async () => {
    $('spBookmarkCheckBtn').disabled = true;
    $('spBookmarkCheckBtn').textContent = '统计中…';
    try { await refreshSidepanelBookmarkStatus(); }
    finally {
      $('spBookmarkCheckBtn').disabled = false;
      $('spBookmarkCheckBtn').textContent = '刷新统计';
    }
  };
  refreshSidepanelBookmarkStatus();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const next = changes.settings.newValue || {};
    $('autoOrganize').checked = !!next.autoOrganize;
    if (autoDelayCtrl) autoDelayCtrl.setValue(next.autoOrganizeDelaySeconds);
    else paintAutoDelay($('autoDelay'), next.autoOrganizeDelaySeconds);
    if ($('autoDiscardEnabled')) $('autoDiscardEnabled').checked = !!next.autoDiscardEnabled;
    if (autoDiscardCtrl) autoDiscardCtrl.setValue(next.autoDiscardMinutes);
    else if (typeof paintAutoDiscard === 'function' && $('autoDiscardMinutes')) paintAutoDiscard($('autoDiscardMinutes'), next.autoDiscardMinutes);
    if ($('interceptDuplicates')) $('interceptDuplicates').checked = next.interceptDuplicates !== false;
    if ($('spShowPagePill')) $('spShowPagePill').checked = next.showPageSearchPill !== false;
    if ($('spDensity')) $('spDensity').checked = next.density === 'compact';
    updateDupUI();
  }
  if (area === 'session' && changes.lastRun) {
    const summary = analysisSummary(changes.lastRun.newValue);
    if (summary) $('analysisMeta').textContent = `最近一次：${summary}`;
    refreshCleanupAdvice();
  }
  // The local value may contain private URLs. Always ask BG for metadata instead.
  if (area === 'local' && changes.tabMetaCache) {
    tabMeta = changes.tabMetaCache.newValue || {};
    paint();
  }
  if (area === 'local' && changes.lockedGroupIds) {
    const raw = changes.lockedGroupIds.newValue;
    lockedGroupIds = new Set(Array.isArray(raw) ? raw.filter(id => Number.isInteger(id) && id >= 0) : []);
    paint();
    refreshCleanupAdvice();
  }
  if (area === 'local' && changes.manualNamedGroups) {
    const raw = changes.manualNamedGroups.newValue || {};
    manualNamedGroups = new Map(
      Object.entries(raw)
        .map(([k, v]) => [Number(k), String(v || '').trim()])
        .filter(([id, v]) => Number.isInteger(id) && id >= 0 && v),
    );
    paint();
  }
  if (area === 'local' && changes.groupArchives) refreshArchives();
});

/* Command+K palette 定位分组：侧边栏与标签条同步，故展开走 chrome.tabGroups */
document.addEventListener('tt-focus-group', async e => {
  const id = String(e.detail?.groupId ?? '');
  if (!id || id.startsWith('u-')) return;
  const gid = Number(id);
  const g = lastData.groups.find(x => x.id === gid);
  if (!g) return; // palette 将未接管的跨窗口分组交给首页定位
  e.preventDefault();
  searchTerm = '';
  $('search').value = '';
  if (g?.collapsed) { try { await chrome.tabGroups.update(gid, { collapsed: false }); } catch { /* 组可能已消失 */ } }
  refresh();
  await new Promise(r => setTimeout(r, 250));
  const el = document.querySelector(`.sp-group[data-group-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1000);
});

$('openGlobalSearch').onclick = () => document.dispatchEvent(new CustomEvent('tt-open-main-search'));
$('searchShortcutSettings').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
async function refreshPanelSearchShortcut() {
  const diagnosis = await refreshSearchCommand($('searchShortcutStatus'), null, $('searchShortcutHint'));
  if (diagnosis?.state === 'ready') $('searchShortcutStatus').textContent = `搜索已绑定 ${diagnosis.shortcut}；全局范围请在 Chrome 设置中确认。`;
}
window.addEventListener('focus', refreshPanelSearchShortcut);

/* ---------------- 控制台折叠 ----------------
 * 矮面板默认收起控制台，把高度让给分组列表；整面板单滚动，任何组都滚得到。 */
const deckToggle = $('deckToggle');
deckToggle.querySelector('.chev').innerHTML = icon('chevron', 12);
function setDeck(open, persist = true) {
  $('deck').classList.toggle('hidden', !open);
  deckToggle.setAttribute('aria-expanded', String(open));
  if (persist) {
    tablistDeckOpen = open;
    chrome.storage.local.set({ spDeckOpen: open });
  }
}
deckToggle.onclick = () => setDeck($('deck').classList.contains('hidden'));

/* ---------------- 初始化 ---------------- */

(async function init() {
  const { settings } = await chrome.storage.sync.get('settings');
  $('autoOrganize').checked = !!settings?.autoOrganize;
  if ($('interceptDuplicates')) $('interceptDuplicates').checked = settings?.interceptDuplicates !== false;
  if ($('spShowPagePill')) $('spShowPagePill').checked = settings?.showPageSearchPill !== false;
  if ($('spDensity')) $('spDensity').checked = settings?.density === 'compact';
  if (typeof initAutoDelayControl === 'function') {
    autoDelayCtrl = initAutoDelayControl({
      selectEl: $('autoDelay'),
      customRowEl: $('autoDelayCustomRow'),
      valueInputEl: $('autoDelayCustomValue'),
      unitSelectEl: $('autoDelayCustomUnit'),
      applyBtnEl: $('autoDelayCustomApply'),
      cancelBtnEl: $('autoDelayCustomCancel'),
      initialValue: settings?.autoOrganizeDelaySeconds,
      onSave: async delay => {
        const { settings: cur } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(cur || {}), autoOrganizeDelaySeconds: delay } });
      },
    });
  } else {
    paintAutoDelay($('autoDelay'), settings?.autoOrganizeDelaySeconds);
  }
  if ($('autoDiscardEnabled')) $('autoDiscardEnabled').checked = !!settings?.autoDiscardEnabled;
  if ($('autoDiscardMinutes') && typeof initAutoDiscardControl === 'function') {
    autoDiscardCtrl = initAutoDiscardControl({
      selectEl: $('autoDiscardMinutes'),
      customRowEl: $('autoDiscardCustomRow'),
      valueInputEl: $('autoDiscardCustomValue'),
      unitSelectEl: $('autoDiscardCustomUnit'),
      applyBtnEl: $('autoDiscardCustomApply'),
      cancelBtnEl: $('autoDiscardCustomCancel'),
      initialValue: settings?.autoDiscardMinutes,
      onSave: async mins => {
        const { settings: cur } = await chrome.storage.sync.get('settings');
        await chrome.storage.sync.set({ settings: { ...(cur || {}), autoDiscardMinutes: mins } });
      },
    });
  }
  const { lastRun } = await chrome.storage.session.get('lastRun');
  const summary = analysisSummary(lastRun);
  if (summary) $('analysisMeta').textContent = `最近一次：${summary}`;
  const { spDeckOpen } = await chrome.storage.local.get('spDeckOpen');
  tablistDeckOpen = spDeckOpen === true;
  setDeck(tablistDeckOpen, false);
  refresh();
  refreshArchives();
  refreshCleanupAdvice();
  let updateCtrl = null;
  let modelCtrl = null;
  const wakeFromPill = async () => {
    setDeck(true, false);
    if (updateCtrl?.attemptWake) await updateCtrl.attemptWake();
  };
  refreshHealthPill($('health'), { onStartRequest: wakeFromPill });
  refreshPanelSearchShortcut();
  modelCtrl = await initModelSelect($('model'), {
    refreshBtn: $('refreshModels'),
    metaEl: $('model-meta'),
    pillEl: $('health'),
    cliContainerEl: $('cliCards'),
  });
  if (typeof initUpdateCard === 'function') {
    updateCtrl = await initUpdateCard({
      statusEl: $('updateStatus'),
      checkBtn: $('updateCheckBtn'),
      applyBtn: $('updateApplyBtn'),
      dotEl: $('svcDot'),
      titleEl: $('svcTitle'),
      actionsEl: $('svcActions'),
      startBtn: $('svcStartBtn'),
      setupBoxEl: $('svcSetupHint'),
      cmdEl: $('svcCmd'),
      copyCmdBtn: $('svcCopyCmdBtn'),
      retryBtn: $('svcRetryBtn'),
      pillEl: $('health'),
      onServiceOnline: () => modelCtrl?.reload?.(),
    });
  }
  window.addEventListener('focus', () => {
    if (updateCtrl?.isOffline?.()) {
      updateCtrl.reload().then(ok => {
        if (ok) refreshHealthPill($('health'), { onStartRequest: wakeFromPill });
      });
    }
  });
  document.addEventListener('tt-lang-change', () => {
    refresh();
    refreshCleanupAdvice();
    refreshArchives();
    refreshHealthPill($('health'), { onStartRequest: wakeFromPill });
  });
})();
