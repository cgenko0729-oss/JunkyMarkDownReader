/**
 * 应用主进程入口
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');

const protocols = require('./protocols');
const store = require('./store');
const files = require('./file-service');
const markdown = require('./markdown');
const plaintext = require('./plaintext');
const codeEditor = require('./code-editor');

const APP_ROOT = app.getAppPath();
const THEMES_DIR = path.join(APP_ROOT, 'themes');

/** 协议特权必须在 ready 之前声明 */
protocols.registerSchemes();

let mainWindow = null;
/** 启动参数里带的文件（双击 .md / .txt 打开的场景），等渲染进程来取 */
let pendingOpenPath = null;
/**
 * 渲染进程是否已经完成初始化并挂好了 IPC 监听。
 *
 * 这个标志是必需的：渲染进程的 boot() 里要 await 两次 IPC 才轮到注册监听，
 * 而窗口的 ready-to-show 可能早于那之前就触发。若此时直接 send('doc:open')，
 * 消息会静默丢失 —— 表现为双击 .md 启动后窗口空着。
 * 所以启动路径改为「渲染进程主动来取」，运行时路径才用推送。
 */
let rendererReady = false;
/** 当前正在显示的文档路径，供文件监听和菜单判断用 */
let currentDocPath = null;

/* ---------------------------------------------------------------
 * 启动参数解析
 * --------------------------------------------------------------- */

/**
 * 从命令行参数里挑出要打开的文件（.md 系列或 .txt）。
 * 打包后双击 .md：argv = [app.exe, C:\path\to\file.md]
 * 开发时 electron .：argv = [electron.exe, ., ...]
 */
function documentFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    try {
      const abs = path.resolve(arg);
      if (files.isSupportedFile(abs) && fs.statSync(abs).isFile()) return abs;
    } catch { /* 不是有效路径，跳过 */ }
  }
  return null;
}

/* ---------------------------------------------------------------
 * 单实例：双击第二个 .md 文件时，交给已经开着的窗口，而不是再开一个进程
 * --------------------------------------------------------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const target = documentFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (target) sendOpenDocument(target);
    }
  });
}

/* ---------------------------------------------------------------
 * 窗口
 * --------------------------------------------------------------- */

function createWindow() {
  const bounds = store.get('windowBounds') || {};

  mainWindow = new BrowserWindow({
    width: bounds.width || 1200,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 560,
    minHeight: 420,
    show: false,
    backgroundColor: store.get('mode') === 'dark' ? '#1e1e1e' : '#ffffff',
    title: 'Junky Markdown Reader',
    icon: path.join(APP_ROOT, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // 开发期把渲染进程的 console 转发到终端，否则界面里的报错在命令行看不见
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (...args) => {
      // Electron 35 起这个事件的签名换成了单个 event 对象，两种都兼容
      if (args.length && typeof args[0] === 'object' && 'message' in args[0]) {
        const e = args[0];
        console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
      } else {
        const [, level, message, line, sourceId] = args;
        console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
      }
    });
  }

  mainWindow.loadURL(protocols.appUrl('src/renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 这里刻意不推送 pendingOpenPath —— 渲染进程可能还没挂上监听。
    // 它会在 boot() 结束时通过 doc:get-pending 主动来取。
  });

  mainWindow.on('closed', () => {
    rendererReady = false;
  });

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (mainWindow.isMaximized()) return; // 别把最大化后的尺寸记成常规尺寸
    store.set({ windowBounds: mainWindow.getBounds() });
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
    files.unwatchFile();
  });

  // 文档里的外部链接一律交给系统浏览器，不在应用内开窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 禁止页面自身被导航走（除了我们自己的 app:// 界面）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${protocols.APP_SCHEME}://${protocols.APP_HOST}/`)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

/**
 * 通知渲染进程显示某文档。
 * 渲染进程还没就绪时先存起来，等它自己来取（见 rendererReady 的说明）。
 */
function sendOpenDocument(filePath) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    pendingOpenPath = filePath;
    return;
  }
  mainWindow.webContents.send('doc:open', filePath);
}

/** 磁盘上的当前文档被改动了，通知渲染进程重新加载 */
function notifyDocChanged(changedPath) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('doc:changed', changedPath);
  }
}

/** 给渲染进程发一条界面命令（菜单/快捷键触发） */
function sendCommand(command, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ui:command', command, payload);
  }
}

/* ---------------------------------------------------------------
 * 菜单
 * --------------------------------------------------------------- */

function buildMenu() {
  const recent = store.get('recentFiles') || [];

  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => pickFile() },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => pickFolder() },
        { type: 'separator' },
        {
          label: '最近打开',
          submenu: recent.length
            ? [
                ...recent.map((p) => ({
                  label: path.basename(p),
                  sublabel: p,
                  click: () => sendOpenDocument(p)
                })),
                { type: 'separator' },
                { label: '清除记录', click: () => { store.set({ recentFiles: [] }); buildMenu(); } }
              ]
            : [{ label: '（空）', enabled: false }]
        },
        { type: 'separator' },
        {
          label: '在资源管理器中显示',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => { if (currentDocPath) shell.showItemInFolder(currentDocPath); }
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { label: '源码编辑模式', accelerator: 'CmdOrCtrl+E', click: () => sendCommand('toggle-editor') },
        { label: '保存并返回阅读', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save-doc') }
      ]
    },
    {
      label: '标签页(&T)',
      submenu: [
        { label: '快速切换…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('quick-open') },
        { type: 'separator' },
        { label: '下一个标签页', accelerator: 'CmdOrCtrl+Tab', click: () => sendCommand('tab-next') },
        { label: '上一个标签页', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => sendCommand('tab-prev') },
        { type: 'separator' },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('tab-close') },
        { label: '关闭其他标签页', click: () => sendCommand('tab-close-others') },
        { label: '关闭全部标签页', accelerator: 'CmdOrCtrl+Shift+W', click: () => sendCommand('tab-close-all') }
      ]
    },
    {
      label: '查找(&S)',
      submenu: [
        { label: '在文档中查找…', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
        { label: '查找下一个', accelerator: 'F3', click: () => sendCommand('find-next') },
        { label: '查找上一个', accelerator: 'Shift+F3', click: () => sendCommand('find-prev') }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '切换亮/暗模式', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendCommand('toggle-mode') },
        { type: 'separator' },
        { label: '文件树侧栏', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('toggle-sidebar') },
        { label: '大纲侧栏', accelerator: 'CmdOrCtrl+R', click: () => sendCommand('toggle-outline') },
        {
          label: '显示行号',
          type: 'checkbox',
          // 勾选状态从设置里取。渲染进程翻转设置后 Electron 自己也会翻转勾选，
          // 两边保持一致；下次重建菜单时再从 store 重新读一遍对齐。
          checked: !!store.get('showLineNumbers'),
          click: () => sendCommand('toggle-line-numbers')
        },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+Plus', click: () => sendCommand('font-size', 1) },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: () => sendCommand('font-size', -1) },
        { label: '重置字号', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('font-size', 0) },
        { type: 'separator' },
        {
          label: '段落变宽',
          accelerator: 'CmdOrCtrl+Shift+Right',
          click: () => sendCommand('content-width', 1)
        },
        {
          label: '段落变窄',
          accelerator: 'CmdOrCtrl+Shift+Left',
          click: () => sendCommand('content-width', -1)
        },
        {
          label: '段落宽度跟随主题',
          accelerator: 'CmdOrCtrl+Shift+0',
          click: () => sendCommand('content-width', 0)
        },
        { type: 'separator' },
        { label: '重新加载文档', accelerator: 'F5', click: () => sendCommand('reload-doc') },
        { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'Junky Markdown Reader',
              detail: `版本 ${app.getVersion()}\nTypora 风格的 Markdown 阅读器\n\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}`,
              buttons: ['好']
            });
          }
        },
        {
          label: '打开主题文件夹',
          click: () => shell.openPath(THEMES_DIR)
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------------------------------------------------------
 * 打开文件 / 文件夹
 * --------------------------------------------------------------- */

async function pickFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开文档',
    properties: ['openFile'],
    filters: [
      { name: '支持的文档', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdtext', 'txt'] },
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdtext'] },
      { name: '纯文本', extensions: ['txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths[0]) {
    sendOpenDocument(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
}

async function pickFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开文件夹作为工作区',
    properties: ['openDirectory']
  });
  if (!result.canceled && result.filePaths[0]) {
    const dir = result.filePaths[0];
    protocols.allowRoot(dir);
    store.set({ workspace: dir });
    files.invalidateScanCache();
    return dir;
  }
  return null;
}

/* ---------------------------------------------------------------
 * IPC
 * --------------------------------------------------------------- */

function registerIpc() {
  ipcMain.handle('dialog:open-file', () => pickFile());
  ipcMain.handle('dialog:open-folder', () => pickFolder());

  /**
   * 渲染进程初始化完毕后调用：领取启动时要打开的文档，
   * 同时告诉主进程「监听已挂好，之后可以直接推送了」。
   */
  ipcMain.handle('doc:get-pending', () => {
    rendererReady = true;
    const target = pendingOpenPath;
    pendingOpenPath = null;
    return target;
  });

  /** 读取 + 渲染一份文档 */
  ipcMain.handle('file:load', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) {
      return { error: '无效的文件路径' };
    }
    const abs = path.resolve(filePath);

    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) return { error: '不是一个文件' };

      const source = await files.readTextFile(abs);

      // 文档所在目录加入白名单，其中的图片才能通过 md-asset 加载
      protocols.allowRoot(path.dirname(abs));

      // .txt 走纯文本渲染器：不解析任何 Markdown 语法（见 main/plaintext.js）
      const kind = files.docKind(abs);
      const rendered = kind === 'text'
        ? plaintext.render(source)
        : markdown.render(source, abs);
      const { html, outline, hasMermaid } = rendered;

      currentDocPath = abs;
      store.pushRecent(abs);
      buildMenu();

      // 监听这份文件，外部编辑器改动后自动刷新
      files.watchFile(abs, notifyDocChanged);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle(`${path.basename(abs)} — Junky Markdown Reader`);
      }

      return {
        path: abs,
        name: path.basename(abs),
        dir: path.dirname(abs),
        kind,                      // 'markdown' | 'text'
        html,
        outline,
        hasMermaid,
        // 纯文本超大文件会退化成单块（失去逐行行号），渲染进程据此提示用户
        degraded: !!rendered.degraded,
        size: stat.size,
        mtime: stat.mtimeMs
      };
    } catch (err) {
      return { error: err.message, path: abs };
    }
  });

  /* ---- 源码编辑模式 ----
   *
   * 只允许改「当前打开的这一份文档」。应用在此之前从不写任何 .md 文件，
   * 加了写入能力就必须把它钉死在这一个路径上 —— 渲染进程即使被文档里的
   * 脚本攻陷（CSP + DOMPurify 之外的万一），也只能碰到用户正看着的这份文件。
   */

  /** 取出整篇 Markdown 原文，交给编辑模式的 textarea 显示 */
  ipcMain.handle('doc:read-source', async (_event, filePath) => {
    const abs = path.resolve(String(filePath || ''));
    if (!currentDocPath || abs !== currentDocPath) {
      return { error: '只能编辑当前打开的文档' };
    }

    try {
      // readTextFileForEdit 保证 text 里的换行已经是 LF，直接交给 textarea
      const { text } = await files.readTextFileForEdit(abs);
      const stat = await fs.promises.stat(abs);
      return { text, mtime: stat.mtimeMs };
    } catch (err) {
      return { error: err.message };
    }
  });

  /** 把编辑结果整篇写回 */
  ipcMain.handle('doc:write-source', async (_event, payload) => {
    const { filePath, text, baseMtime } = payload || {};
    const abs = path.resolve(String(filePath || ''));

    if (!currentDocPath || abs !== currentDocPath) {
      return { error: '只能编辑当前打开的文档' };
    }
    if (typeof text !== 'string') {
      return { error: '无效的内容' };
    }

    try {
      // 乐观并发：进入编辑模式之后文件又被外部改过，就不能盲写 ——
      // 那会把别人的改动整篇覆盖掉。宁可让用户重新加载再改一次。
      const stat = await fs.promises.stat(abs);
      if (typeof baseMtime === 'number' && Math.abs(stat.mtimeMs - baseMtime) > 1) {
        return { error: '文件在外部被修改过，已取消保存。请按 F5 重新加载后再改。' };
      }

      // 写盘期间关掉监听：rename 会让 chokidar 认为文件被替换，
      // 而且我们自己的写入不该触发「文档已更新」的自动刷新。
      files.unwatchFile();
      try {
        const mtime = await files.writeTextFile(abs, text);
        return { ok: true, mtime };
      } finally {
        files.watchFile(abs, notifyDocChanged);
      }
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('file:list-dir', async (_event, dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return { error: '无效的目录', items: [] };
    const abs = path.resolve(dirPath);
    protocols.allowRoot(abs);
    return files.listDirectory(abs);
  });

  /**
   * 递归索引工作区里所有能打开的文档，给快速切换面板（Ctrl+P）用。
   * 结果在 file-service 里带缓存，渲染进程可以放心多次调用。
   */
  ipcMain.handle('workspace:scan', async (_event, payload) => {
    const { root, force } = payload || {};
    const dir = root || store.get('workspace');
    if (!dir) return { items: [], truncated: false, root: null };
    try {
      return await files.scanWorkspace(dir, !!force);
    } catch (err) {
      return { items: [], truncated: false, root: dir, error: err.message };
    }
  });

  ipcMain.handle('settings:get', () => store.getAll());

  ipcMain.handle('settings:set', (_event, patch) => {
    if (patch && typeof patch === 'object') store.set(patch);
    return store.getAll();
  });

  /** 扫描 themes/ 目录，列出可用的 Typora 主题 */
  ipcMain.handle('theme:list', async () => {
    try {
      const entries = await fs.promises.readdir(THEMES_DIR, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.css'))
        .map((e) => ({
          file: e.name,
          name: path.basename(e.name, path.extname(e.name)),
          url: protocols.appUrl(`themes/${e.name}`)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  });

  ipcMain.handle('shell:open-external', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url);
    }
    return false;
  });

  ipcMain.handle('shell:reveal', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(path.resolve(filePath));
  });

  /** 文档里的 .cs 链接 → 用 Visual Studio 2022 打开并跳到该行 */
  ipcMain.handle('code:open-in-vs', (_event, filePath, line) =>
    codeEditor.openInVisualStudio(filePath, line));
}

/* ---------------------------------------------------------------
 * 生命周期
 * --------------------------------------------------------------- */

pendingOpenPath = documentFromArgv(process.argv);

// macOS：通过「用此程序打开」传进来的文件（只做 Windows，但留着无害）
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) sendOpenDocument(filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(() => {
  protocols.registerHandlers(APP_ROOT);

  // themes 目录与上次的工作区先放进白名单
  protocols.allowRoot(THEMES_DIR);
  protocols.allowRoot(store.get('workspace'));

  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  store.flush();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  store.flush();
  files.unwatchFile();
});
