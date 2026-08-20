/**
 * 两个自定义协议
 *
 * app://reader/...     —— 加载应用自身的界面资源（HTML/CSS/JS/主题）
 *   为什么不用 file:// 直接 loadFile？因为 file:// 页面的同源策略很特殊，
 *   CSP 里的 'self' 在那里行为不可预期。换成标准协议后 CSP 完全正常工作。
 *
 * md-asset://local/... —— 加载 Markdown 文档里引用的本地图片等资源
 *   ![](./img/a.png) 在 Electron 里默认加载不出来，必须做路径改写。
 *   走自定义协议而非 file:// 的好处：CSP 可以只放行 img-src md-asset:，
 *   并且能做目录白名单检查 —— 打开来源不明的 .md 时，它读不到白名单外的文件。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_SCHEME = 'app';
const APP_HOST = 'reader';
const ASSET_SCHEME = 'md-asset';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

const mimeFor = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

/* ---------------------------------------------------------------
 * md-asset 的目录白名单
 * --------------------------------------------------------------- */

const allowedRoots = new Set();

/** 注册一个允许读取的根目录（打开文档或工作区时调用） */
function allowRoot(dir) {
  if (!dir) return;
  try {
    allowedRoots.add(path.resolve(dir).toLowerCase());
  } catch { /* 忽略无效路径 */ }
}

function isAllowed(absPath) {
  const target = path.resolve(absPath).toLowerCase();
  for (const root of allowedRoots) {
    if (target === root) return true;
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (target.startsWith(prefix)) return true;
  }
  return false;
}

/* ---------------------------------------------------------------
 * URL ↔ 路径 互转
 * --------------------------------------------------------------- */

/** 本地绝对路径 → md-asset:// URL */
function toAssetUrl(absPath) {
  const normalized = absPath.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  const encoded = withLeadingSlash.split('/').map(encodeURIComponent).join('/');
  return `${ASSET_SCHEME}://local${encoded}`;
}

/** md-asset:// URL → 本地绝对路径 */
function fromAssetUrl(assetUrl) {
  const u = new URL(assetUrl);
  let p = decodeURIComponent(u.pathname);
  // Windows 上会拿到 "/C:/foo/bar"，要去掉开头那道斜杠
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return path.normalize(p);
}

/** 应用内相对路径 → app:// URL */
function appUrl(relPath) {
  const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${APP_SCHEME}://${APP_HOST}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

/* ---------------------------------------------------------------
 * 注册
 * --------------------------------------------------------------- */

/** 必须在 app ready **之前**调用，否则协议拿不到 standard/secure 特权 */
function registerSchemes() {
  const { protocol } = require('electron');
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);
}

/** app ready 之后调用，挂上真正的请求处理器 */
function registerHandlers(appRoot) {
  const { protocol, net } = require('electron');
  const root = path.resolve(appRoot);

  // ---- app://reader/... ----
  protocol.handle(APP_SCHEME, async (request) => {
    const u = new URL(request.url);
    if (u.hostname !== APP_HOST) {
      return new Response('Not Found', { status: 404 });
    }

    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const target = path.normalize(path.join(root, rel));

    // 防目录穿越
    if (target !== root && !target.toLowerCase().startsWith(root.toLowerCase() + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      // 用 fs 读而不是 net.fetch：fs 是 asar-aware 的，
      // 打包进 app.asar 之后依然读得到。
      const data = await fsp.readFile(target);
      return new Response(data, { headers: { 'Content-Type': mimeFor(target) } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  // ---- md-asset://local/... ----
  protocol.handle(ASSET_SCHEME, async (request) => {
    let filePath;
    try {
      filePath = fromAssetUrl(request.url);
    } catch {
      return new Response('Bad asset URL', { status: 400 });
    }

    if (!isAllowed(filePath)) {
      console.warn('[md-asset] 拒绝越界访问:', filePath);
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(filePath)) {
      return new Response('Not Found', { status: 404 });
    }

    // 用户的图片/音视频走 net.fetch，天然支持流式与 range 请求
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

module.exports = {
  APP_SCHEME, APP_HOST, ASSET_SCHEME,
  registerSchemes, registerHandlers,
  toAssetUrl, fromAssetUrl, appUrl,
  allowRoot, isAllowed
};
