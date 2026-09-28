import assert from "node:assert/strict";
import test from "node:test";

import { PostgresSkillValidationPersistence } from "../../src/skills/index.mjs";

function storeWith(steps) {
  const pending = [...steps];
  return {
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = pending.shift(); assert.ok(step, `unexpected query: ${text}`); assert.match(text, step.match);
      if (step.values) assert.deepEqual(values, step.values); return { rows: step.rows ?? [] };
    } }); },
    async withTransaction(work) { return work({}); },
    assertDrained() { assert.equal(pending.length, 0); },
  };
}

const record = {
  schemaVersion: "workbench-v1", testRunId: "test-alpha", workspaceId: "workspace-alpha", requestedBy: "alice",
  skillId: "skill-alpha", skillDraftId: "draft-alpha", packageHash: "sha256:bbbbbbbbbbbbbbbb", contentHash: "sha256:cccccccccccccccc",
  testCase: { name: "Smoke", purpose: "Verify package", input: {}, timeoutSeconds: 30, materialBindings: [], connectionBindings: [] },
  status: "queued", diagnostics: [], outputPreview: null, startedAt: null, completedAt: null, executionAttempt: 1,
};
const evidence = {
  workspaceId: "workspace-alpha", skillId: "skill-alpha", skillDraftId: "draft-alpha", draftRevision: 2,
  uploadId: "upload-alpha", objectId: "object-alpha", objectHash: "sha256:aaaaaaaaaaaaaaaa", packageHash: record.packageHash,
  contentHash: record.contentHash, isolated: true, networkDenied: true, runtimeSummary: { runtimeLabel: "Isolated runtime" },
};

test("PostgreSQL validation persistence inserts one command-bound Test Run and immutable evidence in a UoW", async () => {
  const store = storeWith([
    { match: /SET CONSTRAINTS ALL DEFERRED/ },
    { match: /INSERT INTO public\.skill_test_runs/, values: ["workspace-alpha", "test-alpha", "skill-alpha", "draft-alpha", 2, "alice", record.packageHash, record.contentHash, "upload-alpha", "object-alpha", "sha256:aaaaaaaaaaaaaaaa", JSON.stringify(record.testCase), "2026-08-11T00:00:00.000Z"] },
    { match: /INSERT INTO public\.skill_test_evidence/ },
  ]);
  const persistence = new PostgresSkillValidationPersistence({ store, clock: () => "2026-08-11T00:00:00.000Z" });
  const result = await persistence.insertTestRun({ record, evidence });
  assert.equal(result.testRunId, "test-alpha");
  store.assertDrained();
});

test("PostgreSQL validation persistence requires an exact active claim for terminal settlement", async () => {
  const store = storeWith([
    { match: /UPDATE public\.skill_test_runs/, values: [
      "workspace-alpha", "test-alpha", ["running"], "passed", null, true, null, null, false, null, true,
      "2026-08-11T00:01:00.000Z", false, "[]", true, JSON.stringify({ ok: true }), "2026-08-11T00:02:00.000Z", "{}", 1, "worker-alpha", 4, "2026-08-11T00:02:00.000Z",
    ], rows: [{ schema_version: "workbench-v1", test_run_id: "test-alpha", workspace_id: "workspace-alpha", skill_id: "skill-alpha", skill_draft_id: "draft-alpha", package_hash: record.packageHash, content_hash: record.contentHash, test_case: record.testCase, status: "passed", diagnostics: [], output_preview: { ok: true }, execution_attempt: 1, requested_by: "alice", runner_claim_owner: null, runner_claim_fence: 4, runner_claim_expires_at: null, started_at: "2026-08-11T00:01:00.000Z", completed_at: "2026-08-11T00:01:00.000Z" }] },
  ]);
  const persistence = new PostgresSkillValidationPersistence({ store, clock: () => "2026-08-11T00:02:00.000Z" });
  const result = await persistence.transitionTestRun({ workspaceId: "workspace-alpha", testRunId: "test-alpha", expectedStatuses: ["running"], expectedExecutionAttempt: 1, expectedClaimOwner: "worker-alpha", expectedClaimFence: 4, expectedClaimValidAt: "2026-08-11T00:02:00.000Z", patch: { status: "passed", runnerClaimOwner: null, runnerClaimExpiresAt: null, completedAt: "2026-08-11T00:01:00.000Z", outputPreview: { ok: true } } });
  assert.equal(result.status, "passed");
  store.assertDrained();
});
