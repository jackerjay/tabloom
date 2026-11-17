#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('../extension/ui.js',import.meta.url),'utf8');
const part=source.slice(source.indexOf('function describeSearchShortcut'),source.indexOf('/* 统一描边图标系统'));
const ctx=vm.createContext({});vm.runInContext(part,ctx);
const manifest={version:'0.4.0',commands:{'search-tabs':{description:'打开搜索（标签 / 书签 / Google）'}}};
test('missing loaded command is diagnosed from manifest rather than assuming repository declaration',()=>{
 const result=ctx.describeSearchShortcut({version:'0.1.0'},[{name:'_execute_action',shortcut:'⌘K'}]);
 assert.equal(result.state,'missing');assert.match(result.message,/v0\.1\.0/);assert.match(result.message,/激活该扩展程序/);
});
test('old loaded worker/manifest is distinguished from the current inline-overlay version',()=>{
 const result=ctx.describeSearchShortcut({...manifest,version:'0.2.0'},[{name:'search-tabs',shortcut:'⌘K'}]);
 assert.equal(result.state,'outdated');assert.match(result.message,/当前页内搜索浮层/);
});
test('loaded v0.3.0 is not mistaken for the fixed main-page search routing',()=>{
 const result=ctx.describeSearchShortcut({...manifest,version:'0.3.0'},[{name:'search-tabs',shortcut:'⌘K'}]);
 assert.equal(result.state,'outdated');assert.match(result.message,/主页面并居中/);
});
test('activation binding is not falsely reported as the search binding',()=>{
 const result=ctx.describeSearchShortcut(manifest,[{name:'search-tabs',shortcut:''},{name:'_execute_action',shortcut:'⌘K'}]);
 assert.equal(result.state,'activation-bound');assert.equal(result.shortcut,'');assert.match(result.message,/清除/);
});
test('unregistered, unassigned and assigned commands stay distinct',()=>{
 assert.equal(ctx.describeSearchShortcut(manifest,[]).state,'unregistered');
 assert.equal(ctx.describeSearchShortcut(manifest,[{name:'search-tabs',shortcut:''}]).state,'unassigned');
 const result=ctx.describeSearchShortcut(manifest,[{name:'search-tabs',shortcut:'⌘K'}]);
 assert.equal(result.state,'ready');assert.equal(result.shortcut,'⌘K');assert.match(result.message,/范围以 Chrome 设置为准/);
});
test('unreadable command state clears a previously ready status instead of claiming success',async()=>{
 ctx.chrome={runtime:{getManifest:()=>manifest,id:'test'},commands:{getAll:async()=>{throw Error('unavailable')}}};
 const status={textContent:'ready',dataset:{state:'ready'}},hint={textContent:'⌘K'},version={};
 await ctx.refreshSearchCommand(status,version,hint);assert.equal(status.dataset.state,'unknown');assert.equal(hint.textContent,'未确认');
});
test('Bookmark connection count reads local Chrome bookmarks tree without network calls',async()=>{
 const home=readFileSync(new URL('../extension/home.js',import.meta.url),'utf8');
 const snippet=home.slice(home.indexOf('async function refreshBookmarkIndexStatus'),home.indexOf("window.addEventListener('focus', () => { refreshSearchShortcut()"));
 const nodes={bookmarkIndexStatus:{textContent:''},bookmarkStatusRefresh:{disabled:false,textContent:'刷新统计'}};
 const context=vm.createContext({$:id=>nodes[id],chrome:{bookmarks:{getTree:async()=>[{children:[{title:'Dev',children:[{url:'https://github.com/'},{url:'https://developer.mozilla.org/'}]}]}]}}});
 vm.runInContext(snippet,context);await nodes.bookmarkStatusRefresh.onclick();
 assert.equal(nodes.bookmarkStatusRefresh.disabled,false);
 assert.match(nodes.bookmarkIndexStatus.textContent,/已索引 2 条本地书签/);
});
test('workbench exposes native search form and explicit source selection without losing existing tab filter',()=>{
 const html=readFileSync(new URL('../extension/home.html',import.meta.url),'utf8');
 assert(html.includes('id="workspaceSearch"'));for(const provider of ['all','tabs','bookmarks','history','google'])assert(html.includes('value="'+provider+'"'));
 assert(html.includes('id="search"'));assert(html.includes('id="openPalette"'));assert(html.includes('type="submit"'));
 assert(html.includes('id="bookmarkStatusRefresh"'));assert(html.includes('本地书签'));
});
