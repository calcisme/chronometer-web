#!/bin/bash
# Clone the iOS/Android reference repositories for development.
# These are not required for building or running the web app,
# but are essential for porting new faces or tracing algorithm implementations.
#
# Usage:
#   ./scripts/clone-refs.sh
#
# The repos are cloned into dot-prefixed directories at the project root
# (.chronometer-ref, .esastro-ref, etc.) which are listed in .gitignore.

set -e
cd "$(dirname "$0")/.."

clone_if_missing() {
    local dir="$1" url="$2"
    if [ -d "$dir" ]; then
        echo "✓ $dir already exists"
    else
        echo "Cloning $url → $dir ..."
        git clone "$url" "$dir"
    fi
}

clone_if_missing .chronometer-ref https://github.com/EmeraldSequoia/Chronometer.git
clone_if_missing .esastro-ref    https://github.com/EmeraldSequoia/esastro.git
clone_if_missing .eslocation-ref https://github.com/EmeraldSequoia/eslocation.git
clone_if_missing .estime-ref     https://github.com/EmeraldSequoia/estime.git
clone_if_missing .observatory-ref https://github.com/EmeraldSequoia/Observatory.git

echo ""
echo "All reference repos ready."
