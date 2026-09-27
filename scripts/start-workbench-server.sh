#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WORKBENCH_NODE_BIN:-$ROOT_DIR/.tooling/node/bin/node}"
NPM_BIN="${WORKBENCH_NPM_BIN:-$(dirname "$NODE_BIN")/npm}"
ENV_FILE="${WORKBENCH_ENV_FILE:-$ROOT_DIR/.env}"

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
  "$NODE_BIN" --env-file-if-exists="$ENV_FILE" -e '
    const value = process.env[process.argv[1]];
    if (typeof value === "string") process.stdout.write(value);
  ' "$1"
}

POSTGRES_URL="${WORKBENCH_POSTGRES_URL:-$(env_value WORKBENCH_POSTGRES_URL)}"
OBJECT_STORE_ROOT="${WORKBENCH_OBJECT_STORE_ROOT:-$(env_value WORKBENCH_OBJECT_STORE_ROOT)}"
OBJECT_STORE_ROOT="${OBJECT_STORE_ROOT:-${HOME}/Library/Application Support/Looloomi/workbench-objects}"

if [[ -z "$POSTGRES_URL" ]]; then
  echo "workbench_postgres_url_missing:set_WORKBENCH_POSTGRES_URL" >&2
  exit 1
fi

cd "$ROOT_DIR"
if [[ "${WORKBENCH_MANAGED_POSTGRES:-0}" != "1" ]]; then
  docker compose up -d --wait --wait-timeout 90 postgres
  echo "postgres_ready"
fi

export WORKBENCH_POSTGRES_URL="$POSTGRES_URL"
export WORKBENCH_OBJECT_STORE_ROOT="$OBJECT_STORE_ROOT"

"$NODE_BIN" \
  "$ROOT_DIR/domains/backend/code/workbench-server/scripts/migrate-product-store.mjs" \
  --confirm-write
echo "postgres_migrations_ready"

if [[ "${1:-}" == "--database-only" ]]; then
  exit 0
fi

ENTRYPOINT="${WORKBENCH_SERVER_ENTRYPOINT:-$ROOT_DIR/domains/backend/code/workbench-server/bin/workbench-server.mjs}"
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

exec "$NODE_BIN" --env-file-if-exists="$ENV_FILE" "$ENTRYPOINT"
