/* 网页右侧轻量搜索胶囊（ISOLATED World + Closed Shadow DOM）
 * 仅由 background 通过 chrome.scripting.registerContentScripts 动态挂载在 http(s) 页面。
 * 自动跟随扩展主题（Dusk 深色 / Crisp Daylight 浅色）与中英双语设置。
 */
(() => {
  if (globalThis.__aiTabPagePillLoaded) return;
  globalThis.__aiTabPagePillLoaded = true;

  if (!/^https?:$/.test(location.protocol) || window.top !== window) return;

  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
  const defaultShortcut = isMac ? '⌘K' : 'Ctrl+K';
  const themeMQ = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : { matches: true };

  let pillHost = null;
  let pillRefs = null;
  let currentThemeMode = 'dark';
  let currentLang = 'zh';
  let dragging = false;
  let moved = false;
  let dragPointerId = null;

  const notify = message => {
    try { return chrome.runtime.sendMessage(message)?.catch?.(() => null); } catch { return Promise.resolve(null); }
  };

  function resolveTheme(mode) {
    if (mode === 'light') return 'light';
    if (mode === 'auto') return themeMQ.matches ? 'dark' : 'light';
    return 'dark';
  }

  function applyAppearance() {
    if (!pillRefs) return;
    const { btn, kbd, label, closeBtn } = pillRefs;
    const isEn = currentLang === 'en';
    btn.dataset.theme = resolveTheme(currentThemeMode);
    kbd.textContent = defaultShortcut;
    label.textContent = isEn ? 'Search Tabs / Bookmarks' : '搜索标签 / 书签';
    btn.title = isEn ? 'Open TabLoom Search (⌘K · Drag vertically)' : '打开 AI 标签工作台全能搜索 (可上下拖拽)';
    closeBtn.title = isEn ? 'Hide floating search pill on this site' : '在此网站隐藏悬浮搜索胶囊';
    closeBtn.setAttribute('aria-label', closeBtn.title);
  }

  function unmountPill() {
    dragging = false;
    moved = false;
    dragPointerId = null;
    pillRefs = null;
    if (!pillHost) return;
    try { pillHost.remove(); } catch { /* ignore */ }
    pillHost = null;
  }

  function mountPill() {
    if (!document.body) return;
    if (pillHost?.isConnected && pillRefs) {
      applyAppearance();
      return;
    }
    unmountPill();

    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;right:0!important;top:42%!important;z-index:2147483645!important;display:block!important;pointer-events:auto!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .pill {
        display: inline-flex; align-items: center; gap: 7px;
        height: 36px; padding: 0 10px 0 12px;
        border-radius: 999px 0 0 999px;
        background: rgba(28, 31, 46, 0.92);
        backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2);
        border: 1px solid rgba(255, 255, 255, 0.14); border-right: 0;
        color: #f4f2ee; font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        box-shadow: -4px 8px 24px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.10);
        cursor: pointer; user-select: none;
        transform: translateX(calc(100% - 44px));
        transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), background 0.15s ease, border-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
      }
      .pill:hover, .pill:focus-visible {
        transform: translateX(0);
        background: rgba(36, 41, 58, 0.97);
        border-color: rgba(147, 159, 249, 0.52);
        outline: none;
      }
      .icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; color: #9ca8ff; flex-shrink: 0; }
      .label { white-space: nowrap; color: inherit; }
      .kbd {
        font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        padding: 3px 5px; border-radius: 5px;
        background: rgba(147, 159, 249, 0.16); color: #c7ceff;
        border: 1px solid rgba(147, 159, 249, 0.30);
      }
      .close {
        margin-left: 2px; width: 18px; height: 18px; border-radius: 50%;
        border: 0; background: transparent; color: #9ba3bc;
        font-size: 13px; line-height: 1; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .close:hover { background: rgba(255, 255, 255, 0.14); color: #ffffff; }

      .pill[data-theme="light"] {
        background: rgba(252, 250, 246, 0.94);
        border-color: rgba(35, 39, 58, 0.14);
        color: #1f2436;
        box-shadow: -4px 8px 22px rgba(24, 28, 45, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.85);
      }
      .pill[data-theme="light"]:hover, .pill[data-theme="light"]:focus-visible {
        background: rgba(255, 255, 255, 0.99);
        border-color: rgba(74, 85, 200, 0.45);
      }
      .pill[data-theme="light"] .icon { color: #4a55c8; }
      .pill[data-theme="light"] .kbd {
        background: rgba(74, 85, 200, 0.10);
        color: #3c46b2;
        border-color: rgba(74, 85, 200, 0.24);
      }
      .pill[data-theme="light"] .close { color: #5b6278; }
      .pill[data-theme="light"] .close:hover { background: rgba(35, 39, 58, 0.08); color: #1f2436; }
    `;

    const btn = document.createElement('div');
    btn.className = 'pill';
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;

    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

    const kbd = document.createElement('span');
    kbd.className = 'kbd';

    const label = document.createElement('span');
    label.className = 'label';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';

    let startY = 0;
    let startTop = 0;

    const finishDrag = e => {
      if (!dragging) return;
      dragging = false;
      if (dragPointerId !== null && typeof btn.hasPointerCapture === 'function' && btn.hasPointerCapture(dragPointerId)) {
        try { btn.releasePointerCapture(dragPointerId); } catch { /* ignore */ }
      }
      dragPointerId = null;
      if (moved) {
        globalThis.setTimeout?.(() => { moved = false; }, 0);
      }
    };

    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const target = e.target;
      if (target === closeBtn || closeBtn.contains?.(target)) return;
      dragging = true;
      moved = false;
      dragPointerId = e.pointerId ?? null;
      startY = e.clientY;
      startTop = host.getBoundingClientRect().top;
    });
    btn.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) > 6) {
        moved = true;
        if (dragPointerId !== null) {
          try { btn.setPointerCapture?.(dragPointerId); } catch { /* ignore */ }
        }
      }
      if (moved) {
        const nextTop = Math.min(Math.max(48, startTop + dy), window.innerHeight - 64);
        host.style.setProperty('top', `${nextTop}px`, 'important');
      }
    });
    btn.addEventListener('pointerup', finishDrag);
    btn.addEventListener('pointercancel', () => { dragging = false; moved = false; dragPointerId = null; });

    closeBtn.addEventListener('click', e => {
      e.stopPropagation();
      unmountPill();
      notify({ type: 'page-search-pill-hide-host', host: location.hostname });
    });

    const triggerSearch = () => {
      if (moved) { moved = false; return; }
      notify({ type: 'page-search-pill-trigger' });
    };

    btn.addEventListener('click', triggerSearch);
    btn.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        triggerSearch();
      }
    });

    btn.append(icon, kbd, label, closeBtn);
    shadow.append(style, btn);
    document.body.append(host);
    pillHost = host;
    pillRefs = { btn, kbd, label, closeBtn };
    applyAppearance();
  }

  async function syncFromStorage() {
    try {
      const stored = await chrome.storage.sync.get(['settings', 'themeMode', 'uiLang']);
      const settings = stored?.settings || {};
      if (typeof stored?.themeMode === 'string') currentThemeMode = stored.themeMode;
      if (typeof stored?.uiLang === 'string') currentLang = stored.uiLang === 'en' ? 'en' : 'zh';
      const show = settings.showPageSearchPill !== false;
      const hiddenHosts = Array.isArray(settings.pillHiddenHosts) ? settings.pillHiddenHosts : [];
      const host = location.hostname.replace(/^www\./, '').toLowerCase();
      if (!show || hiddenHosts.includes(host) || hiddenHosts.includes(location.hostname)) {
        unmountPill();
      } else {
        mountPill();
      }
    } catch { /* ignore */ }
  }

  if (document.body) syncFromStorage();
  else window.addEventListener('DOMContentLoaded', syncFromStorage, { once: true });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.themeMode) currentThemeMode = changes.themeMode.newValue || 'dark';
    if (changes.uiLang) currentLang = changes.uiLang.newValue === 'en' ? 'en' : 'zh';
    if (changes.settings || changes.themeMode || changes.uiLang) syncFromStorage();
  });

  themeMQ.addEventListener?.('change', () => {
    if (currentThemeMode === 'auto') applyAppearance();
  });

  chrome.runtime?.onMessage?.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'show-dup-intercept-toast') {
      if (globalThis.__aiPageSearchBridge) {
        globalThis.__aiPageSearchBridge('show-dup-toast', msg);
      }
      sendResponse?.({ ok: true });
    }
  });
})();
