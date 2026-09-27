import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentRuntimeCore } from "../core/run-loop/agent-runtime-core.mjs";
import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "../kernels/pi/pi-kernel-adapter.mjs";
import { nodeVersionSatisfiesRuntime } from "../lib/node-version-gate.mjs";
import {
  RUNTIME_ROOT_ENV,
  resolveRuntimePaths,
} from "../lib/runtime-paths.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDir, "..");
const repoRoot = resolve(agentRuntimeRoot, "../../../..");
const isolatedRuntimeRoot = mkdtempSync("/private/tmp/looloomi-pi-integrity-");
const paths = resolveRuntimePaths({
  env: {
    WECHAT_AGENT_TEST_MODE: "1",
    [RUNTIME_ROOT_ENV]: isolatedRuntimeRoot,
  },
});

let piRuntime = null;

try {
  assert.equal(nodeVersionSatisfiesRuntime(process.version), true);
  assert.equal(paths.repoRoot, repoRoot);
  assert.equal(paths.runtimeRoot, isolatedRuntimeRoot);
  assert.ok(paths.agentDataRoot.startsWith(`${isolatedRuntimeRoot}/`));

  piRuntime = createPiBackedAgentRuntime({
    projectRoot: repoRoot,
    agentRuntimeRoot,
    piAgentDir: paths.piAgentDir,
    piExtensionPath: join(agentRuntimeRoot, "extensions", "wechat-onchain-tools.ts"),
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [],
    discoverExtensionPaths: () => [],
    discoverExtensionPackages: () => [],
  });
  const piKernel = createPiKernelAdapter(piRuntime);
  await piKernel.ensure();

  const loadedSkillNames = new Set(piRuntime.skillsResult.skills.map((skill) => skill.name));
  assert.deepEqual(
    ["wechat-onchain-intelligence", "image-analysis", "long-task"]
      .filter((name) => !loadedSkillNames.has(name)),
    [],
  );
  assert.deepEqual(
    piRuntime.skillDiagnostics.filter((item) => (
      item.type === "collision" || /missing description/i.test(item.message || "")
    )),
    [],
  );

  const capturedPromptMessages = [];
  const session = piRuntime.session;
  session.agent.state.model = {
    provider: "runtime-integrity",
    id: "no-network",
    name: "Runtime integrity no-network model",
    api: "openai-completions",
    contextWindow: 8192,
    maxTokens: 1024,
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session._runAgentPrompt = async (messages) => {
    capturedPromptMessages.push(...messages);
  };

  const core = createAgentRuntimeCore({
    router: {},
    gateEngine: {},
    runtimeKernel: piKernel,
    finalOutput: {},
    artifacts: {},
  });
  const proof = await core.invokeSkill("long-task", { goal: "runtime integrity proof" });
  const expandedPrompt = capturedPromptMessages
    .flatMap((message) => message.content || [])
    .map((part) => part?.text || "")
    .join("\n");

  assert.match(expandedPrompt, /^<skill name="long-task" location=/);
  assert.match(expandedPrompt, /runtime integrity proof/);
  assert.equal(proof.status, "completed");
  assert.ok(!JSON.stringify(proof).includes(agentRuntimeRoot));
  console.log(`pi_runtime_integrity=pass node=${process.version} isolated_runtime=true loaded_skills=${loadedSkillNames.size} live_model=false`);
} finally {
  piRuntime?.session?.dispose?.();
  rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
}
