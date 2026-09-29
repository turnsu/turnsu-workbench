import assert from "node:assert/strict";
import test from "node:test";

import {
  createPromptToolSkillBackend,
  PromptToolSkillBackendError,
} from "../../src/execution/prompt-tool-skill-backend.mjs";

const request = {
  schemaVersion: "workbench-execution-fabric-v1",
  invocationId: "invocation-prompt",
  attemptId: "attempt-prompt",
  workspaceId: "workspace-1",
  controller: { kind: "workflow_run", controllerId: "run-1", fence: 1 },
  mode: "bounded_agent",
  isolation: "process",
  goal: "Read today's agenda.",
  input: { date: "today" },
  limits: {
    timeoutMs: 30_000,
    maxSteps: 32,
    maxModelRequests: 16,
    maxChildren: 0,
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    maxImageCount: 0,
    maxCostUsdMicros: 1_000_000,
  },
  capabilities: {
    toolAllowlist: ["lark.calendar.agenda"],
    connectionIds: ["connection-calendar"],
    network: false,
    filesystem: "none",
    externalActions: false,
  },
  resultSchema: {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  },
  evidenceRequirements: [],
  metadata: {
    executionRef: {
      capabilityId: "prompt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      taskIntent: "execute",
      adapterVersion: "1",
      executionMode: "agent",
    },
    modelProfileRevisionId: "model-revision-1",
    modelCapability: "structured_output",
    requestedBy: "user-1",
  },
};

const lease = {
  invocationId: request.invocationId,
  attemptId: request.attemptId,
  capabilityLeaseId: "lease-1",
};

const packageLoader = {
  async loadExecutionPackage() {
    return {
      files: [{
        path: "SKILL.md",
        content: Buffer.from("---\nname: lark-calendar\ndescription: Calendar\n---\nUse the calendar tool."),
      }],
      inspection: {
        manifest: {
          name: "lark-calendar",
          tools: [{ action: "lark.calendar.agenda", effect: "read", confirmationRequired: false }],
        },
      },
    };
  },
};

test("Prompt Tool backend follows one pinned model/tool loop and returns schema output", async () => {
  const messages = [];
  let modelCalls = 0;
  const gateway = {
    async handle(message) {
      messages.push(structuredClone({ ...message, signal: undefined }));
      if (message.operation === "model") {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [{ type: "toolCall", id: "call-1", name: "lark.calendar.agenda", arguments: { start: "today" } }],
            toolCalls: [{ id: "call-1", name: "lark.calendar.agenda", arguments: { start: "today" } }],
            requestedModelRevisionId: "model-revision-1",
            actualModelRevisionId: "model-revision-1",
          };
        }
        return {
          content: [{ type: "text", text: "Two meetings" }],
          toolCalls: [],
          structuredOutput: { result: "Two meetings" },
          requestedModelRevisionId: "model-revision-1",
          actualModelRevisionId: "model-revision-1",
        };
      }
      return {
        status: "succeeded",
        action: message.toolId,
        output: [{ title: "Standup" }],
        receipt: { receiptId: "lark-read:1" },
      };
    },
    release() {},
  };
  const backend = createPromptToolSkillBackend({ packageLoader, toolGateway: gateway });
  const result = await backend.execute({
    request,
    lease,
    checkpoint: async () => {},
    emit: async () => {},
  });

  assert.deepEqual(result.output, { result: "Two meetings" });
  assert.equal(result.usage.modelRequests, 2);
  assert.equal(result.usage.steps, 3);
  assert.deepEqual(messages.map(({ operation }) => operation), ["model", "tool", "model"]);
  assert.deepEqual(messages[0].input.context.tools[0].parameters.required, []);
  assert.equal(messages[1].toolId, "lark.calendar.agenda");
  assert.equal(messages[1].connectionId, "connection-calendar");
  assert.deepEqual(messages[0].input.responseSchema, request.resultSchema);
});

test("tool-capable routes return parsed JSON without requesting unsupported native schema output", async () => {
  let modelInput;
  let responseText = JSON.stringify({ result: "Three grounded suggestions." });
  const backend = createPromptToolSkillBackend({
    packageLoader,
    toolGateway: {
      async handle(message) {
        modelInput = message.input;
        return { content: [{ type: "text", text: responseText }], toolCalls: [], stopReason: "stop" };
      },
      release() {},
    },
  });
  const toolRequest = structuredClone(request);
  toolRequest.metadata.modelCapability = "tool_calling";
  const result = await backend.execute({ request: toolRequest, lease });
  assert.equal(Object.hasOwn(modelInput, "responseSchema"), false);
  assert.deepEqual(JSON.parse(modelInput.context.messages[0].content).outputContract, request.resultSchema);
  assert.deepEqual(result.output, { result: "Three grounded suggestions." });
  responseText = "Not the requested JSON output";
  await assert.rejects(backend.execute({ request: toolRequest, lease }), { code: "prompt_skill_output_invalid" });
});

test("Prompt Tool backend injects only bounded derived material text into the Product model request", async () => {
  const materialRequest = structuredClone(request);
  materialRequest.metadata.materialBindings = [{
    materialKey: "agenda",
    source: {
      kind: "attachment",
      attachment: {
        attachmentId: "attachment-1",
        version: 1,
        contentHash: `sha256:${"b".repeat(64)}`,
        mediaType: "application/pdf",
      },
    },
  }];
  let modelMessage = null;
  const gateway = {
    async handle(message) {
      modelMessage = message;
      return {
        content: [{ type: "text", text: "Done" }],
        toolCalls: [],
        structuredOutput: { result: "Done" },
        requestedModelRevisionId: "model-revision-1",
        actualModelRevisionId: "model-revision-1",
      };
    },
    release() {},
  };
  const backend = createPromptToolSkillBackend({
    packageLoader,
    toolGateway: gateway,
    materialResolver: async () => [{
      materialKey: "agenda",
      mediaType: "application/pdf",
      contentHash: `sha256:${"b".repeat(64)}`,
      bytes: Buffer.from("%PDF-private-binary"),
      contextText: "Meeting at 10:00.",
    }],
  });
  const result = await backend.execute({
    request: materialRequest,
    lease,
    checkpoint: async () => {},
    emit: async () => {},
  });

  const userPayload = JSON.parse(modelMessage.input.context.messages[0].content);
  assert.equal(userPayload.materials[0].content, "Meeting at 10:00.");
  assert.equal(userPayload.materials[0].contentHash, `sha256:${"b".repeat(64)}`);
  assert.doesNotMatch(JSON.stringify(modelMessage), /PDF-private-binary/);
  assert.ok(result.usage.inputBytes >= Buffer.byteLength(modelMessage.input.context.messages[0].content));
});

test("Prompt Tool backend blocks governed materials that exceed the request input budget", async () => {
  const materialRequest = structuredClone(request);
  materialRequest.limits.maxInputBytes = 128;
  materialRequest.metadata.materialBindings = [{
    materialKey: "agenda",
    source: {
      kind: "workspace_resource",
      resource: {
        resourceId: "resource-1",
        version: 1,
        label: "Agenda",
        contentHash: `sha256:${"c".repeat(64)}`,
      },
    },
  }];
  let gatewayCalls = 0;
  const backend = createPromptToolSkillBackend({
    packageLoader,
    toolGateway: {
      async handle() { gatewayCalls += 1; },
      release() {},
    },
    materialResolver: async () => [{
      materialKey: "agenda",
      mediaType: "text/markdown",
      contentHash: `sha256:${"c".repeat(64)}`,
      bytes: Buffer.from("x".repeat(500)),
      contextText: "x".repeat(500),
    }],
  });
  await assert.rejects(
    backend.execute({ request: materialRequest, lease }),
    (error) => error instanceof PromptToolSkillBackendError
      && error.code === "execution_input_too_large"
      && error.status === "blocked",
  );
  assert.equal(gatewayCalls, 0);
});

test("Prompt Tool backend never executes an unconfirmed write", async () => {
  const writeRequest = structuredClone(request);
  writeRequest.capabilities.toolAllowlist = ["lark.calendar.create"];
  writeRequest.capabilities.externalActions = true;
  const writeLoader = {
    async loadExecutionPackage() { return {
    files: [{
      path: "SKILL.md",
      content: Buffer.from("---\nname: lark-calendar\ndescription: Calendar\n---\nCreate the requested event."),
    }],
    inspection: {
      manifest: {
        name: "lark-calendar",
        tools: [{ action: "lark.calendar.create", effect: "write", confirmationRequired: true }],
      },
    },
  }; },
  };
  const gateway = {
    async handle(message) {
      if (message.operation === "model") {
        return {
          content: [{
            type: "toolCall",
            id: "call-write",
            name: "lark.calendar.create",
            arguments: { summary: "Standup", start: "2026-07-25T09:00:00Z", end: "2026-07-25T09:30:00Z" },
          }],
          toolCalls: [{
            id: "call-write",
            name: "lark.calendar.create",
            arguments: { summary: "Standup", start: "2026-07-25T09:00:00Z", end: "2026-07-25T09:30:00Z" },
          }],
          requestedModelRevisionId: "model-revision-1",
          actualModelRevisionId: "model-revision-1",
        };
      }
      return {
        status: "confirmation_required",
        confirmation: { action: message.toolId, summary: "Confirm" },
      };
    },
    release() {},
  };
  const backend = createPromptToolSkillBackend({ packageLoader: writeLoader, toolGateway: gateway });
  await assert.rejects(
    backend.execute({ request: writeRequest, lease }),
    (error) => error instanceof PromptToolSkillBackendError
      && error.code === "lark_tool_confirmation_required"
      && error.status === "blocked",
  );
});

test("Prompt Tool receipt recovery never loads the Skill, calls a model, or executes a fresh write", async () => {
  const recoveryRequest = structuredClone(request);
  const recovery = {
    schemaVersion: "workbench-effect-recovery-v1",
    effectId: "effect-original-write-1",
    action: "lark.calendar.create",
    connectionId: "connection-calendar",
    requirementId: "lark.calendar",
    approvalFingerprint: `sha256:${"a".repeat(64)}`,
    credentialBindingFingerprint: `sha256:${"b".repeat(64)}`,
    driverBackend: "production",
    sourceInvocationId: "invocation-original",
    sourceAttemptId: "attempt-original",
  };
  recoveryRequest.capabilities.toolAllowlist = [recovery.action];
  recoveryRequest.capabilities.externalActions = true;
  recoveryRequest.metadata.effectRecovery = recovery;
  let packageLoads = 0;
  let modelOrFreshWriteCalls = 0;
  let recoveryCalls = 0;
  const backend = createPromptToolSkillBackend({
    packageLoader: {
      async loadExecutionPackage() {
        packageLoads += 1;
        throw new Error("the ordinary Skill path must not run");
      },
    },
    toolGateway: {
      async handle() {
        modelOrFreshWriteCalls += 1;
        throw new Error("a model could change the action or arguments");
      },
      async recoverEffect(message) {
        recoveryCalls += 1;
        assert.deepEqual(message.effectRecovery, recovery);
        return {
          status: "succeeded",
          ...recovery,
          output: { result: "Recovered original provider result" },
          receipt: { receiptId: `lark-effect:${recovery.effectId}` },
        };
      },
      release() {},
    },
  });

  const result = await backend.execute({ request: recoveryRequest, lease });
  assert.deepEqual(result.output, { result: "Recovered original provider result" });
  assert.equal(result.usage.modelRequests, 0);
  assert.equal(result.usage.steps, 1);
  assert.equal(packageLoads, 0);
  assert.equal(modelOrFreshWriteCalls, 0);
  assert.equal(recoveryCalls, 1);
  assert.ok(result.evidence.some((item) => item.ref === recovery.effectId));
});

test("Prompt Tool receipt recovery fails outcome-unknown when the dedicated backend is unsupported", async () => {
  const recoveryRequest = structuredClone(request);
  recoveryRequest.metadata.effectRecovery = {
    schemaVersion: "workbench-effect-recovery-v1",
    effectId: "effect-original-write-2",
    action: "lark.calendar.create",
    connectionId: "connection-calendar",
    requirementId: "lark.calendar",
    approvalFingerprint: `sha256:${"c".repeat(64)}`,
    credentialBindingFingerprint: `sha256:${"d".repeat(64)}`,
    driverBackend: "production",
    sourceInvocationId: "invocation-original",
    sourceAttemptId: "attempt-original",
  };
  let ordinaryCalls = 0;
  const backend = createPromptToolSkillBackend({
    packageLoader,
    toolGateway: {
      async handle() { ordinaryCalls += 1; },
      release() {},
    },
  });

  await assert.rejects(
    backend.execute({ request: recoveryRequest, lease }),
    (error) => error instanceof PromptToolSkillBackendError
      && error.code === "prompt_effect_recovery_unavailable"
      && error.status === "effect_outcome_unknown",
  );
  assert.equal(ordinaryCalls, 0);
});
