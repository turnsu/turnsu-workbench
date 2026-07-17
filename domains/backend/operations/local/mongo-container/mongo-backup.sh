#!/bin/bash
set -euo pipefail

database="${1:-}"
if [[ ! "$database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  exit 2
fi
username="$(cat /run/secrets/mongo_root_username)"
password="$(cat /run/secrets/mongo_root_password)"
port="${MONGO_PORT:-27017}"
config="$(mktemp /tmp/looloomi-mongodump.XXXXXX.yml)"
trap 'rm -f "$config"' EXIT
chmod 600 "$config"
printf 'password: %s\n' "$password" > "$config"

mongodump \
  --host "127.0.0.1:${port}" \
  --username "$username" \
  --authenticationDatabase admin \
  --config "$config" \
  --db "$database" \
  --archive \
  --gzip
