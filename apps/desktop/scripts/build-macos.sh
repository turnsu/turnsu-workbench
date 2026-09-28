#!/usr/bin/env bash
set -euo pipefail
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DESKTOP_DIR"
npm run package -- --platform=darwin
