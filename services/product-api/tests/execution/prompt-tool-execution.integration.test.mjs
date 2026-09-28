import assert from "node:assert/strict";
import test from "node:test";

import {
  createPromptToolSkillBackend,
  ExecutionBroker,
  InMemoryExecutionPersistence,
  ProductToolGateway,
} from "../../src/execution/index.mjs";

const NOW = "2026-07-24T12:00:00.000Z";

test("a Prompt Tool Skill traverses Broker, pinned model, Gateway, exact Tool, and structured result", async () => {
  const persistence = new InMemoryExecutionPersistence();
  let modelRound = 0;
  const modelCalls = [];
  const toolCalls = [];
  const gateway = new ProductToolGateway({
    persistence,
    clock: () => NOW,
    modelExecutor: async (request) => {
      modelCalls.push(structuredClone(request));
      modelRound += 1;
      if (modelRound === 1) {
        return {
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
          content: [{
            type: "tool_call",
            id: "call-agenda",
            name: "lark.calendar.agenda",
            arguments: { start: "today" },
          }],
          toolCalls: [{
            id: "call-agenda",
            name: "lark.calendar.agenda",
            arguments: { start: "today" },
          }],
        };
      }
      return {
        requestedModelRevisionId: request.modelProfileRevisionId,
        actualModelRevisionId: request.modelProfileRevisionId,
        content: [{ type: "text", text: "{\"summary\":\"One event\"}" }],
        toolCalls: [],
        structuredOutput: { summary: "One event" },
      };
    },
    toolExecutor: async (request) => {
      toolCalls.push(structuredClone({ ...request, signal: undefined }));
      return {
        status: "succeeded",
        action: request.toolId,
        effect: "read",
        output: [{
          event_id: "event-review",
          summary: "Review",
          start_time: { datetime: "2026-07-24T13:00:00Z" },
          end_time: { datetime: "2026-07-24T13:30:00Z" },
        }],
        receipt: { receiptId: "lark-read:agenda-1" },
      };
    },
  });
  let ids = 0;
  const broker = new ExecutionBroker({
    persistence,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++ids}`,
    capacityAuthorizer: { async authorize() { return true; } },
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: createPromptToolSkillBackend({
      packageLoader: {
        async loadExecutionPackage() {
          return {
            inspection: {
              manifest: {
                name: "lark-calendar",
                tools: [{
                  action: "lark.calendar.agenda",
                  effect: "read",
                  confirm: false,
                }],
              },
            },
            files: [{
              path: "SKILL.md",
              content: Buffer.from("---\nname: lark-calendar\ndescription: Calendar\n---\nRead the calendar."),
            }],
          };
        },
      },
      toolGateway: gateway,
      materialResolver: async () => [{
        materialKey: "agenda_notes",
        mediaType: "text/markdown",
        contentHash: `sha256:${"b".repeat(64)}`,
        bytes: Buffer.from("private agenda material"),
        contextText: "private agenda material",
      }],
    }),
  });

  const result = await broker.execute({
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-prompt-test",
    attemptId: "attempt-prompt-test",
    workspaceId: "workspace-a",
    controller: { kind: "skill_test", controllerId: "test-run-a", fence: 1 },
    mode: "bounded_agent",
    isolation: "process",
    goal: "Summarize today's calendar.",
    input: { date: "today" },
    limits: {
      timeoutMs: 30_000,
      maxSteps: 8,
      maxModelRequests: 4,
      maxChildren: 0,
      maxInputBytes: 100_000,
      maxOutputBytes: 100_000,
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
      properties: { summary: { type: "string", minLength: 1 } },
      required: ["summary"],
      additionalProperties: false,
    },
    evidenceRequirements: [{
      requirementId: "prompt-test-output",
      kind: "validation",
      required: true,
      description: "Return one validated summary.",
    }],
    metadata: {
      executionRef: {
        capabilityId: `prompt-${"a".repeat(48)}`,
        taskIntent: "execute",
        adapterVersion: "1",
        executionMode: "agent",
      },
      outerNodeId: "skill-test:test-run-a",
      skillName: "lark-calendar",
      requestedBy: "user-a",
      externalActionConfirmed: false,
      modelProfileRevisionId: "model-revision-1",
      modelCapability: "tool_calling",
      fallbackModelProfileRevisionIds: [],
      materialBindings: [{
        materialKey: "agenda_notes",
        source: {
          kind: "attachment",
          attachment: {
            attachmentId: "attachment-agenda",
            version: 1,
            contentHash: `sha256:${"b".repeat(64)}`,
            mediaType: "text/markdown",
          },
        },
      }],
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { summary: "One event" });
  assert.equal(modelCalls.length, 2);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].toolId, "lark.calendar.agenda");
  assert.equal(toolCalls[0].connectionId, "connection-calendar");
  assert.equal(toolCalls[0].metadata.skillName, "lark-calendar");
  assert.equal(toolCalls[0].metadata.requestedBy, "user-a");
  assert.deepEqual(toolCalls[0].controller, {
    kind: "skill_test",
    controllerId: "test-run-a",
    fence: 1,
  });
  const invocation = await persistence.getInvocation("invocation-prompt-test");
  assert.equal(invocation.status, "completed");
  assert.equal(invocation.controller.kind, "skill_test");
  assert.match(JSON.stringify(invocation.request), /attachment-agenda/);
  assert.doesNotMatch(JSON.stringify(invocation.request), /private agenda material/);
  assert.match(JSON.stringify(modelCalls[0].typedInput), /private agenda material/);
});
