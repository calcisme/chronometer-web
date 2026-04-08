#!/bin/bash
# Build script for Chronometer distribution.
# Produces:
#   dist/chronometer-engine.js   — shared rendering engine
#   dist/face-{name}.js          — per-face XML + image data
#   dist/{name}.html             — per-face viewer
#   dist/all.html                — all faces in a grid
#   dist/index.html              — face selector with thumbnails
set -e

ESBUILD="npx --yes esbuild"
DIST="dist"
SRC="src"
LOADER_FLAGS="--loader:.xml=text --loader:.png=dataurl"
COMMON_FLAGS="--format=iife --target=es2020"

mkdir -p "$DIST"

echo "=== Building engine ==="
$ESBUILD "$SRC/engine-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --outfile="$DIST/chronometer-engine.js"

echo "=== Building face data modules ==="
FACES="haleakala hana chandra selene"
for face in $FACES; do
  echo "  → face-$face.js"
  $ESBUILD "$SRC/faces/face-$face.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
    --outfile="$DIST/face-$face.js"
done

echo "=== Generating HTML files ==="

# Helper to get display title for each face
get_title() {
  case "$1" in
    haleakala) echo "Haleakalā" ;;
    hana)      echo "Hana" ;;
    chandra)   echo "Chandra" ;;
    selene)    echo "Selene" ;;
  esac
}

# Per-face HTML
for face in $FACES; do
  TITLE=$(get_title "$face")
  SCRIPTS='    <script src="chronometer-engine.js"><\/script>\
    <script src="face-'"$face"'.js"><\/script>'
  ICON="thumb-${face}.png"
  sed -e "s|{{TITLE}}|$TITLE|g" \
      -e "s|{{SCRIPTS}}|$SCRIPTS|g" \
      -e "s|{{ICON}}|$ICON|g" \
      "$SRC/face-template.html" > "$DIST/$face.html"
  echo "  → $face.html"
done

# all.html — loads all 4 faces
ALL_SCRIPTS='    <script src="chronometer-engine.js"><\/script>\
    <script src="face-haleakala.js"><\/script>\
    <script src="face-hana.js"><\/script>\
    <script src="face-chandra.js"><\/script>\
    <script src="face-selene.js"><\/script>'
sed -e "s|{{TITLE}}|All Faces|g" \
    -e "s|{{SCRIPTS}}|$ALL_SCRIPTS|g" \
    -e "s|{{ICON}}|thumb-all-faces.png|g" \
    "$SRC/face-template.html" > "$DIST/all.html"
echo "  → all.html"

# index.html — copy the selector page
cp "$SRC/index.html" "$DIST/index.html"
echo "  → index.html"

# Also copy thumbnail images and app icon if they exist
for f in "$SRC"/thumb-*.png "$SRC"/apple-touch-icon.png; do
  [ -f "$f" ] && cp "$f" "$DIST/" && echo "  → $(basename "$f")"
done

echo ""
echo "=== Build complete ==="
ls -lh "$DIST"/*.js "$DIST"/*.html

echo ""
echo "=== Creating zip archive ==="
rm -f dist.zip
(cd "$DIST" && zip -r ../dist.zip .)
echo "  → dist.zip ($(du -h dist.zip | cut -f1))"
