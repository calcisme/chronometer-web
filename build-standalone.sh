#!/bin/bash
# build-standalone.sh — Build the standalone Chronometer web app
#
# Produces two files in dist/:
#   index.html      — self-contained HTML page
#   chronometer.js  — bundled JS with embedded XML
#
# Usage:
#   ./build-standalone.sh
#
# Open dist/index.html directly in a browser (file:// works, no server needed).

set -euo pipefail
cd "$(dirname "$0")"

echo "Building standalone Chronometer…"

# Bundle TypeScript → single JS file (XML embedded as string, PNGs as data URLs)
npx esbuild src/standalone.ts \
  --bundle \
  --loader:.xml=text \
  --loader:.png=dataurl \
  --outfile=dist/chronometer.js \
  --format=iife \
  --target=es2020

# Copy the standalone HTML shell
cp src/standalone.html dist/index.html

echo "Done → dist/index.html + dist/chronometer.js"
