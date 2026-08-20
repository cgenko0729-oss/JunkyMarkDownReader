/**
 * HTML 清洗
 *
 * Markdown 允许内嵌裸 HTML，所以渲染结果必须过一遍 DOMPurify，
 * 否则打开一份来源不明的 .md 就等于让它在应用里执行任意脚本。
 *
 * 有一个必踩的坑：DOMPurify 默认的 URI 白名单里没有 md-asset:，
 * 不显式放行的话所有本地图片的 src 都会被剥掉，图片全部裂开。
 */

(function (global) {
  'use strict';

  // 在默认白名单（http/https/mailto/tel/...）基础上加入 md-asset:
  const ALLOWED_URI_REGEXP =
    /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|md-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

  const CONFIG = {
    ALLOWED_URI_REGEXP,
    // 我们自己生成的 data-* 标记（链接类型、mermaid 源码）靠这个保住
    ALLOW_DATA_ATTR: true,
    // <style> 能做视觉欺骗、还能靠远程字体做追踪，阅读器里不需要。
    // 表单控件同理：阅读器没有任何需要用户输入的场景。
    FORBID_TAGS: [
      'script', 'style', 'iframe', 'object', 'embed', 'applet',
      'form', 'textarea', 'button', 'select', 'option',
      'link', 'meta', 'base'
    ],
    FORBID_ATTR: ['srcset', 'formaction', 'ping'],
    // 保留 <figure>/<figcaption> 等 Typora 主题会用到的结构
    ADD_ATTR: ['lang', 'align', 'colspan', 'rowspan', 'start']
  };

  let hooksInstalled = false;

  /**
   * DOMPurify 的 FORBID_TAGS 只删标签本身、保留子节点，
   * 所以 <form><input type="password"></form> 清洗后会剩下一个孤立的密码框。
   * 阅读器里唯一合法的 input 是任务列表的复选框，其余一律删掉，
   * 免得一份 .md 能伪造出让人填密码的界面。
   */
  function installHooks() {
    if (hooksInstalled || !global.DOMPurify) return;
    global.DOMPurify.addHook('uponSanitizeElement', (node, data) => {
      if (data.tagName !== 'input') return;
      const type = (node.getAttribute && (node.getAttribute('type') || '')).toLowerCase();
      if (type !== 'checkbox' && node.remove) node.remove();
    });
    hooksInstalled = true;
  }

  /** 清洗渲染后的 HTML 字符串 */
  function clean(html) {
    if (!global.DOMPurify) {
      console.error('[sanitize] DOMPurify 未加载，为安全起见不渲染任何内容');
      return '';
    }
    installHooks();
    return global.DOMPurify.sanitize(html, CONFIG);
  }

  global.Sanitize = { clean, CONFIG };
})(window);
