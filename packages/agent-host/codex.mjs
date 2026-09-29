import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { accessSync, statSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, delimiter, isAbsolute } from "node:path";
import { nativeCommand, closeNativeProcess } from './native-process.mjs';

export function executable(name, env = process.env) {
  const dirs = [...(env.PATH || "").split(delimiter), ...(process.platform === 'win32' ? [env.APPDATA ? join(env.APPDATA, 'npm') : ''] : [join(homedir(), ".nvm/current/bin"), "/opt/homebrew/bin", "/usr/local/bin"])];
  const names = process.platform === 'win32' ? [name + '.exe', name + '.cmd', name] : [name];
  return dirs.filter((dir) => isAbsolute(dir)).flatMap(dir => names.map(name => join(dir, name))).find((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  }) || null;
}

export function discoverAgents() {
  return ["codex", "pi", "claude", "opencode"].map((id) => {
    const path = executable(id);
    // Existence is deliberately not reported as login or execution readiness.
    return { id, name: { codex: "Codex", pi: "Pi", claude: "Claude Code", opencode: "OpenCode" }[id], installed: Boolean(path), supported: true };
  });
}

export class CodexConnection {
  constructor({ onEvent, onRequest, onExit, gateway = null, binary = executable("codex"), spawnProcess = spawn }) {
    if (!binary) throw new Error("请先安装 Codex CLI，再重新打开 Agent 列表。");
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    const args = ['app-server'];
    if (gateway) {
      const provider = `turnsu_${gateway.id.replaceAll('-', '')}`;
      for (const [key, value] of Object.entries({ model_provider: provider, [`model_providers.${provider}.name`]: gateway.name, [`model_providers.${provider}.base_url`]: gateway.baseUrl, [`model_providers.${provider}.wire_api`]: 'responses', [`model_providers.${provider}.env_key`]: 'TURNSU_GATEWAY_KEY', [`model_providers.${provider}.requires_openai_auth`]: false, [`model_providers.${provider}.supports_websockets`]: false })) args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
    const launch = nativeCommand(binary, args, executable('node'));
    this.child = spawnProcess(launch.file, launch.args, { stdio: ["pipe", "pipe", "pipe"], shell: false, detached: process.platform !== 'win32', env: { ...process.env, ...(gateway ? { TURNSU_GATEWAY_KEY: gateway.apiKey } : {}), PATH: `${dirname(binary)}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ""}` } });
    this.child.stderr.on("data", () => {}); // Native diagnostics may contain private paths; never dump them into the UI.
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) onRequest(message);
        else onEvent(message);
      } else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "Codex 请求失败。"));
        else pending.resolve(message.result);
      }
    });
    const exit = () => {
      if (this.closed) return;
      this.closed = true;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex 连接已断开；请恢复会话后检查执行结果。")); }
      this.pending.clear(); onExit();
    };
    this.child.on("error", exit); this.child.on("exit", exit);
    this.ready = this.request("initialize", { clientInfo: { name: "turnsu_desktop", version: "0.1.0" }, capabilities: { experimentalApi: true } })
      .then(() => this.write({ method: "initialized" }));
  }
  write(message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error("Codex 连接已断开。");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params, timeout = 30_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("等待 Codex 响应超时。请恢复会话核对结果，不要重复发送任务。")); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  respond(id, result) { this.write({ id, result }); }
  reject(id) { this.write({ id, error: { code: -32601, message: "This interaction is not supported by Turnsu Desktop yet." } }); }
  async close() {
    await closeNativeProcess(this.child);
  }
}
