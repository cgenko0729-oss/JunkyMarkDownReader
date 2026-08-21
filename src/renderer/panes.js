/**
 * 侧栏宽度拖拽
 *
 * 两条边界（文件树右侧、大纲左侧）各挂一个拖拽条，宽度记进设置，重启后保持。
 *
 * 拖拽条本身宽度为 0，热区是它的 ::before —— 一个跨在边界上的 7px 绝对定位块。
 * 这样加了拖拽条**完全不改变布局**：如果给它一个真实宽度，两侧就会各多出一条
 * 几像素的空隙，边框和面板之间会裂开一道缝。
 *
 * 宽度用 CSS 自定义属性下发（--sidebar-w / --outline-w），而不是逐个元素写
 * inline style —— 面板的 flex-basis、拖拽条的位置都要跟着走，一个变量搞定。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 侧栏能拖到多窄。再窄下去标题一个字都放不下，纯属浪费 */
  const MIN_PANE = 150;
  /** 正文至少要留这么宽，否则拖到最后正文只剩一条缝 */
  const MIN_CONTENT = 320;
  /** 侧栏能拖到多宽。上限主要防手滑，实际还会被 MIN_CONTENT 卡住 */
  const MAX_PANE = 640;

  const DEFAULTS = { sidebar: 240, outline: 230 };

  const state = {
    /**
     * 当前宽度，本模块自己说了算。
     *
     * 刻意不去读 app.js 的 state.settings —— 那边的 patchSettings 是
     * `state.settings = { ...state.settings, ...patch }`，每次改设置都换一个新对象，
     * 这里若只握着最初那个引用，拖完宽度再触发一次窗口 resize 就会读到旧值、
     * 把用户刚拖好的宽度弹回去（实测过）。
     */
    width: { sidebar: null, outline: null },
    onChange: null,
    onResize: null,
    frame: 0
  };

  const VAR = { sidebar: '--sidebar-w', outline: '--outline-w' };
  const PANE_ID = { sidebar: 'sidebar', outline: 'outline' };
  const SETTING_KEY = { sidebar: 'sidebarWidth', outline: 'outlineWidth' };

  /* ---------------------------------------------------------------
   * 宽度计算
   * --------------------------------------------------------------- */

  /** 另一个侧栏此刻实际占了多宽（收起来时是 0） */
  function otherPaneWidth(which) {
    const other = $(PANE_ID[which === 'sidebar' ? 'outline' : 'sidebar']);
    if (!other || other.hidden) return 0;
    return other.getBoundingClientRect().width;
  }

  /**
   * 把一个宽度夹到合法范围。
   * 上限是动态的：窗口越窄、另一个侧栏越宽，这一个能占的就越少。
   */
  function clamp(which, width) {
    const room = window.innerWidth - otherPaneWidth(which) - MIN_CONTENT;
    const max = Math.max(MIN_PANE, Math.min(MAX_PANE, room));
    return Math.round(Math.max(MIN_PANE, Math.min(max, width)));
  }

  function currentWidth(which) {
    return clamp(which, Number(state.width[which]) || DEFAULTS[which]);
  }

  /** 宽度定下来了：更新自己的状态、刷 CSS 变量、落盘 */
  function commit(which, width) {
    const px = clamp(which, width);
    state.width[which] = px;
    writeVar(which, px);
    if (state.onChange) state.onChange({ [SETTING_KEY[which]]: px });
    if (state.onResize) state.onResize();
  }

  function writeVar(which, width) {
    document.documentElement.style.setProperty(VAR[which], width + 'px');
  }

  /**
   * 把宽度重新落到 CSS 变量上。侧栏开合、窗口缩放之后都要重来一次
   * （可用上限跟着变了，超标的宽度得收回来）。
   *
   * @param {object} [settings] 传了就以它为准 —— app.js 调用时给的是最新的那份
   */
  function apply(settings) {
    if (settings) {
      for (const which of ['sidebar', 'outline']) {
        const v = Number(settings[SETTING_KEY[which]]);
        if (v > 0) state.width[which] = v;
      }
    }
    writeVar('sidebar', currentWidth('sidebar'));
    writeVar('outline', currentWidth('outline'));
  }

  /**
   * 排版收尾。拖动时正文宽度在连续变化，大纲的位置缓存和行号槽都会失准，
   * 但每个 pointermove 都重算太贵（大纲的 measure 是 O(标题数) 次取矩形），
   * 所以用 rAF 合并成每帧最多一次。
   */
  function scheduleRelayout() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      if (state.onResize) state.onResize();
    });
  }

  /* ---------------------------------------------------------------
   * 拖拽
   * --------------------------------------------------------------- */

  function bindResizer(resizerId, which) {
    const handle = $(resizerId);
    if (!handle) return;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();          // 别让它变成选取文字
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
      // 拖过正文时光标不要变回 text，也别选中任何东西
      document.body.classList.add('resizing');

      const onMove = (moveEvent) => {
        const pane = $(PANE_ID[which]);
        if (!pane) return;
        const box = pane.getBoundingClientRect();
        // 左侧栏量到光标，右侧栏量回来 —— 两边的"生长方向"是相反的
        const raw = which === 'sidebar'
          ? moveEvent.clientX - box.left
          : box.right - moveEvent.clientX;

        writeVar(which, clamp(which, raw));
        scheduleRelayout();
      };

      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');

        // 落盘用的是 CSS 变量的最终值，而不是重新量一次元素 ——
        // 侧栏此刻可能是隐藏的（拖到一半按了 Ctrl+B），量出来会是 0
        const px = parseInt(
          getComputedStyle(document.documentElement).getPropertyValue(VAR[which]), 10);
        if (px > 0) commit(which, px);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp, { once: true });
      handle.addEventListener('pointercancel', onUp, { once: true });
    });

    // 双击回到默认宽度，跟各家编辑器一致
    handle.addEventListener('dblclick', () => commit(which, DEFAULTS[which]));
  }

  /* ---------------------------------------------------------------
   * 装配
   * --------------------------------------------------------------- */

  function attach(options) {
    state.onChange = options.onChange;
    state.onResize = options.onResize;
    apply(options.settings);

    bindResizer('resize-sidebar', 'sidebar');
    bindResizer('resize-outline', 'outline');

    // 窗口变窄时上限跟着变，得把已经超标的宽度收回来
    window.addEventListener('resize', () => apply());
  }

  global.Panes = { attach, apply, DEFAULTS };
})(window);
