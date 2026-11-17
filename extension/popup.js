const $ = id => document.getElementById(id);
let settings = { serviceUrl: DEFAULT_SERVICE, autoOrganize: false };
let cachedWindowId = null;
const rpc = msg => chrome.runtime.sendMessage(msg);

function showBanner(msg, warn = false) {
  const el = $('error');
  el.textContent = msg;
  el.className = 'banner' + (warn ? ' warn' : '');
}
function hideBanner() { $('error').className = 'banner hidden'; }

function renderPreview(p) {
  $('done').classList.add('hidden');
  $('preview').classList.remove('hidden');
  $('preview-meta').textContent =
    `${p.groups.length} 组、${p.tabCount} 标签、${p.source === 'ai' ? 'AI' : '规则'}${p.backend ? '、' + p.backend : ''}`;
  const ul = $('groups');
  ul.innerHTML = '';
  p.groups.forEach((g, i) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', i);
    const hex = COLOR_HEX[g.color] || COLOR_HEX.grey;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = hex;
    dot.style.boxShadow = `0 0 8px ${hex}66`;
    const name = document.createElement('span');
    name.className = 'gname';
    name.textContent = g.name;
    const count = document.createElement('span');
    count.className = 'gcount';
    count.textContent = g.tabIds.length;
    li.append(dot, name, count);
    ul.appendChild(li);
  });
  if (p.note) showBanner(p.note, true);
}

function renderDone(p) {
  $('preview').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('done-text').textContent = `已把 ${p.tabCount} 个标签整理为 ${p.groups.length} 组`;
}

async function doOrganize() {
  const btn = $('organize');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.querySelector('.hero-text').innerHTML = 'AI 思考中…<small>本地 agent 推理，约 10~40 秒</small>';
  hideBanner();
  const res = await rpc({ type: 'organize' });
  btn.disabled = false;
  btn.classList.remove('loading');
  btn.querySelector('.hero-text').innerHTML = '整理当前窗口<small>AI 语义分组，预览后应用</small>';
  if (!res?.ok) return showBanner(res?.message || '整理失败');
  if (res.empty) return showBanner(res.message, true);
  renderPreview(res);
}

$('organize').onclick = doOrganize;
$('regen').onclick = doOrganize;
$('again').onclick = () => { $('done').classList.add('hidden'); doOrganize(); };

$('apply').onclick = async () => {
  const btn = $('apply');
  btn.disabled = true;
  btn.textContent = '应用中…';
  const res = await rpc({ type: 'apply' });
  btn.disabled = false;
  btn.textContent = '应用分组';
  if (!res?.ok) return showBanner(res?.message || '应用失败');
  const { proposal } = await chrome.storage.session.get('proposal');
  if (proposal) renderDone(proposal);
  toast('分组已应用到标签栏', 'ok');
};

$('undo').onclick = async () => {
  const res = await rpc({ type: 'undo' });
  if (!res?.ok) return showBanner(res?.message || '撤销失败');
  $('done').classList.add('hidden');
  showBanner('已撤销，标签恢复原状', true);
};

/* 首页工作台：显式入口（新标签页已被接管，此按钮保底可达） */
$('openHome').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('home.html') });
  window.close();
};

/* 侧边栏：必须在点击手势内同步调用 sidePanel.open（消息中转会丢失手势） */
$('sidepanel').onclick = () => {
  chrome.sidePanel.open({ windowId: cachedWindowId })
    .then(() => window.close())
    .catch(async () => {
      // 降级：以标签页形式打开侧边栏视图
      await chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') });
      window.close();
    });
};

/* ---------------- 去重 ---------------- */

async function updateDupUI() {
  const [cnt, st] = await Promise.all([rpc({ type: 'dup-count' }), rpc({ type: 'dedup-state' })]);
  const badge = $('dupCount');
  badge.textContent = cnt?.count ?? 0;
  badge.classList.toggle('zero', !cnt?.count);
  $('dedup').disabled = !cnt?.count;
  $('dedupUndo').classList.toggle('hidden', !st?.undoCount);
}

$('dedup').onclick = async () => {
  const res = await rpc({ type: 'dedup' });
  if (!res?.ok) return showBanner(res?.message || '去重失败');
  toast(res.closed ? `已关闭 ${res.closed} 个重复标签，可点"恢复"找回` : '没有重复标签', res.closed ? 'ok' : 'info');
  updateDupUI();
};

$('dedupUndo').onclick = async () => {
  const res = await rpc({ type: 'dedup-undo' });
  if (!res?.ok) return showBanner(res?.message || '恢复失败');
  toast(`已恢复 ${res.restored} 个标签`, 'ok');
  updateDupUI();
};

chrome.tabs.onCreated.addListener(updateDupUI);
chrome.tabs.onRemoved.addListener(updateDupUI);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.status === 'complete') updateDupUI();
});

/* ---------------- 设置 ---------------- */

$('serviceUrl').onchange = async () => {
  const next = typeof normalizeLoopbackServiceUrl === 'function'
    ? normalizeLoopbackServiceUrl($('serviceUrl').value)
    : ($('serviceUrl').value.trim() || DEFAULT_SERVICE);
  if ($('serviceUrl').value.trim() && next !== $('serviceUrl').value.trim().replace(/\/+$/, '')) {
    $('serviceUrl').value = next;
    toast('仅支持本机回环地址（127.0.0.1 / localhost）', 'err');
  }
  settings.serviceUrl = next;
  await chrome.storage.sync.set({ settings });
  refreshHealthPill($('health'));
  toast('服务地址已保存');
};

$('autoOrganize').onchange = async () => {
  settings.autoOrganize = $('autoOrganize').checked;
  await chrome.storage.sync.set({ settings });
  toast(settings.autoOrganize ? '自动整理已开启' : '自动整理已关闭');
};

(async function init() {
  cachedWindowId = (await chrome.windows.getCurrent()).id;
  const state = await rpc({ type: 'state' });
  settings = state?.settings || settings;
  $('serviceUrl').value = settings.serviceUrl;
  $('autoOrganize').checked = !!settings.autoOrganize;
  refreshHealthPill($('health'));
  updateDupUI();
  initModelSelect($('model'), { refreshBtn: $('refreshModels'), metaEl: $('model-meta'), pillEl: $('health') });
  if (state?.proposal) {
    if (state.proposal.applied) renderDone(state.proposal);
    else renderPreview(state.proposal);
  }
})();