#!/usr/bin/env node
/**
 * UI 验收 v6：无头 Brave 真实加载扩展
 * 流程：种标签(含重复) → popup 整理/预览/应用 → 去重+恢复 → 侧边栏真实手势点击
 *       → 首页自动整理 → 首页去重 → 紧凑密度 → 历史/空间/白名单
 *       → 主题(auto 跟随/三态/跨表面同步/暗色对比度)
 *       → 滚动可达性(矮面板单滚动/控制台折叠/首页末组) → 新标签页接管实证
 *       → 上下文(书签/页面内容/活跃页) / 首页本地折叠 / 同链相邻 / 组名精简 / 拖拽 / ⌘K palette
 *       → 截图 → 清理
 * 前置：Brave 无头实例 --remote-debugging-port=9223 --load-extension；本地服务 8787。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = 'http://127.0.0.1:9223';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'qa-shots');
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newTab(url) {
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`/json/new 失败 ${res.status}: ${await res.text()}`);
  return res.json();
}
async function listTargets() { return (await fetch(`${CDP}/json/list`)).json(); }

class Session {
  constructor(wsUrl) {
    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); } }, 30000);
    });
  }
  async eval(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(`页面 JS 异常: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async click(selector) {
    const rect = await this.eval(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }
  async shot(file, width, height, scale = 2, fullPage = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(500);
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
    console.log(`📸 ${file}`);
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* 1. 扩展 ID：路径确定性推导 + 打开页面唤醒休眠的 SW，再按 manifest 校验 */
const extPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const computedId = [...createHash('sha256').update(extPath).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
let wakeTab = null;
try { wakeTab = await newTab(`chrome-extension://${computedId}/popup.html`); } catch { /* ignore */ }
await sleep(1500);
let extId = null;
for (let i = 0; i < 8 && !extId; i++) {
  for (const sw of (await listTargets()).filter(t => t.type === 'service_worker' && t.url.endsWith('background.js'))) {
    try {
      const s = new Session(sw.webSocketDebuggerUrl);
      await s.ready;
      const name = await s.eval(`chrome.runtime.getManifest().name`);
      s.close();
      if (name === 'AI 标签整理') { extId = new URL(sw.url).host; break; }
    } catch { /* 内置扩展 */ }
  }
  if (!extId) await sleep(1000);
}
if (!extId) extId = computedId; // SW 仍休眠时直接用推导 ID（页面可正常加载）
if (wakeTab) { try { await fetch(`${CDP}/json/close/${wakeTab.id}`); } catch { /* ignore */ } }
// 注意：Brave 下 chrome.runtime.reload() 会导致扩展页被屏蔽（ERR_BLOCKED_BY_CLIENT），
// 因此代码变更后必须用全新 --user-data-dir 启动浏览器，不能热重载。
if (!extId) throw new Error('扩展未加载');
console.log('扩展 ID:', extId);
const extUrl = p => `chrome-extension://${extId}/${p}`;

/* 清理上一轮残留标签，保证干净状态 */
for (const t of (await listTargets()).filter(t => t.type === 'page')) {
  try { await fetch(`${CDP}/json/close/${t.id}`); } catch { /* ignore */ }
}
await sleep(800);

/* 2. 种标签：8 个不同 + 3 个重复 */
const seedUrls = [
  'https://github.com/pulls',
  'https://developer.chrome.com/docs/extensions/reference/api/tabGroups',
  'https://stackoverflow.com/questions/tagged/google-chrome-extension',
  'https://www.youtube.com/',
  'https://www.bilibili.com/',
  'https://www.taobao.com/',
  'https://mail.google.com/',
  'https://news.ycombinator.com/',
  'https://github.com/pulls',        // 重复 1
  'https://www.youtube.com/',        // 重复 2
  'https://www.taobao.com/',         // 重复 3
];
const seeded = [];
for (const u of seedUrls) {
  try { seeded.push(await newTab(u)); } catch (e) { console.warn('种标签失败:', u, e.message); }
}
console.log(`已打开 ${seeded.length} 个标签（含 3 重复），等待加载…`);
await sleep(7000);

/* 3. popup：整理 → 预览 → 应用 */
const popupTab = await newTab(extUrl('popup.html'));
const popup = new Session(popupTab.webSocketDebuggerUrl);
await popup.ready;
await popup.send('Page.enable');
await popup.send('Page.navigate', { url: extUrl('popup.html') });
await sleep(3500);
await popup.shot('01-popup.png', 380, 860);
// 等待重定向稳定（github/taobao 等会跳转），轮询重复计数
let uiState = null;
for (let i = 0; i < 15; i++) {
  uiState = await popup.eval(`({
    health: document.getElementById('health').textContent.trim(),
    modelOptions: document.getElementById('model').options.length,
    dupCount: document.getElementById('dupCount').textContent,
  })`);
  if (Number(uiState.dupCount) >= 3) break;
  await sleep(2000);
}
console.log('popup 状态:', JSON.stringify(uiState));
if (uiState.modelOptions < 2) throw new Error('模型列表未加载');
if (Number(uiState.dupCount) < 3) throw new Error('重复计数异常: ' + uiState.dupCount);

await popup.eval(`document.getElementById('organize').click()`);
let previewOk = false;
for (let i = 0; i < 60 && !previewOk; i++) {
  await sleep(2000);
  previewOk = await popup.eval(`!document.getElementById('preview').classList.contains('hidden')`);
}
if (!previewOk) throw new Error('预览未出现: ' + await popup.eval(`document.getElementById('error').textContent`));
console.log('预览:', await popup.eval(`document.getElementById('preview-meta').textContent`));
await popup.shot('02-popup-preview.png', 380, 860);
await popup.eval(`document.getElementById('apply').click()`);
for (let i = 0; i < 10; i++) {
  await sleep(1000);
  if (await popup.eval(`!document.getElementById('done').classList.contains('hidden')`)) break;
}
await popup.shot('03-popup-done.png', 380, 860);
const groups = await popup.eval(`chrome.tabGroups.query({}).then(gs => gs.map(g => g.title))`, true);
console.log('真实标签组:', JSON.stringify(groups));
if (!groups.length) throw new Error('应用后无标签组');

/* 4. popup 去重 + 恢复 */
await popup.eval(`document.getElementById('dedup').click()`);
await sleep(1500);
const afterDedup = await popup.eval(`(async () => ({
  dup: document.getElementById('dupCount').textContent,
  toast: document.getElementById('toast').textContent,
  tabs: await chrome.tabs.query({}).then(ts => ts.length),
}))()`, true);
console.log('去重后:', JSON.stringify(afterDedup));
if (Number(afterDedup.dup) !== 0) throw new Error('去重未生效');
await popup.shot('04-popup-dedup.png', 380, 860);
await popup.eval(`document.getElementById('dedupUndo').click()`);
// 恢复的标签可能仍在重定向（github/taobao），轮询等计数稳定
let afterUndo = '0';
for (let i = 0; i < 12; i++) {
  await sleep(1000);
  afterUndo = await popup.eval(`document.getElementById('dupCount').textContent`);
  if (Number(afterUndo) >= 3) break;
}
console.log('恢复后重复数:', afterUndo);
if (Number(afterUndo) < 3) throw new Error('恢复未生效');

/* 5. 侧边栏：真实手势点击（Input 事件，保留 user gesture） */
await popup.click('#sidepanel');
await sleep(2000);
const targetsAfter = await listTargets();
const popupGone = !targetsAfter.some(t => t.id === popupTab.id);
const spTarget = targetsAfter.find(t => t.url === extUrl('sidepanel.html'));
console.log(`侧边栏点击: popup 已关闭=${popupGone}, 侧边栏目标=${spTarget ? spTarget.type : '无（无头可能不渲染面板 UI）'}`);
if (!popupGone) {
  const err = await popup.eval(`document.getElementById('error').textContent`).catch(() => '(popup 已不可达)');
  throw new Error('侧边栏打开失败: ' + err);
}
popup.close();

/* 侧边栏视图截图（以标签页形式，验证渲染） */
const spTab = await newTab(extUrl('sidepanel.html'));
const sp = new Session(spTab.webSocketDebuggerUrl);
await sp.ready;
await sp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 860, deviceScaleFactor: 2, mobile: false });
await sp.send('Page.navigate', { url: extUrl('sidepanel.html') });
await sleep(2500);
await sp.shot('05-sidepanel.png', 360, 860);
console.log('侧边栏状态:', await sp.eval(`document.getElementById('sp-status').textContent`));

/* 6. 首页：自动整理（恢复的 3 个标签未分组 → 触发增量整理） */
const homeTab = await newTab(extUrl('home.html'));
const home = new Session(homeTab.webSocketDebuggerUrl);
await home.ready;
await home.send('Page.enable');
await home.send('Page.navigate', { url: extUrl('home.html') });
await home.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
let homeReady = false;
for (let i = 0; i < 75; i++) {
  await sleep(2000);
  homeReady = await home.eval(`!!document.getElementById('st-tabs') && !document.getElementById('organize').disabled && document.getElementById('organizeBanner').classList.contains('hidden') && document.querySelectorAll('.sp-group').length > 0`).catch(() => false);
  if (homeReady) break;
}
if (!homeReady) throw new Error('首页未完成渲染/自动整理');
await sleep(1200);
await home.shot('06-home.png', 1440, 900, 1.5);
const homeState = await home.eval(`({
  tabs: document.getElementById('st-tabs').textContent,
  groups: document.getElementById('st-groups').textContent,
  dups: document.getElementById('st-dups').textContent,
  wins: document.getElementById('st-wins').textContent,
  dupCardVisible: !document.getElementById('dupCard').classList.contains('hidden'),
  groupCards: document.querySelectorAll('.sp-group').length,
  controls: ['scope','model','organize','dedup','search','collapseAll','expandAll','autoOrganize','autoHome','density'].every(id => !!document.getElementById(id)),
})`);
console.log('首页状态:', JSON.stringify(homeState));
if (!homeState.controls) throw new Error('首页控件缺失');
if (!homeState.dupCardVisible) throw new Error('首页重复面板未显示');

/* 7. 首页去重 */
await home.eval(`document.getElementById('dedup').click()`);
await sleep(1800);
const homeAfterDedup = await home.eval(`({
  dups: document.getElementById('st-dups').textContent,
  dupCardHidden: document.getElementById('dupCard').classList.contains('hidden'),
  toast: document.getElementById('toast').textContent,
})`);
console.log('首页去重后:', JSON.stringify(homeAfterDedup));
if (!homeAfterDedup.dupCardHidden) throw new Error('首页去重未生效');
await home.shot('07-home-dedup.png', 1440, 900, 1.5);

/* 8. 紧凑密度 + 搜索 */
const compactBefore = await home.eval(`document.body.classList.contains('compact')`);
await home.eval(`document.getElementById('density').click()`);
await sleep(600);
const compact = await home.eval(`document.body.classList.contains('compact')`);
if (compact === compactBefore) throw new Error('密度切换未生效');
await home.eval(`(() => { const s = document.getElementById('search'); s.value = 'git'; s.dispatchEvent(new Event('input')); })()`);
await sleep(600);
await home.shot('08-home-compact-search.png', 1440, 900, 1.5);
console.log('紧凑+搜索:', await home.eval(`document.getElementById('mainStatus').textContent`));
// 清空搜索与紧凑密度，恢复完整视图供后续截图
await home.eval(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); if (document.getElementById('density').checked) document.getElementById('density').click(); })()`);
await sleep(800);

/* 9. 整理历史 + 回滚 */
const histBefore = await home.eval(`chrome.runtime.sendMessage({ type: 'history-list' }).then(r => r.runs[0]?.id || '')`, true);
await home.eval(`(async () => { const ts = await chrome.tabs.query({}); const ids = ts.filter(t => t.groupId !== -1).map(t => t.id); if (ids.length) await chrome.tabs.ungroup(ids); return ids.length; })()`, true);
await sleep(800);
const groupsUngrouped = await home.eval(`chrome.tabGroups.query({}).then(g => g.length)`, true);
if (groupsUngrouped !== 0) throw new Error('预置解组失败');
await home.eval(`document.getElementById('organize').click()`);
let reorganized = false;
for (let i = 0; i < 60 && !reorganized; i++) {
  await sleep(2000);
  reorganized = await home.eval(`!document.getElementById('organize').disabled && chrome.tabGroups.query({}).then(g => g.length > 0)`, true).catch(() => false);
}
if (!reorganized) throw new Error('历史测试：重新整理失败');
const histAfter = await home.eval(`chrome.runtime.sendMessage({ type: 'history-list' }).then(r => r.runs[0]?.id || '')`, true);
if (!histAfter || histAfter === histBefore) throw new Error('历史未记录新整理');
await home.eval(`document.querySelector('#historyList .ops-btn').click()`); // 最新一条 → 回滚
await sleep(1500);
const groupsRolledBack = await home.eval(`chrome.tabGroups.query({}).then(g => g.length)`, true);
console.log(`历史: 新记录已写入=${histAfter !== histBefore}, 回滚后分组数=${groupsRolledBack}`);
if (groupsRolledBack !== 0) throw new Error('回滚未恢复到整理前（应为 0 组）');
await home.eval(`document.getElementById('organize').click()`); // 再整理，供空间测试
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  if (await home.eval(`!document.getElementById('organize').disabled && chrome.tabGroups.query({}).then(g => g.length > 0)`, true).catch(() => false)) break;
}

/* 10. 空间：保存 → 关闭全部网页标签 → 恢复 */
await home.eval(`(() => { const i = document.getElementById('spaceName'); i.value = 'QA 空间'; document.getElementById('spaceSave').click(); })()`);
await sleep(1200);
const spaceSaved = await home.eval(`[...document.querySelectorAll('#spaceList .space-name')].some(el => el.textContent === 'QA 空间')`);
if (!spaceSaved) throw new Error('空间未保存');
const webTabsBefore = await home.eval(`chrome.tabs.query({}).then(ts => ts.filter(t => /^https?:/.test(t.url || '')).length)`, true);
const groupTitlesBefore = await home.eval(`chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).sort())`, true);
await home.shot('09-home-ops.png', 1440, 900, 1.5, true);
await home.eval(`(async () => { const ts = await chrome.tabs.query({}); const ids = ts.filter(t => /^https?:/.test(t.url || '')).map(t => t.id); await chrome.tabs.remove(ids); return ids.length; })()`, true);
await sleep(1200);
await home.eval(`document.querySelector('#spaceList .ops-btn.ok').click()`);
let spaceRestored = false;
for (let i = 0; i < 20 && !spaceRestored; i++) {
  await sleep(1500);
  spaceRestored = await home.eval(`chrome.tabs.query({}).then(ts => ts.filter(t => /^https?:/.test(t.url || '')).length >= ${webTabsBefore})`, true).catch(() => false);
}
if (!spaceRestored) throw new Error('空间恢复未打开标签');
await sleep(1500);
const groupTitlesAfter = await home.eval(`chrome.tabGroups.query({}).then(gs => gs.map(g => g.title).sort())`, true);
console.log(`空间: 保存 ${webTabsBefore} 标签, 恢复后分组=${JSON.stringify(groupTitlesAfter)}`);
if (JSON.stringify(groupTitlesAfter) !== JSON.stringify(groupTitlesBefore)) throw new Error('空间恢复后分组不一致');

/* 11. 去重白名单 */
await home.eval(`(async () => { await chrome.tabs.create({ url: 'https://example.com/', active: false }); await chrome.tabs.create({ url: 'https://example.com/', active: false }); return true; })()`, true);
let ignored = false, dupWithExample = '0';
for (let i = 0; i < 12 && !ignored; i++) {
  await sleep(1000);
  dupWithExample = await home.eval(`document.getElementById('dupCount').textContent`);
  ignored = await home.eval(`(() => { const li = [...document.querySelectorAll('#dupList li')].find(li => li.querySelector('.dup-title').title.includes('example.com')); if (!li) return false; li.querySelector('.ops-btn').click(); return true; })()`);
}
if (!ignored) throw new Error('未找到 example.com 重复行');
await sleep(1200);
const wlVisible = await home.eval(`!document.getElementById('wlWrap').classList.contains('hidden') && document.querySelectorAll('#wlList .wl-chip').length > 0`);
if (!wlVisible) throw new Error('白名单芯片未显示');
await home.eval(`document.getElementById('dedup').click()`);
await sleep(1500);
const exampleSurvived = await home.eval(`chrome.tabs.query({ url: 'https://example.com/' }).then(ts => ts.length)`, true);
console.log(`白名单: 忽略前重复=${dupWithExample}, 去重后 example.com 存活=${exampleSurvived}`);
if (exampleSurvived < 2) throw new Error('白名单未保护重复标签');
await home.shot('10-home-whitelist.png', 1440, 900, 1.5, true);
await home.eval(`document.querySelector('#wlList .wl-chip button').click()`);
await sleep(1200);
const dupBack = await home.eval(`document.getElementById('dupCount').textContent`);
if (Number(dupBack) < 1) throw new Error('移除白名单后重复计数未恢复');

/* 12. 空间删除（二次确认） */
await home.eval(`document.querySelector('#spaceList .ops-btn.danger').click()`);
await sleep(300);
await home.eval(`document.querySelector('#spaceList .ops-btn.danger').click()`);
await sleep(1000);
const spaceGone = await home.eval(`document.querySelectorAll('#spaceList li').length === 0`);
if (!spaceGone) throw new Error('空间删除未生效');

/* 13. 主题：auto 跟随系统 + 手动三态 + 跨表面同步 + 暗色对比度 */
const themeProbe = s => s.eval(`({
  theme: document.documentElement.dataset.theme,
  mode: document.querySelector('[data-theme-seg] button[aria-checked="true"]')?.dataset.themeMode,
  segs: document.querySelectorAll('[data-theme-seg] button').length,
  bg: getComputedStyle(document.body).backgroundColor,
})`);
// 无头 CDP 的 setEmulatedMedia 只在该会话首次 override 时派发 matchMedia change，
// 后续翻转只更新 matches 不通知（真实系统翻转无此缺陷）。
// 因此每次模拟翻转后触发 focus，走应用的"回前台自愈"路径，保证断言确定性。
const setScheme = async (s, v) => {
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
  await s.eval(`window.dispatchEvent(new Event('focus'))`);
};
const clickMode = (s, m) => s.eval(`document.querySelector('[data-theme-seg] button[data-theme-mode="${m}"]').click()`);

// a) 默认 auto + 模拟系统深色 → 深色
await setScheme(home, 'dark');
await sleep(700);
let th = await themeProbe(home);
console.log('主题 auto+系统深色:', JSON.stringify(th));
if (th.theme !== 'dark' || th.mode !== 'auto' || th.segs !== 3) throw new Error('auto 未跟随系统深色');
await home.shot('12-home-dark.png', 1440, 900, 1.5);

// b) 暗色关键色对 WCAG ≥ 4.5（canvas 归一化 oklch → srgb）
const contrast = await home.eval(`(() => {
  const cs = getComputedStyle(document.documentElement);
  // 画 1×1 像素读回真实 sRGB 字节（canvas fillStyle 序列化可能保留 oklch，不可直接解析）
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const rgb = v => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = v.trim(); ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255]; };
  const lum = c => { const [r, g, b] = rgb(c).map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const pairs = [
    ['--color-ink', '--color-paper'], ['--color-muted', '--color-paper'], ['--color-muted', '--color-paper-2'],
    ['--color-accent-deep', '--color-paper'], ['--color-accent-ink', '--color-accent'],
    ['--color-graphite-ink', '--color-graphite'], ['--color-error', '--color-paper'],
    ['--color-success', '--color-paper-2'], ['--color-ink', '--color-key-face'],
  ];
  return pairs.map(([a, b]) => ({ pair: a + '/' + b, ratio: Math.round(ratio(cs.getPropertyValue(a), cs.getPropertyValue(b)) * 100) / 100 }));
})()`);
console.log('暗色对比度:', JSON.stringify(contrast));
const badContrast = contrast.filter(c => c.ratio < 4.5);
if (badContrast.length) throw new Error('暗色对比度不足: ' + JSON.stringify(badContrast));

// c) 手动三态：系统深色下强制浅色 / 深色
await clickMode(home, 'light');
await sleep(500);
th = await themeProbe(home);
if (th.theme !== 'light' || th.mode !== 'light') throw new Error('手动浅色未生效: ' + JSON.stringify(th));
await clickMode(home, 'dark');
await sleep(500);
th = await themeProbe(home);
if (th.theme !== 'dark' || th.mode !== 'dark') throw new Error('手动深色未生效: ' + JSON.stringify(th));

// d) 跨表面：新开的 popup 继承深色
const popTab2 = await newTab(extUrl('popup.html'));
const pop2 = new Session(popTab2.webSocketDebuggerUrl);
await pop2.ready;
await pop2.send('Page.navigate', { url: extUrl('popup.html') });
await sleep(2500);
th = await themeProbe(pop2);
console.log('popup 继承主题:', JSON.stringify(th));
if (th.theme !== 'dark') throw new Error('跨表面主题继承失败');
await pop2.shot('13-popup-dark.png', 380, 860);

// e) popup 切浅色 → 首页 / 侧边栏实时同步
await clickMode(pop2, 'light');
await sleep(800);
const homeTh = await themeProbe(home);
const spTh = await themeProbe(sp);
console.log('跨表面实时同步:', JSON.stringify({ home: homeTh.theme, sidepanel: spTh.theme }));
if (homeTh.theme !== 'light' || spTh.theme !== 'light') throw new Error('storage.onChanged 跨表面实时同步失败');

// f) 侧边栏 auto：模拟系统深/浅 → 实时翻转
await clickMode(sp, 'auto');
await setScheme(sp, 'dark');
await sleep(700);
th = await themeProbe(sp);
if (th.theme !== 'dark' || th.mode !== 'auto') throw new Error('侧边栏 auto 未跟随系统深色');
await sp.shot('14-sidepanel-dark.png', 360, 860);
await setScheme(sp, 'light');
await sleep(700);
th = await themeProbe(sp);
if (th.theme !== 'light') throw new Error('auto 未实时跟随系统切回浅色');
const mirror = await home.eval(`localStorage.getItem('themeMode')`);
if (mirror !== 'auto') throw new Error('localStorage 首帧镜像未回写: ' + mirror);
await setScheme(home, 'light');
await sleep(400);
try { await fetch(`${CDP}/json/close/${popTab2.id}`); } catch { /* ignore */ }
pop2.close();
console.log('✅ 主题三态 / auto 跟随 / 跨表面同步 / 暗色对比度 全部通过');

/* 13.5 滚动可达性：侧边栏单滚动面 + 控制台折叠；首页末组可达 */
await sp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const spReach = JSON.parse(await sp.eval(`(() => {
  const b = document.body;
  const last = document.querySelector('#list .sp-group:last-child');
  last.scrollIntoView({ block: 'end' });
  const r = last.getBoundingClientRect();
  return JSON.stringify({ docScroll: b.scrollHeight, vh: innerHeight, y: Math.round(b.scrollTop), lastTop: Math.round(r.top), lastBottom: Math.round(r.bottom), groups: document.querySelectorAll('#list .sp-group').length });
})()`));
console.log('侧边栏矮面板滚动:', JSON.stringify(spReach));
if (spReach.docScroll <= spReach.vh) throw new Error('侧边栏整面板应可滚动');
if (spReach.lastBottom > spReach.vh + 1 || spReach.lastTop < 0) throw new Error('侧边栏最后一组滚不进视口');
// 状态感知：矮面板加载时默认收起，故按当前态翻转到目标态再断言
const deckHidden = () => sp.eval(`document.getElementById('deck').classList.contains('hidden')`);
const setDeckState = async wantHidden => {
  for (let i = 0; i < 3; i++) {
    if ((await deckHidden()) === wantHidden) return;
    await sp.eval(`document.getElementById('deckToggle').click()`);
    await sleep(450);
  }
  throw new Error('控制台折叠/展开翻转未生效');
};
await setDeckState(true);
const deckCollapsed = await sp.eval(`JSON.stringify({ hidden: document.getElementById('deck').classList.contains('hidden'), aria: document.getElementById('deckToggle').getAttribute('aria-expanded'), listTop: Math.round(document.getElementById('list').getBoundingClientRect().top) })`);
console.log('控制台折叠:', deckCollapsed);
if (JSON.parse(deckCollapsed).aria !== 'false') throw new Error('折叠 aria-expanded 未同步');
const deckStored = await sp.eval(`chrome.storage.local.get('spDeckOpen').then(r => r.spDeckOpen)`, true);
if (deckStored !== false) throw new Error('折叠状态未持久化: ' + deckStored);
await sp.shot('15-sidepanel-short.png', 360, 640);
await setDeckState(false);
if (await deckHidden()) throw new Error('控制台展开未恢复');
const homeReach = JSON.parse(await home.eval(`(() => {
  const cards = document.querySelectorAll('.home-main .sp-group');
  const last = cards[cards.length - 1];
  last.scrollIntoView({ block: 'end' });
  const r = last.getBoundingClientRect();
  return JSON.stringify({ n: cards.length, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, y: Math.round(scrollY) });
})()`));
console.log('首页末组可达:', JSON.stringify(homeReach));
if (homeReach.bottom > homeReach.vh + 1) throw new Error('首页最后一组滚不进视口');
await home.eval(`window.scrollTo(0, 0)`);

/* 13.6 新标签页接管实证 + 首页自检 + popup 入口
 * 空白新标签后台不加载 NTP：激活后才解析接管；tab.url 可能仍报 chrome://newtab，用 URL+标题双信号 */
const ntProbe = JSON.parse(await home.eval(`(async () => {
  const me = await chrome.tabs.getCurrent();
  const t = await chrome.tabs.create({ active: true });
  let url = '', title = '', hit = false;
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 300)); const x = await chrome.tabs.get(t.id); url = x.url || ''; title = x.title || ''; if (url.includes('home.html') || title === document.title) { hit = true; break; } }
  await chrome.tabs.remove(t.id);
  await chrome.tabs.update(me.id, { active: true });
  return JSON.stringify({ hit, url, title });
})()`, true));
console.log('空白新标签落点:', JSON.stringify(ntProbe));
if (!ntProbe.hit) throw new Error('新标签页接管未生效: ' + JSON.stringify(ntProbe));
await home.eval(`document.getElementById('newtabCheck').click()`);
let ntStatus = '';
for (let i = 0; i < 24; i++) {
  await sleep(500);
  ntStatus = await home.eval(`document.getElementById('newtabStatus').textContent`);
  if (ntStatus && ntStatus !== '检测中…') break;
}
console.log('首页接管自检:', ntStatus);
if (!ntStatus.startsWith('已生效')) throw new Error('首页接管自检未通过: ' + ntStatus);
const popTab3 = await newTab(extUrl('popup.html'));
const pop3 = new Session(popTab3.webSocketDebuggerUrl);
await pop3.ready;
await pop3.send('Page.navigate', { url: extUrl('popup.html') });
await sleep(2500);
const homeBefore = (await listTargets()).filter(t => t.url === extUrl('home.html')).length;
await pop3.eval(`document.getElementById('openHome').click()`);
await sleep(1500);
const homeAfter = (await listTargets()).filter(t => t.url === extUrl('home.html')).length;
if (homeAfter !== homeBefore + 1) throw new Error('popup 首页入口未打开工作台');
for (const t of (await listTargets()).filter(t => t.url === extUrl('home.html')).slice(homeBefore)) {
  try { await fetch(`${CDP}/json/close/${t.id}`); } catch { /* ignore */ }
}
pop3.close();
console.log('✅ 滚动可达性 / 控制台折叠 / 新标签页接管实证 全部通过');

/* 13.7 v6：上下文增强 / 首页本地折叠 / 同链相邻 / 组名精简 / 拖拽 / ⌘K palette */
const step6 = async (label, fn, ms = 25000) => {
  console.log('13.7 →', label);
  return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('步骤超时: ' + label)), ms))]);
};
// a) 种书签 → 重新整理 → 上下文断言（页面内容 + 书签 + 活跃页）
await step6('种书签', () => home.eval(`(async () => {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0].children.find(c => c.children) || tree[0];
  const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'QA 开发资料' });
  await chrome.bookmarks.create({ parentId: folder.id, title: 'tabGroups 文档', url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups' });
  return folder.id;
})()`, true));
await step6('点击整理', () => home.eval(`document.getElementById('organize').click()`));
let reorg6 = false;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  reorg6 = await home.eval(`!document.getElementById('organize').disabled && document.getElementById('organizeBanner').classList.contains('hidden')`).catch(() => false);
  if (reorg6) break;
}
if (!reorg6) throw new Error('v6 重新整理未完成');
const ctx6 = await step6('读上下文', () => home.eval(`chrome.runtime.sendMessage({ type: 'last-context' }).then(r => r.context)`, true));
console.log('整理上下文:', JSON.stringify(ctx6));
if (!ctx6 || ctx6.withSnippet < 1) throw new Error('未读到页面内容摘要');
if (ctx6.bookmarked < 1 || ctx6.folders < 1) throw new Error('未读到书签');
if (!ctx6.activeUrl) throw new Error('缺少活跃页上下文');
// b) 同链相邻 + 组名精简
const ord6 = JSON.parse(await step6('同链相邻', () => home.eval(`(async () => {
  const ws = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: ws.id });
  const groups = await chrome.tabGroups.query({ windowId: ws.id });
  const norm = u => { try { const x = new URL(u); x.hash = ''; return x.href; } catch { return u; } };
  const bad = [];
  for (const g of groups) {
    const seq = tabs.filter(t => t.groupId === g.id).sort((a, b) => a.index - b.index).map(t => norm(t.url));
    const seen = new Map();
    seq.forEach((u, i) => { if (seen.has(u) && seen.get(u) !== i - 1) bad.push(g.title + ':' + u); seen.set(u, i); });
  }
  return JSON.stringify({ bad, names: groups.map(g => g.title), long: groups.filter(g => g.title.length > 12).map(g => g.title) });
})()`, true)));
console.log('同链相邻/组名:', JSON.stringify(ord6));
if (ord6.bad.length) throw new Error('相同链接未相邻: ' + ord6.bad.join(','));
if (ord6.long.length) throw new Error('组名未精简: ' + ord6.long.join(','));
// c) 首页折叠纯本地：不写 chrome.tabGroups、不影响侧边栏
const cp6 = JSON.parse(await step6('本地折叠', () => home.eval(`(async () => {
  const head = document.querySelector('.home-main .sp-group .sp-group-head');
  const gid = Number(head.closest('.sp-group').dataset.groupId);
  head.click();
  const hiddenHere = head.closest('.sp-group').querySelector('.sp-tabs').style.display === 'none';
  const chromeCollapsed = (await chrome.tabGroups.get(gid)).collapsed;
  head.click();
  return JSON.stringify({ hiddenHere, chromeCollapsed });
})()`, true)));
console.log('首页本地折叠:', JSON.stringify(cp6));
if (!cp6.hiddenHere || cp6.chromeCollapsed) throw new Error('首页折叠与 Chrome 标签组联动了');
const spUl6 = await sp.eval(`getComputedStyle(document.querySelector('#list .sp-tabs')).display`);
if (spUl6 === 'none') throw new Error('首页折叠影响了侧边栏');
// d) 拖拽：跨组移标签 + 组排序（合成 DragEvent 走真实 handler）
const dd6 = JSON.parse(await step6('拖拽', () => home.eval(`(async () => {
  const cards = [...document.querySelectorAll('.home-main .sp-group')].filter(c => !c.dataset.groupId.startsWith('u-'));
  if (cards.length < 2) return JSON.stringify({ skip: true });
  const li = cards[0].querySelector('.sp-tabs li');
  const dt = new DataTransfer();
  li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r1 = cards[1].getBoundingClientRect();
  cards[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: r1.top + r1.height / 2, dataTransfer: dt }));
  cards[1].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: r1.top + r1.height / 2, dataTransfer: dt }));
  li.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise(r => setTimeout(r, 1500));
  const moved = (await chrome.tabs.get(Number(li.dataset.tabId))).groupId;
  const want = Number(cards[1].dataset.groupId);
  const draggedGroup = Number(cards[1].dataset.groupId);
  const h2 = cards[1].querySelector('.sp-group-head');
  const dt2 = new DataTransfer();
  h2.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt2 }));
  const c0 = document.querySelector('.home-main .sp-group[data-group-id="' + cards[0].dataset.groupId + '"]');
  const r0 = c0.getBoundingClientRect();
  c0.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: r0.top + 2, dataTransfer: dt2 }));
  c0.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: r0.top + 2, dataTransfer: dt2 }));
  h2.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt2 }));
  await new Promise(r => setTimeout(r, 1800));
  const ws = await chrome.windows.getCurrent();
  const tabs = await chrome.tabs.query({ windowId: ws.id });
  const firstGroup = tabs.sort((a, b) => a.index - b.index).find(t => t.groupId !== -1)?.groupId;
  return JSON.stringify({ moved, want, firstGroup, draggedGroup });
})()`, true), 45000));
console.log('拖拽:', JSON.stringify(dd6));
if (!dd6.skip) {
  if (dd6.moved !== dd6.want) throw new Error('跨组拖标签未生效');
  if (dd6.firstGroup !== dd6.draggedGroup) throw new Error('拖拽组排序未生效');
}
await home.shot('17-home-dnd.png', 1440, 900, 1.5);
// e) ⌘K palette：开 → 搜标签 → 回车跳转 → 搜分组 → 回车定位 → esc 关闭
const metaK = async () => {
  await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75 });
  await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75 });
};
await metaK();
await sleep(1000);
if (await home.eval(`document.getElementById('palette').classList.contains('hidden')`)) throw new Error('⌘K 未打开 palette');
await home.send('Input.insertText', { text: 'git' });
await sleep(600);
if ((await home.eval(`document.querySelectorAll('#paletteList .palette-row').length`)) < 1) throw new Error('palette 搜索无结果');
await home.shot('16-palette.png', 1440, 900, 1.5);
await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(1000);
const activeUrl6 = await home.eval(`(async () => { const w = await chrome.windows.getCurrent(); const ts = await chrome.tabs.query({ active: true, windowId: w.id }); return ts[0]?.url || ''; })()`, true);
console.log('palette 回车跳转:', activeUrl6);
if (!/github|gitlab|stackoverflow|chrome/.test(activeUrl6)) throw new Error('palette 回车未跳转到匹配标签: ' + activeUrl6);
await metaK();
await sleep(800);
const gname6 = await home.eval(`document.querySelector('.home-main .sp-group .gname')?.textContent || ''`);
await home.send('Input.insertText', { text: gname6.slice(0, 2) });
await sleep(600);
await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(700);
const focused6 = await home.eval(`JSON.stringify({ closed: document.getElementById('palette').classList.contains('hidden'), flash: !!document.querySelector('.sp-group.flash') })`);
console.log('palette 分组定位:', focused6);
const f6 = JSON.parse(focused6);
if (!f6.closed || !f6.flash) throw new Error('palette 分组定位未生效: ' + focused6);
await metaK();
await sleep(500);
await home.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await home.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);
if (!(await home.eval(`document.getElementById('palette').classList.contains('hidden')`))) throw new Error('esc 未关闭 palette');
console.log('✅ 上下文 / 本地折叠 / 同链相邻 / 组名 / 拖拽 / ⌘K palette 全部通过');

/* 14. 清理 */
for (const t of [...seeded, spTab, homeTab]) {
  try { await fetch(`${CDP}/json/close/${t.id}`); } catch { /* ignore */ }
}
sp.close(); home.close();
console.log('✅ UI 验收 v6 全部通过');