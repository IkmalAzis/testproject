/*!
 * Guided Review Tool — review.js (the review engine)
 *
 *   ?review=author    author mode: pick elements, write notes
 *   ?review=<token>   reviewer mode: the client walks the tour and comments
 *
 * The tool (index.html) adds this script to every page of a dropped project:
 * in its own preview, and in the copy it publishes to the review site.
 * See README.md.
 *
 * Script attributes:
 *   data-tour      URL of review-tour.json
 *   data-css       URL of review.css (default: next to this script)
 *   data-root      URL path the project is served under (default "/")
 *   data-mode      mode to use when the URL has no ?review= (tool preview)
 *   data-embedded  running inside the tool: the tool handles publishing
 */
(function () {
  'use strict';

  if (window.__guidedReview) return;

  // ===========================================================================
  // 1. Config, storage and data model
  // ===========================================================================

  const SCRIPT = document.currentScript;
  const CONFIG = {
    tourUrl: new URL((SCRIPT && SCRIPT.dataset.tour) || '/review-tour.json', location.href).href,
    cssUrl: SCRIPT && SCRIPT.dataset.css
      ? new URL(SCRIPT.dataset.css, location.href).href
      : SCRIPT && SCRIPT.src ? new URL('review.css', SCRIPT.src).href : 'review.css',
    root: ((SCRIPT && SCRIPT.dataset.root) || '/').replace(/\/*$/, '/'),
    embedded: !!(SCRIPT && SCRIPT.hasAttribute('data-embedded')),
  };

  const TOUR_FORMAT = 'guided-review/tour';
  const FEEDBACK_FORMAT = 'guided-review/feedback';
  const FORMAT_VERSION = 1;
  const NOTE_LIMIT = 200;
  const PHONE_MAX = 699;
  // wa.me and mailto links get unreliable past roughly 2000 characters.
  const SHARE_URL_LIMIT = 1800;

  const KEY = {
    mode: 'gr:mode',
    focus: 'gr:focus',
    panel: 'gr:author:collapsed',
    draft: 'gr:author:draft',
    authorFeedback: 'gr:author:feedback',
    review: (token) => 'gr:review:' + token,
  };

  let storageOk = true;
  let onStorageFail = function () {};
  const ls = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        if (storageOk) {
          storageOk = false;
          onStorageFail();
        }
        return false;
      }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (e) { /* nothing to do */ }
    },
  };
  const ss = {
    get(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* nothing to do */ } },
    del(key) { try { sessionStorage.removeItem(key); } catch (e) { /* nothing to do */ } },
  };
  try {
    localStorage.setItem('gr:test', '1');
    localStorage.removeItem('gr:test');
  } catch (e) {
    storageOk = false;
  }

  // The mode is remembered for the tab, so ordinary links inside the site keep
  // the review running.
  // data-mode is a default for single-file previews, which cannot be opened
  // with a query string. Review deploys leave it out.
  const param = (new URLSearchParams(location.search).get('review') || '').trim();
  if (param) ss.set(KEY.mode, param);
  const MODE = param || ss.get(KEY.mode) || (SCRIPT && SCRIPT.dataset.mode) || '';
  if (!MODE) return;
  window.__guidedReview = true;
  const IS_AUTHOR = MODE === 'author';

  // --- small helpers --------------------------------------------------------

  const uid = (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const hasText = (s) => typeof s === 'string' && s.trim() !== '';
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const isPhone = () => window.innerWidth <= PHONE_MAX;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function shorten(s, n) {
    s = squash(s);
    if (s.length <= n) return s;
    const cut = s.slice(0, n);
    const space = cut.lastIndexOf(' ');
    return (space > n * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '') + '…';
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function fmtDate(value) {
    const d = new Date(value);
    if (!value || isNaN(d)) return String(value || '');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // --- pages ------------------------------------------------------------------

  // A page is known by its file path inside the project: "index.html",
  // "about.html". The same page has the same key in the tool's preview
  // (/preview/about.html) and on the review site (/about or /about.html).
  function pageKey(pathname) {
    let p = String(pathname || '');
    try { p = decodeURIComponent(p); } catch (e) { /* keep as is */ }
    if (p.startsWith(CONFIG.root)) p = p.slice(CONFIG.root.length);
    p = p.replace(/^\/+/, '');
    if (p === '' || p.endsWith('/')) p += 'index.html';
    if (!/\.[a-z0-9]+$/i.test(p)) p += '.html';
    return p;
  }
  const PAGE = pageKey(location.pathname);

  const TITLE_SPLIT = /\s+[|·•–—-]\s+/;

  // og:site_name, else the site part of the tab title: "About — Acme" on inner
  // pages, "Acme — tagline" on the home page.
  function defaultSiteName() {
    const meta = document.querySelector('meta[property="og:site_name"], meta[name="application-name"]');
    if (meta && squash(meta.getAttribute('content'))) return squash(meta.getAttribute('content'));
    const parts = squash(document.title).split(TITLE_SPLIT).filter(Boolean);
    if (parts.length > 1) return /(^|\/)index\.html?$/i.test(PAGE) ? parts[0] : parts[parts.length - 1];
    return parts[0] || 'Website';
  }

  function pageTitle(siteName) {
    if (/(^|\/)index\.html?$/i.test(PAGE)) return 'Home';
    const raw = squash(document.title);
    const site = squash(siteName).toLowerCase();
    const parts = raw.split(TITLE_SPLIT).map(squash).filter(Boolean);
    const rest = parts.filter((p) => p.toLowerCase() !== site);
    return rest[0] || raw || PAGE;
  }

  // URL of another page of the project. A mode set by data-mode needs no
  // query string; one from ?review= is carried along.
  function pageUrl(key) {
    const fromAttr = SCRIPT && SCRIPT.dataset.mode === MODE;
    return CONFIG.root + key.split('/').map(encodeURIComponent).join('/') +
      (fromAttr ? '' : '?review=' + encodeURIComponent(MODE));
  }

  // --- data model ---------------------------------------------------------------
  //
  // Tour (exported by the author, shipped as review-tour.json):
  //   { format, version, tourId, siteName, contact: { whatsapp, email },
  //     pages: { [pageKey]: { path, title } },
  //     steps: [ { id, page, path, title, note, anchor } ] }
  //   page and path are both the page key, e.g. "about.html".
  //
  // Anchor:
  //   { selector, tag, text, fx, fy, fw, fh }   (f* = fractions of page size)
  //
  // Feedback (downloaded by the client, loaded back by the author):
  //   { format, version, tourId, siteName, reviewer, date,
  //     pages: { [pageKey]: { path, title } },
  //     stepRefs: { [stepId]: { n, title, page, note } },
  //     stepComments: { [stepId]: text },
  //     freePins: [ { id, page, path, anchor, offset: { x, y }, label, text, created } ],
  //     pageComments: { [pageKey]: text } }

  function newTour() {
    return {
      format: TOUR_FORMAT,
      version: FORMAT_VERSION,
      tourId: '',
      siteName: defaultSiteName(),
      contact: { whatsapp: '', email: '' },
      pages: {},
      steps: [],
    };
  }

  function validAnchor(a) {
    return !!a && typeof a === 'object' && typeof a.selector === 'string' && typeof a.tag === 'string';
  }

  function normalizeTour(t) {
    if (!t || typeof t !== 'object' || !Array.isArray(t.steps)) return null;
    if (t.format && t.format !== TOUR_FORMAT) return null;
    const contact = t.contact && typeof t.contact === 'object' ? t.contact : {};
    return {
      format: TOUR_FORMAT,
      version: FORMAT_VERSION,
      tourId: String(t.tourId || ''),
      siteName: squash(t.siteName) || defaultSiteName(),
      contact: { whatsapp: String(contact.whatsapp || ''), email: String(contact.email || '') },
      pages: t.pages && typeof t.pages === 'object' ? t.pages : {},
      steps: t.steps
        .filter((s) => s && s.id && s.page && validAnchor(s.anchor))
        .map((s) => ({
          id: String(s.id),
          page: String(s.page),
          path: String(s.path || s.page),
          title: String(s.title || ''),
          note: String(s.note || ''),
          anchor: s.anchor,
        })),
    };
  }

  function emptyFeedback() {
    return {
      format: FEEDBACK_FORMAT,
      version: FORMAT_VERSION,
      tourId: '',
      siteName: '',
      reviewer: '',
      date: '',
      pages: {},
      stepRefs: {},
      stepComments: {},
      freePins: [],
      pageComments: {},
    };
  }

  function normalizeFeedback(o) {
    if (!o || typeof o !== 'object') throw new Error('That file is empty.');
    if (o.format === TOUR_FORMAT) throw new Error('That is a tour file, not feedback.');
    if (o.format !== FEEDBACK_FORMAT) throw new Error('That is not a feedback file from this tool.');
    const fb = emptyFeedback();
    fb.tourId = String(o.tourId || '');
    fb.siteName = String(o.siteName || '');
    fb.reviewer = String(o.reviewer || '');
    fb.date = String(o.date || '');
    const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
    fb.pages = obj(o.pages);
    fb.stepRefs = obj(o.stepRefs);
    fb.stepComments = obj(o.stepComments);
    fb.pageComments = obj(o.pageComments);
    fb.freePins = (Array.isArray(o.freePins) ? o.freePins : [])
      .filter((p) => p && p.page)
      .map((p) => ({
        id: String(p.id || uid('p')),
        page: String(p.page),
        path: String(p.path || p.page),
        anchor: validAnchor(p.anchor) ? p.anchor : null,
        offset: p.offset && typeof p.offset === 'object' ? p.offset : null,
        label: String(p.label || ''),
        text: String(p.text || ''),
        created: String(p.created || ''),
      }));
    return fb;
  }

  // A tour embedded as <script type="application/json" id="guided-review-tour">
  // wins over the file, so a page opened from disk (file://) works too.
  function fetchTour() {
    const inline = document.getElementById('guided-review-tour');
    if (inline) {
      try { return Promise.resolve(normalizeTour(JSON.parse(inline.textContent))); } catch (e) { return Promise.resolve(null); }
    }
    return fetch(CONFIG.tourUrl, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(normalizeTour)
      .catch(() => null);
  }

  // ===========================================================================
  // 2. Anchoring
  // ===========================================================================

  let host = null;

  function isOurs(node) {
    return !!host && (node === host || host.contains(node));
  }

  // Shortest id-rooted nth-of-type path. The UI host is a custom element, so it
  // never shifts the nth-of-type count of the site's own elements.
  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      if (el === document.body) {
        parts.unshift('body');
        break;
      }
      let i = 1;
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === el.tagName) i++;
      parts.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  // Text nodes joined with spaces ("300+ projects", not "300+projects"). Not
  // innerText: that changes with CSS, and anchors must match on every device.
  function textOf(el, max) {
    max = max || 300;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let out = '';
    for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) out += ' ' + n.nodeValue;
    return squash(out);
  }

  function snippet(el) {
    let t = textOf(el, 80);
    if (!t) {
      t = squash(el.getAttribute('aria-label') || el.getAttribute('alt') ||
        el.getAttribute('placeholder') || el.getAttribute('title'));
    }
    return t.slice(0, 40);
  }

  function docRect(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  }

  // Page size without the review UI (the tooltip and scroll runway would
  // otherwise stretch it).
  function measureDoc() {
    const de = document.documentElement;
    const body = document.body;
    let bottom = de.getBoundingClientRect().bottom;
    if (body) {
      bottom = Math.max(bottom, body.getBoundingClientRect().bottom);
      for (const c of body.children) {
        if (c === host || c.tagName === 'SCRIPT') continue;
        if (getComputedStyle(c).position === 'fixed') continue;
        bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
      }
    }
    return { w: Math.max(de.clientWidth, 1), h: Math.max(bottom + window.scrollY, 1) };
  }

  function recordAnchor(el) {
    const r = docRect(el);
    const d = measureDoc();
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      text: snippet(el),
      fx: round4(r.x / d.w),
      fy: round4(r.y / d.h),
      fw: round4(r.w / d.w),
      fh: round4(r.h / d.h),
    };
  }

  function fractionRect(a) {
    const d = measureDoc();
    return {
      x: (a.fx || 0) * d.w,
      y: (a.fy || 0) * d.h,
      w: Math.max((a.fw || 0) * d.w, 24),
      h: Math.max((a.fh || 0) * d.h, 24),
    };
  }

  // status: 'ok' | 'hidden' (found but not displayed) | 'unanchored'
  function resolveAnchor(a) {
    let el = null;
    try {
      const hits = document.querySelectorAll(a.selector);
      if (hits.length === 1 && !isOurs(hits[0]) && hits[0].tagName.toLowerCase() === a.tag) el = hits[0];
    } catch (e) { /* selector from an older version of the page */ }
    if (!el && a.text) {
      const same = document.getElementsByTagName(a.tag);
      for (let i = 0; i < same.length; i++) {
        if (!isOurs(same[i]) && snippet(same[i]) === a.text) { el = same[i]; break; }
      }
    }
    if (el) {
      const r = docRect(el);
      if (r.w > 0 || r.h > 0) return { el, status: 'ok', rect: r };
      return { el, status: 'hidden', rect: fractionRect(a) };
    }
    return { el: null, status: 'unanchored', rect: fractionRect(a) };
  }

  const ROLE = {
    a: 'link', button: 'button', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', img: 'image', picture: 'image', figure: 'image', svg: 'image',
    video: 'video', input: 'field', textarea: 'field', select: 'field', label: 'field',
    p: 'paragraph', li: 'list item', nav: 'menu', form: 'form', table: 'table',
  };

  function roleWord(el) {
    return ROLE[el.tagName.toLowerCase()] || (el.getAttribute('role') === 'button' ? 'button' : '');
  }

  // e.g. near "Talk to our engineers" button
  function describeNear(el) {
    let cur = el;
    for (let i = 0; cur && cur !== document.body && i < 5; i++, cur = cur.parentElement) {
      const t = snippet(cur);
      if (t) {
        const role = roleWord(cur);
        return 'near "' + shorten(t, 32) + '"' + (role ? ' ' + role : '');
      }
    }
    const role = roleWord(el) || 'element';
    return 'near ' + (/^[aeiou]/.test(role) ? 'an ' : 'a ') + role;
  }

  // The label a step gets in the summary: the element's own short text, its
  // first heading, or the first words of the note.
  function titleFor(el, note) {
    const own = textOf(el);
    if (own && own.length <= 60) return own;
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6');
    if (heading && textOf(heading)) return shorten(textOf(heading), 50);
    const label = el.getAttribute('aria-label') || el.getAttribute('alt');
    if (label) return shorten(label, 50);
    return shorten(own || note || el.tagName.toLowerCase(), 50);
  }

  // ===========================================================================
  // 3. Summary and import (shared by both modes)
  // ===========================================================================

  function stepRef(tour, id) {
    const i = tour.steps.findIndex((s) => s.id === id);
    if (i < 0) return null;
    const s = tour.steps[i];
    return { n: i + 1, title: s.title || shorten(s.note, 40), page: s.page, note: s.note };
  }

  // Groups every non-empty comment by page, in tour order.
  function buildReport(fb, tour) {
    const order = [];
    const addPage = (k) => { if (k && !order.includes(k)) order.push(k); };

    const steps = Object.keys(fb.stepComments)
      .filter((id) => hasText(fb.stepComments[id]))
      .map((id) => {
        const ref = fb.stepRefs[id] || stepRef(tour, id);
        return ref && { kind: 'step', id, n: ref.n, title: ref.title, page: ref.page, text: fb.stepComments[id] };
      })
      .filter(Boolean)
      .sort((a, b) => a.n - b.n);

    tour.steps.forEach((s) => addPage(s.page));
    steps.forEach((s) => addPage(s.page));
    Object.keys(fb.pageComments).forEach(addPage);
    fb.freePins.forEach((p) => addPage(p.page));

    const pages = order.map((key) => {
      const info = fb.pages[key] || tour.pages[key] || {};
      const pins = fb.freePins
        .filter((p) => p.page === key && hasText(p.text))
        .map((p) => ({ kind: 'pin', id: p.id, label: p.label, text: p.text, pin: p }));
      return {
        key,
        path: info.path || key,
        title: info.title || key,
        overall: hasText(fb.pageComments[key]) ? fb.pageComments[key] : '',
        items: steps.filter((s) => s.page === key).concat(pins),
      };
    }).filter((p) => p.overall || p.items.length);

    const total = pages.reduce((n, p) => n + (p.overall ? 1 : 0) + p.items.length, 0);
    return { pages, total };
  }

  function quoteLines(out, text) {
    String(text).trim().split('\n').forEach((line) => out.push(('    > ' + line).replace(/\s+$/, '')));
  }

  function summaryText(fb, tour) {
    const report = buildReport(fb, tour);
    const out = [
      'WEBSITE REVIEW — ' + (fb.siteName || tour.siteName),
      'Reviewer: ' + (squash(fb.reviewer) || '(name not given)') + '       Date: ' + fmtDate(fb.date),
    ];
    report.pages.forEach((p) => {
      out.push('', 'PAGE: ' + p.title + '  (' + p.path + ')');
      if (p.overall) {
        const lines = p.overall.trim().split('\n');
        if (lines.length === 1) out.push('  Overall: ' + lines[0].trim());
        else { out.push('  Overall:'); quoteLines(out, p.overall); }
      }
      p.items.forEach((it) => {
        out.push(it.kind === 'step' ? '  Step ' + it.n + ' — "' + it.title + '"' : '  Free pin — ' + it.label);
        quoteLines(out, it.text);
      });
    });
    if (!report.pages.length) out.push('', '(No comments yet.)');
    out.push('', 'TOTAL: ' + plural(report.total, 'comment') + ' across ' + plural(report.pages.length, 'page'));
    return out.join('\n');
  }

  // Reads the plain-text summary back (e.g. copied out of WhatsApp). Free pins
  // come back without a position; everything else lands where it was.
  function parseSummaryText(text, tour) {
    const fb = emptyFeedback();
    let key = null;
    let cur = null; // { o, k } — where continuation lines are appended
    let recognised = false;

    const append = (line) => {
      if (!cur) return;
      cur.o[cur.k] = cur.o[cur.k] ? cur.o[cur.k] + '\n' + line : line;
    };

    text.replace(/\r/g, '').split('\n').forEach((raw) => {
      const line = raw.trim();
      let m;
      if ((m = line.match(/WEBSITE REVIEW\s+[—–-]\s+(.+)$/))) {
        fb.siteName = m[1].trim();
        recognised = true;
        cur = null;
      } else if ((m = line.match(/^Reviewer:\s*(.*?)(?:\s+Date:\s*(.*))?$/))) {
        fb.reviewer = m[1] === '(name not given)' ? '' : m[1];
        fb.date = m[2] || '';
        cur = null;
      } else if (line.startsWith('PAGE:')) {
        const body = line.slice(5).trim();
        const open = body.lastIndexOf('(');
        let title = body;
        let path = '';
        if (open > 0 && body.endsWith(')')) {
          title = body.slice(0, open).trim();
          path = body.slice(open + 1, -1).trim();
        }
        key = pageKey(path || title);
        fb.pages[key] = { path: path || key, title };
        recognised = true;
        cur = null;
      } else if (key && (m = line.match(/^Overall:\s*(.*)$/))) {
        fb.pageComments[key] = m[1];
        cur = { o: fb.pageComments, k: key };
      } else if (key && (m = line.match(/^Step\s+(\d+)\s+[—–-]\s+"?(.*?)"?$/))) {
        const n = Number(m[1]);
        const title = m[2];
        const byNumber = tour.steps[n - 1];
        const byTitle = tour.steps.find((s) => s.page === key && s.title === title);
        const id = byNumber && byNumber.title === title ? byNumber.id : byTitle ? byTitle.id : 'text-step-' + n;
        fb.stepComments[id] = '';
        fb.stepRefs[id] = { n, title, page: key, note: '' };
        cur = { o: fb.stepComments, k: id };
      } else if (key && (m = line.match(/^Free pin\s+[—–-]\s+(.*)$/))) {
        const pin = { id: uid('p'), page: key, path: fb.pages[key].path, anchor: null, offset: null, label: m[1], text: '', created: '' };
        fb.freePins.push(pin);
        cur = { o: pin, k: 'text' };
      } else if (/^TOTAL:/.test(line)) {
        cur = null;
      } else if ((m = line.match(/^>\s?(.*)$/))) {
        append(m[1]);
      } else if (line) {
        // WhatsApp sometimes drops the "> " quote marks when copying.
        append(line);
      }
    });

    if (!recognised) throw new Error("That doesn't look like review feedback.");
    Object.keys(fb.stepComments).forEach((k) => { fb.stepComments[k] = fb.stepComments[k].trim(); });
    Object.keys(fb.pageComments).forEach((k) => { fb.pageComments[k] = fb.pageComments[k].trim(); });
    fb.freePins.forEach((p) => { p.text = p.text.trim(); });
    return fb;
  }

  function parseFeedbackInput(str, tour) {
    const s = String(str || '').trim();
    if (!s) throw new Error('Nothing to load yet.');
    if (s[0] === '{') {
      let o;
      try { o = JSON.parse(s); } catch (e) { throw new Error('The file is not valid JSON.'); }
      return normalizeFeedback(o);
    }
    return parseSummaryText(s, tour);
  }

  // ===========================================================================
  // 4. UI plumbing: shadow root, layers, layout loop, shared widgets
  // ===========================================================================

  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'disabled' || k === 'hidden' || k === 'draggable' || k === 'checked') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    for (let i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }

  const ICONS = {
    tour: '<path d="M3 6.5l6-2.5 6 2.5 6-2.5v13.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>',
    pin: '<path d="M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.2-4.1A8 8 0 1 1 20 11.5z"/><path d="M12 8v7M8.5 11.5h7"/>',
    page: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    send: '<path d="M21 3L10 14"/><path d="M21 3l-6.5 18-4.5-7-7-4.5z"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
    chat: '<path d="M4 20l1.3-3.9A8.5 8.5 0 1 1 8 18.8z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
    download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  };

  function icon(name) {
    const span = h('span', { class: 'gr-ico', 'aria-hidden': 'true' });
    // Static markup from ICONS only; never user text.
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return span;
  }

  // A custom element name keeps nth-of-type selectors of the page unaffected.
  host = document.createElement('guided-review');
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483000;visibility:hidden;';
  const shadow = host.attachShadow({ mode: 'open' });
  const reveal = () => { host.style.visibility = ''; };
  // Same for the styles: <script type="text/css" id="guided-review-css">.
  const inlineCss = document.getElementById('guided-review-css');
  let cssLink;
  if (inlineCss) {
    cssLink = h('style', null, inlineCss.textContent);
    setTimeout(reveal, 0);
  } else {
    cssLink = h('link', { rel: 'stylesheet', href: CONFIG.cssUrl });
    cssLink.addEventListener('load', reveal);
    cssLink.addEventListener('error', reveal);
    setTimeout(reveal, 2500);
  }

  const app = h('div', { class: 'gr-app' });
  const docLayer = h('div', { class: 'gr-doc' }); // positioned in page coordinates
  const fixedLayer = h('div', { class: 'gr-fixed' }); // positioned in viewport coordinates
  app.append(docLayer, fixedLayer);
  shadow.append(cssLink, app);

  function origin() {
    const r = host.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  function placeAt(el, x, y, w, hgt) {
    const o = origin();
    el.style.left = Math.round(x - o.x) + 'px';
    el.style.top = Math.round(y - o.y) + 'px';
    if (w != null) el.style.width = Math.round(w) + 'px';
    if (hgt != null) el.style.height = Math.round(hgt) + 'px';
  }

  function scrollToY(y) {
    window.scrollTo({ top: Math.max(0, Math.round(y)), behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // Height of the reviewer toolbar, so nothing is placed underneath it.
  let barEl = null;
  function barSpace() {
    if (!barEl || barEl.hidden) return 0;
    return barEl.getBoundingClientRect().height + (isPhone() ? 0 : 16);
  }

  let layoutFn = function () {};
  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      layoutFn();
    });
  }

  function watchLayout() {
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('load', scheduleLayout);
    if (window.ResizeObserver) new ResizeObserver(scheduleLayout).observe(document.body);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleLayout);
    // Catches accordions, lazy images and fade-ins that move things around.
    setInterval(scheduleLayout, 1500);

    // iOS keeps fixed elements behind the on-screen keyboard; lift them.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const onViewport = () => {
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        app.style.setProperty('--gr-kb', kb + 'px');
        app.classList.toggle('is-kb', kb > 80);
      };
      vv.addEventListener('resize', onViewport);
      vv.addEventListener('scroll', onViewport);
    }
  }

  // --- toast ------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;
  function toast(message, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    if (toastEl) toastEl.remove();
    const el = h('div', { class: 'gr-toast', role: 'status' },
      h('span', null, message),
      opts.action && h('button', { class: 'gr-btn gr-btn-small', type: 'button', onclick: opts.action.onClick }, opts.action.label));
    fixedLayer.append(el);
    toastEl = el;
    const close = () => {
      if (toastEl === el) toastEl = null;
      el.remove();
    };
    if (!opts.sticky) toastTimer = setTimeout(close, opts.duration || 3500);
    return close;
  }

  onStorageFail = function () {
    toast("This browser is not saving your comments. Please don't close this tab until you have sent your feedback.", { sticky: true, action: { label: 'OK', onClick: () => toastEl && toastEl.remove() } });
  };

  // --- floating card: modal (centered / bottom sheet) or popover ----------------

  let floating = null;
  function closeFloating() {
    if (floating) floating.close();
  }

  function openFloating(opts) {
    closeFloating();
    const asPopover = !!opts.near && !isPhone();
    let closed = false;
    const card = h('div', {
      class: 'gr-card' + (opts.wide ? ' is-wide' : '') + (asPopover ? ' is-popover' : ''),
      role: 'dialog',
      'aria-label': opts.title,
    },
    h('div', { class: 'gr-card-head' },
      h('h2', { class: 'gr-card-title' }, opts.title),
      h('button', { class: 'gr-icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, '×')),
    h('div', { class: 'gr-card-body' }, opts.body));

    let wrap = card;
    if (asPopover) {
      docLayer.append(card);
      positionPopover(card, opts.near);
    } else {
      wrap = h('div', { class: 'gr-backdrop', onclick: (e) => { if (e.target === wrap) close(); } }, card);
      fixedLayer.append(wrap);
      // Phone sheet for a spot on the page: keep that spot visible above it.
      if (opts.near) {
        const room = window.innerHeight - card.getBoundingClientRect().height;
        const onScreenY = opts.near.y - window.scrollY;
        if (onScreenY < 24 || onScreenY > room - 24) scrollToY(opts.near.y - Math.max(room / 2, 24));
      }
    }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    const onDown = (e) => {
      if (!e.composedPath().includes(card)) close();
    };
    document.addEventListener('keydown', onKey, true);
    if (asPopover) setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);

    function close() {
      if (closed) return;
      closed = true;
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      if (floating && floating.card === card) floating = null;
      if (opts.onClose) opts.onClose();
    }
    floating = { close, card };
    return floating;
  }

  function positionPopover(card, near) {
    const m = 12;
    const vw = document.documentElement.clientWidth;
    const w = card.offsetWidth;
    const th = card.offsetHeight;
    const x = clamp(near.x - w / 2, window.scrollX + m, window.scrollX + vw - w - m);
    let y = near.y + 22;
    const viewportBottom = window.scrollY + window.innerHeight - barSpace() - m;
    if (y + th > viewportBottom && near.y - 22 - th >= window.scrollY + m) y = near.y - 22 - th;
    placeAt(card, x, y);
  }

  // --- element picker (author steps and reviewer free pins) ---------------------

  function startPicking(opts) {
    const hoverBox = opts.hover ? h('div', { class: 'gr-hover' }, h('span', { class: 'gr-hover-label' })) : null;
    if (hoverBox) {
      hoverBox.hidden = true;
      docLayer.append(hoverBox);
    }
    const root = document.documentElement;
    const prevCursor = root.style.cursor;
    root.style.cursor = 'crosshair';
    const closeToast = toast(opts.message, { sticky: true, action: { label: 'Cancel', onClick: () => finish(true) } });

    const inUi = (e) => e.composedPath().includes(host);
    const block = (e) => {
      if (inUi(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onMove = (e) => {
      if (!hoverBox) return;
      if (inUi(e) || !(e.target instanceof Element)) { hoverBox.hidden = true; return; }
      const r = docRect(e.target);
      placeAt(hoverBox, r.x, r.y, r.w, r.h);
      const text = snippet(e.target);
      hoverBox.firstChild.textContent = e.target.tagName.toLowerCase() + (text ? ' · ' + shorten(text, 30) : '');
      hoverBox.hidden = false;
    };
    const onClick = (e) => {
      if (inUi(e)) return;
      block(e);
      if (!(e.target instanceof Element)) return;
      finish(false);
      opts.onPick(e.target, e);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    };
    const blocked = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'submit'];

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    blocked.forEach((t) => window.addEventListener(t, block, true));

    let done = false;
    function finish(cancelled) {
      if (done) return;
      done = true;
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      blocked.forEach((t) => window.removeEventListener(t, block, true));
      if (hoverBox) hoverBox.remove();
      root.style.cursor = prevCursor;
      closeToast();
      if (cancelled && opts.onCancel) opts.onCancel();
    }
    return finish;
  }

  function copyText(text) {
    const legacy = () => {
      const ta = h('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
      ta.value = text;
      fixedLayer.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    };
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true, legacy);
    }
    return Promise.resolve(legacy());
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: filename });
    fixedLayer.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function slug(s) {
    return squash(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
  }

  // Doc-coordinate point of a free pin.
  function pinPoint(pin) {
    const res = resolveAnchor(pin.anchor);
    const r = res.rect;
    const off = pin.offset || { x: 0.5, y: 0.5 };
    return { x: r.x + off.x * r.w, y: r.y + off.y * r.h, status: res.status };
  }

  function flash(rect) {
    const box = h('div', { class: 'gr-flash' });
    docLayer.append(box);
    placeAt(box, rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 12);
    setTimeout(() => box.remove(), 1800);
  }

  // Height of a fixed or sticky site header at the top of the screen, so an
  // element is never scrolled to where the header covers it.
  function topInset() {
    let inset = 0;
    const vw = document.documentElement.clientWidth;
    [8, vw / 2, vw - 8].forEach((x) => {
      document.elementsFromPoint(x, 2).forEach((el) => {
        if (isOurs(el)) return;
        for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
          const pos = getComputedStyle(e).position;
          if (pos !== 'fixed' && pos !== 'sticky') continue;
          const r = e.getBoundingClientRect();
          if (r.top <= 2 && r.bottom < window.innerHeight * 0.4) inset = Math.max(inset, r.bottom);
          break;
        }
      });
    });
    return Math.round(inset);
  }

  function scrollRectIntoView(rect) {
    const vh = window.innerHeight;
    const inset = topInset();
    const room = vh - inset;
    const visible = rect.y >= window.scrollY + inset + 16 && rect.y + rect.h <= window.scrollY + vh - 16;
    if (!visible) scrollToY(rect.h < room * 0.7 ? rect.y - inset - (room - rect.h) / 2 : rect.y - inset - 40);
  }

  // ===========================================================================
  // 5. Author mode
  // ===========================================================================

  function initAuthor() {
    let tour = normalizeTour(ls.get(KEY.draft, null));
    let feedback = null;
    try { feedback = normalizeFeedback(ls.get(KEY.authorFeedback, null)); } catch (e) { feedback = null; }
    let collapsed = ss.get(KEY.panel) === '1';
    let editing = null; // { step, el, isNew }
    let hoverStepId = null;
    let settingsOpen = false;
    let dragFrom = -1;

    const saveTour = () => ls.set(KEY.draft, tour);

    if (!tour) {
      tour = newTour();
      fetchTour().then((t) => {
        if (t && !ls.get(KEY.draft, null)) {
          tour = t;
          saveTour();
          render();
        }
      });
    }

    const panel = h('aside', { class: 'gr-panel', 'aria-label': 'Tour builder' });
    const pill = h('button', { class: 'gr-pill', type: 'button', onclick: () => setCollapsed(false) });
    const markers = h('div', { class: 'gr-markers' });
    const highlight = h('div', { class: 'gr-hl', hidden: true });
    docLayer.append(highlight, markers);
    fixedLayer.append(panel, pill);

    function setCollapsed(v) {
      collapsed = v;
      ss.set(KEY.panel, v ? '1' : '0');
      render();
    }

    const stepsHere = () => tour.steps.filter((s) => s.page === PAGE);
    const stepNumber = (s) => tour.steps.indexOf(s) + 1;
    const pageLabel = (key) => (tour.pages[key] && tour.pages[key].title) || key;

    function render() {
      panel.hidden = collapsed;
      pill.hidden = !collapsed;
      pill.replaceChildren('✎ Tour · ' + plural(tour.steps.length, 'step'));
      panel.replaceChildren(...[
        headView(),
        editing ? editorView() : pickView(),
        stepsView(),
        feedback && feedbackView(),
        settingsView(),
        actionsView(),
      ].filter(Boolean));
      renderMarkers();
      layout();
    }

    function headView() {
      return h('div', { class: 'gr-panel-head' },
        h('div', null,
          h('div', { class: 'gr-panel-title' }, 'Tour builder'),
          h('div', { class: 'gr-muted' }, 'This page: ' + pageTitle(tour.siteName) + '  (' + PAGE + ')')),
        h('button', { class: 'gr-icon-btn', type: 'button', 'aria-label': 'Collapse panel', title: 'Collapse', onclick: () => setCollapsed(true) }, '–'));
    }

    function pickView() {
      return h('button', { class: 'gr-btn gr-btn-primary gr-btn-block', type: 'button', onclick: startPick }, '+ Pick an element');
    }

    function editorView() {
      const s = editing.step;
      const n = editing.isNew ? tour.steps.length + 1 : stepNumber(s);
      const ta = h('textarea', {
        class: 'gr-textarea',
        rows: 4,
        placeholder: 'One or two sentences: what is this part for, and what should the client check?',
        'aria-label': 'Note for this step',
      });
      ta.value = editing.draft != null ? editing.draft : s.note;
      const counter = h('div', { class: 'gr-counter' });
      const save = h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => saveEditor(ta.value) }, 'Save step');
      const update = () => {
        const len = ta.value.trim().length;
        counter.textContent = len + ' / ' + NOTE_LIMIT + (len > NOTE_LIMIT ? ' — keep it to one or two sentences' : '');
        counter.classList.toggle('is-over', len > NOTE_LIMIT);
        counter.classList.toggle('is-near', len > NOTE_LIMIT * 0.9 && len <= NOTE_LIMIT);
        save.disabled = len === 0;
      };
      ta.addEventListener('input', () => {
        editing.draft = ta.value;
        update();
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEditor(ta.value);
      });
      update();
      setTimeout(() => ta.focus(), 0);

      const res = editing.el ? null : resolveAnchor(s.anchor);
      const clientSaid = feedback && feedback.stepComments[s.id];
      return h('div', { class: 'gr-editor' },
        h('div', { class: 'gr-editor-title' }, (editing.isNew ? 'New step ' : 'Step ') + n,
          h('span', { class: 'gr-muted' }, '  <' + s.anchor.tag + '> ' + (s.anchor.text ? '"' + shorten(s.anchor.text, 30) + '"' : ''))),
        res && res.status !== 'ok' && h('p', { class: 'gr-warn' }, res.status === 'hidden'
          ? 'This element is hidden right now. Saving keeps the old position.'
          : 'This element is no longer on the page. Delete the step and pick again.'),
        hasText(clientSaid) && h('div', { class: 'gr-client' }, h('strong', null, 'Client: '), clientSaid),
        ta,
        counter,
        h('div', { class: 'gr-row' },
          save,
          editing.el && editing.el.parentElement && editing.el.parentElement !== document.body &&
            h('button', { class: 'gr-btn', type: 'button', title: 'Select the element around this one', onclick: widen }, 'Select wider'),
          h('button', { class: 'gr-btn', type: 'button', onclick: cancelEditor }, 'Cancel'),
          !editing.isNew && h('button', { class: 'gr-btn gr-btn-danger', type: 'button', onclick: () => deleteStep(s) }, 'Delete')));
    }

    function stepsView() {
      if (!tour.steps.length) {
        return h('div', { class: 'gr-section' },
          h('h3', { class: 'gr-h3' }, 'Steps'),
          h('p', { class: 'gr-muted' }, 'No steps yet. Press "Pick an element", then click something on the page.'));
      }
      const list = h('ol', { class: 'gr-steps' });
      tour.steps.forEach((s, i) => {
        const here = s.page === PAGE;
        const res = here ? resolveAnchor(s.anchor) : null;
        const lost = res && res.status === 'unanchored';
        const commented = feedback && hasText(feedback.stepComments[s.id]);
        const li = h('li', {
          class: 'gr-step' + (here ? '' : ' is-elsewhere') + (lost ? ' is-lost' : '') + (editing && editing.step === s ? ' is-editing' : ''),
          draggable: true,
          ondragstart: (e) => {
            dragFrom = i;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(i));
            li.classList.add('is-dragging');
          },
          ondragend: () => {
            dragFrom = -1;
            list.querySelectorAll('.gr-step').forEach((x) => x.classList.remove('is-dragging', 'drop-before', 'drop-after'));
          },
          ondragover: (e) => {
            if (dragFrom < 0) return;
            e.preventDefault();
            const r = li.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            li.classList.toggle('drop-before', !after);
            li.classList.toggle('drop-after', after);
          },
          ondragleave: () => li.classList.remove('drop-before', 'drop-after'),
          ondrop: (e) => {
            e.preventDefault();
            if (dragFrom < 0) return;
            const r = li.getBoundingClientRect();
            moveStep(dragFrom, e.clientY > r.top + r.height / 2 ? i + 1 : i);
          },
          onmouseenter: () => { hoverStepId = s.id; layout(); },
          onmouseleave: () => { hoverStepId = null; layout(); },
        },
        h('span', { class: 'gr-grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '⋮⋮'),
        h('span', { class: 'gr-num' }, i + 1),
        h('button', { class: 'gr-step-main', type: 'button', onclick: () => goToStep(s, false) },
          h('span', { class: 'gr-step-title' }, s.title || shorten(s.note, 40)),
          h('span', { class: 'gr-step-note' }, s.note),
          (!here || lost || commented) && h('span', { class: 'gr-step-meta' }, [
            !here && 'On ' + pageLabel(s.page) + ' ↗',
            lost && '⚠ Not found on this page',
            commented && '💬 Client commented',
          ].filter(Boolean).join('  ·  '))),
        h('button', { class: 'gr-icon-btn', type: 'button', title: 'Edit note', 'aria-label': 'Edit step ' + (i + 1), onclick: () => goToStep(s, true) }, '✎'),
        h('button', { class: 'gr-icon-btn', type: 'button', title: 'Delete step', 'aria-label': 'Delete step ' + (i + 1), onclick: () => deleteStep(s) }, '×'));
        list.append(li);
      });
      return h('div', { class: 'gr-section' },
        h('h3', { class: 'gr-h3' }, 'Steps (' + tour.steps.length + ')', h('span', { class: 'gr-muted' }, ' · drag to reorder')),
        list);
    }

    function feedbackView() {
      const report = buildReport(feedback, tour);
      const mismatch = feedback.tourId && tour.tourId && feedback.tourId !== tour.tourId;
      return h('div', { class: 'gr-section gr-feedback' },
        h('h3', { class: 'gr-h3' }, 'Client feedback'),
        h('p', { class: 'gr-muted' },
          (feedback.reviewer || 'Name not given') + (feedback.date ? ' · ' + fmtDate(feedback.date) : '') +
          ' · ' + plural(report.total, 'comment') + ' across ' + plural(report.pages.length, 'page')),
        mismatch && h('p', { class: 'gr-warn' }, 'This feedback was made on an older export of the tour. Step numbers are the ones the client saw.'),
        report.pages.map((p) => h('div', { class: 'gr-fb-page' + (p.key === PAGE ? ' is-here' : '') },
          h('div', { class: 'gr-fb-page-title' }, p.title, h('span', { class: 'gr-muted' }, '  ' + p.path)),
          p.overall && h('div', { class: 'gr-fb-item' }, h('span', { class: 'gr-fb-label' }, 'Overall'), h('span', { class: 'gr-quote' }, p.overall)),
          p.items.map((it) => h('button', { class: 'gr-fb-item', type: 'button', onclick: () => showFeedbackItem(it) },
            h('span', { class: 'gr-fb-label' }, it.kind === 'step' ? 'Step ' + it.n + ' — "' + it.title + '"' : 'Free pin — ' + it.label +
              (it.pin.anchor ? '' : ' (no position in text summary)')),
            h('span', { class: 'gr-quote' }, it.text))))),
        h('div', { class: 'gr-row' },
          h('button', { class: 'gr-btn', type: 'button', onclick: () => copyText(summaryText(feedback, tour)).then((ok) => toast(ok ? 'Summary copied.' : 'Could not copy.')) }, 'Copy as text'),
          h('button', { class: 'gr-btn', type: 'button', onclick: closeFeedback }, 'Close feedback')));
    }

    function settingsView() {
      const field = (label, hint, value, onInput, attrs) => h('label', { class: 'gr-field' },
        h('span', { class: 'gr-label' }, label),
        h('input', Object.assign({ class: 'gr-input', value, oninput: (e) => onInput(e.target.value) }, attrs || {})),
        hint && h('span', { class: 'gr-hint' }, hint));
      const details = h('details', { class: 'gr-section gr-settings', ontoggle: () => { settingsOpen = details.open; } },
        h('summary', null, 'Tour settings'),
        field('Site name', 'Shown at the top of the summary.', tour.siteName, (v) => { tour.siteName = v; saveTour(); }),
        field('Your WhatsApp number', 'Country code and number, digits only, e.g. 60123456789. Optional.', tour.contact.whatsapp,
          (v) => { tour.contact.whatsapp = v; saveTour(); }, { inputmode: 'tel' }),
        field('Your email', 'Where the Email button sends feedback. Optional.', tour.contact.email,
          (v) => { tour.contact.email = v; saveTour(); }, { type: 'email' }));
      details.open = settingsOpen;
      return details;
    }

    function actionsView() {
      if (CONFIG.embedded) {
        // Inside the tool, the draft is saved as you go and Publish sends it.
        return h('div', { class: 'gr-section gr-actions' },
          h('p', { class: 'gr-muted' }, 'Saved as you go. Press Publish in the bar above to send the tour to the review site.'),
          h('div', { class: 'gr-row' },
            h('button', { class: 'gr-btn', type: 'button', onclick: openLoadFeedback }, 'Load feedback'),
            h('button', { class: 'gr-btn gr-btn-ghost', type: 'button', onclick: resetTour }, 'Clear tour…')));
      }
      return h('div', { class: 'gr-section gr-actions' },
        h('div', { class: 'gr-row' },
          h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: exportTour, disabled: !tour.steps.length }, 'Export tour'),
          h('button', { class: 'gr-btn', type: 'button', onclick: openLoadFeedback }, 'Load feedback')),
        h('div', { class: 'gr-row' },
          h('button', { class: 'gr-btn gr-btn-ghost', type: 'button', onclick: resetTour }, 'Reset draft…'),
          h('button', { class: 'gr-btn gr-btn-ghost', type: 'button', onclick: exitAuthor }, 'Exit author mode')));
    }

    // --- actions ---

    function startPick() {
      editing = null;
      closeFloating();
      render();
      // The panel fades out and lets clicks through, so it never hides a target.
      panel.classList.add('is-picking');
      startPicking({
        hover: true,
        message: 'Click any part of the page to add a step. Esc to cancel.',
        onCancel: () => panel.classList.remove('is-picking'),
        onPick: (el) => {
          panel.classList.remove('is-picking');
          editing = {
            isNew: true,
            el,
            step: { id: uid('s'), page: PAGE, path: PAGE, title: '', note: '', anchor: recordAnchor(el) },
          };
          render();
        },
      });
    }

    function goToStep(s, edit) {
      if (s.page !== PAGE) {
        ss.set(KEY.focus, (edit ? 'edit:' : 'step:') + s.id);
        location.href = pageUrl(s.page);
        return;
      }
      const res = resolveAnchor(s.anchor);
      scrollRectIntoView(res.rect);
      flash(res.rect);
      if (edit) {
        editing = { isNew: false, el: res.status === 'unanchored' ? null : res.el, step: s };
        render();
      }
    }

    function saveEditor(value) {
      const note = value.trim();
      if (!note || !editing) return;
      const s = editing.step;
      s.note = note;
      const el = editing.el && editing.el.isConnected ? editing.el : null;
      if (el) {
        // Re-recording heals a step that was only found by its text.
        if (docRect(el).w > 0) s.anchor = recordAnchor(el);
        s.title = titleFor(el, note);
      } else if (!s.title) {
        s.title = shorten(note, 50);
      }
      if (editing.isNew) tour.steps.push(s);
      tour.pages[PAGE] = { path: PAGE, title: pageTitle(tour.siteName) };
      saveTour();
      editing = null;
      render();
    }

    // A click lands on the innermost element; this steps out to its container.
    function widen() {
      const parent = editing.el.parentElement;
      if (!parent || parent === document.body) return;
      editing.el = parent;
      editing.step.anchor = recordAnchor(parent);
      render();
    }

    function cancelEditor() {
      editing = null;
      render();
    }

    function deleteStep(s) {
      if (!confirm('Delete step ' + stepNumber(s) + ' ("' + (s.title || shorten(s.note, 30)) + '")?')) return;
      tour.steps.splice(tour.steps.indexOf(s), 1);
      if (editing && editing.step === s) editing = null;
      saveTour();
      render();
    }

    function moveStep(from, to) {
      if (to > from) to--;
      if (from === to) { render(); return; }
      const [s] = tour.steps.splice(from, 1);
      tour.steps.splice(to, 0, s);
      saveTour();
      render();
    }

    function exportTour() {
      const used = new Set(tour.steps.map((s) => s.page));
      Object.keys(tour.pages).forEach((k) => { if (!used.has(k)) delete tour.pages[k]; });
      tour.tourId = 't-' + hash(JSON.stringify(tour.steps.map((s) => [s.id, s.page, s.note, s.anchor.selector])));
      saveTour();
      const out = Object.assign({ exportedAt: new Date().toISOString() }, tour);
      download('review-tour.json', JSON.stringify(out, null, 2) + '\n');
      toast('Saved review-tour.json. Put it in the review branch next to the pages (see README).', { duration: 6000 });
    }

    function openLoadFeedback() {
      const error = h('p', { class: 'gr-warn', hidden: true });
      const ta = h('textarea', { class: 'gr-textarea', rows: 8, placeholder: 'Paste the JSON file contents, or the text summary the client sent on WhatsApp or email.' });
      const file = h('input', {
        type: 'file',
        class: 'gr-file',
        accept: '.json,.txt,application/json,text/plain',
        onchange: () => {
          const f = file.files && file.files[0];
          if (!f) return;
          f.text().then((text) => { ta.value = text; load(); });
        },
      });
      const load = () => {
        try {
          feedback = parseFeedbackInput(ta.value, tour);
          ls.set(KEY.authorFeedback, feedback);
          card.close();
          render();
          toast('Feedback loaded. Comments are listed in the panel and pinned on the page.');
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
        }
      };
      const card = openFloating({
        title: 'Load client feedback',
        wide: true,
        body: [
          h('p', { class: 'gr-muted' }, 'Open the file the client downloaded, or paste what they sent you. The JSON file and the plain-text summary both work.'),
          h('label', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Feedback file'), file),
          h('label', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Or paste it here'), ta),
          error,
          h('div', { class: 'gr-row' }, h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: load }, 'Load')),
        ],
      });
    }

    function closeFeedback() {
      feedback = null;
      ls.del(KEY.authorFeedback);
      closeFloating();
      render();
    }

    function showFeedbackItem(it) {
      if (it.kind === 'step') {
        const s = tour.steps.find((x) => x.id === it.id);
        if (s) goToStep(s, false);
        else toast('That step is no longer in your tour.');
        return;
      }
      const pin = it.pin;
      if (!pin.anchor) { toast('This comment came from the text summary, so it has no position on the page.'); return; }
      if (pin.page !== PAGE) {
        ss.set(KEY.focus, 'pin:' + pin.id);
        location.href = pageUrl(pin.page);
        return;
      }
      const p = pinPoint(pin);
      scrollRectIntoView({ x: p.x, y: p.y - 100, w: 1, h: 200 });
      setTimeout(() => openPinView(pin), reduceMotion ? 0 : 350);
    }

    function openPinView(pin) {
      const p = pinPoint(pin);
      openFloating({
        title: 'Client comment',
        near: p,
        body: [
          h('p', { class: 'gr-muted' }, 'Free pin ' + pin.label),
          p.status === 'unanchored' && h('p', { class: 'gr-warn' }, 'The element has changed since; this is roughly where it was.'),
          h('div', { class: 'gr-quote' }, pin.text),
        ],
      });
    }

    function resetTour() {
      if (CONFIG.embedded) {
        if (!confirm('Delete every step of this tour? This cannot be undone.')) return;
        tour = newTour();
        editing = null;
        saveTour();
        render();
        return;
      }
      if (!confirm('Throw away your local draft? The tour is reloaded from the deployed review-tour.json, or starts empty if there is none.')) return;
      ls.del(KEY.draft);
      tour = newTour();
      editing = null;
      render();
      fetchTour().then((t) => {
        if (t) {
          tour = t;
          saveTour();
          render();
        }
      });
    }

    function exitAuthor() {
      ss.del(KEY.mode);
      location.href = location.pathname;
    }

    // --- markers on the page ---
    // Built on render, repositioned on every layout pass.

    let markerRefs = [];

    function renderMarkers() {
      markers.replaceChildren();
      markerRefs = [];
      stepsHere().forEach((s) => {
        const commented = feedback && hasText(feedback.stepComments[s.id]);
        const badge = h('button', {
          class: 'gr-marker' + (commented ? ' has-comment' : ''),
          type: 'button',
          title: 'Step ' + stepNumber(s) + ': ' + s.note,
          'aria-label': 'Edit step ' + stepNumber(s),
          onclick: () => goToStep(s, true),
        }, String(stepNumber(s)));
        markers.append(badge);
        markerRefs.push(() => {
          const res = resolveAnchor(s.anchor);
          badge.classList.toggle('is-lost', res.status !== 'ok');
          placeAt(badge, Math.max(res.rect.x - 12, 2), Math.max(res.rect.y - 12, 2));
        });
      });

      if (!feedback) return;
      feedback.freePins.filter((p) => p.page === PAGE && p.anchor && hasText(p.text)).forEach((pin, i) => {
        const m = h('button', {
          class: 'gr-marker is-pin',
          type: 'button',
          title: pin.text,
          'aria-label': 'Client comment ' + (i + 1),
          onclick: () => openPinView(pin),
        }, String(i + 1));
        markers.append(m);
        markerRefs.push(() => {
          const p = pinPoint(pin);
          m.classList.toggle('is-lost', p.status !== 'ok');
          placeAt(m, p.x - 14, p.y - 14);
        });
      });
    }

    function layout() {
      markerRefs.forEach((update) => update());
      let rect = null;
      if (editing) {
        rect = editing.el && editing.el.isConnected ? docRect(editing.el) : resolveAnchor(editing.step.anchor).rect;
      } else if (hoverStepId) {
        const s = stepsHere().find((x) => x.id === hoverStepId);
        if (s) rect = resolveAnchor(s.anchor).rect;
      }
      highlight.hidden = !rect;
      if (rect) placeAt(highlight, rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8);
    }

    layoutFn = layout;
    render();

    // Arriving from "edit"/"show" on another page.
    const focus = ss.get(KEY.focus);
    if (focus) {
      ss.del(KEY.focus);
      const [kind, id] = [focus.slice(0, focus.indexOf(':')), focus.slice(focus.indexOf(':') + 1)];
      setTimeout(() => {
        if (kind === 'pin' && feedback) {
          const pin = feedback.freePins.find((p) => p.id === id);
          if (pin) showFeedbackItem({ kind: 'pin', pin });
        } else {
          const s = tour.steps.find((x) => x.id === id);
          if (s && s.page === PAGE) goToStep(s, kind === 'edit');
        }
      }, 400);
    }
  }

  // ===========================================================================
  // 6. Reviewer mode
  // ===========================================================================

  function initReviewer() {
    const STORE = KEY.review(MODE);
    const saved = ls.get(STORE, {}) || {};
    const state = {
      welcomed: !!saved.welcomed,
      touring: !!saved.touring,
      finished: !!saved.finished,
      stepIndex: Number(saved.stepIndex) || 0,
      fb: Object.assign(emptyFeedback(), saved.fb || {}),
    };
    const fb = state.fb;
    const save = () => ls.set(STORE, state);

    let tour = newTour();
    let tourFailed = false;
    let steps = [];
    let tipVisible = false;
    let pinning = false;
    let pinsNeedRender = true;

    const spot = h('div', { class: 'gr-spot', hidden: true });
    const runway = h('div', { class: 'gr-runway', hidden: true });
    const pinLayer = h('div', { class: 'gr-markers' });
    const bar = h('div', { class: 'gr-bar', role: 'toolbar', 'aria-label': 'Review tools' });
    let tip = null;
    let tipWarn = null;
    barEl = bar;
    docLayer.append(spot, runway, pinLayer);
    fixedLayer.append(bar);

    function registerPage() {
      fb.pages[PAGE] = { path: PAGE, title: pageTitle(tour.siteName) };
    }

    const pageName = (key) => (tour.pages[key] && tour.pages[key].title) || key;

    // --- toolbar ---

    function barButton(name, label, opts) {
      return h('button', {
        class: 'gr-bar-btn' + (opts.primary ? ' is-primary' : '') + (opts.active ? ' is-active' : '') + (opts.dot ? ' has-dot' : ''),
        type: 'button',
        'aria-pressed': opts.pressable ? String(!!opts.active) : null,
        'aria-label': opts.aria || label,
        onclick: opts.onClick,
      }, icon(name), h('span', { class: 'gr-bar-label' }, label));
    }

    function renderBar() {
      const n = steps.length;
      bar.replaceChildren(...[
        n > 0 && barButton('tour', 'Tour ' + (state.stepIndex + 1) + '/' + n, {
          active: tipVisible,
          pressable: true,
          aria: tipVisible ? 'Hide the tour' : 'Show the tour, step ' + (state.stepIndex + 1) + ' of ' + n,
          onClick: () => (tipVisible ? pauseTour() : goStep(state.stepIndex)),
        }),
        barButton('pin', 'Add a comment', { active: pinning, onClick: startPin }),
        barButton('page', 'This page', { dot: hasText(fb.pageComments[PAGE]), aria: 'Comment on this page as a whole', onClick: openPageBox }),
        barButton('send', 'Send feedback', { primary: true, onClick: openSummary }),
      ].filter(Boolean));
    }

    // --- welcome ---

    function showWelcome() {
      const n = steps.length;
      const pages = new Set(steps.map((s) => s.page)).size;
      const minutes = Math.max(5, Math.ceil((n * 0.75 + pages * 1.5) / 5) * 5);
      const start = () => {
        state.welcomed = true;
        save();
        card.close();
        if (n) goStep(state.stepIndex);
      };
      const card = openFloating({
        title: 'Website review',
        onClose: () => {
          state.welcomed = true;
          save();
          renderBar();
        },
        body: [
          h('p', null, 'This is a guided walk through ' + tour.siteName + '. I have left short notes on the parts I would like you to look at.'),
          tourFailed && h('p', { class: 'gr-warn' }, 'The guided tour could not be loaded, but you can still leave comments anywhere on the site.'),
          h('ul', { class: 'gr-list' },
            n > 0 && h('li', null, plural(n, 'stop') + ' across ' + plural(pages, 'page') + ' — about ' + minutes + ' minutes.'),
            n > 0 && h('li', null, 'At each stop, read my note and write a comment if you have one. Leaving it empty is fine.'),
            h('li', null, 'To comment on anything else, press "Add a comment", then tap the spot on the page.'),
            h('li', null, 'For thoughts about a whole page — too long, wrong order, something missing — press "This page".'),
            h('li', null, 'Everything is saved on this device as you go. You can stop and come back later.')),
          h('p', { class: 'gr-strong' }, 'Nothing is sent to me until you press "Send feedback".'),
          h('div', { class: 'gr-row' },
            h('button', { class: 'gr-btn gr-btn-primary gr-btn-lg', type: 'button', onclick: start }, n ? 'Start the tour' : 'Start')),
        ],
      });
    }

    // --- tour ---

    function goStep(i) {
      if (!steps.length) return;
      closeFloating();
      state.stepIndex = clamp(i, 0, steps.length - 1);
      state.touring = true;
      save();
      const s = steps[state.stepIndex];
      if (s.page !== PAGE) {
        hideStep();
        toast('Opening the ' + pageName(s.page) + ' page…', { sticky: true });
        location.href = pageUrl(s.page);
        return;
      }
      showStep(true);
    }

    function hideStep() {
      tipVisible = false;
      spot.hidden = true;
      runway.hidden = true;
      if (tip) tip.remove();
      tip = null;
      renderBar();
    }

    function pauseTour() {
      state.touring = false;
      save();
      hideStep();
    }

    function finishTour() {
      state.touring = false;
      state.finished = true;
      save();
      hideStep();
      const card = openFloating({
        title: 'That is the end of the tour',
        body: [
          h('p', null, 'Thank you! Is there anything I did not ask about? You can add a comment anywhere on the site, or a note about a whole page.'),
          h('p', null, 'When you are done, press "Send feedback".'),
          h('div', { class: 'gr-row' },
            h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => { card.close(); openSummary(); } }, 'Send feedback now'),
            h('button', { class: 'gr-btn', type: 'button', onclick: () => card.close() }, 'Keep looking')),
        ],
      });
    }

    function buildTip(s) {
      const i = state.stepIndex;
      const n = steps.length;
      const last = i === n - 1;
      const next = steps[i + 1];
      const ta = h('textarea', {
        class: 'gr-textarea',
        rows: 3,
        'aria-label': 'Your comment on this part (optional)',
        oninput: () => {
          fb.stepComments[s.id] = ta.value;
          save();
        },
      });
      ta.value = fb.stepComments[s.id] || '';
      tipWarn = h('p', { class: 'gr-warn', hidden: true });

      const el = h('div', { class: 'gr-tip', role: 'dialog', 'aria-label': 'Tour stop ' + (i + 1) + ' of ' + n },
        h('div', { class: 'gr-tip-head' },
          h('button', {
            class: 'gr-tip-title',
            type: 'button',
            'aria-label': 'Show or hide the note',
            onclick: () => {
              if (!isPhone()) return;
              el.classList.toggle('is-min');
              scheduleLayout();
            },
          }, h('span', null, s.title || 'Stop ' + (i + 1)), h('span', { class: 'gr-tip-caret', 'aria-hidden': 'true' })),
          h('button', { class: 'gr-icon-btn', type: 'button', title: 'Pause the tour', 'aria-label': 'Pause the tour', onclick: pauseTour }, '×')),
        h('div', { class: 'gr-tip-body' },
          h('p', { class: 'gr-note' }, s.note),
          tipWarn,
          h('label', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Your comment (optional)'), ta),
          next && next.page !== s.page && h('p', { class: 'gr-hint' }, 'The next stop is on the ' + pageName(next.page) + ' page.')),
        h('div', { class: 'gr-tip-foot' },
          h('button', { class: 'gr-btn', type: 'button', disabled: i === 0, onclick: () => goStep(i - 1) }, '← Previous'),
          h('span', { class: 'gr-count', 'aria-live': 'polite' }, (i + 1) + ' / ' + n),
          h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => (last ? finishTour() : goStep(i + 1)) }, last ? 'Finish' : 'Next →')));
      return el;
    }

    function showStep(scroll) {
      const s = steps[state.stepIndex];
      if (!s || s.page !== PAGE) return;
      closeFloating();
      if (tip) tip.remove();
      tip = buildTip(s);
      tipVisible = true;
      renderBar();
      positionStep(scroll);
    }

    function positionStep(scroll) {
      if (!tipVisible || !tip) return;
      const s = steps[state.stepIndex];
      const res = resolveAnchor(s.anchor);
      const pad = 6;
      const R = { x: res.rect.x - pad, y: res.rect.y - pad, w: res.rect.w + pad * 2, h: res.rect.h + pad * 2 };

      spot.classList.toggle('is-lost', res.status !== 'ok');
      placeAt(spot, R.x, R.y, R.w, R.h);
      spot.hidden = false;

      tipWarn.hidden = res.status === 'ok';
      tipWarn.textContent = res.status === 'hidden'
        ? 'This part is hidden right now — it may be inside a menu or a closed section. The box shows roughly where it is.'
        : 'This part of the page has changed since I wrote this note, so the box only shows roughly where it was.';

      // Extra scroll room at the bottom, so the last elements can still be
      // brought above the tooltip.
      const doc = measureDoc();
      placeAt(runway, 0, doc.h, 1, window.innerHeight * 0.8);
      runway.hidden = false;

      if (isPhone()) placeSheet(R, scroll);
      else placeTip(R, scroll);
    }

    // Desktop: beside the element, never over it.
    function placeTip(R, scroll) {
      if (tip.parentNode !== docLayer) docLayer.append(tip);
      tip.classList.remove('is-sheet', 'is-min');
      tip.style.maxHeight = '';
      tip.style.left = '0px';
      tip.style.top = '0px';
      const w = tip.offsetWidth;
      const th = tip.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const sx = window.scrollX;
      const m = 12;
      const gap = 12;
      const bottomSpace = barSpace();
      const inset = topInset();
      const avail = vh - m * 2 - bottomSpace - inset;
      const midX = clamp(R.x + R.w / 2 - w / 2, sx + m, sx + vw - w - m);
      let x;
      let y;
      let focusTop;

      if (R.h + gap + th <= avail) {
        // Element and tooltip fit on screen together: tooltip below.
        x = midX;
        y = R.y + R.h + gap;
        focusTop = R.y - m - inset - (avail - (R.h + gap + th)) / 2;
      } else if (sx + vw - (R.x + R.w) >= w + gap + m) {
        x = R.x + R.w + gap;
        y = R.y;
        focusTop = R.y - m - inset;
      } else if (R.x - sx >= w + gap + m) {
        x = R.x - gap - w;
        y = R.y;
        focusTop = R.y - m - inset;
      } else if (R.y >= th + gap + m) {
        x = midX;
        y = R.y - gap - th;
        focusTop = y - m - inset;
      } else {
        x = midX;
        y = R.y + R.h + gap;
        focusTop = y + th + m + bottomSpace - vh;
      }
      placeAt(tip, x, y);

      if (scroll) {
        const top = Math.min(R.y, y);
        const bottom = Math.max(R.y + R.h, y + th);
        const onScreen = top >= window.scrollY + m + inset && bottom <= window.scrollY + vh - bottomSpace - m;
        if (!onScreen) scrollToY(focusTop);
      }
    }

    // Phone: a sheet above the toolbar; the element is scrolled into the space
    // above it. The sheet can be folded down to its title bar.
    function placeSheet(R, scroll) {
      if (tip.parentNode !== fixedLayer) fixedLayer.append(tip);
      tip.classList.add('is-sheet');
      tip.style.left = '';
      tip.style.top = '';
      // The element gets its room first; the sheet scrolls inside what is left.
      // Only an element taller than most of the screen can end up underneath.
      const inset = topInset();
      const avail = window.innerHeight - barSpace() - inset;
      tip.style.maxHeight = Math.round(clamp(avail - R.h - 24, Math.min(200, avail * 0.5), avail * 0.6)) + 'px';
      if (!scroll) return;
      const sheetTop = window.innerHeight - tip.offsetHeight - barSpace();
      const onScreen = R.y >= window.scrollY + inset + 8 && R.y + R.h <= window.scrollY + sheetTop - 8;
      if (!onScreen) {
        const room = sheetTop - inset - 16;
        scrollToY(R.h < room ? R.y - inset - Math.max(8, (room - R.h) / 3) : R.y - inset - 8);
      }
    }

    // --- free pins ---

    function pagePins() {
      return fb.freePins.filter((p) => p.page === PAGE);
    }

    function layoutPins() {
      if (pinsNeedRender) {
        pinLayer.replaceChildren();
        pagePins().forEach((pin, i) => {
          pinLayer.append(h('button', {
            class: 'gr-marker is-pin',
            type: 'button',
            'data-id': pin.id,
            'aria-label': 'Your comment ' + (i + 1) + ': ' + pin.text,
            title: pin.text,
            onclick: () => openPinEditor(pin, false),
          }, String(i + 1)));
        });
        pinsNeedRender = false;
      }
      pagePins().forEach((pin) => {
        const m = pinLayer.querySelector('[data-id="' + pin.id + '"]');
        if (!m) return;
        const p = pinPoint(pin);
        m.classList.toggle('is-lost', p.status !== 'ok');
        placeAt(m, p.x - 14, p.y - 14);
      });
    }

    function renderPins() {
      pinsNeedRender = true;
      layoutPins();
    }

    function startPin() {
      if (pinning) return;
      const resume = tipVisible;
      if (tipVisible) hideStep();
      closeFloating();
      pinning = true;
      renderBar();
      startPicking({
        hover: false,
        message: isPhone() ? 'Tap the spot you want to comment on.' : 'Click the spot you want to comment on.',
        onPick: (el, e) => {
          pinning = false;
          const r = docRect(el);
          const pin = {
            id: uid('p'),
            page: PAGE,
            path: PAGE,
            anchor: recordAnchor(el),
            offset: {
              x: round4(r.w ? clamp((e.pageX - r.x) / r.w, 0, 1) : 0.5),
              y: round4(r.h ? clamp((e.pageY - r.y) / r.h, 0, 1) : 0.5),
            },
            label: describeNear(el),
            text: '',
            created: new Date().toISOString(),
          };
          fb.freePins.push(pin);
          registerPage();
          save();
          renderPins();
          renderBar();
          openPinEditor(pin, resume);
        },
        onCancel: () => {
          pinning = false;
          renderBar();
          if (resume) showStep(false);
        },
      });
    }

    function openPinEditor(pin, resumeTour) {
      const ta = h('textarea', {
        class: 'gr-textarea',
        rows: 4,
        'aria-label': 'Your comment',
        placeholder: 'What would you like to say about this?',
        oninput: () => {
          pin.text = ta.value;
          save();
        },
      });
      ta.value = pin.text;
      const remove = () => {
        const i = fb.freePins.indexOf(pin);
        if (i >= 0) fb.freePins.splice(i, 1);
        save();
      };
      const card = openFloating({
        title: 'Your comment',
        near: pinPoint(pin),
        onClose: () => {
          if (!hasText(pin.text)) remove();
          renderPins();
          if (resumeTour && state.touring) showStep(false);
        },
        body: [
          h('p', { class: 'gr-muted' }, 'On this page, ' + pin.label + '.'),
          ta,
          h('p', { class: 'gr-hint' }, 'Saved on this device as you type.'),
          h('div', { class: 'gr-row' },
            h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => card.close() }, 'Done'),
            h('button', { class: 'gr-btn gr-btn-danger', type: 'button', onclick: () => { pin.text = ''; card.close(); } }, 'Delete')),
        ],
      });
      if (!isPhone() || !pin.text) setTimeout(() => ta.focus(), 30);
    }

    // --- page-level comment ---

    function openPageBox() {
      const resume = tipVisible;
      if (tipVisible) hideStep();
      const ta = h('textarea', {
        class: 'gr-textarea',
        rows: 7,
        'aria-label': 'Anything about this page as a whole?',
        oninput: () => {
          fb.pageComments[PAGE] = ta.value;
          registerPage();
          save();
          renderBar();
        },
      });
      ta.value = fb.pageComments[PAGE] || '';
      const card = openFloating({
        title: 'This page: ' + pageTitle(tour.siteName),
        onClose: () => { if (resume && state.touring) showStep(false); },
        body: [
          h('label', { class: 'gr-field' },
            h('span', { class: 'gr-label gr-label-lg' }, 'Anything about this page as a whole?'),
            h('span', { class: 'gr-hint' }, 'For example: too long, wrong order, something missing, hard to follow. Anything goes.'),
            ta),
          h('p', { class: 'gr-hint' }, 'Saved on this device as you type.'),
          h('div', { class: 'gr-row' }, h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => card.close() }, 'Done')),
        ],
      });
      if (!isPhone()) setTimeout(() => ta.focus(), 30);
    }

    // --- summary ---

    function exportFeedback() {
      const keep = (o) => {
        const out = {};
        Object.keys(o).forEach((k) => { if (hasText(o[k])) out[k] = o[k].trim(); });
        return out;
      };
      const stepRefs = {};
      steps.forEach((s, i) => {
        if (hasText(fb.stepComments[s.id])) stepRefs[s.id] = { n: i + 1, title: s.title || shorten(s.note, 40), page: s.page, note: s.note };
      });
      return {
        format: FEEDBACK_FORMAT,
        version: FORMAT_VERSION,
        tourId: tour.tourId,
        siteName: tour.siteName,
        reviewer: squash(fb.reviewer),
        date: new Date().toISOString(),
        // The author's page names win over the browser tab title.
        pages: Object.assign({}, fb.pages, tour.pages),
        stepRefs,
        stepComments: keep(fb.stepComments),
        freePins: fb.freePins.filter((p) => hasText(p.text)).map((p) => Object.assign({}, p, { text: p.text.trim() })),
        pageComments: keep(fb.pageComments),
      };
    }

    function shareLinks(text) {
      const encoded = encodeURIComponent(text);
      const long = encoded.length > SHARE_URL_LIMIT;
      const intro = 'Website review — ' + tour.siteName + ' (my comments are pasted below)\n\n';
      const body = long ? intro : text;
      const number = (tour.contact.whatsapp || '').replace(/\D/g, '');
      const email = (tour.contact.email || '').replace(/[^\w.+@-]/g, '');
      return {
        long,
        whatsapp: 'https://wa.me/' + number + '?text=' + encodeURIComponent(body),
        email: 'mailto:' + email + '?subject=' + encodeURIComponent('Website review — ' + tour.siteName) + '&body=' + encodeURIComponent(body),
      };
    }

    function openSummary() {
      if (tipVisible) pauseTour();
      let text = '';
      let links = null;
      const name = h('input', {
        class: 'gr-input',
        type: 'text',
        autocomplete: 'name',
        placeholder: 'Your name',
        value: fb.reviewer,
        oninput: () => {
          fb.reviewer = name.value;
          save();
          refresh();
        },
      });
      const pre = h('pre', { class: 'gr-summary', tabindex: '0' });
      const count = h('p', { class: 'gr-muted' });

      // Long summaries do not fit in a link; they go to the clipboard first.
      const onShare = () => {
        if (!links.long) return;
        copyText(text);
        toast('Your comments are long, so they have been copied. In the message, press and hold, then choose Paste.', { duration: 9000 });
      };
      const wa = h('a', { class: 'gr-btn gr-share', target: '_blank', rel: 'noopener', onclick: onShare }, icon('chat'), 'WhatsApp');
      const mail = h('a', { class: 'gr-btn gr-share', onclick: onShare }, icon('mail'), 'Email');
      const copy = h('button', {
        class: 'gr-btn gr-share',
        type: 'button',
        onclick: () => copyText(text).then((ok) => toast(ok ? 'Copied. Paste it into a message to me.' : 'Could not copy. Please select the text above and copy it.')),
      }, icon('copy'), 'Copy text');
      const dl = h('button', {
        class: 'gr-btn gr-share',
        type: 'button',
        onclick: () => {
          const out = exportFeedback();
          download('review-feedback-' + slug(out.reviewer || tour.siteName) + '-' + out.date.slice(0, 10) + '.json', JSON.stringify(out, null, 2) + '\n');
        },
      }, icon('download'), 'Download file');

      function refresh() {
        const out = exportFeedback();
        const report = buildReport(out, tour);
        text = summaryText(out, tour);
        links = shareLinks(text);
        pre.textContent = text;
        count.textContent = report.total
          ? plural(report.total, 'comment') + ' across ' + plural(report.pages.length, 'page') + '.'
          : 'You have not written any comments yet.';
        wa.href = links.whatsapp;
        mail.href = links.email;
      }
      refresh();

      openFloating({
        title: 'Send your feedback',
        wide: true,
        body: [
          h('label', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Your name'), name),
          h('div', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Your comments'), pre, count),
          h('div', { class: 'gr-field' },
            h('span', { class: 'gr-label' }, 'Send them to me with any one of these'),
            h('div', { class: 'gr-share-grid' }, copy, wa, mail, dl)),
          h('p', { class: 'gr-hint' }, 'Nothing is sent automatically. Your comments stay saved on this device, so you can close this and add more later.'),
        ],
      });
    }

    // --- start ---

    layoutFn = () => {
      if (tipVisible) positionStep(false);
      layoutPins();
    };

    fetchTour().then((t) => {
      if (t) tour = t;
      else tourFailed = true;
      steps = tour.steps;
      state.stepIndex = clamp(state.stepIndex, 0, Math.max(steps.length - 1, 0));
      renderBar();
      renderPins();
      if (!state.welcomed) {
        showWelcome();
      } else if (state.touring && steps[state.stepIndex] && steps[state.stepIndex].page === PAGE) {
        // Wait for the page to settle before measuring and scrolling.
        setTimeout(() => showStep(true), 250);
      }
      if (!storageOk) onStorageFail();
    });
  }

  // ===========================================================================
  // 7. Boot
  // ===========================================================================

  // Forms must not really send anything while a page is being reviewed. The
  // site's own validation still runs; only the submission is stopped.
  function holdForms() {
    window.addEventListener('submit', (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      toast('Forms are not sent during the review.');
    });
  }

  function boot() {
    document.body.append(host);
    watchLayout();
    holdForms();
    if (IS_AUTHOR) initAuthor();
    else initReviewer();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
