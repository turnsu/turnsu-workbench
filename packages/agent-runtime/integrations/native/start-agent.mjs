import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loginNativeProduct } from "./login.mjs";
import { lockNativeProfile, readNativeProfile } from "./session.mjs";
import { assertProductOrigin } from "./product-tools.mjs";

const agents = new Set(["codex", "claude", "pi"]);
const execute = promisify(execFile);

// Host options apply only to this launch. Existing configuration and approvals remain owned by the host.
export function nativeAgentLaunch({ agent, cliPath, sessionPath, nodePath = process.execPath, env = process.env }) {
  if (!agents.has(agent)) throw new Error("native_agent_unsupported");
  const name = `turnsu_${createHash("sha256").update(sessionPath).digest("hex").slice(0, 12)}`;
  const args = [resolve(cliPath), "mcp", "--session", sessionPath];
  if (agent === "codex") return { command: "codex", args: ["-c", `mcp_servers.${name}.command=${JSON.stringify(nodePath)}`, "-c", `mcp_servers.${name}.args=${JSON.stringify(args)}`], env };
  if (agent === "claude") return { command: "claude", args: ["--mcp-config", JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: nodePath, args } } })], env };
  return { command: "pi", args: ["--extension", join(dirname(resolve(cliPath)), "pi-entry.mjs")], env: { ...env, TURNSU_SESSION_FILE: sessionPath } };
}

export async function nativeDefaultSession({ agent, baseUrl, home = homedir() }) {
  if (!agents.has(agent)) throw new Error("native_agent_unsupported");
  const origin = assertProductOrigin(baseUrl);
  const root = join(home, ".turnsu");
  const connections = join(root, "connections");
  const scope = join(connections, createHash("sha256").update(origin).digest("hex").slice(0, 32));
  for (const path of [root, connections, scope]) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("native_connection_private_directory_required");
    }
  }
  return join(scope, `${agent}.json`);
}

export async function startNativeAgent({ agent, baseUrl, cliPath, sessionPath, onAuthorization, onStatus, cwd = process.cwd() }) {
  if (!agents.has(agent)) throw new Error("native_agent_unsupported");
  const origin = assertProductOrigin(baseUrl);
  // Check installation before asking the user to grant a new connection.
  try { await execute(agent, ["--version"], { timeout: 15_000, maxBuffer: 64 * 1024 }); }
  catch { throw new Error(`native_agent_not_installed:${agent}`); }
  const path = sessionPath ? resolve(sessionPath) : await nativeDefaultSession({ agent, baseUrl: origin });
  const release = await lockNativeProfile(path);
  try {
    let existing;
    try { existing = await readNativeProfile(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existing && existing.baseUrl !== origin) throw new Error("native_session_origin_mismatch");
    if (!existing) await loginNativeProduct({ baseUrl: origin, sessionPath: path, onAuthorization });
    else if (existing.refreshPending || Date.parse(existing.tokens.refreshTokenExpiresAt) <= Date.now()) {
      throw new Error("native_session_reconnect_required");
    }
  } finally { await release(); }
  const launch = nativeAgentLaunch({ agent, cliPath, sessionPath: path });
  onStatus?.(`正在打开 ${agent}。工作目录：${cwd}\n本次连接不会修改 Agent 的全局配置。\n`);
  return new Promise((resolveExit, reject) => {
    const child = spawn(launch.command, launch.args, { cwd, env: launch.env, stdio: "inherit", shell: false });
    const forward = (signal) => child.kill(signal);
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
    const cleanup = () => { process.off("SIGINT", onInterrupt); process.off("SIGTERM", onTerminate); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolveExit(code ?? (signal ? 1 : 0)); });
  });
}
