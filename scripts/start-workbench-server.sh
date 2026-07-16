#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WORKBENCH_NODE_BIN:-$ROOT_DIR/.tooling/node/bin/node}"
NPM_BIN="${WORKBENCH_NPM_BIN:-$(dirname "$NODE_BIN")/npm}"
MONGO_URI="${WORKBENCH_MONGODB_URI:-mongodb://127.0.0.1:27017/?replicaSet=rs0}"
MONGO_DB="${WORKBENCH_MONGODB_DB:-looloomi_workbench}"
OBJECT_STORE_ROOT="${WORKBENCH_OBJECT_STORE_ROOT:-${HOME}/Library/Application Support/Looloomi/workbench-objects}"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "workbench_node_missing:$NODE_BIN" >&2
  exit 1
fi

if ! "$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1);
'; then
  echo "workbench_node_unsupported:$($NODE_BIN --version):requires_node_22.19_or_newer" >&2
  exit 1
fi

cd "$ROOT_DIR"
docker compose up -d --wait --wait-timeout 90 mongodb

docker compose exec -T mongodb mongosh --quiet --host 127.0.0.1:27017 --eval '
  const status = rs.status();
  if (status.set !== "rs0" || status.myState !== 1) {
    throw new Error(`mongodb_replica_set_unhealthy:${status.set}:${status.myState}`);
  }
  print(`mongodb_replica_set_ready:${status.set}`);
'

if [[ "${1:-}" == "--mongo-only" ]]; then
  exit 0
fi

ENTRYPOINT="${WORKBENCH_SERVER_ENTRYPOINT:-$ROOT_DIR/domains/backend/code/workbench-server/src/server.mjs}"
if [[ "$ENTRYPOINT" != /* ]]; then
  ENTRYPOINT="$ROOT_DIR/$ENTRYPOINT"
fi
if [[ ! -f "$ENTRYPOINT" ]]; then
  echo "workbench_server_entrypoint_missing:$ENTRYPOINT" >&2
  exit 1
fi

if [[ "${WORKBENCH_SKIP_WEB_BUILD:-0}" != "1" ]]; then
  WEB_DIR="$ROOT_DIR/domains/frontend/web/code/web-prototype"
  if [[ ! -x "$NPM_BIN" || ! -f "$WEB_DIR/package.json" ]]; then
    echo "workbench_web_build_tooling_missing:$NPM_BIN:$WEB_DIR" >&2
    exit 1
  fi
  (
    cd "$WEB_DIR"
    export PATH="$(dirname "$NODE_BIN"):$PATH"
    "$NPM_BIN" run build --silent
  )
fi

export WORKBENCH_MONGODB_URI="$MONGO_URI"
export WORKBENCH_MONGODB_DB="$MONGO_DB"
export WORKBENCH_OBJECT_STORE_ROOT="$OBJECT_STORE_ROOT"
exec "$NODE_BIN" --env-file-if-exists="$ROOT_DIR/.env" "$ENTRYPOINT"
