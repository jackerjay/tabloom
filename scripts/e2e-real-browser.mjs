#!/usr/bin/env node
/**
 * Real E2E Autonomous Verification (Unpacked MV3 Extension + Real Brave Browser + CDP)
 * Verifies:
 *  1. Real MV3 extension load on chrome://newtab -> home.html + live service worker
 *  2. Real Chrome native tabs & tabGroups rendering + zero console/page errors
 *  3. Exact regression of media_1794815067338_11948d3b.png: #orgPop hit-test layering
 *     above .suggest and .sp-group in BOTH light & dark themes at 1440px and 900px
 *  4. #archiveDrawerModal and #palette hit-test layering (3x3 elementFromPoint grid)
 *  5. Real proactive duplicate tab interception in chrome.tabs.onCreated/onUpdated
 *  6. Real sidepanel.html responsive & dual-mode verification with zero horizontal overflow
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const extDir = path.join(repoRoot, 'extension');
const shotsDir = path.join(repoRoot, 'qa-shots');
mkdirSync(shotsDir, { recursive: true });

const BRAVE_BIN = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id == null) {
        for (const fn of this.events) fn(msg);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.data || ''})`));
      else p.resolve(msg.result);
    };
  }
  send(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new CdpPage(this, sessionId, targetId);
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

class CdpPage {
  constructor(client, sessionId, targetId) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }
  send(method, params = {}) {
    return this.client.send(method, params, this.sessionId);
  }
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval error');
    }
    return res.result?.value;
  }
  async click(selector) {
    const pt = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    assert(pt.w > 0 && pt.h > 0, `${selector} has zero dimensions`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  }
  async shot(filename) {
    await this.eval(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(shotsDir, filename), Buffer.from(data, 'base64'));
  }
}

async function until(fn, msg, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error(`${msg}${lastErr ? `: ${lastErr.message}` : ''}`);
}

const server = http.createServer((req, res) => {
  const slug = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/+/, '') || 'index';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Frontend Engineering · ${slug}</title><h1>Guide ${slug}</h1><p>Public web documentation for ${slug}.</p>`);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'aitab-e2e-'));
const debugPort = 9226;

const braveProc = spawn(BRAVE_BIN, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${debugPort}`,
  `--disable-extensions-except=${extDir}`,
  `--load-extension=${extDir}`,
  '--window-size=1440,900',
  'chrome://newtab/',
], { stdio: 'ignore' });

let cdp;
const pageErrors = [];

try {
  const versionInfo = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return r.ok ? r.json() : null;
  }, 'Brave CDP failed to start');

  cdp = new CdpClient(versionInfo.webSocketDebuggerUrl);
  await cdp.ready;

  const homeTarget = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(t => t.type === 'page' && t.url.includes('/home.html'));
  }, 'Extension home.html newtab target did not open');

  const home = await cdp.attach(homeTarget.targetId);
  await home.send('Runtime.enable');
  await home.send('Page.enable');
  cdp.events.push(msg => {
    if (msg.sessionId === home.sessionId && msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(msg.params.exceptionDetails?.text || 'Runtime exception');
    }
  });

  await until(() => home.eval(`!!globalThis.chrome?.tabs && !!document.getElementById('organize')`), 'home.js not initialized');

  // Seed deterministic sync settings & disable auto-organize during layout tests
  await home.eval(`(async () => {
    await chrome.storage.sync.set({
      themeMode: 'light',
      settings: {
        autoOrganize: false,
        autoOrganizeOnHome: false,
        autoOrganizeDelaySeconds: 30,
        interceptDuplicates: true,
        showPageSearchPill: true,
        dedupWhitelist: []
      }
    });
  })()`);
  await home.eval(`location.reload()`);
  await until(() => home.eval(`document.documentElement.dataset.theme === 'light' && !!document.getElementById('orgCaret')?.onclick`), 'Light theme home reload failed');

  // Create real native tabs and tab groups in the current browser window
  const seeded = await home.eval(`(async () => {
    const me = await chrome.tabs.getCurrent();
    const winId = me.windowId;
    const urls = [
      '${fixtureOrigin}/react-compiler',
      '${fixtureOrigin}/react-hooks-guide',
      '${fixtureOrigin}/vite-build-docs',
      '${fixtureOrigin}/mdn-fetch-api'
    ];
    const created = [];
    for (const url of urls) {
      created.push(await chrome.tabs.create({ windowId: winId, url, active: false }));
    }
    const g1 = await chrome.tabs.group({ tabIds: [created[0].id, created[1].id] });
    await chrome.tabGroups.update(g1, { title: '前端架构文档', color: 'blue' });
    const g2 = await chrome.tabs.group({ tabIds: [created[2].id, created[3].id] });
    await chrome.tabGroups.update(g2, { title: '构建与规范周报', color: 'green' });
    return { meId: me.id, winId, tabIds: created.map(t => t.id), urls };
  })()`);

  await until(() => home.eval(`document.querySelectorAll('.sp-group').length >= 2`), 'Native tab groups did not render on home board');

  // Wait for tabs to finish loading so proactive dedup sees real URLs
  await until(() => home.eval(`chrome.tabs.query({ windowId: ${seeded.winId} }).then(ts => ts.filter(t => t.url?.startsWith('${fixtureOrigin}')).length === 4)`), 'Fixture tabs did not load');

  // Force #cleanupAdvice banner visible underneath .toolbar to reproduce the exact occlusion scenario
  await home.eval(`(() => {
    const advice = document.getElementById('cleanupAdvice');
    advice.classList.remove('hidden');
    document.getElementById('cleanupSummary').textContent = '清理建议：8 个标签超过 7 天未访问';
    document.getElementById('cleanupNote').textContent = '依据最近访问时间，不代表真实打开时长；不会自动关闭。固定、活动和播放声音的标签已排除。';
  })()`);

  const assertHitTestUnobstructed = async (containerSelector, label) => {
    const report = await home.eval(`(() => {
      const box = document.querySelector(${JSON.stringify(containerSelector)});
      if (!box) return { ok: false, reason: 'missing container' };
      const r = box.getBoundingClientRect();
      if (r.width < 100 || r.height < 40) return { ok: false, reason: 'collapsed box', rect: r };
      const points = [];
      const xs = [r.left + 12, r.left + r.width / 2, r.right - 12];
      const ys = [r.top + 12, r.top + r.height / 2, r.bottom - 12];
      for (const x of xs) {
        for (const y of ys) {
          const hit = document.elementFromPoint(x, y);
          const inside = !!(hit && (box === hit || box.contains(hit)));
          points.push({ x: Math.round(x), y: Math.round(y), inside, hitTag: hit?.tagName, hitClass: hit?.className, hitId: hit?.id });
        }
      }
      const inViewport = r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight;
      return { ok: points.every(p => p.inside) && inViewport, inViewport, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, points };
    })()`);
    assert(report.ok, `${label} occluded or outside viewport: ${JSON.stringify(report, null, 2)}`);
  };

  // Test 1: Light theme 1440x900 - click #orgCaret and verify #orgPop hit-test unobstructed!
  await home.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await home.click('#orgCaret');
  await until(() => home.eval(`!document.getElementById('orgPop').classList.contains('hidden')`), '#orgPop did not open');
  await assertHitTestUnobstructed('#orgPop', 'Light-1440 #orgPop');
  await home.shot('e2e-light-orgpop-1440.png');
  console.log('PASS [E2E] Light 1440x900 #orgPop sits cleanly above .suggest and .sp-group');

  // Test 2: Dark theme 900x760 small window - verify #orgPop hit-test & viewport fit!
  await home.eval(`chrome.storage.sync.set({ themeMode: 'dark' }); document.documentElement.dataset.theme = 'dark';`);
  await home.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  await assertHitTestUnobstructed('#orgPop', 'Dark-900 #orgPop');
  await home.shot('e2e-dark-orgpop-900.png');
  console.log('PASS [E2E] Dark 900x760 #orgPop sits cleanly unobstructed and inside viewport');

  // Test 3: Click #archiveOpenBtn -> verify #orgPop closes & .archive-panel is unobstructed!
  await home.click('#archiveOpenBtn');
  await until(() => home.eval(`!document.getElementById('archiveDrawerModal').classList.contains('hidden')`), '#archiveDrawerModal did not open');
  assert.equal(await home.eval(`document.getElementById('orgPop').classList.contains('hidden')`), true, 'Opening archive modal must close #orgPop');
  await assertHitTestUnobstructed('.archive-panel', 'Archive Modal .archive-panel');
  await home.shot('e2e-archive-modal.png');
  await home.click('#archiveCloseBtn');
  await until(() => home.eval(`document.getElementById('archiveDrawerModal').classList.contains('hidden')`), '#archiveDrawerModal did not close');
  console.log('PASS [E2E] #archiveDrawerModal sits cleanly on top and closes cleanly');

  // Test 4: Click #topSearchBtn -> verify #palette (.palette-panel) is Dusk-styled, top-aligned zero-jitter, & unobstructed!
  await home.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await home.click('#topSearchBtn');
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not open');
  await assertHitTestUnobstructed('#palette .palette-panel', 'Command Palette .palette-panel');
  const paletteStyleCheck = await home.eval(`(async () => {
    const inp = document.getElementById('paletteInput');
    const panel = document.querySelector('#palette .palette-panel');
    const cs = getComputedStyle(panel);
    const beforeTop = inp.getBoundingClientRect().top;
    inp.value = 'react';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const afterTop = inp.getBoundingClientRect().top;
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const listEl = document.getElementById('paletteList');
    const rowEl = document.querySelector('#paletteList .palette-row.sel') || document.querySelector('#paletteList .palette-row');
    const listCs = getComputedStyle(listEl);
    const rowCs = getComputedStyle(rowEl);
    const panelRect = panel.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    return {
      radius: parseFloat(cs.borderTopLeftRadius),
      topDelta: Math.abs(beforeTop - afterTop),
      listPadLeft: parseFloat(listCs.paddingLeft),
      listPadRight: parseFloat(listCs.paddingRight),
      rowPadX: parseFloat(rowCs.paddingLeft),
      rowPadY: parseFloat(rowCs.paddingTop),
      insetLeft: rowRect.left - panelRect.left,
      insetRight: panelRect.right - rowRect.right,
    };
  })()`);
  assert(
    paletteStyleCheck.radius >= 14 &&
      paletteStyleCheck.topDelta < 1 &&
      paletteStyleCheck.listPadLeft >= 14 &&
      paletteStyleCheck.listPadRight >= 14 &&
      paletteStyleCheck.rowPadX >= 12 &&
      paletteStyleCheck.rowPadY >= 9 &&
      paletteStyleCheck.insetLeft >= 14 &&
      paletteStyleCheck.insetRight >= 14,
    `Palette Dusk style/padding or jitter check failed: ${JSON.stringify(paletteStyleCheck)}`,
  );
  await home.shot('e2e-palette.png');
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not close on Escape');
  console.log('PASS [E2E] #palette uses Dusk rounded glass style with zero vertical jitter and closes on Escape');

  // Test 4.5: Source chip switching has zero horizontal layout jitter
  const chipJitter = await home.eval(`(() => {
    const chips = [...document.querySelectorAll('#sourceChips .source-chip')];
    const beforeRects = chips.map(c => c.getBoundingClientRect().left);
    chips[2].click();
    const afterRects = chips.map(c => c.getBoundingClientRect().left);
    chips[0].click();
    return beforeRects.map((x, i) => Math.abs(x - afterRects[i]));
  })()`);
  assert(chipJitter.every(d => d < 0.5), `Source chip switching caused horizontal jitter: ${JSON.stringify(chipJitter)}`);
  console.log('PASS [E2E] Hero source chips switch with zero horizontal layout jitter');

  // Test 4.6: Real Chrome chrome.tabs.discard (#freeMemoryBtn) & .hibernated-badge
  await home.click('#freeMemoryBtn');
  await until(() => home.eval(`document.querySelectorAll('.hibernated-badge').length >= 1`), 'Free memory did not discard any background tab or render .hibernated-badge', 8000);
  console.log('PASS [E2E] #freeMemoryBtn discarded background HTTP tabs and rendered .hibernated-badge');

  // Test 5: Real Proactive Duplicate Tab Interception (even when existing tab was discarded)!
  const targetBefore = await home.eval(`chrome.tabs.query({ windowId: ${seeded.winId} }).then(ts => ts.filter(t => (t.url || '').startsWith('${fixtureOrigin}/react-compiler')))`);
  assert.equal(targetBefore.length, 1);
  const targetTabId = targetBefore[0].id;
  await home.eval(`chrome.tabs.create({ windowId: ${seeded.winId}, url: '${fixtureOrigin}/react-compiler#section2', active: true })`);
  // Extension should close the new duplicate tab and keep count at 1 + activate targetTabId!
  await until(() => home.eval(`(async () => {
    const ts = await chrome.tabs.query({ windowId: ${seeded.winId} });
    const matches = ts.filter(t => (t.url || '').startsWith('${fixtureOrigin}/react-compiler'));
    const sess = await chrome.storage.session.get('lastInterceptedDup');
    return matches.length === 1 && matches[0].id === ${targetTabId} && matches[0].active === true && !!sess.lastInterceptedDup;
  })()`), 'Proactive duplicate tab interception did not close dup and focus original tab', 10000);
  // Switch back to home.html tab and verify the #dupInterceptBanner rendered!
  await home.eval(`chrome.tabs.update(${seeded.meId}, { active: true })`);
  await until(() => home.eval(`!document.getElementById('dupInterceptBanner').classList.contains('hidden')`), '#dupInterceptBanner did not appear on home workbench');
  console.log('PASS [E2E] Real proactive duplicate tab interception closed dup tab, focused existing tab, and surfaced escape banner');

  await until(() => home.eval(`document.querySelectorAll('.sp-tabs li .t').length >= 1`), 'Groups did not render on home');
  const groupLayoutCheck = await home.eval(`(() => {
    const g = [...document.querySelectorAll('.sp-group')].find(x => x.querySelector('.group-select'));
    const heading = g.querySelector('.group-heading');
    const head = heading.querySelector('.sp-group-head');
    const order = heading.querySelector('.group-order');
    return {
      chevFirstInHead: head.firstElementChild?.classList.contains('chev'),
      headTag: head.tagName,
      isSortableGroup: g.classList.contains('is-sortable-group') || g.classList.contains('active-group'),
      orderOpacity: getComputedStyle(order).opacity,
      moveButtons: order.querySelectorAll('.order-up, .order-down').length,
      hasLockBtn: !!order.querySelector('.group-lock-btn'),
      hasCloseBtn: !!order.querySelector('.group-close-btn'),
    };
  })()`);
  assert(
    groupLayoutCheck.chevFirstInHead
    && groupLayoutCheck.headTag !== 'BUTTON'
    && groupLayoutCheck.isSortableGroup
    && groupLayoutCheck.orderOpacity === '1'
    && groupLayoutCheck.moveButtons === 2
    && groupLayoutCheck.hasLockBtn
    && groupLayoutCheck.hasCloseBtn,
    `Group header layout/order/draggable invalid: ${JSON.stringify(groupLayoutCheck)}`,
  );
  console.log('PASS [E2E] Group collapse chevron placed after checkbox, move buttons always visible, and title area sortable');

  // Test 5.4: Real SortableJS pointer drag across variable-height masonry cards -> greyed-out moving card ghost & zero jitter
  await home.eval(`(async () => {
    const ts = [];
    for (let i = 0; i < 4; i++) ts.push(await chrome.tabs.create({ windowId: ${seeded.winId}, url: '${fixtureOrigin}/react-hooks-guide?sort=' + i, active: false }));
    const g3 = await chrome.tabs.group({ tabIds: ts.map(t => t.id) });
    await chrome.tabGroups.update(g3, { title: '排序测试卡片', color: 'purple' });
  })()`);
  await until(() => home.eval(`document.querySelectorAll('.group-grid > .sp-group.is-sortable-group').length >= 2`), 'Need at least 2 sortable group cards for SortableJS drag check');

  const initialOrder = await home.eval(`[...document.querySelectorAll('.group-grid > .sp-group[data-group-id]')].map(el => el.dataset.groupId).join(',')`);
  const dragCoords = await home.eval(`(() => {
    const cards = [...document.querySelectorAll('.group-grid > .sp-group.is-sortable-group')];
    const srcHead = cards[0].querySelector('.sp-group-head');
    const dstCard = cards[cards.length - 1];
    const sr = srcHead.getBoundingClientRect();
    const dr = dstCard.getBoundingClientRect();
    return {
      sx: Math.round(sr.left + sr.width / 2),
      sy: Math.round(sr.top + sr.height / 2),
      tx: Math.round(dr.left + dr.width * 0.72),
      ty: Math.round(dr.top + dr.height * 0.55),
    };
  })()`);
  await home.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: dragCoords.sx, y: dragCoords.sy });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(dragCoords.sx + (dragCoords.tx - dragCoords.sx) * (i / steps));
    const y = Math.round(dragCoords.sy + (dragCoords.ty - dragCoords.sy) * (i / steps));
    await home.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x, y });
    await new Promise(r => setTimeout(r, 28));
  }
  // Jitter check: wiggle cursor slightly (<10px) in middle spot and count DOM swaps (must be 0!)
  const midSamples = [];
  for (const [dx, dy] of [[3, 2], [-3, -2], [4, 1], [-2, 3]]) {
    await home.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: dragCoords.tx + dx, y: dragCoords.ty + dy });
    await new Promise(r => setTimeout(r, 35));
    const snap = await home.eval(`[...document.querySelectorAll('.group-grid > .sp-group[data-group-id]')].map(el => el.dataset.groupId).join(',')`);
    midSamples.push(snap);
  }
  const midDragCheck = await home.eval(`(() => {
    const ghost = document.querySelector('.group-grid > .sp-group.group-drag-ghost');
    const floating = document.querySelector('.group-drag-floating');
    const cs = ghost ? getComputedStyle(ghost) : null;
    return {
      hasGhostCard: !!ghost && !!ghost.querySelector('.sp-group-head'),
      hasFloatingCard: !!floating,
      hasOldDashedPlaceholder: !!document.querySelector('.group-drop-placeholder'),
      ghostOpacity: cs ? parseFloat(cs.opacity) : 1,
      uniqueMidOrders: ${JSON.stringify([...new Set(midSamples)].length)},
    };
  })()`);
  await home.shot('e2e-drag-placeholder.png');
  await home.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: dragCoords.tx, y: dragCoords.ty });
  await new Promise(r => setTimeout(r, 250));
  const clearedAfterEnd = await home.eval(`!document.querySelector('.group-drag-ghost') && !document.querySelector('.group-drag-floating')`);
  assert(
    midDragCheck.hasGhostCard
    && midDragCheck.hasFloatingCard
    && !midDragCheck.hasOldDashedPlaceholder
    && midDragCheck.ghostOpacity < 0.65
    && midSamples[0] !== initialOrder
    && midDragCheck.uniqueMidOrders === 1
    && clearedAfterEnd,
    `SortableJS drag check failed: ${JSON.stringify({ ...midDragCheck, initialOrder, midSamples, clearedAfterEnd })}`,
  );
  console.log('PASS [E2E] SortableJS drag renders greyed-out moving card ghost, avoids mid-drag jitter, and cleans up cleanly');

  // Test 5.5: Searchable Select component on tab row .tab-move
  await home.eval(`(() => {
    const cards = [...document.querySelectorAll('.sp-group')];
    const frontend = cards.find(c => (c.querySelector('.sp-group-name')?.value || c.querySelector('.gname')?.textContent || '').includes('前端架构'));
    (frontend || cards[1] || cards[0]).querySelector('.ui-ss-trigger.is-move')?.click();
  })()`);
  await until(() => home.eval(`!!document.querySelector('.ui-ss-menu .ui-ss-search')`), 'Searchable move menu did not open');
  const moveSearchCheck = await home.eval(`(() => {
    const input = document.querySelector('.ui-ss-menu .ui-ss-search');
    input.value = '规范';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const opts = [...document.querySelectorAll('.ui-ss-menu .ui-ss-opt')].map(o => o.textContent.trim());
    const rect = document.querySelector('.ui-ss-menu').getBoundingClientRect();
    return {
      opts,
      inViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  })()`);
  assert(moveSearchCheck.inViewport && moveSearchCheck.opts.includes('构建与规范周报') && moveSearchCheck.opts.length >= 1, `Move search failed: ${JSON.stringify(moveSearchCheck)}`);
  await home.shot('e2e-searchable-move.png');
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`!document.querySelector('.ui-ss-menu')`), 'Searchable move menu did not close on Escape');
  console.log('PASS [E2E] Generic SearchableSelect on .tab-move filters groups and stays inside viewport');

  // Seed deterministic tabMetaCache (unified AI title + summary) & test fuzzy search + Home/Sidepanel title parity!
  await home.eval(`(async () => {
    await chrome.storage.local.set({
      tabMetaCache: {
        '${fixtureOrigin}/react-compiler': {
          title: '统一标题·React Compiler 架构指南',
          summary: '自动记忆化编译与渲染性能优化配置说明',
          source: 'ai',
          updatedAt: Date.now()
        }
      }
    });
    await reload();
    await refreshOps();
  })()`);
  await until(() => home.eval(`[...document.querySelectorAll('.sp-tabs li .t')].some(b => b.textContent.trim() === '统一标题·React Compiler 架构指南')`), 'Home did not display unified AI title from tabMetaCache');
  // Test Home fuzzy search matching summary keyword ('性能优化')
  await home.eval(`(() => {
    const s = document.getElementById('search');
    s.value = '性能优化';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => home.eval(`document.querySelectorAll('.sp-tabs li .t').length === 1 && document.querySelector('.sp-tabs li .t').textContent.trim() === '统一标题·React Compiler 架构指南'`), 'Home fuzzy summary search failed');
  await home.eval(`(() => {
    const s = document.getElementById('search');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  // Test #palette fuzzy summary search
  await home.click('#topSearchBtn');
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not open for summary search');
  await home.eval(`(() => {
    const p = document.getElementById('paletteInput');
    p.value = '性能优化';
    p.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => home.eval(`[...document.querySelectorAll('#paletteList .palette-row[data-kind="tab"]')].some(r => r.textContent.includes('统一标题·React Compiler 架构指南') && r.textContent.includes('自动记忆化编译'))`), '#palette fuzzy summary search did not highlight summary');
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not close after summary test');
  console.log('PASS [E2E] Unified AI title & summary fuzzy search verified across Home and #palette');

  // Test 5.8: Real Chrome browsing history omnibox search + h prefix targeting
  const historyUrl = `${fixtureOrigin}/history-archived-omnibox`;
  await home.eval(`(async () => {
    const t = await chrome.tabs.create({ windowId: ${seeded.winId}, url: ${JSON.stringify(historyUrl)}, active: false });
    for (let i = 0; i < 30; i++) {
      const info = await chrome.tabs.get(t.id);
      if (info.status === 'complete') break;
      await new Promise(r => setTimeout(r, 100));
    }
    await chrome.tabs.remove(t.id);
  })()`);
  await home.click('#topSearchBtn');
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not open for history check');
  await home.eval(`(() => {
    const p = document.getElementById('paletteInput');
    p.value = 'history-archived-omnibox';
    p.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => home.eval(`[...document.querySelectorAll('#paletteList .palette-row[data-kind="history"]')].some(r => r.dataset.key === 'history:' + ${JSON.stringify(historyUrl)})`), 'Browsing history item did not surface in omnibox search');
  await home.eval(`(() => {
    const p = document.getElementById('paletteInput');
    p.value = 'h history-archived-omnibox';
    p.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => home.eval(`document.querySelectorAll('#paletteList .palette-row').length === 1 && document.querySelector('#paletteList .palette-row').dataset.kind === 'history' && document.getElementById('paletteCount').textContent.includes('来源：历史')`), 'h prefix did not isolate browsing history results');
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not close after history test');
  console.log('PASS [E2E] Real Chrome browsing history surfaces in omnibox and h prefix isolates history cleanly');

  // Test 5.9: Hero search inline dropdown parity with Cmd+K + Chrome recent/history records
  await home.click('#search');
  await until(() => home.eval(`!document.getElementById('heroSearchDropdown')?.classList.contains('hidden') && document.querySelectorAll('#heroPaletteList .palette-row').length >= 1`), 'Hero search dropdown did not open with recent/tab items on click');
  await home.eval(`(() => {
    const s = document.getElementById('search');
    s.value = 'h history-archived-omnibox';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(() => home.eval(`document.querySelectorAll('#heroPaletteList .palette-row').length === 1 && document.querySelector('#heroPaletteList .palette-row').dataset.kind === 'history' && document.getElementById('heroPaletteCount').textContent.includes('来源：历史')`), 'Hero inline search dropdown did not match h prefix history isolation');
  const heroOverlayCheck = await home.eval(`(() => {
    const dd = document.getElementById('heroSearchDropdown').getBoundingClientRect();
    const tb = document.querySelector('.toolbar-zone').getBoundingClientRect();
    const pt = document.elementFromPoint(dd.left + 40, Math.min(dd.bottom - 12, tb.top + 8));
    return { ddHeight: dd.height, paletteOpen: !document.getElementById('palette').classList.contains('hidden'), onTop: Boolean(pt && pt.closest('#heroSearchDropdown')) };
  })()`);
  assert.ok(heroOverlayCheck.ddHeight > 80 && !heroOverlayCheck.paletteOpen && heroOverlayCheck.onTop, 'Hero dropdown must layer cleanly above toolbar without opening modal: ' + JSON.stringify(heroOverlayCheck));
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('heroSearchDropdown')?.classList.contains('hidden')`), 'Hero search dropdown did not close on Escape');
  await home.eval(`(() => {
    const s = document.getElementById('search');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('search').blur?.();
  })()`);
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('heroSearchDropdown')?.classList.contains('hidden')`), 'Hero search dropdown remained open after reset');
  console.log('PASS [E2E] Home Hero search inline dropdown synced with Cmd+K logic and Chrome recent/history');

  // Test 6: Real Sidepanel target verification at 368px width in both modes
  const spUrl = await home.eval(`chrome.runtime.getURL('sidepanel.html')`);
  await home.eval(`chrome.tabs.create({ url: ${JSON.stringify(spUrl)}, active: true })`);
  const spTarget = await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.find(t => t.type === 'page' && t.url.includes('/sidepanel.html'));
  }, 'sidepanel.html target missing');
  const sp = await cdp.attach(spTarget.targetId);
  await sp.send('Runtime.enable');
  await sp.send('Page.enable');
  cdp.events.push(msg => {
    if (msg.sessionId === sp.sessionId && msg.method === 'Runtime.exceptionThrown') {
      const desc = msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'Sidepanel exception';
      console.error('[SIDEPANEL EXCEPTION]', desc);
      pageErrors.push(desc);
    }
  });
  await sp.send('Page.bringToFront');
  await sp.send('Emulation.setDeviceMetricsOverride', { width: 368, height: 860, deviceScaleFactor: 1, mobile: false });
  await until(() => sp.eval(`document.readyState === 'complete' && document.body.dataset.spMode === 'settings' && !!document.getElementById('regroup')?.onclick && window.scrollY === 0 && document.getElementById('health')?.classList.contains('ok') && document.getElementById('svcDot')?.classList.contains('ok') && !!document.querySelector('#cliCards .cli-card.active')`), 'sidepanel.html did not initialize online status consistently');
  const spOnlineCheck = await sp.eval(`(() => ({
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    pillOk: document.getElementById('health').classList.contains('ok'),
    pillText: document.getElementById('health').textContent.trim(),
    svcDotOk: document.getElementById('svcDot').classList.contains('ok'),
    svcTitle: document.getElementById('svcTitle').textContent.trim(),
    actionsHidden: document.getElementById('svcActions').classList.contains('hidden'),
    activeCli: document.querySelector('#cliCards .cli-card.active')?.dataset?.cliId || null,
  }))()`);
  assert(spOnlineCheck.noOverflow, 'Sidepanel overflows horizontally in settings mode at 368px');
  assert(spOnlineCheck.pillOk && spOnlineCheck.svcDotOk && spOnlineCheck.actionsHidden && spOnlineCheck.activeCli, `Online state inconsistent: ${JSON.stringify(spOnlineCheck)}`);
  await sp.shot('e2e-sidepanel-settings-368.png');

  // Verify SearchableSelect on #model at 368px width & custom #autoDelay (2 min = 120s)
  await sp.eval(`document.getElementById('model')._searchableSelect.open()`);
  await until(() => sp.eval(`!!document.querySelector('.ui-ss-menu .ui-ss-search')`), '#model searchable menu did not open');
  const modelSearchCheck = await sp.eval(`(() => {
    const input = document.querySelector('.ui-ss-menu .ui-ss-search');
    input.value = 'Seed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const opts = [...document.querySelectorAll('.ui-ss-menu .ui-ss-opt')].map(o => o.textContent.trim());
    const rect = document.querySelector('.ui-ss-menu').getBoundingClientRect();
    return { opts, inViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight };
  })()`);
  assert(modelSearchCheck.inViewport && modelSearchCheck.opts.some(o => o.includes('Seed')), `Model search failed: ${JSON.stringify(modelSearchCheck)}`);
  await sp.shot('e2e-searchable-model-368.png');
  await sp.eval(`closeActiveSearchableSelect()`);
  // Clicking label text/blank space MUST NOT open SearchableSelect; only clicking the select box trigger opens it
  await sp.eval(`document.querySelector('label[for="autoDiscardMinutes"]')?.click()`);
  const openedByLabel = await sp.eval(`!!document.querySelector('.ui-ss-menu')`);
  assert.equal(openedByLabel, false, 'Clicking label/blank row opened SearchableSelect menu unexpectedly');
  await sp.eval(`document.getElementById('autoDiscardMinutes')._searchableSelect.trigger.click()`);
  await until(() => sp.eval(`!!document.querySelector('.ui-ss-menu')`), 'Clicking select trigger button did not open SearchableSelect');
  await sp.eval(`closeActiveSearchableSelect()`);
  console.log('PASS [E2E] Clicking label never triggers SearchableSelect; only select box trigger opens menu');

  await sp.eval(`(() => {
    const sel = document.getElementById('autoDelay');
    sel.value = '__custom__';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => sp.eval(`!document.getElementById('autoDelayCustomRow').classList.contains('hidden')`), '#autoDelayCustomRow did not open');
  await sp.eval(`(() => {
    document.getElementById('autoDelayCustomValue').value = '2';
    document.getElementById('autoDelayCustomUnit').value = 'min';
    document.getElementById('autoDelayCustomApply').click();
  })()`);
  await until(() => sp.eval(`chrome.storage.sync.get('settings').then(r => r.settings?.autoOrganizeDelaySeconds === 120 && document.getElementById('autoDelay').value === '120' && document.getElementById('autoDelayCustomRow').classList.contains('hidden'))`), 'Custom autoDelay 2 min (120s) did not persist cleanly');
  await sp.eval(`(() => {
    document.getElementById('autoDiscardEnabled').checked = true;
    document.getElementById('autoDiscardEnabled').dispatchEvent(new Event('change', { bubbles: true }));
    const sel = document.getElementById('autoDiscardMinutes');
    sel.value = '__custom__';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await until(() => sp.eval(`!document.getElementById('autoDiscardCustomRow').classList.contains('hidden')`), '#autoDiscardCustomRow did not open');
  await sp.eval(`(() => {
    document.getElementById('autoDiscardCustomValue').value = '2';
    document.getElementById('autoDiscardCustomUnit').value = 'hour';
    document.getElementById('autoDiscardCustomApply').click();
  })()`);
  await until(() => sp.eval(`chrome.storage.sync.get('settings').then(r => r.settings?.autoDiscardEnabled === true && r.settings?.autoDiscardMinutes === 120 && document.getElementById('autoDiscardMinutes').value === '120')`), 'Custom autoDiscard 2 hours (120m) did not persist cleanly');
  const spAggDepthEnhanced = await sp.eval(`(() => {
    const sel = document.getElementById('spAggRuleDepth');
    const trig = sel?.nextElementSibling;
    if (!sel || !sel.classList.contains('ui-ss-native') || !trig || !trig.classList.contains('ui-ss-trigger')) return false;
    trig.click();
    const menuOpen = !!document.querySelector('.ui-ss-menu');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return menuOpen && trig.classList.contains('is-sm');
  })()`);
  assert(spAggDepthEnhanced, '#spAggRuleDepth must use unified SearchableSelect (.ui-ss-trigger.is-sm) and open .ui-ss-menu');
  await sp.shot('e2e-custom-delay-368.png');
  console.log('PASS [E2E] Generic SearchableSelect (#model), custom autoDelay (120s), and autoDiscardMinutes (120m) verified at 368px');

  // Verify offline state consistency across pill, CLI cards, svc-box, and one-click start button
  const spOfflineCheck = await sp.eval(`(async () => {
    const origFetch = window.fetch;
    window.fetch = () => Promise.reject(new Error('offline simulated'));
    try {
      await refreshHealthPill(document.getElementById('health'), { onStartRequest: () => {} });
      await initModelSelect(document.getElementById('model'), {
        refreshBtn: document.getElementById('refreshModels'),
        metaEl: document.getElementById('model-meta'),
        pillEl: document.getElementById('health'),
        cliContainerEl: document.getElementById('cliCards'),
      });
      await initUpdateCard({
        statusEl: document.getElementById('updateStatus'),
        checkBtn: document.getElementById('updateCheckBtn'),
        applyBtn: document.getElementById('updateApplyBtn'),
        dotEl: document.getElementById('svcDot'),
        titleEl: document.getElementById('svcTitle'),
        actionsEl: document.getElementById('svcActions'),
        startBtn: document.getElementById('svcStartBtn'),
        setupBoxEl: document.getElementById('svcSetupHint'),
        cmdEl: document.getElementById('svcCmd'),
        copyCmdBtn: document.getElementById('svcCopyCmdBtn'),
        retryBtn: document.getElementById('svcRetryBtn'),
        pillEl: document.getElementById('health'),
      });
      return {
        pillBad: document.getElementById('health').classList.contains('bad'),
        svcDotBad: document.getElementById('svcDot').classList.contains('bad'),
        svcTitle: document.getElementById('svcTitle').textContent.trim(),
        cliCardCount: document.querySelectorAll('#cliCards .cli-card').length,
        startBtnVisible: !document.getElementById('svcActions').classList.contains('hidden') && document.getElementById('svcStartBtn').getBoundingClientRect().height > 0,
      };
    } finally {
      window.fetch = origFetch;
    }
  })()`);
  assert(
    spOfflineCheck.pillBad && spOfflineCheck.svcDotBad && spOfflineCheck.cliCardCount === 0 && spOfflineCheck.startBtnVisible,
    `Offline state inconsistent: ${JSON.stringify(spOfflineCheck)}`,
  );
  await sp.shot('e2e-sidepanel-offline-368.png');
  console.log('PASS [E2E] Online & offline status cards (#health, #cliCards, #svcTitle, #svcStartBtn) are 100% synchronized');

  await sp.eval(`(() => {
    document.body.dataset.spMode = 'tablist';
    document.getElementById('deck')?.classList.add('hidden');
    window.scrollTo(0, 0);
  })()`);
  const spTablistCheck = await sp.eval(`(() => {
    const r = document.getElementById('regroup')?.getBoundingClientRect();
    const listRect = document.getElementById('list')?.getBoundingClientRect();
    return {
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      regroupVisible: !!r && r.width > 0 && r.height > 0,
      listVisible: !!listRect && listRect.width > 0 && listRect.height > 0,
      deckHidden: getComputedStyle(document.getElementById('deck')).display === 'none',
    };
  })()`);
  assert(spTablistCheck.noOverflow, 'Sidepanel overflows horizontally in tablist mode at 368px');
  assert(spTablistCheck.regroupVisible && spTablistCheck.listVisible && spTablistCheck.deckHidden, `Sidepanel tablist layout invalid: ${JSON.stringify(spTablistCheck)}`);
  // Also assert Sidepanel displays identical unified AI title & matches summary fuzzy query ('性能优化')!
  const spParity = await sp.eval(`(() => {
    const s = document.getElementById('search');
    s.value = '性能优化';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    const titles = [...document.querySelectorAll('#list .sp-tabs li .t')].map(b => b.textContent.trim());
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return titles;
  })()`);
  assert.deepEqual(spParity, ['统一标题·React Compiler 架构指南'], `Sidepanel unified title/summary parity mismatch: ${JSON.stringify(spParity)}`);
  await sp.shot('e2e-sidepanel-tablist-368.png');
  console.log('PASS [E2E] Sidepanel & Home display identical unified AI title and pass fuzzy summary search');
  console.log('PASS [E2E] sidepanel.html zero horizontal overflow at 368px in both Settings & Tab List modes');

  // Test 7: Language switching (中文 <-> English) across Sidepanel & Home via [data-lang-seg] & storage.sync
  await sp.eval(`(() => {
    document.body.dataset.spMode = 'settings';
    document.getElementById('deck')?.classList.remove('hidden');
    window.scrollTo(0, 0);
    document.querySelector('[data-lang-mode="en"]')?.click();
  })()`);
  await until(() => sp.eval(`document.documentElement.dataset.lang === 'en' && document.getElementById('regroup')?.textContent?.trim() === 'Organize Now'`), 'Sidepanel did not switch UI to English');
  const spEnCheck = await sp.eval(`(() => ({
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    lang: document.documentElement.lang,
    checkedEn: document.querySelector('[data-lang-mode="en"]')?.getAttribute('aria-checked'),
  }))()`);
  assert(spEnCheck.noOverflow && spEnCheck.checkedEn === 'true', `Sidepanel English check failed: ${JSON.stringify(spEnCheck)}`);
  await sp.shot('e2e-english-sidepanel-368.png');

  await home.send('Page.bringToFront');
  await until(() => home.eval(`document.documentElement.dataset.lang === 'en' && document.getElementById('homeTitle')?.textContent?.trim() === 'Workspace Tabs' && document.getElementById('organize')?.textContent?.trim() === 'Organize Now'`), 'Home did not sync English UI via storage.sync');
  await home.shot('e2e-english-home.png');
  // Toggle back to Chinese via Sidepanel [data-lang-mode="zh"] and verify instant sync on Home
  await sp.send('Page.bringToFront');
  await sp.click('[data-lang-mode="zh"]');
  await until(() => sp.eval(`document.documentElement.dataset.lang === 'zh' && document.getElementById('regroup')?.textContent?.trim() === '立即整理'`), 'Sidepanel did not revert cleanly to Chinese');
  await home.send('Page.bringToFront');
  try {
    await until(() => home.eval(`document.documentElement.dataset.lang === 'zh' && document.getElementById('homeTitle')?.textContent?.trim() === '工作标签' && document.getElementById('organize')?.textContent?.trim() === '立即整理'`), 'Home did not revert cleanly to Chinese');
  } catch (err) {
    const diag = await home.eval(`chrome.storage.sync.get('uiLang').then(r => ({ sync: r.uiLang, lang: document.documentElement.dataset.lang, title: document.getElementById('homeTitle')?.textContent, org: document.getElementById('organize')?.textContent }))`);
    throw new Error(`${err.message}: ${JSON.stringify(diag)}`);
  }
  console.log('PASS [E2E] Bilingual UI toggle (中文 <-> English) syncs cleanly across Sidepanel & Home with zero 368px overflow');

  // Test 8: Pasting a URL into #palette promotes direct jump at top without unrelated tab noise and Enter jumps cleanly
  const directUrl = `${fixtureOrigin}/docs/react-19-upgrade-guide-and-migration-checklist`;
  await home.click('#topSearchBtn');
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not open for URL test');
  const directCheck = await home.eval(`(async () => {
    const inp = document.getElementById('paletteInput');
    const url = ${JSON.stringify(directUrl)};
    inp.value = url;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rows = [...document.querySelectorAll('#paletteList .palette-row')];
    return {
      firstKind: rows[0]?.dataset?.kind || '',
      firstText: rows[0]?.textContent || '',
      tabNoiseCount: rows.filter(r => r.dataset.kind === 'tab').length,
      footerText: document.getElementById('paletteCount')?.textContent || '',
    };
  })()`);
  assert.equal(directCheck.firstKind, 'url', `Expected first row to be direct url: ${JSON.stringify(directCheck)}`);
  assert(directCheck.firstText.includes('打开网址：'), `Expected Open URL label: ${JSON.stringify(directCheck)}`);
  assert.equal(directCheck.tabNoiseCount, 0, `Unrelated tabs should not pollute direct URL paste: ${JSON.stringify(directCheck)}`);
  await home.click('#paletteList .palette-row[data-kind="url"]');
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), 'Clicking direct URL row did not close palette');
  await until(() => home.eval(`chrome.tabs.query({}).then(ts => ts.some(t => t.url === ${JSON.stringify(directUrl)}))`), 'Clicking direct URL row did not open destination tab');
  await home.send('Page.bringToFront');
  await home.click('#topSearchBtn');
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not reopen for switch-to-existing test');
  const existingCheck = await home.eval(`(async () => {
    const inp = document.getElementById('paletteInput');
    inp.value = ${JSON.stringify(directUrl)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const first = document.querySelector('#paletteList .palette-row');
    return { kind: first?.dataset?.kind, text: first?.textContent || '' };
  })()`);
  assert.equal(existingCheck.kind, 'url');
  assert(existingCheck.text.includes('切换到已打开网页：'), `Expected Switch to open tab prompt when URL already open: ${JSON.stringify(existingCheck)}`);
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), '#palette did not close after direct URL test');
  console.log('PASS [E2E] Pasting URL into ⌘K palette promotes direct open & switch-to-existing-tab without unrelated tab noise');

  // Test 9: Per-group Lock + Quick Close Menu (1. Save & Close recoverable, 2. Force Close permanently) across Sidepanel & Home
  await sp.send('Page.bringToFront');
  await until(() => sp.eval(`document.querySelectorAll('#list .group-lock-btn').length >= 1 && document.querySelectorAll('#list .group-close-btn').length >= 1`), 'Sidepanel group lock/close buttons missing');
  const spLockLayoutOk = await sp.eval(`document.documentElement.scrollWidth <= window.innerWidth`);
  assert.equal(spLockLayoutOk, true, 'Sidepanel overflows horizontally after adding group lock/close buttons');

  await home.send('Page.bringToFront');
  await home.eval(`window.scrollTo(0, 0)`);
  const targetGid = await home.eval(`(() => {
    const card = document.querySelector('.sp-group:not([data-group-id^="u-"])');
    if (!card) throw new Error('No native group card found');
    return card.dataset.groupId;
  })()`);
  // Manual inline group rename via .group-rename-btn -> Enter -> verifies native Chrome tabGroup title + pinned badge + persistent storage!
  await home.click(`.sp-group[data-group-id="${targetGid}"] .group-rename-btn`);
  await until(() => home.eval(`!!document.querySelector('.sp-group[data-group-id="${targetGid}"] .gname-input')`), 'Inline group rename input did not open');
  await home.eval(`(() => {
    const inp = document.querySelector('.sp-group[data-group-id="${targetGid}"] .gname-input');
    inp.value = '手动固定发布组';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await until(() => home.eval(`document.querySelector('.sp-group[data-group-id="${targetGid}"] .gname')?.textContent?.trim() === '手动固定发布组' && document.querySelector('.sp-group[data-group-id="${targetGid}"]')?.classList.contains('is-manual-named')`), 'Manual group rename did not persist cleanly');
  const nativeAfterRename = await home.eval(`chrome.tabGroups.get(${Number(targetGid)}).then(g => g.title)`);
  assert.equal(nativeAfterRename, '手动固定发布组');
  console.log('PASS [E2E] Manual group rename updated native Chrome tabGroup, persisted lock record, and displayed pinned indicator');

  await home.click(`.sp-group[data-group-id="${targetGid}"] .group-lock-btn`);
  await until(() => home.eval(`document.querySelector('.sp-group[data-group-id="${targetGid}"]')?.classList.contains('is-locked')`), 'Group lock state did not apply on Home');
  await home.click(`.sp-group[data-group-id="${targetGid}"] .group-close-btn`);
  await until(() => home.eval(`!!document.querySelector('.group-close-menu')`), 'Group quick-close menu did not open');
  const menuState = await home.eval(`(() => {
    const m = document.querySelector('.group-close-menu');
    const r = m.getBoundingClientRect();
    return {
      inViewport: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
      hasSave: !!m.querySelector('[data-action="save-close"]'),
      forceDisabled: !!m.querySelector('[data-action="force-close"]')?.disabled,
    };
  })()`);
  assert(menuState.inViewport && menuState.hasSave && menuState.forceDisabled, `Group close menu check failed: ${JSON.stringify(menuState)}`);
  // Unlock via menu item then verify force-close becomes enabled on reopen
  await home.click(`.group-close-menu [data-action="toggle-lock"]`);
  await until(() => home.eval(`!document.querySelector('.sp-group[data-group-id="${targetGid}"]')?.classList.contains('is-locked')`), 'Unlock via menu failed');
  await home.click(`.sp-group[data-group-id="${targetGid}"] .group-close-btn`);
  await until(() => home.eval(`document.querySelector('.group-close-menu [data-action="force-close"]')?.disabled === false`), 'Force close stayed disabled after unlock');
  // Option 1: Save & Close -> recoverable via groupArchives
  await home.click(`.group-close-menu [data-action="save-close"]`);
  await until(() => home.eval(`!document.querySelector('.sp-group[data-group-id="${targetGid}"]')`), 'Option 1 Save & Close did not close group card');
  const archivedCount = await home.eval(`chrome.storage.local.get('groupArchives').then(r => (r.groupArchives || []).length)`);
  assert(archivedCount >= 1, 'Option 1 did not persist group into groupArchives for reopening');
  // Inspect #archiveDrawerModal row styling & compact button dimensions
  await home.click('#archiveOpenBtn');
  await until(() => home.eval(`!document.getElementById('archiveDrawerModal').classList.contains('hidden') && document.querySelectorAll('#closedGroupsList li .archive-restore').length >= 1`), '#archiveDrawerModal did not render archived row');
  const archiveRowCheck = await home.eval(`(() => {
    const li = document.querySelector('#closedGroupsList li');
    const ul = document.getElementById('closedGroupsList');
    const restore = li.querySelector('.archive-restore');
    const summary = li.querySelector('.archive-summary');
    const del = li.querySelector('.archive-delete');
    const lr = li.getBoundingClientRect();
    const rr = restore.getBoundingClientRect();
    return {
      listStyleType: getComputedStyle(ul).listStyleType,
      restoreHeight: Math.round(rr.height),
      delHeight: Math.round(del.getBoundingClientRect().height),
      singleLineAligned: Math.abs((rr.top + rr.height / 2) - (lr.top + lr.height / 2)) <= 4,
    };
  })()`);
  assert(
    archiveRowCheck.listStyleType === 'none'
    && archiveRowCheck.restoreHeight <= 28
    && archiveRowCheck.delHeight <= 28
    && archiveRowCheck.singleLineAligned,
    `Archive modal row layout/button size check failed: ${JSON.stringify(archiveRowCheck)}`,
  );
  await home.shot('e2e-archive-modal-refined.png');
  await home.click('#archiveCloseBtn');
  await until(() => home.eval(`document.getElementById('archiveDrawerModal').classList.contains('hidden')`), '#archiveDrawerModal did not close after inspection');
  // Option 2: Disband & permanently close remaining group without adding another archive
  const secondGid = await home.eval(`document.querySelector('.sp-group:not([data-group-id^="u-"])')?.dataset?.groupId || ''`);
  assert(secondGid, 'Expected second native group card for Option 2 E2E');
  await home.click(`.sp-group[data-group-id="${secondGid}"] .group-close-btn`);
  await until(() => home.eval(`!!document.querySelector('.group-close-menu [data-action="force-close"]')`), 'Menu did not open for second group');
  await home.click(`.group-close-menu [data-action="force-close"]`);
  await until(() => home.eval(`!document.querySelector('.sp-group[data-group-id="${secondGid}"]')`), 'Option 2 Force Close did not disband group card');
  const archivedAfterForce = await home.eval(`chrome.storage.local.get('groupArchives').then(r => (r.groupArchives || []).length)`);
  assert.equal(archivedAfterForce, archivedCount, 'Option 2 permanently closes tabs without creating an archive record');
  console.log('PASS [E2E] Group Lock + Quick Close Menu (Option 1 Save&Reopen + Option 2 Dissolve&Close) verified across Home & Sidepanel');

  // Test 10: Command+K / page-search auto-focus verification on Home AND normal HTTP webpage embedded overlay
  await home.send('Page.bringToFront');
  await home.eval(`document.activeElement?.blur?.(); document.body.focus?.();`);
  // Trigger Command+K keydown on Home directly via CDP Input (modifiers: 4 = Meta on macOS, or Ctrl=2 fallback)
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 4 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 4 });
  await until(() => home.eval(`!document.getElementById('palette')?.classList.contains('hidden') && document.activeElement?.id === 'paletteInput'`), 'Home Command+K did not auto-focus #paletteInput');
  // Test quick-copy URL button inside highlighted #palette-row without closing palette
  const copyBtnVisible = await home.eval(`(() => {
    const selRow = document.querySelector('#paletteList .palette-row.sel');
    const btn = selRow?.querySelector('.palette-copy');
    const tag = selRow?.querySelector('.palette-tag');
    const sr = selRow?.getBoundingClientRect();
    const br = btn?.getBoundingClientRect();
    const tr = tag?.getBoundingClientRect();
    return !!btn && !!tag && getComputedStyle(btn).opacity === '1'
      && br.width > 20 && br.height <= 24 && Math.abs(br.height - tr.height) <= 2
      && br.right <= sr.right;
  })()`);
  assert.equal(copyBtnVisible, true, 'Quick-copy URL button missing or hidden on selected Command+K row');
  await home.click('#paletteList .palette-row.sel .palette-copy');
  await until(() => home.eval(`document.querySelector('#paletteList .palette-row.sel .palette-copy')?.classList.contains('copied') && (document.getElementById('toast')?.textContent || '').includes('已复制链接')`), 'Clicking palette quick-copy URL button did not copy or show confirmation');
  assert.equal(await home.eval(`!document.getElementById('palette')?.classList.contains('hidden') && document.activeElement?.id === 'paletteInput'`), true, 'Quick-copy closed palette or lost input focus');
  await home.shot('e2e-palette-quick-copy.png');
  await home.send('Input.insertText', { text: 'focus-home-ok' });
  const homeTyped = await home.eval(`document.getElementById('paletteInput')?.value || ''`);
  assert.equal(homeTyped, 'focus-home-ok', `Home #paletteInput did not accept immediate keystrokes: ${homeTyped}`);
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => home.eval(`document.getElementById('palette')?.classList.contains('hidden')`), 'Home #palette did not close after focus test');

  // Open an ordinary http://127.0.0.1 fixture page, activate it, trigger embedded page-search, and assert real iframe focus
  const webUrl = `${fixtureOrigin}/?tab=focus-check`;
  const webTab = await home.eval(`chrome.tabs.create({ url: ${JSON.stringify(webUrl)}, active: true }).then(t => ({ id: t.id, windowId: t.windowId }))`);
  await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.some(t => t.type === 'page' && t.url === webUrl);
  }, 'Fixture web tab did not appear in CDP targets');
  const { targetInfos: webTargets } = await cdp.send('Target.getTargets');
  const webTarget = webTargets.find(t => t.type === 'page' && t.url === webUrl);
  const webPage = await cdp.attach(webTarget.targetId);
  await webPage.send('Page.bringToFront');
  await until(() => webPage.eval(`document.readyState !== 'loading' && !!document.body`), 'Fixture web tab body not ready');
  await webPage.eval(`document.body.innerHTML = '<input id="hostInput" value="host">'; document.getElementById('hostInput').focus();`);
  // Invoke the extension's background page-search-open handler cleanly (same path as Chrome global Command+K command)
  const openRes = await home.eval(`chrome.runtime.sendMessage({ type: 'page-search-open' })`);
  assert(openRes?.ok, `page-search-open failed on HTTP fixture page: ${JSON.stringify(openRes)}`);
  let embeddedPage = null;
  await until(async () => {
    if (!embeddedPage) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const hit = targetInfos.find(t => t.url.includes('search.html?embedded='));
      if (!hit) return false;
      embeddedPage = await cdp.attach(hit.targetId);
    }
    const st = await embeddedPage.eval(`({ open: !document.getElementById('palette')?.classList.contains('hidden'), activeId: document.activeElement?.id || '', hasFocus: document.hasFocus() })`).catch(() => null);
    return !!st?.open && st.activeId === 'paletteInput' && st.hasFocus === true;
  }, 'Embedded Command+K iframe did not auto-focus #paletteInput with real document focus');
  await embeddedPage.send('Input.insertText', { text: 'focus-embedded-ok' });
  const embeddedTyped = await embeddedPage.eval(`document.getElementById('paletteInput')?.value || ''`);
  assert.equal(embeddedTyped, 'focus-embedded-ok', `Embedded #paletteInput did not receive immediate keystrokes: ${embeddedTyped}`);
  await embeddedPage.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return !targetInfos.some(t => t.url.includes('search.html?embedded='));
  }, 'Embedded Command+K overlay did not close cleanly on Escape');
  console.log('PASS [E2E] Command+K auto-focuses #paletteInput immediately on BOTH Home and normal webpage embedded overlay');

  // Test 11: Real docked Chrome Sidepanel auto-scrolls newly activated & returning-from-settings off-screen tab cleanly into view below sticky .side-head
  await home.send('Page.bringToFront');
  const prevTargetIds = new Set((await cdp.send('Target.getTargets')).targetInfos.map(t => t.targetId));
  await home.click('#openSettings');
  let dockedSp = null;
  await until(async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const hit = targetInfos.find(t => !prevTargetIds.has(t.targetId) && (t.url || '').includes('/sidepanel.html'));
    if (!hit) return false;
    dockedSp = await cdp.attach(hit.targetId);
    return await dockedSp.eval(`document.readyState === 'complete'`).catch(() => false);
  }, 'Real docked Sidepanel did not open from #openSettings');

  const spCreatedIds = await home.eval(`(async () => {
    const win = await chrome.windows.getCurrent();
    const ids = [];
    for (let i = 1; i <= 18; i++) {
      const t = await chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(fixtureOrigin)} + '/?scroll-check=' + i, active: false });
      ids.push(t.id);
    }
    return ids;
  })()`);
  assert.equal(spCreatedIds.length, 18, `Expected 18 scroll-check tabs, got ${spCreatedIds.length}`);
  const topTabId = spCreatedIds[0];
  const bottomTabId = spCreatedIds[spCreatedIds.length - 1];
  await home.eval(`chrome.tabs.update(${topTabId}, { active: true })`);
  await until(() => dockedSp.eval(`document.body.dataset.spMode === 'tablist' && !!document.querySelector('#list li[data-tab-id="${bottomTabId}"]')`), 'Docked Sidepanel did not render scroll-check tabs');

  // Activate far-bottom tab and assert docked Sidepanel automatically scrolls it cleanly into view below sticky .side-head
  await home.eval(`chrome.tabs.update(${bottomTabId}, { active: true })`);
  await until(() => dockedSp.eval(`(() => {
    const row = document.querySelector('#list li[data-tab-id="${bottomTabId}"]');
    const headBottom = document.querySelector('.side-head')?.getBoundingClientRect()?.bottom || 0;
    if (!row || !row.classList.contains('active')) return false;
    const r = row.getBoundingClientRect();
    const scrolled = (document.body.scrollTop || window.scrollY) > 0;
    return scrolled && r.height > 0 && r.top >= headBottom && r.bottom <= window.innerHeight;
  })()`), 'Docked Sidepanel did not auto-scroll to activated off-screen bottom tab');

  // Switch back to Home (enters settings mode while bottomTab remains recent) -> return to bottomTab -> must still auto-scroll!
  const mainHomeTabId = await home.eval(`chrome.tabs.getCurrent().then(t => t.id)`);
  await home.eval(`chrome.tabs.update(${mainHomeTabId}, { active: true })`);
  await until(() => dockedSp.eval(`document.body.dataset.spMode === 'settings'`), 'Docked Sidepanel did not enter settings mode on Home');
  await dockedSp.eval(`document.body.scrollTop = 0; window.scrollTo(0, 0);`);
  await home.eval(`chrome.tabs.update(${bottomTabId}, { active: true })`);
  await until(() => dockedSp.eval(`(() => {
    const row = document.querySelector('#list li[data-tab-id="${bottomTabId}"]');
    const headBottom = document.querySelector('.side-head')?.getBoundingClientRect()?.bottom || 0;
    if (!row || !row.classList.contains('active') || document.body.dataset.spMode !== 'tablist') return false;
    const r = row.getBoundingClientRect();
    const scrolled = (document.body.scrollTop || window.scrollY) > 0;
    return scrolled && r.height > 0 && r.top >= headBottom && r.bottom <= window.innerHeight;
  })()`), 'Docked Sidepanel failed to auto-scroll active tab after returning from settings mode');
  await dockedSp.shot('e2e-sidepanel-autoscroll.png');
  console.log('PASS [E2E] Sidepanel auto-scrolls activated off-screen tab cleanly into view (including return from settings mode)');

  // Test 12: Light theme sync + real mouse click on floating page pill activates embedded Cmd+K search box
  await home.eval(`chrome.storage.sync.set({ themeMode: 'light' })`);
  const pillUrl = `${fixtureOrigin}/?pill-click-test=1`;
  const pillTab = await home.eval(`chrome.tabs.create({ url: ${JSON.stringify(pillUrl)}, active: true }).then(t => t.id)`);
  let pillPage = null;
  await until(async () => {
    if (!pillPage) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const hit = targetInfos.find(t => t.type === 'page' && t.url === pillUrl);
      if (!hit) return false;
      pillPage = await cdp.attach(hit.targetId);
    }
    return await pillPage.eval(`document.readyState === 'complete' && !!document.body && window.innerWidth > 200`).catch(() => false);
  }, 'Pill E2E web page did not load');
  await pillPage.send('Page.bringToFront');
  await until(() => pillPage.eval(`!!document.body?.lastElementChild && document.body.lastElementChild.style?.right === '0px' && document.body.lastElementChild.style?.zIndex === '2147483645'`), 'Floating page-pill did not mount onto web page');
  const clickPt = await pillPage.eval(`(() => {
    const r = document.body.lastElementChild.getBoundingClientRect();
    return { x: Math.round(window.innerWidth - 18), y: Math.round(r.top + 18) };
  })()`);
  await pillPage.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickPt.x, y: clickPt.y });
  await new Promise(r => setTimeout(r, 220));
  await pillPage.shot('e2e-page-pill-light.png');
  // After hover expands the pill, click the search label/kbd region (avoiding the rightmost close button ×)
  const triggerPt = { x: Math.round(clickPt.x - 75), y: clickPt.y };
  await pillPage.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: triggerPt.x, y: triggerPt.y, button: 'left', clickCount: 1 });
  await pillPage.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: triggerPt.x, y: triggerPt.y, button: 'left', clickCount: 1 });
  let pillEmbedded = null;
  await until(async () => {
    if (!pillEmbedded) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const hit = targetInfos.find(t => t.url.includes('search.html?embedded='));
      if (!hit) return false;
      pillEmbedded = await cdp.attach(hit.targetId);
    }
    const st = await pillEmbedded.eval(`({ open: !document.getElementById('palette')?.classList.contains('hidden'), activeId: document.activeElement?.id || '', theme: document.documentElement.dataset.theme || '' })`).catch(() => null);
    return !!st?.open && st.activeId === 'paletteInput' && st.theme === 'light';
  }, 'Clicking floating page pill did not open and focus Cmd+K search overlay in light theme');
  console.log('PASS [E2E] Floating page pill matches light theme and clicking it opens & focuses Cmd+K search box');

  // Test 13: Hibernated tab favicons show circular dashed grey outer ring on Home & Sidepanel
  await home.send('Page.bringToFront');
  const hibernatedRingOk = await home.eval(`(() => {
    const li = document.querySelector('.sp-tabs li.is-discarded');
    const img = li?.querySelector('img');
    if (!li || !img) return false;
    const cs = getComputedStyle(img);
    return cs.borderTopStyle === 'dashed' && cs.borderRadius === '50%';
  })()`);
  assert.equal(hibernatedRingOk, true, 'Discarded tab row missing circular dashed grey outer ring on Home');
  console.log('PASS [E2E] Hibernated tab icons render circular dashed grey outer ring (.sp-tabs li.is-discarded)');

  // Test 14: Single New Tab / Workspace tab per window (background & active newtabs deduplicated cleanly)
  const isNewTabCheck = `(t) => {
    const u = (t.url || t.pendingUrl || '').split(/[?#]/, 1)[0];
    return u.endsWith('/home.html') || /^(?:chrome|brave):\\/\\/newtab\\/?$/i.test(u);
  }`;
  await sp.eval(`chrome.tabs.create({ windowId: ${seeded.winId}, url: 'chrome://newtab/', active: false })`);
  await until(() => sp.eval(`chrome.tabs.query({ windowId: ${seeded.winId} }).then(ts => ts.filter(${isNewTabCheck}).length === 1)`), 'Background duplicate newtab was not closed automatically');
  const prevHomeId = await sp.eval(`chrome.tabs.query({ windowId: ${seeded.winId} }).then(ts => ts.find(${isNewTabCheck})?.id)`);
  await sp.eval(`chrome.tabs.create({ windowId: ${seeded.winId}, url: 'chrome://newtab/', active: true })`);
  await until(() => sp.eval(`chrome.tabs.query({ windowId: ${seeded.winId} }).then(ts => {
    const nt = ts.filter(${isNewTabCheck});
    return nt.length === 1 && nt[0].active === true && nt[0].id !== ${prevHomeId};
  })`), 'Active newtab did not keep newly focused tab while deduplicating previous idle newtab');
  console.log('PASS [E2E] Single New Tab / Workspace tab enforced per window (keeps newly focused tab, closes duplicate)');

  assert.equal(pageErrors.length, 0, `Uncaught page errors: ${pageErrors.join('; ')}`);
  console.log('ALL E2E REAL BROWSER ASSERTIONS PASSED!');
} finally {
  cdp?.close();
  try { braveProc.kill('SIGKILL'); } catch { /* ignore */ }
  server.close();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
