#!/usr/bin/env bash
# Preflight for the Product-owned Agent Runtime boundary.
# It never reads or reports Provider credentials.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HINT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_NODE_BIN="$REPO_HINT/.tooling/node/bin"
[ -d "$LOCAL_NODE_BIN" ] && export PATH="$LOCAL_NODE_BIN:$PATH"
NODE_BIN="$(command -v node 2>/dev/null || true)"
RUNTIME_PATHS_MODULE="$REPO_HINT/domains/agent/code/agent-runtime/lib/runtime-paths.mjs"
if [ -n "$NODE_BIN" ]; then
  ROOT_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print repoRoot)"
else
  ROOT_DIR="$REPO_HINT"
fi
WORKBENCH_PORT="${WORKBENCH_PORT:-8798}"

# Prefer the project-local Node runtime if present.
ok="✓"; bad="✗"; warn="•"

echo "WeChat x On-chain Agent Runtime — preflight"
echo "-------------------------------------------"

# Node
if command -v node >/dev/null 2>&1; then
  NV="$(node -v)"; MAJ="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJ" -ge 22 ]; then echo "$ok Node $NV"; else echo "$bad Node $NV (need >= 22.19.0)"; fi
else
  echo "$bad Node.js not installed — run: nvm install 22  (or https://nodejs.org)"
fi

# Dependencies
if [ -d "$ROOT_DIR/domains/agent/code/agent-runtime/node_modules/@earendil-works" ]; then
  echo "$ok agent-runtime dependencies installed"
else
  echo "$bad dependencies missing — run: (cd domains/agent/code/agent-runtime && npm install)"
fi

# Product API readiness. The legacy port-8797 daemon is test-only and is not a
# production dependency or credential boundary.
if [ -n "$NODE_BIN" ]; then
  if "$NODE_BIN" -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/readyz`).then(async response => {
      if (!response.ok) process.exit(1);
      const readiness=await response.json();
      process.exit(readiness.status==="ready" ? 0 : 1);
    }).catch(() => process.exit(1));
  ' "$WORKBENCH_PORT" >/dev/null 2>&1; then
    echo "$ok Product Workbench ready on 127.0.0.1:$WORKBENCH_PORT"
  else
    echo "$warn Product Workbench not ready — run: scripts/start-workbench-server.sh"
  fi
fi

echo "-------------------------------------------"
echo "Provider readiness is evaluated by the Product model catalog and host Secret Store; this script does not inspect secrets."
