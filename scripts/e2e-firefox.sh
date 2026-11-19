#!/usr/bin/env bash
# End-to-end test in a real Firefox DevTools, over Marionette. Firefox counterpart of e2e.sh.
# Saves a screenshot of the browser window, DevTools included, to dist/e2e-firefox.png.
# Usage: scripts/e2e-firefox.sh [extension dir or zip] [headed]   (default: this folder)
#
# Needs Node.js 22+ and Firefox. Install it once with
#   npx @puppeteer/browsers@3.2.3 install firefox@stable --path ~/.cache/puppeteer
# or give the binary in E2E_FIREFOX.
set -euo pipefail
cd "$(dirname "$0")/.."

src=${1:-.}
mode=${2:-}

firefox=${E2E_FIREFOX:-$(find "$HOME/.cache/puppeteer/firefox" -type f \
  \( -path '*/Firefox.app/Contents/MacOS/firefox' -o -path '*/firefox/firefox' \) 2>/dev/null \
  | sort -V | tail -1)}
if [ -z "$firefox" ] || [ ! -x "$firefox" ]; then
  echo "Firefox not found. Install it with:" >&2
  echo "  npx @puppeteer/browsers@3.2.3 install firefox@stable --path ~/.cache/puppeteer" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -f "$src" ]; then
  unzip -q "$src" -d "$tmp/ext"
  ext="$tmp/ext"
else
  ext=$(cd "$src" && pwd)
fi

mkdir -p dist
echo "firefox: $("$firefox" --version 2>/dev/null)"
echo "extension: $src"
node tests/e2e/firefox.mjs "$firefox" "$ext" dist/e2e-firefox.png $mode
echo "screenshot: dist/e2e-firefox.png"
