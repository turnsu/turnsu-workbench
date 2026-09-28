import assert from "node:assert/strict";
import test from "node:test";

import { CanonicalMemoryResolver } from "../../src/memory/index.mjs";
import { canonicalRequestHash, canonicalSkillDraftContentHash } from "../../src/store/serialization.mjs";

const workspaceId = "workspace-a";

function fixture() {
  const workflowRevision = {
    schemaVersion: "workbench-v1",
    workflowId: "workflow-a",
    revisionId: "revision-7",
    revisionNumber: 7,
    graph: { nodes: [], edges: [] },
    definition: { goal: "Ship a verified workflow." },
  };
  const compileResult = {
    compileResultId: "compile-7",
    workflowRevisionId: "revision-7",
    status: "ready",
    diagnostics: [],
    executionPlan: {
      workflowId: "workflow-a",
      workflowRevisionId: "revision-7",
      planVersion: 2,
    },
    compiledAt: "2026-07-16T10:00:00.000Z",
  };
  const skillDraft = {
    skillDraftId: "skill-draft-a",
    skillId: "skill-a",
    workspaceId,
    baseVersionId: null,
    revision: 3,
    name: "Verified Skill",
    description: "A verified draft.",
    category: "testing",
    inputSchema: {},
    outputSchema: {},
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    files: [],
  };
  const draftHash = canonicalSkillDraftContentHash(skillDraft);
  const validation = {
    validationId: "validation-a",
    workspaceId,
    skillId: "skill-a",
    skillDraftId: "skill-draft-a",
    draftRevision: 3,
    contentHash: draftHash,
    status: "passed",
    completedAt: "2026-07-16T10:00:00.000Z",
  };
  const skillVersion = {
    skillVersionId: "skill-version-a",
    skillId: "skill-a",
    workspaceId,
    version: "1.0.0",
    contentHash: "sha256:cccccccccccccccc",
    packageHash: "sha256:dddddddddddddddd",
    validation: { validationId: "validation-a", status: "passed", contentHash: draftHash },
    publishedAt: "2026-07-16T10:00:00.000Z",
  };
  const store = {
    async connect() {},
    async getWorkflow(workflowId, options) {
      if (workflowId !== "workflow-a" || options.workspaceId !== workspaceId) {
        const error = new Error("workflow_not_found");
        error.code = "workflow_not_found";
        throw error;
      }
      return { workflow: { workflowId, currentRevisionId: "revision-7" } };
    },
    repositories: {
      workflowRevisions: { async get() { return structuredClone(workflowRevision); } },
      compileResults: { async getLatest() { return structuredClone(compileResult); } },
      skillDrafts: {
        async get(id, options) {
          return id === skillDraft.skillDraftId && options.workspaceId === workspaceId
            ? structuredClone(skillDraft)
            : null;
        },
      },
      skillValidations: {
        async getExactPassed(query) {
          return query.contentHash === draftHash && query.workspaceId === workspaceId
            ? structuredClone(validation)
            : null;
        },
      },
      skillVersions: {
        async get(id, options) {
          return id === skillVersion.skillVersionId && options.workspaceId === workspaceId
            ? structuredClone(skillVersion)
            : null;
        },
      },
    },
  };
  return { store, workflowRevision, compileResult, skillDraft, validation, skillVersion };
}

test("resolver derives Workflow evidence from the current saved revision and ready compile", async () => {
  const { store, workflowRevision } = fixture();
  const resolver = new CanonicalMemoryResolver({ store });
  const resolved = await resolver.resolve({
    workspaceId,
    objectKind: "workflow",
    objectId: "workflow-a",
    versionId: "revision-7",
    factPath: "/definition/goal",
  });

  assert.equal(resolved.source.verified, true);
  assert.equal(resolved.evidence[0].hash, canonicalRequestHash(workflowRevision));
  assert.equal(resolved.evidence[1].kind, "validation");
  assert.deepEqual(resolved.verification, {
    objectKind: "workflow",
    objectId: "workflow-a",
    versionId: "revision-7",
    factPath: "/definition/goal",
  });
  assert.equal(resolved.statement, "Ship a verified workflow.");
});

test("resolver rejects stale Workflow revisions and caller evidence hash mismatches", async () => {
  const { store } = fixture();
  const resolver = new CanonicalMemoryResolver({ store });
  await assert.rejects(
    resolver.resolve({ workspaceId, objectKind: "workflow", objectId: "workflow-a", versionId: "revision-6", factPath: "/definition/goal" }),
    { code: "canonical_memory_version_stale" },
  );
  await assert.rejects(
    resolver.resolve({
      workspaceId,
      objectKind: "workflow",
      objectId: "workflow-a",
      versionId: "revision-7",
      factPath: "/definition/goal",
      expectedEvidenceHash: "sha256:ffffffffffffffff",
    }),
    { code: "canonical_memory_evidence_mismatch" },
  );
});

test("resolver verifies the exact current Skill Draft and immutable published Skill Version", async () => {
  const { store, skillDraft, skillVersion } = fixture();
  const resolver = new CanonicalMemoryResolver({ store });
  const draft = await resolver.resolve({
    workspaceId,
    objectKind: "skill_draft",
    objectId: skillDraft.skillDraftId,
    versionId: `${skillDraft.skillDraftId}:${skillDraft.revision}`,
    factPath: "/name",
  });
  assert.equal(draft.evidence[0].hash, canonicalSkillDraftContentHash(skillDraft));
  assert.equal(draft.evidence[1].kind, "validation");

  const published = await resolver.resolve({
    workspaceId,
    objectKind: "skill_version",
    objectId: skillVersion.skillId,
    versionId: skillVersion.skillVersionId,
    factPath: "/version",
  });
  assert.equal(published.evidence[0].hash, canonicalRequestHash(skillVersion));
  assert.equal(published.source.versionId, skillVersion.skillVersionId);
});

test("resolver rejects missing, cross-workspace, and unvalidated canonical objects", async () => {
  const { store } = fixture();
  const resolver = new CanonicalMemoryResolver({ store });
  await assert.rejects(
    resolver.resolve({ workspaceId: "workspace-other", objectKind: "skill_draft", objectId: "skill-draft-a", versionId: "skill-draft-a:3", factPath: "/name" }),
    { code: "canonical_memory_object_not_found" },
  );
  store.repositories.skillValidations.getExactPassed = async () => null;
  await assert.rejects(
    resolver.resolve({ workspaceId, objectKind: "skill_draft", objectId: "skill-draft-a", versionId: "skill-draft-a:3", factPath: "/name" }),
    { code: "canonical_memory_validation_required" },
  );
});

test("resolver permits only an existing scalar fact selected by JSON Pointer", async () => {
  const { store } = fixture();
  const resolver = new CanonicalMemoryResolver({ store });
  await assert.rejects(
    resolver.resolve({ workspaceId, objectKind: "workflow", objectId: "workflow-a", versionId: "revision-7", factPath: "/definition" }),
    { code: "canonical_memory_fact_not_scalar" },
  );
  await assert.rejects(
    resolver.resolve({ workspaceId, objectKind: "workflow", objectId: "workflow-a", versionId: "revision-7", factPath: "/definition/missing" }),
    { code: "canonical_memory_fact_not_found" },
  );
});
