import assert from "node:assert/strict";
import test from "node:test";

import { createModelCallBackend } from "../../src/execution/index.mjs";

function request(overrides = {}) {
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-model-1",
    attemptId: "attempt-model-1",
    workspaceId: "workspace-a",
    mode: "model_call",
    isolation: "process",
    input: { prompt: "Draw a blue circle.", outputFormat: "png" },
    limits: {
      timeoutMs: 30_000,
      maxSteps: 1,
      maxModelRequests: 1,
      maxChildren: 0,
      maxInputBytes: 100_000,
      maxOutputBytes: 100_000,
      maxImageCount: 1,
      maxCostUsdMicros: 10_000_000,
    },
    capabilities: {
      toolAllowlist: [], connectionIds: [], network: false,
      filesystem: "none", externalActions: false,
    },
    modelProfileRevisionId: "model-revision-image-1",
    modelCapability: "image_generation",
    fallbackModelProfileRevisionIds: [],
    metadata: {},
    ...overrides,
  };
}

const lease = {
  capabilityLeaseId: "lease-model-1",
  invocationId: "invocation-model-1",
  attemptId: "attempt-model-1",
  fence: 4,
};

test("model_call invokes one pinned revision without Pi, tools, or children", async () => {
  const calls = [];
  const events = [];
  const backend = createModelCallBackend({
    modelService: async (input) => {
      calls.push(input);
      return {
        artifactRefs: [{ artifactId: "artifact-image-1", mediaType: "image/png" }],
        format: "png",
        dimensions: { width: 1024, height: 1024 },
        safetyStatus: "safe",
        usage: { images: 1 },
        requestedModelRevisionId: "model-revision-image-1",
        actualModelRevisionId: "model-revision-image-1",
      };
    },
  });
  const result = await backend.execute({
    request: request(),
    lease,
    emit: async (type, payload) => events.push({ type, payload }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].modelProfileRevisionId, "model-revision-image-1");
  assert.equal(calls[0].capabilityLeaseId, "lease-model-1");
  assert.equal(calls[0].fence, 4);
  assert.equal(result.usage.modelRequests, 1);
  assert.equal(result.usage.steps, 1);
  assert.deepEqual(result.evidence, [{
    requirementId: "model-output-artifact", kind: "artifact", ref: "artifact-image-1",
  }]);
  assert.deepEqual(events.map((event) => event.type), ["model.call.started", "model.call.completed"]);
});

test("image model_call rejects fallback and any tool capability before provider invocation", async () => {
  let calls = 0;
  const backend = createModelCallBackend({ modelService: async () => { calls += 1; return {}; } });
  await assert.rejects(() => backend.execute({
    request: request({
      fallbackModelProfileRevisionIds: ["model-revision-image-2"],
    }),
    lease,
  }), /model_image_fallback_forbidden/);
  await assert.rejects(() => backend.execute({
    request: request({
      capabilities: {
        toolAllowlist: ["unsafe"], connectionIds: [], network: false,
        filesystem: "none", externalActions: false,
      },
    }),
    lease,
  }), /model_call_request_invalid/);
  assert.equal(calls, 0);
});
