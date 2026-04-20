#!/usr/bin/env bash
# Build the scrollantir fork of aw-watcher-web (Firefox / Zen) as an xpi.
#
#   1. Shallow-clones upstream ActivityWatch/aw-watcher-web at the pinned
#      commit into ./.build-src/ (gitignored by default because under
#      vendor/, but we write inside mac-extension/ to keep this self-
#      contained and reproducible).
#   2. Inits the media submodule (for logo-128.png).
#   3. Applies zen-container.patch.
#   4. Runs `npm ci` + vite firefox build.
#   5. Packages the build tree as artifacts/aw-watcher-web-zen.xpi.
#
# Requires: git, node (v20+), npm.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$HERE/.build-src"
UPSTREAM_URL="https://github.com/ActivityWatch/aw-watcher-web.git"
UPSTREAM_PIN="50d1c1cb7efa758d63b2509bcf5239b18183550c"
ARTIFACTS="$HERE/artifacts"

say() { printf "\033[1;34m[build]\033[0m %s\n" "$*"; }

rm -rf "$SRC_DIR"
mkdir -p "$ARTIFACTS"

say "cloning upstream at $UPSTREAM_PIN"
git clone --quiet "$UPSTREAM_URL" "$SRC_DIR"
(cd "$SRC_DIR" && git -c advice.detachedHead=false checkout --quiet "$UPSTREAM_PIN")

say "fetching media submodule (for logo-128.png)"
(cd "$SRC_DIR" && git submodule update --init --quiet)
cp "$SRC_DIR/media/logo/logo-128.png" "$SRC_DIR/logo-128.png"

say "applying zen-container.patch"
(cd "$SRC_DIR" && git apply "$HERE/zen-container.patch")

say "npm install"
(cd "$SRC_DIR" && npm ci --silent)

say "building firefox target"
(cd "$SRC_DIR" && VITE_TARGET_BROWSER=firefox npx vite build >/dev/null)

say "packaging xpi"
rm -f "$ARTIFACTS/aw-watcher-web-zen.xpi"
(cd "$SRC_DIR/build" && zip -q -FS -r "$ARTIFACTS/aw-watcher-web-zen.xpi" . -x "*.DS_Store")

say "done: $ARTIFACTS/aw-watcher-web-zen.xpi"
ls -la "$ARTIFACTS"
