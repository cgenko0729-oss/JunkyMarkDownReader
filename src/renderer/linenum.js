/**
 * 源文件行号槽
 *
 * 正文是渲染后的 HTML，跟 .md 原文没有逐行对应关系，所以行号标的是
 * 「每个块在原文里的起始行」—— 主进程渲染时已经把它写成 data-line 属性了
 * （见 main/markdown.js 的 source_lines 规则）。
 *
 * 为什么用 JS 定位而不是纯 CSS 的 ::before：
 *   行号要固定贴在正文区最左边缘，而正文 #write 是居中的，两者之间的距离
 *   随主题、段落宽度、侧栏开合不断变化，CSS 里算不出来。所以另起一层
 *   绝对定位的槽，逐个量出块的位置。代价是布局一变就要重量一次，
 *   触发点跟大纲的 measure() 完全一致。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 行号自身的行高，用来把号码对齐到块的第一行文字中线 */
  const NUMBER_LINE_HEIGHT = 16;

  const state = {
    on: false,
    pending: false
  };

  /* ---------------------------------------------------------------
   * 开关
   * --------------------------------------------------------------- */

  function apply(on) {
    state.on = !!on;
    document.body.classList.toggle('show-line-numbers', state.on);

    const gutter = $('linenum-gutter');
    if (!gutter) return;

    gutter.hidden = !state.on;
    if (state.on) measure();
    else gutter.replaceChildren();   // 关掉就清干净，别留着占内存
  }

  const isOn = () => state.on;

  /* ---------------------------------------------------------------
   * 定位
   * --------------------------------------------------------------- */

  /** 布局变了就重排行号。用 rAF 合并连续调用。 */
  function measure() {
    if (!state.on || state.pending) return;
    state.pending = true;
    requestAnimationFrame(() => {
      state.pending = false;
      layout();
    });
  }

  function layout() {
    const gutter = $('linenum-gutter');
    const content = $('content');
    const write = $('write');
    if (!gutter || !content || !write) return;

    const blocks = write.querySelectorAll('[data-line]');
    if (!blocks.length) {
      gutter.replaceChildren();
      return;
    }

    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;

    // 先把量测全做完再一次性写 DOM：读写交替会反复触发强制重排
    const placements = [];
    for (const block of blocks) {
      const line = block.dataset.line;
      if (!line) continue;

      const rect = firstLineRect(block) || block.getBoundingClientRect();
      if (!rect.height) continue;   // display:none 的块跳过

      // 行号在这一行的行盒里垂直居中。大标题行盒高、行号小，
      // 不居中的话号码会贴在标题顶上，看着像标错了行。
      placements.push({
        line,
        top: rect.top - contentTop + scrollTop + (rect.height - NUMBER_LINE_HEIGHT) / 2
      });
    }

    const frag = document.createDocumentFragment();
    for (const p of placements) {
      const el = document.createElement('span');
      el.className = 'linenum';
      el.style.top = Math.round(p.top) + 'px';
      el.textContent = p.line;
      frag.appendChild(el);
    }
    gutter.replaceChildren(frag);
  }

  /**
   * 量出块里**第一行文字**的行盒。
   *
   * 不能拿块自身的 getBoundingClientRect()：引用块和列表项里还套着 <p>，
   * 外层的 padding 加上内层的 margin，块顶到文字往往差着十几个像素，
   * 行号就会飘在文字上方。用 Range 圈住第一个字，量到的正是那一行的行盒。
   *
   * @returns {DOMRect|null} 没有可见文字时返回 null，由调用方退回块矩形
   */
  function firstLineRect(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data.trim()) return NodeFilter.FILTER_REJECT;
        // Mermaid 画出来的 SVG 里也有文字，量它会把行号拖到图表中间去
        const parent = node.parentElement;
        if (!parent || parent.closest('svg')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const node = walker.nextNode();
    if (!node) return null;

    // 圈住第一个非空白字符，避开行首缩进空白（它可能落在上一行）
    const offset = node.data.search(/\S/);
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);

    const rect = range.getBoundingClientRect();
    return rect.height ? rect : null;
  }

  /* ---------------------------------------------------------------
   * 启动
   * --------------------------------------------------------------- */

  function attach() {
    // 窗口尺寸变了整篇重排，行号跟着重量
    window.addEventListener('resize', measure);
  }

  global.LineNumbers = { attach, apply, measure, isOn };
})(window);
