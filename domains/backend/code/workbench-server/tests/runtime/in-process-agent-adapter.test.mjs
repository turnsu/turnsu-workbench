import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createWorkflowSkillExecutorRegistry,
} from "../../../../../agent/code/agent-runtime/core/workflow/workflow-skill-executor-registry.mjs";
import { buildAgentFinalReadModelV1 } from "../../../../../agent/code/agent-runtime/core/final-output/final-read-model.mjs";
import { createGateEngine } from "../../../../../agent/code/agent-runtime/core/gates/gate-engine.mjs";
import { createAgentRuntimeCore } from "../../../../../agent/code/agent-runtime/core/run-loop/agent-runtime-core.mjs";
import {
  registerWorkflowConformanceExecutor,
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
  WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
  WORKFLOW_CONFORMANCE_SKILL_ID,
} from "../../../../../agent/code/agent-runtime/extensions/workflow-conformance/binding.mjs";
import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "../../../../../agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs";
import {
  assertIsolatedTestRuntime,
  resolveRuntimePaths,
} from "../../../../../agent/code/agent-runtime/lib/runtime-paths.mjs";
import {
  AgentRuntimePort,
  AgentRuntimePortError,
  assertAgentRuntimePort,
  createInProcessAgentAdapter,
} from "../../src/runtime/index.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(testDir, "../..");
const repoRoot = resolve(testDir, "../../../../../..");
const agentRuntimeRoot = join(repoRoot, "domains", "agent", "code", "agent-runtime");

test("in-process workflow bridge uses real PI discovery and Core authority", async (t) => {
  const isolatedRuntimeRoot = mkdtempSync(join(tmpdir(), "looloomi-workflow-bridge-"));
  const previousTestMode = process.env.WECHAT_AGENT_TEST_MODE;
  const previousRuntimeRoot = process.env.WECHAT_AGENT_RUNTIME_ROOT;
  const previousPiOffline = process.env.PI_OFFLINE;
  process.env.WECHAT_AGENT_TEST_MODE = "1";
  process.env.WECHAT_AGENT_RUNTIME_ROOT = isolatedRuntimeRoot;
  process.env.PI_OFFLINE = "1";

  let piRuntime;
  t.after(() => {
    piRuntime?.session?.dispose?.();
    restoreEnvironment("WECHAT_AGENT_TEST_MODE", previousTestMode);
    restoreEnvironment("WECHAT_AGENT_RUNTIME_ROOT", previousRuntimeRoot);
    restoreEnvironment("PI_OFFLINE", previousPiOffline);
    rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
  });

  const runtimePaths = resolveRuntimePaths({ env: process.env });
  assertIsolatedTestRuntime({
    paths: runtimePaths,
    databaseName: "looloomi_workbench_test",
  });
  assert.equal(runtimePaths.repoRoot, repoRoot);
  assert.equal(runtimePaths.runtimeRoot, isolatedRuntimeRoot);

  const discoveredPackages = discoverTestExtensionPackages(
    join(agentRuntimeRoot, "extensions"),
  );
  assert.deepEqual(discoveredPackages.map((item) => item.id), ["workflow-conformance"]);

  piRuntime = createPiBackedAgentRuntime({
    projectRoot: repoRoot,
    agentRuntimeRoot,
    piAgentDir: runtimePaths.piAgentDir,
    piExtensionPath: discoveredPackages[0].extensionPath,
    piSkillPath: join(agentRuntimeRoot, "skills"),
    piPromptPath: join(agentRuntimeRoot, "prompts"),
    projectToolNames: [WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME],
    discoverExtensionPaths: () => discoveredPackages.map((item) => item.extensionPath),
    discoverExtensionPackages: () => discoveredPackages,
    now: () => "2026-07-10T00:00:00.000Z",
    safeId: () => "pi-workflow-conformance",
  });
  const piKernel = createPiKernelAdapter(piRuntime);

  let authoritativeFinal = null;
  const core = createAgentRuntimeCore({
    router: {},
    gateEngine: createGateEngine({ now: () => "2026-07-10T00:00:00.000Z" }),
    piKernel,
    finalOutput: {
      buildAgentFinalReadModelV1(args) {
        authoritativeFinal = buildAgentFinalReadModelV1(args);
        return authoritativeFinal;
      },
    },
    artifacts: {},
    providerExecutor: {},
  });
  assert.throws(
    () => registerWorkflowConformanceExecutor(createWorkflowSkillExecutorRegistry(), { env: {} }),
    /workflow_conformance_test_mode_required/,
  );
  const executorRegistry = registerWorkflowConformanceExecutor(
    createWorkflowSkillExecutorRegistry(),
  );
  const adapter = createInProcessAgentAdapter({
    agentRuntimeCore: core,
    piKernel,
    executorRegistry,
    defaultTimeoutMs: 5000,
    maxTimeoutMs: 5000,
    now: () => "2026-07-10T00:00:00.000Z",
  });
  assert.equal(assertAgentRuntimePort(adapter), adapter);
  assert.ok(adapter instanceof AgentRuntimePort);

  const probe = await adapter.probeSkill(WORKFLOW_CONFORMANCE_EXECUTION_REF);
  assert.deepEqual(probe, {
    status: "ready",
    ready: true,
    code: "skill_loaded_and_bound",
  });
  assert.equal(piRuntime.resourceLoader?.constructor?.name, "DefaultResourceLoader");
  const kernelStatus = piKernel.status();
  assert.ok(kernelStatus.loadedSkills.includes(WORKFLOW_CONFORMANCE_SKILL_ID));
  assert.equal(
    piRuntime.skillsResult.skills.find((skill) => skill.name === WORKFLOW_CONFORMANCE_SKILL_ID)?.disableModelInvocation,
    true,
  );
  assert.ok(kernelStatus.registeredTools.includes(WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME));
  assert.equal(kernelStatus.loadedExtensionCount, 1);
  assert.deepEqual(kernelStatus.extensionErrors, []);

  const messageCountBefore = piRuntime.session.messages.length;
  const echoOutput = await adapter.invokeSkillNode({
    invocationId: "invocation-echo",
    executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF,
    input: { text: "bridge proof" },
  });
  assert.deepEqual(echoOutput, {
    echo: "bridge proof",
    charCount: 12,
  });
  assert.deepEqual(Object.keys(echoOutput).sort(), ["charCount", "echo"]);
  assert.equal(piRuntime.session.messages.length, messageCountBefore, "tool execution must not invoke a model prompt");

  await assert.rejects(
    () => adapter.invokeSkillNode({
      invocationId: "invocation-invalid-input",
      executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF,
      input: { text: "bridge proof", provider: "must-not-pass-schema" },
    }),
    errorWithCode("skill_input_invalid"),
  );

  const unknownExecutionRef = {
    ...WORKFLOW_CONFORMANCE_EXECUTION_REF,
    taskIntent: "unknown",
  };
  const unknownProbe = await adapter.probeSkill(unknownExecutionRef);
  assert.deepEqual(unknownProbe, {
    status: "blocked",
    ready: false,
    code: "skill_execution_ref_unknown",
  });
  await assert.rejects(
    () => adapter.invokeSkillNode({
      invocationId: "invocation-unknown-ref",
      executionRef: unknownExecutionRef,
      input: { text: "not routed" },
    }),
    errorWithCode("skill_execution_ref_unknown"),
  );
  await assert.rejects(
    () => adapter.probeSkill({
      ...WORKFLOW_CONFORMANCE_EXECUTION_REF,
      prompt: "must not influence routing",
    }),
    errorWithCode("skill_execution_ref_invalid"),
  );

  const finalResult = await adapter.buildAuthoritativeFinal({
    runId: "run-workflow-conformance",
    finalText: "Authoritative: bridge proof",
    evidenceGaps: [{
      code: "source_not_required",
      summary: "The deterministic echo requires no external evidence.",
      nodeId: "node-echo",
      provider: "must-not-be-returned",
      artifactPath: "runtime/agent/private.json",
    }],
    reviewPacket: {
      nodeId: "node-review",
      title: "Review echo",
      summary: "Confirm the deterministic output.",
      items: ["bridge proof"],
      canRequestChanges: true,
      toolName: WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
    },
    artifactPath: "runtime/agent/private-final.json",
  });
  assert.equal(authoritativeFinal?.schemaVersion, "agent-final-read-model-v1");
  assert.equal(authoritativeFinal?.artifactPath, null);
  assert.equal(finalResult.finalText, authoritativeFinal?.finalText);
  assert.deepEqual(Object.keys(finalResult).sort(), ["agentFinalReadModel", "evidenceGaps", "finalText", "reviewPacket"]);
  assert.deepEqual(finalResult.agentFinalReadModel, authoritativeFinal);
  assert.deepEqual(finalResult.evidenceGaps, [{
    code: "source_not_required",
    summary: "The deterministic echo requires no external evidence.",
    nodeId: "node-echo",
  }]);
  assert.deepEqual(finalResult.reviewPacket, {
    nodeId: "node-review",
    title: "Review echo",
    summary: "Confirm the deterministic output.",
    items: ["bridge proof"],
    canRequestChanges: true,
  });

  const preCancelled = new AbortController();
  preCancelled.abort();
  await assert.rejects(
    () => adapter.invokeSkillNode({
      invocationId: "invocation-pre-cancelled",
      executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF,
      input: { text: "cancelled" },
      signal: preCancelled.signal,
    }),
    errorWithCode("invocation_cancelled"),
  );
  await assert.rejects(
    () => adapter.cancelInvocation("invocation-missing"),
    errorWithCode("invocation_unknown"),
  );

  const activeCancellation = adapter.invokeSkillNode({
    invocationId: "invocation-active-cancel",
    executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF,
    input: { text: "cancelled while executing", delayMs: 100 },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    await adapter.cancelInvocation("invocation-active-cancel"),
    { cancelled: true },
  );
  await assert.rejects(activeCancellation, errorWithCode("invocation_cancelled"));
  await new Promise((resolve) => setTimeout(resolve, 110));

  const { agentFinalReadModel: internalAgentFinal, ...productFinalProjection } = finalResult;
  assert.equal(internalAgentFinal.schemaVersion, "agent-final-read-model-v1");
  for (const payload of [probe, echoOutput, unknownProbe, productFinalProjection]) {
    assertProductSafe(payload, { agentRuntimeRoot, isolatedRuntimeRoot });
  }

  const adapterSource = readFileSync(
    join(serverRoot, "src", "runtime", "in-process-agent-adapter.mjs"),
    "utf8",
  );
  assert.doesNotMatch(adapterSource, /\bfetch\s*\(|https?:|wechat-agent-daemon/);
  const registrySource = readFileSync(
    join(agentRuntimeRoot, "core", "workflow", "workflow-skill-executor-registry.mjs"),
    "utf8",
  );
  assert.doesNotMatch(registrySource, /\bprompt\b/i);
});

test("in-process workflow bridge delegates proposal generation and maps model failures safely", async () => {
  const calls = [];
  const dependencies = {
    agentRuntimeCore: {
      skillReadiness() {},
      executeKernelTool() {},
      buildFinalReadModel() {},
      async generateBuilderProposal(input) {
        calls.push(structuredClone(input));
        return { summary: "Update the goal.", operations: [], diagnostics: [], permissionImpact: [] };
      },
    },
    piKernel: { ensure() {}, status() { return { registeredTools: [] }; } },
    executorRegistry: {
      resolve() {}, acceptsInput() {}, readKernelOutput() {},
    },
  };
  const adapter = createInProcessAgentAdapter({
    ...dependencies,
  });
  const request = {
    instruction: "Update the goal.",
    workflowId: "workflow-1",
    workspaceId: "workspace-1",
    revision: { revisionId: "revision-1" },
  };
  assert.deepEqual(await adapter.generateBuilderProposal(request), {
    summary: "Update the goal.", operations: [], diagnostics: [], permissionImpact: [],
  });
  assert.deepEqual(calls, [request]);

  for (const code of ["builder_proposal_invalid", "private_provider_failure"]) {
    const failing = createInProcessAgentAdapter({
      ...dependencies,
      agentRuntimeCore: {
        ...dependencies.agentRuntimeCore,
        async generateBuilderProposal() {
          const error = new Error("provider token private-value");
          error.code = code;
          throw error;
        },
      },
    });
    await assert.rejects(
      () => failing.generateBuilderProposal(request),
      errorWithCode(code === "builder_proposal_invalid" ? code : "builder_proposal_unavailable"),
    );
  }
});

test("uploaded Skill bridge remains workspace-scoped and executes through the generic PI tool", async () => {
  const executionRef = {
    capabilityId: `uploaded-${"a".repeat(48)}`,
    taskIntent: "execute",
    adapterVersion: "1",
    executionMode: "deterministic",
  };
  const calls = [];
  const adapter = createInProcessAgentAdapter({
    agentRuntimeCore: {
      skillReadiness() {},
      async executeKernelTool(toolName, params, options) {
        calls.push({ toolName, params: structuredClone(params), signal: options.signal });
        return { details: { status: "completed", workflowOutput: { summary: params.input.transcript } } };
      },
      buildFinalReadModel() {},
      generateBuilderProposal() {},
    },
    piKernel: {
      async ensure() {},
      status() { return { registeredTools: ["workflow.uploaded_skill.execute"] }; },
    },
    executorRegistry: {
      resolve() {}, acceptsInput() {}, readKernelOutput() {},
    },
    uploadedSkillRuntime: {
      async probeExecution({ workspaceId, executionRef: probedRef }) {
        return workspaceId === "workspace-a" && probedRef.capabilityId === executionRef.capabilityId
          ? { status: "ready", ready: true, code: "uploaded_skill_ready" }
          : { status: "blocked", ready: false, code: "uploaded_skill_unavailable" };
      },
    },
  });

  assert.deepEqual(
    await adapter.probeSkill(executionRef, { workspaceId: "workspace-a" }),
    { status: "ready", ready: true, code: "uploaded_skill_ready" },
  );
  assert.equal((await adapter.probeSkill(executionRef, { workspaceId: "workspace-b" })).ready, false);
  assert.deepEqual(
    await adapter.invokeSkillNode({
      invocationId: "uploaded-invocation",
      workspaceId: "workspace-a",
      executionRef,
      input: { transcript: "Reviewed notes" },
    }),
    { summary: "Reviewed notes" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "workflow.uploaded_skill.execute");
  assert.equal(calls[0].params.workspaceId, "workspace-a");
  assert.ok(calls[0].signal instanceof AbortSignal);
});

function discoverTestExtensionPackages(extensionsRoot) {
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageRoot = join(extensionsRoot, entry.name);
      const manifestPath = join(packageRoot, "manifest.json");
      const extensionPath = join(packageRoot, "extension.ts");
      if (!existsSync(manifestPath) || !existsSync(extensionPath)) return null;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.testOnly !== true) return null;
      return {
        id: manifest.id,
        packageRoot,
        extensionPath,
        manifest,
      };
    })
    .filter(Boolean);
}

function errorWithCode(code) {
  return (error) => {
    assert.ok(error instanceof AgentRuntimePortError);
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error.message), /workflow\.conformance\.echo|artifact|provider|\/Users\//i);
    return true;
  };
}

function assertProductSafe(value, { agentRuntimeRoot, isolatedRuntimeRoot }) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "toolName",
    "skillID",
    "skillId",
    "provider",
    "artifactPath",
    "internalBinding",
    WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
    agentRuntimeRoot,
    isolatedRuntimeRoot,
  ]) {
    assert.ok(!serialized.includes(forbidden), `product payload exposed ${forbidden}`);
  }
}

function restoreEnvironment(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
