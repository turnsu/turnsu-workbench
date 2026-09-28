import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionWaitingRecordSchema,
  Check,
  ProductCommandSchema,
} from "../dist/index.js";

const NOW = "2026-08-01T00:00:00.000Z";

test("durable Product Command and admission waiting records carry stable lineage", () => {
  const command = {
    schemaVersion: "workbench-v1",
    commandId: "product-command-a",
    kind: "agent_turn",
    userId: "user-a",
    workspaceId: "workspace-a",
    sessionId: "agent-session-a",
    turnId: "agent-turn-a",
    status: "accepted",
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
  };
  const admission = {
    schemaVersion: "workbench-v1",
    admissionId: "admission-a",
    commandId: command.commandId,
    kind: "command_turn",
    invocationId: null,
    userId: command.userId,
    workspaceId: command.workspaceId,
    sessionId: command.sessionId,
    turnId: command.turnId,
    state: "waiting_session_turn",
    queueSlotHeld: true,
    createdAt: NOW,
    updatedAt: NOW,
    releasedAt: null,
  };
  assert.equal(Check(ProductCommandSchema, command), true);
  assert.equal(Check(AdmissionWaitingRecordSchema, admission), true);
  assert.equal(Check(ProductCommandSchema, { ...command, status: "queued" }), false);
  assert.equal(Check(ProductCommandSchema, { ...command, kind: "skill_test" }), true);
  assert.equal(Check(ProductCommandSchema, {
    ...command,
    commandId: "product-command-cancel-skill-test",
    kind: "cancel_skill_test",
    targetCommandId: "skill-test-run-a",
  }), true);
  assert.equal(Check(ProductCommandSchema, {
    ...command,
    commandId: "product-command-finish-skill-creation-realtime",
    kind: "finish_skill_creation_realtime_call",
    targetCommandId: "product-command-skill-creation-realtime",
  }), true);
  assert.equal(Check(AdmissionWaitingRecordSchema, { ...admission, commandId: undefined }), false);
  assert.equal(Check(AdmissionWaitingRecordSchema, {
    ...admission,
    admissionId: "admission-execution-a",
    kind: "execution_invocation",
    invocationId: "invocation-a",
    sessionId: null,
    turnId: null,
    state: "waiting_capacity",
    queueSlotHeld: false,
  }), true);
});
