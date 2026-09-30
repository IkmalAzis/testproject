#!/bin/sh
# Adds the review script to every HTML page of a site checkout.
#
# Run it on a review branch of the website repo (e.g. review/round-1), never on
# main. The site's AGENTS.md limits what JavaScript ships on main; the review
# script is not part of that.
#
#   sh inject.sh <site-dir> <review.js URL> [review-tour.json]
#
#   sh inject.sh . https://guided-review.netlify.app/review.js ~/Downloads/review-tour.json
#
# Safe to run again: pages that already have the tag are left alone, and the
# tour file is simply replaced.

set -eu

if [ $# -lt 2 ]; then
  echo "usage: sh inject.sh <site-dir> <review.js URL> [review-tour.json]" >&2
  exit 1
fi

SITE_DIR=$1
SCRIPT_URL=$2
TOUR_FILE=${3:-}

if [ ! -d "$SITE_DIR" ]; then
  echo "not a directory: $SITE_DIR" >&2
  exit 1
fi

TAG="<script src=\"$SCRIPT_URL\" data-tour=\"/review-tour.json\" data-guided-review defer></script>"

added=0
skipped=0
missing=0

# Split find's output on newlines only, so page names with spaces work.
set -f
IFS='
'
for page in $(find "$SITE_DIR" -type f -name '*.html' -not -path '*/node_modules/*' -not -path '*/.git/*'); do
  if grep -q 'data-guided-review' "$page"; then
    skipped=$((skipped + 1))
    continue
  fi
  if ! grep -qi '</body>' "$page"; then
    echo "  no </body>, left alone: $page" >&2
    missing=$((missing + 1))
    continue
  fi
  tmp="$page.inject.$$"
  # Insert the tag before the last </body> in the file.
  awk -v tag="$TAG" '
    { lines[NR] = $0; if (tolower($0) ~ /<\/body>/) last = NR }
    END {
      for (i = 1; i <= NR; i++) {
        if (i == last) {
          pos = index(tolower(lines[i]), "</body>")
          print substr(lines[i], 1, pos - 1) tag
          print substr(lines[i], pos)
        } else {
          print lines[i]
        }
      }
    }
  ' "$page" > "$tmp"
  mv "$tmp" "$page"
  added=$((added + 1))
done

if [ -n "$TOUR_FILE" ]; then
  cp "$TOUR_FILE" "$SITE_DIR/review-tour.json"
  echo "tour: copied to $SITE_DIR/review-tour.json"
fi

echo "pages: $added tagged, $skipped already tagged, $missing without </body>"
