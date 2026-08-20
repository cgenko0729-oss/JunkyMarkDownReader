/**
 * Markdown 渲染管线（运行在主进程）
 *
 * 放在主进程的理由：markdown-it 及其插件、highlight.js 都是 npm 包，
 * 在 Node 环境里 require 毫无障碍；渲染进程只需接收最终 HTML 字符串。
 * 这样彻底避开渲染进程加载 npm 包（bare specifier / ESM）的一堆麻烦。
 *
 * 输出的 DOM 结构刻意贴近 Typora 导出的 HTML（#write、md-fences、figure>table 等），
 * 以便直接套用现成的 Typora 主题 CSS。
 */

'use strict';

const path = require('path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js');
const { toAssetUrl } = require('./protocols');

// 这几个插件在不同打包格式下 require 结果可能带 .default，统一解包
const unwrap = (m) => (m && m.default) || m;
const anchor = unwrap(require('markdown-it-anchor'));
const footnote = unwrap(require('markdown-it-footnote'));
const taskLists = unwrap(require('markdown-it-task-lists'));
const attrs = unwrap(require('markdown-it-attrs'));

/**
 * 标题 → id。保留中文字符（DOM id 允许），只清掉空白与标点，
 * 这样大纲跳转的锚点是可读的 #第一章 而不是 #%E7%AC%AC%E4%B8%80%E7%AB%A0
 */
function slugify(str) {
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '') || 'section';
}

/** 判断链接是否指向外部（不需要改写成本地资源） */
function isExternal(href) {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

const md = new MarkdownIt({
  html: true,        // 允许裸 HTML；渲染进程会用 DOMPurify 清洗
  linkify: true,     // 裸 URL 自动变链接
  breaks: false,     // 遵循标准 Markdown，单换行不成 <br>
  typographer: false // 关掉智能标点，避免破坏中文引号
});

md.use(anchor, {
  level: [1, 2, 3, 4, 5, 6],
  slugify,
  tabIndex: false
});
md.use(footnote);
md.use(taskLists, { label: true, labelAfter: false });
md.use(attrs);

/* ---------------------------------------------------------------
 * 源文件行号
 *
 * markdown-it 的块级 token 自带 .map = [起始行, 结束行]（0 基），
 * 把它写成 data-line 属性带给渲染进程，行号槽就能标出「这一块在
 * .md 原文的第几行」。
 * --------------------------------------------------------------- */

/**
 * 要标行号的 token 类型。
 * 刻意不含 bullet_list_open / ordered_list_open：列表整体和它的第一项
 * 起始行相同，两个都标会重叠。列表按「每一项」标，粒度更实用。
 * 表格内部的 tr/td 同理不标，整张表一个号就够。
 */
const LINE_TOKENS = new Set([
  'heading_open',
  'paragraph_open',
  'blockquote_open',
  'list_item_open',
  'fence',
  'code_block',
  'table_open',
  'hr'
]);
// 注意没有 html_block：它的 renderer 直接吐原始 content，属性根本传不出去

md.core.ruler.push('source_lines', (state) => {
  let lastLine = -1;

  for (const token of state.tokens) {
    if (!token.map || token.hidden || !LINE_TOKENS.has(token.type)) continue;

    const line = token.map[0] + 1;   // token.map 是 0 基，行号给人看要 1 基
    // 同一行上嵌套了好几层（比如 li 里紧跟着 p）只标最外面那一个
    if (line === lastLine) continue;
    lastLine = line;

    token.attrSet('data-line', String(line));
  }
});

/** 自定义 renderer 绕开了 renderToken，得自己把 data-line 拼回去 */
function lineAttr(token) {
  const line = token.attrGet('data-line');
  return line ? ` data-line="${md.utils.escapeHtml(line)}"` : '';
}

/* ---------------------------------------------------------------
 * 自定义 renderer：对齐 Typora 的 DOM 结构
 * --------------------------------------------------------------- */

/**
 * 代码块。Typora 主题依赖 pre.md-fences 这个选择器。
 * mermaid 代码块不做高亮，而是输出一个占位 div，交给渲染进程画图。
 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const lang = info.split(/\s+/)[0].toLowerCase();
  const code = token.content;

  if (lang === 'mermaid') {
    // 源码用 base64 传递，免去引号、换行、HTML 实体的转义地狱
    const payload = Buffer.from(code, 'utf8').toString('base64');
    return `<div class="md-diagram-panel md-mermaid md-end-block" data-mermaid-src="${payload}"${lineAttr(token)}>` +
           `<div class="md-mermaid-placeholder">Mermaid 图表加载中…</div></div>\n`;
  }

  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      highlighted = md.utils.escapeHtml(code);
    }
  } else {
    highlighted = md.utils.escapeHtml(code);
  }

  const langAttr = lang ? ` lang="${md.utils.escapeHtml(lang)}"` : '';
  const langClass = lang ? ` language-${md.utils.escapeHtml(lang)}` : '';
  return `<pre class="md-fences md-end-block"${langAttr}${lineAttr(token)}>` +
         `<code class="hljs${langClass}">${highlighted}</code></pre>\n`;
};

/** 行内代码：Typora 用 code.md-code */
md.renderer.rules.code_inline = (tokens, idx) => {
  return `<code class="md-code">${md.utils.escapeHtml(tokens[idx].content)}</code>`;
};

/** 表格：Typora 导出结构是 figure > table，主题据此做溢出滚动与边框 */
md.renderer.rules.table_open = (tokens, idx) =>
  `<figure class="md-table-fig md-end-block"${lineAttr(tokens[idx])}><table class="md-table">\n`;
md.renderer.rules.table_close = () => '</table></figure>\n';

/**
 * 图片：把本地相对/绝对路径改写成 md-asset:// 协议 URL。
 * 不这么做的话 ![](./img/a.png) 在 Electron 里根本加载不出来。
 */
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const srcIdx = token.attrIndex('src');
  if (srcIdx >= 0) {
    const src = token.attrs[srcIdx][1];
    if (!isExternal(src)) {
      const abs = path.resolve(env.baseDir || process.cwd(), decodeURI(src));
      token.attrs[srcIdx][1] = toAssetUrl(abs);
    }
  }
  // alt 文本由 markdown-it 自己渲染（可能含行内标记）
  token.attrs[token.attrIndex('alt')][1] = self.renderInlineAsText(token.children, options, env);
  return self.renderToken(tokens, idx, options);
};

/**
 * 链接：标记出三类链接，交给渲染进程分别处理
 *  - 外部链接      → 用系统浏览器打开
 *  - 本地 .md 文件 → 在本应用内跳转打开
 *  - 页内锚点      → 平滑滚动
 */
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const hrefIdx = token.attrIndex('href');
  if (hrefIdx >= 0) {
    const href = token.attrs[hrefIdx][1];
    if (href.startsWith('#')) {
      token.attrSet('data-link-type', 'anchor');
    } else if (isExternal(href)) {
      token.attrSet('data-link-type', 'external');
    } else {
      // 拆掉可能跟在文件名后的锚点：other.md#section
      const hashAt = href.indexOf('#');
      const filePart = hashAt >= 0 ? href.slice(0, hashAt) : href;
      const hashPart = hashAt >= 0 ? href.slice(hashAt) : '';
      const abs = path.resolve(env.baseDir || process.cwd(), decodeURI(filePart));
      token.attrSet('data-link-type', 'local');
      token.attrSet('data-local-path', abs);
      if (hashPart) token.attrSet('data-local-hash', hashPart);
    }
  }
  return self.renderToken(tokens, idx, options);
};

/* ---------------------------------------------------------------
 * 对外接口
 * --------------------------------------------------------------- */

/**
 * 渲染 Markdown 为 HTML，并抽出大纲。
 * @param {string} source   Markdown 原文
 * @param {string} filePath 文档绝对路径（用于解析其中的相对路径）
 * @returns {{html: string, outline: Array, hasMermaid: boolean}}
 */
function render(source, filePath) {
  const baseDir = filePath ? path.dirname(filePath) : process.cwd();
  const env = { baseDir };

  let html = md.render(source, env);

  // task-lists 插件的类名是硬编码的，补上 Typora 主题用的那个
  html = html.replace(/class="task-list-item/g, 'class="task-list-item md-task-list-item');

  return {
    html,
    outline: extractOutline(source),
    hasMermaid: /class="[^"]*md-mermaid/.test(html)
  };
}

/**
 * 从 Markdown 原文抽取标题大纲。
 * 直接解析 token 流而不是解析渲染后的 HTML —— 更可靠，
 * 且 id 的算法与 markdown-it-anchor 完全一致，跳转不会错位。
 */
function extractOutline(source) {
  const tokens = md.parse(source, {});
  const outline = [];
  const seen = new Map(); // 处理重名标题，规则与 markdown-it-anchor 一致

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const level = Number(tokens[i].tag.slice(1));
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline'
      ? inline.children.filter((t) => t.type === 'text' || t.type === 'code_inline')
          .map((t) => t.content).join('')
      : '';

    let id = slugify(text);
    if (seen.has(id)) {
      const n = seen.get(id) + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 0);
    }

    outline.push({ level, text: text.trim(), id });
  }
  return outline;
}

module.exports = { render, extractOutline, slugify };
