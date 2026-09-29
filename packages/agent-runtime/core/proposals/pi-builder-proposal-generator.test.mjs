import assert from "node:assert/strict";
import test from "node:test";

import {
  PiBuilderProposalGeneratorError,
  createPiBuilderProposalGenerator,
} from "./pi-builder-proposal-generator.mjs";
import { inspectPiBuilderProviderReadiness } from "./pi-builder-provider-readiness.mjs";

function workflowRevision() {
  return {
    schemaVersion: "workbench-v1",
    workflowId: "workflow-1",
    revisionId: "revision-1",
    definition: {
      goal: "Create reviewed meeting actions.",
      context: "Use the attached notes.",
      constraints: [],
      doneWhen: ["Every action has an owner."],
      verify: [],
      expectedResult: "Reviewed actions.",
      stopRules: [],
    },
    graph: { nodes: [], edges: [] },
    inputForm: { fields: [] },
    outputDefinition: { primaryOutput: { nodeId: "node-output", portId: "result" } },
    resourceRefs: [],
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 300 },
  };
}

function sessionFactoryWithText(text, capture) {
  return async (options) => {
    capture.options = options;
    const session = {
      messages: [],
      async prompt(prompt) {
        capture.prompt = prompt;
        session.messages.push({ role: "assistant", content: [{ type: "text", text }] });
      },
      dispose() { capture.disposed = true; },
    };
    return { session };
  };
}

test("PI Builder proposal generation uses an isolated no-tool session and returns only JSON", async () => {
  const capture = {};
  const generator = createPiBuilderProposalGenerator({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionFactory: sessionFactoryWithText(JSON.stringify({
      summary: "Require an owner for each action.",
      operations: [{ op: "updateWorkflowSettings", runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 180 } }],
      diagnostics: [],
      permissionImpact: [],
    }), capture),
  });

  const result = await generator.generate({
    instruction: "Require an owner for each action.",
    workflowId: "workflow-1",
    workspaceId: "workspace-1",
    revision: workflowRevision(),
  });

  assert.equal(result.summary, "Require an owner for each action.");
  assert.equal(result.operations[0].op, "updateWorkflowSettings");
  assert.deepEqual(capture.options.tools, []);
  assert.equal(capture.options.noTools, "all");
  assert.equal(capture.options.resourceLoader.getAgentsFiles().agentsFiles.length, 0);
  assert.equal(capture.options.resourceLoader.getSkills().skills.length, 0);
  assert.match(capture.prompt, /workflow-1/);
  assert.match(capture.prompt, /Require an owner/);
  assert.match(capture.prompt, /"op":"updateDefinition"/);
  assert.match(capture.prompt, /goal, context, constraints, doneWhen, verify, expectedResult, and stopRules/);
  assert.match(capture.prompt, /Use empty arrays when there are no diagnostics or connection permission changes/);
  assert.equal(capture.disposed, true);
});

test("PI Builder proposal generation rejects markdown or malformed model output", async () => {
  const capture = {};
  const generator = createPiBuilderProposalGenerator({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    sessionFactory: sessionFactoryWithText("```json\n{}\n```", capture),
  });

  await assert.rejects(
    () => generator.generate({
      instruction: "Update the goal.",
      workflowId: "workflow-1",
      workspaceId: "workspace-1",
      revision: workflowRevision(),
    }),
    (error) => error instanceof PiBuilderProposalGeneratorError && error.code === "builder_proposal_invalid",
  );
  assert.equal(capture.disposed, true);
});

test("PI Builder proposal generation maps model setup failures to a stable unavailable error", async () => {
  const generator = createPiBuilderProposalGenerator({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    async sessionFactory() {
      throw new Error("provider token private-value");
    },
  });

  await assert.rejects(
    () => generator.generate({
      instruction: "Update the goal.",
      workflowId: "workflow-1",
      workspaceId: "workspace-1",
      revision: workflowRevision(),
    }),
    (error) => (
      error instanceof PiBuilderProposalGeneratorError
      && error.code === "builder_proposal_unavailable"
      && !error.message.includes("private-value")
    ),
  );
});

test("PI Builder proposal generation aborts a bounded model session on timeout", async () => {
  const capture = {};
  const generator = createPiBuilderProposalGenerator({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    timeoutMs: 100,
    async sessionFactory() {
      return {
        session: {
          isStreaming: true,
          messages: [],
          prompt() { return new Promise(() => {}); },
          abort() { capture.aborted = true; },
          dispose() { capture.disposed = true; },
        },
      };
    },
  });

  await assert.rejects(
    () => generator.generate({
      instruction: "Update the goal.",
      workflowId: "workflow-1",
      workspaceId: "workspace-1",
      revision: workflowRevision(),
    }),
    (error) => error?.code === "builder_proposal_unavailable",
  );
  assert.equal(capture.aborted, true);
  assert.equal(capture.disposed, true);
});

test("PI Builder provider readiness reports only product-safe aggregate availability", async () => {
  const result = await inspectPiBuilderProviderReadiness({
    agentDir: "/tmp/pi-builder-provider-ready",
    authStorageFactory: () => ({ privateToken: "must-not-escape" }),
    modelRegistryFactory: () => ({
      refresh() {},
      getError() { return null; },
      async getAvailable() {
        return [
          { provider: "private-provider", id: "private-model-a" },
          { provider: "private-provider", id: "private-model-b" },
        ];
      },
    }),
  });

  assert.deepEqual(result, {
    ready: true,
    code: "builder_provider_ready",
    availableModelCount: 2,
  });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("PI Builder provider readiness distinguishes missing and invalid configuration without raw errors", async () => {
  const missing = await inspectPiBuilderProviderReadiness({
    agentDir: "/tmp/pi-builder-provider-missing",
    authStorageFactory: () => ({}),
    modelRegistryFactory: () => ({
      refresh() {},
      getError() { return null; },
      async getAvailable() { return []; },
    }),
  });
  assert.deepEqual(missing, {
    ready: false,
    code: "builder_provider_not_configured",
    availableModelCount: 0,
  });

  const invalid = await inspectPiBuilderProviderReadiness({
    agentDir: "/tmp/pi-builder-provider-invalid",
    authStorageFactory: () => ({}),
    modelRegistryFactory: () => ({
      refresh() {},
      getError() { return new Error("provider-token-private-value"); },
      async getAvailable() { throw new Error("must not run"); },
    }),
  });
  assert.deepEqual(invalid, {
    ready: false,
    code: "builder_provider_configuration_invalid",
    availableModelCount: 0,
  });
  assert.equal(JSON.stringify(invalid).includes("private-value"), false);
});

test("PI Builder provider readiness masks registry failures", async () => {
  const result = await inspectPiBuilderProviderReadiness({
    agentDir: "/tmp/pi-builder-provider-failure",
    authStorageFactory: () => ({}),
    modelRegistryFactory: () => ({
      refresh() {},
      getError() { return null; },
      async getAvailable() { throw new Error("provider-secret-private-value"); },
    }),
  });

  assert.deepEqual(result, {
    ready: false,
    code: "builder_provider_readiness_unavailable",
    availableModelCount: 0,
  });
  assert.equal(JSON.stringify(result).includes("private-value"), false);
});
