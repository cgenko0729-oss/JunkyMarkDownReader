/**
 * Mermaid 图表渲染
 *
 * Mermaid 的 bundle 有 3.4MB，每次启动都加载会明显拖慢冷启动。
 * 所以走按需注入：只有当前文档里真的出现 ```mermaid 代码块时，
 * 才动态插入那个 <script>，之后常驻复用。
 */

(function (global) {
  'use strict';

  const SCRIPT_URL = '../../node_modules/mermaid/dist/mermaid.min.js';

  let loadPromise = null;   // 加载中/已完成的 Promise，保证只注入一次
  let initialized = false;
  let seq = 0;              // 每张图需要一个唯一 id

  /** base64 → UTF-8 字符串（图表源码里有中文，不能直接用 atob） */
  function decodeSource(b64) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return '';
    }
  }

  function loadMermaid() {
    if (loadPromise) return loadPromise;

    loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.onload = () => {
        if (global.mermaid) resolve(global.mermaid);
        else reject(new Error('mermaid.min.js 已加载但未导出 mermaid 对象'));
      };
      script.onerror = () => reject(new Error('无法加载 mermaid.min.js'));
      document.head.appendChild(script);
    });

    return loadPromise;
  }

  function configure(mermaid, mode) {
    mermaid.initialize({
      startOnLoad: false,
      // strict 会让 mermaid 自己清洗图表里的 HTML 标签
      securityLevel: 'strict',
      theme: mode === 'dark' ? 'dark' : 'default',
      fontFamily: 'inherit'
    });
    initialized = true;
  }

  /** 渲染失败时，退回展示原始代码，至少信息不丢 */
  function showError(panel, source, message) {
    panel.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'mermaid-error';

    const title = document.createElement('div');
    title.className = 'mermaid-error-title';
    title.textContent = 'Mermaid 图表渲染失败：' + message;

    const pre = document.createElement('pre');
    pre.className = 'md-fences';
    const code = document.createElement('code');
    code.textContent = source;
    pre.appendChild(code);

    box.appendChild(title);
    box.appendChild(pre);
    panel.appendChild(box);
  }

  /**
   * 渲染容器内所有的 mermaid 占位块。
   * @param {HTMLElement} container 通常是 #write
   * @param {string} mode 'light' | 'dark'
   */
  async function renderAll(container, mode) {
    const panels = Array.from(container.querySelectorAll('.md-mermaid[data-mermaid-src]'));
    if (!panels.length) return;

    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch (err) {
      panels.forEach((p) => showError(p, decodeSource(p.dataset.mermaidSrc), err.message));
      return;
    }

    // 主题变了要重新 initialize，否则新图还是旧配色
    configure(mermaid, mode);

    for (const panel of panels) {
      const source = decodeSource(panel.dataset.mermaidSrc);
      if (!source.trim()) {
        showError(panel, '', '图表源码为空');
        continue;
      }

      const id = `mermaid-svg-${++seq}`;
      try {
        const { svg, bindFunctions } = await mermaid.render(id, source);
        panel.innerHTML = svg;
        // 交互类图表（点击节点等）需要这一步把事件挂回去
        if (typeof bindFunctions === 'function') bindFunctions(panel);
      } catch (err) {
        // mermaid 渲染失败会往 body 里塞一个残留的错误节点，清掉它
        const orphan = document.getElementById(id);
        if (orphan && orphan.parentElement === document.body) orphan.remove();
        showError(panel, source, (err && err.message) || String(err));
      }
    }
  }

  /** 主题切换后重画（源码一直存在 data 属性里，可以反复渲染） */
  async function rerender(container, mode) {
    if (!initialized) return renderAll(container, mode);
    const panels = container.querySelectorAll('.md-mermaid[data-mermaid-src]');
    if (!panels.length) return;
    // 清回占位状态，再走一遍完整渲染
    panels.forEach((p) => { p.innerHTML = '<div class="md-mermaid-placeholder">重新渲染中…</div>'; });
    return renderAll(container, mode);
  }

  global.MermaidRender = { renderAll, rerender };
})(window);
