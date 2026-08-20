/**
 * 文件树侧栏
 *
 * 采用懒展开：点开哪个目录才去读哪个目录的内容。
 * 这样即使把一个几万个文件的知识库根目录设成工作区，也不会卡住。
 */

(function (global) {
  'use strict';

  const treeEl = () => document.getElementById('filetree');
  const nameEl = () => document.getElementById('workspace-name');

  const state = {
    root: null,
    expanded: new Set(),   // 已展开的目录路径（刷新后据此恢复）
    activePath: null,
    onOpenFile: null
  };

  const basename = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();

  function showEmpty() {
    treeEl().innerHTML =
      '<div class="pane-empty">还没有打开文件夹<br><button class="link-btn" id="btn-pick-folder">选择一个文件夹</button></div>';
    const btn = document.getElementById('btn-pick-folder');
    if (btn) btn.addEventListener('click', () => global.App && global.App.openFolder());
    nameEl().textContent = '未打开文件夹';
    nameEl().title = '';
  }

  /** 建一行（目录或文件） */
  function makeRow(item, depth) {
    const node = document.createElement('div');
    node.className = `tree-node tree-${item.type}`;
    node.dataset.path = item.path;

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = `${6 + depth * 13}px`;
    row.title = item.path;

    const arrow = document.createElement('span');
    arrow.className = 'tree-arrow';
    arrow.textContent = item.type === 'dir' ? '▸' : '';

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = item.type === 'file' ? item.name.replace(/\.[^.]+$/, '') : item.name;

    row.appendChild(arrow);
    row.appendChild(name);
    node.appendChild(row);

    if (item.type === 'dir') {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.hidden = true;
      node.appendChild(children);

      row.addEventListener('click', () => toggleDir(item.path, node, depth));

      // 恢复上次的展开状态
      if (state.expanded.has(item.path)) {
        // 异步展开，不阻塞当前这一层的渲染
        setTimeout(() => expandDir(item.path, node, depth), 0);
      }
    } else {
      row.addEventListener('click', () => {
        if (state.onOpenFile) state.onOpenFile(item.path);
      });
      if (state.activePath && item.path.toLowerCase() === state.activePath.toLowerCase()) {
        row.classList.add('active');
      }
    }

    return node;
  }

  async function expandDir(dirPath, node, depth) {
    const children = node.querySelector(':scope > .tree-children');
    const arrow = node.querySelector(':scope > .tree-row > .tree-arrow');
    if (!children) return;

    state.expanded.add(dirPath);
    arrow.textContent = '▾';
    children.hidden = false;

    if (children.dataset.loaded === '1') return;

    const result = await global.api.listDir(dirPath);
    children.innerHTML = '';

    if (result.error) {
      const err = document.createElement('div');
      err.className = 'tree-error';
      err.style.paddingLeft = `${19 + depth * 13}px`;
      err.textContent = '无法读取：' + result.error;
      children.appendChild(err);
    } else if (!result.items.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.style.paddingLeft = `${19 + depth * 13}px`;
      empty.textContent = '（空）';
      children.appendChild(empty);
    } else {
      for (const item of result.items) {
        children.appendChild(makeRow(item, depth + 1));
      }
    }

    children.dataset.loaded = '1';
  }

  function collapseDir(dirPath, node) {
    const children = node.querySelector(':scope > .tree-children');
    const arrow = node.querySelector(':scope > .tree-row > .tree-arrow');
    state.expanded.delete(dirPath);
    if (children) children.hidden = true;
    if (arrow) arrow.textContent = '▸';
  }

  function toggleDir(dirPath, node, depth) {
    if (state.expanded.has(dirPath)) collapseDir(dirPath, node);
    else expandDir(dirPath, node, depth);
  }

  /** 设定工作区根目录并渲染第一层 */
  async function setRoot(dirPath) {
    state.root = dirPath || null;
    if (!state.root) {
      showEmpty();
      return;
    }

    nameEl().textContent = basename(state.root);
    nameEl().title = state.root;
    treeEl().innerHTML = '<div class="pane-empty">读取中…</div>';

    const result = await global.api.listDir(state.root);
    treeEl().innerHTML = '';

    if (result.error) {
      treeEl().innerHTML = `<div class="pane-empty">无法读取该文件夹<br><small>${result.error}</small></div>`;
      return;
    }
    if (!result.items.length) {
      treeEl().innerHTML = '<div class="pane-empty">这个文件夹里没有 Markdown 文件</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of result.items) frag.appendChild(makeRow(item, 0));
    treeEl().appendChild(frag);
  }

  /** 重新读取整棵树（展开状态会保留） */
  function refresh() {
    if (state.root) {
      // 清掉 loaded 标记，让展开的目录重新拉取
      setRoot(state.root);
    }
  }

  /** 高亮当前正在阅读的文件 */
  function setActiveFile(filePath) {
    state.activePath = filePath || null;
    treeEl().querySelectorAll('.tree-row.active').forEach((el) => el.classList.remove('active'));
    if (!filePath) return;

    const node = treeEl().querySelector(`.tree-file[data-path="${cssEscape(filePath)}"]`);
    if (node) {
      const row = node.querySelector('.tree-row');
      if (row) {
        row.classList.add('active');
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /** 属性选择器里的反斜杠和引号要转义（Windows 路径全是反斜杠） */
  function cssEscape(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  function init(onOpenFile) {
    state.onOpenFile = onOpenFile;
    const refreshBtn = document.getElementById('btn-refresh-tree');
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);
  }

  global.FileTree = { init, setRoot, refresh, setActiveFile, showEmpty, get root() { return state.root; } };
})(window);
