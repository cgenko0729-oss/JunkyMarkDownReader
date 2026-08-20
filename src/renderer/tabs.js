/**
 * 顶部标签页
 *
 * 这一层只管「开着哪些文档、当前是哪一个」，真正的加载与渲染仍然由
 * app.js 的 loadDocument 完成 —— 切换标签就是重新渲染一次那份文件。
 *
 * 为什么不在内存里缓存每个标签的 DOM：
 *   缓存意味着要自己维护「这份缓存有没有过期」，而外部编辑器随时会改文件。
 *   重新渲染反而让主进程的 currentDocPath、文件监听、外部改动检测这三套
 *   既有逻辑一行都不用动，切回去还自动是最新内容。代价是切换大文件多花
 *   几十毫秒，滚动位置由 app.js 的 scrollMemory 接住，手感上察觉不到。
 *
 * 预览标签（VSCode 那套）：
 *   文件树单击开出来的是**预览标签**，标题显示成斜体，再点别的文件会把它
 *   顶掉而不是新开一个。双击、拖放、Ctrl+O、进编辑模式都会把它固定下来。
 *   没有这个机制，在文件树里翻十几个文件就能把标签栏塞爆。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    tabs: [],            // [{ path, name, preview }]
    activePath: null,
    onOpen: null,        // (path, opts) => Promise<boolean>  真正去加载，返回是否成功
    onChange: null,      // (patch) => void  标签集合变了，用来落盘
    onEmpty: null,       // () => void  最后一个标签也关掉了
    canLeave: null       // (opts) => boolean  当前文档允许被换掉吗（编辑模式的未保存确认）
  };

  /**
   * 所有会换掉正文的操作都要先过这一关。
   * 编辑模式下有未保存的改动时，app.js 传进来的这个钩子会弹确认框；
   * 用户选择留下就整个动作取消 —— 关键是**取消要发生在改动 state.tabs 之前**，
   * 否则标签已经被挪走/删掉，界面和状态就对不上了。
   */
  function canLeave(opts) {
    return !state.canLeave || state.canLeave(opts || {});
  }

  const samePath = (a, b) =>
    !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

  const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

  const indexOfPath = (p) => state.tabs.findIndex((t) => samePath(t.path, p));

  /* ---------------------------------------------------------------
   * 渲染
   * --------------------------------------------------------------- */

  function render() {
    const bar = $('tabbar');
    if (!bar) return;

    // 只有一个标签时也照常显示：标签栏消失又出现会让正文高度跳一下
    bar.hidden = state.tabs.length === 0;
    bar.replaceChildren();

    for (const tab of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab';
      el.classList.toggle('active', samePath(tab.path, state.activePath));
      el.classList.toggle('preview', !!tab.preview);
      el.classList.toggle('tab-text', /\.txt$/i.test(tab.path));
      el.dataset.path = tab.path;
      el.title = tab.path;

      const label = document.createElement('span');
      label.className = 'tab-label';
      // 扩展名对认文件没帮助，但 .txt 要留着 —— 同名的 .md 和 .txt 很常见
      label.textContent = /\.txt$/i.test(tab.name)
        ? tab.name
        : tab.name.replace(/\.[^.]+$/, '');

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.type = 'button';
      close.tabIndex = -1;
      close.title = '关闭 (Ctrl+W)';
      close.setAttribute('aria-label', `关闭 ${tab.name}`);
      close.textContent = '×';

      el.appendChild(label);
      el.appendChild(close);

      el.addEventListener('click', (event) => {
        if (event.target === close) {
          event.stopPropagation();
          closeTab(tab.path);
          return;
        }
        activate(tab.path);
      });

      // 双击把预览标签固定下来，跟 VSCode 一致
      el.addEventListener('dblclick', (event) => {
        if (event.target === close) return;
        pin(tab.path);
      });

      // 中键关闭
      el.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeTab(tab.path);
      });

      bar.appendChild(el);
    }

    scrollActiveIntoView();
  }

  function scrollActiveIntoView() {
    const bar = $('tabbar');
    if (!bar) return;
    const active = bar.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ---------------------------------------------------------------
   * 打开 / 切换
   * --------------------------------------------------------------- */

  /**
   * 打开一份文档，必要时新建标签。
   *
   * @param {string} filePath
   * @param {object} [opts]
   *   preview  true = 开成预览标签（文件树单击走这条）
   *   其余字段（hash / keepScroll / sourceLine / fromEditor）原样转给加载函数
   */
  async function open(filePath, opts = {}) {
    if (!filePath) return false;
    if (!canLeave(opts)) return false;

    const existing = indexOfPath(filePath);

    if (existing >= 0) {
      // 已经开着了：非预览方式再打开一次，顺手把它固定下来
      if (!opts.preview && state.tabs[existing].preview) {
        state.tabs[existing].preview = false;
      }
    } else if (opts.preview) {
      // 预览标签全局只有一个，新的顶掉旧的（位置不变，避免标签左右乱跳）
      const previewIndex = state.tabs.findIndex((t) => t.preview);
      const tab = { path: filePath, name: basename(filePath), preview: true };
      if (previewIndex >= 0) state.tabs[previewIndex] = tab;
      else state.tabs.push(tab);
    } else {
      // 固定标签插在当前标签右边，而不是甩到最后 —— 从一篇文档跳到它引用的
      // 另一篇时，两者挨着才符合直觉
      const at = indexOfPath(state.activePath);
      const tab = { path: filePath, name: basename(filePath), preview: false };
      if (at >= 0) state.tabs.splice(at + 1, 0, tab);
      else state.tabs.push(tab);
    }

    return activateInternal(filePath, opts);
  }

  /** 切到某个已存在的标签（公开入口，带守卫） */
  async function activate(filePath, opts = {}) {
    if (indexOfPath(filePath) < 0) return false;
    if (!canLeave(opts)) return false;
    return activateInternal(filePath, opts);
  }

  /**
   * 真正的切换：更新高亮 → 加载 → 落盘。
   * 加载失败（文件被删/改名）就把这个标签摘掉，不留一个点不开的空壳。
   *
   * 不带守卫 —— 调用方必须已经确认过可以离开当前文档，否则会重复弹确认框。
   */
  async function activateInternal(filePath, opts = {}) {
    const index = indexOfPath(filePath);
    if (index < 0) return false;

    const previous = state.activePath;
    state.activePath = state.tabs[index].path;
    render();

    const ok = await state.onOpen(state.tabs[index].path, opts);

    if (!ok) {
      state.tabs.splice(index, 1);
      state.activePath = previous && indexOfPath(previous) >= 0 ? previous : null;
      render();
      persist();
      return false;
    }

    persist();
    return true;
  }

  /** 把预览标签固定成正式标签 */
  function pin(filePath) {
    const index = indexOfPath(filePath || state.activePath);
    if (index < 0 || !state.tabs[index].preview) return;
    state.tabs[index].preview = false;
    render();
    persist();
  }

  /* ---------------------------------------------------------------
   * 关闭
   * --------------------------------------------------------------- */

  /**
   * 关闭一个标签。关掉的是当前标签时，接替的优先级是右邻 → 左邻，
   * 跟浏览器一致；全关光了就回到欢迎页。
   */
  function closeTab(filePath) {
    const index = indexOfPath(filePath || state.activePath);
    if (index < 0) return;

    const wasActive = samePath(state.tabs[index].path, state.activePath);
    // 关的是正在显示的这个才需要问；关别的标签不影响正文
    if (wasActive && !canLeave({})) return;
    state.tabs.splice(index, 1);

    if (!wasActive) {
      render();
      persist();
      return;
    }

    const next = state.tabs[index] || state.tabs[index - 1];
    if (next) {
      activateInternal(next.path);
    } else {
      state.activePath = null;
      render();
      persist();
      if (state.onEmpty) state.onEmpty();
    }
  }

  function closeOthers() {
    const keep = indexOfPath(state.activePath);
    if (keep < 0) return;
    // 留下的正是当前文档，正文不会变，不用问
    state.tabs = [state.tabs[keep]];
    render();
    persist();
  }

  function closeAll() {
    if (!canLeave({})) return;
    state.tabs = [];
    state.activePath = null;
    render();
    persist();
    if (state.onEmpty) state.onEmpty();
  }

  /* ---------------------------------------------------------------
   * 循环切换
   * --------------------------------------------------------------- */

  function step(delta) {
    if (state.tabs.length < 2) return;
    if (!canLeave({})) return;
    const at = indexOfPath(state.activePath);
    const from = at < 0 ? 0 : at;
    const next = (from + delta + state.tabs.length) % state.tabs.length;
    activateInternal(state.tabs[next].path);
  }

  const next = () => step(1);
  const prev = () => step(-1);

  /* ---------------------------------------------------------------
   * 持久化 / 恢复
   * --------------------------------------------------------------- */

  function persist() {
    if (!state.onChange) return;
    // 预览标签是临时的，不落盘：下次启动只恢复用户真正固定下来的那些
    state.onChange({
      openTabs: state.tabs.filter((t) => !t.preview).map((t) => t.path),
      activeTab: state.activePath || null
    });
  }

  /**
   * 从设置恢复上次的标签，并激活其中一个。
   *
   * 恢复失败的标签（文件被删了）会在 activate 里自动摘掉，所以这里
   * 只按顺序把路径填进去，真伪交给加载时判断。
   *
   * @param {string[]} paths
   * @param {string} [activePath]
   * @param {boolean} [skipLoad] 只把标签摆出来，不去加载任何一个
   *   （双击文件启动时用：马上就要开别的文件了，先渲染一份没人看的纯属浪费）
   * @returns {Promise<boolean>} 是否成功恢复出至少一个可用标签
   */
  async function restore(paths, activePath, skipLoad) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (!list.length) return false;

    state.tabs = list.map((p) => ({ path: p, name: basename(p), preview: false }));
    state.activePath = null;
    render();

    if (skipLoad) return false;

    // 优先恢复上次正在看的那个；它打不开就从头往下试
    const order = [];
    if (activePath && indexOfPath(activePath) >= 0) order.push(activePath);
    for (const tab of state.tabs) {
      if (!samePath(tab.path, activePath)) order.push(tab.path);
    }

    for (const p of order) {
      if (indexOfPath(p) < 0) continue;      // 前一轮已经被摘掉了
      if (await activateInternal(p)) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------
   * 对外
   * --------------------------------------------------------------- */

  function init(options) {
    state.onOpen = options.onOpen;
    state.onChange = options.onChange;
    state.onEmpty = options.onEmpty;
    state.canLeave = options.canLeave;

    // 标签栏很窄，纵向滚轮在这里没意义，转成横向滚动
    const bar = $('tabbar');
    if (bar) {
      bar.addEventListener('wheel', (event) => {
        if (event.deltaY === 0 || event.ctrlKey) return;
        event.preventDefault();
        bar.scrollLeft += event.deltaY;
      }, { passive: false });
    }
  }

  global.Tabs = {
    init,
    open,
    activate,
    pin,
    close: closeTab,
    closeOthers,
    closeAll,
    next,
    prev,
    restore,
    render,
    has: (p) => indexOfPath(p) >= 0,
    list: () => state.tabs.map((t) => ({ ...t })),
    get activePath() { return state.activePath; },
    get count() { return state.tabs.length; }
  };
})(window);
