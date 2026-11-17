/* 共享：本地服务访问 */
const DEFAULT_SERVICE = 'http://127.0.0.1:8787';

async function getServiceUrl() {
  const { settings } = await chrome.storage.sync.get('settings');
  return (settings?.serviceUrl || DEFAULT_SERVICE).replace(/\/+$/, '');
}

async function apiFetch(path, { method = 'GET', body, timeout = 8000 } = {}) {
  const base = await getServiceUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求超时');
    throw new Error(`无法连接本地服务 ${base}`);
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `服务返回 ${res.status}`);
  return data;
}