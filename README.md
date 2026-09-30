# Guided Review Tool

A review layer for a static website. The author picks parts of the finished
site and writes a short note for each, in order, as a guided tour. The client
walks the tour at their own pace, comments in writing, and sends the comments
back. It replaces the review call.

No backend, no build step, no framework: one `review.js`, one `review.css`.

| File | What it is |
|---|---|
| `review.js` | The whole tool. Vanilla JS, no dependencies. |
| `review.css` | Styles for the tool's own UI. Loaded inside a shadow root, so it cannot touch the site and the site's Tailwind cannot touch it. |
| `inject.sh` | Adds the `<script>` tag to every page of a site checkout. Used only on review branches. |
| `demo/` | Three plain pages (Tailwind CDN) and a sample `review-tour.json`, for trying the tool. |

---

## Where the script runs (read this first)

**The review script is never committed to the website's `main` branch.**

The website's `AGENTS.md` limits shipped JavaScript to the mobile nav toggle,
the FAQ accordion, contact-form validation and an optional fade-in. The review
script is none of those, so it must not reach `main`.

An iframe from another origin is not an option either: JavaScript cannot reach
the elements of a page on another origin, so pins could not anchor to anything.

So the arrangement is:

1. **This repo** is deployed on its own (e.g. Netlify site `guided-review`,
   publish directory = repo root, no build command). That makes
   `https://<tool-site>/review.js` and `review.css` available.
2. **For each review round**, a branch is made in the *website* repo, e.g.
   `review/round-1`. On that branch only, `inject.sh` adds one line to every
   page:

   ```html
   <script src="https://<tool-site>/review.js" data-tour="/review-tour.json" data-guided-review defer></script>
   ```

   and `review-tour.json` is placed at the site root.
3. Netlify **branch deploys** publish that branch at its own URL, e.g.
   `https://review-round-1--<website>.netlify.app`.
4. The review branch is **never merged**. `main` stays clean and `AGENTS.md`
   is not violated. When the round is over, the branch can be deleted.

Without `?review=…` in the URL, the review deploy looks and behaves exactly
like the normal site: the script does nothing.

---

## A review round, step by step

### 1. Make the review branch

In the website repo:

```sh
git checkout main && git pull
git checkout -b review/round-1
sh /path/to/guided-review/inject.sh . https://<tool-site>/review.js
git commit -am "Review round 1: add review script (do not merge)"
git push -u origin review/round-1
```

In Netlify, turn on branch deploys for `review/round-1` (or for all branches)
under the site's *Branches and deploy contexts* settings.

### 2. Write the tour (author mode, desktop)

Open the branch deploy with `?review=author`:

```
https://review-round-1--<website>.netlify.app/?review=author
```

- **+ Pick an element**, then click the part of the page. It is highlighted
  and a note box opens. The panel fades while picking, so it never hides a
  target. `Esc` cancels.
- A click selects the innermost element. **Select wider** steps out to the
  element around it (e.g. from one card to the whole list).
- Notes are one or two sentences. The counter turns red past 200 characters;
  it is a soft limit.
- Move around the site with its normal links; author mode stays on for the tab.
  Each step remembers its page, so one tour can cover the whole site.
- Drag steps in the list to reorder them. ✎ edits a note, × deletes a step.
- **Tour settings**: the site name shown in the summary, and optionally your
  WhatsApp number and email address, which the client's WhatsApp and Email
  buttons will send to. Without them, the client picks the recipient.
- The draft is kept in this browser's `localStorage` as you go.

When done, press **Export tour**. This downloads `review-tour.json`.

### 3. Ship the tour

```sh
sh /path/to/guided-review/inject.sh . https://<tool-site>/review.js ~/Downloads/review-tour.json
git add review-tour.json
git commit -m "Review round 1: tour"
git push
```

(Running `inject.sh` again is safe. Pages already tagged are left alone; the
tour file is replaced.)

### 4. Send the client the link

Any value other than `author` works as the token. It only makes the URL hard
to guess; it is not security.

```
https://review-round-1--<website>.netlify.app/?review=acme-r1-7f3k
```

### 5. What the client sees (reviewer mode, works on a phone)

- A welcome card: what this is, how many stops, about how long, and that
  nothing is sent until they press **Send feedback**.
- Each stop highlights one element, dims the rest slightly, and shows the note
  with **Previous / Next**, a counter (`3 / 12`) and an optional comment box.
  The tooltip is placed beside the element, never on it. On a phone it is a
  sheet above the toolbar, the element is scrolled into the space above it,
  and the sheet can be folded to its title bar.
- **Next** on the last stop of a page opens the next page and carries on.
- **Add a comment** → tap anywhere → type. For things the tour did not ask.
- **This page** → *Anything about this page as a whole?* For "too long",
  "restructure this", "people won't read".
- Every keystroke is saved to `localStorage`. Closing the tab loses nothing;
  the same link resumes where they left off.
- **Send feedback** asks for their name (only here, not up front), shows the
  summary, and offers **Copy text**, **WhatsApp**, **Email** and
  **Download file** (JSON). Nothing is ever sent by the tool itself.

A long summary does not fit in a WhatsApp or email link. In that case the
button copies the summary to the clipboard first and tells the client to paste
it into the message.

### 6. Read the feedback in place

Open the branch deploy in author mode, press **Load feedback**, and either open
the JSON file or paste what the client sent. The plain-text summary works too,
including text copied out of WhatsApp.

- Comments are listed per page in the panel; click one to jump to it.
- Step comments show in that step's editor; steps with a comment get a pink dot.
- Free pins appear on the page where the client put them. Pins read from the
  plain-text summary have no position (the text does not carry one), so they
  are listed in the panel only.

---

## The summary

Plain text, readable anywhere, including WhatsApp without formatting:

```
WEBSITE REVIEW — Northwind Engineering
Reviewer: Aina Rahman       Date: 30 Sept 2026

PAGE: Home  (/index.html)
  Step 1 — "Mechanical and electrical engineering for industrial plants"
    > Too technical. Our buyers are plant managers.
  Step 3 — "Five service categories"
    > Energy audits should be first.
    > Maintenance is our main income.

PAGE: About  (/about.html)
  Overall: This page is too long. People will not read all of it.
  Free pin — near "Daniel Lee"
    > Please add Siti from procurement too.

TOTAL: 4 comments across 2 pages
```

A step's title is taken from the element: its own short text, else its first
heading, else the first words of the note. A free pin is labelled by the
nearest text around the spot that was tapped.

---

## How a pin stays attached to the page

When an element is picked, the tool records:

- a CSS selector path (rooted at the nearest unique `id`, else `nth-of-type`
  steps from `body`),
- the tag name,
- the first 40 characters of its text,
- its box as a fraction of the page width and height.

On load it resolves, in this order:

1. the selector, if it matches exactly one element of the same tag;
2. otherwise the first element with the same tag and the same text;
3. otherwise the recorded position, drawn as a **dashed** box with a note
   saying the page has changed since. It never silently points at the wrong
   thing.

An element that exists but is not displayed (e.g. inside a closed mobile menu)
is also shown dashed, with a note saying it is hidden right now.

Re-saving a step in author mode re-records its anchor, which repairs a step
that was only found by its text.

---

## File formats

Both files are JSON with a `format` and `version` field.

**Tour** — `review-tour.json`, written by *Export tour*:

```json
{
  "format": "guided-review/tour",
  "version": 1,
  "tourId": "t-57tkpr",
  "siteName": "Northwind Engineering",
  "contact": { "whatsapp": "60123456789", "email": "studio@example.com" },
  "pages": { "/about": { "path": "/about.html", "title": "About" } },
  "steps": [
    {
      "id": "s-k2j9x0abc",
      "page": "/about",
      "path": "/about.html",
      "title": "Leadership",
      "note": "Two people from leadership. Do you want photos here?",
      "anchor": {
        "selector": "body > main:nth-of-type(1) > h2:nth-of-type(2)",
        "tag": "h2",
        "text": "Leadership",
        "fx": 0.2125, "fy": 0.3791, "fw": 0.5625, "fh": 0.0287
      }
    }
  ]
}
```

`page` is the normalised page key (`/index.html` → `/`, `/about.html` →
`/about`, matching Netlify's pretty URLs); `path` is the URL used to navigate.

**Feedback**, downloaded by the client:

```json
{
  "format": "guided-review/feedback",
  "version": 1,
  "tourId": "t-57tkpr",
  "siteName": "Northwind Engineering",
  "reviewer": "Aina Rahman",
  "date": "2026-09-30T08:14:03.120Z",
  "pages": { "/about": { "path": "/about.html", "title": "About" } },
  "stepRefs": { "s-k2j9x0abc": { "n": 7, "title": "Leadership", "page": "/about", "note": "…" } },
  "stepComments": { "s-k2j9x0abc": "Add photos, yes." },
  "freePins": [
    {
      "id": "p-8d2k1mxyz",
      "page": "/about",
      "path": "/about.html",
      "anchor": { "selector": "…", "tag": "strong", "text": "Daniel Lee", "fx": 0.53, "fy": 0.47, "fw": 0.06, "fh": 0.01 },
      "offset": { "x": 0.4, "y": 0.5 },
      "label": "near \"Daniel Lee\"",
      "text": "Please add Siti from procurement too.",
      "created": "2026-09-30T08:10:44.001Z"
    }
  ],
  "pageComments": { "/about": "This page is too long." }
}
```

`stepRefs` is a copy of what the client saw for each step they commented on
(its number and title), so the feedback still reads correctly after the tour
has been edited. `offset` is where inside the element the pin was tapped.

### Where things are stored

| Key | Storage | Holds |
|---|---|---|
| `gr:mode` | sessionStorage | `author` or the reviewer token, so links inside the site keep the mode |
| `gr:author:draft` | localStorage | the tour being written |
| `gr:author:feedback` | localStorage | the feedback loaded for reading |
| `gr:review:<token>` | localStorage | the client's comments and tour progress |

Each branch deploy is its own origin, so each round starts clean.

---

## Trying it locally

`fetch()` of the tour does not work from `file://`, so serve the folder with
any static server:

```sh
npx http-server -c-1 .        # or: python3 -m http.server
```

- Author: <http://localhost:8080/demo/index.html?review=author>
- Client: <http://localhost:8080/demo/index.html?review=test-1>

The demo pages load `../review.js` and `demo/review-tour.json` directly.

To start over as a client, clear the site's storage in the browser, or use a
different token.

---

## Not in version one

Accounts, a server or database, real-time collaboration, screenshots or
drawing, threaded replies, sending email from the tool, and author mode on a
phone (reviewer mode does work on phones).
