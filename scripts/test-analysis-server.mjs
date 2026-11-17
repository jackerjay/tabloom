#!/usr/bin/env node
// Offline integration proof: real cache files in a guarded temp directory, only mocked ACP/HTTP.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { AnalysisCache, CACHE_TTL_MS, CACHE_MAX_ENTRIES } from '../server/analysis-cache.mjs';

const sourceURL = new URL('../server/server.mjs', import.meta.url);
const source = readFileSync(sourceURL, 'utf8');
const offlineSource = source.slice(0, source.indexOf('/* ---------------- HTTP 服务'))
  .replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify(sourceURL.href));
const root = await mkdtemp(path.join(os.tmpdir(), 'tab-analysis-test-'));
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tabsFromPrompt = text => JSON.parse(text.slice(text.lastIndexOf('标签页列表：\n') + '标签页列表：\n'.length));
const tab = (id, extra = {}) => ({ id, title: '无意义网站原始标题', url: `https://example.test/${id}`,
  snippet: `正文讲解主题 ${id} 的设计、应用与实现。`, bookmarkPath: '研究/技术', ...extra });
function answer(text, { name = '技术研究', title = '正文主题与实现' } = {}) {
  const tabs = tabsFromPrompt(text);
  return JSON.stringify({ groups: [{ name, color: 'blue', tabIds: tabs.map(t => t.id) }],
    tabTitles: tabs.filter(t => t.snippet).map(t => ({ id: t.id, title })) });
}
let nextFile = 0;
function harness({ file = path.join(root, `cache-${++nextFile}.json`), kind = 'acp', model = 'mock-A',
  baseUrl = 'http://mock.invalid', respond = text => answer(text), Cache = AnalysisCache } = {}) {
  const prompts = [], requests = [], clients = [];
  let config = `model = "${model}"\nopenai_base_url = "http://mock-gateway.invalid"\n`;
  const env = { TAB_ANALYSIS_CACHE_FILE: file,
    ...(kind === 'acp' ? { ACP_COMMAND: 'mock-acp' } : {}),
    ...(kind === 'http' ? { LLM_BASE_URL: baseUrl, LLM_API: 'openai', LLM_MODEL: model } : {}) };
  class MockAcpClient {
    constructor() { this.dead = false; this.agentInfo = { name: 'mock' }; clients.push(this); }
    start() {}
    async initialize() {}
    async prompt(text, options) { prompts.push({ text, options }); return respond(text); }
    close() { this.dead = true; }
  }
  const context = vm.createContext({ URL, AbortController, createHash, AnalysisCache: Cache,
    AcpClient: MockAcpClient, path, os, fileURLToPath, setTimeout, clearTimeout,
    console: { log() {}, error() {} }, process: { env, pid: process.pid },
    existsSync: filename => kind === 'acp' && (filename.endsWith('/.codex-home/config.toml') || filename.endsWith('/.codex-home')),
    readFileSync: filename => { assert.match(filename, /\.codex-home\/config\.toml$/); return config; },
    writeFileSync: (filename, text) => { assert.match(filename, /\.codex-home\/config\.toml$/); config = text; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (kind !== 'http') throw new Error('network forbidden in offline test');
      let data;
      if (url.endsWith('/v1/models')) data = { data: [{ id: model }] };
      else if (url.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(options.body), text = body.messages.map(m => m.content).join('\n\n');
        prompts.push({ text, body });
        data = { choices: [{ message: { content: await respond(text) } }] };
      } else throw new Error(`unexpected mocked URL: ${url}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    },
  });
  vm.runInContext(offlineSource + '\nglobalThis.api = { organize, buildMessages, parseGroups, parseAnalysis, validateTitle, analysisCache, analysisInFlight, setModel };', context);
  return { api: context.api, prompts, requests, clients, file,
    async organize(tabs, opts = {}) { const result = await context.api.organize({ tabs, ...opts }); assert.equal(result.status, 200); return plain(result.json); } };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ids = result => result.groups.flatMap(g => g.tabIds).sort((a, b) => a - b);

test('ACP sees actual 1200-character body, title rules and the extended JSON schema', async () => {
  const snippet = '正'.repeat(1100) + '正文末尾关键主题';
  const h = harness({ respond: text => {
    const payload = tabsFromPrompt(text);
    assert.equal(payload[0].snippet, snippet);
    assert.match(text, /阅读正文并总结实际页面主题/);
    assert.match(text, /中文不超过20字，英文不超过8词/);
    assert.match(text, /禁止仅用网站名\/域名/);
    assert.match(text, /不要调用任何工具/);
    assert.match(text, /"tabTitles"/);
    return answer(text, { title: '正文末尾关键主题' });
  } });
  const result = await h.organize([tab(42, { snippet })]);
  assert.deepEqual(result.tabTitles, [{ id: 42, title: '正文末尾关键主题', source: 'ai' }]);
  assert.deepEqual(result.cache, { hits: 0, misses: 1, hitTabIds: [], missTabIds: [42] });
  assert.equal(result.source, 'ai');
  assert.equal(h.prompts.length, 1);
  assert.ok(h.prompts[0].options.timeoutMs <= 180000);
  for (const key of ['groups', 'source', 'backend', 'note', 'elapsedMs']) assert.ok(key in result);
});

test('same URL/body deduplicates inference, maps every original ID and survives self-renaming', async () => {
  const h = harness();
  const original = tab(10, { url: 'https://example.test/shared#one', snippet: '同一篇正文的核心信息' });
  const duplicate = { ...original, id: 777, title: '另一个网站标题', url: 'https://example.test/shared#two', bookmarkPath: '另一条书签路径' };
  const first = await h.organize([original, duplicate, tab(11)]);
  assert.equal(tabsFromPrompt(h.prompts[0].text).length, 2, 'bookmark variants of the same body still infer once');
  assert.deepEqual(ids(first), [10, 11, 777]);
  assert.deepEqual(first.tabTitles.map(t => t.id), [10, 777, 11]);
  assert.equal(first.cache.misses, 3);
  const renamed = await h.organize([{ ...original, id: 900, title: first.tabTitles[0].title }, duplicate],
    { context: { activeTab: tab(999), activePageNote: 'different browsing task' } });
  assert.deepEqual(renamed.cache, { hits: 2, misses: 0, hitTabIds: [900, 777], missTabIds: [] });
  assert.deepEqual(renamed.tabTitles.map(t => t.id), [900, 777]);
  assert.equal(h.prompts.length, 1, 'all hits never invoke ACP');
  assert.equal(h.api.analysisInFlight.size, 0);
});

test('body, URL, bookmark path, language and actual ACP model changes invalidate the cache', async () => {
  const h = harness();
  const original = tab(1);
  await h.organize([original]);
  for (const [changed, opts] of [[{ ...original, snippet: '实际正文变更' }, {}],
    [{ ...original, url: 'https://example.test/changed' }, {}],
    [{ ...original, bookmarkPath: '研究/另一主题' }, {}], [original, { language: 'en' }]]) {
    const result = await h.organize([changed], opts);
    assert.equal(result.cache.misses, 1);
  }
  const switched = await h.api.setModel('mock-B');
  assert.equal(switched.status, 200);
  assert.equal((await h.organize([original])).cache.misses, 1);
  assert.equal(h.prompts.length, 6);
});

test('cache metadata and title rows consistently expose numeric input tab IDs', async () => {
  const h = harness(), original = tab('49');
  const miss = await h.organize([original]);
  assert.deepEqual(miss.cache.missTabIds, [49]);
  assert.equal(miss.tabTitles[0].id, 49);
  const hit = await h.organize([original, tab('50')]);
  assert.deepEqual(hit.cache.hitTabIds, [49]);
  assert.deepEqual(hit.cache.missTabIds, [50]);
  assert.deepEqual(hit.tabTitles.map(row => row.id), [49, 50]);
});

test('persistent restart hits and disk stores only hashes, short output, group and timestamps', async () => {
  const h = harness(), original = tab(51, { snippet: '绝不存储的隐私正文', bookmarkPath: '私密/书签路径' });
  await h.organize([original]);
  const disk = await readFile(h.file, 'utf8'), data = JSON.parse(disk);
  for (const secret of [original.snippet, original.title, original.url, original.bookmarkPath, 'mock-A']) assert.ok(!disk.includes(secret));
  assert.deepEqual(Object.keys(data.entries[0]).sort(), ['accessedAt', 'backend', 'createdAt', 'group', 'hash', 'title']);
  assert.match(data.entries[0].hash, /^[a-f0-9]{64}$/);
  const restarted = harness({ file: h.file, respond: () => { throw Error('must not infer on restart hit'); } });
  const result = await restarted.organize([{ ...original, id: 52 }]);
  assert.equal(result.cache.hits, 1);
  assert.equal(restarted.prompts.length, 0);
  assert.equal(restarted.clients.length, 0, 'a cache hit must not even initialize an ACP client');
  assert.deepEqual(result.tabTitles.map(t => t.id), [52]);
});

test('mixed hits/misses send only misses plus group hints and retain all same-URL IDs', async () => {
  let round = 0;
  const h = harness({ respond: text => answer(text, { name: ++round === 1 ? '缓存主题' : '新主题' }) });
  const cached = tab(61, { url: 'https://example.test/shared', snippet: '旧正文' });
  await h.organize([cached]);
  const misses = [tab(62, { url: cached.url, snippet: '新正文' }), tab(63)];
  const result = await h.organize([cached, ...misses], { mode: 'full', existingGroups: ['用户已有组'] });
  assert.deepEqual(tabsFromPrompt(h.prompts[1].text).map(t => t.id), [62, 63]);
  assert.match(h.prompts[1].text, /缓存主题/);
  assert.match(h.prompts[1].text, /用户已有组/);
  assert.deepEqual(ids(result), [61, 62, 63]);
  assert.ok(result.groups.find(g => g.tabIds.includes(61)).tabIds.includes(62));
  assert.deepEqual(result.cache, { hits: 1, misses: 2, hitTabIds: [61], missTabIds: [62, 63] });
});

test('restricted pages cache classification only; no fabricated title and no-body title changes miss', async () => {
  const h = harness({ respond: text => {
    const tabs = tabsFromPrompt(text);
    return JSON.stringify({ groups: [{ name: '浏览器设置', color: 'grey', tabIds: tabs.map(t => t.id) }],
      tabTitles: tabs.map(t => ({ id: t.id, title: '凭空猜测的摘要' })) });
  } });
  const restricted = tab(71, { url: 'chrome://settings/', snippet: '', title: 'Settings' });
  assert.deepEqual((await h.organize([restricted])).tabTitles, []);
  assert.equal((await h.organize([restricted])).cache.hits, 1);
  assert.equal((await h.organize([{ ...restricted, title: 'New settings title' }])).cache.misses, 1);
  const data = JSON.parse(await readFile(h.file, 'utf8'));
  assert.ok(data.entries.every(row => !('title' in row)));
  assert.equal(h.prompts.length, 2);
});

test('missing/invalid model titles remain retriable and legacy parseGroups keeps its return shape', async () => {
  let omit = true;
  const h = harness({ respond: text => omit ? JSON.stringify({ groups: [{ name: '技术研究', tabIds: tabsFromPrompt(text).map(t => t.id) }] }) : answer(text) });
  const original = tab(81);
  assert.deepEqual((await h.organize([original])).tabTitles, []);
  assert.deepEqual((await h.organize([original])).tabTitles, []);
  assert.equal(h.prompts.length, 2);
  assert.equal(h.api.analysisCache.entries.size, 0);
  omit = false;
  await h.organize([original]);
  assert.equal((await h.organize([original])).cache.hits, 1);
  const old = h.api.parseGroups('prefix```json\n{"groups":[{"name":"旧格式","tabIds":[81]}]}\n```suffix');
  assert.deepEqual(plain(old), [{ name: '旧格式', tabIds: [81] }]);
});

test('title validation rejects long, site-only, unknown-ID and no-snippet titles', async () => {
  const h = harness(), original = tab(91, { url: 'https://www.github.com/project' });
  for (const invalid of ['字'.repeat(21), 'GitHub', 'github.com', 'https://github.com/', '两行\n标题', '<script>', '', 123, null]) {
    assert.equal(h.api.validateTitle(invalid, original, 'zh'), null, String(invalid));
  }
  assert.equal(h.api.validateTitle('字'.repeat(20), original, 'zh'), '字'.repeat(20));
  assert.equal(h.api.validateTitle('字'.repeat(21), original, 'en'), null);
  assert.equal(h.api.validateTitle('!!!', original, 'zh'), null);
  assert.equal(h.api.validateTitle('one two three four five six seven eight nine', original, 'en'), null);
  assert.equal(h.api.validateTitle('one two three four five six seven eight', original, 'en'), 'one two three four five six seven eight');
  const parsed = h.api.parseAnalysis(JSON.stringify({ groups: [{ name: '技术研究', tabIds: [91, 92] }],
    tabTitles: [{ id: 9999, title: '伪造标题' }, { id: 92, title: '伪造标题' }, { id: 91, title: '安全内容短标题' }] }),
  [original, tab(92, { snippet: '' })], 'zh');
  assert.deepEqual(plain([...parsed.titles]), [[91, '安全内容短标题']]);
});

test('fallbacks never cache, mixed heuristic responses retain only previous AI titles', async () => {
  let fail = false;
  const h = harness({ respond: text => { if (fail) throw Error('mock offline failure'); return answer(text); } });
  const cached = tab(101), fresh = tab(102);
  await h.organize([cached]); fail = true;
  const result = await h.organize([cached, fresh]);
  assert.equal(result.source, 'heuristic');
  assert.deepEqual(result.tabTitles, [{ id: 101, title: '正文主题与实现', source: 'ai' }]);
  assert.deepEqual(ids(result), [101, 102]);
  assert.match(result.note, /mock offline failure/);
  assert.equal((await h.organize([fresh])).cache.misses, 1);
  assert.equal(h.api.analysisCache.entries.size, 1);
  assert.equal(h.prompts.length, 3);
  const malformed = harness({ respond: () => 'not JSON' });
  assert.equal((await malformed.organize([fresh])).source, 'heuristic');
  assert.equal((await malformed.organize([fresh])).cache.misses, 1);
  assert.equal(malformed.api.analysisCache.entries.size, 0);
});

test('partial model output retains each successful AI title, never titles fallback classifications', async () => {
  const h = harness({ respond: text => {
    const [first, second] = tabsFromPrompt(text);
    return JSON.stringify({ groups: [{ name: '技术研究', tabIds: [first.id] }],
      tabTitles: [{ id: first.id, title: '有正文的有效短标题' }, ...(second ? [{ id: second.id, title: '不该缓存的标题' }] : [])] });
  } });
  const result = await h.organize([tab(111), tab(112)]);
  assert.equal(result.source, 'heuristic');
  assert.deepEqual(result.tabTitles, [{ id: 111, title: '有正文的有效短标题', source: 'ai' }]);
  assert.deepEqual(ids(result), [111, 112]);
  assert.deepEqual(result.cache, { hits: 0, misses: 2, hitTabIds: [], missTabIds: [111, 112] });
  assert.equal(h.api.analysisCache.entries.size, 1);
  const mixed = await h.organize([tab(111), tab(112)]);
  assert.deepEqual(mixed.cache, { hits: 1, misses: 1, hitTabIds: [111], missTabIds: [112] });
  assert.deepEqual(mixed.tabTitles.map(row => row.id), [111, 112]);
});

test('same-key concurrent requests reuse inference before and during cache writes', async () => {
  const started = deferred(), releaseModel = deferred(), writeStarted = deferred(), releaseWrite = deferred();
  class DelayedCache extends AnalysisCache {
    async setMany(rows) { if (rows.length) { writeStarted.resolve(); await releaseWrite.promise; } return super.setMany(rows); }
  }
  const h = harness({ Cache: DelayedCache, respond: async text => { started.resolve(); await releaseModel.promise; return answer(text); } });
  const original = tab(121);
  const first = h.organize([original]);
  await started.promise;
  const second = h.organize([{ ...original, id: 122, title: '另一个标题' }]);
  releaseModel.resolve();
  await writeStarted.promise;
  const third = h.organize([{ ...original, id: 123 }]);
  // Make the third request pass its asynchronous cache.ready/detectBackend boundaries.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.prompts.length, 1);
  releaseWrite.resolve();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map(r => r.tabTitles[0].id), [121, 122, 123]);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.api.analysisInFlight.size, 0);
});

test('overlapping requests infer only their newly owned keys and map shared results correctly', async () => {
  const started = deferred(), release = deferred();
  let round = 0;
  const h = harness({ respond: async text => { if (++round === 1) { started.resolve(); await release.promise; } return answer(text); } });
  const first = h.organize([tab(124), tab(125)]);
  await started.promise;
  const second = h.organize([tab(125), tab(126)]);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(h.prompts.map(p => tabsFromPrompt(p.text).map(t => t.id)), [[124, 125], [126]]);
  assert.deepEqual(results.map(ids), [[124, 125], [125, 126]]);
  assert.equal(h.api.analysisInFlight.size, 0);
});

test('HTTP receives body and uses actual runtime model and endpoint in cache identity', async () => {
  const h = harness({ kind: 'http' }), original = tab(131);
  await h.organize([original]);
  assert.equal(h.prompts[0].body.model, 'mock-A');
  assert.equal(tabsFromPrompt(h.prompts[0].text)[0].snippet, original.snippet);
  assert.equal((await h.organize([original])).cache.hits, 1);
  await h.api.setModel('http-model-B');
  const changed = await h.organize([original]);
  assert.equal(changed.cache.misses, 1);
  assert.equal(changed.backend, 'openai:http-model-B');
  assert.equal(h.prompts[1].body.model, 'http-model-B');
  const restarted = harness({ kind: 'http', model: 'http-model-B', file: h.file });
  assert.equal((await restarted.organize([original])).cache.hits, 1);
  const differentEndpoint = harness({ kind: 'http', model: 'http-model-B', baseUrl: 'http://another-mock.invalid', file: h.file });
  assert.equal((await differentEndpoint.organize([original])).cache.misses, 1);
});

test('medium/large miss batch is a single ACP round and preserves every ID', async () => {
  const h = harness();
  const input = Array.from({ length: 180 }, (_, index) => tab(index + 1000, { snippet: '正'.repeat(1190) + `主题${index}` }));
  const result = await h.organize(input);
  assert.equal(h.prompts.length, 1);
  assert.equal(tabsFromPrompt(h.prompts[0].text).length, 180);
  assert.equal(result.tabTitles.length, 180);
  assert.equal(ids(result).length, 180);
  assert.equal((await h.organize(input)).cache.hits, 180);
  assert.equal(h.prompts.length, 1);
});

const hash = text => createHash('sha256').update(text).digest('hex');
const cacheRow = id => ({ hash: hash(`row-${id}`), backend: hash('backend'), title: `主题${id}`, group: { name: '技术研究', color: 'blue' } });

test('cache defaults are 30-day TTL/max1000, expiry is not extended by hits', async () => {
  assert.equal(CACHE_TTL_MS, 30 * 24 * 60 * 60 * 1000); assert.equal(CACHE_MAX_ENTRIES, 1000);
  let now = 100000;
  const file = path.join(root, 'ttl.json'), cache = new AnalysisCache({ file, now: () => now });
  await cache.ready(); await cache.setMany([cacheRow(1)]);
  now += CACHE_TTL_MS - 1;
  assert.ok(cache.get(cacheRow(1).hash)); await cache.flush();
  const restarted = new AnalysisCache({ file, now: () => ++now });
  await restarted.ready();
  assert.equal(restarted.get(cacheRow(1).hash), null);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).entries, []);
});

test('LRU max1000 evicts oldest, access protects entries including equal-clock ties', async () => {
  let now = 100000;
  const file = path.join(root, 'lru.json'), cache = new AnalysisCache({ file, now: () => now });
  await cache.ready(); await cache.setMany(Array.from({ length: 1000 }, (_, id) => cacheRow(id)));
  cache.get(cacheRow(0).hash);
  await cache.setMany([cacheRow(1000)]);
  assert.equal(cache.entries.size, 1000);
  assert.ok(cache.get(cacheRow(0).hash));
  assert.equal(cache.get(cacheRow(1).hash), null);
  await cache.flush();
  const restarted = new AnalysisCache({ file, now: () => now });
  await restarted.ready();
  assert.equal(restarted.entries.size, 1000);
  now++;
  await restarted.setMany([cacheRow(1001)]);
  assert.equal(restarted.get(cacheRow(2).hash), null);
});

test('corrupt files rebuild safely and concurrent atomic writes retain all entries', async () => {
  const file = path.join(root, 'corrupt.json');
  await writeFile(file, '{broken JSON');
  const cache = new AnalysisCache({ file });
  await cache.ready();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, entries: [] });
  await Promise.all(Array.from({ length: 30 }, (_, id) => cache.setMany([cacheRow(id)])));
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.entries.length, 30);
  assert.equal(new Set(disk.entries.map(row => row.hash)).size, 30);
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ hash: 'invalid', snippet: 'must be discarded' }] }));
  const invalid = new AnalysisCache({ file }); await invalid.ready();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, entries: [] });
  const at = Date.now();
  await writeFile(file, JSON.stringify({ version: 1, entries: [{ ...cacheRow(77), createdAt: at, accessedAt: at, snippet: 'unexpected body must be stripped' }] }));
  const extraFields = new AnalysisCache({ file }); await extraFields.ready();
  assert.equal(extraFields.entries.size, 1);
  assert.ok(!(await readFile(file, 'utf8')).includes('unexpected body'));
  await writeFile(file, JSON.stringify({ version: 999, entries: [] }));
  const wrongSchema = new AnalysisCache({ file }); await wrongSchema.ready();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, entries: [] });
});

test('no backend stays heuristic, reports every uncached page and does not create cache entries', async () => {
  const h = harness({ kind: 'none' });
  const result = await h.organize([tab(141), tab(142, { snippet: '' })]);
  assert.equal(result.source, 'heuristic'); assert.equal(result.backend, null);
  assert.deepEqual(result.tabTitles, []);
  assert.deepEqual(result.cache, { hits: 0, misses: 2, hitTabIds: [], missTabIds: [141, 142] });
  assert.equal(h.api.analysisCache.entries.size, 0);
  assert.equal(existsSync(h.file), false);
});

test('optional AI summary in tabTitles is sanitized, returned, and reused across cache hits', async () => {
  const h = harness({
    respond: text => {
      const tabs = tabsFromPrompt(text);
      return JSON.stringify({
        groups: [{ name: '工作流', color: 'blue', tabIds: tabs.map(t => t.id) }],
        tabTitles: tabs.map(t => ({
          id: t.id,
          title: '短标题示例',
          summary: '优惠券灰度配置与促销接口排查指南',
        })),
      });
    },
  });
  const baseTab = tab(201);
  const first = await h.organize([baseTab]);
  assert.equal(first.tabTitles[0].summary, '优惠券灰度配置与促销接口排查指南');
  const second = await h.organize([{ ...baseTab, id: 202 }]);
  assert.equal(second.cache.hits, 1);
  assert.equal(second.tabTitles[0].summary, '优惠券灰度配置与促销接口排查指南');
});

let passed = 0;
try {
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok ${++passed} - ${name}`); }
    catch (error) { console.error(`not ok - ${name}`); throw error; }
  }
  console.log(`PASS ${passed}/${tests.length} analysis server regressions (mock ACP/HTTP, native Node; no service/browser/paid model)`);
} finally {
  // Guard the exact deletion target; never delete an unchecked computed directory.
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('tab-analysis-test-'));
  await rm(root, { recursive: true, force: true });
}
