/**
 * 纯文本渲染器（.txt）
 *
 * 跟 markdown.js 是两条完全独立的路：.txt 的内容**不做任何语法解析**。
 * 用户在记事本里写的 `# 备忘` 就该显示成 `# 备忘`，而不是变成一级标题；
 * 缩进、连续空行、行尾空格也都原样保留。这是选纯文本模式的全部意义。
 *
 * 输出结构是「一行一个 div，带 data-line」，而不是一整块 <pre>：
 *   - 行号槽（renderer/linenum.js）认的就是 data-line，这样 .txt 能拿到
 *     真正逐行的行号 —— 比 Markdown 那种「每个块的起始行」还准
 *   - 查找（renderer/search.js）走的是文本节点，逐行 div 完全不影响它
 *   - 换行交给 CSS 的 white-space: pre-wrap，长行会软换行而不是撑出横向滚动条
 */

'use strict';

/**
 * 超过这个行数就退回单块模式：几十万个 div 会让渲染进程直接卡死。
 * 退化后失去逐行行号，但至少打得开。
 */
const PER_LINE_LIMIT = 50000;

/** HTML 转义。纯文本里的 < & " 必须原样显示，绝不能当标签解析。 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} source 文件全文
 * @returns {{ html: string, outline: Array, hasMermaid: boolean, lineCount: number, degraded: boolean }}
 */
function render(source) {
  // 统一换行：CRLF / CR 都按一行算，否则 Windows 文件的行号会全错
  const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // 文件以换行结尾时 split 会多出一个空字符串，那不是真正的一行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const degraded = lines.length > PER_LINE_LIMIT;

  let html;
  if (degraded) {
    html = `<div class="plaintext plaintext-degraded"><div class="txt-line" data-line="1">${escapeHtml(text)}</div></div>`;
  } else {
    const parts = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      // 空行不给内容，高度由 CSS 的 min-height 撑起来 ——
      // 塞 <br> 或零宽空格都会污染查找结果和复制出来的文本
      parts[i] = `<div class="txt-line" data-line="${i + 1}">${escapeHtml(lines[i])}</div>`;
    }
    html = `<div class="plaintext">${parts.join('')}</div>`;
  }

  return {
    html,
    outline: [],        // 纯文本没有标题，大纲侧栏由渲染进程自动收起
    hasMermaid: false,
    lineCount: lines.length,
    degraded
  };
}

module.exports = { render, PER_LINE_LIMIT };
