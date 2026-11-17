#!/usr/bin/env node
/**
 * 联调脚本：把真实（CDP）或模拟标签页发给本地服务，打印分组结果。
 *
 * 用法:
 *   node test-organize.mjs                          # 优先读本机 Chrome CDP(9222)，失败则用模拟数据
 *   node test-organize.mjs --mock                   # 强制模拟数据
 *   node test-organize.mjs --service http://127.0.0.1:8787 --cdp http://127.0.0.1:9222
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SERVICE = arg('--service', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CDP = arg('--cdp', 'http://127.0.0.1:9222').replace(/\/+$/, '');
const MOCK = process.argv.includes('--mock');

const MOCK_TABS = [
  { title: 'Pull requests · chrome-extensions', url: 'https://github.com/pulls' },
  { title: 'chrome.tabGroups | Chrome for Developers', url: 'https://developer.chrome.com/docs/extensions/reference/api/tabGroups' },
  { title: 'Manifest V3 migration guide', url: 'https://developer.chrome.com/docs/extensions/develop/migrate' },
  { title: 'Stack Overflow - MV3 service worker fetch CORS', url: 'https://stackoverflow.com/questions/12345' },
  { title: 'Ollama - Run local LLMs', url: 'https://ollama.com/library/qwen2.5' },
  { title: 'DeepSeek Chat', url: 'https://chat.deepseek.com/' },
  { title: 'Claude', url: 'https://claude.ai/new' },
  { title: '【4K】冰岛航拍 - YouTube', url: 'https://www.youtube.com/watch?v=abc' },
  { title: '哔哩哔哩 - 科技区', url: 'https://www.bilibili.com/v/tech' },
  { title: '知乎 - 如何评价 Arc 浏览器', url: 'https://www.zhihu.com/question/123' },
  { title: 'V2EX - Chrome 插件节点', url: 'https://www.v2ex.com/go/create' },
  { title: '淘宝 - 机械键盘', url: 'https://www.taobao.com/list/item/keyboard' },
  { title: '京东 - 显示器比价', url: 'https://www.jd.com/monitor' },
  { title: 'Gmail - 收件箱', url: 'https://mail.google.com/mail/u/0/#inbox' },
  { title: 'Notion - Q4 Engineering Roadmap', url: 'https://www.notion.so/engineering-roadmap' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com/' },
  { title: 'Wikipedia - Arc (web browser)', url: 'https://en.wikipedia.org/wiki/Arc_(web_browser)' },
];

async function loadTabs() {
  if (!MOCK) {
    try {
      const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000) });
      const targets = await res.json();
      const pages = targets.filter(t => t.type === 'page' && t.url && !t.url.startsWith('devtools://'));
      if (pages.length) {
        console.log(`数据来源: Chrome CDP ${CDP}（${pages.length} 个真实标签页）\n`);
        return pages.map((p, i) => ({ id: i + 1, title: p.title || p.url, url: p.url }));
      }
    } catch { /* CDP 不可用 */ }
    console.log('CDP 不可用，使用模拟数据。\n');
  } else {
    console.log('数据来源: 模拟标签页\n');
  }
  return MOCK_TABS.map((t, i) => ({ id: i + 1, ...t }));
}

const COLOR_DOT = {
  grey: '⚪', blue: '🔵', red: '🔴', yellow: '🟡', green: '🟢',
  pink: '🌸', purple: '🟣', cyan: '🩵', orange: '🟠',
};

const tabs = await loadTabs();
const health = await fetch(`${SERVICE}/health`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
if (!health) {
  console.error(`✗ 服务未启动：先运行  node server.mjs  （${SERVICE}）`);
  process.exit(1);
}
console.log(`服务状态: ai=${health.ai}${health.backend ? ` backend=${health.backend.type}:${health.backend.model}` : '（规则兜底模式）'}\n`);

const res = await fetch(`${SERVICE}/organize`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tabs, language: 'zh' }),
  signal: AbortSignal.timeout(120000),
});
const out = await res.json();
if (!res.ok) { console.error('✗ 请求失败:', out); process.exit(1); }

const byId = new Map(tabs.map(t => [t.id, t]));
console.log(`分组结果 [${out.source}${out.backend ? ` · ${out.backend}` : ''}] 耗时 ${out.elapsedMs}ms`);
if (out.note) console.log(`备注: ${out.note}`);
console.log('─'.repeat(60));
for (const g of out.groups) {
  console.log(`${COLOR_DOT[g.color] || '⚪'} ${g.name}（${g.tabIds.length}）`);
  for (const id of g.tabIds) {
    const t = byId.get(id);
    console.log(`    ${String(t?.title || id).slice(0, 58)}`);
  }
}
const covered = new Set(out.groups.flatMap(g => g.tabIds));
const missing = tabs.filter(t => !covered.has(t.id));
console.log('─'.repeat(60));
console.log(`校验: ${covered.size}/${tabs.length} 个标签页已覆盖${missing.length ? `，遗漏: ${missing.map(t => t.id).join(',')}` : ' ✓'}`);