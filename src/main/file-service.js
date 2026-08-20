/**
 * 文件服务：读文档、列目录、监听文件变更
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext']);

/** 列目录时直接跳过的噪音目录 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  '__pycache__', 'dist', 'build', '.next', '.cache', '$RECYCLE.BIN'
]);

function isMarkdownFile(filePath) {
  return MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase());
}

/** 读取文本文件，顺手剥掉 UTF-8 BOM（否则第一个标题会渲染失败） */
async function readTextFile(filePath) {
  const buf = await fsp.readFile(filePath);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * 读文件，并把「写回时必须原样还原的东西」一并带出来。
 *
 * readTextFile 会把 BOM 剥掉且不记录 —— 读来渲染没问题，但拿它的结果写回
 * 就会把原本带 BOM 的文件悄悄改成不带 BOM。换行符同理：CRLF 的文件按 LF 写
 * 回去，改一个字会让 git 显示整个文件都变了。编辑模式必须走这个函数。
 *
 * 契约：返回的 text 里的换行**一律是 LF**（textarea 本来也只认 LF），
 * 原文件用的是哪种记在 eol 里，writeTextFile 负责还原。
 */
async function readTextFileForEdit(filePath) {
  const buf = await fsp.readFile(filePath);
  let text = buf.toString('utf8');

  const hasBom = text.charCodeAt(0) === 0xfeff;
  if (hasBom) text = text.slice(1);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  return {
    text: eol === '\r\n' ? text.split('\r\n').join('\n') : text,
    hasBom,
    eol
  };
}

/**
 * 把整篇内容写回文件，原样保留 BOM 与原有的换行符。
 *
 * 先写临时文件再改名，避免写到一半崩溃把用户的文档截断成半截。
 *
 * @returns {number} 写入后的 mtimeMs
 */
async function writeTextFile(filePath, text) {
  const { hasBom, eol } = await readTextFileForEdit(filePath);

  // textarea 交出来的换行一律是 LF，写回时换成这个文件原本用的那种。
  // BOM 用转义写：字面量的 BOM 在编辑器里是隐形的，改代码时极易误删。
  const body = String(text).split(/\r\n|\n/).join(eol);
  const out = (hasBom ? '\ufeff' : '') + body;

  const tmp = `${filePath}.jmr-tmp-${process.pid}`;
  try {
    await fsp.writeFile(tmp, out, 'utf8');
    await fsp.rename(tmp, filePath);   // Windows 上 rename 会覆盖同名文件
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }

  const stat = await fsp.stat(filePath);
  return stat.mtimeMs;
}

/**
 * 只读取目录的一层内容。文件树采用懒展开 —— 点开哪个目录才读哪个，
 * 这样即使指向一个几万个文件的知识库根目录也不会卡住。
 */
async function listDirectory(dirPath) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    return { error: err.message, items: [] };
  }

  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: full, type: 'dir' });
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      files.push({ name: entry.name, path: full, type: 'file' });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);

  return { items: [...dirs, ...files] };
}

/* ---------------------------------------------------------------
 * 文件变更监听
 *
 * 只监听「当前打开的那一个文件」。这是性价比最高的取舍：
 * 在别的编辑器里改完保存，阅读器立刻刷新；而不必为了文件树的
 * 实时性去递归监听整个知识库目录（那个开销在大目录上很难看）。
 * --------------------------------------------------------------- */

let watcher = null;
let watchedPath = null;

function watchFile(filePath, onChange) {
  unwatchFile();
  if (!filePath || !fs.existsSync(filePath)) return;

  watchedPath = filePath;
  watcher = chokidar.watch(filePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  });

  watcher.on('change', () => onChange(filePath));
  watcher.on('error', (err) => console.warn('[watch] ', err.message));
}

function unwatchFile() {
  if (watcher) {
    watcher.close().catch(() => {});
    watcher = null;
    watchedPath = null;
  }
}

module.exports = {
  MARKDOWN_EXTS,
  isMarkdownFile,
  readTextFile,
  readTextFileForEdit,
  writeTextFile,
  listDirectory,
  watchFile,
  unwatchFile,
  get watchedPath() { return watchedPath; }
};
