/**
 * 文档内查找（Ctrl+F）
 *
 * 只搜当前打开的这一篇，不跨文件。
 *
 * 高亮走的是 CSS Custom Highlight API（CSS.highlights + ::highlight()），
 * 而不是常见的「把命中处包一层 <mark>」。理由：
 *   1. #write 里的 DOM 是 Typora 主题的地盘，插标签会改变元素结构，
 *      主题的相邻选择器（h2 + p 之类）和大纲的位置缓存都可能被带歪；
 *   2. 代码块被 hljs 拆成了一堆 <span>，往里插标签容易把 token 结构搞坏；
 *   3. 不改 DOM 也就不必写「撤销高亮」的逆操作，关掉搜索只要清空 registry。
 * 代价是 Range 会因 DOM 变动而失效 —— 所以文档重载、Mermaid 渲染完成之后
 * 都要调 refresh() 重跑一遍。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const HL_ALL = 'jmr-find';
  const HL_CURRENT = 'jmr-find-current';

  /** 命中太多时截断，避免病态输入（比如搜一个空格）把界面拖死 */
  const MAX_MATCHES = 4000;

  /** 这些子树里的文字不参与搜索 */
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CANVAS', 'IFRAME', 'TEXTAREA']);

  /**
   * 用来判断两段文字是否属于同一个「块」。
   * 跨块的两段文字之间会插一个换行符，防止上一段结尾和下一段开头
   * 拼出一个实际并不存在的词（"foo" + "bar" → "foobar"）。
   */
  const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, li, td, th, pre, blockquote, figcaption, dt, dd, div';

  const state = {
    open: false,
    query: '',          // 输入框里的当前内容
    lastQuery: '',      // 关掉搜索后仍然记着，下次 Ctrl+F 直接复用
    matches: [],        // Range[]，文档顺序
    index: -1,          // 当前命中在 matches 里的下标
    inputTimer: null,
    bound: false
  };

  const supported = typeof CSS !== 'undefined' &&
    CSS.highlights &&
    typeof global.Highlight === 'function';

  /* ---------------------------------------------------------------
   * 采集正文文字
   * --------------------------------------------------------------- */

  /**
   * 把 #write 里的可见文字拼成一整条字符串，同时记下每段文字对应哪个文本节点。
   * 返回 { hay, segments }，hay 已经是小写的，直接拿小写关键词去 indexOf。
   */
  function collect(root) {
    const segments = [];
    let hay = '';
    let prevBlock;

    // closest() 对每个文本节点都调一次会有点浪费，按父元素缓存
    const blockCache = new WeakMap();
    const skipCache = new WeakMap();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.data) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        return isSkipped(parent, skipCache) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = blockOf(node.parentElement, blockCache);
      if (prevBlock !== undefined && block !== prevBlock) hay += '\n';

      segments.push({ node, start: hay.length, len: node.data.length });
      hay += lowerKeepingLength(node.data);
      prevBlock = block;
    }

    return { hay, segments };
  }

  function isSkipped(el, cache) {
    if (cache.has(el)) return cache.get(el);

    let skipped = false;
    for (let cur = el; cur; cur = cur.parentElement) {
      // Mermaid 图表渲染成了 SVG，里面的 <text> 不适合参与查找：
      // 高亮画不出来，还会让计数虚高
      if (SKIP_TAGS.has(cur.tagName) || cur.tagName === 'svg' || cur.namespaceURI === 'http://www.w3.org/2000/svg') {
        skipped = true;
        break;
      }
      if (cur.id === 'write') break;
    }

    cache.set(el, skipped);
    return skipped;
  }

  function blockOf(el, cache) {
    if (cache.has(el)) return cache.get(el);
    const block = el.closest(BLOCK_SEL) || el;
    cache.set(el, block);
    return block;
  }

  /**
   * 小写化，但只在长度不变时才用小写结果。
   * 少数字符小写后长度会变（土耳其语 'İ' → 'i̇' 两个码元），那样偏移量就
   * 对不上原文本节点了。这种字符极罕见，遇到就原样保留、放弃它的大小写不敏感。
   */
  function lowerKeepingLength(text) {
    const lowered = text.toLowerCase();
    return lowered.length === text.length ? lowered : text;
  }

  /* ---------------------------------------------------------------
   * 找命中
   * --------------------------------------------------------------- */

  function run(query, opts = {}) {
    clearHighlights();
    state.matches = [];
    state.index = -1;
    state.query = query;

    const write = $('write');
    if (!query || !write) {
      updateReadout();
      return;
    }

    const { hay, segments } = collect(write);
    const needle = query.toLowerCase();

    let from = 0;
    while (state.matches.length < MAX_MATCHES) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;

      const range = makeRange(segments, at, at + needle.length);
      if (range) state.matches.push(range);

      from = at + Math.max(1, needle.length);
    }

    if (state.matches.length) {
      state.index = opts.keepIndex !== undefined
        ? Math.min(opts.keepIndex, state.matches.length - 1)
        : nearestToViewport();
    }

    paint();
    updateReadout();

    if (state.matches.length && opts.reveal !== false) reveal();
  }

  /** 把 hay 上的 [start, end) 换算成一个跨节点的 Range */
  function makeRange(segments, start, end) {
    const a = locate(segments, start);
    const b = locate(segments, end);
    if (!a || !b) return null;

    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null;   // 理论上不该发生，真出事了就丢掉这一处命中
    }
  }

  /** 二分查找：hay 上的偏移量 → 具体哪个文本节点的第几个字符 */
  function locate(segments, offset) {
    let lo = 0;
    let hi = segments.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segments[mid];
      if (offset < seg.start) hi = mid - 1;
      else if (offset > seg.start + seg.len) lo = mid + 1;
      else return { node: seg.node, offset: offset - seg.start };
    }
    return null;
  }

  /**
   * 挑一个「离当前视野最近」的命中作为起点，而不是每次都从文档开头开始 ——
   * 看到一半按 Ctrl+F，期望的是就近往下找。
   *
   * matches 按文档顺序排列，纵向位置基本单调，所以能二分，
   * 不必给几千个 Range 逐个算 getBoundingClientRect()。
   */
  function nearestToViewport() {
    const content = $('content');
    if (!content || state.matches.length < 2) return 0;

    const top = content.getBoundingClientRect().top;

    let lo = 0;
    let hi = state.matches.length - 1;
    let answer = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rect = state.matches[mid].getBoundingClientRect();
      if (rect.top >= top) {
        answer = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
        answer = Math.min(mid + 1, state.matches.length - 1);
      }
    }
    return answer;
  }

  /* ---------------------------------------------------------------
   * 高亮与滚动
   * --------------------------------------------------------------- */

  function paint() {
    if (!supported) return;

    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
    if (!state.matches.length) return;

    const all = new global.Highlight(...state.matches);
    all.priority = 1;
    CSS.highlights.set(HL_ALL, all);

    if (state.index >= 0 && state.matches[state.index]) {
      // 复制一份：同一个 Range 同时挂在两个 Highlight 上没必要冒险
      const current = new global.Highlight(state.matches[state.index].cloneRange());
      current.priority = 2;   // 数值大的赢，当前命中盖住普通命中
      CSS.highlights.set(HL_CURRENT, current);
    }
  }

  function clearHighlights() {
    if (!supported) return;
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
  }

  /** 把当前命中滚进视野。已经看得见就不动，免得每次跳转画面都晃一下。 */
  function reveal() {
    const range = state.matches[state.index];
    const content = $('content');
    if (!range || !content) return;

    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const box = content.getBoundingClientRect();
    const headroom = 64;   // 顶部要给浮动搜索条留出位置

    if (rect.top >= box.top + headroom && rect.bottom <= box.bottom - 24) return;

    const target = content.scrollTop + (rect.top - box.top) - Math.max(headroom, content.clientHeight * 0.3);
    content.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
  }

  function updateReadout() {
    const readout = $('find-count');
    const input = $('find-input');
    if (!readout || !input) return;

    const total = state.matches.length;
    readout.textContent = total ? `${state.index + 1}/${total}${total >= MAX_MATCHES ? '+' : ''}` : '0/0';
    input.classList.toggle('no-match', !!state.query && total === 0);

    $('find-prev').disabled = total === 0;
    $('find-next').disabled = total === 0;
  }

  /* ---------------------------------------------------------------
   * 导航
   * --------------------------------------------------------------- */

  function step(delta) {
    if (!state.matches.length) return;
    // 循环：最后一个再按「下一个」回到第一个
    state.index = (state.index + delta + state.matches.length) % state.matches.length;
    paint();
    updateReadout();
    reveal();
  }

  /* ---------------------------------------------------------------
   * 开关
   * --------------------------------------------------------------- */

  function open() {
    const dock = $('findbar-dock');
    const input = $('find-input');
    if (!dock || !input) return;

    if (!supported) {
      if (global.App) global.App.toast('当前运行环境不支持文档内查找');
      return;
    }

    state.open = true;
    dock.hidden = false;

    // 用户选的是「保留上次关键字」：不吃正文选区，总是沿用上一次搜过的词
    input.value = state.lastQuery;
    input.focus();
    input.select();

    if (state.lastQuery) run(state.lastQuery);
    else updateReadout();
  }

  function close() {
    const dock = $('findbar-dock');
    if (!dock) return;

    state.open = false;
    dock.hidden = true;

    if (state.query) state.lastQuery = state.query;
    clearHighlights();
    state.matches = [];
    state.index = -1;

    const content = $('content');
    if (content) content.focus({ preventScroll: true });
  }

  /** 文档内容原地变了（重载 / Mermaid 渲染完）：Range 全失效，重跑一遍 */
  function refresh() {
    if (!state.open || !state.query) return;
    run(state.query, { keepIndex: Math.max(0, state.index), reveal: false });
  }

  /** 换了一篇文档：直接关掉，但记住关键字 */
  function reset() {
    if (state.open) close();
    else clearHighlights();
  }

  /* ---------------------------------------------------------------
   * 绑定
   * --------------------------------------------------------------- */

  function attach() {
    if (state.bound) return;
    state.bound = true;

    const input = $('find-input');
    if (!input) return;

    input.addEventListener('input', () => {
      clearTimeout(state.inputTimer);
      // 边打字边搜，但压一下频率：长文档里每个按键都全文扫一遍会卡
      state.inputTimer = setTimeout(() => run(input.value), 110);
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // 输入还在防抖窗口里就先把这一次搜索跑掉，免得回车落空
        clearTimeout(state.inputTimer);
        if (input.value !== state.query) run(input.value);
        else step(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    $('find-prev').addEventListener('click', () => step(-1));
    $('find-next').addEventListener('click', () => step(1));
    $('find-close').addEventListener('click', close);

    // 正文区里按 Esc 也能关掉搜索
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });
  }

  global.Search = {
    attach,
    open,
    close,
    refresh,
    reset,
    next: () => step(1),
    prev: () => step(-1),
    isOpen: () => state.open
  };
})(window);
