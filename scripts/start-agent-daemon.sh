#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HINT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_NODE="$REPO_HINT/.tooling/node/bin/node"
NODE_BIN="$LOCAL_NODE"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found; Node >= 22.19.0 is required." >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=19) ? 0 : 1)'; then
  echo "Node $("$NODE_BIN" -v) is too old; Node >= 22.19.0 is required." >&2
  exit 1
fi

RUNTIME_PATHS_MODULE="$REPO_HINT/domains/agent/code/agent-runtime/lib/runtime-paths.mjs"
ROOT_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print repoRoot)"
RUNTIME_BASE="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print runtimeRoot)"
RUNTIME_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print agentDataRoot)"
LOG_FILE="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print daemonLogPath)"
PID_FILE="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print daemonPidPath)"
AUTH_FILE="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print authTokenPath)"
DAEMON_ENTRY="$ROOT_DIR/domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs"
DAEMON_PORT="${WECHAT_AGENT_DAEMON_PORT:-8797}"

if [[ "${WECHAT_AGENT_TEST_MODE:-}" == "1" ]]; then
  AUTH_MIRROR_FILE="${WECHAT_AGENT_AUTH_MIRROR_PATH:-$RUNTIME_DIR/auth-token.mirror.json}"
  if ! "$NODE_BIN" -e 'const p=require("node:path"); const [root,target]=process.argv.slice(1).map(value => p.resolve(value)); const rel=p.relative(root,target); process.exit(rel && !rel.startsWith("..") && !p.isAbsolute(rel) ? 0 : 1)' "$RUNTIME_BASE" "$AUTH_MIRROR_FILE"; then
    echo "test auth mirror must be inside the isolated runtime root" >&2
    exit 1
  fi
else
  if [[ -n "${WECHAT_AGENT_AUTH_MIRROR_PATH:-}" ]]; then
    echo "WECHAT_AGENT_AUTH_MIRROR_PATH is allowed only in test mode" >&2
    exit 1
  fi
  AUTH_MIRROR_FILE="$HOME/Library/Application Support/WeChatIntelligenceRadarMVP/runtime/agent/auth-token.json"
fi

mkdir -p "$(dirname "$LOG_FILE")"

pid_record_valid() {
  "$NODE_BIN" -e '
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
  ' "$PID_FILE"
}

pid_from_file() {
  "$NODE_BIN" -e 'const fs=require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).pid)' "$PID_FILE"
}

process_matches_daemon() {
  local pid="$1" command
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -n "$command" ]] && [[ "$command" == *"$DAEMON_ENTRY"* ]]
}

health_matches_pid_file() {
  "$NODE_BIN" -e '
    const fs=require("node:fs");
    const pid=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const port=process.argv[2];
    fetch(`http://127.0.0.1:${port}/health`).then(async response => {
      if (!response.ok) process.exit(1);
      const health=await response.json();
      const daemon=health.daemon || {};
      const keys=["owner","runtimeOwner","instanceID","pid","host","port","startedAt"];
      process.exit(keys.every(key => daemon[key]===pid[key]) ? 0 : 1);
    }).catch(() => process.exit(1));
  ' "$PID_FILE" "$DAEMON_PORT" >/dev/null 2>&1
}

port_responds() {
  "$NODE_BIN" -e 'fetch(`http://127.0.0.1:${process.argv[1]}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' "$DAEMON_PORT" >/dev/null 2>&1
}

mirror_canonical_token() {
  "$NODE_BIN" -e '
    const fs=require("node:fs");
    try {
      const token=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const pid=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
      const keys=["owner","runtimeOwner","instanceID","pid","host","port","startedAt"];
      const valid=token.schemaVersion==="agent-daemon-auth-token-v1"
        && typeof token.token==="string" && token.token.length>=32
        && keys.every(key => token[key]===pid[key]);
      process.exit(valid?0:1);
    } catch { process.exit(1); }
  ' "$AUTH_FILE" "$PID_FILE"
  mkdir -p "$(dirname "$AUTH_MIRROR_FILE")"
  cp "$AUTH_FILE" "$AUTH_MIRROR_FILE"
  chmod 600 "$AUTH_MIRROR_FILE" 2>/dev/null || true
}

if [[ -f "$PID_FILE" ]]; then
  if ! pid_record_valid; then
    echo "refusing_start_invalid_pid_owner" >&2
    exit 1
  fi
  EXISTING_PID="$(pid_from_file)"
  if kill -0 "$EXISTING_PID" 2>/dev/null; then
    if ! process_matches_daemon "$EXISTING_PID"; then
      echo "refusing_start_process_command_mismatch pid=$EXISTING_PID" >&2
      exit 1
    fi
    if ! health_matches_pid_file; then
      echo "refusing_start_health_owner_mismatch pid=$EXISTING_PID" >&2
      exit 1
    fi
    mirror_canonical_token
    echo "wechat-agent-daemon already running pid=$EXISTING_PID"
    exit 0
  fi
fi

if port_responds; then
  echo "refusing_start_unowned_health_on_port port=$DAEMON_PORT" >&2
  exit 1
fi

if [[ ! -d "$ROOT_DIR/domains/agent/code/agent-runtime/node_modules/mongodb" ]]; then
  echo "agent-runtime dependencies are missing; install them explicitly before starting" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Local MongoDB is required for Agent sessions/tasks/runs." >&2
  exit 1
fi

(cd "$ROOT_DIR" && docker compose up -d mongodb)

ENV_ARGS=()
if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_ARGS=(--env-file "$ROOT_DIR/.env")
fi

cd "$ROOT_DIR"
nohup "$NODE_BIN" "${ENV_ARGS[@]}" "$DAEMON_ENTRY" >>"$LOG_FILE" 2>&1 &
LAUNCHED_PID=$!

for _ in {1..120}; do
  if [[ -f "$PID_FILE" ]] && pid_record_valid && health_matches_pid_file; then
    PID="$(pid_from_file)"
    if process_matches_daemon "$PID"; then
      mirror_canonical_token
      echo "wechat-agent-daemon started pid=$PID"
      echo "log=$LOG_FILE"
      exit 0
    fi
  fi
  sleep 0.25
done

if kill -0 "$LAUNCHED_PID" 2>/dev/null && process_matches_daemon "$LAUNCHED_PID"; then
  kill "$LAUNCHED_PID" 2>/dev/null || true
fi
echo "wechat-agent-daemon did not become owned and healthy on 127.0.0.1:$DAEMON_PORT" >&2
tail -40 "$LOG_FILE" >&2 || true
exit 1
