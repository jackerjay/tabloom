#!/usr/bin/env node
import assert from'node:assert/strict';import{readFileSync}from'node:fs';import vm from'node:vm';import test from'node:test';
const ui=readFileSync(new URL('../extension/ui.js',import.meta.url),'utf8');const parser=ui.slice(ui.indexOf('function parseSearchInput('),ui.indexOf('/* Search command diagnostics'));
const context=vm.createContext({URL});vm.runInContext(parser,context);const parse=(raw,base)=>JSON.parse(JSON.stringify(context.parseSearchInput(raw,base)));
test('b selects Bookmarks, h selects History, and g selects Google without including the command in the query',()=>{assert.deepEqual(parse('b React 文档'),{query:'React 文档',provider:'bookmarks',prefix:'b'});assert.deepEqual(parse('h github 仓库'),{query:'github 仓库',provider:'history',prefix:'h'});assert.deepEqual(parse('/h'),{query:'',provider:'history',prefix:'h'});assert.deepEqual(parse(' /H github '),{query:'github',provider:'history',prefix:'h'});assert.deepEqual(parse('g C++ & 中文'),{query:'C++ & 中文',provider:'google',prefix:'g'})});
test('prefixes are case-insensitive and accept leading/multiple whitespace',()=>{assert.deepEqual(parse('  B   MDN  '),{query:'MDN',provider:'bookmarks',prefix:'b'});assert.deepEqual(parse(' H  周报 '),{query:'周报',provider:'history',prefix:'h'});assert.equal(parse('G 网页').provider,'google')});
test('ordinary words, URLs, unknown commands and lone letters remain literal',()=>{for(const raw of['google docs','bookmark guide','history log','bookmarks','localhost','https://google.com','b/h test','x 资料','b','h','g'])assert.deepEqual(parse(raw),{query:raw,provider:'all',prefix:null})});
test('a prefix overrides but does not mutate the selected fallback source',()=>{assert.equal(parse('b 文档','google').provider,'bookmarks');assert.equal(parse('g 文档','tabs').provider,'google');assert.equal(parse('文档','tabs').provider,'tabs');assert.equal(parse('文档','invalid').provider,'all')});
test('empty command queries are empty',()=>{assert.deepEqual(parse('b   '),{query:'',provider:'bookmarks',prefix:'b'});assert.deepEqual(parse('g '),{query:'',provider:'google',prefix:'g'});assert.equal(parse(null).query,'')});
function homeHarness(raw,provider='all'){
 const source=readFileSync(new URL('../extension/home.js',import.meta.url),'utf8'),calls={creates:[],events:[],toasts:[],paint:0};
 const make=()=>({value:'',attrs:{},setAttribute(k,v){this.attrs[k]=v}}),nodes={search:make(),searchProvider:make(),openPalette:make(),workspaceSearch:{}};nodes.search.value=raw;nodes.searchProvider.value=provider;
 const ctx=vm.createContext({$:id=>nodes[id],data:{currentId:7},searchTerm:'',paint:()=>calls.paint++,chrome:{tabs:{create:async args=>calls.creates.push(args)}},document:{dispatchEvent:e=>calls.events.push(e)},CustomEvent:class{constructor(type,args){this.type=type;this.detail=args.detail}},toast:(...args)=>calls.toasts.push(args)});vm.runInContext(parser,ctx);
 vm.runInContext(source.slice(source.indexOf('function updateHomeSearchInput()'),source.indexOf('/* 折叠全部')),ctx);vm.runInContext(source.slice(source.indexOf("$('workspaceSearch').onsubmit"),source.indexOf("$('searchShortcutSettings').onclick")),ctx);
 return{ctx,nodes,calls,submit:()=>nodes.workspaceSearch.onsubmit({preventDefault(){}})};
}
test('homepage g command opens encoded Google query directly, even with Bookmarks selected',async()=>{const f=homeHarness('g C++ 中文 & x=1','bookmarks');await f.submit();assert.equal(f.calls.creates.length,1);assert.equal(new URL(f.calls.creates[0].url).searchParams.get('q'),'C++ 中文 & x=1');assert.equal(f.calls.creates[0].windowId,7);assert.equal(f.calls.events.length,0)});
test('homepage b preserves raw command and base source so clearing it restores the dropdown source',async()=>{const f=homeHarness('b react','google');await f.submit();assert.equal(f.calls.creates.length,0);assert.equal(f.calls.events[0].detail.query,'b react');assert.equal(f.calls.events[0].detail.provider,'google');});
test('empty Google/Bookmarks prefixes never navigate or dispatch search',async()=>{for(const raw of['g ','b ']){const f=homeHarness(raw);await f.submit();assert.equal(f.calls.creates.length,0);assert.equal(f.calls.events.length,0);assert.equal(f.calls.toasts.length,1)}});
test('homepage prefixed input does not accidentally filter all local groups away',()=>{const f=homeHarness('b React');f.nodes.search.oninput();assert.equal(f.ctx.searchTerm,'');assert.equal(f.nodes.openPalette.attrs['aria-haspopup'],'dialog');f.nodes.search.value='g React';f.nodes.search.oninput();assert.equal(f.ctx.searchTerm,'');assert.equal(f.nodes.openPalette.attrs['aria-haspopup'],'false');f.nodes.search.value='React';f.nodes.search.oninput();assert.equal(f.ctx.searchTerm,'React')});
test('parseDirectUrl recognizes full/bare public URLs and rejects plain queries or code filenames',()=>{
 assert.equal(context.parseDirectUrl('https://github.com/facebook/react/issues/12345')?.url,'https://github.com/facebook/react/issues/12345');
 assert.equal(context.parseDirectUrl('developer.mozilla.org/en-US/docs/Web/API')?.url,'https://developer.mozilla.org/en-US/docs/Web/API');
 assert.equal(context.parseDirectUrl('localhost:8787/health')?.url,'http://localhost:8787/health');
 assert.equal(context.parseDirectUrl('127.0.0.1:3000')?.url,'http://127.0.0.1:3000/');
 for(const nonUrl of['localhost','home.js','styles.css','v0.4.0','foo bar.com','javascript:alert(1)'])assert.equal(context.parseDirectUrl(nonUrl),null,nonUrl);
});
test('homepage hero search jumps to existing tab or opens pasted public URL directly',async()=>{
 const source=readFileSync(new URL('../extension/home.js',import.meta.url),'utf8'),calls={creates:[],updates:[],wins:[],events:[],toasts:[]};
 const make=()=>({value:'',attrs:{},setAttribute(k,v){this.attrs[k]=v}}),nodes={search:make(),searchProvider:make(),openPalette:make(),workspaceSearch:{}};
 nodes.searchProvider.value='all';
 const tabs=[{id:12,windowId:9,url:'https://github.com/facebook/react'}];
 const ctx=vm.createContext({URL,$:id=>nodes[id],data:{currentId:7},searchTerm:'',paint:()=>{},chrome:{runtime:{getURL:p=>'chrome-extension://ext/'+p},tabs:{query:async()=>tabs,update:async(id,opts)=>calls.updates.push([id,opts]),create:async args=>calls.creates.push(args)},windows:{update:async(id,opts)=>calls.wins.push([id,opts])}},document:{dispatchEvent:e=>calls.events.push(e)},CustomEvent:class{constructor(type,args){this.type=type;this.detail=args.detail}},toast:(...args)=>calls.toasts.push(args)});
 vm.runInContext(parser,ctx);vm.runInContext(source.slice(source.indexOf("$('workspaceSearch').onsubmit"),source.indexOf("$('searchShortcutSettings').onclick")),ctx);
 nodes.search.value='https://github.com/facebook/react';
 await nodes.workspaceSearch.onsubmit({preventDefault(){}});
 assert.deepEqual(JSON.parse(JSON.stringify(calls.updates)),[[12,{active:true}]]);assert.deepEqual(JSON.parse(JSON.stringify(calls.wins)),[[9,{focused:true}]]);assert.equal(calls.creates.length,0);
 nodes.search.value='https://react.dev/reference/react/useEffect';
 await nodes.workspaceSearch.onsubmit({preventDefault(){}});
 assert.equal(calls.creates.length,1);assert.equal(calls.creates[0].url,'https://react.dev/reference/react/useEffect');assert.equal(calls.toasts.length,0);assert.equal(calls.events.length,0);
});
