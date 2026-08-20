/**
 * 主题管理
 *
 * 关键认知：Typora 的主题是**一整个独立的 CSS 文件**（github.css / night.css），
 * 不是靠 CSS 变量在单个文件里切明暗。所以「切换亮暗」的实现是
 * 替换 <link> 的 href，而不是常规 Web 开发里改 data-theme 属性。
 *
 * 于是形成两层样式体系：
 *   - #write 内部       → 完全交给 Typora 主题 CSS
 *   - 外壳（工具栏/侧栏）→ shell.css 自带的亮暗变量，靠 <html data-mode> 切换
 * 两层需要联动，但走的是两套机制。
 */

(function (global) {
  'use strict';

  const HLJS_LIGHT = '../../node_modules/highlight.js/styles/github.css';
  const HLJS_DARK = '../../node_modules/highlight.js/styles/github-dark.css';

  const linkTypora = () => document.getElementById('typora-theme');
  const linkHljs = () => document.getElementById('hljs-theme');
  const select = () => document.getElementById('theme-select');
  const modeIcon = () => document.getElementById('mode-icon');

  const state = {
    mode: 'light',
    themeLight: 'github.css',
    themeDark: 'night.css',
    themes: [],       // [{ file, name, url }]
    onChange: null    // 主题变化后的回调（Mermaid 需要据此重画）
  };

  /** 当前模式下应该用哪个主题文件 */
  function currentThemeFile() {
    return state.mode === 'dark' ? state.themeDark : state.themeLight;
  }

  function urlForTheme(file) {
    const hit = state.themes.find((t) => t.file === file);
    if (hit) return hit.url;
    // 主题被删掉了就退回列表里第一个，总比整个正文没样式好
    return state.themes.length ? state.themes[0].url : '';
  }

  /** 把当前状态刷到 DOM 上 */
  function apply() {
    document.documentElement.setAttribute('data-mode', state.mode);

    const typoraUrl = urlForTheme(currentThemeFile());
    if (typoraUrl && linkTypora().getAttribute('href') !== typoraUrl) {
      linkTypora().setAttribute('href', typoraUrl);
    }

    // 先按亮暗模式给个默认值；等主题 CSS 加载完，App 会根据代码块的
    // 实际背景色再校正一次（有些亮色主题配的是暗色代码块）
    setCodeDark(state.mode === 'dark');

    if (modeIcon()) modeIcon().textContent = state.mode === 'dark' ? '☀' : '☾';

    const sel = select();
    if (sel && sel.value !== currentThemeFile()) sel.value = currentThemeFile();

    if (typeof state.onChange === 'function') state.onChange(state.mode);
  }

  function buildSelect() {
    const sel = select();
    if (!sel) return;
    sel.innerHTML = '';
    if (!state.themes.length) {
      const opt = document.createElement('option');
      opt.textContent = '（themes/ 目录为空）';
      opt.value = '';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    for (const t of state.themes) {
      const opt = document.createElement('option');
      opt.value = t.file;
      opt.textContent = t.name;
      sel.appendChild(opt);
    }
  }

  /**
   * @param {object} settings 持久化设置
   * @param {Array}  themes   themes/ 目录扫描结果
   * @param {Function} onChange 主题/模式变化后的回调
   */
  function init(settings, themes, onChange) {
    state.themes = themes || [];
    state.mode = settings.mode === 'dark' ? 'dark' : 'light';
    state.themeLight = settings.themeLight || 'github.css';
    state.themeDark = settings.themeDark || 'night.css';
    state.onChange = onChange;

    buildSelect();
    apply();
  }

  function setMode(mode) {
    state.mode = mode === 'dark' ? 'dark' : 'light';
    apply();
    return { mode: state.mode };
  }

  function toggleMode() {
    return setMode(state.mode === 'dark' ? 'light' : 'dark');
  }

  /** 为**当前模式**指定主题文件（亮色和暗色各记一套） */
  function setTheme(file) {
    if (!file) return {};
    if (state.mode === 'dark') state.themeDark = file;
    else state.themeLight = file;
    apply();
    return state.mode === 'dark' ? { themeDark: file } : { themeLight: file };
  }

  /**
   * 单独设置代码高亮配色的明暗。
   *
   * 之所以跟主题的亮暗模式解耦：Typora 主题里代码块的底色不一定跟正文
   * 一致（drake-jb 就是亮色正文配暗色代码块）。配色选错的话，深色字打在
   * 深色底上，整段代码几乎看不见。App 会实测代码块背景亮度后调这个函数。
   */
  function setCodeDark(isDark) {
    const url = isDark ? HLJS_DARK : HLJS_LIGHT;
    const link = linkHljs();
    if (link && link.getAttribute('href') !== url) link.setAttribute('href', url);
    // shell.css 靠这个属性给代码块定「没有语法着色的那些字符」的颜色。
    // 光靠调整样式表顺序不够：主题常用 `#write .md-fences` 这种高特异性
    // 选择器设文字色，hljs 的 `.hljs` 压不过它。
    document.documentElement.setAttribute('data-code', isDark ? 'dark' : 'light');
  }

  const getMode = () => state.mode;

  global.Theme = { init, setMode, toggleMode, setTheme, getMode, setCodeDark };
})(window);
