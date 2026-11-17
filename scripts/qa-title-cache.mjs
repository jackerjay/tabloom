#!/usr/bin/env node
// Isolated Brave CDP 9224 + the running local ACP service. At most two fresh page analyses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const CDP=process.env.CDP_URL||'http://127.0.0.1:9224';
const sessions=[];
const fixture=createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh-CN"><head><title>企业平台 - 工作区 - Portal</title><meta name="description" content="员工差旅报销：发票提交与财务审批流程"></head><body><nav>首页 工作区 导航 帮助</nav><main><h1>差旅报销提交指南</h1><p>员工出差结束后，上传交通、住宿发票，填写费用明细和出差事由。直属主管审核业务真实性，财务核验发票后发起报销付款。</p><p>本页说明报销申请所需材料、主管审核与财务付款的流程。</p></main></body></html>');});
await new Promise(r=>fixture.listen(8797,'127.0.0.1',r));
class Session{
 constructor(t){this.id=t.id;this.ws=new WebSocket(t.webSocketDebuggerUrl);this.n=0;this.pending=new Map();this.ready=new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);};sessions.push(this);}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},210000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
}
async function newPage(url){const t=await(await fetch(CDP+'/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();const s=new Session(t);await s.ready;return s;}
async function until(fn,why,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error(why);}
const id=[...createHash('sha256').update(process.cwd()+'/extension').digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const base='chrome-extension://'+id+'/';
try{
 const control=await newPage(base+'sidepanel.html');
 await until(()=>control.eval('!!globalThis.chrome?.runtime?.id'),'extension missing');
 await control.eval(`chrome.storage.sync.set({settings:{autoOrganize:false,autoOrganizeOnHome:false,autoOrganizeDelaySeconds:30}})`);
 await until(()=>control.eval(`document.querySelector('#autoDelay')?.options.length===4`),'wait selector not initialized');
 await control.eval(`document.querySelector('#autoDelay').value='300';document.querySelector('#autoDelay').dispatchEvent(new Event('change',{bubbles:true}))`);
 await until(()=>control.eval(`chrome.storage.sync.get('settings').then(r=>r.settings.autoOrganizeDelaySeconds===300)`),'delay not persisted');
 const home=await newPage(base+'home.html');
 await until(()=>home.eval(`document.querySelector('#autoDelay')?.value==='300'`),'home did not inherit delay');
 await home.eval(`document.querySelector('#openSettings').click();document.querySelector('#autoDelay').value='60';document.querySelector('#autoDelay').dispatchEvent(new Event('change',{bubbles:true}))`);
 await until(()=>control.eval(`document.querySelector('#autoDelay').value==='60'`),'sidepanel did not sync delay');
 await home.eval(`document.querySelector('#closeSettings').click()`);
 console.log('PASS configurable automatic wait persists and syncs across sidebar/home');
 const seed=await control.eval(`(async()=>{const url='http://127.0.0.1:8797/expense-guide?qa=${Date.now().toString(36)}';const w=await chrome.windows.create({url});const a=w.tabs[0];const b=await chrome.tabs.create({windowId:w.id,url,active:false});return{windowId:w.id,ids:[a.id,b.id],url}})()`);
 await until(()=>control.eval(`chrome.tabs.query({windowId:${seed.windowId}}).then(ts=>ts.length===2&&ts.every(t=>t.status==='complete'))`),'fixture did not load');
 const organize=()=>control.eval(`chrome.runtime.sendMessage({type:'organize',apply:true,windowId:${seed.windowId}})`);
 console.log('ACP analysis 1/2: expense page content');
 const first=await organize();assert(first.ok,JSON.stringify(first));assert.equal(first.source,'ai',JSON.stringify(first));assert(first.backend?.startsWith('acp:'),'acceptance requires the real ACP path');
 assert.equal(first.cache.misses,2);assert.equal(first.cache.hits,0);
 await until(()=>control.eval(`chrome.tabs.query({windowId:${seed.windowId}}).then(ts=>ts.every(t=>t.title!=='企业平台 - 工作区 - Portal'&&t.title.length>0&&[...t.title].length<=48))`),'actual Chrome tab titles not updated');
 const originalTitles=await control.eval(`chrome.tabs.query({windowId:${seed.windowId}}).then(ts=>ts.map(t=>({id:t.id,title:t.title})))`);
 assert.equal(originalTitles[0].title,originalTitles[1].title,'duplicate content shares title analysis');
 console.log('PASS ACP receives content and changes actual Chrome Tab title:',JSON.stringify(originalTitles));
 const historyBefore=await control.eval(`chrome.runtime.sendMessage({type:'history-list'}).then(r=>r.runs.length)`);
 const repeated=await organize();assert(repeated.ok,JSON.stringify(repeated));assert.equal(repeated.cache.hits,2);assert.equal(repeated.cache.misses,0);assert.equal(repeated.titleStats.updated,0);
 assert.equal(await control.eval(`chrome.runtime.sendMessage({type:'history-list'}).then(r=>r.runs.length)`),historyBefore,'cache-only unchanged pass must not create another undo/history');
 await control.eval(`chrome.scripting.executeScript({target:{tabId:${seed.ids[0]}},func:()=>{document.title='网站自行重写的冗长导航标题';}})`);
 await until(()=>control.eval(`chrome.tabs.get(${seed.ids[0]}).then(t=>t.title===${JSON.stringify(originalTitles[0].title)})`),'one-document title observer did not preserve AI title');
 console.log('PASS unchanged pages hit cache, do not regroup/history, and preserve short title');
 await control.eval(`chrome.scripting.executeScript({target:{tabId:${seed.ids[0]}},func:()=>{document.querySelector('meta[name="description"]').content='云资源预算与成本优化指南';document.querySelector('main').innerHTML='<h1>云资源预算预警</h1><p>团队部署前制定每月云资源预算，持续跟踪计算、存储与网络成本。超出预算阈值时发送预警，关闭空闲实例并调整资源规格。</p><p>这里说明云成本预算、超额预警与闲置资源回收。</p>';document.title='云资源预算的新页面';}})`);
 console.log('ACP analysis 2/2: changed content at the same URL');
 const changed=await organize();assert(changed.ok,JSON.stringify(changed));assert.equal(changed.source,'ai');assert.equal(changed.cache.misses,1);assert.equal(changed.cache.hits,1);
 await until(()=>control.eval(`chrome.tabs.get(${seed.ids[0]}).then(t=>t.title!==${JSON.stringify(originalTitles[0].title)}&&t.title!=='云资源预算的新页面'&&t.title.length>0)`),'same-URL changed content did not get a fresh title');
 const final=await organize();assert(final.ok,JSON.stringify(final));assert.equal(final.cache.hits,2);assert.equal(final.cache.misses,0);assert.equal(final.titleStats.updated,0);
 console.log('PASS changed content invalidates only its own cache; next pass is all-hit');
 const timerTab=await control.eval(`chrome.tabs.create({windowId:${seed.windowId},url:${JSON.stringify(seed.url+'&timer=1')},active:false})`);
 try {
   await control.eval(`(async()=>{const {settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,autoOrganize:true,autoOrganizeDelaySeconds:30}})})()`);
   await until(()=>control.eval(`chrome.alarms.getAll().then(as=>as.some(a=>a.name.startsWith('ai-tab-auto-organize:')&&a.scheduledTime-Date.now()>25000&&a.scheduledTime-Date.now()<=31000))`),'native 30-second alarm missing');
   await control.eval(`(async()=>{const {settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,autoOrganizeDelaySeconds:60}})})()`);
   await until(()=>control.eval(`chrome.alarms.getAll().then(as=>as.some(a=>a.name.startsWith('ai-tab-auto-organize:')&&a.scheduledTime-Date.now()>55000&&a.scheduledTime-Date.now()<=61000))`),'changed wait did not reschedule native alarm');
 } finally {
   await control.eval(`(async()=>{const {settings}=await chrome.storage.sync.get('settings');await chrome.storage.sync.set({settings:{...settings,autoOrganize:false,autoOrganizeDelaySeconds:60}})})()`);
   await until(()=>control.eval(`chrome.alarms.getAll().then(as=>!as.some(a=>a.name.startsWith('ai-tab-auto-organize')))`),'turning auto off did not clear native alarms');
   await control.eval(`chrome.tabs.remove(${timerTab.id})`);
 }
 console.log('PASS native automatic alarm uses configured wait, reschedules and cancels (no timed model call)');
 await control.send('Emulation.setDeviceMetricsOverride',{width:360,height:860,deviceScaleFactor:1,mobile:false});
 await control.eval(`if(document.querySelector('#deck').classList.contains('hidden'))document.querySelector('#deckToggle').click()`);
 await control.eval('document.fonts.ready.then(()=>true)');
 mkdirSync('.hallmark/title-cache',{recursive:true});const shot=await control.send('Page.captureScreenshot',{format:'png'});writeFileSync('.hallmark/title-cache/sidepanel-controls.png',Buffer.from(shot.data,'base64'));
 assert(await control.eval('document.documentElement.scrollWidth<=innerWidth'),'sidebar horizontal overflow');
 console.log('PASS title/cache/config browser acceptance; two bounded real ACP analyses completed');
}finally{for(const s of sessions)s.ws.close();fixture.close();fixture.closeAllConnections();}
