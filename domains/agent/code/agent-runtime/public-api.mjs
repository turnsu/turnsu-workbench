import { join } from "node:path";

import { createGateEngine } from "./core/gates/gate-engine.mjs";
import { buildAgentFinalReadModelV1 } from "./core/final-output/final-read-model.mjs";
import { createAgentRuntimeCore } from "./core/run-loop/agent-runtime-core.mjs";
import { createPiBuilderProposalGenerator } from "./core/proposals/pi-builder-proposal-generator.mjs";
import { createWorkflowSkillExecutorRegistry } from "./core/workflow/workflow-skill-executor-registry.mjs";
import {
  registerWorkflowConformanceExecutor,
  WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_SKILL_ID,
} from "./extensions/workflow-conformance/binding.mjs";
import {
  registerMeetingActionExtractorExecutor,
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "./extensions/meeting-action-extractor/binding.mjs";
import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "./kernels/pi/pi-kernel-adapter.mjs";
import { resolveRuntimePaths } from "./lib/runtime-paths.mjs";

const DEFAULT_BUILDER_PROPOSAL_TIMEOUT_MS = 90_000;

/**
 * The only backend-facing entry point for the remaining Pi compatibility
 * adapter. Product code receives opaque AgentRuntimeCore/Kernel/registry
 * ports, never a Pi type, extension path, or loader configuration.
 */
export function createLegacyPiRuntimeComponents({
  env = process.env,
  clock = () => new Date().toISOString(),
  idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
} = {}) {
  const paths = resolveRuntimePaths({ env });
  const workbenchTestMode = String(env.WORKBENCH_TEST_MODE || "") === "1";
  const agentTestMode = String(env.WECHAT_AGENT_TEST_MODE || "") === "1";
  const testBusinessSkill = workbenchTestMode
    && String(env.WORKBENCH_TEST_BUSINESS_SKILL || "") === "1";
  if (workbenchTestMode !== agentTestMode) {
    throw new Error("workbench_and_agent_test_mode_must_match");
  }
  const extensionPackage = workbenchTestMode && !testBusinessSkill
    ? {
      id: "workflow-conformance",
      extensionPath: join(paths.agentRuntimeRoot, "extensions/workflow-conformance/extension.ts"),
      manifest: { testOnly: true },
    }
    : null;
  const extensionPackages = extensionPackage ? [extensionPackage] : [];
  const legacyRuntime = createPiBackedAgentRuntime({
    projectRoot: paths.repoRoot,
    agentRuntimeRoot: paths.agentRuntimeRoot,
    piAgentDir: paths.piAgentDir,
    piExtensionPath: extensionPackage?.extensionPath ?? null,
    piSkillPath: join(paths.agentRuntimeRoot, "skills"),
    piPromptPath: join(paths.agentRuntimeRoot, "prompts"),
    projectToolNames: extensionPackage ? [WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME] : [],
    discoverExtensionPaths: () => extensionPackages.map((item) => item.extensionPath),
    discoverExtensionPackages: () => extensionPackages,
    now: clock,
    safeId: idFactory,
  });
  const runtimeKernel = createPiKernelAdapter(legacyRuntime);
  const executorRegistry = createWorkflowSkillExecutorRegistry();
  if (extensionPackage) {
    registerWorkflowConformanceExecutor(executorRegistry, { env });
  } else {
    registerMeetingActionExtractorExecutor(executorRegistry);
  }
  const agentRuntimeCore = createAgentRuntimeCore({
    router: {},
    gateEngine: createGateEngine({ now: clock }),
    runtimeKernel,
    finalOutput: { buildAgentFinalReadModelV1 },
    artifacts: {},
    providerExecutor: {},
    capabilityCatalog: { capabilities: [] },
    builderProposalGenerator: createPiBuilderProposalGenerator({
      cwd: paths.repoRoot,
      agentDir: paths.piAgentDir,
      timeoutMs: DEFAULT_BUILDER_PROPOSAL_TIMEOUT_MS,
    }),
  });
  return Object.freeze({
    agentRuntimeCore,
    runtimeKernel,
    executorRegistry,
    async dispose() { await legacyRuntime.dispose(); },
  });
}

export {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_SKILL_ID,
};
