#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HINT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_NODE="$REPO_HINT/.tooling/node/bin/node"
NODE_BIN="$LOCAL_NODE"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"

if [[ "${1:-}" == "--hard" ]]; then
  echo "destructive_reset_disabled: repository and App Support runtime directories are never removed" >&2
  echo "use: WECHAT_AGENT_TEST_MODE=1 WECHAT_AGENT_RUNTIME_ROOT=/private/tmp/<dir> MONGODB_DB=<name>_test scripts/reset-local-runtime.sh --isolated-test --yes" >&2
  exit 2
fi
if [[ "${1:-}" != "--isolated-test" || "${2:-}" != "--yes" ]]; then
  echo "usage: scripts/reset-local-runtime.sh --isolated-test --yes" >&2
  exit 2
fi
if [[ "${WECHAT_AGENT_TEST_MODE:-}" != "1" ]]; then
  echo "isolated_test_runtime_required" >&2
  exit 1
fi
if [[ -z "${WECHAT_AGENT_RUNTIME_ROOT:-}" || "${WECHAT_AGENT_RUNTIME_ROOT}" != /* ]]; then
  echo "absolute_temporary_runtime_root_required" >&2
  exit 1
fi
if [[ "${MONGODB_DB:-}" != *_test ]]; then
  echo "refusing_non_test_database" >&2
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found" >&2
  exit 1
fi

RUNTIME_PATHS_MODULE="$REPO_HINT/domains/agent/code/agent-runtime/lib/runtime-paths.mjs"
ROOT_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print repoRoot)"
ISOLATED_RUNTIME_ROOT="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print runtimeRoot)"
if [[ "$ISOLATED_RUNTIME_ROOT" == "$ROOT_DIR/runtime" ]]; then
  echo "refusing_repository_runtime_reset" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for isolated MongoDB reset." >&2
  exit 1
fi

"$ROOT_DIR/scripts/stop-agent-daemon.sh"
(cd "$ROOT_DIR" && docker compose up -d mongodb)
"$NODE_BIN" "$ROOT_DIR/domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs" --admin-runtime-reset

echo "isolated_test_runtime_reset=pass"
