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

test("model_call probe verifies only the local Product backend composition", async () => {
  const backend = createModelCallBackend({ modelService: async () => ({}) });
  assert.deepEqual(await backend.probe(), { available: true, verified: true });
});

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

test("image input budgets include expanded governed attachment bytes before provider dispatch", async () => {
  let calls = 0;
  const backend = createModelCallBackend({
    attachmentResolver: async () => [{
      type: "image",
      mediaType: "image/png",
      dataBase64: Buffer.alloc(512, 1).toString("base64"),
      attachment: {
        attachmentId: "attachment-1",
        version: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        mediaType: "image/png",
      },
    }],
    modelService: async () => {
      calls += 1;
      return {};
    },
  });
  const visionRequest = request({
    controller: { kind: "agent_turn", controllerId: "turn-1", fence: 1 },
    input: {
      messages: [{ role: "user", content: "Describe it." }],
      tools: [],
    },
    limits: {
      ...request().limits,
      maxInputBytes: 256,
      maxImageCount: 1,
    },
    modelCapability: "image_input",
    metadata: {
      requestedBy: "user-a",
      attachmentRefs: [{
        attachmentId: "attachment-1",
        version: 1,
        contentHash: `sha256:${"a".repeat(64)}`,
        mediaType: "image/png",
      }],
    },
  });
  await assert.rejects(
    () => backend.execute({ request: visionRequest, lease }),
    (error) => error?.code === "execution_input_too_large" && error?.status === "blocked",
  );
  assert.equal(calls, 0);
});

test("governed document attachments are appended as text without requiring image_input", async () => {
  const calls = [];
  const backend = createModelCallBackend({
    attachmentResolver: async () => [{
      type: "text",
      text: "[Attachment: notes.md; text/markdown]\n# Governed notes",
      attachment: {
        attachmentId: "attachment-document-1",
        version: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        mediaType: "text/markdown",
      },
    }],
    modelService: async (input) => {
      calls.push(structuredClone(input));
      return {
        content: [{ type: "text", text: "The notes are available." }],
        toolCalls: [],
        usage: {},
        requestedModelRevisionId: "model-revision-chat-1",
        actualModelRevisionId: "model-revision-chat-1",
      };
    },
  });
  const documentRequest = request({
    controller: { kind: "agent_turn", controllerId: "turn-document-1", fence: 1 },
    input: {
      messages: [{ role: "user", content: "Summarize the file." }],
      tools: [],
    },
    modelProfileRevisionId: "model-revision-chat-1",
    modelCapability: "tool_calling",
    metadata: {
      requestedBy: "user-a",
      attachmentRefs: [{
        attachmentId: "attachment-document-1",
        version: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        mediaType: "text/markdown",
      }],
    },
  });
  const result = await backend.execute({ request: documentRequest, lease });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].capability, "tool_calling");
  assert.deepEqual(calls[0].typedInput.messages[0].content, [
    { type: "text", text: "Summarize the file." },
    {
      type: "text",
      text: "[Attachment: notes.md; text/markdown]\n# Governed notes",
      attachment: {
        attachmentId: "attachment-document-1",
        version: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        mediaType: "text/markdown",
      },
    },
  ]);
  assert.equal(result.usage.imageCount, 0);
});
