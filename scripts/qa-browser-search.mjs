#!/usr/bin/env node
// Real extension acceptance on an isolated Brave CDP profile (9224).
// Native OS key delivery is not synthesized here: registration is read from Chrome,
// and commands.onCommand itself is covered by test-browser-search.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9224';
const sessions = [];
const fixture = createServer((req, res) => { res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(`<!doctype html><html lang="zh-CN"><head><title>${req.url === '/destination' ? '目标资料：跨窗口跳转测试' : '来源网页：全浏览器搜索测试'}</title></head><body><h1>普通网页</h1><p>搜索不应在此注入任何界面。</p></body></html>`); });
await new Promise(r => fixture.listen(8796, '127.0.0.1', r));
class Session {
  constructor(t) { this.id=t.id; this.ws=new WebSocket(t.webSocketDebuggerUrl); this.n=0; this.pending=new Map(); this.ready=new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;}); this.ws.onmessage=e=>{const m=JSON.parse(e.data),p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);};sessions.push(this); }
  send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.n,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
}
async function targets(){return(await fetch(CDP+'/json/list')).json();}
async function newPage(url){const t=await(await fetch(CDP+'/json/new?'+encodeURIComponent(url),{method:'PUT'})).json();const s=new Session(t);await s.ready;return s;}
async function until(fn,why){const end=Date.now()+12000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100));}throw Error(why);}
const extId=[...createHash('sha256').update(process.cwd()+'/extension').digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
const base='chrome-extension://'+extId+'/';
try{
  const control=await newPage(base+'popup.html');
  await until(()=>control.eval('!!globalThis.chrome?.runtime?.id'),'extension missing');
  await control.eval(`chrome.storage.sync.set({settings:{autoOrganize:false,autoOrganizeOnHome:false}})`);
  const commands=await control.eval(`chrome.commands.getAll()`);
  const registered=commands.find(c=>c.name==='search-tabs');
  assert(registered,'browser command not registered');assert(registered.shortcut,'fresh profile must assign shortcut');
  console.log('PASS actual browser shortcut registration:',registered.shortcut);
  const seed=await control.eval(`(async()=>{const source=await chrome.tabs.create({url:'http://127.0.0.1:8796/source',active:true});const target=await chrome.windows.create({url:'http://127.0.0.1:8796/destination'});const internal=await chrome.tabs.create({windowId:source.windowId,url:'chrome://version/',active:false});await chrome.tabs.update(source.id,{active:true});await chrome.windows.update(source.windowId,{focused:true});return{sourceId:source.id,sourceWindowId:source.windowId,targetId:target.tabs[0].id,targetWindowId:target.id,internalId:internal.id}})()`);
  const open=async()=>{const r=await control.eval(`chrome.runtime.sendMessage({type:'browser-search-open'})`);assert(r.ok,JSON.stringify(r));const t=await until(async()=> (await targets()).find(t=>t.url===base+'search.html'),'search window missing');const s=new Session(t);await s.ready;await until(()=>s.eval(`document.activeElement?.id==='paletteInput' && document.querySelectorAll('.palette-row').length>0`),'search did not focus/load');return {s,r};};
  const first=await open();
  assert.equal(first.r.sourceWindowId,seed.sourceWindowId);assert.equal(first.r.currentTabId,seed.sourceId);
  assert.equal(await first.s.eval(`document.querySelectorAll('#palette [role="option"]').length>0`),true);
  assert.equal(await first.s.eval(`document.body.innerText.includes('立即整理')`),false,'browser search must focus on tabs, not AI commands');
  assert.equal(await first.s.eval(`chrome.tabs.query({}).then(ts=>ts.some(t=>t.id===${seed.internalId}))`),true);
  await first.s.eval(`document.querySelector('#paletteInput').value='跨窗口跳转';document.querySelector('#paletteInput').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(()=>first.s.eval(`document.querySelectorAll('.palette-row').length===1`),'query must match destination');
  mkdirSync('.hallmark/browser-search',{recursive:true});
  const png=await first.s.send('Page.captureScreenshot',{format:'png'});writeFileSync('.hallmark/browser-search/search-window.png',Buffer.from(png.data,'base64'));
  await control.eval(`chrome.windows.update(${seed.sourceWindowId},{focused:true})`);
  const reused=await control.eval(`chrome.runtime.sendMessage({type:'browser-search-open'})`);
  assert.equal(reused.windowId,first.r.windowId);assert.equal(reused.reused,true);
  await until(()=>first.s.eval(`document.querySelector('#paletteInput').value===''`),'reuse must clear stale query');
  assert.equal((await targets()).filter(t=>t.url===base+'search.html').length,1,'only one search window');
  console.log('PASS ordinary web-page origin, native popup, singleton reuse and autofocus');
  await first.s.eval(`document.querySelector('#paletteInput').value='跨窗口跳转';document.querySelector('#paletteInput').dispatchEvent(new Event('input',{bubbles:true}))`);
  await first.s.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(async()=>!(await targets()).some(t=>t.url===base+'search.html'),'Enter must close search window');
  assert(await control.eval(`(async()=>{const t=await chrome.tabs.get(${seed.targetId});const w=await chrome.windows.get(${seed.targetWindowId});return t.active&&w.focused})()`),'jump must focus destination, not source');
  console.log('PASS Enter activates cross-window target and closes without stealing focus');
  await control.eval(`(async()=>{await chrome.tabs.update(${seed.internalId},{active:true});await chrome.windows.update(${seed.sourceWindowId},{focused:true})})()`);
  const second=await open();
  assert.equal(second.r.currentTabId,seed.internalId,'privileged Chrome page remains valid origin');
  await second.s.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(async()=>!(await targets()).some(t=>t.url===base+'search.html'),'Escape must close search');
  assert(await control.eval(`(async()=>{const t=await chrome.tabs.get(${seed.internalId});const w=await chrome.windows.get(${seed.sourceWindowId});return t.active&&w.focused})()`),'Escape must restore source internal page');
  console.log('PASS chrome:// page origin and Escape focus restoration');
  console.log('PASS browser-level tab search acceptance (registered shortcut + shared command handler; no native OS key synthesis)');
}finally{for(const s of sessions)s.ws.close();fixture.close();fixture.closeAllConnections();}
