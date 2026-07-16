#!/usr/bin/env bash
# Local LoopOps web review fallback that creates a single HTML file and never binds a port.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT_DIR/domains/frontend/web/code/web-prototype"

cd "$WEB_DIR"

echo "Building LoopOps offline review artifact."
echo "This command does not bind localhost and does not open a browser or macOS app."
npm run review:offline
