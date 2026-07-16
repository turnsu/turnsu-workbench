import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createGateEngine } from "../core/gates/gate-engine.mjs";
import { buildAgentFinalReadModelV1 } from "../core/final-output/final-read-model.mjs";
import { createAgentRuntimeCore } from "../core/run-loop/agent-runtime-core.mjs";
import { createWorkflowSkillExecutorRegistry } from "../core/workflow/workflow-skill-executor-registry.mjs";
import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
  registerMeetingActionExtractorExecutor,
} from "../extensions/meeting-action-extractor/binding.mjs";
import { createPiBackedAgentRuntime, createPiKernelAdapter } from "../kernels/pi/pi-kernel-adapter.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDirectory, "..");
const repositoryRoot = resolve(agentRuntimeRoot, "../../../../");

test("meeting action extractor is a non-test Skill loaded and executed through PI, Core, and the explicit registry", async (context) => {
  const piHome = mkdtempSync(join(tmpdir(), "looloomi-business-skill-"));
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  let piRuntime;
  context.after(() => {
    piRuntime?.session?.dispose?.();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(piHome, { recursive: true, force: true });
  });

  const extensionPath = join(agentRuntimeRoot, "extensions", "meeting-action-extractor", "extension.ts");
  piRuntime = createPiBackedAgentRuntime({
    projectRoot: repositoryRoot,
    agentRuntimeRoot,
    piAgentDir: piHome,
    piExtensionPath: extensionPath,
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME],
    discoverExtensionPaths: () => [extensionPath],
    discoverExtensionPackages: () => [{
      id: "meeting-action-extractor",
      extensionPath,
      manifest: { testOnly: false },
    }],
  });
  const piKernel = createPiKernelAdapter(piRuntime);
  const core = createAgentRuntimeCore({
    router: {},
    gateEngine: createGateEngine(),
    piKernel,
    finalOutput: { buildAgentFinalReadModelV1 },
    artifacts: {},
    providerExecutor: {},
  });
  const registry = registerMeetingActionExtractorExecutor(createWorkflowSkillExecutorRegistry());
  const { createInProcessAgentAdapter } = await import("../../../../backend/code/workbench-server/src/runtime/index.mjs");
  const adapter = createInProcessAgentAdapter({ agentRuntimeCore: core, piKernel, executorRegistry: registry });

  assert.deepEqual(await adapter.probeSkill(MEETING_ACTION_EXTRACTOR_EXECUTION_REF), {
    status: "ready",
    ready: true,
    code: "skill_loaded_and_bound",
  });
  assert.ok(piKernel.status().loadedSkills.includes(MEETING_ACTION_EXTRACTOR_SKILL_ID));
  assert.ok(piKernel.status().registeredTools.includes(MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME));

  const output = await adapter.invokeSkillNode({
    invocationId: "business-skill-proof",
    executionRef: MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
    input: {
      transcript: "Mia will send the draft on Friday. The team discussed the roadmap. TODO: Leo should confirm the launch owner.",
    },
  });
  assert.deepEqual(output, {
    actionItems: [
      { text: "Mia will send the draft on Friday." },
      { text: "TODO: Leo should confirm the launch owner." },
    ],
    summary: "2 follow-up actions found.",
  });

  const source = readFileSync(extensionPath, "utf8");
  assert.doesNotMatch(source, /\b(fetch|spawn|exec|readFile|writeFile|process\.env)\b/);
  assert.equal(JSON.stringify(output).includes(MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME), false);
});
