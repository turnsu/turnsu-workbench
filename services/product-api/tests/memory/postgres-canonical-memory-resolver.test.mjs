import assert from "node:assert/strict";
import test from "node:test";

import { PostgresCanonicalMemoryResolver } from "../../src/memory/postgres-canonical-memory-resolver.mjs";

const NOW = "2026-08-10T00:00:00.000Z";
const WORKSPACE_ID = "workspace-memory";
const DRAFT_ID = "skill-draft-memory";
const SKILL_ID = "skill-memory";

function fixture({ validation = true } = {}) {
  const draft = {
    schema_version: "workbench-v1", skill_draft_id: DRAFT_ID, skill_id: SKILL_ID,
    workspace_id: WORKSPACE_ID, base_version_id: null, draft_revision: 3,
    content_hash: "sha256:abcdef1234567890", updated_by: "user-memory",
    created_at: NOW, updated_at: NOW,
    definition: { name: "Meeting summary", description: "Extract decisions from a meeting." },
    payload: { executionRef: { executionMode: "deterministic" } },
  };
  const passedValidation = {
    validation_id: "validation-memory", skill_id: SKILL_ID, skill_draft_id: DRAFT_ID,
    draft_revision: 3, content_hash: draft.content_hash, status: "passed",
    diagnostics: [], runtime_summary: { isolated: true }, completed_at: NOW, payload: {},
  };
  const store = {
    persistenceDriver: "postgres",
    async connect() { return this; },
    async withTransaction(work) { return work({ kind: "postgres_unit_of_work" }); },
    bindAdapter(factory) {
      return factory({
        async execute(_uow, query) {
          const text = typeof query === "string" ? query : query.text;
          if (text.includes("FROM public.skill_drafts")) return { rows: [draft] };
          if (text.includes("FROM public.skill_validations")) return { rows: validation ? [passedValidation] : [] };
          throw new Error("unexpected_query");
        },
      });
    },
  };
  return new PostgresCanonicalMemoryResolver({ store });
}

test("PostgreSQL canonical memory resolver promotes only an exact passed Skill Draft fact", async () => {
  const resolver = fixture();
  const value = await resolver.resolve({
    workspaceId: WORKSPACE_ID,
    objectKind: "skill_draft",
    objectId: DRAFT_ID,
    versionId: `${DRAFT_ID}:3`,
    factPath: "/description",
  });
  assert.equal(value.statement, "Extract decisions from a meeting.");
  assert.deepEqual(value.source, {
    kind: "canonical_object", sourceId: DRAFT_ID, versionId: `${DRAFT_ID}:3`, verified: true,
  });
  assert.deepEqual(value.subject, { kind: "skill_draft", subjectId: DRAFT_ID });
  assert.equal(value.evidence[0].hash, "sha256:abcdef1234567890");
  assert.match(value.evidence[1].hash, /^sha256:[a-f0-9]{64}$/);
});

test("PostgreSQL canonical memory resolver rejects stale and unvalidated draft facts", async () => {
  await assert.rejects(
    fixture().resolve({
      workspaceId: WORKSPACE_ID, objectKind: "skill_draft", objectId: DRAFT_ID,
      versionId: `${DRAFT_ID}:2`, factPath: "/description",
    }),
    { code: "canonical_memory_version_stale" },
  );
  await assert.rejects(
    fixture({ validation: false }).resolve({
      workspaceId: WORKSPACE_ID, objectKind: "skill_draft", objectId: DRAFT_ID,
      versionId: `${DRAFT_ID}:3`, factPath: "/description",
    }),
    { code: "canonical_memory_validation_required" },
  );
});
