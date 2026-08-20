/**
 * 快速切换面板（Ctrl+P）
 *
 * 三个来源合成一份候选清单，按这个优先级去重：
 *   1. 已经开着的标签    —— 最可能想切过去的
 *   2. 最近打开          —— 关掉了但还在手边的
 *   3. 整个工作区        —— 主进程递归扫出来的索引
 *
 * 工作区索引是**懒加载**的：第一次按 Ctrl+P 才去扫，扫的过程中面板照常可用，
 * 只是先只有前两个来源，扫完自动补进来。大目录第一次会慢，所以主进程侧
 * 带了缓存（见 main/file-service.js 的 scanWorkspace）。
 */

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /** 列表最多显示多少条。再多用户也不会往下翻，只会继续打字 */
  const MAX_ROWS = 60;

  const state = {
    open: false,
    items: [],           // 当前的候选全集
    filtered: [],        // 过滤后的结果
    cursor: 0,
    index: null,         // 工作区索引 { root, items }
    scanning: false,
    onPick: null
  };

  const lower = (s) => String(s || '').toLowerCase();
  const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

  /* ---------------------------------------------------------------
   * 模糊匹配
   *
   * 子序列匹配 + 加权：连续命中、词首命中（路径分隔符/下划线之后）都加分，
   * 目标越短分越高。够用且零依赖 —— 文档数量级在几千，不需要真正的 fzf。
   * --------------------------------------------------------------- */

  function fuzzy(query, text) {
    const q = lower(query);
    const t = lower(text);
    if (!q) return { score: 0, positions: [] };

    const positions = [];
    let qi = 0;
    let score = 0;
    let streak = 0;

    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] !== q[qi]) { streak = 0; continue; }

      let bonus = 0;
      if (ti === 0) bonus += 8;
      else if (/[\s\-_.\/\\]/.test(t[ti - 1])) bonus += 6;   // 词首

      streak++;
      bonus += Math.min(streak, 6) * 3;                       // 连续命中

      score += 10 + bonus;
      positions.push(ti);
      qi++;
    }

    if (qi < q.length) return null;   // 有字符没匹配上 = 不算命中

    /*
     * 紧凑度惩罚：命中的字符横跨了多长一段。
     *
     * 少了这一条，排序会明显不合直觉 —— 实测查 "sam" 时
     * FuwaFuwaSurvivor_AddFeatureGuide.md（s 在 survivor、a 在 addfeature、
     * m 在 .md，散在 26 个字符里）会压过 sample/示例文档.md（sam 连着命中）。
     * 逐字符的连续加分不足以拉开差距，因为它只看相邻两个字符，看不到整体跨度。
     */
    const span = positions[positions.length - 1] - positions[0] + 1;
    score -= (span - q.length) * 2;

    // 同样命中的情况下，短的目标更可能是想要的那个
    score -= Math.min(t.length, 80) * 0.2;
    return { score, positions };
  }

  /* ---------------------------------------------------------------
   * 候选清单
   * --------------------------------------------------------------- */

  /** 把三个来源合成一份去重后的清单（先来的优先级高） */
  function buildItems(settings) {
    const seen = new Set();
    const items = [];

    const push = (path, source, rel) => {
      const key = lower(path);
      if (!path || seen.has(key)) return;
      seen.add(key);
      items.push({
        path,
        name: basename(path),
        rel: rel || path,
        source,                                  // 'tab' | 'recent' | 'workspace'
        kind: /\.txt$/i.test(path) ? 'text' : 'markdown'
      });
    };

    for (const tab of global.Tabs.list()) push(tab.path, 'tab');
    for (const p of (settings.recentFiles || [])) push(p, 'recent');

    if (state.index && state.index.items) {
      for (const it of state.index.items) push(it.path, 'workspace', it.rel);
    }

    return items;
  }

  /** 后台去扫工作区，扫完把结果并进清单并重绘 */
  async function ensureIndex(settings) {
    const root = settings.workspace;
    if (!root) return;
    if (state.scanning) return;
    if (state.index && lower(state.index.root) === lower(root)) return;

    state.scanning = true;
    updateHint();

    try {
      const result = await global.api.scanWorkspace(root);
      state.index = { root: result.root || root, items: result.items || [], truncated: !!result.truncated };
    } catch {
      state.index = { root, items: [], truncated: false };
    } finally {
      state.scanning = false;
      if (state.open) {
        state.items = buildItems(state.settings);
        applyFilter($('quickopen-input').value);
      }
      updateHint();
    }
  }

  /** 工作区换了或者用户刷新了文件树，索引作废 */
  function invalidate() {
    state.index = null;
  }

  /* ---------------------------------------------------------------
   * 过滤与渲染
   * --------------------------------------------------------------- */

  function applyFilter(query) {
    const q = String(query || '').trim();

    if (!q) {
      // 没输入时按来源排：打开中的 → 最近的 → 工作区
      const rank = { tab: 0, recent: 1, workspace: 2 };
      state.filtered = state.items
        .slice()
        .sort((a, b) => rank[a.source] - rank[b.source])
        .slice(0, MAX_ROWS)
        .map((item) => ({ item, positions: [], field: 'name' }));
    } else {
      const scored = [];
      for (const item of state.items) {
        // 文件名命中比路径命中更值钱：用户打的多半是文件名
        const byName = fuzzy(q, item.name);
        const byRel = fuzzy(q, item.rel);

        let best = null;
        if (byName) best = { score: byName.score * 1.6 + 20, positions: byName.positions, field: 'name' };
        if (byRel && (!best || byRel.score > best.score)) {
          best = { score: byRel.score, positions: byRel.positions, field: 'rel' };
        }
        if (!best) continue;

        // 已经开着的标签同分时排前面
        if (item.source === 'tab') best.score += 15;
        else if (item.source === 'recent') best.score += 6;

        scored.push({ item, score: best.score, positions: best.positions, field: best.field });
      }
      scored.sort((a, b) => b.score - a.score);
      state.filtered = scored.slice(0, MAX_ROWS);
    }

    state.cursor = 0;
    renderList();
  }

  /** 把命中的字符包成 <mark>。positions 是升序的索引数组。 */
  function highlight(text, positions) {
    const frag = document.createDocumentFragment();
    if (!positions || !positions.length) {
      frag.appendChild(document.createTextNode(text));
      return frag;
    }

    const hit = new Set(positions);
    let buffer = '';
    let bufferHit = false;

    const flush = () => {
      if (!buffer) return;
      if (bufferHit) {
        const mark = document.createElement('mark');
        mark.textContent = buffer;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(buffer));
      }
      buffer = '';
    };

    for (let i = 0; i < text.length; i++) {
      const isHit = hit.has(i);
      if (isHit !== bufferHit) { flush(); bufferHit = isHit; }
      buffer += text[i];
    }
    flush();
    return frag;
  }

  const SOURCE_LABEL = { tab: '打开中', recent: '最近', workspace: '工作区' };

  function renderList() {
    const list = $('quickopen-list');
    list.replaceChildren();

    if (!state.filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'qo-empty';
      empty.textContent = state.items.length ? '没有匹配的文档' : '还没有可切换的文档';
      list.appendChild(empty);
      updateHint();
      return;
    }

    state.filtered.forEach((entry, i) => {
      const { item, positions, field } = entry;

      const row = document.createElement('div');
      row.className = 'qo-row';
      row.classList.toggle('current', i === state.cursor);
      row.dataset.index = String(i);
      row.title = item.path;

      const icon = document.createElement('span');
      icon.className = 'qo-icon' + (item.kind === 'text' ? ' qo-icon-text' : '');
      icon.textContent = item.kind === 'text' ? 'T' : 'M';

      const main = document.createElement('span');
      main.className = 'qo-main';

      const name = document.createElement('span');
      name.className = 'qo-name';
      name.appendChild(field === 'name' ? highlight(item.name, positions)
                                        : document.createTextNode(item.name));

      const path = document.createElement('span');
      path.className = 'qo-path';
      path.appendChild(field === 'rel' ? highlight(item.rel, positions)
                                       : document.createTextNode(item.rel));

      main.appendChild(name);
      main.appendChild(path);

      const badge = document.createElement('span');
      badge.className = 'qo-badge qo-badge-' + item.source;
      badge.textContent = SOURCE_LABEL[item.source] || '';

      row.appendChild(icon);
      row.appendChild(main);
      row.appendChild(badge);

      row.addEventListener('mousemove', () => setCursor(i));
      row.addEventListener('click', () => pick(i));

      list.appendChild(row);
    });

    updateHint();
  }

  function updateHint() {
    const hint = $('quickopen-hint');
    if (!hint) return;

    if (state.scanning) {
      hint.textContent = '正在索引工作区…';
      return;
    }
    if (state.index && state.index.truncated) {
      hint.textContent = `工作区文件过多，索引已截断到 ${state.index.items.length} 个`;
      return;
    }
    hint.textContent = state.filtered.length
      ? `↑↓ 选择 · Enter 打开 · Esc 关闭 · 共 ${state.filtered.length} 项`
      : '↑↓ 选择 · Enter 打开 · Esc 关闭';
  }

  /* ---------------------------------------------------------------
   * 键盘与选中
   * --------------------------------------------------------------- */

  function setCursor(i) {
    if (!state.filtered.length) return;
    const next = Math.max(0, Math.min(state.filtered.length - 1, i));
    if (next === state.cursor) return;

    const list = $('quickopen-list');
    const rows = list.querySelectorAll('.qo-row');
    if (rows[state.cursor]) rows[state.cursor].classList.remove('current');
    state.cursor = next;
    if (rows[next]) {
      rows[next].classList.add('current');
      rows[next].scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    if (!state.filtered.length) return;
    // 循环：在最后一条按 ↓ 回到第一条
    const n = state.filtered.length;
    setCursor(((state.cursor + delta) % n + n) % n);
  }

  function pick(i) {
    const entry = state.filtered[typeof i === 'number' ? i : state.cursor];
    if (!entry) return;
    close();
    // Enter 是明确的打开意图，开成固定标签而不是预览
    if (state.onPick) state.onPick(entry.item.path);
  }

  /* ---------------------------------------------------------------
   * 开 / 关
   * --------------------------------------------------------------- */

  function open(settings) {
    state.settings = settings;
    state.items = buildItems(settings);

    const panel = $('quickopen');
    const input = $('quickopen-input');

    panel.hidden = false;
    state.open = true;

    input.value = '';
    applyFilter('');
    input.focus();
    input.select();

    // 面板已经能用了，索引在后台补
    ensureIndex(settings);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    $('quickopen').hidden = true;
    $('quickopen-list').replaceChildren();
    // 焦点还回正文，否则方向键会失灵
    const content = document.getElementById('content');
    if (content && !content.hidden) content.focus({ preventScroll: true });
  }

  const isOpen = () => state.open;

  /* ---------------------------------------------------------------
   * 装配
   * --------------------------------------------------------------- */

  function attach(onPick) {
    state.onPick = onPick;

    const panel = $('quickopen');
    const input = $('quickopen-input');

    input.addEventListener('input', () => applyFilter(input.value));

    input.addEventListener('keydown', (event) => {
      switch (event.key) {
        case 'ArrowDown': event.preventDefault(); move(1); break;
        case 'ArrowUp':   event.preventDefault(); move(-1); break;
        case 'PageDown':  event.preventDefault(); move(8); break;
        case 'PageUp':    event.preventDefault(); move(-8); break;
        case 'Enter':     event.preventDefault(); pick(); break;
        case 'Escape':    event.preventDefault(); close(); break;
        default: break;
      }
    });

    // 点面板外面就关掉
    panel.addEventListener('mousedown', (event) => {
      if (event.target === panel) close();
    });
  }

  global.QuickOpen = { attach, open, close, isOpen, invalidate };
})(window);
