/* Homepage-only settings layout. A dock is a normal landmark, never a top-layer
 * popover: search can cover it, and the tab ledger gets its own remaining width. */
(() => {
  const drawer = document.getElementById('settingsDrawer');
  const opener = document.getElementById('openSettings');
  const pin = document.getElementById('pinSettings');
  const close = document.getElementById('closeSettings');
  if (!drawer || !opener || !pin || !close) return;
  const key = 'homeSettingsLayout';
  const wide = matchMedia('(min-width: 1000px)');
  let state = { pinned: true, visible: true };
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && typeof saved.pinned === 'boolean' && typeof saved.visible === 'boolean') state = { pinned: saved.pinned, visible: saved.visible };
  } catch { /* Corrupt/blocked storage falls back to a usable desktop dock. */ }
  const persist = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* Layout still works without storage. */ } };
  const floatingOpen = () => drawer.matches(':popover-open');
  const docked = () => document.body.classList.contains('settings-docked');
  function updateExpanded() {
    const visible = docked() || floatingOpen();
    opener.setAttribute('aria-expanded', String(visible));
    opener.title = visible ? '关闭整理设置' : '打开整理设置';
  }
  function render({ showFloating = false, focus = null } = {}) {
    if (floatingOpen()) drawer.hidePopover();
    const useDock = wide.matches && state.pinned && state.visible;
    document.body.classList.toggle('settings-docked', useDock);
    drawer.dataset.docked = String(useDock);
    pin.setAttribute('aria-pressed', String(state.pinned));
    pin.title = state.pinned && !wide.matches
      ? '宽屏时常驻；窄屏按需打开抽屉，不挤压标签区域'
      : '常驻侧栏，刷新后保持打开；关闭可暂时收起';
    if (useDock) {
      drawer.removeAttribute('popover');
      drawer.setAttribute('role', 'complementary');
      opener.removeAttribute('aria-haspopup');
    } else {
      drawer.setAttribute('popover', 'auto');
      drawer.setAttribute('role', 'dialog');
      opener.setAttribute('aria-haspopup', 'dialog');
      if (showFloating && state.visible) drawer.showPopover();
    }
    updateExpanded();
    if (focus && (useDock || floatingOpen())) focus.focus({ preventScroll: true });
  }
  function hide() {
    state.visible = false;
    persist(); render();
    opener.focus({ preventScroll: true });
  }
  opener.addEventListener('click', () => {
    if (docked() || floatingOpen()) return hide();
    state.visible = true;
    persist(); render({ showFloating: true, focus: pin });
  });
  pin.addEventListener('click', () => {
    state.pinned = !state.pinned;
    state.visible = true;
    persist(); render({ showFloating: true, focus: pin });
  });
  close.addEventListener('click', hide);
  drawer.addEventListener('toggle', updateExpanded);
  drawer.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !floatingOpen()) return;
    event.preventDefault();
    drawer.hidePopover();
    opener.focus({ preventScroll: true });
    updateExpanded();
  });
  wide.addEventListener('change', () => {
    const active = drawer.contains(document.activeElement) ? document.activeElement : null;
    const keepFloating = !state.pinned && floatingOpen();
    render({ showFloating: keepFloating, focus: active });
    if (active && !docked() && !floatingOpen()) opener.focus({ preventScroll: true });
  });
  // A compact viewport starts unobstructed. The stored wide-screen preference is
  // unchanged, so widening restores the dock without requiring another pin action.
  render();
})();
