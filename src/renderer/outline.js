/**
 * 大纲侧栏：标题列表 + 跟随滚动高亮
 */

(function (global) {
  'use strict';

  const listEl = () => document.getElementById('outline-list');
  const contentEl = () => document.getElementById('content');

  const state = {
    items: [],        // [{ level, text, id }]
    nodes: [],        // 大纲面板里的 DOM 项
    headings: [],     // 正文里对应的标题元素
    tops: [],         // 各标题相对滚动容器的位置（缓存，避免每次滚动都测量）
    activeIndex: -1,
    ticking: false
  };

  /** 顶部留一点余量，标题刚滚到顶时就算「当前所在」 */
  const ACTIVE_OFFSET = 24;

  function clear() {
    state.items = [];
    state.nodes = [];
    state.headings = [];
    state.tops = [];
    state.activeIndex = -1;
    listEl().innerHTML = '<div class="pane-empty">没有标题</div>';
  }

  /**
   * 渲染大纲。
   * @param {Array} items 主进程解析出的标题数组（id 与正文里的锚点算法一致）
   */
  function render(items) {
    state.items = items || [];
    state.activeIndex = -1;

    if (!state.items.length) {
      clear();
      return;
    }

    const container = document.createElement('div');
    container.className = 'outline-tree';

    // 标题层级可能从 h2 甚至 h3 起跳，按最小层级归一化缩进
    const minLevel = Math.min(...state.items.map((it) => it.level));

    state.nodes = state.items.map((item, index) => {
      const node = document.createElement('div');
      node.className = `outline-item level-${item.level}`;
      node.style.paddingLeft = `${8 + (item.level - minLevel) * 14}px`;

      // 文字单独包一层：悬停展开时要把它变成绝对定位的浮层，
      // 直接操作 .outline-item 会连带影响缩进和高亮背景
      const text = document.createElement('span');
      text.className = 'outline-text';
      text.textContent = item.text || '(无标题)';
      node.appendChild(text);

      // title 留着：拖到窄处时系统提示仍是最后的兜底
      node.title = item.text || '';

      // 只给真的被截断的行加 truncated —— 短标题也浮个白框出来纯属噪音。
      // 放在 pointerenter 里量而不是渲染时量：渲染那一刻侧栏可能还没布局完，
      // 而且用户随时会拖宽侧栏，截断与否是会变的。
      node.addEventListener('pointerenter', () => {
        node.classList.toggle('truncated', text.scrollWidth > text.clientWidth + 1);
      });

      node.addEventListener('click', () => jumpTo(index));
      container.appendChild(node);
      return node;
    });

    listEl().innerHTML = '';
    listEl().appendChild(container);

    measure();
  }

  /**
   * 缓存每个标题在滚动容器里的位置。
   * 用 getBoundingClientRect 而不是 offsetTop —— Typora 主题可能给
   * #write 设 position，offsetParent 会变，offsetTop 就不可靠了。
   */
  function measure() {
    const content = contentEl();
    if (!content) return;

    const contentTop = content.getBoundingClientRect().top;
    const scrollTop = content.scrollTop;

    state.headings = state.items.map((item) => {
      // id 里可能有中文等字符，用 getElementById 而不是 querySelector，免去转义问题
      return document.getElementById(item.id);
    });

    state.tops = state.headings.map((el) => {
      if (!el) return Number.POSITIVE_INFINITY;
      return el.getBoundingClientRect().top - contentTop + scrollTop;
    });

    updateActive();
  }

  function jumpTo(index) {
    const content = contentEl();
    const top = state.tops[index];
    if (!content || top === undefined || !isFinite(top)) return;
    content.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
    setActive(index);
  }

  /** 找出当前应该高亮哪一项：最后一个已经滚过顶部的标题 */
  function updateActive() {
    const content = contentEl();
    if (!content || !state.tops.length) return;

    const y = content.scrollTop + ACTIVE_OFFSET;

    let index = -1;
    for (let i = 0; i < state.tops.length; i++) {
      if (state.tops[i] <= y) index = i;
      else break; // tops 是升序的，可以提前结束
    }
    // 还没滚到第一个标题时，就把第一个当作当前项
    if (index < 0 && state.tops.length) index = 0;

    setActive(index);
  }

  function setActive(index) {
    if (index === state.activeIndex) return;
    if (state.nodes[state.activeIndex]) {
      state.nodes[state.activeIndex].classList.remove('active');
    }
    state.activeIndex = index;
    const node = state.nodes[index];
    if (node) {
      node.classList.add('active');
      // 让高亮项保持在大纲面板可视范围内
      const pane = listEl();
      const nodeRect = node.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      if (nodeRect.top < paneRect.top || nodeRect.bottom > paneRect.bottom) {
        node.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /** 滚动事件用 rAF 节流 */
  function onScroll() {
    if (state.ticking) return;
    state.ticking = true;
    requestAnimationFrame(() => {
      state.ticking = false;
      updateActive();
    });
  }

  function attach() {
    const content = contentEl();
    if (content) content.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => measure());
  }

  /** 滚动到指定锚点 id（处理文档内 [text](#anchor) 链接） */
  function scrollToId(id) {
    const index = state.items.findIndex((it) => it.id === id);
    if (index >= 0) {
      jumpTo(index);
      return true;
    }
    // 不在标题列表里（比如脚注锚点），退化为直接定位元素
    const el = document.getElementById(id);
    const content = contentEl();
    if (el && content) {
      const top = el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
      content.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
      return true;
    }
    return false;
  }

  global.Outline = { render, clear, measure, attach, scrollToId };
})(window);
