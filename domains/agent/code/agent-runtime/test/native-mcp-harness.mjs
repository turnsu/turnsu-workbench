import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

export async function connectNativeMcp(sessionPath) {
  const client = new Client({ name: "turnsu-native-acceptance", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.TURNSU_NATIVE_CONNECTOR_CLI || fileURLToPath(new URL("../integrations/native/cli.mjs", import.meta.url)), "mcp", "--session", sessionPath],
    env: {}, stderr: "pipe" });
  await client.connect(transport);
  return client;
}

// Exercise the distributable's own PKCE implementation outside the checkout.
export async function loginPortableNative({ cliPath, baseUrl, sessionPath, approve }) {
  const { spawn } = await import("node:child_process");
  const { tmpdir } = await import("node:os");
  return new Promise((resolveLogin, reject) => {
    const child = spawn(process.execPath, [cliPath, "login", "--url", baseUrl, "--session", sessionPath], { cwd: tmpdir(), env: {}, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", approval = null, failure;
    const timer = setTimeout(() => { failure = new Error("portable_login_timeout"); child.kill("SIGTERM"); }, 20_000);
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
      const url = stderr.match(/https?:\/\/[^\s]+\/native\/authorize\?[^\s]+/u)?.[0];
      if (url && !approval) approval = Promise.resolve().then(() => approve(url)).catch((error) => { failure = error; child.kill("SIGTERM"); });
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", async (code) => { clearTimeout(timer); await approval; if (failure) reject(failure); else if (code !== 0 || !approval) reject(new Error(`portable_login_failed:${code}`)); else resolveLogin(); });
  });
}
