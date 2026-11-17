#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../extension/ui.js', import.meta.url), 'utf8');
const start = source.indexOf('const AUTO_DELAY_OPTIONS =');
const end = source.indexOf('/* 统一描边图标系统', start);
const context = vm.createContext({ Option: class { constructor(label, value) { this.label=label;this.value=value; } } });
vm.runInContext(source.slice(start,end), context);
const evaluate = expression => vm.runInContext(expression, context);
test('wait settings accept custom seconds in [5, 3600] and keep a safe default for invalid values', () => {
  for(const value of [5,10,30,60,120,300,900,3600,'60','120']) assert.equal(evaluate(`normalizeAutoDelay(${JSON.stringify(value)})`), Number(value));
  for(const value of [null,0,-1,4,30.5,3601,NaN,'bad','0x20']) assert.equal(evaluate(`normalizeAutoDelay(${JSON.stringify(value)})`),30);
});
test('both surfaces use a populated, labelled selector and can restore stored preset or custom choice', () => {
  context.select={ options:[], set innerHTML(_){this.options=[];}, add(option){this.options.push(option);}, value:'' };
  evaluate('paintAutoDelay(select, 300)');
  assert.deepEqual(Array.from(context.select.options, o=>o.label),['30 秒','1 分钟','5 分钟','15 分钟','自定义时长…']);
  assert.equal(context.select.value,'300');
  evaluate('paintAutoDelay(select, 120)');
  assert.deepEqual(Array.from(context.select.options, o=>o.label),['30 秒','1 分钟','5 分钟','15 分钟','2 分钟（自定义）','自定义时长…']);
  assert.equal(context.select.value,'120');
  for(const file of ['home.html','sidepanel.html']) {
    const html=readFileSync(new URL('../extension/'+file,import.meta.url),'utf8');
    assert.equal((html.match(/id="autoDelay"/g)||[]).length,1);
    assert(html.includes('for="autoDelay"'));
    assert(html.includes('aria-describedby="autoDelayHint"'));
  }
});
test('analysis feedback reports only returned title/cache data, including all-hit no-op', () => {
  assert.equal(evaluate('analysisSummary({})'),'');
  const message=evaluate('analysisSummary({titleStats:{updated:0,unchanged:4,skipped:1},cache:{hits:4,misses:0}})');
  assert(message.includes('更新 0 个标签标题'));
  assert(message.includes('4 个标题未变'));
  assert(message.includes('1 页保留原标题'));
  assert(message.includes('复用 4 页缓存'));
  assert(!message.includes('未命中'));
  assert(!message.includes('undefined'));
});
