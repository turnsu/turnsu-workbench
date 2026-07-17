#!/bin/bash
set -euo pipefail

umask 077
port="${MONGO_PORT:-27017}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then
  exit 2
fi
install -d -m 700 -o mongodb -g mongodb /data/configdb
install -m 400 -o mongodb -g mongodb /run/secrets/mongo_replica_key /data/configdb/keyfile

exec docker-entrypoint.sh mongod \
  --replSet rs0 \
  --auth \
  --keyFile /data/configdb/keyfile \
  --port "$port" \
  --bind_ip_all
