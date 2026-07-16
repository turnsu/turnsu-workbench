import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import {
  createSkillValidationCoordinator,
  formatSkillPackage,
  hashSkillPackageObject,
} from "../../src/skills/index.mjs";
import { formatSkillDraftEtag } from "../../src/store/index.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const NOW = "2026-07-13T09:00:00.000Z";
const IMAGE = "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";

test("Skill lifecycle application persists exact public records, hides private evidence, and enforces workspace/idempotency", async () => {
  const harness = makeHarness();
  const testRequest = request({
    testCase: {
      name: "echoes approved input",
      purpose: "Confirm the package returns the reviewed object.",
      input: { value: "approved" },
      expectedOutput: { value: "approved" },
      timeoutSeconds: 5,
    },
  });
  const created = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "test-key-1",
    ifMatch: harness.etag,
    request: testRequest,
    auth: harness.owner,
  });
  const replay = await harness.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "test-key-1",
    ifMatch: harness.etag,
    request: testRequest,
    auth: harness.owner,
  });
  assert.deepEqual(replay, created);
  assert.equal(created.status, "passed");
  assertProductSafe(created);
  assert.equal(harness.records.evidence.size, 1);
  assert.equal(harness.records.evidence.get(created.testRunId).networkDenied, true);

  await assert.rejects(
    () => harness.application.createSkillTest({
      skillId: "skill-1",
      draftId: "draft-1",
      idempotencyKey: "test-key-1",
      ifMatch: harness.etag,
      request: request({ testCase: { ...testRequest.data.testCase, purpose: "Different body" } }),
      auth: harness.owner,
    }),
    (error) => error?.code === "idempotency_key_reused",
  );

  const validation = await harness.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "validation-key-1",
    ifMatch: harness.etag,
    request: request({ testRunIds: [created.testRunId], permissionAcknowledged: true }),
    auth: harness.owner,
  });
  assert.equal(validation.status, "passed");
  assertProductSafe(validation);
  assert.equal(harness.records.bindings.size, 1);
  assert.equal(Object.hasOwn(validation, "imageDigest"), false);
  const binding = [...harness.records.bindings.values()][0];
  assert.deepEqual(
    await harness.coordinator.probeExecution({
      workspaceId: "workspace-a",
      executionRef: binding.executionRef,
    }),
    { status: "ready", ready: true, code: "uploaded_skill_ready" },
  );
  assert.deepEqual(
    await harness.coordinator.executePublished({
      workspaceId: "workspace-a",
      executionRef: binding.executionRef,
      input: { value: "published" },
    }),
    { value: "published" },
  );
  assert.deepEqual(
    await harness.coordinator.probeExecution({
      workspaceId: "workspace-b",
      executionRef: binding.executionRef,
    }),
    { status: "blocked", ready: false, code: "uploaded_skill_unavailable" },
  );
  await assert.rejects(
    () => harness.coordinator.executePublished({
      workspaceId: "workspace-b",
      executionRef: binding.executionRef,
      input: { value: "must-not-run" },
    }),
    (error) => error?.code === "uploaded_skill_execution_binding_missing",
  );
  const validationReplay = await harness.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "validation-key-1",
    ifMatch: harness.etag,
    request: request({ testRunIds: [created.testRunId], permissionAcknowledged: true }),
    auth: harness.owner,
  });
  assert.deepEqual(validationReplay, validation);
  await assert.rejects(
    () => harness.application.createSkillValidation({
      skillId: "skill-1",
      draftId: "draft-1",
      idempotencyKey: "validation-key-1",
      ifMatch: harness.etag,
      request: request({ testRunIds: ["different-test-run"], permissionAcknowledged: true }),
      auth: harness.owner,
    }),
    (error) => error?.code === "idempotency_key_reused",
  );

  const loaded = await harness.application.getSkillValidation({
    skillId: "skill-1",
    validationId: validation.validationId,
    auth: harness.owner,
  });
  assert.deepEqual(loaded, validation);
  await assert.rejects(
    () => harness.application.getSkillValidation({
      skillId: "skill-1",
      validationId: validation.validationId,
      auth: { userId: "user-b", activeWorkspaceId: "workspace-b" },
    }),
    (error) => error?.code === "skill_validation_not_found",
  );
});

test("failed and stale tests cannot create an execution binding", async () => {
  const failed = makeHarness();
  const failedRun = await failed.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "failed-test",
    ifMatch: failed.etag,
    request: request({
      testCase: {
        name: "mismatch",
        purpose: "Prove failed output stays failed.",
        input: { value: "actual" },
        expectedOutput: { value: "expected" },
        timeoutSeconds: 5,
      },
    }),
    auth: failed.owner,
  });
  assert.equal(failedRun.status, "failed");
  const failedValidation = await failed.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "failed-validation",
    ifMatch: failed.etag,
    request: request({ testRunIds: [failedRun.testRunId], permissionAcknowledged: true }),
    auth: failed.owner,
  });
  assert.equal(failedValidation.status, "failed");
  assert.equal(failed.records.bindings.size, 0);

  const stale = makeHarness();
  const passedRun = await stale.application.createSkillTest({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "passed-before-change",
    ifMatch: stale.etag,
    request: request({
      testCase: {
        name: "passes",
        purpose: "Create evidence for the original draft.",
        input: { value: "ok" },
        expectedOutput: { value: "ok" },
        timeoutSeconds: 5,
      },
    }),
    auth: stale.owner,
  });
  stale.context.contentHash = `sha256:${"9".repeat(64)}`;
  const staleValidation = await stale.application.createSkillValidation({
    skillId: "skill-1",
    draftId: "draft-1",
    idempotencyKey: "stale-validation",
    ifMatch: stale.etag,
    request: request({ testRunIds: [passedRun.testRunId], permissionAcknowledged: true }),
    auth: stale.owner,
  });
  assert.equal(staleValidation.status, "failed");
  assert.ok(staleValidation.diagnostics.some(({ code }) => code === "skill_test_run_stale"));
  assert.equal(stale.records.bindings.size, 0);
});

function makeHarness() {
  const files = [
    { path: "SKILL.md", content: "---\nname: uploaded-echo\ndescription: Echo a reviewed JSON object.\ndisable-model-invocation: true\n---\n" },
    { path: "scripts/main.py", content: "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n" },
  ];
  const inspection = inspectSkillPackage({ files });
  const bytes = formatSkillPackage(files);
  const objectHash = hashSkillPackageObject(bytes);
  const draft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "draft-1",
    skillId: "skill-1",
    workspaceId: "workspace-a",
    baseVersionId: null,
    revision: 1,
    name: "Uploaded echo",
    description: "Echo a reviewed object.",
    category: "utility",
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: {}, required: [] },
    risk: { level: "low", externalAction: false, summary: "No external action." },
    dependencies: [],
    connectionRequirements: [],
    files: [{ path: "package.skill-package", objectId: "object-1", contentHash: objectHash, mediaType: "application/vnd.looloomi.skill-package+json", sizeBytes: bytes.byteLength }],
    updatedBy: "user-a",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const context = {
    draft,
    uploadId: "upload-1",
    objectId: "object-1",
    objectHash,
    packageHash: inspection.contentHash,
    contentHash: `sha256:${"8".repeat(64)}`,
  };
  const records = {
    tests: new Map(),
    evidence: new Map(),
    validations: new Map(),
    bindings: new Map(),
  };
  const idempotency = new Map();
  let ids = 0;
  const store = {
    async connect() {},
    async authorizeWorkspace({ workspaceId }) {
      if (workspaceId !== "workspace-a") return { workspaceId };
      return { workspaceId };
    },
    async withTransaction(callback) { return callback({ id: "session-1" }); },
    async runIdempotentMutation({ scope, key, request: body, workspaceId }, mutation) {
      const recordKey = `${workspaceId}:${scope}:${key}`;
      const serialized = JSON.stringify(body);
      const existing = idempotency.get(recordKey);
      if (existing) {
        if (existing.serialized !== serialized) throw coded("idempotency_key_reused");
        return structuredClone(existing.response);
      }
      const response = await mutation({ id: "session-1" });
      idempotency.set(recordKey, { serialized, response: structuredClone(response) });
      return response;
    },
    async runIdempotentExternalMutation({ scope, key, request: body, workspaceId, operationIdKind }, mutation) {
      const recordKey = `${workspaceId}:${scope}:${key}`;
      const serialized = JSON.stringify(body);
      const existing = idempotency.get(recordKey);
      if (existing) {
        if (existing.serialized !== serialized) throw coded("idempotency_key_reused");
        return structuredClone(existing.response);
      }
      const response = await mutation(`${operationIdKind}-${idempotency.size + 1}`);
      idempotency.set(recordKey, { serialized, response: structuredClone(response) });
      return response;
    },
    async resolveSkillValidationContext({ workspaceId }) {
      if (workspaceId !== "workspace-a") throw coded("skill_not_found");
      return structuredClone(context);
    },
    repositories: {
      uploads: {
        async get(uploadId, { workspaceId }) {
          if (workspaceId !== "workspace-a" || uploadId !== "upload-1") return null;
          return { uploadId, workspaceId, objectId: "object-1", state: "promoted", inspection };
        },
      },
      skillTestRuns: {
        async insert(record) { records.tests.set(record.testRunId, structuredClone(record)); return record; },
        async get(testRunId, { workspaceId }) {
          const record = records.tests.get(testRunId);
          return record?.workspaceId === workspaceId ? structuredClone(record) : null;
        },
      },
      skillTestEvidence: {
        async insertInternal(record) { records.evidence.set(record.testRunId, structuredClone(record)); return record; },
        async getInternal(testRunId, { workspaceId }) {
          const record = records.evidence.get(testRunId);
          return record?.workspaceId === workspaceId ? structuredClone(record) : null;
        },
      },
      skillValidations: {
        async insert(record) { records.validations.set(record.validationId, structuredClone(record)); return record; },
        async get(validationId, { workspaceId }) {
          const record = records.validations.get(validationId);
          return record?.workspaceId === workspaceId ? structuredClone(record) : null;
        },
      },
      skillExecutionBindings: {
        async insertInternal(record) { records.bindings.set(record.validationId, structuredClone(record)); return record; },
        async getExactInternal(query) {
          return [...records.bindings.values()].find((record) =>
            record.workspaceId === query.workspaceId
            && record.skillId === query.skillId
            && record.skillDraftId === query.skillDraftId
            && record.draftRevision === query.draftRevision
            && record.contentHash === query.contentHash
            && record.packageHash === query.packageHash) ?? null;
        },
        async getByExecutionRefInternal({ workspaceId, executionRef }) {
          return [...records.bindings.values()].find((record) =>
            record.workspaceId === workspaceId
            && JSON.stringify(record.executionRef) === JSON.stringify(executionRef)) ?? null;
        },
      },
    },
  };
  const objectStore = {
    async read({ workspaceId, objectId }) {
      if (workspaceId !== "workspace-a" || objectId !== "object-1") throw coded("object_not_found");
      return { object: { workspaceId, objectId, state: "promoted", contentHash: objectHash }, bytes };
    },
  };
  const coordinator = createSkillValidationCoordinator({
    store,
    objectStore,
    isolatedExecutor: { async execute({ input }) { return structuredClone(input); } },
    imageDigest: IMAGE,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  const application = createWorkbenchApplication({
    store,
    skillValidationService: coordinator,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++ids}`,
  });
  return {
    application,
    coordinator,
    context,
    records,
    owner: { userId: "user-a", activeWorkspaceId: "workspace-a" },
    etag: formatSkillDraftEtag(draft),
  };
}

function request(data) {
  return { schemaVersion: "workbench-api-v1", data };
}

function assertProductSafe(value) {
  const forbidden = new Set([
    "workspaceid", "requestedby", "objectid", "objecthash", "packageobjectid",
    "packagehash", "contenthash", "manifest", "executionref", "imagedigest",
    "provider", "tool", "artifact", "artifactpath",
  ]);
  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      assert.equal(forbidden.has(key.toLowerCase()), false, `forbidden public field ${key}`);
      visit(child);
    }
  };
  visit(value);
}

function coded(code) {
  return Object.assign(new Error(code), { code });
}
