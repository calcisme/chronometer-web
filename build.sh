#!/bin/bash
# Build script for Chronometer distribution.
# Produces:
#   dist/chronometer-engine.js   — shared rendering engine
#   dist/face-{name}.js          — per-face XML + image data
#   dist/{name}.html             — per-face viewer
#   dist/all.html                — all faces in a grid
#   dist/index.html              — face selector with thumbnails
#   dist/index-page.js           — index page location dialog logic
set -e

ESBUILD="npx --yes esbuild"
DIST="dist"
SRC="src"
LOADER_FLAGS="--loader:.xml=text --loader:.png=dataurl"
COMMON_FLAGS="--format=iife --target=es2020"

mkdir -p "$DIST"

echo "=== Checking URL abbreviation uniqueness ==="
ABBREVS=$(grep -roh "urlAbbrev='[^']*'" "$SRC"/watch/assets/*//*.xml | sed "s/urlAbbrev='//;s/'//" | sort)
DUPES=$(echo "$ABBREVS" | uniq -d)
if [ -n "$DUPES" ]; then
  echo "ERROR: Duplicate urlAbbrev values found: $DUPES" >&2
  exit 1
fi
echo "  ✓ All urlAbbrev values are unique ($(echo "$ABBREVS" | wc -l | tr -d ' ') faces)"

echo "=== Type-checking with tsc ==="
npx tsc --noEmit
echo "  ✓ No type errors"

echo "=== Building engine ==="
$ESBUILD "$SRC/engine-entry.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
  --outfile="$DIST/chronometer-engine.js"

echo "=== Building face data modules ==="
FACES="haleakala hana chandra selene mauna-kea geneva basel firenze venezia terra miami gaia babylon vienna kyoto"
for face in $FACES; do
  echo "  → face-$face.js"
  $ESBUILD "$SRC/faces/face-$face.ts" --bundle $LOADER_FLAGS $COMMON_FLAGS \
    --outfile="$DIST/face-$face.js"
done

echo "=== Building index page script ==="
$ESBUILD "$SRC/index-page.ts" --bundle $COMMON_FLAGS \
  --outfile="$DIST/index-page.js"
echo "  → index-page.js"

echo "=== Building pick page script ==="
$ESBUILD "$SRC/pick-page.ts" --bundle $COMMON_FLAGS \
  --outfile="$DIST/pick-page.js"
echo "  → pick-page.js"

echo "=== Generating HTML files ==="

# Helper: inject partial files into a template.
# Reads from stdin, writes to stdout.
# Replaces lines containing {{LOCATION_CSS}}, {{LOCATION_DIALOG}},
# {{TIME_CSS}}, {{TIME_CONTROLLER}}, and terra city dialog placeholders.
inject_partials() {
    local HELP_FILE="${1:-}"
    awk -v P="$SRC/partials" -v H="$HELP_FILE" '
    /\{\{ *LOCATION_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.css")) > 0) print line; close(P"/location-dialog.css");
        s=$0; sub(/.*\{\{ *LOCATION_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *LOCATION_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.html")) > 0) print line; close(P"/location-dialog.html");
        s=$0; sub(/.*\{\{ *LOCATION_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.css")) > 0) print line; close(P"/time-controller.css");
        s=$0; sub(/.*\{\{ *TIME_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CONTROLLER *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CONTROLLER *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.html")) > 0) print line; close(P"/time-controller.html");
        s=$0; sub(/.*\{\{ *TIME_CONTROLLER *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_CSS *\}\}/ { next }
    /\{\{ *TERRA_CITY_DIALOG *\}\}/ { next }
    /\{\{ *HELP_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_CONTENT *\}\}.*/, "", s); printf "%s", s;
        if (H != "") { while ((getline line < H) > 0) print line; close(H) };
        s=$0; sub(/.*\{\{ *HELP_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *PRIVACY_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *PRIVACY_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/privacy-content.html")) > 0) print line; close(P"/privacy-content.html");
        s=$0; sub(/.*\{\{ *PRIVACY_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *SUPPORT_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *SUPPORT_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/support-content.html")) > 0) print line; close(P"/support-content.html");
        s=$0; sub(/.*\{\{ *SUPPORT_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *DISCLAIMER_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *DISCLAIMER_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/disclaimer-content.html")) > 0) print line; close(P"/disclaimer-content.html");
        s=$0; sub(/.*\{\{ *DISCLAIMER_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_SUBVIEW_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_SUBVIEW_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/help-subview.css")) > 0) print line; close(P"/help-subview.css");
        s=$0; sub(/.*\{\{ *HELP_SUBVIEW_CSS *\}\}/, "", s); print s; next
    }
    { print }
    '
}

# Same as inject_partials but includes terra city dialog content.
inject_partials_terra() {
    local HELP_FILE="${1:-}"
    awk -v P="$SRC/partials" -v H="$HELP_FILE" '
    /\{\{ *LOCATION_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.css")) > 0) print line; close(P"/location-dialog.css");
        s=$0; sub(/.*\{\{ *LOCATION_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *LOCATION_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *LOCATION_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/location-dialog.html")) > 0) print line; close(P"/location-dialog.html");
        s=$0; sub(/.*\{\{ *LOCATION_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.css")) > 0) print line; close(P"/time-controller.css");
        s=$0; sub(/.*\{\{ *TIME_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TIME_CONTROLLER *\}\}/ { 
        s=$0; sub(/\{\{ *TIME_CONTROLLER *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/time-controller.html")) > 0) print line; close(P"/time-controller.html");
        s=$0; sub(/.*\{\{ *TIME_CONTROLLER *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *TERRA_CITY_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/terra-city-dialog.css")) > 0) print line; close(P"/terra-city-dialog.css");
        s=$0; sub(/.*\{\{ *TERRA_CITY_CSS *\}\}/, "", s); print s; next
    }
    /\{\{ *TERRA_CITY_DIALOG *\}\}/ { 
        s=$0; sub(/\{\{ *TERRA_CITY_DIALOG *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/terra-city-dialog.html")) > 0) print line; close(P"/terra-city-dialog.html");
        s=$0; sub(/.*\{\{ *TERRA_CITY_DIALOG *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_CONTENT *\}\}.*/, "", s); printf "%s", s;
        if (H != "") { while ((getline line < H) > 0) print line; close(H) };
        s=$0; sub(/.*\{\{ *HELP_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *PRIVACY_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *PRIVACY_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/privacy-content.html")) > 0) print line; close(P"/privacy-content.html");
        s=$0; sub(/.*\{\{ *PRIVACY_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *SUPPORT_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *SUPPORT_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/support-content.html")) > 0) print line; close(P"/support-content.html");
        s=$0; sub(/.*\{\{ *SUPPORT_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *DISCLAIMER_CONTENT *\}\}/ { 
        s=$0; sub(/\{\{ *DISCLAIMER_CONTENT *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/disclaimer-content.html")) > 0) print line; close(P"/disclaimer-content.html");
        s=$0; sub(/.*\{\{ *DISCLAIMER_CONTENT *\}\}/, "", s); print s; next
    }
    /\{\{ *HELP_SUBVIEW_CSS *\}\}/ { 
        s=$0; sub(/\{\{ *HELP_SUBVIEW_CSS *\}\}.*/, "", s); printf "%s", s;
        while ((getline line < (P"/help-subview.css")) > 0) print line; close(P"/help-subview.css");
        s=$0; sub(/.*\{\{ *HELP_SUBVIEW_CSS *\}\}/, "", s); print s; next
    }
    { print }
    '
}

# Helper to get display title for each face
get_title() {
  case "$1" in
    haleakala)  echo "Haleakalā" ;;
    hana)       echo "Hana" ;;
    chandra)    echo "Chandra" ;;
    selene)     echo "Selene" ;;
    mauna-kea)  echo "Mauna Kea" ;;
    geneva)     echo "Geneva" ;;
    basel)      echo "Basel" ;;
    firenze)    echo "Firenze" ;;
    venezia)    echo "Venezia" ;;
    terra)      echo "Terra" ;;
    miami)      echo "Miami" ;;
    gaia)       echo "Gaia" ;;
    babylon)    echo "Babylon" ;;
    vienna)     echo "Vienna" ;;
    kyoto)      echo "Kyoto" ;;
  esac
}

# Helper to get help file path for each face
get_help_file() {
  local f="$SRC/help/$1.html"
  if [ -f "$f" ]; then
    echo "$f"
  fi
}

# Per-face HTML
for face in $FACES; do
  TITLE=$(get_title "$face")
  SCRIPTS='    <script src="chronometer-engine.js"><\/script>\
    <script src="face-'"$face"'.js"><\/script>'
  ICON="thumb-${face}.png"
  # Use city-dialog partial injection for faces with city customization
  if [ "$face" = "terra" ] || [ "$face" = "gaia" ]; then
    INJECTOR=inject_partials_terra
  else
    INJECTOR=inject_partials
  fi
  HELP_FILE=$(get_help_file "$face")
  sed -e "s|{{TITLE}}|$TITLE|g" \
      -e "s|{{SCRIPTS}}|$SCRIPTS|g" \
      -e "s|{{ICON}}|$ICON|g" \
      "$SRC/face-template.html" | $INJECTOR "$HELP_FILE" > "$DIST/$face.html"
  echo "  → $face.html"
done

# all.html / selected.html — loads all faces
ALL_SCRIPTS='    <script src="chronometer-engine.js"><\/script>\
    <script src="face-mauna-kea.js"><\/script>\
    <script src="face-haleakala.js"><\/script>\
    <script src="face-hana.js"><\/script>\
    <script src="face-chandra.js"><\/script>\
    <script src="face-selene.js"><\/script>\
    <script src="face-geneva.js"><\/script>\
    <script src="face-basel.js"><\/script>\
    <script src="face-firenze.js"><\/script>\
    <script src="face-venezia.js"><\/script>\
    <script src="face-terra.js"><\/script>\
    <script src="face-miami.js"><\/script>\
    <script src="face-gaia.js"><\/script>\
    <script src="face-babylon.js"><\/script>\
    <script src="face-vienna.js"><\/script>\
    <script src="face-kyoto.js"><\/script>'

# Generate combined help file for multi-face pages
COMBINED_HELP="$DIST/.combined-help.html"
: > "$COMBINED_HELP"
for face in $FACES; do
  HELP_FILE=$(get_help_file "$face")
  if [ -n "$HELP_FILE" ]; then
    TITLE=$(get_title "$face")
    echo "<details class=\"face-help-section\" data-face=\"$face\"><summary>$TITLE</summary>" >> "$COMBINED_HELP"
    cat "$HELP_FILE" >> "$COMBINED_HELP"
    echo "</details>" >> "$COMBINED_HELP"
  fi
done

sed -e "s|{{TITLE}}|All Faces|g" \
    -e "s|{{SCRIPTS}}|$ALL_SCRIPTS|g" \
    -e "s|{{ICON}}|thumb-all-faces.png|g" \
    "$SRC/face-template.html" | inject_partials "$COMBINED_HELP" > "$DIST/all.html"
echo "  → all.html"

# selected.html — loads all faces; engine filters by picks param
sed -e "s|{{TITLE}}|Selected Faces|g" \
    -e "s|{{SCRIPTS}}|$ALL_SCRIPTS|g" \
    -e "s|{{ICON}}|thumb-all-faces.png|g" \
    "$SRC/face-template.html" | inject_partials "$COMBINED_HELP" > "$DIST/selected.html"
echo "  → selected.html"

# index.html — process with partial injection (includes combined help)
inject_partials "$COMBINED_HELP" < "$SRC/index.html" > "$DIST/index.html"
echo "  → index.html"
rm -f "$COMBINED_HELP"

# pick.html — face picker page (simple copy, no partials needed)
cp "$SRC/pick.html" "$DIST/pick.html"
echo "  → pick.html"

# help.html — general help topics page (simple copy)
cp "$SRC/help.html" "$DIST/help.html"
echo "  → help.html"

# privacy.html — privacy policy
inject_partials < "$SRC/privacy.html" > "$DIST/privacy.html"
echo "  → privacy.html"

# support.html — support info
inject_partials < "$SRC/support.html" > "$DIST/support.html"
echo "  → support.html"

# disclaimer.html — legal disclaimer
inject_partials < "$SRC/disclaimer.html" > "$DIST/disclaimer.html"
echo "  → disclaimer.html"

# cities-data.js — city database for location picker (if generated)
if [ -f "$SRC/cities-data.js" ]; then
  cp "$SRC/cities-data.js" "$DIST/cities-data.js"
  echo "  → cities-data.js ($(du -h "$DIST/cities-data.js" | cut -f1))"
fi

# Also copy thumbnail images and app icon if they exist
for f in "$SRC"/faces/thumb-*.png "$SRC"/apple-touch-icon.png; do
  [ -f "$f" ] && cp "$f" "$DIST/" && echo "  → $(basename "$f")"
done

# Copy help images to dist
if [ -d "$SRC/help/images" ]; then
  echo ""
  echo "=== Copying help images ==="
  mkdir -p "$DIST/help/images"
  cp -r "$SRC"/help/images/* "$DIST/help/images/"
  echo "  → help/images/ ($(find "$DIST/help/images" -type f | wc -l | tr -d ' ') files)"
fi

echo ""
echo "=== Build complete ==="
ls -lh "$DIST"/*.js "$DIST"/*.html

echo ""
echo "=== Creating zip archive ==="
rm -f dist.zip
(cd "$DIST" && zip -r ../dist.zip .)
echo "  → dist.zip ($(du -h dist.zip | cut -f1))"
