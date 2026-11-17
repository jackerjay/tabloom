/* Runs only in the top frame's ISOLATED world. The host gets no search data,
 * inputs, listeners or postMessage capability: the UI lives at extension origin. */
(() => {
  if (globalThis.__aiPageSearchBridge) return;
  let current = null;
  let pillHost = null;
  let toastHost = null;
  const notify = message => {
    try { chrome.runtime.sendMessage(message)?.catch?.(() => {}); } catch { /* Extension reload. */ }
  };
  const removePill = () => {
    if (!pillHost) return false;
    try { pillHost.remove(); } catch { /* ignore */ }
    pillHost = null;
    return true;
  };
  const removeToast = () => {
    if (!toastHost) return false;
    try { toastHost.remove(); } catch { /* ignore */ }
    toastHost = null;
    return true;
  };
  const mountPill = (options = {}) => {
    if (!/^https?:$/.test(location.protocol) || !document.documentElement || typeof document.body?.append !== 'function') {
      return { ok: false };
    }
    if (pillHost?.isConnected) return { ok: true, exists: true };
    removePill();
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
        box-shadow: -4px 8px 24px rgba(0, 0, 0, 0.40);
        cursor: pointer; user-select: none;
        transform: translateX(calc(100% - 44px));
        transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), background 0.15s ease, border-color 0.15s ease;
      }
      .pill:hover {
        transform: translateX(0);
        background: rgba(36, 41, 58, 0.97);
        border-color: rgba(147, 159, 249, 0.52);
      }
      .icon { display: inline-flex; align-items: center; color: #9ca8ff; flex-shrink: 0; }
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
      .close:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
      .pill[data-theme="light"] {
        background: rgba(252, 250, 246, 0.94);
        border-color: rgba(35, 39, 58, 0.14);
        color: #1f2436;
        box-shadow: -4px 8px 22px rgba(24, 28, 45, 0.12);
      }
      .pill[data-theme="light"]:hover {
        background: rgba(255, 255, 255, 0.99);
        border-color: rgba(74, 85, 200, 0.45);
      }
      .pill[data-theme="light"] .icon { color: #4a55c8; }
      .pill[data-theme="light"] .kbd { background: rgba(74, 85, 200, 0.10); color: #3c46b2; border-color: rgba(74, 85, 200, 0.24); }
      .pill[data-theme="light"] .close { color: #5b6278; }
      .pill[data-theme="light"] .close:hover { background: rgba(35, 39, 58, 0.08); color: #1f2436; }
    `;
    const btn = document.createElement('div');
    btn.className = 'pill';
    btn.dataset.theme = options.theme === 'light' ? 'light' : 'dark';
    btn.title = '打开 AI 标签工作台全能搜索 (⌘K)';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
    const kbd = document.createElement('span');
    kbd.className = 'kbd';
    kbd.textContent = options.shortcut || '⌘K';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '搜索标签 / 书签';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.type = 'button';
    closeBtn.title = '在此域名隐藏悬浮球';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      removePill();
      notify({ type: 'page-search-pill-hide-host', host: location.hostname });
    });
    btn.addEventListener('click', () => {
      notify({ type: 'page-search-pill-trigger' });
    });
    btn.append(icon, kbd, label, closeBtn);
    shadow.append(style, btn);
    document.body.append(host);
    pillHost = host;
    return { ok: true };
  };
  const showDupToast = (options = {}) => {
    if (!/^https?:$/.test(location.protocol) || !document.body?.append) return { ok: false };
    removeToast();
    const host = document.createElement('div');
    host.style.cssText = 'all:initial!important;position:fixed!important;top:16px!important;right:16px!important;z-index:2147483646!important;display:block!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .toast {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        max-width: 480px; padding: 11px 14px; border-radius: 12px;
        background: rgba(19, 23, 34, 0.95);
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(229, 161, 88, 0.45);
        box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45);
        color: #f1f3f9; font: 500 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .badge {
        padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
        background: rgba(229, 161, 88, 0.16); color: #f6b96e;
      }
      .act {
        padding: 4px 9px; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.06); color: #e2e7f5;
        font-size: 11.5px; font-weight: 600; cursor: pointer;
      }
      .act:hover { background: rgba(110, 123, 242, 0.22); border-color: rgba(110, 123, 242, 0.45); }
    `;
    const box = document.createElement('div');
    box.className = 'toast';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '防重复拦截';
    const msg = document.createElement('span');
    msg.textContent = '已复用当前已打开的相同网页标签';
    const forceBtn = document.createElement('button');
    forceBtn.className = 'act';
    forceBtn.type = 'button';
    forceBtn.textContent = '仍然新开';
    forceBtn.addEventListener('click', () => {
      removeToast();
      notify({ type: 'force-open-duplicate', url: options.url, windowId: options.windowId });
    });
    const wlBtn = document.createElement('button');
    wlBtn.className = 'act';
    wlBtn.type = 'button';
    wlBtn.textContent = '加白域名';
    wlBtn.addEventListener('click', () => {
      removeToast();
      notify({ type: 'dup-whitelist-add', host: options.host || location.hostname });
    });
    box.append(badge, msg, forceBtn, wlBtn);
    shadow.append(style, box);
    document.body.append(host);
    toastHost = host;
    setTimeout(() => { if (toastHost === host) removeToast(); }, 6500);
    return { ok: true };
  };
  const remove = restoreFocus => {
    if (!current) return false;
    const state = current;
    current = null;
    clearTimeout(state.timer);
    globalThis.removeEventListener('pagehide', state.pagehide);
    // Removing without dialog.close() intentionally avoids the dialog's native
    // focus restoration when a result has already navigated somewhere else.
    if (restoreFocus && state.dialog.open) state.dialog.close();
    state.host.remove();
    // Never focus the source after a result already activated another tab/window.
    if (restoreFocus && state.previousFocus?.isConnected) {
      try { state.previousFocus.focus({ preventScroll: true }); } catch { /* Detached/non-focusable. */ }
    }
    return true;
  };
  globalThis.__aiPageSearchBridge = (action, options = {}) => {
    if (action === 'mount-pill') return mountPill(options);
    if (action === 'unmount-pill') return { ok: removePill() };
    if (action === 'show-dup-toast') return showDupToast(options);
    // Only the service worker's trusted scripting caller uses reset, e.g. when
    // a tab attaches after its old window already discarded the nonce record.
    if (action === 'reset') return { ok: remove(false) };
    if (action === 'open') {
      if (current?.nonce === options.nonce && current.host.isConnected) return { ok: true, exists: true };
      remove(false);
      if (!/^https?:$/.test(location.protocol) || !document.documentElement) throw new Error('页面不支持原位搜索');
      const host = document.createElement('div');
      // Only this transparent, empty container is visible in the host DOM.
      host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:2147483647!important;display:block!important;background:transparent!important;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = 'dialog::backdrop{background:transparent!important}';
      const dialog = document.createElement('dialog');
      dialog.tabIndex = -1;
      dialog.style.cssText = 'all:initial;position:fixed;inset:0;margin:0;padding:0;border:0;max-width:none;max-height:none;width:100vw;height:100vh;background:transparent;overflow:hidden;';
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        if (current?.nonce !== options.nonce) return;
        // Local escape must never depend on a live worker/session record.
        remove(true);
        notify({ type: 'page-search-overlay-dismiss', nonce: options.nonce });
      });
      const iframe = document.createElement('iframe');
      iframe.title = '搜索标签、书签与 Google';
      iframe.tabIndex = 0;
      iframe.autofocus = true;
      iframe.allow = 'clipboard-write';
      iframe.style.cssText = 'border:0;position:fixed;inset:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal;';
      iframe.src = chrome.runtime.getURL('search.html') + '?embedded=' + encodeURIComponent(options.nonce);
      const state = { host, dialog, iframe, nonce: options.nonce, targetTabId: options.targetTabId,
        previousFocus: document.activeElement, authorized: false, timer: null, pagehide: null };
      current = state;
      const focusFrame = () => {
        if (current !== state || !state.host.isConnected) return;
        try { iframe.focus({ preventScroll: true }); } catch { iframe.focus(); }
      };
      iframe.addEventListener('load', () => {
        if (current !== state) return;
        focusFrame();
        globalThis.requestAnimationFrame?.(focusFrame);
        notify({ type: 'page-search-overlay-loaded', nonce: state.nonce });
      });
      iframe.addEventListener('error', () => {
        if (current === state) notify({ type: 'page-search-overlay-failed', nonce: state.nonce });
      });
      state.pagehide = () => {
        if (current !== state) return;
        remove(false);
        notify({ type: 'page-search-overlay-gone', nonce: state.nonce });
      };
      globalThis.addEventListener('pagehide', state.pagehide, { once: true });
      dialog.append(iframe);
      shadow.append(style, dialog);
      document.documentElement.append(host);
      // Native top layer works above existing webpage dialogs/popovers and inert
      // backgrounds; z-index alone cannot provide that guarantee.
      dialog.showModal();
      focusFrame();
      // load alone can mean an error document. Only the runtime handshake proves
      // that the real extension iframe initialized despite the page's CSP.
      state.timer = setTimeout(() => {
        if (current === state && !state.authorized) notify({ type: 'page-search-overlay-failed', nonce: state.nonce });
      }, 7000);
      return { ok: true };
    }
    if (!current || current.nonce !== options.nonce) return { ok: false, missing: true };
    if (action === 'authorized') {
      current.authorized = true;
      clearTimeout(current.timer);
      try { current.iframe.focus({ preventScroll: true }); } catch { current.iframe.focus(); }
      return { ok: true };
    }
    if (action === 'close') return { ok: remove(options.restoreFocus === true) };
    if (action === 'focus') {
      if (!current.host.isConnected) { remove(false); return { ok: false, missing: true }; }
      try { current.iframe.focus({ preventScroll: true }); } catch { current.iframe.focus(); }
      return { ok: true };
    }
    return { ok: false };
  };
})();
