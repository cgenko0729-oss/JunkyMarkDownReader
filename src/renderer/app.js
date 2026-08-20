/**
 * 渲染进程主控制器
 *
 * 职责：串起设置、主题、文件树、大纲、Mermaid，处理工具栏与文档内的交互。
 * Markdown 的解析与渲染都在主进程完成，这里拿到的是 HTML 字符串。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    settings: null,
    doc: null,                    // 当前文档 { path, name, kind, html, outline, ... }
    scrollMemory: new Map(),      // 文档路径 → 上次的滚动位置
    dragDepth: 0,                 // dragenter/dragleave 配对计数，防遮罩闪烁
    /**
     * 加载序号。切标签和「退出编辑模式后自动重渲染」可能同时在飞，
     * 谁后发起谁作数 —— 否则会出现切过去又被旧文档顶回来。
     */
    loadToken: 0
  };

  const MIN_FONT = 11;
  const MAX_FONT = 28;

  /**
   * 段落宽度档位（px）。0 = 跟随当前 Typora 主题自己设计的宽度。
   * 括号里是 19px 中文字号下的大致每行字数，中文 35~45 字/行最好读。
   */
  const WIDTH_STEPS = [
    0,      // 跟随主题
    700,    // 约 34 字
    780,    // 约 38 字
    860,    // 约 42 字
    960,    // 约 47 字
    1080,   // 约 53 字
    1220,   // 约 60 字
    1400    // 约 68 字
  ];

  /* ---------------------------------------------------------------
   * 小工具
   * --------------------------------------------------------------- */

  let toastTimer = null;
  function toast(message, ms = 2200) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /**
   * 排版变动后的统一收尾：大纲的位置缓存和行号槽都依赖元素的实际位置，
   * 任何会让正文重排的操作（字号、段落宽度、侧栏开合、换主题）都得走这里。
   */
  function relayout() {
    global.Outline.measure();
    global.LineNumbers.measure();
  }

  /** 改设置：内存 + 落盘 */
  function patchSettings(patch) {
    if (!patch || !Object.keys(patch).length) return;
    state.settings = { ...state.settings, ...patch };
    global.api.setSettings(patch);
  }

  const isMarkdownPath = (p) => /\.(md|markdown|mdown|mkd|mdtext)$/i.test(p || '');
  const isPlainTextPath = (p) => /\.txt$/i.test(p || '');
  /** 本应用能在窗口内打开的文档类型（与主进程的 files.isSupportedFile 对齐） */
  const isSupportedPath = (p) => isMarkdownPath(p) || isPlainTextPath(p);
  const isCSharpPath = (p) => /\.cs$/i.test(p || '');

  /**
   * 把 .cs 链接丢给 Visual Studio 2022。
   * hash 形如 "#L550"（也接受 "#L550-560"，取起始行）。
   */
  async function openInVisualStudio(filePath, hash) {
    const m = /^#L(\d+)/i.exec(hash || '');
    const line = m ? Number(m[1]) : 0;

    toast(line ? `正在用 VS 2022 打开 L${line} …` : '正在用 VS 2022 打开 …');

    const res = await global.api.openInVisualStudio(filePath, line);
    if (res && res.ok) {
      const name = filePath.split(/[\\/]/).pop();
      toast(line ? `已在 VS 2022 打开 ${name} L${line}` : `已在 VS 2022 打开 ${name}`);
    } else {
      // 打不开时退回资源管理器，至少让用户拿得到文件
      toast('VS 2022 打不开：' + ((res && res.reason) || '未知原因'), 4000);
      global.api.revealInExplorer(filePath);
    }
  }

  /* ---------------------------------------------------------------
   * 排版参数（字号 / 正文宽度）
   *
   * 用 inline style 打在 #write 上 —— 内联样式的优先级高于外部样式表，
   * 这样才压得住 Typora 主题里对 #write 的设定，又不必到处写 !important。
   * --------------------------------------------------------------- */

  function applyTypography() {
    const write = $('write');
    const size = state.settings.fontSize || 16;
    write.style.fontSize = size + 'px';

    // contentWidth 为 0 表示「跟随主题自己的设计」，不去干扰它。
    // 用固定像素而不是百分比，这样开关侧栏时段落宽度不会跳动。
    const width = state.settings.contentWidth || 0;
    write.style.maxWidth = width > 0 ? width + 'px' : '';

    $('font-readout').textContent = String(size);
    $('width-readout').textContent = width > 0 ? String(width) : '主题';
  }

  function changeFontSize(delta) {
    let size;
    if (delta === 0) {
      size = 16;
    } else {
      size = Math.min(MAX_FONT, Math.max(MIN_FONT, (state.settings.fontSize || 16) + delta));
    }
    if (size === state.settings.fontSize) return;
    patchSettings({ fontSize: size });
    applyTypography();
    // 字号变了行高全变，大纲的位置缓存要重算
    setTimeout(relayout, 60);
  }

  /**
   * 段落宽度换档。
   * @param {number} delta +1 更宽 / -1 更窄 / 0 回到「跟随主题」
   */
  function changeContentWidth(delta) {
    const current = state.settings.contentWidth || 0;

    let next;
    if (delta === 0) {
      next = 0;
    } else {
      // 当前值可能来自旧设置、不在档位表里，取最接近的一档再移动
      let index = WIDTH_STEPS.indexOf(current);
      if (index < 0) {
        index = WIDTH_STEPS.reduce(
          (best, w, i) => (Math.abs(w - current) < Math.abs(WIDTH_STEPS[best] - current) ? i : best),
          0
        );
      }
      const target = Math.min(WIDTH_STEPS.length - 1, Math.max(0, index + delta));
      next = WIDTH_STEPS[target];
    }

    if (next === current) {
      toast(delta > 0 ? '已经是最宽的一档' : '已经是最窄的一档');
      return;
    }

    patchSettings({ contentWidth: next });
    applyTypography();
    toast(next > 0 ? `段落宽度 ${next}px` : '段落宽度跟随主题');
    // 宽度变了整篇重排，大纲的位置缓存要重算
    setTimeout(relayout, 60);
  }

  /* ---------------------------------------------------------------
   * 侧栏显示/隐藏
   * --------------------------------------------------------------- */

  function applyPanes() {
    const showSidebar = !!state.settings.showSidebar;

    // 纯文本没有 Markdown 标题，大纲永远是空的，开着只是白占一列 ——
    // 自动收起，但**不动用户的设置**，切回 .md 时它自己会回来
    const isText = !!(state.doc && state.doc.kind === 'text');
    const showOutline = !!state.settings.showOutline && !isText;

    $('sidebar').hidden = !showSidebar;
    $('outline').hidden = !showOutline;
    $('btn-sidebar').classList.toggle('active', showSidebar);
    $('btn-outline').classList.toggle('active', showOutline);
    $('btn-outline').disabled = isText;

    setTimeout(relayout, 60);
  }

  function toggleSidebar() {
    patchSettings({ showSidebar: !state.settings.showSidebar });
    applyPanes();
    // 第一次打开侧栏时如果还没有工作区，顺手引导一下
    if (state.settings.showSidebar && !state.settings.workspace) {
      global.FileTree.showEmpty();
    }
  }

  function toggleOutline() {
    if (state.doc && state.doc.kind === 'text') {
      toast('纯文本没有标题，大纲不可用');
      return;
    }
    patchSettings({ showOutline: !state.settings.showOutline });
    applyPanes();
  }

  /* ---------------------------------------------------------------
   * 行号槽
   * --------------------------------------------------------------- */

  function toggleLineNumbers() {
    const next = !state.settings.showLineNumbers;
    patchSettings({ showLineNumbers: next });
    global.LineNumbers.apply(next);
    toast(next ? '已显示源文件行号' : '已隐藏行号');
  }

  /* ---------------------------------------------------------------
   * 滚动位置记忆
   * --------------------------------------------------------------- */

  function saveScroll() {
    if (state.doc && state.doc.path) {
      state.scrollMemory.set(state.doc.path, $('content').scrollTop);
    }
  }

  function restoreScroll(filePath, forcedTop) {
    const content = $('content');
    const top = forcedTop !== undefined ? forcedTop : (state.scrollMemory.get(filePath) || 0);
    // 等两帧，让新插入的 DOM 完成布局后再定位
    requestAnimationFrame(() => requestAnimationFrame(() => { content.scrollTop = top; }));
  }

  /* ---------------------------------------------------------------
   * 打开文档
   * --------------------------------------------------------------- */

  /**
   * 打开一份文档 —— 对外的统一入口。
   *
   * 它只负责「让标签页知道该显示谁」，真正的读取渲染在 loadDocument 里，
   * 由 Tabs 回调过来。编辑模式的未保存确认也归 Tabs 的 canLeave 钩子管。
   *
   * @param {string} filePath
   * @param {object} [opts] { preview, keepScroll, hash, sourceLine, fromEditor }
   * @returns {Promise<boolean>}
   */
  function openDocument(filePath, opts = {}) {
    if (!filePath) return Promise.resolve(false);
    return global.Tabs.open(filePath, opts);
  }

  /**
   * 真正把文档读进来并渲染。**只由 Tabs 调用**，别的地方一律走 openDocument。
   *
   * @returns {Promise<boolean>} 失败时 Tabs 会把对应的标签摘掉
   */
  async function loadDocument(filePath, opts = {}) {
    if (!filePath) return false;

    const token = ++state.loadToken;

    const previousTop = $('content').scrollTop;
    const isSameDoc = !!(state.doc && state.doc.path === filePath);
    saveScroll();

    const result = await global.api.loadFile(filePath);

    // 这次加载已经被更晚的一次取代了，结果直接丢掉（见 state.loadToken）
    if (token !== state.loadToken) return true;

    if (!result || result.error) {
      toast('打开失败：' + ((result && result.error) || '未知错误'));
      return false;
    }

    state.doc = result;

    // 纯文本的排版由 #write .plaintext 那组规则接管（见 shell.css）；
    // body 上这个标记是给外壳自己用的状态位，applyPanes 靠它决定收不收大纲
    document.body.classList.toggle('text-doc', result.kind === 'text');

    // 换文档就收起查找条；同一篇原地重载则保留，等 DOM 换完再重跑。
    // 重跑是必须的：老的 Range 指向的文本节点已经被 innerHTML 整个换掉了。
    if (!isSameDoc) global.Search.reset();

    const write = $('write');
    // 关键一步：渲染结果必须过 DOMPurify，Markdown 里夹带的脚本在此被剥掉
    write.innerHTML = global.Sanitize.clean(result.html);

    $('welcome').hidden = true;
    $('doc-title').textContent = result.name;
    $('doc-title').title = result.path;

    applyTypography();
    global.Outline.render(result.outline);
    applyPanes();                  // 纯文本要把大纲收起来，普通文档则恢复原状
    global.LineNumbers.measure();
    global.FileTree.setActiveFile(result.path);

    // 没设过工作区的话，把文档所在目录当作工作区
    // （侧栏此时未必展开，不打扰，但展开就能看到同目录的其他文档）
    if (!state.settings.workspace) {
      patchSettings({ workspace: result.dir });
      global.FileTree.setRoot(result.dir);
    }

    if (result.hasMermaid) {
      global.MermaidRender.renderAll(write, global.Theme.getMode())
        .then(() => {
          relayout();
          global.Search.refresh();   // 图表替换了 DOM，命中位置要重算
        });
    }

    if (opts.hash) {
      // 等大纲位置测量完再跳锚点
      setTimeout(() => global.Outline.scrollToId(opts.hash.replace(/^#/, '')), 80);
    } else if (opts.sourceLine) {
      // 刚从编辑模式回来：落到光标那一行对应的块，而不是文档开头
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!scrollToSourceLine(opts.sourceLine)) restoreScroll(result.path);
      }));
    } else {
      restoreScroll(result.path, opts.keepScroll ? previousTop : undefined);
    }

    // 查找条开着的时候别抢焦点，否则原地重载一次就要重新点回输入框
    if (!global.Search.isOpen()) $('content').focus({ preventScroll: true });
    else global.Search.refresh();

    syncCodeTheme();
    warnIfOverflowing();

    // 超大纯文本退化成了单块，行号槽只剩一个「1」，说一声免得以为是坏了
    if (result.degraded) {
      toast('这个文件太大，已按整块显示，逐行行号不可用', 4000);
    }

    return true;
  }

  /** 最后一个标签也关掉了：清空正文，回到欢迎页 */
  function showWelcome() {
    state.doc = null;
    state.loadToken++;             // 让还在飞的加载作废，别把正文又填回来

    global.Search.reset();
    $('write').replaceChildren();
    $('welcome').hidden = false;
    $('doc-title').textContent = '未打开文档';
    $('doc-title').title = '';

    document.body.classList.remove('text-doc');
    global.Outline.clear();
    global.LineNumbers.measure();
    global.FileTree.setActiveFile(null);
    renderRecent();
    applyPanes();
  }

  /**
   * 开发期护栏：宽元素突破用的是负 margin，一旦哪条规则算错就会把正文区
   * 撑出水平滚动条。这里不只报警，还把越界的元素列出来 —— 肉眼盯滚动条
   * 根本看不出是谁干的。
   */
  function warnIfOverflowing() {
    setTimeout(() => {
      const content = $('content');
      if (!content) return;

      const box = content.getBoundingClientRect();
      const rightSlack = content.scrollWidth - content.clientWidth;

      // 左侧溢出要单独查：内容跑到左边界外面会被直接裁掉，
      // scrollWidth 完全不变，光看它是发现不了的（真踩过）。
      const strays = [];
      for (const el of document.querySelectorAll('#write, #write *')) {
        if (strays.length >= 6) break;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;
        if (isClippedByAncestor(el, content)) continue;

        if (rect.left < box.left - 1) {
          strays.push({ el, side: '左', over: box.left - rect.left, rect });
        } else if (rect.right > box.right + 1) {
          strays.push({ el, side: '右', over: rect.right - box.right, rect });
        }
      }

      if (rightSlack <= 1 && !strays.length) return;

      console.warn(`[layout] 正文排版越界（右侧滚动条 ${Math.max(0, rightSlack)}px），涉及元素：`);
      for (const s of strays) {
        const cls = s.el.className ? `.${String(s.el.className).split(' ')[0]}` : '';
        console.warn(
          `  ${s.el.tagName}${cls} 向${s.side}超出 ${Math.round(s.over)}px ` +
          `(left=${Math.round(s.rect.left)} right=${Math.round(s.rect.right)} w=${Math.round(s.rect.width)})`
        );
      }
      if (!strays.length) console.warn('  没找到具体元素，可能来自被裁剪的子树');
    }, 400);
  }

  /**
   * 让代码高亮配色匹配当前 Typora 主题的代码块底色。
   *
   * 不能简单跟随亮暗模式：有的亮色主题配暗色代码块（drake-jb 就是），
   * 那样会把深色的高亮配色打在深色底上，整段代码糊成一片。
   * 所以直接量代码块的实际背景亮度来决定。
   */
  function syncCodeTheme() {
    const pre = document.querySelector('#write pre.md-fences');
    // 文档里没有代码块时，退回按亮暗模式判断
    if (!pre) {
      global.Theme.setCodeDark(global.Theme.getMode() === 'dark');
      return;
    }

    const bg = getComputedStyle(pre).backgroundColor;
    const m = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);

    // 背景透明说明主题没给代码块单独上色，那就看正文模式
    if (!m || (m[4] !== undefined && parseFloat(m[4]) < 0.1)) {
      global.Theme.setCodeDark(global.Theme.getMode() === 'dark');
      return;
    }

    // 感知亮度（ITU-R BT.601），比直接比 RGB 更贴近肉眼判断
    const luminance = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
    global.Theme.setCodeDark(luminance < 128);
  }

  /** 元素与 stopAt 之间是否存在会裁剪它的祖先 */
  function isClippedByAncestor(el, stopAt) {
    let parent = el.parentElement;
    while (parent && parent !== stopAt) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX !== 'visible') return true;
      parent = parent.parentElement;
    }
    return false;
  }

  /**
   * 重新加载当前文档，保持滚动位置。
   * 直接走 loadDocument：标签集合根本没变，没必要惊动 Tabs。
   */
  function reloadDocument() {
    if (state.doc && state.doc.path) {
      loadDocument(state.doc.path, { keepScroll: true });
    }
  }

  /* ---------------------------------------------------------------
   * 打开文件 / 文件夹
   * --------------------------------------------------------------- */

  async function openFile() {
    const picked = await global.api.openFileDialog();
    if (picked) openDocument(picked);
  }

  async function openFolder() {
    const dir = await global.api.openFolderDialog();
    if (!dir) return;
    patchSettings({ workspace: dir, showSidebar: true });
    applyPanes();
    global.FileTree.setRoot(dir);
    global.QuickOpen.invalidate();   // 换了工作区，Ctrl+P 的索引作废
  }

  /** 拖进来一个文件夹时走这里 */
  async function setWorkspace(dir) {
    const probe = await global.api.listDir(dir);
    if (probe.error) {
      toast('无法作为文件夹打开：' + probe.error);
      return;
    }
    patchSettings({ workspace: dir, showSidebar: true });
    applyPanes();
    global.FileTree.setRoot(dir);
    global.QuickOpen.invalidate();
  }

  /* ---------------------------------------------------------------
   * 最近打开（空状态里那一列）
   * --------------------------------------------------------------- */

  function renderRecent() {
    const box = $('welcome-recent');
    const recent = state.settings.recentFiles || [];
    box.innerHTML = '';
    if (!recent.length) return;

    const title = document.createElement('div');
    title.className = 'welcome-recent-title';
    title.textContent = '最近打开';
    box.appendChild(title);

    for (const p of recent.slice(0, 8)) {
      const item = document.createElement('button');
      item.className = 'recent-item';
      item.title = p;
      item.textContent = p.split(/[\\/]/).pop();
      item.addEventListener('click', () => openDocument(p));
      box.appendChild(item);
    }
  }

  /* ---------------------------------------------------------------
   * 文档内的交互：链接、图片
   * --------------------------------------------------------------- */

  function bindDocumentInteractions() {
    const write = $('write');

    // 链接：主进程渲染时已经按类型打好了 data-link-type 标记
    write.addEventListener('click', (event) => {
      const link = event.target.closest('a');
      if (!link) return;

      const type = link.dataset.linkType;
      const href = link.getAttribute('href') || '';

      if (type === 'external' || /^https?:\/\//i.test(href)) {
        event.preventDefault();
        global.api.openExternal(link.href || href);
        return;
      }

      if (type === 'anchor' || href.startsWith('#')) {
        event.preventDefault();
        const id = decodeURIComponent(href.replace(/^#/, ''));
        if (!global.Outline.scrollToId(id)) toast('找不到锚点：' + id);
        return;
      }

      if (type === 'local') {
        event.preventDefault();
        const target = link.dataset.localPath;
        if (!target) return;
        if (isSupportedPath(target)) {
          openDocument(target, { hash: link.dataset.localHash });
        } else if (isCSharpPath(target)) {
          // [L550](Setsuna/SkillData.cs#L550) → 用 VS 2022 打开并跳到该行
          openInVisualStudio(target, link.dataset.localHash);
        } else {
          // 其余非 Markdown 的本地文件不在应用内打开，改为定位到资源管理器
          global.api.revealInExplorer(target);
        }
        return;
      }

      // 其余情况（例如脚注生成的链接）交给浏览器默认行为，但拦下整页导航
      if (!href.startsWith('#')) event.preventDefault();
    });

    // 图片点击放大
    write.addEventListener('click', (event) => {
      if (event.target.tagName === 'IMG') showLightbox(event.target.src, event.target.alt);
    });

    // 主题 CSS 是异步加载的，加载完布局和配色才定下来：
    // 重算大纲位置，并按新主题的代码块底色校正高亮配色
    const themeLink = $('typora-theme');
    if (themeLink) {
      themeLink.addEventListener('load', () => {
        relayout();
        syncCodeTheme();
      });
    }
  }

  function showLightbox(src, alt) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox';

    const img = document.createElement('img');
    img.src = src;
    if (alt) img.alt = alt;

    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  /* ---------------------------------------------------------------
   * 拖放
   * --------------------------------------------------------------- */

  function bindDragDrop() {
    const overlay = $('drop-overlay');

    document.addEventListener('dragenter', (event) => {
      event.preventDefault();
      state.dragDepth++;
      overlay.classList.add('show');
    });

    document.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', (event) => {
      event.preventDefault();
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) overlay.classList.remove('show');
    });

    document.addEventListener('drop', (event) => {
      event.preventDefault();
      state.dragDepth = 0;
      overlay.classList.remove('show');

      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) return;

      // Electron 32 起 File.path 被移除，路径要通过 preload 里的 webUtils 拿
      const filePath = global.api.getPathForFile(file);
      if (!filePath) {
        toast('无法获取拖入项目的路径');
        return;
      }

      if (isSupportedPath(filePath)) openDocument(filePath);
      else setWorkspace(filePath);   // 大概是个文件夹，试着当工作区打开
    });
  }

  /* ---------------------------------------------------------------
   * 工具栏与快捷键
   * --------------------------------------------------------------- */

  function bindUI() {
    $('btn-open').addEventListener('click', openFile);
    $('btn-open-folder').addEventListener('click', openFolder);
    $('btn-welcome-open').addEventListener('click', openFile);
    $('btn-welcome-folder').addEventListener('click', openFolder);

    $('btn-sidebar').addEventListener('click', toggleSidebar);
    $('btn-outline').addEventListener('click', toggleOutline);
    $('btn-edit').addEventListener('click', toggleEditor);

    $('btn-font-inc').addEventListener('click', () => changeFontSize(1));
    $('btn-font-dec').addEventListener('click', () => changeFontSize(-1));

    $('btn-width-inc').addEventListener('click', () => changeContentWidth(1));
    $('btn-width-dec').addEventListener('click', () => changeContentWidth(-1));

    $('btn-mode').addEventListener('click', () => {
      patchSettings(global.Theme.toggleMode());
    });

    $('theme-select').addEventListener('change', (event) => {
      patchSettings(global.Theme.setTheme(event.target.value));
    });

    // Ctrl + 滚轮调字号
    $('content').addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      changeFontSize(event.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  }

  /* ---------------------------------------------------------------
   * 源码编辑模式
   * --------------------------------------------------------------- */

  /**
   * 进入编辑模式时，把光标放到「当前正在读的那一段」对应的源码行 ——
   * 几千行的文档里让用户自己重新找位置太不友好了。
   * 行号来自渲染时打在块上的 data-line（见 main/markdown.js）。
   */
  function readingLine() {
    const content = $('content');
    const blocks = document.querySelectorAll('#write [data-line]');
    if (!content || !blocks.length) return 0;

    const top = content.getBoundingClientRect().top + 8;
    let line = 0;
    for (const block of blocks) {
      if (block.getBoundingClientRect().top > top) break;
      line = Number(block.dataset.line) || line;
    }
    return line;
  }

  function toggleEditor() {
    if (global.Editor.isOn()) {
      global.Editor.close();
      return;
    }
    if (!state.doc) {
      toast('还没有打开文档');
      return;
    }
    // 编辑模式下查找条没有意义（查的是渲染后的正文），先收起来
    global.Search.reset();
    // 开始编辑了，预览标签就该固定下来 —— 不然点一下文件树改动就没了着落
    global.Tabs.pin();
    global.Editor.open(state.doc.path, readingLine());
  }

  /** 退出编辑模式后：重新渲染，并回到光标所在那一行对应的位置 */
  function onEditorExit(caretLine) {
    if (!state.doc) return;
    loadDocument(state.doc.path, { sourceLine: caretLine });
  }

  /**
   * 滚到原文第 line 行所在的那一块。
   * 块上的 data-line 是升序的，取最后一个不超过 line 的即可。
   */
  function scrollToSourceLine(line) {
    if (!line) return false;

    let target = null;
    for (const block of document.querySelectorAll('#write [data-line]')) {
      if (Number(block.dataset.line) <= line) target = block;
      else break;
    }
    if (!target) return false;

    const content = $('content');
    const top = target.getBoundingClientRect().top -
                content.getBoundingClientRect().top + content.scrollTop;
    content.scrollTop = Math.max(0, top - 40);
    return true;
  }

  /* ---------------------------------------------------------------
   * 查找
   * --------------------------------------------------------------- */

  function openFind() {
    if (!state.doc) {
      toast('还没有打开文档');
      return;
    }
    global.Search.open();
  }

  /* ---------------------------------------------------------------
   * 快速切换（Ctrl+P）
   * --------------------------------------------------------------- */

  function toggleQuickOpen() {
    if (global.QuickOpen.isOpen()) {
      global.QuickOpen.close();
      return;
    }
    // 查找条和快速切换都抢焦点，不能同时开着
    global.Search.reset();
    global.QuickOpen.open(state.settings);
  }

  /* ---------------------------------------------------------------
   * 主进程事件
   * --------------------------------------------------------------- */

  function subscribeIpc() {
    global.api.onOpenDocument((filePath) => openDocument(filePath));

    global.api.onFileChanged((changedPath) => {
      if (!state.doc || state.doc.path !== changedPath) return;

      // 正在编辑时绝不能自动重载 —— 那会把用户没保存的内容直接冲掉。
      // 只提醒一声，怎么处理交给用户（保存会因 mtime 对不上而被拒绝）。
      if (global.Editor.isOn()) {
        toast('这份文件在外部被修改了。你正在编辑，保存前请先处理冲突。', 6000);
        return;
      }

      reloadDocument();
      toast('文档已更新');
    });

    global.api.onCommand((command, payload) => {
      switch (command) {
        case 'toggle-mode':
          patchSettings(global.Theme.toggleMode());
          break;
        case 'toggle-sidebar':
          toggleSidebar();
          break;
        case 'toggle-outline':
          toggleOutline();
          break;
        case 'font-size':
          changeFontSize(payload);
          break;
        case 'content-width':
          changeContentWidth(payload);
          break;
        case 'reload-doc':
          reloadDocument();
          break;
        case 'toggle-line-numbers':
          toggleLineNumbers();
          break;
        case 'toggle-editor':
          toggleEditor();
          break;
        case 'save-doc':
          if (global.Editor.isOn()) global.Editor.saveAndClose();
          break;
        case 'find':
          openFind();
          break;
        case 'quick-open':
          toggleQuickOpen();
          break;
        case 'tab-next':
          global.Tabs.next();
          break;
        case 'tab-prev':
          global.Tabs.prev();
          break;
        case 'tab-close':
          global.Tabs.close();
          break;
        case 'tab-close-others':
          global.Tabs.closeOthers();
          break;
        case 'tab-close-all':
          global.Tabs.closeAll();
          break;
        case 'find-next':
          if (global.Search.isOpen()) global.Search.next();
          else openFind();
          break;
        case 'find-prev':
          if (global.Search.isOpen()) global.Search.prev();
          else openFind();
          break;
        default:
          break;
      }
    });
  }

  /** 主题或亮暗模式变化后的收尾工作 */
  function onThemeChange(mode) {
    document.body.classList.toggle('dark-mode', mode === 'dark');

    const write = $('write');
    if (write && write.querySelector('.md-mermaid')) {
      global.MermaidRender.rerender(write, mode).then(() => {
        relayout();
        global.Search.refresh();
      });
    }
    setTimeout(() => {
      relayout();
      syncCodeTheme();
    }, 150);
  }

  /* ---------------------------------------------------------------
   * 启动
   * --------------------------------------------------------------- */

  async function boot() {
    state.settings = await global.api.getSettings();
    const themes = await global.api.listThemes();

    global.Theme.init(state.settings, themes, onThemeChange);

    // 文件树单击 = 预览标签（斜体，会被下一次单击顶掉），跟 VSCode 一致
    global.FileTree.init((filePath) => openDocument(filePath, { preview: true }));

    global.Tabs.init({
      onOpen: loadDocument,
      onChange: patchSettings,
      onEmpty: showWelcome,
      // 编辑模式下换文档：先让编辑器把未保存的改动问清楚，用户选择留下就整个取消
      canLeave: (opts) =>
        !global.Editor.isOn() || !!opts.fromEditor || global.Editor.close()
    });
    global.QuickOpen.attach((filePath) => openDocument(filePath));
    global.Outline.attach();
    global.Search.attach();
    global.LineNumbers.attach();
    global.Editor.attach(onEditorExit);

    applyPanes();
    applyTypography();
    global.LineNumbers.apply(state.settings.showLineNumbers);
    renderRecent();

    if (state.settings.workspace) global.FileTree.setRoot(state.settings.workspace);
    else global.FileTree.showEmpty();

    bindUI();
    bindDocumentInteractions();
    bindDragDrop();
    subscribeIpc();

    // 监听挂好之后才去领启动参数里的文档。
    // 反过来（等主进程推送）会有竞态：ready-to-show 可能早于这里，消息就丢了。
    const pending = await global.api.getPendingDocument();

    if (pending) {
      // 双击文件启动：上次的标签照样恢复出来，但不去加载它们 ——
      // 用户要看的是刚双击的这个，先渲染别的纯属浪费
      await global.Tabs.restore(state.settings.openTabs, state.settings.activeTab, true);
      openDocument(pending);
    } else {
      await global.Tabs.restore(state.settings.openTabs, state.settings.activeTab);
    }
  }

  global.App = {
    openDocument,
    openFile,
    openFolder,
    reloadDocument,
    openFind,
    toggleQuickOpen,
    toast
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
