/*
 * Guided Review Tool — sw.js
 * Serves the dropped project from the browser's Cache Storage under /preview/,
 * so the preview is a real same-origin page: relative links, images, CSS and
 * srcset all work unchanged. Every HTML page gets the review engine added.
 */
importScripts('inject-html.js');

const { injectHtml, engineTag, encodePath } = self.GuidedReviewInject;

const PROJECT_CACHE = 'gr-project';
const PREFIX = '/preview/';
const INTERNAL = '/__gr/'; // tool data kept in the same cache (preview config, tour)
const ENGINE_MARK = 'gr-engine'; // query flag on the engine's own files

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.searchParams.has(ENGINE_MARK)) return;

  if (url.pathname === '/preview') {
    event.respondWith(Response.redirect(PREFIX, 302));
  } else if (url.pathname.startsWith(PREFIX)) {
    event.respondWith(serveProject(url));
  } else if (url.pathname.startsWith(INTERNAL)) {
    event.respondWith(serveInternal(url));
  } else {
    // A root-relative URL ("/about.html", "/img/logo.png") used by a previewed
    // page belongs to the project, not to the tool.
    event.respondWith(
      fromPreview(event).then((yes) => {
        if (!yes) return fetch(req);
        const mapped = new URL(PREFIX + url.pathname.replace(/^\/+/, '') + url.search, url.origin);
        return req.mode === 'navigate' ? Response.redirect(mapped.href, 302) : serveProject(mapped);
      })
    );
  }
});

async function fromPreview(event) {
  const req = event.request;
  if (req.mode === 'navigate') {
    return req.destination === 'iframe' && !!req.referrer && new URL(req.referrer).pathname.startsWith(PREFIX);
  }
  if (!event.clientId) return false;
  const client = await self.clients.get(event.clientId);
  return !!client && new URL(client.url).pathname.startsWith(PREFIX);
}

async function serveInternal(url) {
  const cache = await caches.open(PROJECT_CACHE);
  return (await cache.match(url.pathname)) || new Response('Not found', { status: 404 });
}

async function readConfig(cache) {
  const res = await cache.match(INTERNAL + 'config.json');
  try { return res ? await res.json() : {}; } catch (e) { return {}; }
}

async function serveProject(url) {
  const cache = await caches.open(PROJECT_CACHE);
  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(PREFIX.length)); } catch (e) { rel = url.pathname.slice(PREFIX.length); }

  const candidates = rel === '' || rel.endsWith('/')
    ? [rel + 'index.html']
    : [rel, rel + '.html', rel + '/index.html'];

  for (const path of candidates) {
    const res = await cache.match(PREFIX + encodePath(path));
    if (!res) continue;
    // A folder asked for without its slash: add it, or its relative links break.
    if (path === rel + '/index.html') return Response.redirect(url.pathname + '/' + url.search, 302);
    if (!/text\/html/i.test(res.headers.get('Content-Type') || '')) return res;

    const config = await readConfig(cache);
    const html = injectHtml(await res.text(), {
      body: engineTag({
        src: '/review.js?' + ENGINE_MARK,
        css: '/review.css?' + ENGINE_MARK,
        tour: INTERNAL + 'tour.json',
        root: PREFIX,
        mode: config.mode || 'author',
        embedded: true,
      }),
    });
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Not in this project</title>' +
    '<body style="font:16px system-ui,sans-serif;padding:40px;color:#334155">' +
    '<h1 style="font-size:20px">Not in this project</h1><p>The project has no file at <code>' +
    rel.replace(/</g, '&lt;') + '</code>.</p></body>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
