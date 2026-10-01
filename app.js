/*
 * Guided Review Tool — app.js
 * The tool shell. Drop a project folder: it is kept in the browser and shown in
 * a preview with the review engine (served by sw.js). Publish sends the project,
 * the engine tag and the tour to your Netlify review site, replacing whatever
 * was there. Copy client link gives the URL to send.
 */
(function () {
  'use strict';

  const { injectHtml, engineTag, storageGuardTag, contentType, isHtml, encodePath } = self.GuidedReviewInject;

  const PROJECT_CACHE = 'gr-project';
  const PREFIX = '/preview/';
  const INTERNAL = '/__gr/';
  const KEY = {
    project: 'gr:tool:project',
    netlify: 'gr:tool:netlify',
    api: 'gr:tool:api', // override of the Netlify API base, for testing
    page: 'gr:tool:page',
    // The engine's own keys: cleared when a project is replaced.
    draft: 'gr:author:draft',
    feedback: 'gr:author:feedback',
    clientPreview: 'gr:review:preview-client',
  };
  // Files and folders a project folder often carries that the site does not need.
  const IGNORED = /(^|\/)(\.[^/]*|node_modules|Thumbs\.db|desktop\.ini)(\/|$)/i;
  const NETLIFY_TOKENS_URL = 'https://app.netlify.com/user/applications#personal-access-tokens';

  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { toast('This browser is not saving tool settings.'); }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch (e) { /* nothing to do */ }
    },
  };
  const apiBase = () => localStorage.getItem(KEY.api) || 'https://api.netlify.com/api/v1';

  let project = store.get(KEY.project);
  let netlify = store.get(KEY.netlify);
  let swReady = null;

  const $ = (id) => document.getElementById(id);

  function h(tag, props) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'disabled' || k === 'checked') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    for (let i = 2; i < arguments.length; i++) add(arguments[i]);
    return el;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (n) => Math.random().toString(36).slice(2, 2 + n);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // --- toast and dialog ----------------------------------------------------------

  let toastTimer = 0;
  function toast(message, ms) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  // One dialog at a time. Returns { close, body, actions } to update it in place.
  function openDialog(opts) {
    const dlg = $('dialog');
    const body = h('div', { class: 'dialog-body' });
    const actions = h('div', { class: 'dialog-actions' });
    dlg.replaceChildren(
      h('div', { class: 'dialog-head' },
        h('h2', null, opts.title),
        opts.dismissable !== false && h('button', { class: 'close-x', type: 'button', 'aria-label': 'Close', onclick: () => close() }, '×')),
      body,
      actions);
    const set = (nodes, buttons) => {
      body.replaceChildren(...[].concat(nodes).filter(Boolean));
      actions.replaceChildren(...[].concat(buttons || []).filter(Boolean));
    };
    set(opts.body, opts.actions);
    dlg.oncancel = (e) => {
      if (opts.dismissable === false) e.preventDefault();
    };
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (dlg.open) dlg.close();
      if (opts.onClose) opts.onClose();
    }
    // The close event arrives after the fact; one that shows up while a newer
    // dialog is already open belongs to the previous one.
    dlg.onclose = () => { if (!dlg.open) close(); };
    if (!dlg.open) dlg.showModal();
    return { close, set, body, actions };
  }

  function confirmDialog(title, message, okLabel, danger) {
    return new Promise((resolve) => {
      let answered = false;
      const d = openDialog({
        title,
        body: [].concat(message).map((m) => (typeof m === 'string' ? h('p', null, m) : m)),
        actions: [
          h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'),
          h('button', {
            class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
            type: 'button',
            onclick: () => { answered = true; d.close(); },
          }, okLabel),
        ],
        onClose: () => resolve(answered),
      });
    });
  }

  // --- reading a dropped folder -------------------------------------------------------

  async function walkEntry(entry, prefix, out) {
    // node_modules, .git and other hidden folders are left out anyway (IGNORED);
    // skipping them here keeps a big app folder quick to drop. .output holds
    // Nuxt's build, so it stays.
    if (entry.isDirectory && (/^node_modules$/i.test(entry.name) || (entry.name[0] === '.' && entry.name !== '.output'))) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries hands back the folder in batches until it returns none.
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child, prefix + entry.name + '/', out);
      }
    }
  }

  function filesFromDrop(dataTransfer) {
    // Entries must be taken while the drop event is still running.
    const entries = Array.from(dataTransfer.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    const plain = Array.from(dataTransfer.files || []);
    return (async () => {
      if (!entries.length) return plain.map((file) => ({ path: file.name, file }));
      const out = [];
      for (const entry of entries) await walkEntry(entry, '', out);
      return out;
    })();
  }

  // Build output folders: Vite, Vue CLI, Angular (dist), Create React App
  // (build), Next export (out), Nuxt generate (.output/public).
  const BUILD_DIR = /(^|\/)(dist|build|out|\.output\/public)\//i;

  // The source of a React / Vue / Svelte / Angular app: browsers cannot run it
  // as it is, which shows as a blank page. Vite's index.html loads
  // /src/main.jsx (or main.js / main.ts next to a package.json); Create React
  // App and Vue CLI keep placeholders in public/index.html; Angular's
  // src/index.html has only <app-root>.
  const SOURCE_SIGNS = [
    /<script[^>]+src=["'][^"']*\/src\/[^"']+\.(jsx|tsx|ts|vue|svelte)["']/i,
    /%PUBLIC_URL%/,
    /<%=\s*BASE_URL/,
  ];

  function looksLikeSource(html, siblings) {
    if (SOURCE_SIGNS.some((re) => re.test(html))) return true;
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    const hasProjectFile = (re) => siblings.some((p) => re.test(p));
    // <script type="module" src="/src/main.js"> beside package.json / vite.config.js
    const srcModule = scripts.some((t) => /type=["']?module/i.test(t) && /src=["'](\.?\/)?src\//i.test(t));
    if (srcModule && hasProjectFile(/^(package\.json|vite\.config\.[a-z]+)$/i)) return true;
    // Angular: only <app-root></app-root>, no scripts (a build adds them)
    if (/<app-root[\s>]/i.test(html) && !scripts.length) return true;
    return false;
  }

  const SOURCE_TITLE = 'This app needs to be built first';
  // folder: where the app's index.html sits in what was dropped ("my-app/web").
  const sourceMessage = (folder) => [
    'This is the source code of an app (React, Vue, Svelte, Angular…). Browsers cannot run it as it is, so the page would stay blank.',
    'Build it once: open a terminal in the ' + (folder ? '“' + folder + '” folder' : 'app\'s folder') + ' and run "npm run build" ' +
      '(run "npm install" first if the app has never been set up on this computer).',
    'Then drop the same folder here again. The tool finds the build (dist, build or out) by itself.',
  ];

  // Finds the site inside what was dropped: the folder holding the top-most
  // index.html, or for an app's source folder, its build output (dist, build,
  // out). Everything outside it, and hidden files, are left out.
  async function shapeProject(list) {
    const files = list.filter((f) => !IGNORED.test(f.path.replace(/(^|\/)\.output\/public\//i, '$1output-public/')));
    const indexes = files
      .filter((f) => /(^|\/)index\.html?$/i.test(f.path))
      .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    if (!indexes.length) {
      const zipped = list.length === 1 && /\.zip$/i.test(list[0].path);
      throw new Error(zipped
        ? 'That is a .zip file. Unzip it first (right-click → Extract All), then drop the folder that comes out.'
        : 'There is no index.html in what you dropped. Drop the folder that has the site\'s index.html in it.');
    }
    // The top-most index.html is the site, unless it is an app's source: then
    // the app's build output is, if it has been built.
    const isSource = async (f) => {
      const dir = f.path.replace(/[^/]*$/, '');
      const siblings = files.filter((x) => x.path.startsWith(dir)).map((x) => x.path.slice(dir.length)).filter((p) => !p.includes('/'));
      return looksLikeSource(await f.file.text(), siblings);
    };
    let index = indexes[0];
    if (await isSource(index)) {
      index = indexes.find((f) => BUILD_DIR.test(f.path));
      if (!index || (await isSource(index))) {
        const err = new Error(SOURCE_TITLE);
        err.lines = sourceMessage(indexes[0].path.replace(/\/?[^/]*$/, ''));
        throw err;
      }
    }
    const root = index.path.replace(/[^/]*$/, '');

    const inside = files
      .filter((f) => f.path.startsWith(root))
      .map((f) => ({ path: f.path.slice(root.length), file: f.file }));
    // "my-app/dist/" is called "my-app", not "dist"; so is "my-app/dist/my-app/browser/".
    const parts = root.replace(/\/$/, '').split('/').filter(Boolean);
    const at = parts.findIndex((p, i) => /^(dist|build|out)$/i.test(p) || (p === '.output' && parts[i + 1] === 'public'));
    const name = (at > 0 ? parts[at - 1] : parts.pop()) ||
      (list[0] && list[0].path.includes('/') ? list[0].path.split('/')[0] : '') || 'project';
    return { name, files: inside };
  }

  async function receiveFiles(listPromise) {
    let shaped;
    try {
      shaped = await shapeProject(await listPromise);
    } catch (e) {
      const lines = e.lines || [e.message];
      openDialog({ title: e.lines ? e.message : 'That is not a site folder', body: lines.map((t) => h('p', null, t)), actions: [h('button', { class: 'btn btn-primary', type: 'button', onclick: () => $('dialog').close() }, 'OK')] });
      return;
    }
    if (project) {
      const ok = await confirmDialog(
        'Replace “' + project.name + '”?',
        [
          '“' + shaped.name + '” will take its place in this tool. The tour and any loaded feedback for “' + project.name + '” are removed from this tool.',
          'The review site keeps showing “' + project.name + '” until you publish the new project.',
        ],
        'Replace',
        true
      );
      if (!ok) return;
    }
    await importProject(shaped);
  }

  async function importProject(shaped) {
    const d = openDialog({ title: 'Opening “' + shaped.name + '”', dismissable: false, body: [h('p', null, 'Reading files…')] });
    const bar = h('div');
    const line = h('p', null, '');
    d.set([line, h('div', { class: 'progress' }, bar)]);
    try {
      await caches.delete(PROJECT_CACHE);
      const cache = await caches.open(PROJECT_CACHE);
      let done = 0;
      for (const f of shaped.files) {
        await cache.put(
          new Request(PREFIX + encodePath(f.path)),
          new Response(f.file, { headers: { 'Content-Type': contentType(f.path) } })
        );
        done++;
        if (done % 5 === 0 || done === shaped.files.length) {
          line.textContent = 'Reading files… ' + done + ' of ' + shaped.files.length;
          bar.style.width = Math.round((done / shaped.files.length) * 100) + '%';
        }
      }
    } catch (e) {
      d.set(h('p', { class: 'error' }, 'The files could not be stored in this browser: ' + e.message),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => d.close() }, 'OK'));
      return;
    }

    // A new project starts with a clean tour and a clean client preview.
    [KEY.draft, KEY.feedback, KEY.clientPreview].forEach(store.del);
    try {
      ['gr:mode', 'gr:focus', KEY.page].forEach((k) => sessionStorage.removeItem(k));
    } catch (e) { /* nothing to do */ }

    const pages = shaped.files.map((f) => f.path).filter(isHtml)
      .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
    project = {
      name: shaped.name,
      token: slug(shaped.name) + '-' + rand(4),
      pages,
      fileCount: shaped.files.length,
      size: shaped.files.reduce((n, f) => n + f.file.size, 0),
      droppedAt: Date.now(),
      publishedAt: null,
      publishedTourHash: null,
      mode: 'author',
    };
    store.set(KEY.project, project);
    d.close();
    await showWorkspace();
  }

  // --- preview ----------------------------------------------------------------------------

  async function writeInternal(name, data) {
    const cache = await caches.open(PROJECT_CACHE);
    await cache.put(new Request(INTERNAL + name), new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  }

  const readDraft = () => store.get(KEY.draft);
  const tourHash = () => hashString(localStorage.getItem(KEY.draft) || '');

  async function projectStillStored() {
    try {
      const cache = await caches.open(PROJECT_CACHE);
      return (await cache.keys()).some((r) => new URL(r.url).pathname.startsWith(PREFIX));
    } catch (e) {
      return false;
    }
  }

  // One HTML file, index.html: a React / Vue / Svelte style app that routes
  // itself. Its routes ("about", "products/12") are pages of the review.
  const isApp = () => !!project && project.pages.length === 1 && /^index\.html?$/i.test(project.pages[0]);

  async function loadFrame(page) {
    await swReady;
    await writeInternal('config.json', { mode: project.mode === 'client' ? 'preview-client' : 'author' });
    const key = page || 'index.html';
    const hashAt = key.indexOf('#');
    const path = hashAt < 0 ? key : key.slice(0, hashAt);
    $('frame').src = PREFIX + encodePath(isApp() && path === 'index.html' ? '' : path) + (hashAt < 0 ? '' : key.slice(hashAt));
  }

  async function setMode(mode) {
    if (project.mode === mode) return;
    project.mode = mode;
    store.set(KEY.project, project);
    if (mode === 'client') {
      // The client view shows the tour as it stands, from a fresh start.
      await writeInternal('tour.json', readDraft() || {});
      store.del(KEY.clientPreview);
    }
    renderBar();
    await loadFrame(currentPage());
  }

  function currentPage() {
    try {
      const loc = $('frame').contentWindow.location;
      const path = loc.pathname;
      if (path.startsWith(PREFIX)) return decodeURIComponent(path.slice(PREFIX.length)) || 'index.html';
      // An app puts its own address back (/about), see appAddressTag.
      if (isApp() && loc.href !== 'about:blank') {
        return (decodeURIComponent(path.replace(/^\/+|\/+$/g, '')) || 'index.html') + (/^#\//.test(loc.hash) ? loc.hash : '');
      }
    } catch (e) { /* not loaded yet */ }
    return sessionStorage.getItem(KEY.page) || 'index.html';
  }

  function onFrameLoad() {
    const win = $('frame').contentWindow;
    const page = currentPage();
    try { sessionStorage.setItem(KEY.page, page); } catch (e) { /* nothing to do */ }
    const select = $('page-select');
    if (!Array.from(select.options).some((o) => o.value === page)) select.append(h('option', { value: page }, page));
    select.value = page;
    // Drags over the preview land in the frame; bring up the drop veil from there too.
    try {
      win.addEventListener('dragenter', (e) => { if (hasFiles(e)) $('drop-veil').hidden = false; });
    } catch (e) { /* nothing to do */ }
  }

  // --- status bar -----------------------------------------------------------------------------

  function clientLink() {
    return netlify && project ? netlify.url.replace(/\/$/, '') + '/?review=' + encodeURIComponent(project.token) : '';
  }

  function renderBar() {
    if (!project) return;
    $('project-name').textContent = project.name;
    const select = $('page-select');
    const keep = select.value;
    select.replaceChildren(...project.pages.map((p) => h('option', { value: p }, p)));
    if (keep) select.value = keep;
    // An app is one page with routes: its own links move between them.
    select.closest('.page-pick').hidden = isApp();
    $('mode-author').setAttribute('aria-pressed', String(project.mode !== 'client'));
    $('mode-client').setAttribute('aria-pressed', String(project.mode === 'client'));
    $('preview-note').hidden = project.mode !== 'client';
    $('copy-link').disabled = !project.publishedAt || !netlify;
    renderStatus();
  }

  function renderStatus() {
    const el = $('status');
    el.className = 'status';
    if (!project.publishedAt) {
      el.textContent = 'Not published yet';
    } else if (project.publishedTourHash !== tourHash()) {
      el.classList.add('is-stale');
      el.textContent = 'Tour changed since publishing';
    } else {
      el.classList.add('is-live');
      el.textContent = 'Published ' + ago(project.publishedAt);
    }
  }

  async function showWorkspace() {
    $('empty').hidden = !!project;
    $('work').hidden = !project;
    $('bar').hidden = !project;
    if (!project) {
      $('preview-note').hidden = true;
      return;
    }
    renderBar();
    await loadFrame(sessionStorage.getItem(KEY.page) || 'index.html');
  }

  // --- Netlify ------------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function api(method, path, body, token) {
    const headers = { Authorization: 'Bearer ' + (token || netlify.token) };
    let payload;
    if (body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(apiBase() + path, { method, headers, body: payload });
    } catch (e) {
      throw new ApiError(0, 'Could not reach Netlify. Check your internet connection and try again.');
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const j = JSON.parse(text);
        message = j.message || (j.errors && JSON.stringify(j.errors)) || text;
      } catch (e) { /* plain text */ }
      throw new ApiError(res.status, message || res.statusText);
    }
    return text ? JSON.parse(text) : null;
  }

  function openNetlifySettings() {
    return new Promise((resolve) => {
      let connected = false;
      const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', value: netlify ? netlify.token : '' });
      const name = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', value: netlify ? netlify.siteName : 'review-' + rand(5) });
      const error = h('p', { class: 'error', hidden: true });
      const connect = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => run(false) }, netlify ? 'Save' : 'Connect');

      const form = [
        netlify && h('dl', { class: 'facts' }, h('dt', null, 'Review site'), h('dd', null, netlify.url)),
        h('label', { class: 'field' },
          h('span', null, 'Netlify personal access token'),
          token,
          h('span', { class: 'hint' }, 'Create one under ', h('a', { href: NETLIFY_TOKENS_URL, target: '_blank', rel: 'noopener' }, 'User settings → Applications'),
            '. It is kept in this browser only.')),
        h('label', { class: 'field' },
          h('span', null, 'Review site name'),
          name,
          h('span', { class: 'hint' }, 'Becomes ', h('strong', null, 'name.netlify.app'), '. Everything on this site is replaced each time you publish, so use it for reviews only.')),
        error,
      ];
      const actions = [
        netlify && h('button', {
          class: 'btn btn-danger',
          type: 'button',
          onclick: () => { netlify = null; store.del(KEY.netlify); d.close(); renderBar(); toast('Disconnected from Netlify.'); },
        }, 'Disconnect'),
        h('button', { class: 'btn', type: 'button', onclick: () => d.close() }, 'Cancel'),
        connect,
      ];
      const d = openDialog({ title: netlify ? 'Netlify review site' : 'Connect your Netlify review site', body: form, actions, onClose: () => resolve(connected) });

      const fail = (message) => {
        error.textContent = message;
        error.hidden = false;
        connect.disabled = false;
        connect.textContent = netlify ? 'Save' : 'Connect';
      };

      async function run(useExisting) {
        const t = token.value.trim();
        const n = slug(name.value.trim());
        if (!t) return fail('Paste your Netlify token first.');
        if (!n) return fail('Give the review site a name.');
        error.hidden = true;
        connect.disabled = true;
        connect.textContent = 'Checking…';
        try {
          await api('GET', '/user', null, t);
        } catch (e) {
          return fail(e.status === 401 ? 'Netlify did not accept that token.' : e.message);
        }
        let site = null;
        try {
          site = await api('GET', '/sites/' + n + '.netlify.app', null, t);
        } catch (e) {
          if (e.status !== 404) return fail(e.message);
        }
        if (site && !useExisting && !(netlify && netlify.siteId === site.id)) {
          // Never wipe an existing site without a clear yes.
          d.set([
            h('p', { class: 'notice' }, 'You already have a site called ' + n + '. Everything on it will be replaced each time you publish a review.'),
            h('p', null, 'Use it anyway, or go back and pick another name.'),
          ], [
            h('button', {
              class: 'btn',
              type: 'button',
              onclick: () => {
                d.set(form, actions);
                connect.disabled = false;
                connect.textContent = netlify ? 'Save' : 'Connect';
              },
            }, 'Back'),
            h('button', { class: 'btn btn-danger', type: 'button', onclick: () => run(true) }, 'Use ' + n),
          ]);
          return;
        }
        if (!site) {
          try {
            site = await api('POST', '/sites', { name: n }, t);
          } catch (e) {
            return fail(e.status === 422 ? 'The name ' + n + ' is taken by someone else. Try another.' : e.message);
          }
        }
        netlify = { token: t, siteId: site.id, siteName: site.name, url: site.ssl_url || site.url };
        store.set(KEY.netlify, netlify);
        connected = true;
        renderBar();
        d.close();
      }
    });
  }

  async function sha1(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function tourForPublish() {
    const tour = readDraft() || { format: 'guided-review/tour', version: 1, steps: [], pages: {}, contact: { whatsapp: '', email: '' } };
    if (!tour.siteName) tour.siteName = project.name;
    tour.tourId = 't-' + hashString(JSON.stringify((tour.steps || []).map((s) => [s.id, s.page, s.note, s.anchor && s.anchor.selector])));
    tour.exportedAt = new Date().toISOString();
    return tour;
  }

  // The site as it will be published: every file of the project, the engine tag
  // and a noindex tag on every page, the tour, and a noindex header.
  async function buildSite(onProgress) {
    const cache = await caches.open(PROJECT_CACHE);
    const requests = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith(PREFIX));
    const encoder = new TextEncoder();
    const tag = engineTag({ src: new URL('review.js', location.href).href, tour: '/review-tour.json', spa: isApp() });
    const files = {};
    let n = 0;
    for (const req of requests) {
      const path = decodeURIComponent(new URL(req.url).pathname.slice(PREFIX.length));
      const res = await cache.match(req);
      if (isHtml(path)) {
        const html = injectHtml(await res.text(), { head: '<meta name="robots" content="noindex">' + storageGuardTag(), body: tag });
        files['/' + path] = encoder.encode(html);
      } else {
        files['/' + path] = new Uint8Array(await res.arrayBuffer());
      }
      onProgress(++n, requests.length);
    }
    files['/review-tour.json'] = encoder.encode(JSON.stringify(tourForPublish(), null, 2) + '\n');
    // A single-page app (one HTML file) handles its own routes like /about:
    // let Netlify serve index.html for them, unless the project says otherwise.
    if (isApp() && !files['/_redirects']) files['/_redirects'] = encoder.encode('/*  /index.html  200\n');
    const ownHeaders = files['/_headers'] ? new TextDecoder().decode(files['/_headers']) + '\n' : '';
    files['/_headers'] = encoder.encode(ownHeaders + '/*\n  X-Robots-Tag: noindex\n');
    return files;
  }

  // Netlify's file-digest deploy: send the list of files with their SHA-1,
  // upload only the ones Netlify does not already have, wait until it is live.
  async function deploy(files, onProgress) {
    const digests = {};
    for (const path of Object.keys(files)) digests[path] = await sha1(files[path]);

    let d = await api('POST', '/sites/' + netlify.siteId + '/deploys', { files: digests });
    for (let i = 0; (d.state === 'new' || d.state === 'preparing') && i < 120; i++) {
      await sleep(1000);
      d = await api('GET', '/deploys/' + d.id);
    }
    if (d.state === 'error') throw new Error(d.error_message || 'Netlify could not prepare the deploy.');

    const required = new Set(d.required || []);
    const uploads = [];
    const seen = new Set();
    for (const path of Object.keys(files)) {
      const sha = digests[path];
      if (required.has(sha) && !seen.has(sha)) {
        seen.add(sha);
        uploads.push(path);
      }
    }

    let done = 0;
    onProgress(0, uploads.length);
    const queue = uploads.slice();
    const worker = async () => {
      while (queue.length) {
        const path = queue.shift();
        const url = '/deploys/' + d.id + '/files/' + encodePath(path.slice(1));
        try {
          await api('PUT', url, files[path]);
        } catch (e) {
          await sleep(1000);
          await api('PUT', url, files[path]); // one retry
        }
        onProgress(++done, uploads.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    for (let i = 0; i < 180; i++) {
      d = await api('GET', '/deploys/' + d.id);
      if (d.state === 'ready') return d;
      if (d.state === 'error') throw new Error(d.error_message || 'Netlify could not finish the deploy.');
      await sleep(1000);
    }
    throw new Error('Netlify is taking unusually long. Check the deploy in your Netlify dashboard.');
  }

  async function publish() {
    if (!netlify && !(await openNetlifySettings())) return;
    const steps = (readDraft() || {}).steps || [];
    if (!steps.length) {
      const ok = await confirmDialog('The tour is empty', 'The client will get the site without a guided tour. They can still comment anywhere. Publish anyway?', 'Publish');
      if (!ok) return;
    }

    const line = h('p', null, 'Preparing files…');
    const bar = h('div');
    const d = openDialog({ title: 'Publishing “' + project.name + '”', dismissable: false, body: [line, h('div', { class: 'progress' }, bar)] });
    const show = (text, done, total) => {
      line.textContent = text;
      bar.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    };

    try {
      const files = await buildSite((n, total) => show('Preparing files… ' + n + ' of ' + total, n, total));
      await deploy(files, (n, total) => show(total ? 'Uploading… ' + n + ' of ' + plural(total, 'file') : 'Nothing new to upload…', n, total));
      project.publishedAt = Date.now();
      project.publishedTourHash = tourHash();
      store.set(KEY.project, project);
      renderBar();
      showPublished(d);
    } catch (e) {
      const auth = e.status === 401;
      d.set([
        h('p', { class: 'error' }, auth ? 'Netlify did not accept your token. It may have been revoked.' : e.message),
        h('p', null, 'Nothing on the review site was changed.'),
      ], [
        auth && h('button', { class: 'btn', type: 'button', onclick: () => { d.close(); openNetlifySettings(); } }, 'Update token'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => d.close() }, 'OK'),
      ]);
    }
  }

  function showPublished(d) {
    const link = clientLink();
    const input = h('input', { type: 'text', readonly: true, value: link, onfocus: (e) => e.target.select() });
    d.set([
      h('p', null, '“' + project.name + '” is live on your review site with the current tour. Send this link to the client:'),
      h('div', { class: 'linkbox' }, input, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => copyLink() }, 'Copy')),
      h('p', { class: 'hint' }, 'Publishing again after changing the tour keeps the same link. The client’s comments stay on their phone.'),
    ], [
      h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Open as client'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => d.close() }, 'Done'),
    ]);
  }

  function copyLink() {
    const link = clientLink();
    if (!link) return;
    const done = () => toast('Client link copied.');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, () => window.prompt('Copy the client link:', link));
    } else {
      window.prompt('Copy the client link:', link);
    }
  }

  function openProjectMenu() {
    const d = openDialog({
      title: project.name,
      body: [
        h('dl', { class: 'facts' },
          h('dt', null, 'Pages'), h('dd', null, String(project.pages.length)),
          h('dt', null, 'Files'), h('dd', null, project.fileCount + ' (' + (project.size / 1048576).toFixed(1) + ' MB)'),
          h('dt', null, 'Tour'), h('dd', null, plural(((readDraft() || {}).steps || []).length, 'step')),
          h('dt', null, 'Client link'), h('dd', null, project.publishedAt && netlify ? clientLink() : 'Not published yet')),
        h('p', { class: 'hint' }, 'To start the next project, drop its folder anywhere on this page.'),
      ],
      actions: [
        h('button', { class: 'btn btn-danger', type: 'button', onclick: () => { d.close(); removeProject(); } }, 'Remove from tool'),
        h('label', { class: 'btn' }, 'Open another folder',
          h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true, onchange: (e) => { d.close(); pickFolder(e.target); } })),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => d.close() }, 'Close'),
      ],
    });
  }

  async function removeProject() {
    const ok = await confirmDialog('Remove “' + project.name + '”?', 'Its files, tour and loaded feedback are removed from this tool. The review site is not changed.', 'Remove', true);
    if (!ok) return;
    await caches.delete(PROJECT_CACHE);
    [KEY.project, KEY.draft, KEY.feedback, KEY.clientPreview].forEach(store.del);
    project = null;
    $('frame').removeAttribute('src');
    showWorkspace();
  }

  // --- drag and drop, folder input ---------------------------------------------------------

  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function pickFolder(input) {
    const list = Array.from(input.files || []).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    input.value = '';
    if (list.length) receiveFiles(Promise.resolve(list));
  }

  function wireDrop() {
    const veil = $('drop-veil');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      veil.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    veil.addEventListener('dragleave', (e) => {
      if (e.target === veil && !veil.contains(e.relatedTarget)) veil.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      veil.hidden = true;
      receiveFiles(filesFromDrop(e.dataTransfer));
    });
  }

  // --- start ---------------------------------------------------------------------------------

  async function init() {
    if (!('serviceWorker' in navigator) || !window.caches) {
      $('empty-note').textContent = 'This browser cannot run the preview. Use a current Chrome, Edge, Firefox or Safari, outside a private window.';
      $('folder-input').disabled = true;
      return;
    }
    swReady = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready);

    wireDrop();
    $('folder-input').addEventListener('change', (e) => pickFolder(e.target));
    $('frame').addEventListener('load', onFrameLoad);
    $('page-select').addEventListener('change', (e) => loadFrame(e.target.value));
    $('mode-author').addEventListener('click', () => setMode('author'));
    $('mode-client').addEventListener('click', () => setMode('client'));
    $('publish').addEventListener('click', publish);
    $('copy-link').addEventListener('click', copyLink);
    $('settings').addEventListener('click', openNetlifySettings);
    $('project-menu').addEventListener('click', openProjectMenu);
    // The engine in the preview writes the tour draft; keep the status honest.
    window.addEventListener('storage', (e) => { if (project && e.key === KEY.draft) renderStatus(); });
    setInterval(() => { if (project) renderStatus(); }, 30000);

    if (project && !(await projectStillStored())) {
      // The browser cleared its storage since last time.
      store.del(KEY.project);
      project = null;
      toast('The last project is no longer stored in this browser. Drop it again.', 6000);
    }
    await showWorkspace();
  }

  init();
})();
