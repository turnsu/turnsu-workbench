import assert from "node:assert/strict";
import test from "node:test";
import { createAgentMaterialToolExecutor } from "../../src/tools/agent-material-tool.mjs";

test("task material reads resolve exact Product references and cannot expand task scope", async () => {
  const ref = { attachmentId: "attachment-one", version: 1, contentHash: `sha256:${"a".repeat(64)}`, mediaType: "text/plain" };
  const reads = [];
  const executor = createAgentMaterialToolExecutor({
    agentPersistence: { async listSessionAttachmentRefs(input) {
      assert.equal(input.userId, "alice"); assert.equal(input.workspaceId, "workspace-one");
      assert.equal(input.sessionId, "session-one"); assert.equal(input.throughTurnId, "turn-one");
      return { refs: [ref], hasMore: false };
    } },
    inputAttachmentService: {
      async get() { return { attachment: { ...ref, fileName: "brief.txt", sizeBytes: 50,
        processing: { status: "ready" }, expiresAt: "2030-01-01T00:00:00.000Z" } }; },
      async readText(input) { reads.push(input); return { text: "Source evidence", nextOffset: null }; },
    },
  });
  const request = { toolId: "turnsu_materials", actor: { userId: "alice" }, workspaceId: "workspace-one",
    controller: { kind: "agent_turn", controllerId: "turn-one" },
    metadata: { agentSessionId: "session-one", agentTurnId: "turn-one" } };
  const list = await executor({ ...request, input: { action: "list" } });
  assert.equal(list.files[0].fileName, "brief.txt");
  await executor({ ...request, input: { action: "read", attachmentId: ref.attachmentId, offset: 10, limit: 20 } });
  assert.deepEqual(reads[0], { workspaceId: "workspace-one", requestedBy: "alice", ref, offset: 10, limit: 20, signal: undefined });
  await assert.rejects(executor({ ...request, input: { action: "read", attachmentId: "attachment-other" } }), { code: "attachment_forbidden" });
  await assert.rejects(executor({ ...request, input: { action: "list", sessionId: "session-other" } }), { code: "agent_material_input_invalid" });
  await assert.rejects(executor({ ...request, actor: null, input: { action: "list" } }), { code: "attachment_forbidden" });
  await assert.rejects(executor({ ...request, controller: { kind: "workflow_run", controllerId: "turn-one" }, input: { action: "list" } }), { code: "attachment_forbidden" });
  assert.equal(reads.length, 1);
});
