#!/bin/bash
set -euo pipefail

database="${1:-}"
if [[ ! "$database" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}_test$ ]]; then
  exit 2
fi
username="$(cat /run/secrets/mongo_root_username)"
password="$(cat /run/secrets/mongo_root_password)"
port="${MONGO_PORT:-27017}"

exec mongosh --quiet \
  --host "127.0.0.1:${port}" \
  --username "$username" \
  --password "$password" \
  --authenticationDatabase admin \
  "$database" \
  --eval 'db.dropDatabase(); print(JSON.stringify({dropped:true}))'
