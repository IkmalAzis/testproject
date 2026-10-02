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
 *   data-spa       the project is a single-page app that routes itself
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
    // A single-page app (React, Vue…): one index.html that routes itself.
    spa: !!(SCRIPT && SCRIPT.hasAttribute('data-spa')),
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
    panelScroll: 'gr:author:panel-scroll',
    panelPos: 'gr:author:panel-position',
    activeFeedback: 'gr:author:active-feedback',
    draft: 'gr:author:draft',
    authorFeedback: 'gr:author:feedback',
    review: (token) => 'gr:review:' + token,
  };

  // The page guards "gr:" keys from the site's own scripts (storageGuardTag);
  // the engine removes its keys through the original removeItem it keeps.
  const removeKey = (store, key) => (Storage.prototype.__grRemove || Storage.prototype.removeItem).call(store, key);

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
      try { removeKey(localStorage, key); } catch (e) { /* nothing to do */ }
    },
  };
  const ss = {
    get(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch (e) { /* nothing to do */ } },
    del(key) { try { removeKey(sessionStorage, key); } catch (e) { /* nothing to do */ } },
  };
  try {
    localStorage.setItem('gr:test', '1');
    removeKey(localStorage, 'gr:test');
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
  // The tool's "Client view": the real client UI, but nothing typed is sent.
  const IS_PREVIEW = CONFIG.embedded && !IS_AUTHOR;

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
    if (CONFIG.spa) {
      // An app's own routes keep their shape: "about", "products/12".
      p = p.replace(/\/+$/, '');
      return p === '' || /^index\.html?$/i.test(p) ? 'index.html' : p;
    }
    if (p === '' || p.endsWith('/')) p += 'index.html';
    if (!/\.[a-z0-9]+$/i.test(p)) p += '.html';
    return p;
  }

  // Apps with hash routes (#/about) are told apart by the hash too.
  function currentPage() {
    const key = pageKey(location.pathname);
    return CONFIG.spa && /^#\//.test(location.hash) ? key + location.hash : key;
  }
  let PAGE = currentPage();

  // A single-page app changes route without loading a page. Watch for it, so
  // the steps and pins of the new route show up.
  const routeListeners = [];
  const onRoute = (fn) => routeListeners.push(fn);
  if (CONFIG.spa) {
    const check = () => {
      const key = currentPage();
      if (key === PAGE) return;
      PAGE = key;
      routeListeners.forEach((fn) => fn());
    };
    ['pushState', 'replaceState'].forEach((m) => {
      const original = history[m];
      history[m] = function () {
        const result = original.apply(this, arguments);
        setTimeout(check, 0);
        return result;
      };
    });
    window.addEventListener('popstate', check);
    window.addEventListener('hashchange', check);
  }

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
    if (rest[0]) return rest[0];
    // An app often keeps one tab title on every route: name the route instead.
    if (CONFIG.spa) return routeName(PAGE);
    return raw || PAGE;
  }

  // "about" -> "About", "products/12" -> "Products / 12", "index.html#/team" -> "Team".
  function routeName(key) {
    const words = key.replace(/^index\.html?/i, '').replace(/^#?\/?/, '').split('/').filter(Boolean)
      .map((w) => w.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()));
    return words.join(' / ') || 'Home';
  }

  // URL of another page of the project. A mode set by data-mode needs no
  // query string; one from ?review= is carried along.
  function pageUrl(key) {
    const fromAttr = SCRIPT && SCRIPT.dataset.mode === MODE;
    const hashAt = key.indexOf('#');
    let path = hashAt < 0 ? key : key.slice(0, hashAt);
    if (CONFIG.spa && path === 'index.html') path = ''; // an app's home route is "/"
    return CONFIG.root + path.split('/').map(encodeURIComponent).join('/') +
      (fromAttr ? '' : '?review=' + encodeURIComponent(MODE)) +
      (hashAt < 0 ? '' : key.slice(hashAt));
  }

  // Waits (up to a few seconds) for a step's elements to be on the page: an
  // app draws them after it loads.
  function whenOnPage(step, cb) {
    const started = Date.now();
    const tryNow = () => {
      if (resolveAnchor(step.anchor).status === 'ok' || Date.now() - started > 4000) cb();
      else setTimeout(tryNow, 200);
    };
    tryNow();
  }

  // --- data model ---------------------------------------------------------------
  //
  // Tour (exported by the author, shipped as review-tour.json):
  //   { format, version, tourId, siteName, contact: { whatsapp, email },
  //     pages: { [pageKey]: { path, title } },
  //     steps: [ { id, page, path, title, note, anchor } ] }
  //   page and path are both the page key, e.g. "about.html".
  //   extra: more anchors highlighted together with `anchor` (optional).
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
          // More elements shown together with the first one (e.g. a row of logos).
          extra: Array.isArray(s.extra) ? s.extra.filter(validAnchor) : [],
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

  // Where a pin is, in words, from the closest thing with text to the spot:
  // on "Send briefing" button, right of "Send briefing" button, below "Leadership" heading.
  const SPOT_TARGETS = 'a, button, h1, h2, h3, h4, h5, h6, p, li, label, img, input, textarea, select, ' +
    'figcaption, dt, dd, th, td, blockquote, [role="button"]';

  function describeSpot(el, x, y) {
    const scope = el.closest('section, article, form, header, footer, nav, aside, main') || document.body;
    let best = null;
    // A wrapper whose only text is its children's (the box around a button)
    // would claim "on" for a spot that is really next to the button.
    const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.nodeValue.trim());
    const candidates = Array.from(scope.querySelectorAll(SPOT_TARGETS));
    if (ownText && !candidates.includes(el)) candidates.unshift(el);
    candidates.forEach((c) => {
      if (isOurs(c)) return;
      const text = snippet(c);
      if (!text) return;
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const role = roleWord(c);
      // Pages flow downwards, so something beside the spot counts as nearer than
      // something the same distance above or below; named things (button, link…)
      // get a little extra pull. On a tie: named first, then the smallest.
      const score = [Math.max(0, Math.hypot(dx, dy * 3) - (role ? 12 : 0)), role ? 0 : 1, r.width * r.height];
      const better = !best || score[0] < best.score[0] - 0.5 ||
        (Math.abs(score[0] - best.score[0]) <= 0.5 && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])));
      if (better) best = { score, text, role, r, dx: Math.sign(x < r.left ? -1 : x > r.right ? 1 : 0), dy: Math.sign(y < r.top ? -1 : y > r.bottom ? 1 : 0), ax: dx, ay: dy };
    });
    if (!best || best.score[0] > 240) return describeNear(el);
    const what = '"' + shorten(best.text, 32) + '"' + (best.role ? ' ' + best.role : '');
    let where = 'on';
    if (best.dx || best.dy) {
      where = best.ax >= best.ay
        ? (best.dx < 0 ? 'left of' : 'right of')
        : (best.dy < 0 ? 'above' : 'below');
    }
    return where + ' ' + what;
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

  // Free pin positions packed into one line at the end of the text summary,
  // so pins come back to their exact spot when the text is loaded again.
  const PIN_LINE = 'Pin positions (for the review tool, please keep this line): GR1 ';

  const packSelector = (sel) => sel.replace(/:nth-of-type\((\d+)\)/g, '~$1').replace(/ > /g, '>');
  const unpackSelector = (sel) => sel.replace(/>/g, ' > ').replace(/~(\d+)/g, ':nth-of-type($1)');

  function encodePins(pins) {
    const bytes = new TextEncoder().encode(JSON.stringify(pins.map((p) => {
      if (!p.anchor) return 0;
      const a = p.anchor;
      const o = p.offset || { x: 0.5, y: 0.5 };
      return [packSelector(a.selector), a.tag, a.text, a.fx, a.fy, a.fw, a.fh, o.x, o.y];
    })));
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  function decodePins(code) {
    try {
      const bin = atob(code);
      const list = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      return list.map((v) => (Array.isArray(v) ? {
        anchor: { selector: unpackSelector(String(v[0])), tag: String(v[1]), text: String(v[2] || ''), fx: +v[3], fy: +v[4], fw: +v[5], fh: +v[6] },
        offset: { x: +v[7], y: +v[8] },
      } : null));
    } catch (e) {
      return [];
    }
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
    const pins = [];
    report.pages.forEach((p) => p.items.forEach((it) => { if (it.kind === 'pin') pins.push(it.pin); }));
    if (pins.some((p) => p.anchor)) out.push('', PIN_LINE + encodePins(pins));
    return out.join('\n');
  }

  // Reads the plain-text summary back (e.g. copied out of WhatsApp). Free pins
  // get their exact spot from the pin line at the end, when it is there.
  function parseSummaryText(text, tour) {
    const fb = emptyFeedback();
    let key = null;
    let cur = null; // { o, k } — where continuation lines are appended
    let pinSpots = [];
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
      } else if ((m = line.match(/GR1\s+([A-Za-z0-9+/=]+)/))) {
        pinSpots = decodePins(m[1]);
        cur = null;
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
    // The pin line lists the pins in the order the summary shows them.
    fb.freePins.forEach((pin, i) => {
      const spot = pinSpots[i];
      if (spot) {
        pin.anchor = spot.anchor;
        pin.offset = spot.offset;
      }
    });
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

  // A few seconds of "move here, click, a pin appears", shown the first time
  // someone adds a comment. Pure CSS animation; it never takes clicks.
  function pinDemo() {
    const el = h('div', { class: 'gr-demo', 'aria-hidden': 'true' });
    el.innerHTML =
      '<div class="gr-demo-page">' +
        '<i class="gr-demo-line w1"></i><i class="gr-demo-line w2"></i><i class="gr-demo-block"></i><i class="gr-demo-line w3"></i>' +
        '<span class="gr-demo-ripple"></span><span class="gr-demo-pin">1</span>' +
        '<span class="gr-demo-bubble"><i></i><i></i></span>' +
      '</div>' +
      '<span class="gr-demo-pointer"><svg viewBox="0 0 16 22" width="16" height="22"><path d="M1 1v17l4.5-4.2 3 6.7 2.8-1.3-3-6.6H14z" fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/></svg></span>' +
      '<span class="gr-demo-finger"></span>';
    return el;
  }

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
  // Some layout (like the author panel's scroll position) can only be restored
  // once the styles are in.
  let markStylesReady;
  const stylesReady = new Promise((resolve) => { markStylesReady = resolve; });
  const reveal = () => {
    host.style.visibility = '';
    markStylesReady();
  };
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
    // Space the toolbar takes at the bottom of the screen; none if the client
    // moved it up.
    const fromBottom = window.innerHeight - barEl.getBoundingClientRect().top;
    return fromBottom <= window.innerHeight / 2 ? Math.max(0, fromBottom) : 0;
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

    // How far the bottom of the screen the browser lays fixed elements out
    // against is below the bottom of what can be seen. Two cases:
    // - iOS keeps fixed elements behind the on-screen keyboard (a big gap):
    //   the toolbar hides and the open card moves above the keyboard.
    // - Some phones (Chrome on Android, with the address bar showing) lay them
    //   out a little below the visible screen, cutting off the toolbar's
    //   bottom (a small gap): the toolbar and the tour card are lifted by it.
    // Measured with an empty fixed marker at bottom: 0.
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const probe = h('div', { class: 'gr-probe', 'aria-hidden': 'true' });
      fixedLayer.append(probe);
      let queued = false;
      const onViewport = () => {
        queued = false;
        const fixedBottom = probe.getBoundingClientRect().top;
        const seenBottom = vv.offsetTop + vv.height;
        const gap = Math.max(0, Math.round(Math.max(fixedBottom, window.innerHeight) - seenBottom));
        const kb = gap > 80;
        app.style.setProperty('--gr-kb', gap + 'px');
        // Not while zoomed in: then the gap is just the part zoomed out of view.
        app.style.setProperty('--gr-lift', (kb || vv.scale > 1.05 ? 0 : gap) + 'px');
        app.style.setProperty('--gr-vvh', Math.round(vv.height) + 'px');
        app.classList.toggle('is-kb', kb);
        // ?gr-debug in the address: show the numbers (for checking a phone).
        if (debugBox) {
          debugBox.textContent = 'fixed ' + Math.round(fixedBottom) + ' · inner ' + window.innerHeight +
            ' · seen ' + Math.round(seenBottom) + ' (h ' + Math.round(vv.height) + ' top ' + Math.round(vv.offsetTop) +
            ' scale ' + vv.scale.toFixed(2) + ') · lift ' + (kb ? 0 : gap);
        }
      };
      const debugBox = /[?&]gr-debug\b/.test(location.search) ? h('div', { class: 'gr-debug' }) : null;
      if (debugBox) fixedLayer.append(debugBox);
      const queue = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(onViewport);
      };
      vv.addEventListener('resize', queue);
      vv.addEventListener('scroll', queue);
      window.addEventListener('scroll', queue, { passive: true });
      window.addEventListener('resize', queue);
      window.addEventListener('touchend', () => setTimeout(queue, 350), { passive: true });
      setInterval(queue, 1000);
      queue();
    }
  }

  // --- toast ------------------------------------------------------------------

  let toastEl = null;
  let toastTimer = 0;
  function toast(message, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    if (toastEl) toastEl.remove();
    const row = h('div', { class: 'gr-toast-row' },
      h('span', null, message),
      opts.action && h('button', { class: 'gr-btn gr-btn-small', type: 'button', onclick: opts.action.onClick }, opts.action.label));
    const el = h('div', { class: 'gr-toast' + (opts.demo ? ' has-demo' : ''), role: 'status' }, opts.demo, row);
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
    h('div', { class: 'gr-card-body' }, opts.body),
    // The footer stays in view while a long body scrolls.
    opts.footer && h('div', { class: 'gr-card-foot' }, opts.footer));

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

  // The element on the page at a screen point, looking through the review UI.
  function elementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (isOurs(el)) continue;
      return el === document.documentElement ? document.body : el;
    }
    return null;
  }

  // A see-through layer over the page takes the click while picking, so
  // nothing on the page reacts to it: links, buttons (even disabled ones),
  // embedded maps and the site's own scripts. The element underneath is found
  // from the point. Scrolling still goes to the page.
  function startPicking(opts) {
    const hoverBox = opts.hover ? h('div', { class: 'gr-hover' }, h('span', { class: 'gr-hover-label' })) : null;
    if (hoverBox) {
      hoverBox.hidden = true;
      docLayer.append(hoverBox);
    }
    const layer = h('div', { class: 'gr-pick-layer' });
    fixedLayer.append(layer);
    const closeToast = toast(opts.message, { sticky: true, demo: opts.demo, action: { label: 'Cancel', onClick: () => finish(true) } });

    const swallow = (e) => e.stopPropagation();
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'].forEach((t) => layer.addEventListener(t, swallow));
    layer.addEventListener('mousemove', (e) => {
      if (!hoverBox) return;
      const el = elementAt(e.clientX, e.clientY);
      if (!el) { hoverBox.hidden = true; return; }
      const r = docRect(el);
      placeAt(hoverBox, r.x, r.y, r.w, r.h);
      const text = snippet(el);
      hoverBox.firstChild.textContent = el.tagName.toLowerCase() + (text ? ' · ' + shorten(text, 30) : '');
      hoverBox.hidden = false;
    });
    layer.addEventListener('mouseleave', () => { if (hoverBox) hoverBox.hidden = true; });
    layer.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAt(e.clientX, e.clientY);
      if (!el) return;
      finish(false);
      opts.onPick(el, { pageX: e.clientX + window.scrollX, pageY: e.clientY + window.scrollY, clientX: e.clientX, clientY: e.clientY });
    });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    };
    window.addEventListener('keydown', onKey, true);

    let done = false;
    function finish(cancelled) {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (hoverBox) hoverBox.remove();
      closeToast();
      if (cancelled && opts.onCancel) opts.onCancel();
    }
    return finish;
  }

  // Keeps a fixed box inside the window.
  function clampToWindow(left, top, w, hgt) {
    const vw = document.documentElement.clientWidth;
    return {
      left: Math.round(clamp(left, 4, Math.max(4, vw - w - 4))),
      top: Math.round(clamp(top, 4, Math.max(4, window.innerHeight - Math.min(hgt, 56) - 4))),
    };
  }

  // Drags a fixed box (the client toolbar, the author panel) by a handle, on
  // computers. done({ left, top }) is called when it is let go.
  function dragFixed(e, el, done) {
    if (isPhone() || e.button !== 0 || e.target.closest('button, a, input, textarea, select')) return;
    e.preventDefault();
    const start = el.getBoundingClientRect();
    const grabX = e.clientX - start.left;
    const grabY = e.clientY - start.top;
    let moving = false;
    const onMove = (ev) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moving = true;
        el.classList.add('is-free', 'is-dragging');
      }
      const pos = clampToWindow(ev.clientX - grabX, ev.clientY - grabY, start.width, start.height);
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
    };
    const onUp = () => {
      el.classList.remove('is-dragging');
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      if (moving && done) done({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) });
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
  }

  // Puts a moved box back where it was left, or where it belongs by default.
  function applyFixedPosition(el, pos) {
    if (el.classList.contains('is-dragging')) return;
    if (pos && !isPhone()) {
      const r = el.getBoundingClientRect();
      const p = clampToWindow(pos.left, pos.top, r.width, r.height);
      el.classList.add('is-free');
      el.style.left = p.left + 'px';
      el.style.top = p.top + 'px';
    } else {
      el.classList.remove('is-free');
      el.style.left = '';
      el.style.top = '';
    }
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

  function unionRect(rects) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }

  const stepAnchors = (s) => [s.anchor].concat(s.extra || []);

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
    const moreHighlights = h('div', { class: 'gr-hl-more' });
    docLayer.append(highlight, moreHighlights, markers);
    fixedLayer.append(panel, pill);

    // While a step is dragged near the top or bottom edge of the panel, the
    // list scrolls, faster the closer to the edge, so a step can travel from
    // the end of a long tour to the start in one drag.
    panel.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      const r = panel.getBoundingClientRect();
      const zone = 64;
      const fromTop = e.clientY - r.top;
      const fromBottom = r.bottom - e.clientY;
      if (fromTop < zone) panel.scrollTop -= Math.ceil((zone - Math.max(fromTop, 0)) / 3);
      else if (fromBottom < zone) panel.scrollTop += Math.ceil((zone - Math.max(fromBottom, 0)) / 3);
    });

    function setCollapsed(v) {
      collapsed = v;
      ss.set(KEY.panel, v ? '1' : '0');
      render();
    }

    const stepsHere = () => tour.steps.filter((s) => s.page === PAGE);
    const stepNumber = (s) => tour.steps.indexOf(s) + 1;
    const pageLabel = (key) => (tour.pages[key] && tour.pages[key].title) || key;

    function render() {
      // Replacing the panel's content would jump it back to the top.
      const keepScroll = panel.scrollTop;
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
      // The step editor sits at the top of the panel; show it when it is open.
      panel.scrollTop = editing ? 0 : keepScroll;
      renderMarkers();
      layout();
    }

    let activeFeedback = ss.get(KEY.activeFeedback);
    panel.addEventListener('scroll', () => ss.set(KEY.panelScroll, String(Math.round(panel.scrollTop))));

    // Brings the feedback item last opened back into view in the panel.
    function revealActiveFeedback() {
      if (!activeFeedback) return;
      const item = Array.from(panel.querySelectorAll('[data-fb]')).find((el) => el.getAttribute('data-fb') === activeFeedback);
      if (!item) return;
      const ir = item.getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      if (ir.top < pr.top + 8 || ir.bottom > pr.bottom - 8) panel.scrollTop += ir.top - pr.top - pr.height / 3;
    }

    function headView() {
      return h('div', {
        class: 'gr-panel-head',
        title: 'Drag to move the panel. Double-click to put it back.',
        onpointerdown: (e) => dragFixed(e, panel, (pos) => ls.set(KEY.panelPos, pos)),
        ondblclick: (e) => {
          if (e.target.closest('button')) return;
          ls.del(KEY.panelPos);
          applyFixedPosition(panel, null);
        },
      },
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
      const all = stepAnchors(s);
      const describe = (a) => '<' + a.tag + '> ' + (a.text ? '"' + shorten(a.text, 30) + '"' : '');
      return h('div', { class: 'gr-editor' },
        h('div', { class: 'gr-editor-title' }, (editing.isNew ? 'New step ' : 'Step ') + n,
          h('span', { class: 'gr-muted' }, '  ' + (all.length > 1 ? plural(all.length, 'element') + ', shown together' : describe(s.anchor)))),
        all.length > 1 && h('ol', { class: 'gr-editor-els' }, all.map((a, i) => h('li', null,
          h('span', null, describe(a)),
          h('button', { class: 'gr-icon-btn', type: 'button', title: 'Remove from this step', 'aria-label': 'Remove ' + describe(a), onclick: () => removeElement(i) }, '×')))),
        res && res.status !== 'ok' && h('p', { class: 'gr-warn' }, res.status === 'hidden'
          ? 'This element is hidden right now. Saving keeps the old position.'
          : 'This element is no longer on the page. Delete the step and pick again.'),
        hasText(clientSaid) && h('div', { class: 'gr-client' }, h('strong', null, 'Client: '), clientSaid),
        // Too tall to show together with a note above or below it (see placeTip).
        editing.el && editing.el.isConnected && docRect(editing.el).h > window.innerHeight - 300 &&
          h('p', { class: 'gr-warn' }, 'This is a large area. Your client will see the top of it, with your note in the corner of the screen. To point at one thing inside it, press Cancel and pick something smaller.'),
        ta,
        counter,
        h('div', { class: 'gr-row' },
          save,
          all.length === 1 && editing.el && editing.el.parentElement && editing.el.parentElement !== document.body &&
            h('button', { class: 'gr-btn', type: 'button', title: 'Select the element around this one', onclick: widen }, 'Select wider'),
          h('button', { class: 'gr-btn', type: 'button', title: 'Highlight another element together with this one, under the same note', onclick: addElement }, '+ Add another element'),
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
            // The page highlight would jump from step to step under the drag.
            hoverStepId = null;
            layout();
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
          // Moving over the text inside a step also fires dragleave; only a real
          // exit from the step should clear the drop line.
          ondragleave: (e) => { if (!li.contains(e.relatedTarget)) li.classList.remove('drop-before', 'drop-after'); },
          ondrop: (e) => {
            e.preventDefault();
            if (dragFrom < 0) return;
            const r = li.getBoundingClientRect();
            moveStep(dragFrom, e.clientY > r.top + r.height / 2 ? i + 1 : i);
          },
          onmouseenter: () => {
            if (dragFrom >= 0) return;
            hoverStepId = s.id;
            layout();
          },
          onmouseleave: () => {
            if (hoverStepId !== s.id) return;
            hoverStepId = null;
            layout();
          },
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
          p.items.map((it) => h('button', {
            class: 'gr-fb-item' + (activeFeedback === it.kind + ':' + it.id ? ' is-active' : ''),
            type: 'button',
            'data-fb': it.kind + ':' + it.id,
            onclick: (e) => {
              activeFeedback = it.kind + ':' + it.id;
              ss.set(KEY.activeFeedback, activeFeedback);
              panel.querySelectorAll('.gr-fb-item.is-active').forEach((x) => x.classList.remove('is-active'));
              e.currentTarget.classList.add('is-active');
              showFeedbackItem(it);
            },
          },
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
            extraEls: [],
            step: { id: uid('s'), page: PAGE, path: PAGE, title: '', note: '', anchor: recordAnchor(el), extra: [] },
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
      const results = stepAnchors(s).map(resolveAnchor);
      scrollRectIntoView(unionRect(results.map((r) => r.rect)));
      results.forEach((r) => flash(r.rect));
      if (edit) {
        const found = (r) => (r.status === 'unanchored' ? null : r.el);
        editing = { isNew: false, el: found(results[0]), extraEls: results.slice(1).map(found), step: s };
        render();
      }
    }

    function saveEditor(value) {
      const note = value.trim();
      if (!note || !editing) return;
      const s = editing.step;
      s.note = note;
      const el = editing.el && editing.el.isConnected ? editing.el : null;
      const extraEls = editing.extraEls || [];
      // Re-recording heals a step that was only found by its text.
      if (el && docRect(el).w > 0) s.anchor = recordAnchor(el);
      s.extra = (s.extra || []).map((a, i) => {
        const x = extraEls[i];
        return x && x.isConnected && docRect(x).w > 0 ? recordAnchor(x) : a;
      });
      if (el && s.extra.length) {
        // Several elements: name them all, e.g. "Cargoflow, Eng Kong Depot, Affin Moneybrokers".
        s.title = shorten([el].concat(extraEls.filter(Boolean)).map((x) => shorten(titleFor(x, ''), 28)).join(', '), 70);
      } else if (el) {
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

    // One note for several things at once, e.g. three logos that need the same fix.
    function addElement() {
      panel.classList.add('is-picking');
      startPicking({
        hover: true,
        message: 'Click another element for this step. Esc to stop.',
        onCancel: () => panel.classList.remove('is-picking'),
        onPick: (el) => {
          panel.classList.remove('is-picking');
          if (!editing) return;
          editing.extraEls = (editing.extraEls || []).concat(el);
          editing.step.extra = (editing.step.extra || []).concat(recordAnchor(el));
          render();
        },
      });
    }

    function removeElement(i) {
      const s = editing.step;
      const els = editing.extraEls || [];
      if (i === 0) {
        if (!s.extra.length) return;
        s.anchor = s.extra.shift();
        editing.el = els.shift() || null;
      } else {
        s.extra.splice(i - 1, 1);
        els.splice(i - 1, 1);
      }
      editing.extraEls = els;
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
      activeFeedback = null;
      ss.del(KEY.activeFeedback);
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
        (s.extra || []).forEach((a) => {
          const more = h('button', {
            class: 'gr-marker is-extra',
            type: 'button',
            title: 'Step ' + stepNumber(s) + ' (shown together): ' + s.note,
            'aria-label': 'Edit step ' + stepNumber(s),
            onclick: () => goToStep(s, true),
          }, String(stepNumber(s)));
          markers.append(more);
          markerRefs.push(() => {
            const res = resolveAnchor(a);
            more.classList.toggle('is-lost', res.status !== 'ok');
            placeAt(more, Math.max(res.rect.x - 10, 2), Math.max(res.rect.y - 10, 2));
          });
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
      let rects = [];
      if (editing) {
        const els = [editing.el].concat(editing.extraEls || []);
        rects = stepAnchors(editing.step).map((a, i) => (els[i] && els[i].isConnected ? docRect(els[i]) : resolveAnchor(a).rect));
      } else if (hoverStepId) {
        const s = stepsHere().find((x) => x.id === hoverStepId);
        if (s) rects = stepAnchors(s).map((a) => resolveAnchor(a).rect);
      }
      highlight.hidden = !rects.length;
      if (rects.length) placeAt(highlight, rects[0].x - 4, rects[0].y - 4, rects[0].w + 8, rects[0].h + 8);
      moreHighlights.replaceChildren();
      rects.slice(1).forEach((r) => {
        const box = h('div', { class: 'gr-hl' });
        moreHighlights.append(box);
        placeAt(box, r.x - 4, r.y - 4, r.w + 8, r.h + 8);
      });
    }

    layoutFn = () => {
      applyFixedPosition(panel, ls.get(KEY.panelPos, null));
      layout();
    };
    render();
    // Coming from another page: carry on where the panel was.
    stylesReady.then(() => requestAnimationFrame(() => {
      applyFixedPosition(panel, ls.get(KEY.panelPos, null));
      if (!editing) panel.scrollTop = Number(ss.get(KEY.panelScroll)) || 0;
      revealActiveFeedback();
    }));

    // Arriving from "edit"/"show" on another page.
    const focus = ss.get(KEY.focus);
    if (focus) {
      ss.del(KEY.focus);
      const [kind, id] = [focus.slice(0, focus.indexOf(':')), focus.slice(focus.indexOf(':') + 1)];
      setTimeout(() => {
        if (kind === 'pin' && feedback) {
          const pin = feedback.freePins.find((p) => p.id === id);
          if (pin) whenOnPage(pin, () => showFeedbackItem({ kind: 'pin', pin }));
        } else {
          const s = tour.steps.find((x) => x.id === id);
          if (s && s.page === PAGE) whenOnPage(s, () => goToStep(s, kind === 'edit'));
        }
      }, 400);
    }

    // An app moved to another route: show that route's steps and comments.
    onRoute(() => {
      if (editing && editing.step.page !== PAGE) editing = null;
      hoverStepId = null;
      render();
    });
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
      pinDemoSeen: !!saved.pinDemoSeen,
      barPos: saved.barPos || null,
      fb: Object.assign(emptyFeedback(), saved.fb || {}),
    };
    const fb = state.fb;
    const save = () => ls.set(STORE, state);

    let tour = newTour();
    let tourFailed = false;
    let steps = [];
    let tipVisible = false;
    let tipMoved = false; // the client dragged the note somewhere; leave it there
    let pinning = false;
    let pinsNeedRender = true;

    const spot = h('div', { class: 'gr-spot', hidden: true });
    const multi = h('div', { class: 'gr-multi', hidden: true }); // several elements: outlines + one dim layer
    const runway = h('div', { class: 'gr-runway', hidden: true });
    const pinLayer = h('div', { class: 'gr-markers' });
    const bar = h('div', { class: 'gr-bar', role: 'toolbar', 'aria-label': 'Review tools' });
    let tip = null;
    let tipWarn = null;
    let tipPlaces = null; // "3 places are highlighted…" for a step with several elements
    barEl = bar;
    docLayer.append(spot, multi, runway, pinLayer);
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
        'data-tip': opts.tip,
        onclick: opts.onClick,
      }, icon(name), h('span', { class: 'gr-bar-label' }, label));
    }

    function renderBar() {
      const n = steps.length;
      bar.replaceChildren(...[
        h('span', {
          class: 'gr-bar-grip',
          title: 'Drag to move the toolbar. Double-click to put it back.',
          'aria-hidden': 'true',
          onpointerdown: (e) => dragFixed(e, bar, (pos) => {
            state.barPos = pos;
            save();
            markBarHeight();
            scheduleLayout();
          }),
          ondblclick: () => {
            state.barPos = null;
            save();
            applyFixedPosition(bar, null);
            markBarHeight();
            scheduleLayout();
          },
        }, '⋮⋮'),
        n > 0 && barButton('tour', 'Tour ' + (state.stepIndex + 1) + '/' + n, {
          active: tipVisible,
          pressable: true,
          aria: tipVisible ? 'Hide the tour' : 'Show the tour, step ' + (state.stepIndex + 1) + ' of ' + n,
          tip: tipVisible ? 'Hide the tour for now. You can come back to it any time.' : 'Walk through the parts I would like you to check.',
          onClick: () => (tipVisible ? pauseTour() : goStep(state.stepIndex)),
        }),
        barButton('pin', 'Add a comment', {
          active: pinning,
          tip: 'Click anywhere on the page to pin a comment to that spot.',
          onClick: startPin,
        }),
        barButton('page', 'This page', {
          dot: hasText(fb.pageComments[PAGE]),
          aria: 'Comment on this page as a whole',
          tip: 'Write about this page as a whole: too long, wrong order, something missing.',
          onClick: openPageBox,
        }),
        barButton('send', 'Send feedback', { primary: true, tip: 'See all your comments and send them to me.', onClick: openSummary }),
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
          h('p', null, 'A guided walk through ' + tour.siteName + ', with short notes on the parts I would like you to check.'),
          tourFailed && h('p', { class: 'gr-warn' }, 'The guided tour could not be loaded, but you can still leave comments anywhere on the site.'),
          h('ul', { class: 'gr-list' },
            n > 0 && h('li', null, plural(n, 'stop') + ' across ' + plural(pages, 'page') + ', about ' + minutes + ' minutes.'),
            n > 0 && h('li', null, 'At each stop, read my note, then type in the comment box under it if you want something changed. Empty is fine.'),
            h('li', null, 'Anything else: press "Add a comment" and tap the spot.'),
            h('li', null, 'About a whole page: press "This page".'),
            h('li', null, 'No rush. It saves on this phone, so you can look now and comment later on the same link.')),
          h('p', { class: 'gr-strong' }, 'Nothing is sent to me until you press "Send feedback".'),
        ],
        footer: h('button', { class: 'gr-btn gr-btn-primary gr-btn-lg', type: 'button', onclick: start },
          !n ? 'Start' : state.stepIndex > 0 ? 'Continue the tour' : 'Start the tour'),
      });
    }

    // Someone coming back who has already written something is reminded of it,
    // and that it has not been sent yet.
    function showWelcomeBack(total) {
      const canTour = steps.length > 0 && !state.finished;
      const card = openFloating({
        title: 'Welcome back',
        body: [
          h('p', null, 'You have ' + plural(total, 'comment') + ' so far, saved on this phone. ' +
            (total === 1 ? 'It has' : 'They have') + ' not been sent yet.'),
          canTour && h('p', null, 'The tour is at stop ' + (state.stepIndex + 1) + ' of ' + steps.length + '.'),
          h('div', { class: 'gr-row' },
            canTour && h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => { card.close(); goStep(state.stepIndex); } }, 'Continue the tour'),
            h('button', { class: 'gr-btn' + (canTour ? '' : ' gr-btn-primary'), type: 'button', onclick: () => { card.close(); openSummary(); } }, 'Send feedback'),
            h('button', { class: 'gr-btn gr-btn-ghost', type: 'button', onclick: () => card.close() }, 'Keep looking')),
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
      multi.hidden = true;
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
      // Starts two lines tall and grows with what is typed.
      const fit = () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight + 2, isPhone() ? 112 : 180) + 'px';
      };
      const ta = h('textarea', {
        class: 'gr-textarea gr-grow',
        rows: isPhone() ? 1 : 2,
        placeholder: isPhone() ? 'Your comment (optional)' : 'Type here, or leave it empty',
        'aria-label': 'Your comment on this part (optional)',
        oninput: () => {
          fb.stepComments[s.id] = ta.value;
          save();
          fit();
          scheduleLayout();
        },
      });
      ta.value = fb.stepComments[s.id] || '';
      requestAnimationFrame(fit);
      tipWarn = h('p', { class: 'gr-warn', hidden: true });
      tipPlaces = h('p', { class: 'gr-hint gr-places', hidden: true });

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
        h('div', { class: 'gr-tip-body', onscroll: () => markMore(el) },
          h('p', { class: 'gr-note' }, s.note),
          tipPlaces,
          tipWarn,
          next && next.page !== s.page && h('p', { class: 'gr-hint' }, 'The next stop is on the ' + pageName(next.page) + ' page.')),
        // Outside the scrolling note, so the comment box is always in view: a
        // long note on a phone would otherwise push it out of sight, and the
        // stop reads as information only.
        h('label', { class: 'gr-field gr-tip-reply' }, h('span', { class: 'gr-label' }, 'Your comment (optional)'), ta),
        h('div', { class: 'gr-tip-foot' },
          h('button', { class: 'gr-btn', type: 'button', disabled: i === 0, onclick: () => goStep(i - 1) }, '← Previous'),
          h('span', { class: 'gr-count', 'aria-live': 'polite' }, (i + 1) + ' / ' + n),
          h('button', { class: 'gr-btn gr-btn-primary', type: 'button', onclick: () => (last ? finishTour() : goStep(i + 1)) }, last ? 'Finish' : 'Next →')));
      const head = el.firstChild;
      head.title = 'Drag to move this note';
      head.addEventListener('pointerdown', (e) => dragTip(e, el, head));
      return el;
    }

    // A note longer than its space fades out at the bottom, so it is clear
    // there is more to read.
    function markMore(el) {
      const body = el && el.querySelector('.gr-tip-body');
      if (!body) return;
      el.classList.toggle('has-more', body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    }

    // Several elements at once: one dimmed layer with a hole for each, and an
    // outline around each.
    function drawMulti(boxes, results, doc) {
      const W = Math.max(doc.w, document.documentElement.scrollWidth);
      const H = doc.h + window.innerHeight; // also covers the scroll room below the page
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.setAttribute('class', 'gr-multi-dim');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('fill-rule', 'evenodd');
      path.setAttribute('d', 'M0 0H' + W + 'V' + H + 'H0Z' + boxes.map((b) =>
        'M' + Math.round(b.x) + ' ' + Math.round(b.y) + 'h' + Math.round(b.w) + 'v' + Math.round(b.h) + 'h' + -Math.round(b.w) + 'Z').join(''));
      svg.append(path);
      multi.replaceChildren(svg);
      boxes.forEach((b, i) => {
        const outline = h('div', { class: 'gr-spot is-multi' + (results[i].status !== 'ok' ? ' is-lost' : '') });
        Object.assign(outline.style, { left: Math.round(b.x) + 'px', top: Math.round(b.y) + 'px', width: Math.round(b.w) + 'px', height: Math.round(b.h) + 'px' });
        multi.append(outline);
      });
      placeAt(multi, 0, 0);
      multi.hidden = false;
    }

    // On a computer the note can be dragged by its top bar, e.g. off a logo
    // it happens to cover. It then stays put on screen until the next stop.
    function dragTip(e, el, head) {
      if (isPhone() || e.button !== 0 || e.target.closest('.gr-icon-btn')) return;
      e.preventDefault();
      const start = el.getBoundingClientRect();
      const grabX = e.clientX - start.left;
      const grabY = e.clientY - start.top;
      let moving = false;
      // Listened for on the window: the note changes layer when the drag
      // starts, which would drop a pointer capture on it.
      const onMove = (ev) => {
        if (!moving) {
          if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
          moving = true;
          tipMoved = true;
          if (el.parentNode !== fixedLayer) fixedLayer.append(el);
          el.classList.remove('is-docked');
          el.classList.add('is-free', 'is-dragging');
          el.style.bottom = '';
        }
        const vw = document.documentElement.clientWidth;
        el.style.left = Math.round(clamp(ev.clientX - grabX, 4, vw - start.width - 4)) + 'px';
        el.style.top = Math.round(clamp(ev.clientY - grabY, 4, window.innerHeight - 48)) + 'px';
      };
      const onUp = () => {
        el.classList.remove('is-dragging');
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    }

    // A moved note stays where it was put, but never off screen.
    function keepMovedTipOnScreen() {
      const r = tip.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      tip.style.left = Math.round(clamp(r.left, 4, Math.max(4, vw - r.width - 4))) + 'px';
      tip.style.top = Math.round(clamp(r.top, 4, Math.max(4, window.innerHeight - 48))) + 'px';
    }

    function showStep(scroll) {
      const s = steps[state.stepIndex];
      if (!s || s.page !== PAGE) return;
      closeFloating();
      if (tip) tip.remove();
      tip = buildTip(s);
      tipMoved = false;
      tipVisible = true;
      renderBar();
      positionStep(scroll);
    }

    function positionStep(scroll) {
      if (!tipVisible || !tip) return;
      const s = steps[state.stepIndex];
      const results = stepAnchors(s).map(resolveAnchor);
      const res = results[0];
      const pad = 6;
      const boxes = results.map((r) => ({ x: r.rect.x - pad, y: r.rect.y - pad, w: r.rect.w + pad * 2, h: r.rect.h + pad * 2 }));
      // The note is placed against the area that holds all of them.
      const R = unionRect(boxes);
      const doc = measureDoc();

      if (boxes.length === 1) {
        multi.hidden = true;
        spot.classList.toggle('is-lost', res.status !== 'ok');
        placeAt(spot, R.x, R.y, R.w, R.h);
        spot.hidden = false;
      } else {
        spot.hidden = true;
        drawMulti(boxes, results, doc);
      }

      // Several elements may not all fit on screen (a phone stacks them): say so.
      tipPlaces.hidden = boxes.length < 2;
      if (boxes.length > 1) {
        const room = window.innerHeight - topInset() - barSpace() - (isPhone() ? tip.offsetHeight : 0);
        tipPlaces.textContent = boxes.length + ' places are highlighted on this page' +
          (R.h > room ? '. Scroll to see them all.' : '.');
      }

      const lost = results.filter((r) => r.status !== 'ok');
      tipWarn.hidden = !lost.length;
      tipWarn.textContent = results.length > 1
        ? 'Some of these parts have changed or are hidden right now, so their boxes only show roughly where they are.'
        : res.status === 'hidden'
          ? 'This part is hidden right now — it may be inside a menu or a closed section. The box shows roughly where it is.'
          : 'This part of the page has changed since I wrote this note, so the box only shows roughly where it was.';

      // Extra scroll room at the bottom, so the last elements can still be
      // brought above the tooltip.
      placeAt(runway, 0, doc.h, 1, window.innerHeight * 0.8);
      runway.hidden = false;

      if (isPhone()) {
        tipMoved = false;
        tip.classList.remove('is-free');
        placeSheet(R, scroll);
      } else if (tipMoved) {
        keepMovedTipOnScreen();
      } else {
        placeTip(R, scroll);
      }
      markMore(tip);
    }

    // Desktop: beside the element, never over it.
    function placeTip(R, scroll) {
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const sx = window.scrollX;
      const m = 12;
      const gap = 12;
      const bottomSpace = barSpace();
      const inset = topInset();
      const avail = vh - m * 2 - bottomSpace - inset;

      // The note never grows taller than the free screen; a long note scrolls
      // inside it, with Previous / Next always in view. It is measured where it
      // is: moving it to another layer would take focus away from someone typing.
      tip.classList.remove('is-sheet', 'is-min', 'is-free');
      tip.style.maxHeight = Math.max(180, avail) + 'px';
      if (!tip.parentNode) docLayer.append(tip); // a new note has no size until it is in the page
      const w = tip.offsetWidth;
      const th = tip.offsetHeight;
      const midX = clamp(R.x + R.w / 2 - w / 2, sx + m, sx + vw - w - m);
      let x;
      let y;
      let focusTop;

      if (R.h + gap + th <= avail) {
        // Element and note fit on screen together: note below.
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
      } else {
        dockTip(R, scroll, inset, bottomSpace);
        return;
      }

      if (tip.parentNode !== docLayer) docLayer.append(tip);
      tip.classList.remove('is-docked');
      tip.style.bottom = '';
      placeAt(tip, x, y);

      if (scroll) {
        const top = Math.min(R.y, y);
        const bottom = Math.max(R.y + R.h, y + th);
        const onScreen = top >= window.scrollY + m + inset && bottom <= window.scrollY + vh - bottomSpace - m;
        if (!onScreen) scrollToY(focusTop);
      }
    }

    // A section too big to show with its note beside or below it: show its top
    // under the site header, with the note docked in the screen's lower corner
    // over it. A note under or above the section would scroll the section away.
    function dockTip(R, scroll, inset, bottomSpace) {
      if (tip.parentNode !== fixedLayer) fixedLayer.append(tip);
      tip.classList.add('is-docked');
      tip.style.left = '';
      tip.style.top = '';
      tip.style.bottom = Math.round(bottomSpace + 12) + 'px';
      if (!scroll) return;
      const topOnScreen = R.y - window.scrollY;
      if (topOnScreen < inset + 4 || topOnScreen > window.innerHeight * 0.25) scrollToY(R.y - inset - 12);
    }

    // Phone: a sheet above the toolbar; the element is scrolled into the space
    // above it. The sheet can be folded down to its title bar.
    function placeSheet(R, scroll) {
      if (tip.parentNode !== fixedLayer) fixedLayer.append(tip);
      tip.classList.remove('is-docked');
      tip.classList.add('is-sheet');
      tip.style.left = '';
      tip.style.top = '';
      tip.style.bottom = '';
      // The element gets its room first; the sheet scrolls inside what is left.
      // Only an element taller than most of the screen can end up underneath.
      const inset = topInset();
      const avail = window.innerHeight - barSpace() - inset;
      tip.style.maxHeight = Math.round(clamp(avail - R.h - 24, Math.min(250, avail * 0.5), avail * 0.6)) + 'px';
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
      const firstTime = !state.pinDemoSeen;
      if (firstTime) {
        state.pinDemoSeen = true;
        save();
      }
      startPicking({
        hover: false,
        demo: firstTime ? pinDemo() : null,
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
            label: describeSpot(el, e.clientX, e.clientY),
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
        if (IS_PREVIEW) return;
        wa.href = links.whatsapp;
        mail.href = links.email;
      }
      refresh();
      if (IS_PREVIEW) {
        [copy, dl].forEach((b) => { b.disabled = true; });
        [wa, mail].forEach((a) => {
          a.classList.add('is-disabled');
          a.setAttribute('aria-disabled', 'true');
          a.addEventListener('click', (e) => e.preventDefault());
        });
      }

      openFloating({
        title: 'Send your feedback',
        wide: true,
        body: [
          h('label', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Your name'), name),
          h('div', { class: 'gr-field' }, h('span', { class: 'gr-label' }, 'Your comments'), pre, count),
          h('div', { class: 'gr-field' },
            h('span', { class: 'gr-label' }, 'Send them to me with any one of these'),
            h('div', { class: 'gr-share-grid' }, copy, wa, mail, dl)),
          IS_PREVIEW
            ? h('p', { class: 'gr-warn' }, 'Preview only. In your client’s link, these buttons send the feedback to you. Here they are switched off, and nothing you typed is sent anywhere.')
            : h('p', { class: 'gr-hint' }, 'Nothing is sent automatically. Your comments stay saved on this device, so you can close this and add more later.'),
        ],
      });
    }

    // --- start ---

    // Toolbar hints open below the toolbar when it was moved near the top.
    function markBarHeight() {
      bar.classList.toggle('is-high', bar.classList.contains('is-free') && bar.getBoundingClientRect().top < 140);
    }

    layoutFn = () => {
      applyFixedPosition(bar, state.barPos);
      markBarHeight();
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
      stylesReady.then(() => scheduleLayout()); // puts a moved toolbar back where it was left
      // A new visit (not just moving between pages) by someone who was here before.
      const visitKey = 'gr:visit:' + MODE;
      const newVisit = !ss.get(visitKey);
      ss.set(visitKey, '1');
      const total = buildReport(exportFeedback(), tour).total;
      if (!state.welcomed) {
        showWelcome();
      } else if (newVisit && total === 0 && !state.finished) {
        // They only had a look last time: explain everything again.
        showWelcome();
      } else if (newVisit && total > 0) {
        showWelcomeBack(total);
      } else if (state.touring && steps[state.stepIndex] && steps[state.stepIndex].page === PAGE) {
        // Wait for the page to settle before measuring and scrolling.
        setTimeout(() => whenOnPage(steps[state.stepIndex], () => showStep(true)), 250);
      }
      // An app moved to another route without loading a page.
      onRoute(() => {
        closeFloating();
        if (tipVisible) hideStep();
        renderPins();
        renderBar();
        const s = steps[state.stepIndex];
        if (state.touring && s && s.page === PAGE) whenOnPage(s, () => showStep(true));
      });
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

  // Phones stretch or bounce the whole screen when the page is pulled past
  // its top, toolbar included, which cuts off its bottom. Only for the
  // client's view; pull-to-refresh is not needed on a review page.
  function holdOverscroll() {
    if (IS_AUTHOR || !isPhone()) return;
    try { document.documentElement.style.setProperty('overscroll-behavior-y', 'none'); } catch (e) { /* nothing to do */ }
  }

  function boot() {
    document.body.append(host);
    watchLayout();
    holdForms();
    holdOverscroll();
    if (IS_AUTHOR) initAuthor();
    else initReviewer();
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
