import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeAgentLaunch, nativeDefaultSession } from "../integrations/native/start-agent.mjs";
import { writeNativeProfile } from "../integrations/native/session.mjs";

const execute = promisify(execFile);
const origin = "https://team.example.test";
test("default credentials remain private, separate by host and Agent, and reject a linked credential directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "turnsu-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await nativeDefaultSession({ agent: "codex", baseUrl: origin, home: dir });
  const b = await nativeDefaultSession({ agent: "pi", baseUrl: origin, home: dir });
  const c = await nativeDefaultSession({ agent: "codex", baseUrl: "https://other.example.test", home: dir });
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal((await stat(join(dir, ".turnsu"))).mode & 0o077, 0);
  await mkdir(join(dir, "other"));
  await symlink(join(dir, ".turnsu"), join(dir, "other", ".turnsu"));
  await assert.rejects(nativeDefaultSession({ agent: "codex", baseUrl: origin, home: join(dir, "other") }), /private_directory_required/);
});

test("launcher starts the selected installed host without rewriting configuration or shell interpolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "turnsu-launch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"); await mkdir(bin);
  const captured = join(dir, "captured.json");
  const config = join(dir, "existing-config"); await writeFile(config, "preserve me");
  await writeFile(join(bin, "codex"), `#!${process.execPath}\nimport('node:fs').then(({writeFileSync})=>{if(process.argv[2]==='--version') {console.log('test-host');return;} writeFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})); process.exitCode=7;});`, { mode: 0o700 });
  const sessionPath = join(dir, "profile with spaces.json");
  await writeNativeProfile(sessionPath, { baseUrl: origin, tokens: { accessToken: "a".repeat(43), refreshToken: "b".repeat(43), accessTokenExpiresAt: new Date(Date.now()+60_000).toISOString(), refreshTokenExpiresAt: new Date(Date.now()+120_000).toISOString(), clientSessionId: "native-start-test", workspaceId: "workspace-test" } }, { create: true });
  const cli = new URL("../integrations/native/cli.mjs", import.meta.url).pathname;
  await assert.rejects(execute(process.execPath, [cli, "start", "--agent", "codex", "--url", origin, "--session", sessionPath], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE: captured } }), (error) => error.code === 7);
  const recorded = JSON.parse(await readFile(captured, "utf8"));
  assert.equal(recorded.cwd, await realpath(dir));
  assert.equal(recorded.args.length, 4);
  assert.ok(recorded.args[3].includes(JSON.stringify(sessionPath)));
  assert.equal(await readFile(config, "utf8"), "preserve me");
  await assert.rejects(stat(`${sessionPath}.lock`), { code: "ENOENT" });
  const launch = nativeAgentLaunch({ agent: "claude", cliPath: cli, sessionPath });
  const server = Object.values(JSON.parse(launch.args[1]).mcpServers)[0];
  assert.deepEqual(server.args, [cli, "mcp", "--session", sessionPath]);
  assert.equal(launch.args.includes("--strict-mcp-config"), false);
  const pi = nativeAgentLaunch({ agent: "pi", cliPath: cli, sessionPath, env: { KEEP: "yes" } });
  assert.equal(pi.env.KEEP, "yes"); assert.equal(pi.env.TURNSU_SESSION_FILE, sessionPath);
});
