#!/bin/bash
set -euo pipefail

database="${1:-}"
if [[ ! "$database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}_test$ ]]; then
  exit 2
fi
exec /opt/looloomi/mongo-snapshot-summary.sh "$database"
