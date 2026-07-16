#!/usr/bin/env bash
# Local LoopOps web review entry that never opens a browser or macOS app.
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
URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5184/}"

probe_loopops_url() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 2 "$1" 2>/dev/null | grep -q "LoopOps Admin"
}

cd "$WEB_DIR"

if probe_loopops_url "$URL"; then
  echo "LoopOps Web review is already available: $URL"
  echo "No browser or system app was opened."
  exit 0
fi

echo "Starting LoopOps Web review. Preferred URL: $URL"
echo "If that port is busy, Vite will print the actual Local URL below. Use the printed Local URL for review."
echo "This command only binds a local HTTP server. It does not call open, AppleScript, Chrome, Safari, or Accessibility."
exec npm run review
