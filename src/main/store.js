/**
 * 极简设置持久化：userData 目录下一个 settings.json
 * 不引入 electron-store 之类的依赖 —— 需求就这么点，自己写更透明。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  themeLight: 'github.css',   // 亮色模式使用的 Typora 主题文件
  themeDark: 'night.css',     // 暗色模式使用的 Typora 主题文件
  mode: 'light',              // 'light' | 'dark'
  fontSize: 16,               // 正文字号 px
  // 段落最大宽度 px；0 = 跟随 Typora 主题自己的设计。
  // 档位表在 renderer/app.js 的 WIDTH_STEPS。刻意用固定像素而非百分比，
  // 这样开关侧栏时段落宽度不会跳动。表格/代码块的加宽是独立的 CSS 规则。
  contentWidth: 0,
  showSidebar: false,         // 左侧文件树
  showOutline: true,          // 右侧大纲
  showLineNumbers: false,     // 正文左侧的源文件行号槽（标的是每个块在 .md 里的起始行）
  workspace: null,            // 当前打开的工作区目录
  recentFiles: [],            // 最近打开的文档（最多 15 条）
  windowBounds: { width: 1200, height: 820 }
};

let cache = null;
let writeTimer = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    let raw = fs.readFileSync(settingsPath(), 'utf8');
    // 剥掉 UTF-8 BOM。我们自己写文件不会有 BOM，但用户拿记事本
    // 编辑过设置再另存为 UTF-8 就会带上，JSON.parse 会直接抛错，
    // 结果是所有设置静默丢失 —— 曾经真的踩到过。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (err) {
    // 只有「文件不存在」是正常情况，其余要说一声，否则设置丢了都不知道
    if (err.code !== 'ENOENT') {
      console.warn('[store] 设置文件读取失败，已回退到默认值:', err.message);
    }
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) {
  return load()[key];
}

function getAll() {
  return { ...load() };
}

function set(patch) {
  cache = { ...load(), ...patch };
  // 防抖落盘，避免拖动窗口/滚动时疯狂写文件
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 400);
  return cache;
}

function flush() {
  clearTimeout(writeTimer);
  if (!cache) return;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[store] 设置保存失败:', err.message);
  }
}

/** 把一个文件推到最近列表顶部 */
function pushRecent(filePath) {
  const list = (get('recentFiles') || []).filter((p) => p.toLowerCase() !== filePath.toLowerCase());
  list.unshift(filePath);
  set({ recentFiles: list.slice(0, 15) });
}

module.exports = { DEFAULTS, get, getAll, set, flush, pushRecent };
