/* AI 标签工作台 — 新标签页首页
 * 聚合所有窗口的工作标签：实时分组视图 + 控制台 + 去重 + 自动整理
 */
const $ = id => document.getElementById(id);
const rpc = msg => chrome.runtime.sendMessage(msg);

/* Focus once on entry, never after a data refresh or a user interaction. */
function focusHomeSearchOnEntry() {
  if (new URLSearchParams(location.search).has('focusGroup')) return;
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const release = () => {
    document.removeEventListener('pointerdown', cancel, true);
    document.removeEventListener('keydown', cancel, true);
  };
  document.addEventListener('pointerdown', cancel, { capture: true, once: true });
  document.addEventListener('keydown', cancel, { capture: true, once: true });
  return Promise.all([chrome.tabs.getCurrent(), chrome.windows.getCurrent()]).then(([tab, win]) => new Promise(resolve => {
    requestAnimationFrame(() => {
      release();
      const active = document.activeElement;
      if (cancelled || !tab?.active || win?.focused === false || document.visibilityState !== 'visible' ||
          (active !== document.body && active !== document.documentElement && active !== $('search')) ||
          !document.querySelector('#palette.hidden')) { resolve(false); return; }
      // Chrome keeps native newtab keyboard focus in the omnibox. One same-tab
      // replacement makes this our ordinary extension page, without a new tab/window.
      if (/^(?:chrome|brave|edge|vivaldi|opera):\/\/(?:newtab|new-tab-page)\/?(?:[?#].*)?$/.test(tab.url || '') &&
          !new URLSearchParams(location.search).has('searchFocus')) {
        const url = new URL(location.href); url.searchParams.set('searchFocus', '1');
        location.replace(url.href);
        resolve(true); return;
      }
      $('search').focus({ preventScroll: true });
      resolve(false);
    });
  })).catch(() => { release(); return false; });
}
const homeEntryReady = focusHomeSearchOnEntry();

let settings = {};
let scope = 'all';                 // 'all' | windowId
let searchTerm = '';
let data = { windows: [], currentId: null, winCount: 0 };
let dupInfo = { count: 0, sets: [] };
let refreshTimer = null;
let loadRevision = 0;
let activeContext = { tabId: null, windowId: null, groupId: -1, mode: 'none' };
let lastFollowKey = '';
let pendingFollowScroll = false;
let initialPaintDone = false;
let followActive = true;
try { followActive = localStorage.getItem('homeFollowActive') !== 'false'; } catch { /* Default to following. */ }
const selectedGroups = new Set();
const expandedGroupCards = new Set();
const SHOW_TAB_LIMIT = 6;
let groupArchiveBusy = false;
const localCollapsed = new Set();  // 未分组伪分组的本地折叠状态
/* 首页折叠只作用于首页视图：不写 chrome.tabGroups，不与侧边栏/标签条联动 */
let homeCollapsed = new Set();
try { homeCollapsed = new Set(JSON.parse(localStorage.getItem('homeCollapsed') || '[]')); } catch { /* 损坏则重置 */ }
function persistCollapsed() {
  try { localStorage.setItem('homeCollapsed', JSON.stringify([...homeCollapsed])); } catch { /* 忽略 */ }
}
/* Natural-height masonry; sizing changes never write to native tab groups. */
function sizeFlowCard(card) {
  const gap = parseFloat(getComputedStyle(card.parentElement).columnGap) || 0;
  card.style.gridRowEnd = `span ${Math.max(1, Math.ceil(card.getBoundingClientRect().height + gap))}`;
}
const flowObserver = new ResizeObserver(entries => {
  for (const { target } of entries) if (target.isConnected) sizeFlowCard(target);
});
function initGroupFlow() {
  flowObserver.disconnect();
  document.querySelectorAll('.group-grid').forEach(grid => {
    for (const card of grid.children) sizeFlowCard(card);
    grid.dataset.flowReady = '';
    for (const card of grid.children) flowObserver.observe(card);
  });
}
let sortableInstances = [];
let isDraggingSort = false;
let autoDelayCtrl = null;
let autoDiscardCtrl = null;
let tabMeta = {};
let lockedGroups = new Set();
let manualNamedGroups = new Map();
function destroySortables() {
  for (const inst of sortableInstances) {
    try { inst.destroy(); } catch { /* ignore */ }
  }
  sortableInstances = [];
}
function pointerXY(ev) {
  const pt = ev?.touches?.[0] || ev?.changedTouches?.[0] || ev;
  return pt && Number.isFinite(pt.clientX) && Number.isFinite(pt.clientY)
    ? { x: pt.clientX, y: pt.clientY }
    : null;
}
function initGroupSortable(grid, windowId) {
  if (typeof Sortable !== 'function' || !grid) return;
  const sortableCards = [...grid.querySelectorAll(':scope > .sp-group.is-sortable-group')];
  if (sortableCards.length < 2) return;
  let lastSwap = null;
  const inst = Sortable.create(grid, {
    draggable: '.sp-group.is-sortable-group',
    handle: '.sp-group-head',
    filter: '.active-group, [data-group-id^="u-"], .group-select, .group-order, .group-rename-btn, .gname-input, input, button',
    preventOnFilter: false,
    animation: 180,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    swapThreshold: 0.65,
    invertSwap: true,
    ghostClass: 'group-drag-ghost',
    chosenClass: 'group-drag-chosen',
    dragClass: 'group-drag-active',
    fallbackClass: 'group-drag-floating',
    onStart() {
      isDraggingSort = true;
      lastSwap = null;
    },
    onMove(evt, originalEvent) {
      if (!evt.related?.classList?.contains('is-sortable-group')) return false;
      const now = performance.now();
      // 防抖锁 + 指针滞回：在瀑布流跨列卡片动画期间或指针未真实移动 >= 14px 时，禁止因网格重排引起的反向回跳抖动
      if (lastSwap && now - lastSwap.at < 220) return false;
      const pt = pointerXY(originalEvent);
      if (lastSwap && pt && Math.hypot(pt.x - lastSwap.x, pt.y - lastSwap.y) < 14) return false;
      lastSwap = { at: now, x: pt?.x ?? -9999, y: pt?.y ?? -9999 };
      return true;
    },
    async onEnd(evt) {
      isDraggingSort = false;
      lastSwap = null;
      initGroupFlow();
      if (evt.oldIndex === evt.newIndex) return;
      const allGroups = (data.windows.find(w => w.windowId === windowId)?.groups || []).map(g => g.id);
      const gridOrder = [...grid.querySelectorAll(':scope > .sp-group[data-group-id]')]
        .map(el => el.dataset.groupId)
        .filter(id => id && !id.startsWith('u-'))
        .map(Number);
      const gridSet = new Set(gridOrder);
      const missing = allGroups.filter(id => !gridSet.has(id));
      const order = [...missing, ...gridOrder];
      if (!order.length || order.every((id, idx) => allGroups[idx] === id)) return;
      const res = await rpc({ type: 'drag-group-reorder', windowId, order });
      if (res?.ok) toast('分组顺序已调整', 'ok');
      else toast(res?.message || '排序失败', 'err');
      scheduleReload();
    },
  });
  sortableInstances.push(inst);
}
function initTabSortable(ul, windowId) {
  if (typeof Sortable !== 'function' || !ul) return;
  const inst = Sortable.create(ul, {
    group: { name: `home-tabs-${windowId}`, pull: true, put: true },
    draggable: 'li',
    filter: 'button, select, .ui-ss-trigger, .close, .tab-move',
    preventOnFilter: false,
    animation: 150,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    forceFallback: true,
    fallbackOnBody: true,
    fallbackTolerance: 4,
    ghostClass: 'tab-drag-ghost',
    fallbackClass: 'tab-drag-floating',
    onStart() {
      isDraggingSort = true;
    },
    async onEnd(evt) {
      isDraggingSort = false;
      if (!evt.to || evt.to === evt.from) return;
      const targetBox = evt.to.closest('.sp-group');
      const targetKey = targetBox?.dataset?.groupId || '';
      const tabId = Number(evt.item?.dataset?.tabId);
      if (!targetKey || !Number.isInteger(tabId)) return;
      const isTargetPseudo = targetKey.startsWith('u-');
      const targetTitle = targetBox.querySelector('.gname')?.textContent || '未命名组';
      const res = await rpc({
        type: 'drag-tab-move',
        tabId,
        groupId: isTargetPseudo ? null : Number(targetKey),
        windowId,
      });
      if (res?.ok) toast(isTargetPseudo ? '已移出分组' : `已移入「${targetTitle}」`, 'ok');
      else toast(res?.message || '移动失败', 'err');
      scheduleReload();
    },
  });
  sortableInstances.push(inst);
}

function faviconUrl(url) {
  return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(url || '')}&size=32`;
}
function matches(t) {
  if (!searchTerm) return true;
  const groupName = data.windows.flatMap(w => w.groups).find(g => g.id === t.groupId)?.title || '';
  const displayTitle = typeof resolveTabDisplayTitle === 'function' ? resolveTabDisplayTitle(t, tabMeta) : cleanTitle(t.title, t.url);
  const summary = typeof resolveTabSummary === 'function' ? resolveTabSummary(t, tabMeta) : '';
  if (typeof fuzzyMatchScore === 'function') {
    return fuzzyMatchScore(searchTerm, displayTitle, t.title, summary, t.url, groupName) > 0;
  }
  const s = searchTerm.toLowerCase();
  return displayTitle.toLowerCase().includes(s) || (t.title || '').toLowerCase().includes(s)
    || summary.toLowerCase().includes(s) || (t.url || '').toLowerCase().includes(s) || groupName.toLowerCase().includes(s);
}

/* ---------------- 时钟 ---------------- */
function tick() {
  const now = new Date();
  $('clock-time').textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
  $('clock-date').textContent = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
}
setInterval(tick, 1000);
tick();

/* ---------------- 数据 ---------------- */

async function buildScopeOptions() {
  const wins = await chrome.windows.getAll({ populate: true });
  const cur = await chrome.windows.getCurrent();
  const sel = $('scope');
  sel.innerHTML = '';
  sel.add(new Option(`全部窗口（${wins.length}）`, 'all'));
  sel.add(new Option(`当前窗口（${cur.tabs?.length ?? 0} 标签）`, String(cur.id)));
  for (const w of wins) {
    if (w.id === cur.id) continue;
    sel.add(new Option(`窗口 ${w.id}（${w.tabs?.length ?? 0} 标签）`, String(w.id)));
  }
  const want = String(scope);
  sel.value = [...sel.options].some(o => o.value === want) ? want : 'all';
  scope = sel.value === 'all' ? 'all' : Number(sel.value);
  if (typeof enhanceSelect === 'function') {
    enhanceSelect(sel, { variant: 'sm', searchPlaceholder: '搜索窗口…', minMenuWidth: 190 });
    syncSearchableSelect(sel);
  }
}

async function loadData() {
  const revision = ++loadRevision;
  const wins = await chrome.windows.getAll();
  const cur = await chrome.windows.getCurrent();
  const targets = scope === 'all' ? wins : wins.filter(w => w.id === scope);
  const out = [];
  for (const w of targets) {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId: w.id }),
      chrome.tabGroups.query({ windowId: w.id }),
    ]);
    groups.sort((a, b) => Math.min(...tabs.filter(t => t.groupId === a.id).map(t => t.index)) - Math.min(...tabs.filter(t => t.groupId === b.id).map(t => t.index)));
    out.push({ windowId: w.id, focused: w.focused, tabs, groups });
  }
  const [duplicates, context, localMeta] = await Promise.all([
    rpc({ type: 'dup-count', windowId: scope === 'all' ? null : scope }),
    rpc({ type: 'active-work-tab', windowId: scope === 'all' ? null : scope }).catch(() => null),
    chrome.storage.local?.get?.(['tabMetaCache', 'lockedGroupIds', 'manualNamedGroups']).catch(() => ({})) || Promise.resolve({}),
  ]);
  if (revision !== loadRevision) return false;
  tabMeta = (localMeta?.tabMetaCache && typeof localMeta.tabMetaCache === 'object') ? localMeta.tabMetaCache : {};
  lockedGroups = new Set(Array.isArray(localMeta?.lockedGroupIds) ? localMeta.lockedGroupIds.filter(id => Number.isInteger(id) && id >= 0) : []);
  manualNamedGroups = new Map(
    Object.entries(localMeta?.manualNamedGroups && typeof localMeta.manualNamedGroups === 'object' ? localMeta.manualNamedGroups : {})
      .map(([k, v]) => [Number(k), String(v || '').trim()])
      .filter(([id, v]) => Number.isInteger(id) && id >= 0 && v),
  );
  data = { windows: out, currentId: cur.id, winCount: wins.length };
  dupInfo = duplicates || { count: 0, sets: [] };
  activeContext = context?.ok ? context : { tabId: null, windowId: null, groupId: -1, mode: 'none' };
  const key = activeContext.tabId == null ? '' : `${activeContext.windowId}:${activeContext.tabId}:${activeContext.groupId}`;
  if (followActive && key && key !== lastFollowKey) {
    homeCollapsed.delete(activeContext.groupId);
    if (activeContext.groupId === -1) localCollapsed.delete(`u-${activeContext.windowId}`);
    pendingFollowScroll = initialPaintDone && activeContext.mode === 'active';
  }
  lastFollowKey = key;
  return true;
}

async function reload() {
  if (await loadData() !== false) paint();
}

function scheduleReload() {
  if (isDraggingSort) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(reload, 400);
}

/* ---------------- 渲染 ---------------- */

function renderGroup(title, color, tabs, group, idx, isPseudo = false, windowId = null) {
  const box = document.createElement('section');
  box.className = 'sp-group';
  box.style.setProperty('--i', idx);
  box.dataset.groupId = String(group.id);
  box.dataset.windowId = String(windowId ?? '');
  const followedGroup = followActive && activeContext.windowId === windowId && activeContext.groupId === group.id;
  const isLocked = !isPseudo && lockedGroups.has(group.id);
  const isManualNamed = !isPseudo && manualNamedGroups.has(group.id);
  box.classList.toggle('active-group', followedGroup);
  box.classList.toggle('is-sortable-group', !isPseudo && !followedGroup);
  box.classList.toggle('is-locked', isLocked);
  box.classList.toggle('is-manual-named', isManualNamed);
  const store = isPseudo ? localCollapsed : homeCollapsed;
  const collapsed = store.has(group.id);
  const head = document.createElement('div');
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.className = 'sp-group-head';
  const hex = COLOR_HEX[color] || COLOR_HEX.grey;
  head.style.background = tint(hex, .12);
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = hex;
  const trUi = s => (typeof translateUiText === 'function' ? translateUiText(s) : s);
  const name = document.createElement('span');
  name.className = 'gname';
  name.textContent = title ? (isPseudo ? trUi(title) : title) : trUi('未命名组');
  const triggerRename = () => {
    if (isPseudo || typeof startInlineGroupRename !== 'function') return;
    startInlineGroupRename({
      nameEl: name,
      currentTitle: title || '',
      onSave: async nextTitle => {
        try {
          const res = await rpc({ type: 'group-rename', groupId: group.id, title: nextTitle });
          if (!res?.ok) throw new Error(res?.message || '重命名失败');
          manualNamedGroups.set(group.id, res.title);
          toast(`已重命名并固定分组名称为「${res.title}」`, 'ok');
          await reload();
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
  chev.className = 'chev' + (collapsed ? ' collapsed' : '');
  chev.innerHTML = icon('chevron', 12);
  head.append(chev, dot, name);
  if (!isPseudo) {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'group-rename-btn';
    renameBtn.innerHTML = icon('edit', 11);
    renameBtn.title = trUi(isManualNamed ? '已手动固定分组名称，AI 不再自动改名；点击修改' : '重命名分组并固定名称');
    renameBtn.setAttribute('aria-label', trUi(`重命名分组「${title || '未命名组'}」`));
    renameBtn.onclick = e => { e.stopPropagation(); triggerRename(); };
    head.appendChild(renameBtn);
  }
  if (isManualNamed) {
    const fixedBadge = document.createElement('span');
    fixedBadge.className = 'group-manual-badge';
    fixedBadge.title = trUi('已手动命名，AI 自动整理不再更改名称');
    fixedBadge.textContent = trUi('已固定');
    head.appendChild(fixedBadge);
  }
  if (followedGroup) {
    const marker = document.createElement('span');
    marker.className = 'group-current-label';
    marker.textContent = activeContext.mode === 'recent' ? '最近浏览' : '当前';
    head.appendChild(marker);
  }
  head.append(count);
  head.setAttribute('aria-expanded', String(!collapsed));
  head.setAttribute('aria-label', `${title || '未命名组'}，${tabs.length} 个标签`);

  const ul = document.createElement('ul');
  ul.className = 'sp-tabs';
  if (collapsed) ul.style.display = 'none';
  /* 拦截：首页折叠纯本地，不碰 chrome.tabGroups（侧边栏/标签条不受影响） */
  head.onclick = () => {
    const nowCollapsed = !store.has(group.id);
    if (nowCollapsed) store.add(group.id); else store.delete(group.id);
    if (!isPseudo) persistCollapsed();
    ul.style.display = nowCollapsed ? 'none' : '';
    chev.classList.toggle('collapsed', nowCollapsed);
    head.setAttribute('aria-expanded', String(!nowCollapsed));
  };
  head.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      head.click();
    }
  };

  /* 拖拽由 SortableJS 接管（指针式灰卡落点预览 + 防抖滞回） */
  if (!isPseudo && !followedGroup) {
    head.title = '点击折叠/展开；拖动标题区域调整 Chrome 分组顺序';
  }
  initTabSortable(ul, windowId);

  for (const t of tabs) {
    const li = document.createElement('li');
    const tracked = t.id === activeContext.tabId;
    if (tracked || (activeContext.tabId == null && t.active)) li.classList.add('active');
    if (t.discarded) li.classList.add('is-discarded');
    if (tracked && activeContext.mode === 'active') li.setAttribute('aria-current', 'page');
    if (tracked && activeContext.mode === 'recent') { li.dataset.recent = 'true'; li.title = '最近浏览的标签'; }
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
    const domain = document.createElement('span');
    domain.className = 'tab-domain';
    const hostText = domainOf(t.url);
    domain.textContent = summary ? (hostText ? `${hostText} · ${summary}` : summary) : hostText;
    if (t.discarded) {
      const asleep = document.createElement('span');
      asleep.className = 'hibernated-badge';
      asleep.textContent = typeof translateUiText === 'function' ? translateUiText('已休眠') : '已休眠';
      asleep.title = typeof translateUiText === 'function' ? translateUiText('该标签已休眠释放内存，点击切换时自动唤醒') : '该标签已休眠释放内存，点击切换时自动唤醒';
      domain.append(' ', asleep);
    }
    const activate = () => {
      chrome.tabs.update(t.id, { active: true });
      chrome.windows.update(t.windowId, { focused: true });
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
    li.dataset.tabId = String(t.id);
    const move = document.createElement('select');
    move.className = 'tab-move';
    move.setAttribute('aria-label', `移动标签「${cleanTitle(t.title, t.url)}」到分组`);
    move.title = '移动到同窗口的其他分组';
    move.add(new Option('移动', '', true, true));
    for (const destination of data.windows.find(w => w.windowId === windowId)?.groups || []) {
      if (destination.id !== t.groupId) move.add(new Option(destination.title || '未命名组', String(destination.id)));
    }
    if (t.groupId !== -1) move.add(new Option('移出分组', 'ungroup'));
    move.disabled = move.options.length < 2;
    move.onclick = e => e.stopPropagation();
    move.onkeydown = e => e.stopPropagation();
    move.onchange = async e => {
      e.stopPropagation();
      move.disabled = true;
      try {
        const res = await rpc({ type: 'drag-tab-move', tabId: t.id, groupId: move.value === 'ungroup' ? null : Number(move.value), windowId });
        if (!res?.ok) toast(res?.message || '移动失败', 'err');
        await reload();
        const nextRow = document.querySelector(`[data-tab-id="${t.id}"]`);
        (nextRow?.querySelector('.ui-ss-trigger') || nextRow?.querySelector('.tab-move'))?.focus();
      } catch (err) { toast(`移动失败：${err.message}`, 'err'); }
      finally {
        move.value = '';
        move.disabled = move.options.length < 2;
        if (typeof syncSearchableSelect === 'function') syncSearchableSelect(move);
      }
    };
    if (!searchTerm && !expandedGroupCards.has(group.id) && ul.children.length >= SHOW_TAB_LIMIT) {
      li.classList.add('extra-tab-hidden');
    }
    li.append(img, titleBtn, domain, move, close);
    if (typeof enhanceSelect === 'function') {
      enhanceSelect(move, {
        variant: 'move',
        searchPlaceholder: '搜索目标分组…',
        minMenuWidth: 220,
        hidePlaceholderOption: true,
      });
    }
    ul.appendChild(li);
  }
  const heading = document.createElement('div');
  heading.className = 'group-heading';
  if (!isPseudo) {
    const label = document.createElement('label');
    label.className = 'group-select';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedGroups.has(group.id);
    checkbox.disabled = groupArchiveBusy;
    const total = data.windows.find(w => w.windowId === windowId)?.tabs.filter(t => t.groupId === group.id).length || tabs.length;
    checkbox.setAttribute('aria-label', `选择整个 Chrome 分组「${title || '未命名组'}」，共 ${total} 个标签`);
    checkbox.onchange = () => { checkbox.checked ? selectedGroups.add(group.id) : selectedGroups.delete(group.id); updateGroupSelection(); };
    label.appendChild(checkbox);
    heading.appendChild(label);
  }
  heading.append(head);
  if (!isPseudo) {
    const actions = document.createElement('div');
    actions.className = 'group-order';
    const siblings = data.windows.find(w => w.windowId === windowId)?.groups || [];
    const position = siblings.findIndex(g => g.id === group.id);
    for (const [delta, label] of [[-1, '上移'], [1, '下移']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = delta < 0 ? 'order-up' : 'order-down';
      btn.innerHTML = icon('chevron', 12);
      btn.title = followedGroup ? '当前分组置顶展示；关闭跟随后可手动排序' : `${label}Chrome 分组`;
      btn.setAttribute('aria-label', `${label}分组「${title}」`);
      btn.disabled = followedGroup || position + delta < 0 || position + delta >= siblings.length;
      btn.onclick = async () => {
        btn.disabled = true;
        const order = siblings.map(g => g.id);
        [order[position], order[position + delta]] = [order[position + delta], order[position]];
        try {
          const res = await rpc({ type: 'drag-group-reorder', windowId, order });
          if (!res?.ok) toast(res?.message || '排序失败', 'err');
          await reload();
          document.querySelector(`[data-group-id="${group.id}"] .${btn.className}`)?.focus();
        } catch (err) { toast(`排序失败：${err.message}`, 'err'); btn.disabled = false; }
      };
      actions.append(btn);
    }
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'group-lock-btn' + (isLocked ? ' is-locked' : '');
    lockBtn.innerHTML = icon(isLocked ? 'lock' : 'unlock', 12);
    lockBtn.title = trUi(isLocked ? '已加锁保护（禁止自动清理/去重）；点击解锁' : '加锁保护分组（禁止自动清理该分组标签）');
    lockBtn.setAttribute('aria-label', trUi(isLocked ? `解锁分组「${title || '未命名组'}」` : `加锁保护分组「${title || '未命名组'}」`));
    lockBtn.setAttribute('aria-pressed', String(isLocked));
    lockBtn.onclick = async e => {
      e.stopPropagation();
      lockBtn.disabled = true;
      try {
        const res = await rpc({ type: 'group-lock-set', groupId: group.id, locked: !isLocked });
        if (!res?.ok) throw new Error(res?.message || '操作失败');
        lockedGroups = new Set(res.lockedGroupIds || []);
        toast(res.locked ? `已加锁「${title || '未命名组'}」，禁止自动清理组内标签` : `已解锁「${title || '未命名组'}」`, 'ok');
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
    closeBtn.title = trUi('快速关闭或保存分组');
    closeBtn.setAttribute('aria-label', trUi(`快速关闭分组「${title || '未命名组'}」`));
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
            const res = await rpc({ type: 'group-archive-close', groupIds: [group.id], windowId });
            if (!res?.ok) throw new Error(res?.message || '关闭分组失败');
            selectedGroups.delete(group.id);
            updateGroupSelection();
            toast(`已关闭分组「${title || '未命名组'}」（可在「已关闭分组」重新打开）`, 'ok');
            await reload();
            refreshOps();
          } catch (err) {
            toast(err?.message || '关闭分组失败', 'err');
          }
        },
        onForceClose: async () => {
          try {
            const res = await rpc({ type: 'group-force-close', groupId: group.id, windowId });
            if (!res?.ok) throw new Error(res?.message || '关闭失败');
            selectedGroups.delete(group.id);
            updateGroupSelection();
            toast(`已解散分组「${title || '未命名组'}」并彻底关闭 ${res.closedTabs} 个标签页`, 'ok');
            await reload();
            refreshOps();
          } catch (err) {
            toast(err?.message || '解散关闭失败', 'err');
          }
        },
      });
    };

    actions.append(lockBtn, closeBtn);
    heading.append(actions);
  }
  if (followedGroup) {
    const pinBanner = document.createElement('div');
    pinBanner.className = 'pinned-banner-label';
    pinBanner.innerHTML = '<strong>当前工作分组 · 已在视图置顶</strong><span>当前浏览标签所属分组（仅调整视图展示顺序，不移动原生标签条）</span>';
    box.appendChild(pinBanner);
  }
  box.append(heading, ul);
  if (!searchTerm && tabs.length > SHOW_TAB_LIMIT && !collapsed) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'gmore-btn';
    const isExp = expandedGroupCards.has(group.id);
    moreBtn.textContent = isExp ? `共 ${tabs.length} 个标签 · 收起其余标签` : `展开其余 ${tabs.length - SHOW_TAB_LIMIT} 个标签`;
    moreBtn.onclick = e => {
      e.stopPropagation();
      if (expandedGroupCards.has(group.id)) expandedGroupCards.delete(group.id);
      else expandedGroupCards.add(group.id);
      paint();
    };
    box.appendChild(moreBtn);
  }
  return box;
}

async function updateLastRun() {
  const { lastRun } = await chrome.storage.session.get('lastRun');
  if (lastRun?.applied) {
    const time = new Date(lastRun.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    $('lastRun').textContent = `上次整理 ${time}（${lastRun.source === 'ai' ? 'AI' : '规则'}）`;
    if ($('topLastRun')) $('topLastRun').textContent = `上次整理 ${time}`;
  }
}

function visibleNativeGroups() {
  return data.windows.flatMap(w => w.groups.filter(g => Number.isInteger(g.id) && g.id >= 0 && w.tabs.some(t => t.groupId === g.id && matches(t)))
    .map(group => ({ ...group, tabs: w.tabs.filter(t => t.groupId === group.id) })));
}
function updateGroupSelection() {
  const visible = visibleNativeGroups();
  const visibleIds = new Set(visible.map(g => g.id));
  for (const id of selectedGroups) if (!visibleIds.has(id)) selectedGroups.delete(id);
  const count = visible.filter(g => selectedGroups.has(g.id));
  $('selectAllGroups').checked = visible.length > 0 && count.length === visible.length;
  $('selectAllGroups').indeterminate = count.length > 0 && count.length < visible.length;
  $('selectAllGroups').disabled = groupArchiveBusy || !visible.length;
  $('groupSelectionCount').textContent = count.length ? `已选 ${count.length} 个 Chrome 分组、${count.reduce((n, g) => n + g.tabs.length, 0)} 个标签（整组）` : '未选择分组';
  $('archiveSelectedGroups').disabled = groupArchiveBusy || !count.length;
  if ($('batchBar')) $('batchBar').classList.toggle('hidden', count.length === 0);
  $('followActiveTab').setAttribute('aria-pressed', String(followActive));
  document.querySelectorAll('.group-select input').forEach(input => { input.disabled = groupArchiveBusy; });
  document.querySelectorAll('.archive-restore').forEach(button => { button.disabled = groupArchiveBusy; });
}

function paint() {
  updateGroupSelection();
  const totalTabs = data.windows.reduce((n, w) => n + w.tabs.length, 0);
  const totalGroups = data.windows.reduce((n, w) => n + w.groups.length, 0);
  countUp($('st-tabs'), totalTabs);
  countUp($('st-groups'), totalGroups);
  countUp($('st-dups'), dupInfo.count || 0);
  countUp($('st-wins'), data.winCount);
  if ($('ledeTabs')) $('ledeTabs').textContent = String(totalTabs);
  if ($('ledeGroups')) $('ledeGroups').textContent = String(totalGroups);

  const badge = $('dupCount');
  badge.textContent = dupInfo.count || 0;
  badge.classList.toggle('zero', !dupInfo.count);
  $('dedup').disabled = !dupInfo.count;
  $('dupCard').classList.toggle('hidden', !(dupInfo.sets || []).length);
  const dl = $('dupList');
  dl.innerHTML = '';
  for (const s of (dupInfo.sets || []).slice(0, 12)) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'dup-title';
    t.textContent = s.title || s.url;
    t.title = s.url;
    const n = document.createElement('span');
    n.className = 'dup-n';
    n.textContent = '×' + s.count;
    const ignore = document.createElement('button');
    ignore.className = 'ops-btn';
    ignore.title = '忽略此组重复（加入白名单）';
    ignore.setAttribute('aria-label', '忽略重复 ' + (s.title || s.url));
    ignore.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
    ignore.onclick = async () => {
      await rpc({ type: 'dup-whitelist-add', url: s.url });
      toast('已加入去重白名单', 'ok');
      await reload();
    };
    li.append(t, n, ignore);
    dl.appendChild(li);
  }
  const wl = dupInfo.whitelist || [];
  $('wlWrap').classList.toggle('hidden', !wl.length);
  const wlList = $('wlList');
  wlList.innerHTML = '';
  for (const u of wl) {
    const chip = document.createElement('span');
    chip.className = 'wl-chip';
    const label = document.createElement('span');
    label.textContent = domainOf(u) || u;
    label.title = u;
    const x = document.createElement('button');
    x.innerHTML = icon('close', 11);
    x.setAttribute('aria-label', '移除去重白名单 ' + u);
    x.onclick = async () => {
      await rpc({ type: 'dup-whitelist-remove', url: u });
      toast('已移出去重白名单', 'info');
      await reload();
    };
    chip.append(label, x);
    wlList.appendChild(chip);
  }
  rpc({ type: 'dedup-state' }).then(st => $('dedupUndo').classList.toggle('hidden', !st?.undoCount));

  destroySortables();
  const root = $('windows');
  root.innerHTML = '';
  let shown = 0, wi = 0;
  const windows = [...data.windows].sort((a, b) => followActive ? Number(b.windowId === activeContext.windowId) - Number(a.windowId === activeContext.windowId) : 0);
  for (const w of windows) {
    const sec = document.createElement('section');
    sec.className = 'win-section';
    sec.style.setProperty('--i', wi++);
    if (data.windows.length > 1) {
      const head = document.createElement('div');
      head.className = 'win-head';
      const chip = document.createElement('span');
      chip.className = 'win-chip';
      chip.appendChild(document.createTextNode(
        w.focused ? `当前窗口（${w.tabs.length} 标签）` : `窗口 ${w.windowId}（${w.tabs.length} 标签）`,
      ));
      const org = document.createElement('button');
      org.className = 'ghost win-organize';
      org.innerHTML = icon('refresh', 12) + '整理此窗口';
      org.onclick = () => runOrganize({ windowId: w.windowId });
      head.append(chip, org);
      sec.appendChild(head);
    }
    const grid = document.createElement('div');
    grid.className = 'group-grid';
    const byGroup = new Map(w.groups.map(g => [g.id, g]));
    const buckets = new Map();
    const ungrouped = [];
    for (const t of w.tabs) {
      if (t.groupId !== -1 && byGroup.has(t.groupId)) {
        if (!buckets.has(t.groupId)) buckets.set(t.groupId, []);
        buckets.get(t.groupId).push(t);
      } else {
        ungrouped.push(t);
      }
    }
    let gi = 0;
    const displayGroups = [...w.groups].sort((a, b) => followActive && w.windowId === activeContext.windowId
      ? Number(b.id === activeContext.groupId) - Number(a.id === activeContext.groupId) : 0);
    for (const g of displayGroups) {
      const filtered = (buckets.get(g.id) || []).filter(matches);
      if (!filtered.length) continue;
      grid.appendChild(renderGroup(g.title, g.color, filtered, g, gi++, false, w.windowId));
      shown += filtered.length;
    }
    const fu = ungrouped.filter(matches);
    if (fu.length) {
      const key = `u-${w.windowId}`;
      const pseudo = { id: key };
      grid.appendChild(renderGroup('未分组', 'grey', fu, pseudo, gi++, true, w.windowId));
      shown += fu.length;
    }
    sec.appendChild(grid);
    if (grid.children.length) {
      root.appendChild(sec);
      initGroupSortable(grid, w.windowId);
    }
  }
  initGroupFlow();
  $('empty').classList.toggle('hidden', shown > 0);
  $('mainStatus').textContent =
    `${totalTabs} 标签、${totalGroups} 分组${searchTerm ? `、匹配 ${shown}` : ''}`;
  updateLastRun();
  if (pendingFollowScroll && !document.hidden) {
    pendingFollowScroll = false;
    if (followActive && !searchTerm) {
      const targetId = activeContext.tabId;
      globalThis.requestAnimationFrame?.(() => {
        if (!document.hidden && activeContext.tabId === targetId) {
          document.querySelector(`[data-tab-id="${targetId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        }
      });
    }
  }
  initialPaintDone = true;
}

/* ---------------- Native group archives and lifecycle advice ---------------- */
let archiveListRevision = 0;
async function refreshGroupArchives() {
  const revision = ++archiveListRevision;
  try {
    const result = await rpc({ type: 'group-archive-list' });
    if (revision !== archiveListRevision) return;
    const archives = result?.ok && Array.isArray(result.archives) ? result.archives.slice(0, 20) : [];
    $('closedGroupsCount').textContent = result?.ok ? String(archives.length) : '未连接';
    $('closedGroupsEmpty').textContent = result?.ok ? '还没有保存并关闭的分组' : result?.message || '无法读取已关闭分组，请重试';
    $('closedGroupsEmpty').classList.toggle('hidden', !!archives.length);
    const list = $('closedGroupsList'); list.innerHTML = '';
    for (const archive of archives) {
      const li = document.createElement('li');
      li.className = 'archive-row';
      const main = document.createElement('div');
      main.className = 'archive-row-main';
      const summary = document.createElement('span'); summary.className = 'archive-summary';
      const names = (archive.groups || []).map(g => g.title || '未命名组').join(' / ');
      summary.textContent = names;
      summary.title = names;
      const metaRow = document.createElement('div');
      metaRow.className = 'archive-row-meta';
      const at = document.createElement('time'); at.className = 'ops-time';
      at.textContent = new Date(archive.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const meta = document.createElement('span'); meta.className = 'ops-meta';
      meta.textContent = `· ${archive.groupCount} 组 ${archive.tabCount} 标签`;
      metaRow.append(at, meta);
      main.append(summary, metaRow);
      const button = document.createElement('button'); button.className = 'btn sm archive-restore'; button.type = 'button';
      button.textContent = archive.restoring ? '重试' : '恢复';
      button.title = archive.restoring ? '重试恢复到当前窗口' : '恢复分组与标签到当前窗口';
      button.setAttribute('aria-label', archive.restoring ? `重试恢复 ${names}` : `恢复 ${names} 到本窗口`);
      button.dataset.archiveId = archive.id;
      button.disabled = groupArchiveBusy;
      button.onclick = async () => {
        if (groupArchiveBusy) return;
        groupArchiveBusy = true; updateGroupSelection();
        $('groupActionStatus').textContent = '正在恢复链接与 Chrome 分组…';
        try {
          const restored = await rpc({ type: 'group-archive-restore', id: archive.id, targetWindowId: data.currentId });
          $('groupActionStatus').textContent = restored?.message || (restored?.ok ? `已恢复 ${restored.restoredGroups || 0} 组、${restored.restoredTabs || 0} 个标签` : '恢复未完成，档案仍保留，可重试');
          toast($('groupActionStatus').textContent, restored?.ok ? 'ok' : 'err');
        } catch (error) { $('groupActionStatus').textContent = `恢复未完成：${error.message}，可重试`; toast($('groupActionStatus').textContent, 'err'); }
        finally { groupArchiveBusy = false; await reload(); await refreshGroupArchives(); updateGroupSelection(); }
      };
      const del = document.createElement('button');
      del.className = 'ops-btn danger archive-delete';
      del.type = 'button';
      del.title = '删除这条归档记录';
      del.setAttribute('aria-label', `删除归档 ${names}`);
      del.innerHTML = ICON_TRASH;
      del.disabled = groupArchiveBusy;
      del.onclick = async () => {
        del.disabled = true;
        try {
          const res = await rpc({ type: 'group-archive-delete', id: archive.id });
          if (!res?.ok) throw new Error(res?.message || '删除失败');
          toast('已删除该条已关闭分组记录', 'info');
          await refreshGroupArchives();
        } catch (error) {
          toast(`删除失败：${error.message}`, 'err');
          del.disabled = false;
        }
      };
      li.append(main, button, del); list.appendChild(li);
    }
  } catch { if (revision === archiveListRevision) { $('closedGroupsCount').textContent = '未连接'; $('closedGroupsEmpty').classList.remove('hidden'); $('closedGroupsEmpty').textContent = '无法读取已关闭分组，请重新打开首页'; } }
}
$('selectAllGroups').onchange = () => {
  for (const group of visibleNativeGroups()) $('selectAllGroups').checked ? selectedGroups.add(group.id) : selectedGroups.delete(group.id);
  paint();
};
$('archiveSelectedGroups').onclick = async () => {
  if (groupArchiveBusy) return;
  const selected = visibleNativeGroups().filter(g => selectedGroups.has(g.id));
  if (!selected.length) return;
  const total = selected.reduce((n, g) => n + g.tabs.length, 0);
  if (!confirm(`保存并关闭 ${selected.length} 个完整 Chrome 分组、${total} 个标签？\n将先保存链接、分组名称和颜色，之后可恢复。未提交的表单或临时页面内容不会保存。`)) return;
  groupArchiveBusy = true; updateGroupSelection();
  $('groupActionStatus').textContent = '正在保存分组，成功保存后才关闭标签…';
  try {
    const result = await rpc({ type: 'group-archive-close', groupIds: selected.map(g => g.id), ...(scope === 'all' ? {} : { windowId: scope }) });
    $('groupActionStatus').textContent = result?.message || (result?.ok ? `已保存并关闭 ${result.closedGroups || 0} 组、${result.closedTabs || 0} 个标签，可从“已关闭分组”恢复` : '未能关闭分组，原标签保留，请重试');
    toast($('groupActionStatus').textContent, result?.ok ? (result.partial ? 'info' : 'ok') : 'err');
    if (result?.id) $('closedGroupsPanel').open = true;
  } catch (error) { $('groupActionStatus').textContent = `关闭未完成：${error.message}，请检查已关闭分组记录`; toast($('groupActionStatus').textContent, 'err'); }
  finally { groupArchiveBusy = false; await reload(); await refreshGroupArchives(); updateGroupSelection(); }
};
$('followActiveTab').onclick = async () => {
  followActive = !followActive;
  try { localStorage.setItem('homeFollowActive', String(followActive)); } catch { /* The current view still works. */ }
  if (followActive) lastFollowKey = '';
  await reload();
};
let cleanupRevision = 0;
function renderCleanupAdvice(advice) {
  if (!advice?.ok || advice.basis !== 'lastAccessed') return;
  if (scope !== 'all' && advice.windowId !== scope) return;
  const candidates = (advice.candidates || []).filter(t => Number.isInteger(t.id) && Number.isFinite(t.idleDays) && t.idleDays >= 7);
  $('cleanupAdvice').classList.remove('hidden');
  const windowLabel = advice.windowId != null && scope === 'all' ? `窗口 ${advice.windowId} · ` : '';
  $('cleanupSummary').textContent = candidates.length ? `${windowLabel}清理建议：${candidates.length >= 50 ? '至少 ' : ''}${candidates.length} 个标签超过 ${advice.thresholdDays || 7} 天未访问` : `${windowLabel}清理建议：暂未发现超过 7 天未访问的可清理标签`;
  $('cleanupNote').textContent = `依据最近访问时间，不代表真实打开时长；不会自动关闭，可手动一键清理或先休眠释放内存。固定、活动和播放声音的标签已排除。${advice.unknownCount ? `另有 ${advice.unknownCount} 个标签缺少访问时间，未作推断。` : ''}`;
  if ($('cleanupCloseAllBtn')) $('cleanupCloseAllBtn').disabled = !candidates.length;
  if ($('cleanupDiscardAllBtn')) $('cleanupDiscardAllBtn').disabled = !candidates.some(c => !c.discarded);
  const list = $('cleanupCandidates'); list.innerHTML = '';
  for (const candidate of candidates.slice(0, 10)) {
    const li = document.createElement('li');
    const main = document.createElement('span'); main.className = 'sug-item-main';
    const title = document.createElement('button'); title.type = 'button'; title.className = 'link cleanup-tab';
    title.textContent = cleanTitle(candidate.title, candidate.url); title.title = candidate.url || '';
    title.onclick = async () => {
      try {
        const live = await chrome.tabs.get(candidate.id);
        if (live.url !== candidate.url) throw new Error('标签页面已经变化');
        await chrome.tabs.update(candidate.id, { active: true });
        await chrome.windows.update(live.windowId, { focused: true });
        refreshCleanupAdvice();
      } catch { toast('该标签已关闭或已变化，请重新获取清理建议', 'info'); }
    };
    const age = document.createElement('span'); age.className = 'meta'; age.textContent = `${candidate.idleDays} 天未访问${candidate.discarded ? ' · 已休眠' : ''}`;
    main.append(title, age);
    const acts = document.createElement('span'); acts.className = 'sug-item-actions';
    if (!candidate.discarded) {
      const hibBtn = document.createElement('button'); hibBtn.type = 'button'; hibBtn.className = 'btn sm';
      hibBtn.textContent = '休眠';
      hibBtn.onclick = () => runFreeMemory({ tabIds: [candidate.id], triggerBtn: hibBtn });
      acts.append(hibBtn);
    }
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'btn sm';
    closeBtn.textContent = '关闭';
    closeBtn.onclick = () => runCleanupClose({ tabIds: [candidate.id], triggerBtn: closeBtn });
    acts.append(closeBtn);
    li.append(main, acts); list.appendChild(li);
  }
}
async function runCleanupClose({ tabIds = null, triggerBtn = null } = {}) {
  const winId = scope === 'all' ? null : scope;
  if (triggerBtn) triggerBtn.disabled = true;
  try {
    const res = await rpc({ type: 'cleanup-close', windowId: winId, tabIds });
    if (!res?.ok) throw new Error(res?.message || '清理失败');
    if (res.advice) renderCleanupAdvice(res.advice);
    toast(res.closed ? `已一键清理 ${res.closed} 个闲置标签` : '没有可清理的闲置标签', res.closed ? 'ok' : 'info');
    await reload();
  } catch (err) {
    toast(`清理失败：${err.message}`, 'err');
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}
async function runFreeMemory({ tabIds = null, triggerBtn = null } = {}) {
  const winId = scope === 'all' ? null : scope;
  const orig = triggerBtn?.textContent;
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = '释放中…'; }
  try {
    const res = await rpc({ type: 'discard-tabs', windowId: winId, tabIds });
    if (!res?.ok) throw new Error(res?.message || '释放内存失败');
    toast(res.discarded ? `已将 ${res.discarded} 个非活跃标签置入休眠以释放内存` : '当前没有可休眠的后台标签', res.discarded ? 'ok' : 'info');
    await Promise.all([reload(), refreshCleanupAdvice()]);
  } catch (err) {
    toast(`释放内存失败：${err.message}`, 'err');
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; if (orig) triggerBtn.textContent = orig; }
  }
}
if ($('cleanupCloseAllBtn')) $('cleanupCloseAllBtn').onclick = () => runCleanupClose({ triggerBtn: $('cleanupCloseAllBtn') });
if ($('cleanupDiscardAllBtn')) {
  $('cleanupDiscardAllBtn').onclick = () => {
    const ids = [...document.querySelectorAll('#cleanupCandidates .cleanup-tab')].length
      ? null : null;
    rpc({ type: 'cleanup-advice', windowId: scope === 'all' ? null : scope }).then(adv => {
      const candIds = (adv?.candidates || []).map(c => c.id);
      if (!candIds.length) return toast('没有可休眠的候选标签', 'info');
      return runFreeMemory({ tabIds: candIds, triggerBtn: $('cleanupDiscardAllBtn') });
    }).catch(() => {});
  };
}
if ($('freeMemoryBtn')) $('freeMemoryBtn').onclick = () => runFreeMemory({ triggerBtn: $('freeMemoryBtn') });
if ($('freeMemorySettingsBtn')) $('freeMemorySettingsBtn').onclick = () => runFreeMemory({ triggerBtn: $('freeMemorySettingsBtn') });
async function refreshCleanupAdvice() {
  const revision = ++cleanupRevision;
  try {
    const result = await rpc({ type: 'cleanup-advice', windowId: scope === 'all' ? null : scope });
    if (revision === cleanupRevision) renderCleanupAdvice(result);
  } catch { /* Advice never blocks grouping or closes a tab. */ }
}

/* ---------------- 整理 ---------------- */

async function runOrganize({ windowId = null, incremental = false } = {}) {
  const btn = $('organize');
  btn.disabled = true;
  btn.textContent = 'AI 整理中…';
  $('organizeBanner').classList.remove('hidden');
  document.body.classList.add('organizing');
  const targets = windowId != null ? [windowId]
    : scope !== 'all' ? [scope]
    : incremental ? [data.currentId]
    : data.windows.map(w => w.windowId);
  let okCount = 0, totalGroups = 0, failMsg = null;
  const contexts = [], results = [];
  try {
    for (const wid of targets) {
      const res = await rpc({ type: 'organize', apply: true, incremental, windowId: wid });
      if (res?.ok) {
        results.push(res);
        if (!res.empty) { okCount++; totalGroups += res.groups?.length || 0; }
        const latest = await rpc({ type: 'last-context' });
        if (latest?.context) contexts.push(latest.context);
      } else failMsg = res?.message || '服务未返回结果';
    }
  } catch (err) { failMsg = err.message; }
  finally {
    btn.disabled = false;
    btn.textContent = '立即整理';
    $('organizeBanner').classList.add('hidden');
    document.body.classList.remove('organizing');
  }
  const feedback = [];
  if (contexts.length) {
    const read = contexts.reduce((n, c) => n + c.withSnippet, 0);
    const total = contexts.reduce((n, c) => n + c.tabs, 0);
    const bookmarked = contexts.reduce((n, c) => n + c.bookmarked, 0);
    feedback.push(`本次读取 ${read}/${total} 个页面摘要，匹配 ${bookmarked} 个书签。`);
  }
  const combined = {};
  for (const field of ['titleStats', 'cache']) {
    const rows = results.map(result => result[field]).filter(Boolean);
    if (rows.length) combined[field] = Object.fromEntries((field === 'titleStats' ? ['updated', 'unchanged', 'skipped'] : ['hits', 'misses']).map(key => [key, rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0)]));
  }
  const summary = analysisSummary(combined);
  if (summary) feedback.push(summary);
  if (feedback.length) $('contextStatus').textContent = feedback.join(' ');
  if (failMsg) toast(`${okCount ? '部分完成' : '整理失败'}：${failMsg}`, 'err');
  else if (!okCount) toast(results.find(result => result.message)?.message || '没有需要整理的标签', 'info');
  await reload();
  refreshOps();
  refreshCleanupAdvice();
  refreshHealthPill($('health'));
}

$('organize').onclick = () => runOrganize({});

/* ---------------- 去重 ---------------- */

async function doDedup() {
  const res = await rpc({ type: 'dedup', windowId: scope === 'all' ? null : scope });
  if (!res?.ok) return toast(res?.message || '去重失败', 'err');
  toast(res.closed ? `已关闭 ${res.closed} 个重复标签，可点"恢复"找回` : '没有重复标签', res.closed ? 'ok' : 'info');
  await reload();
  refreshOps();
}
$('dedup').onclick = doDedup;
$('dupCardBtn').onclick = doDedup;

$('dedupUndo').onclick = async () => {
  const res = await rpc({ type: 'dedup-undo' });
  if (!res?.ok) return toast(res?.message || '恢复失败', 'err');
  toast(`已恢复 ${res.restored} 个标签`, 'ok');
  await reload();
};

/* ---------------- 历史 / 空间 ---------------- */

const ICON_UNDO = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/></svg>';
const ICON_RESTORE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const ICON_TRASH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

async function refreshOps() {
  const [hist, sp] = await Promise.all([rpc({ type: 'history-list' }), rpc({ type: 'space-list' })]);
  renderHistory(hist?.runs || []);
  renderSpaces(sp?.spaces || []);
  refreshGroupArchives();
}

function renderHistory(runs) {
  const ul = $('historyList');
  ul.innerHTML = '';
  $('historyEmpty').classList.toggle('hidden', runs.length > 0);
  for (const r of runs.slice(0, 6)) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'ops-time';
    time.textContent = new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const src = document.createElement('span');
    src.className = 'ops-src ' + (r.source === 'ai' ? 'ai' : ['rollback', 'drag'].includes(r.source) ? 'rb' : 'rule');
    src.textContent = r.source === 'ai' ? 'AI' : r.source === 'rollback' ? '回滚' : r.source === 'drag' ? '手动' : '规则';
    const meta = document.createElement('span');
    meta.className = 'ops-meta';
    meta.textContent = `${r.groups?.length ?? 0} 组、${r.tabCount} 标签`;
    const btn = document.createElement('button');
    btn.className = 'ops-btn';
    btn.title = '回滚到这次整理之前';
    btn.setAttribute('aria-label', '回滚到 ' + time.textContent + ' 之前');
    btn.innerHTML = ICON_UNDO;
    btn.onclick = async () => {
      const res = await rpc({ type: 'history-rollback', id: r.id });
      if (!res?.ok) return toast(res?.message || '回滚失败', 'err');
      toast(`已回滚到 ${time.textContent} 之前的状态`, 'ok');
      await reload();
      refreshOps();
    };
    li.append(time, src, meta, btn);
    ul.appendChild(li);
  }
}

function renderSpaces(spaces) {
  const ul = $('spaceList');
  ul.innerHTML = '';
  $('spaceEmpty').classList.toggle('hidden', spaces.length > 0);
  for (const s of spaces) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'space-name';
    name.textContent = s.name;
    name.title = s.name;
    const meta = document.createElement('span');
    meta.className = 'ops-meta';
    meta.textContent = `${s.groups.length} 组、${s.tabCount} 标签`;
    const restore = document.createElement('button');
    restore.className = 'ops-btn ok';
    restore.title = '恢复空间（打开标签并建组）';
    restore.setAttribute('aria-label', '恢复空间 ' + s.name);
    restore.innerHTML = ICON_RESTORE;
    restore.onclick = async () => {
      restore.disabled = true;
      const res = await rpc({ type: 'space-restore', id: s.id });
      restore.disabled = false;
      if (!res?.ok) return toast(res?.message || '恢复失败', 'err');
      toast(`空间「${res.name}」已恢复：${res.tabs} 标签，${res.groups} 组`, 'ok');
      await reload();
    };
    const del = document.createElement('button');
    del.className = 'ops-btn danger';
    del.title = '删除空间';
    del.setAttribute('aria-label', '删除空间 ' + s.name);
    del.innerHTML = ICON_TRASH;
    let armed = false;
    del.onclick = async () => {
      if (!armed) {
        armed = true;
        del.classList.add('armed');
        del.title = '再点一次确认删除';
        setTimeout(() => { armed = false; del.classList.remove('armed'); del.title = '删除空间'; }, 2500);
        return;
      }
      await rpc({ type: 'space-delete', id: s.id });
      toast(`已删除空间「${s.name}」`, 'info');
      refreshOps();
    };
    li.append(name, meta, restore, del);
    ul.appendChild(li);
  }
}

$('spaceSave').onclick = async () => {
  const res = await rpc({ type: 'space-save', name: $('spaceName').value });
  if (!res?.ok) return toast(res?.message || '保存失败', 'err');
  $('spaceName').value = '';
  toast(`空间「${res.space.name}」已保存`, 'ok');
  refreshOps();
};

/* ---------------- 控制区 ---------------- */

$('scope').onchange = async () => {
  scope = $('scope').value === 'all' ? 'all' : Number($('scope').value);
  selectedGroups.clear();
  lastFollowKey = '';
  $('cleanupAdvice').classList.add('hidden');
  await reload();
};

function updateHomeSearchInput() {
  const search = parseSearchInput($('search').value, $('searchProvider').value);
  searchTerm = ['all', 'tabs'].includes(search.provider) ? search.query : '';
  $('openPalette').setAttribute('aria-haspopup', search.provider === 'google' ? 'false' : 'dialog');
  paint();
}
$('search').oninput = updateHomeSearchInput;

/* 折叠全部 / 展开全部：同样只作用于首页本地视图 */
$('collapseAll').onclick = () => {
  for (const w of data.windows) {
    localCollapsed.add(`u-${w.windowId}`);
    for (const g of w.groups) homeCollapsed.add(g.id);
  }
  persistCollapsed();
  paint();
};

$('expandAll').onclick = () => {
  for (const w of data.windows) {
    localCollapsed.delete(`u-${w.windowId}`);
    for (const g of w.groups) homeCollapsed.delete(g.id);
  }
  persistCollapsed();
  paint();
};

/* 快速查找可跨范围定位；折叠始终只更新首页本地状态。 */
async function focusGroup({ groupId, windowId }) {
  const id = String(groupId ?? '');
  if (!id) return;
  searchTerm = '';
  $('search').value = '';
  if (windowId != null && scope !== 'all' && Number(scope) !== Number(windowId)) {
    scope = 'all';
    await buildScopeOptions();
  }
  if (id.startsWith('u-')) localCollapsed.delete(id);
  else { homeCollapsed.delete(Number(id)); persistCollapsed(); }
  await reload();
  const el = document.querySelector(`.sp-group[data-group-id="${CSS.escape(id)}"]`);
  if (!el) return toast('该分组已关闭或不在当前窗口范围。', 'info');
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.querySelector('.sp-group-head')?.focus({ preventScroll: true });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1000);
}
document.addEventListener('tt-focus-group', e => {
  e.preventDefault();
  focusGroup(e.detail || {}).catch(err => toast(`无法定位分组：${err.message}`, 'err'));
});
$('workspaceSearch').onsubmit = async event => {
  event.preventDefault();
  const raw = $('search').value;
  const baseProvider = $('searchProvider').value;
  const { query, provider, prefix } = parseSearchInput(raw, baseProvider);
  const direct = !prefix && ['all', 'tabs'].includes(provider) && typeof parseDirectUrl === 'function' ? parseDirectUrl(query) : null;
  if (direct) {
    try {
      const ownSearch = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('search.html') : '';
      const tabs = chrome.tabs?.query ? await chrome.tabs.query({}) : [];
      const existing = tabs.find(t => (!ownSearch || !t.url?.startsWith(ownSearch))
        && (typeof urlsMatchForDirectJump === 'function' ? urlsMatchForDirectJump(t.url, direct.url) : t.url === direct.url));
      if (existing) {
        await chrome.tabs.update(existing.id, { active: true });
        if (Number.isInteger(existing.windowId)) await chrome.windows?.update?.(existing.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ ...(Number.isInteger(data.currentId) ? { windowId: data.currentId } : {}), url: direct.url, active: true });
      }
    } catch (error) {
      toast(`无法打开网址：${error.message}`, 'err');
    }
    return;
  }
  if (['bookmarks', 'google'].includes(provider) && !query) return toast('请输入搜索关键词。', 'info');
  if ([...query].length > 200) return toast('搜索关键词最多 200 个字符。', 'err');
  if (provider === 'google') {
    try { await chrome.tabs.create({ ...(Number.isInteger(data.currentId) ? { windowId: data.currentId } : {}), url: 'https://www.google.com/search?q=' + encodeURIComponent(query), active: true }); }
    catch (error) { toast(`无法打开 Google：${error.message}`, 'err'); }
    return;
  }
  document.dispatchEvent(new CustomEvent('tt-open-palette', { detail: { query: raw, provider: baseProvider } }));
};
$('searchProvider').onchange = () => {
  const provider = $('searchProvider').value;
  const placeholders = {
    all: '搜索标签、书签（b 关键词）、历史（h 关键词）或 Google（g 关键词）…',
    tabs: '筛选标签标题、链接或分组…',
    bookmarks: '按标题、文件夹或网址搜索书签…',
    history: '按关键字或网址搜索浏览历史…',
    google: '输入 Google 搜索关键词…',
  };
  const msg = typeof translateUiText === 'function' ? translateUiText(placeholders[provider]) : placeholders[provider];
  $('search').placeholder = msg;
  $('search').setAttribute('aria-label', msg);
  document.querySelectorAll?.('#sourceChips .source-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === provider);
  });
  updateHomeSearchInput();
};
document.querySelectorAll?.('#sourceChips .source-chip').forEach(btn => {
  btn.onclick = () => {
    $('searchProvider').value = btn.dataset.provider;
    $('searchProvider').onchange();
    $('search').focus();
  };
});
$('searchShortcutSettings').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
function refreshSearchShortcut() {
  return refreshSearchCommand($('searchShortcutStatus'), $('extensionStatus'), $('searchShortcutHint'));
}
async function refreshBookmarkIndexStatus() {
  const el = $('bookmarkIndexStatus');
  if (!el) return;
  try {
    if (!chrome.bookmarks?.getTree) { el.textContent = '已启用本地书签与浏览历史实时检索。'; return; }
    const tree = await chrome.bookmarks.getTree();
    let count = 0;
    const walk = nodes => { for (const n of nodes || []) { if (n.url) count++; if (n.children) walk(n.children); } };
    walk(tree);
    el.textContent = `已索引 ${count} 条本地书签，支持 b 关键词或综合模式即时搜索。`;
  } catch { el.textContent = '无法读取浏览器书签数量，标签与历史搜索仍可使用。'; }
}
if ($('bookmarkStatusRefresh')) {
  $('bookmarkStatusRefresh').onclick = async () => {
    const button = $('bookmarkStatusRefresh'); button.disabled = true; button.textContent = '统计中…';
    try { await refreshBookmarkIndexStatus(); }
    finally { button.disabled = false; button.textContent = '刷新统计'; }
  };
}
window.addEventListener('focus', () => { refreshSearchShortcut(); refreshBookmarkIndexStatus(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingFollowScroll) paint();
});

if ($('orgCaret') && $('orgPop')) {
  const toolbarEl = $('orgCaret').closest('.toolbar');
  const alignOrgPop = () => {
    const pop = $('orgPop');
    const wrap = pop.parentElement;
    if (!pop || !wrap || pop.classList.contains('hidden')) return;
    pop.style.left = '';
    pop.style.right = '';
    const wr = wrap.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const margin = 12;
    // Prefer right-aligned to the split button unless that overflows the left viewport edge.
    if (wr.right - pr.width < margin) {
      pop.style.left = `${Math.max(margin - wr.left, 0)}px`;
      pop.style.right = 'auto';
    } else if (wr.right > window.innerWidth - margin) {
      pop.style.right = `${Math.max(wr.right - (window.innerWidth - margin), 0)}px`;
      pop.style.left = 'auto';
    }
  };
  const setOrgPop = open => {
    $('orgPop').classList.toggle('hidden', !open);
    toolbarEl?.classList?.toggle('pop-open', open);
    $('orgCaret').setAttribute('aria-expanded', String(open));
    if (open) alignOrgPop();
  };
  window.addEventListener('resize', alignOrgPop);
  $('orgCaret').onclick = e => {
    e.stopPropagation();
    setOrgPop($('orgPop').classList.contains('hidden'));
  };
  document.addEventListener('click', e => {
    if (!$('orgPop').classList.contains('hidden') && !$('orgPop').contains(e.target) && e.target !== $('orgCaret')) {
      setOrgPop(false);
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('orgPop').classList.contains('hidden')) setOrgPop(false);
  });
}
if ($('archiveOpenBtn') && $('archiveDrawerModal')) {
  $('archiveOpenBtn').onclick = () => {
    $('orgPop')?.classList.add('hidden');
    $('orgCaret')?.closest('.toolbar')?.classList?.remove('pop-open');
    $('archiveDrawerModal').classList.remove('hidden');
  };
}
if ($('archiveCloseBtn') && $('archiveDrawerModal')) {
  $('archiveCloseBtn').onclick = () => {
    $('archiveDrawerModal').classList.add('hidden');
  };
  $('archiveDrawerModal').onclick = e => {
    if (e.target === $('archiveDrawerModal')) $('archiveDrawerModal').classList.add('hidden');
  };
}
if ($('batchCancelBtn')) {
  $('batchCancelBtn').onclick = () => {
    selectedGroups.clear();
    paint();
  };
}
if ($('cleanupToggleBtn') && $('cleanupCandidates')) {
  $('cleanupToggleBtn').onclick = () => {
    const hidden = $('cleanupCandidates').classList.toggle('hidden');
    $('cleanupToggleBtn').textContent = hidden ? '查看清单' : '收起清单';
  };
}
if ($('topSearchBtn')) {
  $('topSearchBtn').onclick = () => {
    $('orgPop')?.classList.add('hidden');
    $('orgCaret')?.closest('.toolbar')?.classList?.remove('pop-open');
    document.dispatchEvent(new CustomEvent('tt-open-palette', { detail: { query: $('search').value, provider: $('searchProvider').value } }));
  };
}
if ($('openSettings') && $('settingsDrawer')) {
  $('openSettings').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.sidePanel?.open && Number.isInteger(data?.currentId)) {
      chrome.sidePanel.open({ windowId: data.currentId }).catch(() => rpc({ type: 'open-sidepanel' }).catch(() => {}));
    } else {
      rpc({ type: 'open-sidepanel' }).catch(() => {});
    }
  });
}

async function saveSettings(patch) {
  const { settings: stored } = await chrome.storage.sync.get('settings');
  settings = { ...(stored || settings), ...patch };
  await chrome.storage.sync.set({ settings });
}

$('autoOrganize').onchange = e => {
  saveSettings({ autoOrganize: e.target.checked });
  toast(e.target.checked ? '新标签自动归组已开启' : '新标签自动归组已关闭');
};
if ($('autoDelay') && typeof initAutoDelayControl !== 'function') {
  $('autoDelay').onchange = async () => {
    const delay = normalizeAutoDelay($('autoDelay').value);
    await saveSettings({ autoOrganizeDelaySeconds: delay });
    const label = typeof formatAutoDelayLabel === 'function' ? formatAutoDelayLabel(delay) : `${delay} 秒`;
    toast(`自动整理等待：${label}`, 'ok');
  };
}
if ($('autoDiscardEnabled')) {
  $('autoDiscardEnabled').onchange = e => {
    saveSettings({ autoDiscardEnabled: e.target.checked });
    toast(e.target.checked ? '已开启空闲标签自动休眠模式' : '已关闭空闲标签自动休眠模式', 'ok');
  };
}
$('autoHome').onchange = e => {
  saveSettings({ autoOrganizeOnHome: e.target.checked });
  toast(e.target.checked ? '打开首页将自动整理未分组标签' : '首页自动整理已关闭');
};
$('density').onchange = e => {
  document.body.classList.toggle('compact', e.target.checked);
  saveSettings({ density: e.target.checked ? 'compact' : 'comfortable' });
};
if ($('interceptDuplicates')) {
  $('interceptDuplicates').onchange = e => {
    saveSettings({ interceptDuplicates: e.target.checked });
    toast(e.target.checked ? '新开重复标签实时拦截已开启' : '新开重复标签实时拦截已关闭', 'ok');
  };
}
if ($('showPageSearchPill')) {
  $('showPageSearchPill').onchange = e => {
    saveSettings({ showPageSearchPill: e.target.checked });
    toast(e.target.checked ? '普通网页右侧悬浮搜索胶囊已开启' : '普通网页右侧悬浮搜索胶囊已隐藏', 'ok');
  };
}
if ($('whitelistAdd')) {
  $('whitelistAdd').onclick = async () => {
    const val = ($('whitelistInput')?.value || '').trim();
    if (!val) return toast('请输入域名或网址', 'info');
    const res = await rpc({ type: 'dup-whitelist-add', url: val });
    if (!res?.ok) return toast(res?.message || '添加失败', 'err');
    $('whitelistInput').value = '';
    toast(`已加入去重白名单：${val}`, 'ok');
    await reload();
  };
}

let currentInterceptedDup = null;
function renderInterceptedDup(record) {
  currentInterceptedDup = record || null;
  const banner = $('dupInterceptBanner');
  if (!banner) return;
  if (!record || !record.url || Date.now() - (record.at || 0) > 120000) {
    banner.classList.add('hidden');
    return;
  }
  $('dupInterceptText').textContent = `已拦截重复新开标签并跳转至已打开页：${cleanTitle(record.existingTitle || record.url, record.url)}`;
  banner.classList.remove('hidden');
}
if ($('dupForceOpen')) {
  $('dupForceOpen').onclick = async () => {
    if (!currentInterceptedDup?.url) return;
    await rpc({ type: 'force-open-duplicate', url: currentInterceptedDup.url, windowId: currentInterceptedDup.windowId });
    renderInterceptedDup(null);
  };
}
if ($('dupWhitelistHost')) {
  $('dupWhitelistHost').onclick = async () => {
    if (!currentInterceptedDup) return;
    const target = currentInterceptedDup.host || currentInterceptedDup.url;
    await rpc({ type: 'dup-whitelist-add', host: target, url: target });
    await rpc({ type: 'clear-intercepted-dup' });
    renderInterceptedDup(null);
    toast(`已将 ${target} 加入防重复白名单`, 'ok');
    await reload();
  };
}
if ($('dupDismiss')) {
  $('dupDismiss').onclick = async () => {
    await rpc({ type: 'clear-intercepted-dup' });
    renderInterceptedDup(null);
  };
}

/* 新标签页接管自检：空白新标签在后台不加载 NTP，必须激活才解析接管；
 * tab.url 可能仍报 chrome://newtab，故用 URL + 标题双信号；验完关探针并把焦点还回本页。 */
$('newtabCheck').onclick = async () => {
  const btn = $('newtabCheck');
  const status = $('newtabStatus');
  btn.disabled = true;
  status.textContent = '检测中…';
  const me = await chrome.tabs.getCurrent();
  let tab = null, hit = false, seenUrl = '';
  try {
    tab = await chrome.tabs.create({ active: true });
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300));
      const x = await chrome.tabs.get(tab.id);
      seenUrl = x.url || x.pendingUrl || '';
      if (seenUrl.startsWith(chrome.runtime.getURL('home.html')) || x.title === document.title) { hit = true; break; }
    }
  } catch { /* 探针失败按未生效报 */ }
  if (tab) { try { await chrome.tabs.remove(tab.id); } catch { /* 已关 */ } }
  if (me) { try { await chrome.tabs.update(me.id, { active: true }); } catch { /* 忽略 */ } }
  status.textContent = hit
    ? '已生效：新标签页 = 工作台'
    : `未生效：${seenUrl || '未知地址'}。Chrome 只允许一个扩展接管新标签页，请到 chrome://extensions 停用其他新标签页扩展；主页按钮/启动页设为 chrome://newtab 即进工作台`;
  status.title = status.textContent;
  toast(hit ? '新标签页接管已生效' : '接管被其他扩展或策略占用', hit ? 'ok' : 'err');
  btn.disabled = false;
};

document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing) return;
  const tag = document.activeElement?.tagName || '';
  if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(tag)) {
    e.preventDefault();
    $('search').focus();
  }
  if (e.key === 'Escape' && document.activeElement === $('search')) {
    $('search').value = '';
    searchTerm = '';
    paint();
    $('search').blur();
  }
});

/* ---------------- 事件 ---------------- */

for (const ev of ['onCreated', 'onRemoved', 'onAttached', 'onDetached', 'onMoved', 'onActivated']) {
  chrome.tabs[ev]?.addListener(scheduleReload);
}
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.title || info.status === 'complete' || info.groupId !== undefined || info.active) scheduleReload();
});
for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onMoved']) {
  chrome.tabGroups[ev].addListener(scheduleReload);
}
chrome.windows.onFocusChanged.addListener(scheduleReload);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) {
    const s = changes.settings.newValue || {};
    settings = s;
    $('autoOrganize').checked = !!s.autoOrganize;
    if (autoDelayCtrl) autoDelayCtrl.setValue(s.autoOrganizeDelaySeconds);
    else paintAutoDelay($('autoDelay'), s.autoOrganizeDelaySeconds);
    if ($('autoDiscardEnabled')) $('autoDiscardEnabled').checked = !!s.autoDiscardEnabled;
    if (autoDiscardCtrl) autoDiscardCtrl.setValue(s.autoDiscardMinutes);
    else if (typeof paintAutoDiscard === 'function' && $('autoDiscardMinutes')) paintAutoDiscard($('autoDiscardMinutes'), s.autoDiscardMinutes);
    $('autoHome').checked = s.autoOrganizeOnHome !== false;
    $('density').checked = s.density === 'compact';
    if ($('interceptDuplicates')) $('interceptDuplicates').checked = s.interceptDuplicates !== false;
    if ($('showPageSearchPill')) $('showPageSearchPill').checked = s.showPageSearchPill !== false;
    document.body.classList.toggle('compact', s.density === 'compact');
    refreshOps();
  }
  if (area === 'local' && (changes.orgHistory || changes.spaces)) refreshOps();
  if (area === 'local' && changes.tabMetaCache) {
    tabMeta = changes.tabMetaCache.newValue || {};
    paint();
  }
  if (area === 'local' && changes.lockedGroupIds) {
    const raw = changes.lockedGroupIds.newValue;
    lockedGroups = new Set(Array.isArray(raw) ? raw.filter(id => Number.isInteger(id) && id >= 0) : []);
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
  if (area === 'local' && changes.groupArchives) refreshGroupArchives();
  if (area === 'session' && changes.activeWorkTabs) scheduleReload();
  if (area === 'session' && changes.lastCleanupAdvice) renderCleanupAdvice(changes.lastCleanupAdvice.newValue);
  if (area === 'session' && changes.lastInterceptedDup) renderInterceptedDup(changes.lastInterceptedDup.newValue);
  if (area === 'session' && changes.lastRun) {
    const summary = analysisSummary(changes.lastRun.newValue);
    if (summary) $('contextStatus').textContent = `最近一次整理：${summary}`;
    refreshCleanupAdvice();
  }
});

/* ---------------- 初始化 ---------------- */

(async function init() {
  if (await homeEntryReady) return;
  const { settings: s } = await chrome.storage.sync.get('settings');
  settings = s || {};
  $('autoOrganize').checked = !!settings.autoOrganize;
  if (typeof initAutoDelayControl === 'function') {
    autoDelayCtrl = initAutoDelayControl({
      selectEl: $('autoDelay'),
      customRowEl: $('autoDelayCustomRow'),
      valueInputEl: $('autoDelayCustomValue'),
      unitSelectEl: $('autoDelayCustomUnit'),
      applyBtnEl: $('autoDelayCustomApply'),
      cancelBtnEl: $('autoDelayCustomCancel'),
      initialValue: settings.autoOrganizeDelaySeconds,
      onSave: delay => saveSettings({ autoOrganizeDelaySeconds: delay }),
    });
  } else {
    paintAutoDelay($('autoDelay'), settings.autoOrganizeDelaySeconds);
  }
  if ($('autoDiscardEnabled')) $('autoDiscardEnabled').checked = !!settings.autoDiscardEnabled;
  if ($('autoDiscardMinutes') && typeof initAutoDiscardControl === 'function') {
    autoDiscardCtrl = initAutoDiscardControl({
      selectEl: $('autoDiscardMinutes'),
      customRowEl: $('autoDiscardCustomRow'),
      valueInputEl: $('autoDiscardCustomValue'),
      unitSelectEl: $('autoDiscardCustomUnit'),
      applyBtnEl: $('autoDiscardCustomApply'),
      cancelBtnEl: $('autoDiscardCustomCancel'),
      initialValue: settings.autoDiscardMinutes,
      onSave: mins => saveSettings({ autoDiscardMinutes: mins }),
    });
  }
  const { lastRun, lastCleanupAdvice, lastInterceptedDup } = await chrome.storage.session.get(['lastRun', 'lastCleanupAdvice', 'lastInterceptedDup']);
  if (lastCleanupAdvice) renderCleanupAdvice(lastCleanupAdvice);
  if (lastInterceptedDup) renderInterceptedDup(lastInterceptedDup);
  const summary = analysisSummary(lastRun);
  if (summary) $('contextStatus').textContent = `最近一次整理：${summary}`;
  $('autoHome').checked = settings.autoOrganizeOnHome !== false;
  $('density').checked = settings.density === 'compact';
  if ($('interceptDuplicates')) $('interceptDuplicates').checked = settings.interceptDuplicates !== false;
  if ($('showPageSearchPill')) $('showPageSearchPill').checked = settings.showPageSearchPill !== false;
  document.body.classList.toggle('compact', settings.density === 'compact');

  await buildScopeOptions();
  await reload();
  refreshOps();
  let updateCtrl = null;
  let modelCtrl = null;
  const wakeFromPill = async () => {
    const res = await updateCtrl?.attemptWake?.();
    if (res && !res.ok && res.reason === 'no_host') {
      try { $('settingsDrawer')?.showPopover?.(); } catch { /* ignore */ }
    }
  };
  refreshHealthPill($('health'), { onStartRequest: wakeFromPill });
  refreshSearchShortcut();
  refreshBookmarkIndexStatus();
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
    paint();
    refreshOps();
    refreshCleanupAdvice();
    refreshHealthPill($('health'), { onStartRequest: wakeFromPill });
  });

  const link = new URLSearchParams(location.search);
  if (link.has('focusGroup')) {
    await focusGroup({ groupId: link.get('focusGroup'), windowId: link.get('windowId') });
    history.replaceState(null, '', location.pathname);
    return;
  }

  // 打开首页自动整理：仅当当前窗口监测到真正“新增”的未分组标签时才调用 AI 整理，减少或无变化时不消耗 Token
  if (settings.autoOrganizeOnHome !== false) {
    const mon = await rpc({ type: 'check-home-auto-organize', windowId: data.currentId }).catch(() => null);
    if (mon?.shouldOrganize && mon.newCount > 0) {
      toast(`监测到 ${mon.newCount} 个新增标签，开始增量整理…`);
      await runOrganize({ windowId: data.currentId, incremental: true });
    }
  }
})();