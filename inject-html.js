/*
 * Guided Review Tool — inject-html.js
 * Adds tags to a page's HTML. Shared by the tool (app.js, when publishing) and
 * the service worker (sw.js, for the preview), so both produce the same page.
 */
(function (scope) {
  'use strict';

  const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // head: inserted right after <head>; body: right before the last </body>.
  function injectHtml(html, parts) {
    if (parts.head) {
      const m = html.match(/<head(\s[^>]*)?>/i);
      html = m
        ? html.slice(0, m.index + m[0].length) + parts.head + html.slice(m.index + m[0].length)
        : parts.head + html;
    }
    if (parts.body) {
      const i = html.toLowerCase().lastIndexOf('</body>');
      html = i >= 0 ? html.slice(0, i) + parts.body + html.slice(i) : html + parts.body;
    }
    return html;
  }

  // The <script> tag that loads the review engine into a page.
  function engineTag(attrs) {
    let tag = '<script src="' + escapeAttr(attrs.src) + '"';
    ['css', 'tour', 'root', 'mode'].forEach((k) => {
      if (attrs[k]) tag += ' data-' + k + '="' + escapeAttr(attrs[k]) + '"';
    });
    if (attrs.embedded) tag += ' data-embedded';
    return tag + ' defer></script>';
  }

  const TYPES = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg',
    pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', xml: 'application/xml', webmanifest: 'application/manifest+json',
  };

  function contentType(path) {
    const ext = (path.match(/\.([a-z0-9]+)$/i) || [])[1];
    return TYPES[(ext || '').toLowerCase()] || 'application/octet-stream';
  }

  const isHtml = (path) => /\.html?$/i.test(path);

  // "my page.html" -> "my%20page.html", keeping the slashes.
  const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

  scope.GuidedReviewInject = { injectHtml, engineTag, contentType, isHtml, encodePath };
})(self);
