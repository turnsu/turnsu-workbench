#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HINT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_NODE="$REPO_HINT/.tooling/node/bin/node"
NODE_BIN="$LOCAL_NODE"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found; refusing to inspect daemon ownership." >&2
  exit 1
fi

RUNTIME_PATHS_MODULE="$REPO_HINT/domains/agent/code/agent-runtime/lib/runtime-paths.mjs"
ROOT_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print repoRoot)"
PID_FILE="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print daemonPidPath)"
DAEMON_ENTRY="$ROOT_DIR/domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs"
DAEMON_PORT="${WECHAT_AGENT_DAEMON_PORT:-8797}"

port_responds() {
  "$NODE_BIN" -e 'fetch(`http://127.0.0.1:${process.argv[1]}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$DAEMON_PORT" >/dev/null 2>&1
}

if [[ ! -f "$PID_FILE" ]]; then
  if port_responds; then
    echo "refusing_stop_health_without_pid_owner" >&2
    exit 1
  fi
  echo "wechat-agent-daemon not running"
  exit 0
fi

if ! "$NODE_BIN" -e '
  const fs=require("node:fs");
  try {
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const valid=value.schemaVersion==="agent-daemon-pid-v1"
      && value.owner==="looloomi-agent-runtime"
      && value.runtimeOwner==="repository-runtime-agent-v1"
      && Number.isInteger(value.pid) && value.pid>0
      && typeof value.instanceID==="string" && value.instanceID.length>0
      && value.host==="127.0.0.1"
      && Number.isInteger(value.port)
      && typeof value.startedAt==="string" && value.startedAt.length>0;
    process.exit(valid?0:1);
  } catch { process.exit(1); }
' "$PID_FILE"; then
  echo "refusing_stop_invalid_pid_owner" >&2
  exit 1
fi

PID="$("$NODE_BIN" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).pid)' "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "wechat-agent-daemon pid=$PID is not active; stale PID file retained for daemon ownership safety"
  exit 0
fi

PROCESS_COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
if [[ -z "$PROCESS_COMMAND" || "$PROCESS_COMMAND" != *"$DAEMON_ENTRY"* ]]; then
  echo "refusing_stop_process_command_mismatch pid=$PID" >&2
  exit 1
fi

if ! "$NODE_BIN" -e '
  const fs=require("node:fs");
  const pid=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  fetch(`http://127.0.0.1:${process.argv[2]}/health`).then(async response => {
    if (!response.ok) process.exit(1);
    const health=await response.json();
    const daemon=health.daemon || {};
    const keys=["owner","runtimeOwner","instanceID","pid","host","port","startedAt"];
    process.exit(keys.every(key => daemon[key]===pid[key]) ? 0 : 1);
  }).catch(() => process.exit(1));
' "$PID_FILE" "$DAEMON_PORT" >/dev/null 2>&1; then
  echo "refusing_stop_health_owner_mismatch pid=$PID" >&2
  exit 1
fi

kill -TERM "$PID"
for _ in {1..100}; do
  if [[ ! -f "$PID_FILE" ]]; then
    echo "wechat-agent-daemon stopped pid=$PID"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "daemon exited but did not clean its owned PID file" >&2
    exit 1
  fi
  sleep 0.1
done

echo "wechat-agent-daemon did not stop after SIGTERM pid=$PID" >&2
exit 1
