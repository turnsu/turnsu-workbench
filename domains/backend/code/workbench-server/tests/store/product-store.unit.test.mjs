import assert from "node:assert/strict";
import test from "node:test";
import * as storeModule from "../../src/store/index.mjs";

import {
  DEFAULT_PRODUCT_DATABASE,
  PRODUCT_INDEX_DEFINITIONS,
  ProductMongoStore,
  SkillRepository,
  SkillVersionRepository,
  TemplateRepository,
  RunNodeAttemptRepository,
  RunRepository,
  WorkflowRepository,
  WorkflowRevisionRepository,
  canonicalRequestHash,
  formatSkillDraftEtag,
  formatWorkflowEtag,
} from "../../src/store/index.mjs";
import { skillDefinitionExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";

test("canonical request hashes ignore object key order but preserve body changes", () => {
  const left = {
    schemaVersion: "workbench-api-v1",
    data: { name: "Research", settings: { timeout: 30, enabled: true } },
  };
  const reordered = {
    data: { settings: { enabled: true, timeout: 30 }, name: "Research" },
    schemaVersion: "workbench-api-v1",
  };
  const changed = structuredClone(reordered);
  changed.data.settings.timeout = 31;

  assert.match(canonicalRequestHash(left), /^sha256:[a-f0-9]{64}$/);
  assert.equal(canonicalRequestHash(left), canonicalRequestHash(reordered));
  assert.notEqual(canonicalRequestHash(left), canonicalRequestHash(changed));
});

test("the strong workflow ETag includes internal write state exactly", () => {
  assert.equal(
    formatWorkflowEtag({
      workflowId: "workflow-alpha",
      writeVersion: 7,
      currentRevisionId: "revision-7",
    }),
    '"wfv1:workflow-alpha:7:revision-7"',
  );
});

test("required unique index definitions cover legacy and V1 immutable product identities", () => {
  const uniqueIndexes = PRODUCT_INDEX_DEFINITIONS.flatMap(({ collection, indexes }) =>
    indexes
      .filter(({ options }) => options?.unique)
      .map(({ key }) => `${collection}:${JSON.stringify(key)}`),
  );

  const expected = [
    'product_users:{"userId":1}',
    'product_workspaces:{"workspaceId":1}',
    'workspace_memberships:{"workspaceId":1,"userId":1}',
    'product_sessions:{"sessionId":1}',
    'product_sessions:{"tokenHash":1}',
    'skill_assets:{"skillId":1}',
    'skill_drafts:{"skillDraftId":1}',
    'skill_versions:{"skillVersionId":1}',
    'skill_versions:{"workspaceId":1,"skillId":1,"version":1}',
    'skill_test_runs:{"testRunId":1}',
    'skill_test_evidence:{"testRunId":1}',
    'skill_validations:{"validationId":1}',
    'skill_execution_bindings:{"executionBindingId":1}',
    'skill_execution_bindings:{"validationId":1}',
    'skill_execution_bindings:{"workspaceId":1,"skillDraftId":1,"draftRevision":1,"contentHash":1,"packageHash":1}',
    'loop_versions:{"loopVersionId":1}',
    'loop_versions:{"workspaceId":1,"workflowId":1,"version":1}',
    'loop_imports:{"importId":1}',
    'workspace_asset_releases:{"releaseId":1}',
    'asset_installations:{"installationId":1}',
    'upload_sessions:{"uploadId":1}',
    'product_objects:{"objectId":1}',
    'workspace_connections:{"connectionId":1}',
    'workspace_connection_bindings:{"workspaceId":1,"targetKind":1,"targetId":1,"requirementId":1}',
    'builder_proposals:{"proposalId":1}',
    'run_jobs:{"runJobId":1}',
    'run_jobs:{"runId":1}',
    'run_leases:{"runId":1}',
    'run_checkpoints:{"checkpointId":1}',
    'run_checkpoints:{"runId":1,"sequence":1}',
    'run_checkpoints:{"runId":1,"attemptId":1,"sequence":1}',
    'run_commands:{"runCommandId":1}',
    'execution_plans:{"planId":1}',
    'idempotency_records:{"scope":1,"key":1}',
    'run_events:{"eventId":1}',
    'run_events:{"runId":1,"sequence":1}',
    'run_node_attempts:{"runId":1,"nodeId":1,"attempt":1}',
    'run_read_models:{"runId":1}',
    'review_decisions:{"decisionId":1}',
    'runs:{"runId":1}',
    'skills:{"skillId":1,"version":1}',
    'templates:{"templateId":1,"templateVersion":1}',
    'workflow_revisions:{"revisionId":1}',
    'workflow_revisions:{"workflowId":1,"revisionNumber":1}',
    'workflows:{"workflowId":1}',
  ];
  for (const index of expected) assert.ok(uniqueIndexes.includes(index), `missing ${index}`);
  assert.equal(new Set(uniqueIndexes).size, uniqueIndexes.length);
});

test("repositories accept injected collections and forward an injected session", async () => {
  const calls = [];
  const session = { id: "unit-session" };
  const collection = {
    async insertOne(document, options) {
      calls.push({ document: structuredClone(document), options });
      return { acknowledged: true, insertedId: "mongo-id" };
    },
  };
  const repository = new SkillRepository(collection);

  const result = await repository.insert(
    { _id: "must-not-leak", ...structuredClone(skillDefinitionExample) },
    { session },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.session, session);
  assert.equal(Object.hasOwn(result, "_id"), false);
  assert.equal(Object.hasOwn(calls[0].document, "_id"), false);
});

test("Skill test evidence and execution binding repositories expose internal reads only", () => {
  assert.equal(typeof storeModule.SkillTestRunRepository.prototype.get, "function");
  assert.equal(typeof storeModule.SkillTestEvidenceRepository.prototype.getInternal, "function");
  assert.equal(storeModule.SkillTestEvidenceRepository.prototype.get, undefined);
  assert.equal(typeof storeModule.SkillExecutionBindingRepository.prototype.getExactInternal, "function");
  assert.equal(typeof storeModule.SkillExecutionBindingRepository.prototype.getByExecutionRefInternal, "function");
  assert.equal(storeModule.SkillExecutionBindingRepository.prototype.get, undefined);
});

test("Skill version history is workspace-scoped, skill-scoped, and deterministically newest-first", async () => {
  const observed = {};
  const documents = [
    { skillVersionId: "version-b", workspaceId: "workspace-a", skillId: "skill-a", publishedAt: "2026-07-13T10:00:00.000Z" },
    { skillVersionId: "version-a", workspaceId: "workspace-a", skillId: "skill-a", publishedAt: "2026-07-13T10:00:00.000Z" },
  ];
  const cursor = {
    sort(value) { observed.sort = value; return this; },
    limit(value) { observed.limit = value; return this; },
    async toArray() { return structuredClone(documents); },
  };
  const repository = new SkillVersionRepository({
    find(filter, options) {
      observed.filter = structuredClone(filter);
      observed.options = options;
      return cursor;
    },
  });

  const result = await repository.listBySkill("skill-a", {
    workspaceId: "workspace-a",
    limit: 2,
  });

  assert.deepEqual(observed.filter, { workspaceId: "workspace-a", skillId: "skill-a" });
  assert.deepEqual(observed.sort, { publishedAt: -1, skillVersionId: -1 });
  assert.equal(observed.limit, 2);
  assert.deepEqual(result, documents);
  assert.throws(() => repository.listBySkill("skill-a"), /workspace_id_required/);
});

test("Product store projects Skill versions onto the product-safe history shape", async () => {
  const store = new ProductMongoStore();
  store.connect = async () => null;
  store.repositories = {
    skillVersions: {
      async listBySkill(skillId, options) {
        assert.equal(skillId, "skill-a");
        assert.equal(options.workspaceId, "workspace-a");
        return [{
          skillVersionId: "version-2",
          skillId,
          workspaceId: options.workspaceId,
          version: "2.0.0",
          name: "Meeting actions",
          description: "Find meeting actions.",
          category: "meetings",
          validation: {
            status: "passed",
            testedAt: "2026-07-13T10:00:00.000Z",
            diagnostics: [],
            contentHash: "sha256:private",
          },
          publishedBy: "user-a",
          publishedAt: "2026-07-13T10:01:00.000Z",
          packageObjectId: "object-private",
          packageHash: "sha256:private",
          contentHash: "sha256:private",
          manifest: { internal: true },
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          executionRef: { capabilityId: "private" },
        }];
      },
    },
  };

  const result = await store.listSkillVersions({
    skillId: "skill-a",
    workspaceId: "workspace-a",
    limit: 10,
  });

  assert.deepEqual(result, [{
    skillVersionId: "version-2",
    skillId: "skill-a",
    version: "2.0.0",
    name: "Meeting actions",
    description: "Find meeting actions.",
    category: "meetings",
    validation: { status: "passed", testedAt: "2026-07-13T10:00:00.000Z" },
    publishedBy: "user-a",
    publishedAt: "2026-07-13T10:01:00.000Z",
  }]);
});

test("ProductRecordRepository can atomically clear stale optional fields while patching", async () => {
  let observed;
  const repository = new storeModule.ProductRecordRepository({
    async findOneAndUpdate(filter, update, options) {
      observed = { filter, update, options };
      return { skillDraftId: "draft-a", revision: 2 };
    },
  }, { idField: "skillDraftId" });
  const value = await repository.patchAndUnset(
    "draft-a",
    { skillDraftId: "must-not-overwrite", revision: 2 },
    ["executionRef", "executionRef"],
    { workspaceId: "workspace-a" },
  );
  assert.deepEqual(observed.filter, { skillDraftId: "draft-a", workspaceId: "workspace-a" });
  assert.deepEqual(observed.update, {
    $set: { revision: 2 },
    $unset: { executionRef: "" },
  });
  assert.equal(observed.options.returnDocument, "after");
  assert.deepEqual(value, { skillDraftId: "draft-a", revision: 2 });
});

test("replacing a Skill draft package is owner/current/revision bound and clears stale execution", async () => {
  const now = "2026-07-13T12:00:00.000Z";
  const draft = {
    skillDraftId: "draft-a",
    skillId: "skill-a",
    revision: 4,
    executionRef: { capabilityId: "stale" },
  };
  const calls = [];
  const store = new ProductMongoStore({ clock: () => now, idFactory: (kind) => `${kind}-a` });
  store.runIdempotentMutation = async (options, mutation) => {
    calls.push({ kind: "idempotency", options });
    return mutation({ transaction: true });
  };
  store.repositories = {
    skillAssets: {
      async get() { return { skillId: "skill-a", ownerId: "user-a", lifecycle: "draft", currentDraftId: "draft-a" }; },
      async patch(skillId, patch) { calls.push({ kind: "skill", skillId, patch }); return { skillId, ...patch }; },
    },
    skillDrafts: {
      async get() { return structuredClone(draft); },
      async patchAndUnset(draftId, patch, unset, options) {
        calls.push({ kind: "draft", draftId, patch, unset, options });
        const next = { ...draft, ...patch };
        delete next.executionRef;
        return next;
      },
    },
    uploads: {
      async get(uploadId) { return { uploadId, state: "promoted", objectId: "object-a" }; },
    },
    objects: {
      async get() {
        return {
          objectId: "object-a",
          contentHash: "sha256:0123456789abcdef",
          mediaType: "application/vnd.looloomi.skill-package+json",
          sizeBytes: 512,
        };
      },
    },
    auditEvents: { async append(event) { calls.push({ kind: "audit", event }); } },
  };
  const request = { data: { uploadId: "upload-a" } };
  const replacement = {
    uploadId: "upload-a",
    objectId: "object-a",
    contentHash: "sha256:0123456789abcdef",
    mediaType: "application/vnd.looloomi.skill-package+json",
    sizeBytes: 512,
  };
  const result = await store.replaceSkillDraftPackage({
    skillId: "skill-a",
    draftId: "draft-a",
    idempotencyKey: "idem-a",
    ifMatch: formatSkillDraftEtag(draft),
    request,
    workspaceId: "workspace-a",
    authoredBy: "user-a",
    replacement,
  });
  assert.equal(result.draft.revision, 5);
  assert.equal(Object.hasOwn(result.draft, "executionRef"), false);
  const draftWrite = calls.find((call) => call.kind === "draft");
  assert.deepEqual(draftWrite.unset, ["executionRef"]);
  assert.deepEqual(draftWrite.patch.files, [{
    path: "package.skill-package",
    objectId: "object-a",
    contentHash: "sha256:0123456789abcdef",
    mediaType: "application/vnd.looloomi.skill-package+json",
    sizeBytes: 512,
  }]);
  assert.deepEqual(calls[0].options.request, { ifMatch: formatSkillDraftEtag(draft), request });
  assert.equal(calls.find((call) => call.kind === "audit").event.action, "skill.draft_package_replaced");
});

test("Skill draft package replacement rejects non-owner, stale revision, and unpromoted upload", async () => {
  const baseDraft = { skillDraftId: "draft-a", skillId: "skill-a", revision: 2 };
  const replacement = {
    uploadId: "upload-a",
    objectId: "object-a",
    contentHash: "sha256:0123456789abcdef",
    mediaType: "application/vnd.looloomi.skill-package+json",
    sizeBytes: 512,
  };
  async function run({ ownerId = "user-a", currentDraftId = "draft-a", revision = 2, uploadState = "promoted" } = {}) {
    const store = new ProductMongoStore();
    store.runIdempotentMutation = async (_options, mutation) => mutation({});
    store.repositories = {
      skillAssets: { async get() { return { skillId: "skill-a", ownerId, lifecycle: "draft", currentDraftId }; } },
      skillDrafts: { async get() { return { ...baseDraft, revision }; } },
      uploads: { async get() { return { uploadId: "upload-a", state: uploadState, objectId: "object-a" }; } },
      objects: { async get() { return replacement; } },
    };
    return store.replaceSkillDraftPackage({
      skillId: "skill-a",
      draftId: "draft-a",
      idempotencyKey: "idem-a",
      ifMatch: formatSkillDraftEtag(baseDraft),
      request: { data: { uploadId: "upload-a" } },
      workspaceId: "workspace-a",
      authoredBy: "user-a",
      replacement,
    });
  }
  await assert.rejects(() => run({ ownerId: "user-b" }), (error) => error?.code === "skill_owner_required");
  await assert.rejects(() => run({ currentDraftId: "draft-b" }), (error) => error?.code === "skill_draft_conflict");
  await assert.rejects(() => run({ revision: 3 }), (error) => error?.code === "skill_draft_conflict");
  await assert.rejects(() => run({ uploadState: "ready_draft" }), (error) => error?.code === "skill_package_not_promoted");
});

test("Skill usage projects legacy Workflows onto a contract-valid product shape", async () => {
  const store = new ProductMongoStore();
  store.connect = async () => null;
  store.repositories = {
    skillAssets: {
      async get() { return { skillId: "skill-a", latestPublishedVersionId: "version-1" }; },
    },
    skillVersions: {
      async get() { return { skillVersionId: "version-1", version: "1.0.0" }; },
    },
    workflows: {
      async list() {
        return [{
          workflowId: "workflow-legacy",
          currentRevisionId: "revision-legacy",
          name: "Legacy meeting follow-up",
          readiness: "Ready",
        }];
      },
    },
    workflowRevisions: {
      async get() {
        return {
          revisionId: "revision-legacy",
          graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-a", version: "1.0.0" } }] },
        };
      },
    },
  };

  const result = await store.getSkillUsageImpact({
    skillId: "skill-a",
    workspaceId: "workspace-a",
  });

  assert.deepEqual(result.affectedWorkflows, [{
    workflowId: "workflow-legacy",
    revisionId: "revision-legacy",
    name: "Legacy meeting follow-up",
    visibility: "private",
    state: "ready",
  }]);
});

test("Loop Skill update preview is owner-scoped and derives one safe revision change", async () => {
  const current = {
    skillVersionId: "skill-version-1",
    skillId: "skill-a",
    version: "1.0.0",
    name: "Meeting actions",
    description: "Find follow-up work.",
    inputSchema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
    outputSchema: { type: "object", properties: { actions: { type: "string" } }, required: ["actions"] },
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    packageHash: "sha256:current",
  };
  const target = {
    ...current,
    skillVersionId: "skill-version-2",
    version: "2.0.0",
    description: "Find owners and due dates.",
    packageHash: "sha256:target",
  };
  const store = new ProductMongoStore();
  store.connect = async () => null;
  store.repositories = {
    workflows: {
      async getInternal() {
        return {
          workflowId: "workflow-a",
          currentRevisionId: "revision-a",
          name: "Meeting follow-up",
          ownerId: "user-a",
          writeVersion: 3,
        };
      },
    },
    workflowRevisions: {
      async get() {
        return {
          revisionId: "revision-a",
          graph: {
            nodes: [{
              nodeId: "node-skill",
              kind: "Skill",
              title: "Extract actions",
              skillRef: { skillId: "skill-a", version: "1.0.0" },
            }],
          },
        };
      },
    },
    skillAssets: {
      async get() { return { skillId: "skill-a", lifecycle: "ready" }; },
    },
    skillVersions: {
      async get(id) { return structuredClone(id === target.skillVersionId ? target : current); },
      async getBySkillRef() { return structuredClone(current); },
    },
  };

  const result = await store.getLoopSkillUpdatePreview({
    workflowId: "workflow-a",
    skillVersionId: target.skillVersionId,
    workspaceId: "workspace-a",
    requestedBy: "user-a",
  });

  assert.equal(result.preview.currentVersion.version, "1.0.0");
  assert.equal(result.preview.targetVersion.version, "2.0.0");
  assert.deepEqual(result.preview.affectedNodes, [{ nodeId: "node-skill", title: "Extract actions" }]);
  assert.equal(result.preview.changes.find((entry) => entry.field === "purpose").changed, true);
  assert.equal(result.preview.requiresTestRun, true);
  assert.equal(result.etag, '"wfv1:workflow-a:3:revision-a"');
  assert.equal(Object.hasOwn(result.preview.targetVersion, "packageHash"), false);

  await assert.rejects(
    () => store.getLoopSkillUpdatePreview({
      workflowId: "workflow-a",
      skillVersionId: target.skillVersionId,
      workspaceId: "workspace-a",
      requestedBy: "user-b",
    }),
    (error) => error?.code === "loop_owner_required",
  );
});

test("Skill publication requires exact persisted validation and execution binding", async () => {
  const now = "2026-07-13T09:00:00.000Z";
  const packageHash = `sha256:${"1".repeat(64)}`;
  const objectHash = `sha256:${"2".repeat(64)}`;
  const draft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "draft-1",
    skillId: "skill-1",
    workspaceId: "workspace-1",
    baseVersionId: null,
    revision: 1,
    name: "Validated Skill",
    description: "A validated uploaded Skill.",
    category: "utility",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    files: [{ path: "package.skill-package", objectId: "object-1", contentHash: objectHash, mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: 128 }],
    updatedBy: "user-1",
    createdAt: now,
    updatedAt: now,
  };
  const skill = {
    schemaVersion: "workbench-v1",
    skillId: "skill-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    visibility: "private",
    lifecycle: "draft",
    currentDraftId: draft.skillDraftId,
    latestPublishedVersionId: null,
    createdAt: now,
    updatedAt: now,
  };
  const upload = {
    uploadId: "upload-1",
    workspaceId: "workspace-1",
    objectId: "object-1",
    state: "promoted",
    inspection: { status: "needs_review", contentHash: packageHash, manifest: {} },
  };
  const store = new ProductMongoStore({ clock: () => now, idFactory: (kind) => `${kind}-1` });
  store.runIdempotentMutation = async (_options, mutation) => mutation({ id: "session-1" });
  let validation = null;
  let binding = null;
  let insertedVersion = null;
  store.repositories = {
    skillAssets: {
      async get() { return structuredClone(skill); },
      async patch(_id, patch) { return { ...structuredClone(skill), ...structuredClone(patch) }; },
    },
    skillDrafts: { async get() { return structuredClone(draft); } },
    uploads: { async list() { return [structuredClone(upload)]; } },
    objects: { async get() { return { objectId: "object-1", workspaceId: "workspace-1", contentHash: objectHash }; } },
    skillValidations: { async getExactPassed() { return validation && structuredClone(validation); } },
    skillExecutionBindings: { async getExactInternal() { return binding && structuredClone(binding); } },
    skillVersions: {
      async list() { return []; },
      async insert(value) { insertedVersion = structuredClone(value); return structuredClone(value); },
    },
    assetReleases: { async insert(value) { return structuredClone(value); } },
    auditEvents: { async append(value) { return structuredClone(value); } },
  };
  const request = { schemaVersion: "workbench-api-v1", data: { version: "1.0.0", releaseNotes: "Validated release." } };
  const args = {
    skillId: "skill-1",
    idempotencyKey: "publish-1",
    ifMatch: storeModule.formatSkillDraftEtag(draft),
    request,
    workspaceId: "workspace-1",
    publishedBy: "user-1",
  };
  await assert.rejects(() => store.publishSkill(args), (error) => error?.code === "skill_validation_failed");

  const expectedContentHash = canonicalRequestHash({
    skillDraftId: draft.skillDraftId,
    skillId: draft.skillId,
    baseVersionId: draft.baseVersionId,
    revision: draft.revision,
    name: draft.name,
    description: draft.description,
    category: draft.category,
    inputSchema: draft.inputSchema,
    outputSchema: draft.outputSchema,
    risk: draft.risk,
    dependencies: draft.dependencies,
    connectionRequirements: draft.connectionRequirements,
    files: draft.files,
  });
  validation = {
    validationId: "validation-1",
    workspaceId: "workspace-1",
    skillId: "skill-1",
    skillDraftId: "draft-1",
    draftRevision: 1,
    contentHash: expectedContentHash,
    testRunIds: ["test-run-1"],
    status: "passed",
    diagnostics: [],
    completedAt: now,
  };
  await assert.rejects(() => store.publishSkill(args), (error) => error?.code === "skill_activation_required");

  binding = {
    validationId: "validation-1",
    packageHash,
    executionRef: { capabilityId: "uploaded-proof", taskIntent: "execute", adapterVersion: "1", executionMode: "deterministic" },
  };
  const published = await store.publishSkill(args);
  assert.equal(published.version.validation.validationId, validation.validationId);
  assert.deepEqual(published.version.executionRef, binding.executionRef);
  assert.equal(insertedVersion.validation.testedAt, now);
  assert.equal(Object.hasOwn(insertedVersion, "imageDigest"), false);
});

test("external idempotency claims execute outside transactions and recover a stable operation ID", async () => {
  const records = new Map();
  let ids = 0;
  const store = new ProductMongoStore({
    clock: () => "2026-07-13T09:00:00.000Z",
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  store.connect = async () => {};
  store.repositories = {
    idempotencyRecords: {
      async getInternal(scope, key) { return structuredClone(records.get(`${scope}:${key}`) ?? null); },
      async insertPending(record) { records.set(`${record.scope}:${record.key}`, structuredClone(record)); return structuredClone(record); },
      async takeOverExternal(scope, key, change) {
        const record = records.get(`${scope}:${key}`);
        const next = { ...record, state: "executing", leaseOwner: change.leaseOwner, leaseExpiresAt: change.leaseExpiresAt, executionAttempt: record.executionAttempt + 1 };
        records.set(`${scope}:${key}`, next);
        return structuredClone(next);
      },
      async completeExternal(scope, key, change) {
        const record = records.get(`${scope}:${key}`);
        const next = { ...record, state: "completed", response: structuredClone(change.response), leaseOwner: null, leaseExpiresAt: null };
        records.set(`${scope}:${key}`, next);
        return structuredClone(next);
      },
      async releaseExternal() {},
    },
  };
  let executions = 0;
  const options = {
    scope: "test-skill-draft:skill-1:draft-1",
    key: "external-1",
    request: { ifMatch: '"draft-1"', request: { data: { value: 1 } } },
    workspaceId: "workspace-1",
    operationIdKind: "skill-test-run",
  };
  const first = await store.runIdempotentExternalMutation(options, async (operationId) => {
    executions += 1;
    return { operationId, status: "passed" };
  });
  const replay = await store.runIdempotentExternalMutation(options, async () => {
    executions += 1;
    throw new Error("must_not_reexecute");
  });
  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
  await assert.rejects(
    () => store.runIdempotentExternalMutation({ ...options, request: { changed: true } }, async () => null),
    (error) => error?.code === "idempotency_key_reused",
  );

  const recoveryOptions = { ...options, key: "external-recovery" };
  const scope = `workspace:workspace-1:${recoveryOptions.scope}`;
  records.set(`${scope}:${recoveryOptions.key}`, {
    scope,
    key: recoveryOptions.key,
    requestHash: canonicalRequestHash(recoveryOptions.request),
    response: null,
    operationId: "skill-test-run-recoverable",
    state: "retryable",
    executionAttempt: 1,
    leaseOwner: null,
    leaseExpiresAt: "2026-07-13T08:59:00.000Z",
  });
  const recovered = await store.runIdempotentExternalMutation({
    ...recoveryOptions,
    recover: async (operationId) => ({ operationId, status: "passed" }),
  }, async () => {
    executions += 1;
    throw new Error("must_not_reexecute_recovered_effect");
  });
  assert.equal(recovered.operationId, "skill-test-run-recoverable");
  assert.equal(executions, 1);
});

test("RunJobRepository claims with one atomic fence and rejects stale completion", async () => {
  assert.equal(typeof storeModule.RunJobRepository, "function");
  const calls = [];
  const collection = {
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      if (calls.length === 1) {
        return {
          runJobId: "job-1",
          runId: "run-1",
          workspaceId: "workspace-1",
          status: "leased",
          fence: 1,
          leaseOwner: "worker-a",
          leaseExpiresAt: "2026-07-11T00:00:30.000Z",
          heartbeatAt: "2026-07-11T00:00:00.000Z",
          queuedAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        };
      }
      return null;
    },
  };
  const repository = new storeModule.RunJobRepository(collection);
  const lease = await repository.claimByRun("run-1", {
    workerId: "worker-a",
    now: "2026-07-11T00:00:00.000Z",
    leaseExpiresAt: "2026-07-11T00:00:30.000Z",
  });
  assert.equal(lease.fence, 1);
  assert.equal(calls[0].update.$inc.fence, 1);
  assert.equal(calls[0].options.returnDocument, "after");

  const stale = await repository.finishByRun("run-1", {
    workerId: "worker-b",
    fence: 0,
    status: "completed",
    now: "2026-07-11T00:01:00.000Z",
  });
  assert.equal(stale, null);
  assert.deepEqual(calls[1].filter, { runId: "run-1", leaseOwner: "worker-b", fence: 0 });
});

test("RunJobRepository abandons only its own claim and terminally cancels recoverable jobs", async () => {
  const calls = [];
  const repository = new storeModule.RunJobRepository({
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return null;
    },
  });

  await repository.abandonClaimByRun("run-1", {
    workerId: "worker-a",
    fence: 4,
    now: "2026-07-11T00:01:00.000Z",
  });
  await repository.cancelByRun("run-1", { now: "2026-07-11T00:01:01.000Z" });

  assert.deepEqual(calls[0].filter, {
    runId: "run-1",
    leaseOwner: "worker-a",
    fence: 4,
    status: { $in: ["leased", "running"] },
  });
  assert.equal(calls[0].update.$set.status, "queued");
  assert.deepEqual(calls[1].filter, {
    runId: "run-1",
    status: { $in: ["queued", "leased", "running", "paused"] },
  });
  assert.equal(calls[1].update.$set.status, "cancelled");
});

test("RunLeaseRepository never overwrites a newer fence", async () => {
  assert.equal(typeof storeModule.RunLeaseRepository, "function");
  const calls = [];
  const duplicate = Object.assign(new Error("duplicate"), { code: 11000 });
  const repository = new storeModule.RunLeaseRepository({
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      throw duplicate;
    },
  });
  const stale = await repository.acquire({
    schemaVersion: "workbench-v1",
    runId: "run-1",
    runJobId: "job-1",
    workspaceId: "workspace-1",
    workerId: "worker-a",
    fence: 1,
    status: "active",
    acquiredAt: "2026-07-11T00:00:00.000Z",
    heartbeatAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2026-07-11T00:00:30.000Z",
    releasedAt: null,
    updatedAt: "2026-07-11T00:00:00.000Z",
  });
  assert.equal(stale, null);
  assert.equal(calls[0].options.upsert, true);
  assert.deepEqual(calls[0].filter.$or, [
    { fence: { $lt: 1 } },
    { fence: 1, workerId: "worker-a" },
    { fence: { $exists: false } },
  ]);
});

test("RunLeaseRepository marks an active lease cancelled without weakening its fence", async () => {
  const calls = [];
  const repository = new storeModule.RunLeaseRepository({
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return null;
    },
  });

  await repository.cancelByRun("run-1", { cancelledAt: "2026-07-11T00:01:00.000Z" });

  assert.deepEqual(calls[0].filter, { runId: "run-1", status: "active" });
  assert.deepEqual(calls[0].update.$set, {
    status: "cancelled",
    releasedAt: "2026-07-11T00:01:00.000Z",
    updatedAt: "2026-07-11T00:01:00.000Z",
  });
});

test("RunJobRepository allocates checkpoint sequence under the active fence", async () => {
  const calls = [];
  const repository = new storeModule.RunJobRepository({
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return { runId: "run-1", checkpointSequence: 4 };
    },
  });
  const sequence = await repository.nextCheckpointSequence("run-1", {
    workerId: "worker-a",
    fence: 2,
    now: "2026-07-11T00:00:10.000Z",
  });
  assert.equal(sequence, 4);
  assert.deepEqual(calls[0].filter, { runId: "run-1", leaseOwner: "worker-a", fence: 2 });
  assert.deepEqual(calls[0].update.$inc, { checkpointSequence: 1 });
});

test("workflow reads strip Mongo and concurrency-only fields", async () => {
  const session = { id: "read-session" };
  const collection = {
    async findOne(filter, options) {
      assert.deepEqual(filter, { workflowId: "workflow-alpha" });
      assert.equal(options.session, session);
      return {
        _id: "mongo-id",
        schemaVersion: "workbench-v1",
        workflowId: "workflow-alpha",
        currentRevisionId: "revision-2",
        revisionNumber: 2,
        writeVersion: 9,
      };
    },
  };
  const repository = new WorkflowRepository(collection);

  const workflow = await repository.get("workflow-alpha", { session });

  assert.deepEqual(workflow, {
    schemaVersion: "workbench-v1",
    workflowId: "workflow-alpha",
    currentRevisionId: "revision-2",
  });
});

test("workflow readiness is updated only for its current compiled revision", async () => {
  const calls = [];
  const repository = new WorkflowRepository({
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return {
        workflowId: filter.workflowId,
        currentRevisionId: filter.currentRevisionId,
        status: update.$set.status,
        latestCompile: update.$set.latestCompile,
        updatedAt: update.$set.updatedAt,
      };
    },
  });
  const value = await repository.updateCompileSummary("workflow-alpha", {
    revisionId: "revision-2",
    status: "ready",
    compiledAt: "2026-07-10T10:00:00.000Z",
  });
  assert.deepEqual(calls[0].filter, {
    workflowId: "workflow-alpha",
    currentRevisionId: "revision-2",
  });
  assert.equal(calls[0].update.$set.status, "ready");
  assert.equal(value.latestCompile.revisionId, "revision-2");
});

test("run and node reads hide execution snapshots while internal reads retain them", async () => {
  const runRepository = new RunRepository({
    async findOne() {
      return {
        _id: "mongo-run",
        runId: "run-alpha",
        eventSequence: 4,
        executionPlanSnapshot: { contentHash: "sha256:private" },
        agentFinalReadModel: {
          schemaVersion: "agent-final-read-model-v1",
          runID: "run-alpha",
          finalText: "private final",
        },
        status: "running",
      };
    },
  });
  assert.deepEqual(await runRepository.get("run-alpha"), {
    runId: "run-alpha",
    status: "running",
  });
  assert.deepEqual(await runRepository.getInternal("run-alpha"), {
    runId: "run-alpha",
    eventSequence: 4,
    executionPlanSnapshot: { contentHash: "sha256:private" },
    agentFinalReadModel: {
      schemaVersion: "agent-final-read-model-v1",
      runID: "run-alpha",
      finalText: "private final",
    },
    status: "running",
  });

  const nodeRepository = new RunNodeAttemptRepository({
    async findOne() {
      return {
        _id: "mongo-node",
        runId: "run-alpha",
        nodeId: "node-skill",
        attempt: 1,
        status: "completed",
        executionInput: { text: "private input" },
        executionOutput: { text: "private output" },
      };
    },
  });
  assert.deepEqual(await nodeRepository.get("run-alpha", "node-skill", 1), {
    runId: "run-alpha",
    nodeId: "node-skill",
    attempt: 1,
    status: "completed",
  });
  assert.equal(
    (await nodeRepository.getInternal("run-alpha", "node-skill", 1)).executionOutput.text,
    "private output",
  );
});

test("template and revision repositories reject all post-insert mutations", async () => {
  const collection = {};
  const templateRepository = new TemplateRepository(collection);
  const revisionRepository = new WorkflowRevisionRepository(collection);

  for (const operation of [
    () => templateRepository.update("template-1", {}),
    () => templateRepository.delete("template-1"),
  ]) {
    await assert.rejects(operation, (error) => error?.code === "template_read_only");
  }

  for (const operation of [
    () => revisionRepository.update("revision-1", {}),
    () => revisionRepository.delete("revision-1"),
  ]) {
    await assert.rejects(operation, (error) => error?.code === "workflow_revision_immutable");
  }
});

test("ProductMongoStore uses injected and owned sessions without taking client ownership", async () => {
  let starts = 0;
  let closes = 0;
  let ownedTransactions = 0;
  let ownedEnds = 0;
  const ownedSession = {
    inTransaction: () => false,
    async withTransaction(callback) {
      ownedTransactions += 1;
      return callback();
    },
    async endSession() {
      ownedEnds += 1;
    },
  };
  const client = {
    startSession() {
      starts += 1;
      return ownedSession;
    },
    async close() {
      closes += 1;
    },
  };
  const store = new ProductMongoStore({ client, dbName: "looloomi_workbench_unit_test" });

  const ownedResult = await store.withTransaction(async (session) => {
    assert.equal(session, ownedSession);
    return "owned";
  });
  assert.equal(ownedResult, "owned");
  assert.equal(starts, 1);
  assert.equal(ownedTransactions, 1);
  assert.equal(ownedEnds, 1);

  let externalTransactions = 0;
  let externalEnds = 0;
  const externalSession = {
    inTransaction: () => false,
    async withTransaction(callback) {
      externalTransactions += 1;
      return callback();
    },
    async endSession() {
      externalEnds += 1;
    },
  };
  const externalResult = await store.withTransaction(
    async (session) => {
      assert.equal(session, externalSession);
      return "external";
    },
    { session: externalSession },
  );
  assert.equal(externalResult, "external");
  assert.equal(starts, 1);
  assert.equal(externalTransactions, 1);
  assert.equal(externalEnds, 0);

  await store.close();
  assert.equal(closes, 0);
});

test("ProductMongoStore accepts a constructor-injected default session", async () => {
  let transactions = 0;
  let starts = 0;
  const defaultSession = {
    inTransaction: () => false,
    async withTransaction(callback) {
      transactions += 1;
      return callback();
    },
  };
  const store = new ProductMongoStore({
    client: {
      startSession() {
        starts += 1;
      },
    },
    session: defaultSession,
    dbName: "looloomi_workbench_unit_test",
  });

  const result = await store.withTransaction(async (session) => {
    assert.equal(session, defaultSession);
    return "default-session";
  });

  assert.equal(result, "default-session");
  assert.equal(transactions, 1);
  assert.equal(starts, 0);
});

test("ProductMongoStore defaults to the non-test product database", () => {
  const store = new ProductMongoStore({ client: {} });

  assert.equal(store.dbName, DEFAULT_PRODUCT_DATABASE);
  assert.equal(store.dbName.endsWith("_test"), false);
});

test("advancing a workflow revision updates the workflow timestamp", async () => {
  let update;
  const repository = new WorkflowRepository({
    async findOneAndUpdate(filter, nextUpdate, options) {
      update = { filter, nextUpdate, options };
      return {
        workflowId: "workflow-alpha",
        currentRevisionId: "revision-2",
        revisionNumber: 2,
        writeVersion: 2,
        updatedAt: "2026-07-10T00:00:01.000Z",
      };
    },
  });

  await repository.advanceRevisionInternal("workflow-alpha", {
    expectedRevisionId: "revision-1",
    expectedWriteVersion: 1,
    currentRevisionId: "revision-2",
    revisionNumber: 2,
    writeVersion: 2,
    updatedAt: "2026-07-10T00:00:01.000Z",
  });

  assert.deepEqual(update.nextUpdate, {
    $set: {
      currentRevisionId: "revision-2",
      revisionNumber: 2,
      writeVersion: 2,
      updatedAt: "2026-07-10T00:00:01.000Z",
    },
  });
});

test("destructive cleanup refuses every database not ending in _test", async () => {
  const store = new ProductMongoStore({
    client: {},
    dbName: "looloomi_workbench",
  });

  await assert.rejects(
    () => store.dropDatabase(),
    (error) => error?.code === "destructive_cleanup_requires_test_database",
  );
});
