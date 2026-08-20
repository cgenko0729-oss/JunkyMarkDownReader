/**
 * 源码编辑模式（Ctrl+E）
 *
 * 整篇文档切换成原始 Markdown，用一个原生 <textarea> 编辑，Ctrl+S 手动保存。
 *
 * 为什么是原生 textarea 而不是 CodeMirror/Monaco：
 *   阅读才是这个应用的主场，编辑是偶尔用一下。原生控件新增依赖 0 字节、
 *   启动开销 0，而且中文输入法的组字行为绝对不会出问题 —— 套一层 JS 编辑器
 *   反而要重新面对 IME 这一堆坑。代价是没有语法着色。
 *
 * 唯一的技术麻烦是行号：textarea 开着软换行，一个长段落会占好几个视觉行，
 * 行号不能简单地「一行一个」堆下去。解法是维护一个样式完全相同的隐藏镜像 div，
 * 每个源码行一个子元素，量出它们的 offsetTop 就是该行在 textarea 里的真实位置。
 * 这个测量是 O(行数) 的，所以只在「进入编辑模式 / 改变尺寸 / 打字停顿」时做，
 * 不是每次按键都做。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 打字停顿多久之后才重排行号。太短会白费力气，太长会看出行号在追赶。 */
  const RENUMBER_DELAY = 300;

  const state = {
    on: false,
    path: null,        // 正在编辑哪个文件
    baseMtime: 0,      // 进入编辑时文件的 mtime，保存前用它做冲突检查
    original: '',      // 进入编辑时的原文，用来判断有没有改动
    renumberTimer: null,
    bound: false,
    onExit: null       // 退出编辑模式后的回调（由 app.js 传入，负责重新渲染）
  };

  const isOn = () => state.on;
  const isDirty = () => state.on && $('editor-input').value !== state.original;

  /* ---------------------------------------------------------------
   * 进入 / 退出
   * --------------------------------------------------------------- */

  /**
   * @param {string} filePath 当前文档
   * @param {number} [caretLine] 想让光标落在第几行（1 基），用来接住阅读位置
   */
  async function open(filePath, caretLine) {
    if (state.on || !filePath) return;

    const result = await global.api.readSource(filePath);
    if (!result || result.error) {
      global.App.toast('无法进入编辑模式：' + ((result && result.error) || '未知错误'));
      return;
    }

    state.on = true;
    state.path = filePath;
    state.baseMtime = result.mtime;
    state.original = result.text;

    const input = $('editor-input');
    input.value = result.text;

    $('content').hidden = true;
    $('editor').hidden = false;
    document.body.classList.add('editing');

    renumber();
    updateStatus();

    input.focus();
    // 落到刚才在读的那一段，省得在几千行里重新找
    if (caretLine > 0) caretToLine(caretLine);
    else input.setSelectionRange(0, 0);
  }

  /**
   * 退出编辑模式。
   * @param {boolean} [force] 跳过未保存确认（保存成功后自己调用时用）
   * @returns {boolean} 是否真的退出了
   */
  function close(force) {
    if (!state.on) return true;

    if (!force && isDirty()) {
      if (!global.confirm('有未保存的修改，确定要放弃吗？')) return false;
    }

    // 光标在第几行要在拆状态之前取：退出后靠它把阅读位置落回刚编辑的地方。
    // 不这么做的话，编辑期间 .content 是 display:none，滚动位置会被浏览器
    // 清零，退出编辑就直接跳回文档开头。
    const line = caretLine();

    state.on = false;
    state.path = null;
    state.original = '';
    clearTimeout(state.renumberTimer);

    $('editor').hidden = true;
    $('content').hidden = false;
    document.body.classList.remove('editing');

    if (state.onExit) state.onExit(line);
    return true;
  }

  /* ---------------------------------------------------------------
   * 保存
   * --------------------------------------------------------------- */

  async function save(options = {}) {
    if (!state.on) return false;

    const input = $('editor-input');
    const text = input.value;

    if (text === state.original) {
      if (!options.silent) global.App.toast('没有需要保存的修改');
      return true;
    }

    const result = await global.api.writeSource({
      filePath: state.path,
      text,
      baseMtime: state.baseMtime
    });

    if (!result || result.error) {
      global.App.toast('保存失败：' + ((result && result.error) || '未知错误'), 5000);
      return false;
    }

    state.original = text;
    state.baseMtime = result.mtime;
    updateStatus();
    global.App.toast('已保存');
    return true;
  }

  /** Ctrl+S：保存并回到阅读模式 */
  async function saveAndClose() {
    if (!state.on) return;
    if (await save({ silent: true })) close(true);
  }

  /* ---------------------------------------------------------------
   * 行号
   * --------------------------------------------------------------- */

  /**
   * 重排行号。
   *
   * 镜像 div 的字体、宽度、内边距、换行规则都与 textarea 一致（靠 CSS 保证），
   * 所以它每个子元素的 offsetTop 就等于对应源码行在 textarea 里的顶部偏移。
   */
  function renumber() {
    if (!state.on) return;

    const input = $('editor-input');
    const mirror = $('editor-mirror');
    const inner = $('editor-gutter-inner');
    if (!input || !mirror || !inner) return;

    // 镜像必须和 textarea 的**内容宽度**一样宽，换行位置才会一致。
    // mirror 自身 padding 为 0（见 shell.css），这里把 textarea 的内边距扣掉。
    const style = getComputedStyle(input);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    mirror.style.width = Math.max(0, input.clientWidth - padLeft - padRight) + 'px';

    const lines = input.value.split('\n');

    const rows = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement('div');
      // 空行也要占一个行高，否则后面所有行的偏移都会往上错
      row.textContent = line || ' ';
      rows.appendChild(row);
    }
    mirror.replaceChildren(rows);

    // 先把偏移量一次读完，再统一写 DOM —— 读写交替会反复触发强制重排。
    // offsetTop 是从 mirror 的内边距边缘算起的，textarea 那边还有 padding-top，
    // 要补回来才对得上。
    const children = mirror.children;
    const tops = new Array(children.length);
    for (let i = 0; i < children.length; i++) tops[i] = children[i].offsetTop + padTop;

    const numbers = document.createDocumentFragment();
    for (let i = 0; i < tops.length; i++) {
      const el = document.createElement('span');
      el.className = 'editor-linenum';
      el.style.top = tops[i] + 'px';
      el.textContent = String(i + 1);
      numbers.appendChild(el);
    }
    inner.replaceChildren(numbers);

    syncScroll();
  }

  function scheduleRenumber() {
    clearTimeout(state.renumberTimer);
    state.renumberTimer = setTimeout(renumber, RENUMBER_DELAY);
  }

  /** 行号槽跟着 textarea 一起滚 */
  function syncScroll() {
    const input = $('editor-input');
    const inner = $('editor-gutter-inner');
    if (input && inner) inner.style.transform = `translateY(${-input.scrollTop}px)`;
  }

  /* ---------------------------------------------------------------
   * 光标定位
   * --------------------------------------------------------------- */

  /** 把光标放到第 line 行（1 基）行首，并滚到可见处 */
  function caretToLine(line) {
    const input = $('editor-input');
    const lines = input.value.split('\n');
    const target = Math.min(Math.max(1, line), lines.length);

    let offset = 0;
    for (let i = 0; i < target - 1; i++) offset += lines[i].length + 1;

    input.setSelectionRange(offset, offset);

    // textarea 不会自动把光标滚进视野，用镜像量出该行的位置自己滚。
    // 镜像的行数与源码行数一一对应，所以可以直接按下标取。
    const mirror = $('editor-mirror');
    const row = mirror && mirror.children[target - 1];
    if (row) input.scrollTop = Math.max(0, row.offsetTop - input.clientHeight / 3);
    syncScroll();
  }

  /** 光标当前在第几行（1 基） */
  function caretLine() {
    const input = $('editor-input');
    return input.value.slice(0, input.selectionStart).split('\n').length;
  }

  /* ---------------------------------------------------------------
   * 状态条
   * --------------------------------------------------------------- */

  function updateStatus() {
    const status = $('editor-status');
    if (!status) return;
    const dirty = isDirty();
    status.textContent = dirty ? '未保存' : '已保存';
    status.classList.toggle('dirty', dirty);
  }

  /* ---------------------------------------------------------------
   * 绑定
   * --------------------------------------------------------------- */

  function attach(onExit) {
    state.onExit = onExit;
    if (state.bound) return;
    state.bound = true;

    const input = $('editor-input');
    if (!input) return;

    input.addEventListener('input', () => {
      scheduleRenumber();
      updateStatus();
    });

    input.addEventListener('scroll', syncScroll, { passive: true });

    input.addEventListener('keydown', (event) => {
      // Tab 应该插入缩进，而不是把焦点跳走
      if (event.key === 'Tab') {
        event.preventDefault();
        insertAtCursor(input, '  ');
        scheduleRenumber();
        updateStatus();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    $('editor-save').addEventListener('click', () => save());
    $('editor-done').addEventListener('click', saveAndClose);
    $('editor-cancel').addEventListener('click', () => close());

    // 换字号或改窗口大小都会让换行位置变，行号要重排
    window.addEventListener('resize', () => { if (state.on) renumber(); });
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.setRangeText(text, start, end, 'end');
  }

  global.Editor = {
    attach,
    open,
    close,
    save,
    saveAndClose,
    renumber,
    isOn,
    isDirty,
    caretLine
  };
})(window);
