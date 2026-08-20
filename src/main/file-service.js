/**
 * 文件服务：读文档、列目录、监听文件变更
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const chokidar = require('chokidar');

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext']);

/**
 * 纯文本扩展名。这些文件**不走 Markdown 解析** —— 见 main/plaintext.js。
 * 刻意只放 .txt：把 .log/.json 之类也收进来，就得面对几十 MB 的文件和
 * 二进制误判，那是另一个需求了。
 */
const PLAIN_TEXT_EXTS = new Set(['.txt']);

/** 列目录时直接跳过的噪音目录 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  '__pycache__', 'dist', 'build', '.next', '.cache', '$RECYCLE.BIN'
]);

function isMarkdownFile(filePath) {
  return MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase());
}

function isPlainTextFile(filePath) {
  return PLAIN_TEXT_EXTS.has(path.extname(filePath).toLowerCase());
}

/** 本应用能打开的文件（文件树、命令行参数、拖放、快速切换索引都用这个判断） */
function isSupportedFile(filePath) {
  return isMarkdownFile(filePath) || isPlainTextFile(filePath);
}

/** 'markdown' | 'text'，决定用哪个渲染器 */
function docKind(filePath) {
  return isPlainTextFile(filePath) ? 'text' : 'markdown';
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
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      // kind 交给文件树区分图标：.txt 和 .md 在同一棵树里要一眼看得出来
      files.push({ name: entry.name, path: full, type: 'file', kind: docKind(entry.name) });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
  dirs.sort(byName);
  files.sort(byName);

  return { items: [...dirs, ...files] };
}

/* ---------------------------------------------------------------
 * 工作区索引（快速切换面板 Ctrl+P 用）
 *
 * 与文件树的懒展开是两套东西：文件树只读用户点开的那一层，而 Ctrl+P 要能
 * 搜到整个工作区，非递归扫一遍不可。所以这里的重点全在「别让大目录把主进程
 * 卡死」：硬上限 + 深度上限 + 结果缓存，扫描本身也是 async 的，事件循环
 * 在每个 readdir 之间都能喘口气。
 * --------------------------------------------------------------- */

/** 索引的硬上限。超过就截断 —— 搜索框里本来也只显示前几十条 */
const SCAN_FILE_LIMIT = 20000;
/** 递归深度上限，防御符号链接成环之类的意外 */
const SCAN_DEPTH_LIMIT = 12;
/**
 * 缓存有效期。设得长是有意的：扫一个上万文档的知识库要好几秒，
 * 30 秒就过期意味着用户每隔一会儿按 Ctrl+P 都要重等一次。
 * 真正需要刷新的两个时机（换工作区、用户点文件树的刷新）都会显式作废缓存。
 */
const SCAN_CACHE_MS = 5 * 60 * 1000;
/**
 * 同时读几个目录。
 *
 * 逐个 await readdir 的话，整趟扫描的耗时就是「目录数 × 单次 IO 延迟」，
 * 实测 12000 份文档的知识库要 23 秒 —— CPU 全程闲着，时间都花在等磁盘。
 * 一次并发读十几个目录能把这段压缩到几分之一。数字不宜再大：Windows 上
 * 并发句柄开太多反而会拖慢，12 是实测比较稳的一档。
 */
const SCAN_CONCURRENCY = 12;
/**
 * 时间预算。碰上意料之外的巨型目录树（比如有人把 C:\ 设成工作区）时，
 * 与其让「正在索引」转到天荒地老，不如给出已经扫到的部分并标记截断。
 */
const SCAN_TIME_LIMIT_MS = 12000;

let scanCache = { root: null, at: 0, result: null };
let scanInFlight = null;

/**
 * 递归列出工作区里所有能打开的文档。
 *
 * @param {string} root
 * @param {boolean} [force] 忽略缓存重新扫
 * @returns {Promise<{items: Array, truncated: boolean, root: string}>}
 */
async function scanWorkspace(root, force) {
  if (!root) return { items: [], truncated: false, root: null };
  const abs = path.resolve(root);

  const fresh = scanCache.result &&
                scanCache.root === abs &&
                Date.now() - scanCache.at < SCAN_CACHE_MS;
  if (fresh && !force) return scanCache.result;

  // 同一个目录的并发请求合并成一次扫描：渲染进程刚启动时
  // 「打开工作区」和「按下 Ctrl+P」很容易前后脚撞在一起
  if (scanInFlight && scanInFlight.root === abs && !force) return scanInFlight.promise;

  const promise = (async () => {
    const items = [];
    let truncated = false;
    const deadline = Date.now() + SCAN_TIME_LIMIT_MS;

    /** 读一层目录。失败（没权限、被删）只跳过这一个，不该让整趟扫描失败。 */
    async function readLevelEntries(dir) {
      try {
        return await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    }

    /**
     * 逐层推进的广度优先遍历，每层内部并发读。
     * 顺带的好处：浅层的文件排在前面，而越浅的文件通常越是用户想找的那个。
     */
    let level = [abs];

    for (let depth = 0; depth <= SCAN_DEPTH_LIMIT && level.length; depth++) {
      const nextLevel = [];

      for (let i = 0; i < level.length && !truncated; i += SCAN_CONCURRENCY) {
        if (Date.now() > deadline) { truncated = true; break; }

        const batch = level.slice(i, i + SCAN_CONCURRENCY);
        const batchEntries = await Promise.all(batch.map(readLevelEntries));

        for (let b = 0; b < batch.length; b++) {
          const dir = batch[b];

          for (const entry of batchEntries[b]) {
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;

            if (entry.isDirectory()) {
              nextLevel.push(path.join(dir, entry.name));
            } else if (entry.isFile() && isSupportedFile(entry.name)) {
              if (items.length >= SCAN_FILE_LIMIT) { truncated = true; break; }
              const full = path.join(dir, entry.name);
              items.push({
                path: full,
                name: entry.name,
                // 相对路径是给搜索框显示和匹配用的，绝对路径太长且前缀全一样
                rel: path.relative(abs, full),
                kind: docKind(entry.name)
              });
            }
          }

          if (truncated) break;
        }
      }

      if (truncated) break;
      level = nextLevel;
    }

    const result = { items, truncated, root: abs };
    scanCache = { root: abs, at: Date.now(), result };
    return result;
  })();

  scanInFlight = { root: abs, promise };
  try {
    return await promise;
  } finally {
    if (scanInFlight && scanInFlight.promise === promise) scanInFlight = null;
  }
}

/** 工作区换了或者用户点了刷新，缓存作废 */
function invalidateScanCache() {
  scanCache = { root: null, at: 0, result: null };
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
  PLAIN_TEXT_EXTS,
  isMarkdownFile,
  isPlainTextFile,
  isSupportedFile,
  docKind,
  scanWorkspace,
  invalidateScanCache,
  readTextFile,
  readTextFileForEdit,
  writeTextFile,
  listDirectory,
  watchFile,
  unwatchFile,
  get watchedPath() { return watchedPath; }
};
