/**
 * preload：渲染进程与主进程之间唯一的通道
 *
 * 保持 sandbox: true + contextIsolation: true，这里只用到 electron 自带的
 * contextBridge / ipcRenderer，不 require 任何第三方模块。
 * 渲染进程拿不到 Node API —— 打开一份来源不明的 .md 也没法碰到文件系统。
 */

'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 包一层，只把 event 之后的参数交给回调，避免把 IpcRendererEvent 泄漏到页面 */
const on = (channel, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  /* ---- 主动调用（渲染进程 → 主进程） ---- */
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:open-folder'),

  /**
   * 领取启动参数里要打开的文档（双击 .md 的场景）。
   * 必须在渲染进程初始化完成后调用一次 —— 靠主进程推送会有竞态。
   */
  getPendingDocument: () => ipcRenderer.invoke('doc:get-pending'),

  /** 读取并渲染一份文档 → { path, name, html, outline, hasMermaid } */
  loadFile: (filePath) => ipcRenderer.invoke('file:load', filePath),
  /** 列出目录的一层内容（文件树懒展开用） */
  listDir: (dirPath) => ipcRenderer.invoke('file:list-dir', dirPath),

  /**
   * 递归索引整个工作区，给快速切换面板（Ctrl+P）用。
   * 主进程侧带缓存，可以放心多次调用；force 为 true 时强制重扫。
   */
  scanWorkspace: (root, force) => ipcRenderer.invoke('workspace:scan', { root, force }),

  /** 编辑模式：取出整篇 Markdown 原文 / 把改动整篇写回 */
  readSource: (filePath) => ipcRenderer.invoke('doc:read-source', filePath),
  writeSource: (payload) => ipcRenderer.invoke('doc:write-source', payload),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /** 扫描 themes/ 目录，返回可用的 Typora 主题文件列表 */
  listThemes: () => ipcRenderer.invoke('theme:list'),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  revealInExplorer: (filePath) => ipcRenderer.invoke('shell:reveal', filePath),

  /**
   * 用 Visual Studio 2022 打开源码并跳到指定行。
   * 给文档里 [L550](Setsuna/SkillData.cs#L550) 这类链接用。
   */
  openInVisualStudio: (filePath, line) =>
    ipcRenderer.invoke('code:open-in-vs', filePath, line),

  /**
   * 拖放进来的 File 对象 → 真实磁盘路径。
   * Electron 32 起 File.path 被移除，必须走 webUtils 这条路。
   */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /* ---- 被动接收（主进程 → 渲染进程） ---- */

  /** 主进程要求打开某文档：双击关联文件、菜单打开、拖入窗口等 */
  onOpenDocument: (cb) => on('doc:open', cb),
  /** 磁盘上的当前文档被外部修改了 */
  onFileChanged: (cb) => on('doc:changed', cb),
  /** 菜单/快捷键触发的界面命令 */
  onCommand: (cb) => on('ui:command', cb)
});
