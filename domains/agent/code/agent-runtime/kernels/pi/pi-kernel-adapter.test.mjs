import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "./pi-kernel-adapter.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDir, "../..");
const projectRoot = resolve(agentRuntimeRoot, "../../../..");
const tempRoot = mkdtempSync(join(tmpdir(), "looloomi-pi-adapter-"));
const prompts = [];
const messages = [];
const toolSignals = [];
const lifecycle = [];
let eventListener;
const diagnostic = {
  type: "warning",
  message: "test diagnostic",
  path: join(tempRoot, "private-skill-path.md"),
};
const skillsResult = {
  skills: [{
    name: "long-task",
    description: "Runs a recoverable task.",
    filePath: join(agentRuntimeRoot, "skills", "long-task.md"),
    baseDir: join(agentRuntimeRoot, "skills"),
  }],
  diagnostics: [diagnostic],
};

const fakeLoader = {
  async reload() {},
  getSkills() {
    return skillsResult;
  },
};
const fakeSession = {
  get messages() {
    return messages;
  },
  getAllTools: () => [],
  getActiveToolNames: () => [],
  subscribe(listener) {
    eventListener = listener;
    lifecycle.push("subscribed");
    return () => lifecycle.push("unsubscribed");
  },
  async compact(instructions) {
    lifecycle.push(`compact:${instructions}`);
    return { summary: "compacted" };
  },
  async abort() {
    lifecycle.push("aborted");
  },
  dispose() {
    lifecycle.push("disposed");
  },
  getToolDefinition(name) {
    if (name !== "test.signal") return null;
    return {
      async execute(_toolCallId, params, signal) {
        toolSignals.push(signal);
        return {
          content: [{ type: "text", text: params.value }],
          details: { status: "completed", workflowOutput: { value: params.value } },
        };
      },
    };
  },
  async prompt(command) {
    prompts.push(command);
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Recoverable task accepted." }],
    });
  },
};

try {
  const actualLoader = new DefaultResourceLoader({
    cwd: tempRoot,
    agentDir: join(tempRoot, "actual-loader-home"),
    additionalSkillPaths: [join(agentRuntimeRoot, "skills")],
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await actualLoader.reload();
  const actualSkills = actualLoader.getSkills();
  assert.deepEqual(
    actualSkills.skills.map((skill) => skill.name).sort(),
    [
      "image-analysis",
      "long-task",
      "meeting-action-extractor",
      "wechat-onchain-intelligence",
      "workflow-conformance",
    ],
  );
  assert.deepEqual(
    actualSkills.diagnostics.filter((item) => (
      item.type === "collision" || /missing description/i.test(item.message || "")
    )),
    [],
  );

  const runtime = createPiBackedAgentRuntime({
    projectRoot,
    agentRuntimeRoot,
    piAgentDir: join(tempRoot, "pi-agent-home"),
    piExtensionPath: join(agentRuntimeRoot, "extensions", "wechat-onchain-tools.ts"),
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    createResourceLoader: () => fakeLoader,
    createSessionManager: () => ({ kind: "in-memory-test" }),
    createSession: async () => ({ session: fakeSession, extensionsResult: { extensions: [], errors: [] } }),
    safeId: () => "pi-skill-test",
    now: () => "2026-07-10T00:00:00.000Z",
  });
  const kernel = createPiKernelAdapter(runtime);

  await kernel.ensure();
  assert.equal(runtime.skillsResult, skillsResult);
  assert.equal(runtime.skillDiagnostics, skillsResult.diagnostics);
  assert.deepEqual(kernel.skillReadiness("long-task"), {
    skillID: "long-task",
    status: "ready",
    ready: true,
    code: "pi_skill_loaded_and_bound",
  });

  const status = kernel.status();
  assert.equal(status.loadedSkillCount, 1);
  assert.deepEqual(status.loadedSkills, ["long-task"]);
  assert.equal(status.skillDiagnostics.length, 1);
  assert.equal("path" in status.skillDiagnostics[0], false);
  assert.ok(!JSON.stringify(status).includes(tempRoot));

  const result = await kernel.invokeSkill("long-task", {
    goal: "produce a resumable plan",
    apiKey: "must-not-be-returned",
  });
  assert.match(prompts[0], /^\/skill:long-task /);
  assert.match(prompts[0], /produce a resumable plan/);
  assert.equal(result.schemaVersion, "pi-skill-invocation-v1");
  assert.equal(result.skillID, "long-task");
  assert.equal(result.status, "completed");
  assert.equal(result.outputSummary, "Recoverable task accepted.");
  assert.ok(!JSON.stringify(result).includes("must-not-be-returned"));
  assert.ok(!JSON.stringify(result).includes(tempRoot));

  await assert.rejects(
    () => kernel.invokeSkill("missing-skill", {}),
    /pi_skill_not_ready:missing-skill/,
  );

  const controller = new AbortController();
  const toolResult = await kernel.executeTool(
    "test.signal",
    { value: "signal proof" },
    { signal: controller.signal },
  );
  assert.equal(toolSignals[0], controller.signal);
  assert.deepEqual(toolResult.details.workflowOutput, { value: "signal proof" });

  const unsubscribe = kernel.subscribe((event) => lifecycle.push(`event:${event.type}`));
  eventListener({ type: "agent_start" });
  unsubscribe();
  assert.deepEqual(await kernel.compact("retain decisions"), { summary: "compacted" });
  await kernel.abort();
  await kernel.dispose();
  assert.deepEqual(lifecycle, [
    "subscribed",
    "event:agent_start",
    "unsubscribed",
    "compact:retain decisions",
    "aborted",
    "disposed",
  ]);

  console.log("pi_kernel_skill_invocation=pass");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
