#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WORKBENCH_NODE_BIN:-$ROOT_DIR/.tooling/node/bin/node}"
NPM_BIN="${WORKBENCH_NPM_BIN:-$(dirname "$NODE_BIN")/npm}"

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

env_value() {
  "$NODE_BIN" --env-file-if-exists="$ROOT_DIR/.env" -e '
    const value = process.env[process.argv[1]];
    if (typeof value === "string") process.stdout.write(value);
  ' "$1"
}

MONGO_URI="${WORKBENCH_MONGODB_URI:-$(env_value WORKBENCH_MONGODB_URI)}"
MONGO_DB="${WORKBENCH_MONGODB_DB:-$(env_value WORKBENCH_MONGODB_DB)}"
OBJECT_STORE_ROOT="${WORKBENCH_OBJECT_STORE_ROOT:-$(env_value WORKBENCH_OBJECT_STORE_ROOT)}"
MONGO_DB="${MONGO_DB:-looloomi_workbench}"
OBJECT_STORE_ROOT="${OBJECT_STORE_ROOT:-${HOME}/Library/Application Support/Looloomi/workbench-objects}"

if [[ -z "$MONGO_URI" ]]; then
  echo "workbench_mongodb_uri_missing:set_WORKBENCH_MONGODB_URI_with_authenticated_credentials" >&2
  exit 1
fi

cd "$ROOT_DIR"
docker compose up -d --wait --wait-timeout 90 mongodb

if ! docker compose exec -T mongodb /bin/bash /opt/looloomi/mongo-healthcheck.sh; then
  echo "workbench_mongodb_replica_set_unhealthy" >&2
  exit 1
fi
echo "mongodb_replica_set_ready:rs0"

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
