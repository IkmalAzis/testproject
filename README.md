# Guided Review Tool

Client review in writing instead of on a call. Drop a project folder into the
tool, write a short guided tour of the site, publish, and send the client one
link. The client walks the tour on their phone, comments, and sends the
comments back as text or a file.

One tool, deployed once. Nothing is ever added to a client's repo.

```
drop folder → write tour → Publish → Copy client link → client reviews → load feedback
```

---

## How it fits together

| Piece | Where it lives | Changes |
|---|---|---|
| **The tool** (`index.html`, `app.js`, `sw.js`, `review.js`, …) | Its own Netlify site, e.g. `guided-review.netlify.app` | Deployed once |
| **The review site** | A second Netlify site of yours, e.g. `review-ikmal.netlify.app` | Replaced by the tool each time you publish |
| **The project** | Your browser, while you work on it | Replaced when you drop the next one |

One project is live at a time. Publishing a new project replaces the old one on
the review site, so the old client link stops working. Nothing piles up
anywhere.

---

## Setting up (once)

1. Deploy this repo on Netlify as a plain static site: no build command,
   publish directory = repo root.
2. Open the tool. The first time you press **Publish**, it asks for:
   - a **Netlify personal access token** (Netlify → User settings →
     Applications → Personal access tokens). It is stored in this browser only.
   - a **review site name**. The tool creates `name.netlify.app` for you. If
     you already have a site with that name, it asks before using it, because
     everything on it is replaced on every publish.

Change or disconnect this later with **Netlify…** in the top bar.

## Each project

1. **Drop the project folder** anywhere on the tool page, or press
   **Choose folder**. The tool finds the folder with `index.html` in it, and
   leaves out hidden files, `.git` and `node_modules`. Nothing is uploaded yet.
2. **Write the tour** in the preview (desktop). Click the site's own links, or
   use the page list in the top bar, to move between pages.
   - **+ Pick an element**, click it, write one or two sentences (soft limit
     200 characters). **Select wider** steps out to the element around the one
     you clicked.
   - Drag steps to reorder them. ✎ edits, × deletes.
   - **Tour settings**: site name for the summary, and optionally your
     WhatsApp number and email for the client's send buttons.
   - The tour saves as you go.
3. **Client view** in the top bar shows exactly what the client will get,
   starting fresh each time you switch to it. A strip under the bar reminds
   you it is a test: nothing typed there is sent, and the send buttons in the
   summary are switched off.
4. **Publish.** The tool uploads the project, the tour, and one `<script>` tag
   on every page to your review site. Only files Netlify does not already have
   are uploaded, so publishing again after editing the tour takes seconds.
5. **Copy client link** and send it, e.g.
   `https://review-ikmal.netlify.app/?review=mtt-7f3k`. The link stays the same
   when you publish the same project again.
6. When feedback arrives, press **Load feedback** in the tour panel and open
   the file, or paste the text the client sent. Comments appear in place.
7. **Next project:** drop the next folder. The tool asks before replacing the
   current one. The review site keeps the old project until you publish.

The status in the top bar tells you whether the review site is up to date:
*Not published yet*, *Published 5 min ago*, or *Tour changed since publishing*.

---

## What the client gets (works on a phone)

- A welcome card: what this is, how many stops, about how long, and that
  nothing is sent until they press **Send feedback**.
- Each stop highlights one element, dims the rest slightly, and shows your note
  with **Previous / Next**, a counter (`3 / 12`) and an optional comment box.
  The note never covers the element, and a fixed site header never hides it.
  On a phone the note is a sheet above the toolbar and can be folded down.
  On a computer the note can be dragged by its top bar, e.g. off something it
  covers; it stays there until the next stop.
- **Add a comment**: tap anywhere on the page and type. The first time, a
  short animation shows a pointer (a fingertip on phones) dropping a pin.
- On a computer, hovering a toolbar button explains what it does.
- **This page**: *Anything about this page as a whole?*
- Everything saves on their device as they type; closing the tab loses nothing.
  Coming back to the link later: if they have not written anything yet, the
  welcome card shows again; if they have, a *Welcome back* card tells them how
  many comments are waiting to be sent and offers to continue the tour.
- **Send feedback** asks for their name, shows a plain-text summary, and offers
  **Copy text**, **WhatsApp**, **Email** and **Download file** (JSON).
- Forms on the site do not really send anything during the review.
- The review site is marked `noindex`, so search engines leave it alone.

The summary reads like this, and survives being pasted into WhatsApp:

```
WEBSITE REVIEW — Makmal Tangkasan Teknologi
Reviewer: Aina Rahman       Date: 30 Sept 2026

PAGE: Home  (index.html)
  Step 1 — "ICT, Fire, ELV and Software. One accountable partner."
    > Too technical for our buyers.

PAGE: About  (about.html)
  Overall: This page is too long.
  Free pin — near "Our certifications"
    > Add the ISO number.

TOTAL: 3 comments across 2 pages
```

---

## How it works

**Preview.** Dropped files are kept in the browser's Cache Storage. The service
worker (`sw.js`) serves them under `/preview/`, so the preview is an ordinary
same-origin page: relative links, images, CSS and `srcset` work unchanged, and
root-relative URLs (`/about.html`) are mapped into the project. Every HTML page
gets the review engine (`review.js`) added on the way out.

**Publish.** `app.js` builds the site as the client will see it: every file of
the project, a `<script src="https://<tool>/review.js">` tag and a noindex tag
on every page, `review-tour.json`, and a `_headers` rule adding
`X-Robots-Tag: noindex`. It sends Netlify the list of files with their SHA-1,
uploads only the ones Netlify asks for, and waits until the deploy is live.
Netlify's API allows this straight from the browser.

**Pages** are known by their path in the project: `index.html`, `about.html`.
The same page has the same name in the preview (`/preview/about.html`) and on
the review site (`/about.html` or `/about`).

**Anchoring.** When you pick an element, the tool records a CSS selector, the
tag, the first 40 characters of its text, and its box as a fraction of the page
size. On load it tries the selector, then tag + text, then falls back to the
recorded position, drawn as a dashed box with a note that the page has changed.
It never silently points at the wrong thing.

### Files

| File | What it does |
|---|---|
| `index.html`, `app.css`, `app.js` | The tool: drop zone, preview, top bar, Netlify publishing |
| `sw.js` | Serves the dropped project under `/preview/` and adds the engine to each page |
| `inject-html.js` | Adds tags to a page's HTML; shared by `app.js` and `sw.js` |
| `review.js`, `review.css` | The review engine: author panel, client tour, pins, summary. Loaded into the preview and into every published page |
| `demo/` | A small sample site to try the tool with: drop the `demo` folder |

### Stored in your browser (the tool's)

| Key | Storage | Holds |
|---|---|---|
| `gr-project` | Cache Storage | The project files, plus the preview settings |
| `gr:tool:project` | localStorage | Project name, pages, client link token, publish status |
| `gr:tool:netlify` | localStorage | Netlify token and review site |
| `gr:author:draft` | localStorage | The tour |
| `gr:author:feedback` | localStorage | Feedback you loaded |

The client's comments are stored on their own device, on the review site's
origin, under `gr:review:<token>`.

### File formats

**Tour** — `review-tour.json` on the review site:

```json
{
  "format": "guided-review/tour",
  "version": 1,
  "tourId": "t-57tkpr",
  "siteName": "Makmal Tangkasan Teknologi",
  "contact": { "whatsapp": "", "email": "" },
  "pages": { "about.html": { "path": "about.html", "title": "About" } },
  "steps": [
    {
      "id": "s-k2j9x0abc",
      "page": "about.html",
      "path": "about.html",
      "title": "A technology laboratory that builds complete ICT systems.",
      "note": "About page headline. Is this how you describe the company?",
      "anchor": {
        "selector": "body > main:nth-of-type(1) > section:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)",
        "tag": "h1",
        "text": "A technology laboratory that builds comp",
        "fx": 0.0531, "fy": 0.0512, "fw": 0.5, "fh": 0.061
      }
    }
  ]
}
```

**Feedback**, downloaded by the client:

```json
{
  "format": "guided-review/feedback",
  "version": 1,
  "tourId": "t-57tkpr",
  "siteName": "Makmal Tangkasan Teknologi",
  "reviewer": "Aina Rahman",
  "date": "2026-09-30T08:14:03.120Z",
  "pages": { "about.html": { "path": "about.html", "title": "About" } },
  "stepRefs": { "s-k2j9x0abc": { "n": 3, "title": "A technology laboratory…", "page": "about.html", "note": "…" } },
  "stepComments": { "s-k2j9x0abc": "Yes, but shorter." },
  "freePins": [
    {
      "id": "p-8d2k1mxyz", "page": "about.html", "path": "about.html",
      "anchor": { "selector": "…", "tag": "h2", "text": "Our certifications", "fx": 0.05, "fy": 0.6, "fw": 0.4, "fh": 0.02 },
      "offset": { "x": 0.4, "y": 0.5 },
      "label": "near \"Our certifications\" heading",
      "text": "Add the ISO number.",
      "created": "2026-09-30T08:10:44.001Z"
    }
  ],
  "pageComments": { "about.html": "This page is too long." }
}
```

---

## Limits

- **Static HTML only.** The tool shows the files you drop as they are. A site
  that needs a build step must be built first; drop the output folder.
- **One project at a time** on the review site. Publishing the next project
  ends the previous client link.
- **Your token and the preview share an origin.** Scripts in a project you
  preview could read the Netlify token stored by the tool. Only drop your own
  projects.
- **Publish from the deployed tool**, not from a local copy: published pages
  load `review.js` from the address the tool was opened at.
- Author mode is for desktop. The client side works on phones.

## Working on the tool locally

```sh
npx http-server -c-1 .     # service workers need http://localhost or https
```

Open <http://localhost:8080/> and drop the `demo` folder. To test publishing
without touching Netlify, point the tool at another API base:
`localStorage.setItem('gr:tool:api', 'http://localhost:8090/api/v1')`.
