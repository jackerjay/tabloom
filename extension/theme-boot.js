/* 首帧防闪烁：默认使用 Dusk 深色主题（data-theme="dark"），与改版设计稿一致。
 * 真值在 chrome.storage.sync（themeMode），ui.js 加载后会校正并回写镜像。 */
(() => {
  try {
    const m = localStorage.getItem('themeMode') || 'dark';
    const dark = m === 'dark' || (m === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const lang = localStorage.getItem('uiLang') === 'en' ? 'en' : 'zh';
    document.documentElement.dataset.lang = lang;
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  } catch {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.dataset.lang = 'zh';
  }
})();
