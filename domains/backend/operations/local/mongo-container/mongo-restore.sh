#!/bin/bash
set -euo pipefail

source_database="${1:-}"
target_database="${2:-}"
if [[ ! "$source_database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
  exit 2
fi
if [[ ! "$target_database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}_test$ ]]; then
  exit 2
fi
username="$(cat /run/secrets/mongo_root_username)"
password="$(cat /run/secrets/mongo_root_password)"
port="${MONGO_PORT:-27017}"
config="$(mktemp /tmp/looloomi-mongorestore.XXXXXX.yml)"
trap 'rm -f "$config"' EXIT
chmod 600 "$config"
printf 'password: %s\n' "$password" > "$config"

mongorestore \
  --host "127.0.0.1:${port}" \
  --username "$username" \
  --authenticationDatabase admin \
  --config "$config" \
  --archive \
  --gzip \
  --drop \
  --nsFrom "${source_database}.*" \
  --nsTo "${target_database}.*"
