import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Explicit opt-in acceptance only. Uses installed clients and their existing
// model authentication; never modifies their global configuration or copies it.
export async function runNativeModelParticipant({ kind, sessionPath, directory, workItemId }) {
  const connector = join(runtime, "integrations/native/cli.mjs");
  const marker = `native-${kind}-acceptance`;
  const prompt = `This is an authorized local Turnsu acceptance test with synthetic data only.
Use only the Turnsu tools to read work item ${workItemId}, its audience and its shared execution results.
Then submit one comment to that work item, starting with ${marker}, quoting the exact final result of the completed shared run and saying it still awaits human acceptance.
Use idempotencyKey ${marker}. This comment is explicitly authorized for the work item's existing audience.
Do not accept or complete the work, execute a Loop, open files, run shell commands, or call any other services.
Do not invent a result if a tool fails. Report the actual error instead. After the comment receipt, stop.`;
  const server = { command: process.execPath, args: [connector, "mcp", "--session", sessionPath] };
  let command, args;
  if (kind === "codex") {
    command = "codex";
    args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json",
      "-c", `mcp_servers.turnsu.command=${JSON.stringify(server.command)}`,
      "-c", `mcp_servers.turnsu.args=${JSON.stringify(server.args)}`, prompt];
  } else if (kind === "claude") {
    command = "claude";
    args = ["--print", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers: { turnsu: server } }), "--tools", "",
      "--allowedTools", "mcp__turnsu__turnsu_work_context,mcp__turnsu__turnsu_work_results,mcp__turnsu__turnsu_submit_update", "--", prompt];
  } else if (kind === "pi") {
    command = process.execPath;
    args = [join(runtime, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "--print", "--mode", "json", "--no-session",
      "--no-extensions", "--extension", join(runtime, "integrations/native/pi-entry.mjs"),
      "--tools", "turnsu_work_context,turnsu_work_results,turnsu_submit_update", prompt];
  } else throw new Error("unsupported_native_acceptance_client");
  return runNativeCommand({ kind, command, args, directory, sessionPath, marker });
}

export async function runNativeInstalledSkill({ directory, skillName }) {
  const outputPath = join(directory, "native-skill-result.md");
  const prompt = `Use $${skillName}, installed in this project. Read its SKILL.md and the small reference it names before answering.
This is an authorized acceptance test with synthetic data. Summarize only these two feedback statements:
甲：我用 Codex，希望复用同事的技能。
乙：我用 Claude Code，希望直接查看团队结果。
Follow the installed skill's format. Do not invent counts, priority or budgets. Do not access any other project, personal file, service or credential. Do not change files or run anything except reading the installed skill and its named reference. Produce the summary, then stop.`;
  const receipt = await runNativeCommand({ kind: "codex-skill", command: "codex", directory,
    args: ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--output-last-message", outputPath, prompt],
    marker: "native-installed-skill" });
  return { ...receipt, outputPath };
}

async function runNativeCommand({ kind, command, args, directory, sessionPath, marker }) {
  const outcome = await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: directory, detached: true,
      env: { ...process.env, ...(sessionPath ? { TURNSU_SESSION_FILE: sessionPath } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    let forced;
    const stop = () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      if (!forced) forced = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 180_000);
    child.stdout.on("data", (bytes) => { stdout += bytes; if (stdout.length > 8_000_000) stop(); });
    child.stderr.on("data", (bytes) => { stderr += bytes; if (stderr.length > 8_000_000) stop(); });
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(forced); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); stop(); clearTimeout(forced); done({ code, signal, timedOut, stdout, stderr }); });
  });
  const tracePath = join(directory, `${kind}-trace.json`);
  await writeFile(tracePath, JSON.stringify(outcome, null, 2), { mode: 0o600 });
  return { marker, tracePath, code: outcome.code, timedOut: outcome.timedOut };
}
