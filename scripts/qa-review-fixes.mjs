#!/usr/bin/env node
// Focused acceptance for audit fixes. Isolated Brave CDP 9224 only; no real user profile.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9224';
const out = '.hallmark/audit-20261113';
mkdirSync(out, { recursive: true });
const fixture = createServer((req, res) => {
  const names = { '/api': 'Chrome 标签分组 API：创建、排序与恢复分组', '/keyboard': '命令面板的键盘导航与无障碍实践', '/bookmarks': '书签上下文与页面摘要采集说明', '/repo': '标签整理项目：本轮开发与回归清单', '/review': '代码评审：同链接分组完整性', '/docs': '交互设计：搜索优先的标签工作台', '/notes': '产品笔记：从控制台到工作上下文' };
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh-CN"><head><title>${names[req.url] || '另一个窗口的工作标签'}</title><meta name="description" content="真实浏览器回归测试页面"></head><body><h1>${names[req.url] || '工作页面'}</h1><p>用于验证页面摘要、标签分组和快捷搜索的本地测试资料。</p></body></html>`);
});
await new Promise(r => fixture.listen(8795, '127.0.0.1', r));
const sessions = [];
class Session {
  constructor(t) {
    this.ws = new WebSocket(t.webSocketDebuggerUrl); this.n = 0; this.pending = new Map();
    this.ready = new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); };
    sessions.push(this);
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.n; const timer = setTimeout(() => { this.pending.delete(id); reject(Error('CDP timeout ' + method)); }, 15000); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
  async shot(name, width = 1440, height = 900) { await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await this.eval('document.fonts.ready.then(()=>true)'); await this.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await until(() => this.eval('!document.documentElement.classList.contains("theme-switching")'), 'theme did not settle'); const r = await this.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/${name}.png`, Buffer.from(r.data, 'base64')); }
}
async function newPage(url) { const t = await (await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json(); const s = new Session(t); await s.ready; await s.send('Page.enable'); return s; }
async function until(fn, message, ms = 10000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 120)); } throw Error(message); }
const id = [...createHash('sha256').update(process.cwd() + '/extension').digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const base = `chrome-extension://${id}/`;
try {
  const bootstrap = await newPage(base + 'popup.html');
  await until(() => bootstrap.eval('!!globalThis.chrome?.runtime?.id'), 'extension did not load');
  await bootstrap.eval(`chrome.storage.sync.set({settings:{autoOrganize:false,autoOrganizeOnHome:false,density:'comfortable'}})`);
  // This suite exercises the optional transient layout; pinned-default coverage lives in qa-home-settings.
  await bootstrap.eval(`localStorage.setItem('homeSettingsLayout',JSON.stringify({pinned:false,visible:false}))`);
  const seed = await bootstrap.eval(`(async()=>{const paths=['api','keyboard','bookmarks','repo','review','docs','notes']; const tabs=[]; for(const p of paths)tabs.push(await chrome.tabs.create({url:'http://127.0.0.1:8795/'+p,active:false}));const w=tabs[0].windowId;const gs=[];for(const [i,name,color]of [[0,'扩展开发','blue'],[1,'代码协作','green'],[2,'设计资料','purple']]){const ids=i===0?tabs.slice(0,3):i===1?tabs.slice(3,5):tabs.slice(5);const g=await chrome.tabs.group({tabIds:ids.map(t=>t.id)});await chrome.tabGroups.update(g,{title:name,color,collapsed:i===1});gs.push(g);}return{ids:tabs.map(t=>t.id),windowId:w,groups:gs};})()`);
  const home = await newPage(base + 'home.html');
  await until(() => home.eval('document.querySelectorAll(".sp-group").length>=3'), 'home groups missing');
  await until(() => home.eval('document.querySelector(".sp-tabs .t")?.innerText.includes("Chrome")'), 'fixture titles not ready');
  console.log('PASS homepage fixtures loaded');
  assert.equal(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`), false);
  const screenshotWidths = [[1440,900,'flow-home',3],[980,800,'flow-home-tablet',2],[390,844,'flow-home-narrow',1],[320,800,'flow-home-320',1]];
  for (const [w,h,name,columns] of screenshotWidths) {
    await home.shot(name,w,h);
    assert(await home.eval('document.documentElement.scrollWidth<=innerWidth'), `horizontal overflow at ${w}`);
    assert(await home.eval(`document.querySelector('#search').getBoundingClientRect().top < document.querySelector('#windows').getBoundingClientRect().top`));
    assert.equal(await home.eval(`getComputedStyle(document.querySelector('.group-grid')).gridTemplateColumns.split(' ').length`), columns);
    assert.equal(await home.eval(`new Set([...document.querySelector('.group-grid').children].slice(0,${columns}).map(g=>Math.round(g.getBoundingClientRect().left))).size`), columns, 'every available column must be used');
    assert(await home.eval(`document.querySelector('.home-main').getBoundingClientRect().right >= document.querySelector('.home-body').getBoundingClientRect().right - parseFloat(getComputedStyle(document.querySelector('.home-body')).paddingRight) - 1`), 'main must use full content width');
    assert(await home.eval(`[...document.querySelectorAll('.group-grid > .sp-group')].every(g=>g.getClientRects().length===1)`), 'groups must not split across columns');
    const beforeDrawer = await home.eval(`document.querySelector('#windows').getBoundingClientRect().toJSON()`);
    await home.eval(`document.querySelector('#openSettings').focus();document.querySelector('#openSettings').click()`);
    assert(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`));
    assert.deepEqual(await home.eval(`document.querySelector('#windows').getBoundingClientRect().toJSON()`), beforeDrawer, 'settings must never move or shrink tab content');
    const drawer = await home.eval(`document.querySelector('#settingsDrawer').getBoundingClientRect().toJSON()`);
    assert.equal(Math.round(drawer.right), w); assert.equal(drawer.top, 0);
    assert.equal(Math.round(drawer.height), h); assert(drawer.width <= w);
    if (w === 1440 || w === 390) await home.shot(w === 1440 ? 'settings-drawer' : 'settings-drawer-narrow', w, h);
    await home.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`), false);
    assert.equal(await home.eval('document.activeElement.id'), 'openSettings');
  }
  await home.shot('flow-home');
  const flowRects = await home.eval(`[...document.querySelector('.group-grid').children].map(g=>{const r=g.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height}})`);
  assert(new Set(flowRects.map(r=>Math.round(r.height))).size > 1, 'test uses unequal group heights');
  for (let i=0;i<flowRects.length;i++) for(let j=i+1;j<flowRects.length;j++) {
    const a=flowRects[i],b=flowRects[j];
    assert(!(a.x<b.right-1 && a.right>b.x+1 && a.y<b.bottom-1 && a.bottom>b.y+1), 'masonry cards must not overlap');
  }
  assert(await home.eval(`[...document.querySelectorAll('.home-deck > details')].every(d=>!d.open)`), 'all secondary tools default closed');
  assert(await home.eval(`!document.querySelector('.home-main').contains(document.querySelector('#settingsDrawer'))`), 'settings are outside the content flow');
  await home.eval(`document.querySelector('#openSettings').click();document.querySelector('#closeSettings').click()`);
  assert.equal(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`), false, 'explicit close works');
  await home.eval(`document.querySelector('#openSettings').click()`);
  const outsidePoint = await home.eval(`(()=>{const r=document.querySelector('#search').getBoundingClientRect();return {x:r.left+30,y:r.top+r.height/2}})()`);
  await home.send('Input.dispatchMouseEvent',{type:'mousePressed',...outsidePoint,button:'left',clickCount:1});
  await home.send('Input.dispatchMouseEvent',{type:'mouseReleased',...outsidePoint,button:'left',clickCount:1});
  assert.equal(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`), false, 'outside click light-dismisses settings');
  await home.eval(`document.querySelector('#openSettings').click();document.dispatchEvent(new CustomEvent('tt-open-palette'))`);
  await until(() => home.eval(`!document.querySelector('#palette').classList.contains('hidden')`), 'inline search must still open');
  assert.equal(await home.eval(`document.querySelector('#settingsDrawer').matches(':popover-open')`), false, 'settings must not cover command palette');
  await home.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  const expandedHeight = await home.eval(`document.querySelector('.group-grid').getBoundingClientRect().height`);
  await home.eval(`document.querySelector('#collapseAll').click()`);
  await until(() => home.eval(`document.querySelector('.group-grid').getBoundingClientRect().height < ${expandedHeight - 50}`), 'masonry must compact after collapsing');
  await home.eval(`document.querySelector('#expandAll').click()`);
  await home.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  console.log('PASS full-width 3/2/1 column flow, unbroken groups and collapse compaction at 320/390/980/1440');
  const localCollapse = await home.eval(`(async()=>{const gid=${seed.groups[0]}; const b=document.querySelector('[data-group-id="'+gid+'"] .sp-group-head'); b.click(); const native=await chrome.tabGroups.get(gid);return{expanded:b.getAttribute('aria-expanded'),native:native.collapsed}})()`);
  assert.equal(localCollapse.expanded,'false'); assert.equal(localCollapse.native,false);
  await home.eval(`document.querySelector('[data-group-id="${seed.groups[0]}"] .sp-group-head').click()`);
  console.log('PASS home collapse does not change native collapse');
  const baseline = await home.eval(`(async()=>{const ts=await chrome.tabs.query({windowId:${seed.windowId}});const gs=await chrome.tabGroups.query({windowId:${seed.windowId}});return ts.filter(t=>${JSON.stringify(seed.ids)}.includes(t.id)).map(t=>({id:t.id,index:t.index,group:gs.find(g=>g.id===t.groupId)?.title,color:gs.find(g=>g.id===t.groupId)?.color,collapsed:gs.find(g=>g.id===t.groupId)?.collapsed}))})()`);
  assert(await home.eval(`(async()=>{await chrome.storage.session.set({proposal:{windowId:${seed.windowId},groups:[{name:'临时合并',color:'red',tabIds:${JSON.stringify(seed.ids)}}],source:'heuristic',tabCount:7}});return(await chrome.runtime.sendMessage({type:'apply'})).ok})()`));
  assert(await home.eval(`chrome.runtime.sendMessage({type:'undo'}).then(r=>r.ok)`));
  const restored = await home.eval(`(async()=>{const ts=await chrome.tabs.query({windowId:${seed.windowId}});const gs=await chrome.tabGroups.query({windowId:${seed.windowId}});return ts.filter(t=>${JSON.stringify(seed.ids)}.includes(t.id)).map(t=>({id:t.id,index:t.index,group:gs.find(g=>g.id===t.groupId)?.title,color:gs.find(g=>g.id===t.groupId)?.color,collapsed:gs.find(g=>g.id===t.groupId)?.collapsed}))})()`);
  assert.deepEqual(restored, baseline);
  console.log('PASS native Chrome undo recreates destroyed groups, colors, collapse and order');
  await home.eval('reload()');
  await home.eval(`document.querySelector('.order-down:not(:disabled)').click()`);
  await until(() => home.eval(`document.querySelector('.gname').textContent==='代码协作'`), 'keyboard equivalent group ordering failed');
  const membership = await home.eval(`(async()=>{const ts=await chrome.tabs.query({windowId:${seed.windowId}});const gs=await chrome.tabGroups.query({windowId:${seed.windowId}});return ts.filter(t=>${JSON.stringify(seed.ids)}.includes(t.id)).map(t=>({id:t.id,group:gs.find(g=>g.id===t.groupId)?.title})).sort((a,b)=>a.id-b.id)})()`);
  assert.deepEqual(membership, baseline.map(({id,group})=>({id,group})).sort((a,b)=>a.id-b.id));
  await home.eval(`chrome.runtime.sendMessage({type:'undo'})`); await home.eval('reload()');
  await home.eval(`(()=>{const s=document.querySelector('[data-tab-id="${seed.ids[0]}"] .tab-move');s.value=[...s.options].find(o=>o.text==='设计资料').value;s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => home.eval(`chrome.tabs.get(${seed.ids[0]}).then(async t=>(await chrome.tabGroups.get(t.groupId)).title==='设计资料')`), 'select moving failed');
  await home.eval(`chrome.runtime.sendMessage({type:'undo'})`); await home.eval('reload()');
  console.log('PASS group move buttons and native select keyboard alternatives');
  await home.eval(`document.querySelector('#openPalette').focus();document.querySelector('#openPalette').click()`);
  await until(() => home.eval('!!document.querySelector("#paletteInput").getAttribute("aria-activedescendant")'), 'palette not loaded');
  await home.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await home.eval('document.activeElement.id'),'paletteInput');
  await home.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  assert(await home.eval(`document.querySelector('#'+document.querySelector('#paletteInput').getAttribute('aria-activedescendant')).getAttribute('aria-selected')==='true'`));
  await home.shot('fixed-palette');
  await home.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await home.eval('document.activeElement.id'),'openPalette');
  console.log('PASS real keyboard palette focus trap, active descendant, restore');
  const foreign = await home.eval(`(async()=>{const w=await chrome.windows.create({url:'http://127.0.0.1:8795/foreign'});const g=await chrome.tabs.group({tabIds:[w.tabs[0].id]});await chrome.tabGroups.update(g,{title:'异窗资料',color:'cyan'});return{wid:w.id,gid:g}})()`);
  await home.eval('reload()');
  const before = await home.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,group:x.groupId,window:x.windowId,index:x.index})))`);
  await home.eval(`(()=>{const a=document.querySelector('.sp-group-head[draggable]');const target=document.querySelector('[data-group-id="${foreign.gid}"]');const dt=new DataTransfer();a.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:dt}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));a.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}));})()`);
  const after = await home.eval(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,group:x.groupId,window:x.windowId,index:x.index})))`);
  assert.deepEqual(after,before);
  await home.eval(`(async()=>{scope=${seed.windowId};document.querySelector('#scope').value=String(scope);await reload();document.querySelector('#search').value='无匹配';searchTerm='无匹配';paint();})()`);
  await home.eval(`document.dispatchEvent(new CustomEvent('tt-focus-group',{detail:{groupId:${foreign.gid},windowId:${foreign.wid}},cancelable:true}))`);
  await until(() => home.eval(`!!document.querySelector('[data-group-id="${foreign.gid}"] .sp-group-head:focus')`), 'cross scope focus failed');
  assert.equal(await home.eval('scope'),'all');
  console.log('PASS cross-window drag rejected without mutation and group search clears scope/filter');
  await home.eval(`setThemeMode('dark')`); await home.shot('fixed-home-dark');
  await home.eval(`setThemeMode('light')`);
  console.log('PASS audit fixes UI acceptance');
} finally { for(const s of sessions)s.ws.close(); fixture.closeAllConnections(); await new Promise(r=>fixture.close(r)); }
