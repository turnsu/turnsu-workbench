import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Check,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { createWorkbenchServer } from "../../src/server.mjs";
import {
  createSkillUploadService,
  createSkillValidationCoordinator,
} from "../../src/skills/index.mjs";
import { createTextResourceService } from "../../src/resources/index.mjs";
import { createFilesystemObjectStore } from "../../src/storage/index.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME = process.env.MONGODB_DB ?? "looloomi_workbench_test";
const DOCKER_IMAGE = "python@sha256:9d3abd9fc11d06998ccdbdd93b4dd49b5ad7d67fcbbc11c016eb0eb2c2194891";

if (!DATABASE_NAME.endsWith("_test")) {
  throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitFor(check, { attempts = 80, delayMs = 25 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("integration_wait_timeout");
}

function meetingActionGraph(skillRef) {
  const text = { type: "string", minLength: 1, maxLength: 20000 };
  const common = (nodeId, title, description, position) => ({
    nodeId,
    title,
    description,
    position,
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 60,
    display: { collapsed: false },
  });
  return {
    graph: {
      nodes: [
        {
          ...common("node-input", "Meeting notes", "Notes used to find explicit follow-up actions.", { x: 0, y: 0 }),
          kind: "Input",
          inputPorts: [],
          outputPorts: [{ portId: "transcript", name: "Meeting notes", schema: text, required: true }],
          inputBindings: [],
          configuration: { fieldIds: ["transcript"] },
        },
        {
          ...common("node-skill", "Extract action items", "Run the published meeting action Skill.", { x: 360, y: 0 }),
          kind: "Skill",
          skillRef,
          inputPorts: [{ portId: "transcript", name: "Meeting notes", schema: text, required: true }],
          outputPorts: [{ portId: "summary", name: "Summary", schema: text, required: true }],
          inputBindings: [{ targetPort: "transcript", source: { kind: "nodeOutput", nodeId: "node-input", portId: "transcript" } }],
          configuration: {},
        },
        {
          ...common("node-review", "Review action summary", "Confirm the action summary before it is shared.", { x: 720, y: 0 }),
          kind: "ReviewGate",
          inputPorts: [{ portId: "candidate", name: "Summary", schema: text, required: true }],
          outputPorts: [{ portId: "approved", name: "Approved summary", schema: text, required: true }],
          inputBindings: [{ targetPort: "candidate", source: { kind: "nodeOutput", nodeId: "node-skill", portId: "summary" } }],
          reviewPolicy: { mode: "required", instructions: "Approve, revise, or reject the action summary." },
          configuration: { instructions: "Review the action summary.", allowRevision: true },
        },
        {
          ...common("node-output", "Action summary", "Present the published action summary.", { x: 1080, y: 0 }),
          kind: "Output",
          inputPorts: [{ portId: "result", name: "Result", schema: text, required: true }],
          outputPorts: [{ portId: "result", name: "Result", schema: text, required: true }],
          inputBindings: [{ targetPort: "result", source: { kind: "nodeOutput", nodeId: "node-review", portId: "approved" } }],
          configuration: { format: "markdown" },
        },
      ],
      edges: [
        { edgeId: "edge-input-skill", sourceNodeId: "node-input", sourcePort: "transcript", targetNodeId: "node-skill", targetPort: "transcript" },
        { edgeId: "edge-skill-review", sourceNodeId: "node-skill", sourcePort: "summary", targetNodeId: "node-review", targetPort: "candidate" },
        { edgeId: "edge-review-output", sourceNodeId: "node-review", sourcePort: "approved", targetNodeId: "node-output", targetPort: "result" },
      ],
    },
    inputForm: {
      fields: [{
        fieldId: "transcript",
        label: "Meeting notes",
        description: "Paste the notes to turn into follow-up actions.",
        schema: text,
        required: true,
      }],
    },
    outputDefinition: {
      primary: { nodeId: "node-output", portId: "result" },
      expectedOutputs: [{ nodeId: "node-output", portId: "result", label: "Action summary", mediaType: "text/markdown" }],
    },
    resourceRefs: [],
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 60 },
  };
}

test(
  "Product HTTP composes durable session tenancy with server-owned Skill and Loop creation",
  { skip: !ENABLED, timeout: 60_000 },
  async (context) => {
    const objectRoot = await mkdtemp(join(tmpdir(), "looloomi-product-http-upload-"));
    const runtimeRoot = await mkdtemp(join(tmpdir(), "looloomi-product-http-runtime-"));
    const store = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME });
    await store.connect();
    await store.dropTestDatabase();
    const objectStore = await createFilesystemObjectStore({ rootDir: objectRoot });
    const skillUploadService = createSkillUploadService({ store, objectStore });
    const skillValidationService = createSkillValidationCoordinator({
      store,
      objectStore,
      isolatedExecutor: { async execute({ input }) { return { summary: input.transcript }; } },
      imageDigest: DOCKER_IMAGE,
    });
    const textResourceService = createTextResourceService({ store, objectStore });
    const composed = createWorkbenchServer({
      store,
      skillUploadService,
      skillValidationService,
      textResourceService,
      bootstrapCatalog: false,
      distDirectory: null,
      env: {
        ...process.env,
        WORKBENCH_TEST_MODE: "1",
        WECHAT_AGENT_TEST_MODE: "1",
        WECHAT_AGENT_RUNTIME_ROOT: runtimeRoot,
        WORKBENCH_TEST_BUSINESS_SKILL: "1",
        PI_OFFLINE: "1",
      },
    });
    context.after(async () => {
      await composed.close();
      await store.dropTestDatabase();
      await store.close();
      await rm(objectRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    });
    await composed.ready;
    const port = await listen(composed.server);
    const origin = `http://127.0.0.1:${port}`;

    async function bootstrapIdentity(userId, workspaceId) {
      const bootstrap = await fetch(`${origin}/api/workbench/v1/workspace`, {
        headers: {
          "X-Workbench-Test-User": userId,
          "X-Workbench-Test-Workspace": workspaceId,
        },
      });
      assert.equal(bootstrap.status, 200);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const body = await bootstrap.json();
      return { cookie, csrf: body.data.session.csrfToken, body };
    }

    const memberA = await bootstrapIdentity("test-user-a", "test-workspace-a");
    const { cookie, csrf } = memberA;

    const activeSession = await fetch(`${origin}/api/workbench/v1/session`, {
      headers: { Cookie: cookie },
    });
    assert.equal(activeSession.status, 200);
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getActiveSession.responseBodySchema, await activeSession.json()),
      true,
    );
    const memberships = await fetch(`${origin}/api/workbench/v1/workspace/memberships`, {
      headers: { Cookie: cookie },
    });
    assert.equal(memberships.status, 200);
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listMemberships.responseBodySchema, await memberships.json()),
      true,
    );

    const unauthenticated = await fetch(`${origin}/api/workbench/v1/skills`);
    assert.equal(unauthenticated.status, 401);

    const mutationHeaders = {
      Cookie: cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": csrf,
      "Idempotency-Key": "http-create-skill-1",
      "Content-Type": "application/json",
    };
    async function validateSkillDraft(skillId, draftId, etag, suffix) {
      const testRun = await fetch(`${origin}/api/workbench/v1/skills/${skillId}/drafts/${draftId}/tests`, {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": `http-skill-test-${suffix}`,
          "If-Match": etag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: {
            testCase: {
              name: `publication test ${suffix}`,
              purpose: "Verify the exact promoted package before publication.",
              input: { transcript: "Alice will send the notes by Friday." },
              expectedOutput: { summary: "Alice will send the notes by Friday." },
              timeoutSeconds: 5,
            },
          },
        }),
      });
      assert.equal(testRun.status, 202, await testRun.clone().text());
      const testRunBody = await testRun.json();
      assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillTest.responseBodySchema, testRunBody), true);
      assert.equal(testRunBody.data.status, "passed");
      assert.equal(Object.hasOwn(testRunBody.data, "imageDigest"), false);

      const validation = await fetch(`${origin}/api/workbench/v1/skills/${skillId}/drafts/${draftId}/validations`, {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": `http-skill-validation-${suffix}`,
          "If-Match": etag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { testRunIds: [testRunBody.data.testRunId], permissionAcknowledged: true },
        }),
      });
      assert.equal(validation.status, 202, await validation.clone().text());
      const validationBody = await validation.json();
      assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillValidation.responseBodySchema, validationBody), true);
      assert.equal(validationBody.data.status, "passed");
      assert.equal(Object.hasOwn(validationBody.data, "imageDigest"), false);
      return { testRun: testRunBody.data, validation: validationBody.data };
    }
    const invited = await fetch(`${origin}/api/workbench/v1/workspace/memberships`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-invite-member-b" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { userId: "test-user-b", displayName: "Member B", role: "member" },
      }),
    });
    assert.equal(invited.status, 201);
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.addMembership.responseBodySchema, await invited.json()), true);
    const memberB = await bootstrapIdentity("test-user-b", "test-workspace-a");
    const memberC = await bootstrapIdentity("test-user-c", "test-workspace-c");
    const memberBMutationHeaders = {
      Cookie: memberB.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": memberB.csrf,
      "Content-Type": "application/json",
    };
    const invitedViewer = await fetch(`${origin}/api/workbench/v1/workspace/memberships`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-invite-viewer-d" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { userId: "test-user-d", displayName: "Viewer D", role: "viewer" },
      }),
    });
    assert.equal(invitedViewer.status, 201);
    const viewerD = await bootstrapIdentity("test-user-d", "test-workspace-a");
    const viewerMutationHeaders = {
      Cookie: viewerD.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": viewerD.csrf,
      "Content-Type": "application/json",
    };
    const rejectedSecretConfiguration = await fetch(`${origin}/api/workbench/v1/connections`, {
      method: "POST",
      headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-create-connection-secret" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          capabilityKey: "calendar-read",
          label: "Team calendar",
          configuration: {
            accountLabel: "Operations calendar",
            permissionSummary: "Read event titles and times.",
            clientSecret: "must-never-be-accepted",
          },
        },
      }),
    });
    assert.equal(rejectedSecretConfiguration.status, 400);
    assert.equal((await store.repositories.connections.list({ workspaceId: "test-workspace-a" })).length, 0);
    const viewerConnectionWrite = await fetch(`${origin}/api/workbench/v1/connections`, {
      method: "POST",
      headers: { ...viewerMutationHeaders, "Idempotency-Key": "http-viewer-create-connection" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          capabilityKey: "calendar-read",
          label: "Viewer calendar",
          configuration: {},
        },
      }),
    });
    assert.equal(viewerConnectionWrite.status, 403);
    assert.equal((await viewerConnectionWrite.json()).code, "workspace_role_forbidden");
    const createdConnection = await fetch(`${origin}/api/workbench/v1/connections`, {
      method: "POST",
      headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-create-connection-calendar" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          capabilityKey: "calendar-read",
          label: "Team calendar",
          configuration: {
            accountLabel: "Operations calendar",
            permissionSummary: "Read event titles and times.",
          },
        },
      }),
    });
    assert.equal(createdConnection.status, 201, await createdConnection.clone().text());
    const createdConnectionBody = await createdConnection.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createConnection.responseBodySchema, createdConnectionBody), true);
    assert.equal(createdConnectionBody.data.status, "needs_setup");
    assert.equal(JSON.stringify(createdConnectionBody).includes("clientSecret"), false);
    assert.equal(JSON.stringify(createdConnectionBody).includes("must-never-be-accepted"), false);
    const createdConnectionEtag = createdConnection.headers.get("etag");
    assert.ok(createdConnectionEtag);
    const validatedConnection = await fetch(
      `${origin}/api/workbench/v1/connections/${createdConnectionBody.data.connectionId}/validate`,
      {
        method: "POST",
        headers: {
          ...memberBMutationHeaders,
          "Idempotency-Key": "http-validate-connection-calendar",
          "If-Match": createdConnectionEtag,
        },
        body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: {} }),
      },
    );
    assert.equal(validatedConnection.status, 200, await validatedConnection.clone().text());
    const validatedConnectionBody = await validatedConnection.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.validateConnection.responseBodySchema, validatedConnectionBody), true);
    assert.equal(validatedConnectionBody.data.status, "connected");
    assert.equal(validatedConnectionBody.data.validation.status, "valid");
    const validatedConnectionEtag = validatedConnection.headers.get("etag");
    assert.ok(validatedConnectionEtag);
    assert.notEqual(validatedConnectionEtag, createdConnectionEtag);
    const staleConnectionUpdate = await fetch(
      `${origin}/api/workbench/v1/connections/${createdConnectionBody.data.connectionId}`,
      {
        method: "PATCH",
        headers: {
          ...memberBMutationHeaders,
          "Idempotency-Key": "http-stale-connection-update",
          "If-Match": createdConnectionEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { label: "Stale calendar name" },
        }),
      },
    );
    assert.equal(staleConnectionUpdate.status, 412);
    assert.equal((await staleConnectionUpdate.json()).code, "connection_revision_conflict");
    const viewerConnectionList = await fetch(`${origin}/api/workbench/v1/connections`, {
      headers: { Cookie: viewerD.cookie },
    });
    assert.equal(viewerConnectionList.status, 200);
    const viewerConnectionListBody = await viewerConnectionList.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listConnections.responseBodySchema, viewerConnectionListBody), true);
    assert.equal(viewerConnectionListBody.data.length, 1);
    const crossWorkspaceConnectionRead = await fetch(
      `${origin}/api/workbench/v1/connections/${createdConnectionBody.data.connectionId}`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspaceConnectionRead.status, 404);
    const createdResource = await fetch(`${origin}/api/workbench/v1/resources`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-create-resource-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { label: "Meeting notes", mediaType: "text/markdown", contentBase64: Buffer.from("# Notes\nAssign an owner.").toString("base64") },
      }),
    });
    assert.equal(createdResource.status, 201);
    const createdResourceBody = await createdResource.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createResource.responseBodySchema, createdResourceBody), true);
    assert.equal(Object.hasOwn(createdResourceBody.data, "objectId"), false);
    const resourceId = createdResourceBody.data.resourceId;
    const listedResources = await fetch(`${origin}/api/workbench/v1/resources`, { headers: { Cookie: cookie } });
    assert.equal(listedResources.status, 200);
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listResources.responseBodySchema, await listedResources.json()), true);
    const loadedResource = await fetch(`${origin}/api/workbench/v1/resources/${resourceId}`, { headers: { Cookie: cookie } });
    assert.equal(loadedResource.status, 200);
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getResource.responseBodySchema, await loadedResource.json()), true);
    const uploadCreated = await fetch(`${origin}/api/workbench/v1/uploads`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-create-upload-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          filename: "meeting-action-extractor.zip",
          sizeBytes: 128,
          mediaType: "application/zip",
        },
      }),
    });
    assert.equal(uploadCreated.status, 201);
    const uploadCreatedBody = await uploadCreated.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createUpload.responseBodySchema, uploadCreatedBody), true);
    const uploadId = uploadCreatedBody.data.uploadId;
    const skillFile = await readFile(
      new URL("../../../../../agent/code/agent-runtime/skills/meeting-action-extractor.md", import.meta.url),
      "utf8",
    );
    const uploadPackage = await fetch(`${origin}/api/workbench/v1/uploads/${uploadId}/package`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-inspect-upload-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { files: [
          { path: "SKILL.md", contentBase64: Buffer.from(skillFile).toString("base64") },
          {
            path: "scripts/main.py",
            contentBase64: Buffer.from(
              "import json, sys\nvalue = json.load(sys.stdin)\nprint(json.dumps({'summary': value['transcript']}))\n",
            ).toString("base64"),
          },
          {
            path: "skill.runtime.json",
            contentBase64: Buffer.from(`${JSON.stringify({
              runtime: "python3.12",
              entrypoint: "scripts/main.py",
              protocol: { stdin: "json", stdout: "json" },
              permissions: {
                network: false,
                connections: [],
                externalActions: false,
                filesystem: "scratch-only",
              },
            })}\n`).toString("base64"),
          },
        ] },
      }),
    });
    assert.equal(uploadPackage.status, 200, await uploadPackage.clone().text());
    const uploadPackageBody = await uploadPackage.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.uploadPackage.responseBodySchema, uploadPackageBody), true);
    assert.equal(uploadPackageBody.data.state, "needs_decision");
    const unacknowledgedPromotion = await fetch(`${origin}/api/workbench/v1/uploads/${uploadId}/promote`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-promote-upload-without-review" },
      body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: {} }),
    });
    assert.equal(unacknowledgedPromotion.status, 409);
    assert.equal((await unacknowledgedPromotion.json()).code, "upload_review_acknowledgement_required");
    const promotedUpload = await fetch(`${origin}/api/workbench/v1/uploads/${uploadId}/promote`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-promote-upload-1" },
      body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { permissionAcknowledged: true } }),
    });
    assert.equal(promotedUpload.status, 200);
    assert.equal((await promotedUpload.json()).data.state, "promoted");
    const createdSkill = await fetch(`${origin}/api/workbench/v1/skills`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          name: "Meeting summary",
          description: "Summarize a reviewed meeting source.",
          category: "meetings",
          uploadId,
        },
      }),
    });
    assert.equal(createdSkill.status, 201);
    const createdSkillBody = await createdSkill.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkill.responseBodySchema, createdSkillBody), true);
    assert.equal(createdSkillBody.data.skill.lifecycle, "draft");
    assert.equal(Object.hasOwn(createdSkillBody.data.draft, "executionRef"), false);
    const loadedSkillDraft = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts/${createdSkillBody.data.draft.skillDraftId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(loadedSkillDraft.status, 200);
    const skillDraftEtag = loadedSkillDraft.headers.get("etag");
    assert.ok(skillDraftEtag);
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraft.responseBodySchema, await loadedSkillDraft.json()),
      true,
    );
    const skillDraftPackagePath = `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts/${createdSkillBody.data.draft.skillDraftId}/package`;
    const loadedSkillDraftPackage = await fetch(skillDraftPackagePath, {
      headers: { Cookie: cookie },
    });
    assert.equal(loadedSkillDraftPackage.status, 200, await loadedSkillDraftPackage.clone().text());
    assert.equal(loadedSkillDraftPackage.headers.get("etag"), skillDraftEtag);
    const loadedSkillDraftPackageBody = await loadedSkillDraftPackage.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraftPackage.responseBodySchema, loadedSkillDraftPackageBody),
      true,
    );
    assert.deepEqual(
      loadedSkillDraftPackageBody.data.files.map((file) => [file.path, file.kind]),
      [["SKILL.md", "instructions"], ["scripts/main.py", "executable"], ["skill.runtime.json", "runtime_manifest"]],
    );
    assert.equal(loadedSkillDraftPackageBody.data.files[0].content, skillFile);
    for (const forbidden of ["workspaceId", "objectId", "contentHash", "executionRef", "provider", "tool", "artifactPath"]) {
      assert.equal(JSON.stringify(loadedSkillDraftPackageBody).includes(`\"${forbidden}\"`), false, forbidden);
    }
    const crossWorkspacePackage = await fetch(skillDraftPackagePath, {
      headers: { Cookie: memberC.cookie },
    });
    assert.equal(crossWorkspacePackage.status, 404);
    const deniedBeforeValidation = await fetch(`${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-skill-without-validation",
        "If-Match": skillDraftEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "0.9.0", releaseNotes: "Must not publish without exact validation." },
      }),
    });
    assert.equal(deniedBeforeValidation.status, 409);
    assert.equal((await deniedBeforeValidation.json()).code, "skill_validation_failed");
    const initialValidation = await validateSkillDraft(
      createdSkillBody.data.skill.skillId,
      createdSkillBody.data.draft.skillDraftId,
      skillDraftEtag,
      "v1",
    );
    const crossWorkspaceValidation = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/validations/${initialValidation.validation.validationId}`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspaceValidation.status, 404);
    const publishedSkill = await fetch(`${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-skill-1",
        "If-Match": skillDraftEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "First trusted meeting action release." },
      }),
    });
    assert.equal(publishedSkill.status, 200);
    const publishedSkillBody = await publishedSkill.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.publishSkill.responseBodySchema, publishedSkillBody), true);
    assert.equal(Object.hasOwn(publishedSkillBody.data.version, "executionRef"), false);
    assert.equal(Object.hasOwn(publishedSkillBody.data.version, "packageHash"), false);
    const internalPublishedVersion = await store.repositories.skillVersions.get(
      publishedSkillBody.data.version.skillVersionId,
      { workspaceId: "test-workspace-a" },
    );
    assert.match(internalPublishedVersion.executionRef.capabilityId, /^uploaded-[a-f0-9]{48}$/);
    assert.equal(publishedSkillBody.data.skill.latestPublishedVersionId, publishedSkillBody.data.version.skillVersionId);
    assert.equal(publishedSkillBody.data.release.assetKind, "skill");
    assert.equal(publishedSkillBody.data.release.versionId, publishedSkillBody.data.version.skillVersionId);
    assert.equal(publishedSkillBody.data.release.version, "1.0.0");
    const editPublishedDraft = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts/${createdSkillBody.data.draft.skillDraftId}`,
      {
        method: "PATCH",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": "http-edit-published-skill-draft",
          "If-Match": skillDraftEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { description: "This must not mutate the source of an immutable published version." },
        }),
      },
    );
    assert.equal(editPublishedDraft.status, 409);
    assert.equal((await editPublishedDraft.json()).code, "skill_draft_not_editable");
    const skillAssets = await fetch(`${origin}/api/workbench/v1/skill-assets`, {
      headers: { Cookie: cookie },
    });
    assert.equal(skillAssets.status, 200);
    const skillAssetsBody = await skillAssets.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillAssets.responseBodySchema, skillAssetsBody), true);
    assert.equal(skillAssetsBody.data.length, 1);
    assert.equal(skillAssetsBody.data[0].skill.skillId, createdSkillBody.data.skill.skillId);
    assert.deepEqual(skillAssetsBody.data[0].skill.allowedActions, ["create_version", "retire"]);
    assert.equal(skillAssetsBody.data[0].latestVersion.skillVersionId, publishedSkillBody.data.version.skillVersionId);
    assert.equal(skillAssetsBody.data[0].draft.fileCount, 1);
    for (const forbidden of [
      "workspaceId",
      "ownerId",
      "updatedBy",
      "files",
      "packageObjectId",
      "packageHash",
      "contentHash",
      "manifest",
      "executionRef",
    ]) {
      assert.equal(JSON.stringify(skillAssetsBody).includes(`\"${forbidden}\"`), false, forbidden);
    }
    const skillReleaseInLibrary = await fetch(`${origin}/api/workbench/v1/team-library`, { headers: { Cookie: cookie } });
    assert.equal(skillReleaseInLibrary.status, 200);
    assert.ok((await skillReleaseInLibrary.json()).data.some((release) => release.releaseId === publishedSkillBody.data.release.releaseId));
    const memberSkillLibrary = await fetch(`${origin}/api/workbench/v1/team-library`, { headers: { Cookie: memberB.cookie } });
    assert.equal(memberSkillLibrary.status, 200);
    assert.ok((await memberSkillLibrary.json()).data.some((release) => release.releaseId === publishedSkillBody.data.release.releaseId));
    const installedSkill = await fetch(
      `${origin}/api/workbench/v1/team-library/${publishedSkillBody.data.release.releaseId}/install`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-install-skill-1" },
        body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { connectionIds: [] } }),
      },
    );
    assert.equal(installedSkill.status, 201);
    const installedSkillBody = await installedSkill.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.installRelease.responseBodySchema, installedSkillBody), true);
    assert.equal(installedSkillBody.data.assetKind, "skill");
    assert.equal(installedSkillBody.data.pinnedVersionId, publishedSkillBody.data.version.skillVersionId);
    const replayedSkillPublish = await fetch(`${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-skill-1",
        "If-Match": skillDraftEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "First trusted meeting action release." },
      }),
    });
    assert.equal(replayedSkillPublish.status, 200);
    assert.equal((await replayedSkillPublish.json()).data.version.skillVersionId, publishedSkillBody.data.version.skillVersionId);
    await assert.rejects(
      () => store.repositories.skillVersions.patch(
        publishedSkillBody.data.version.skillVersionId,
        { name: "Mutated version" },
        { workspaceId: "test-workspace-a" },
      ),
      (error) => error?.code === "immutable_record",
    );

    const definition = {
      goal: "Turn meeting notes into actions.",
      context: "Internal meetings.",
      constraints: ["Do not send messages."],
      doneWhen: ["Each action has an owner."],
      verify: ["A reviewer approves the result."],
      expectedResult: "A reviewed action list.",
      stopRules: ["Stop when source notes are missing."],
    };
    const createdLoop = await fetch(`${origin}/api/workbench/v1/loops`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-create-loop-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { name: "Meeting actions", description: "Turn notes into actions.", definition },
      }),
    });
    assert.equal(createdLoop.status, 201);
    const createdLoopBody = await createdLoop.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoop.responseBodySchema, createdLoopBody), true);

    const workflowId = createdLoopBody.data.workflow.workflowId;
    const workflow = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(workflow.status, 200);
    const workflowBody = await workflow.json();
    assert.equal(Check(WORKBENCH_V1_ENDPOINTS.getWorkflow.responseBodySchema, workflowBody), true);
    const workflowEtag = workflow.headers.get("etag");
    assert.ok(workflowEtag);
    const graph = meetingActionGraph({
      skillId: publishedSkillBody.data.version.skillId,
      version: publishedSkillBody.data.version.version,
    });
    const savedLoop = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/revisions`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-add-published-skill-1", "If-Match": workflowEtag },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          ...graph,
          baseRevisionId: createdLoopBody.data.revision.revisionId,
          definition,
          saveReason: "Add the published meeting action Skill.",
        },
      }),
    });
    assert.equal(savedLoop.status, 201);
    const savedLoopBody = await savedLoop.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.saveLoopRevision.responseBodySchema, savedLoopBody), true);
    const savedWorkflowEtag = savedLoop.headers.get("etag");
    assert.ok(savedWorkflowEtag);
    const copiedLoop = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/duplicate`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-duplicate-loop-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { name: "Meeting actions copy" },
      }),
    });
    assert.equal(copiedLoop.status, 201);
    const copiedLoopBody = await copiedLoop.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.duplicateLoop.responseBodySchema, copiedLoopBody), true);
    assert.deepEqual(copiedLoopBody.data.workflow.sourceWorkflow, {
      workflowId,
      revisionId: savedLoopBody.data.revision.revisionId,
    });
    assert.equal(copiedLoopBody.data.revision.compile.status, "blocked");
    const replayedCopiedLoop = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/duplicate`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-duplicate-loop-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { name: "Meeting actions copy" },
      }),
    });
    assert.equal(replayedCopiedLoop.status, 201);
    assert.equal(
      (await replayedCopiedLoop.json()).data.workflow.workflowId,
      copiedLoopBody.data.workflow.workflowId,
    );
    const prematurePublish = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/publish`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-publish-loop-before-compile", "If-Match": savedWorkflowEtag },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "Must compile first.", startingPoint: true },
      }),
    });
    assert.equal(prematurePublish.status, 409);
    assert.equal((await prematurePublish.json()).code, "loop_compile_required");
    const compiled = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}/compile`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-compile-loop-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { workflowRevisionId: savedLoopBody.data.revision.revisionId },
      }),
    });
    assert.equal(compiled.status, 200);
    assert.equal((await compiled.json()).data.status, "ready");
    const runtimeStatus = composed.piRuntime.status();
    assert.ok(
      runtimeStatus.registeredTools.includes("workflow.uploaded_skill.execute"),
      JSON.stringify(runtimeStatus),
    );
    assert.deepEqual(
      await composed.agentRuntime.probeSkill(
        internalPublishedVersion.executionRef,
        { workspaceId: "test-workspace-a" },
      ),
      { status: "ready", ready: true, code: "uploaded_skill_ready" },
    );
    const publishWithoutTestRun = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-loop-before-test-run",
        "If-Match": savedWorkflowEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "Must complete a test run first.", startingPoint: true },
      }),
    });
    assert.equal(publishWithoutTestRun.status, 409);
    assert.equal((await publishWithoutTestRun.json()).code, "loop_test_run_required");
    const startedRun = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}/runs`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-start-published-skill-run-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          workflowRevisionId: savedLoopBody.data.revision.revisionId,
          inputs: { transcript: "Owner will send the revised brief on Friday." },
          resourceRefs: [],
        },
      }),
    });
    assert.equal(startedRun.status, 202);
    const startedRunBody = await startedRun.json();
    assert.equal(Check(WORKBENCH_V1_ENDPOINTS.startRun.responseBodySchema, startedRunBody), true);
    const runDraft = await fetch(`${origin}/api/workbench/v1/runs/${startedRunBody.data.runId}/draft`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-create-loop-from-run-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { name: "Meeting actions follow-up" },
      }),
    });
    assert.equal(runDraft.status, 201);
    const runDraftBody = await runDraft.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopDraftFromRun.responseBodySchema, runDraftBody), true);
    assert.deepEqual(runDraftBody.data.workflow.sourceWorkflow, {
      workflowId,
      revisionId: savedLoopBody.data.revision.revisionId,
    });
    assert.equal(runDraftBody.data.revision.compile.status, "blocked");
    const waitingRunBody = await waitFor(async () => {
      const detail = await fetch(`${origin}/api/workbench/v1/runs/${startedRunBody.data.runId}`, { headers: { Cookie: cookie } });
      if (detail.status !== 200) return null;
      const body = await detail.json();
      if (["failed", "cancelled"].includes(body.data.run.status)) {
        const internal = await store.repositories.runs.getInternal(startedRunBody.data.runId);
        throw new Error(`initial_run_terminated:${JSON.stringify({
          failure: body.data.readModel.failure,
          workspaceId: internal?.workspaceId,
          skillVersions: internal?.executionSnapshot?.skillVersions,
        })}`);
      }
      return body.data.run.status === "waiting_review" && body.data.readModel.reviewPacket ? body : null;
    });
    assert.equal(waitingRunBody.data.readModel.reviewPacket.nodeId, "node-review");
    const cancelledRun = await fetch(`${origin}/api/workbench/v1/runs/${startedRunBody.data.runId}/cancel`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-cancel-published-skill-run-1" },
      body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { reason: "Exercise the cancel path." } }),
    });
    assert.equal(cancelledRun.status, 202);
    assert.equal((await cancelledRun.json()).data, startedRunBody.data.runId);
    await waitFor(async () => {
      const detail = await fetch(`${origin}/api/workbench/v1/runs/${startedRunBody.data.runId}`, { headers: { Cookie: cookie } });
      return detail.ok && (await detail.json()).data.run.status === "cancelled";
    });
    const retriedRun = await fetch(`${origin}/api/workbench/v1/runs/${startedRunBody.data.runId}/retry`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-retry-published-skill-run-1" },
      body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { reason: "Exercise the snapshot retry path." } }),
    });
    assert.equal(retriedRun.status, 202);
    const retriedRunId = (await retriedRun.json()).data;
    assert.notEqual(retriedRunId, startedRunBody.data.runId);
    let retryDetail = null;
    try {
      await waitFor(async () => {
        const detail = await fetch(`${origin}/api/workbench/v1/runs/${retriedRunId}`, { headers: { Cookie: cookie } });
        if (!detail.ok) {
          retryDetail = { status: detail.status, body: await detail.text() };
          return false;
        }
        const body = await detail.json();
        retryDetail = body.data;
        if (["failed", "cancelled"].includes(body.data.run.status)) {
          throw new Error(`retried_run_terminated:${JSON.stringify(body.data.readModel.failure)}`);
        }
        return body.data.run.status === "waiting_review" && Boolean(body.data.readModel.reviewPacket);
      }, { attempts: 400 });
    } catch (error) {
      throw new Error(`snapshot_retry_wait_failed:${JSON.stringify(retryDetail)}:${error.message}`);
    }
    const approvedRun = await fetch(`${origin}/api/workbench/v1/runs/${retriedRunId}/review-decisions`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-approve-retried-run-1" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { nodeId: "node-review", decision: "approve", requestedChanges: [] },
      }),
    });
    assert.equal(approvedRun.status, 200);
    const completedRunBody = await waitFor(async () => {
      const detail = await fetch(`${origin}/api/workbench/v1/runs/${retriedRunId}`, { headers: { Cookie: cookie } });
      if (detail.status !== 200) return null;
      const body = await detail.json();
      return body.data.run.status === "completed" ? body : null;
    });
    assert.equal(Check(WORKBENCH_V1_ENDPOINTS.getRun.responseBodySchema, completedRunBody), true);
    assert.equal(completedRunBody.data.run.retryOf, startedRunBody.data.runId);
    assert.equal(completedRunBody.data.readModel.finalAnswer.content, "Owner will send the revised brief on Friday.");
    assert.equal(completedRunBody.data.run.authoritativeReadModel.available, true);
    assert.equal(Object.hasOwn(completedRunBody.data.run, "executionSnapshot"), false);
    const internalRun = await store.repositories.runs.getInternal(retriedRunId);
    assert.equal(internalRun.executionSnapshot.skillVersions.length, 1);
    assert.equal(
      internalRun.executionSnapshot.skillVersions[0].packageHash,
      internalPublishedVersion.packageHash,
    );
    assert.deepEqual(
      (await store.repositories.runCommands.list({ workspaceId: "test-workspace-a" })).map((entry) => entry.command).sort(),
      ["cancel", "retry"],
    );
    const published = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/publish`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-publish-loop-1", "If-Match": savedWorkflowEtag },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "Initial meeting action workflow.", startingPoint: true },
      }),
    });
    assert.equal(published.status, 200);
    const publishedBody = await published.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.publishLoop.responseBodySchema, publishedBody), true);
    assert.equal(publishedBody.data.release.version, "1.0.0");
    const teamLibrary = await fetch(`${origin}/api/workbench/v1/team-library`, { headers: { Cookie: cookie } });
    assert.equal(teamLibrary.status, 200);
    const teamLibraryBody = await teamLibrary.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listTeamLibrary.responseBodySchema, teamLibraryBody), true);
    assert.ok(teamLibraryBody.data.some((release) => release.releaseId === publishedBody.data.release.releaseId));
    const installed = await fetch(
      `${origin}/api/workbench/v1/team-library/${publishedBody.data.release.releaseId}/install`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-install-loop-1" },
        body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { connectionIds: [] } }),
      },
    );
    assert.equal(installed.status, 201);
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.installRelease.responseBodySchema, await installed.json()), true);
    const startingPoint = await fetch(
      `${origin}/api/workbench/v1/team-library/${publishedBody.data.release.releaseId}/starting-point`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-start-from-loop-release-1" },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { name: "Member B meeting actions" },
        }),
      },
    );
    assert.equal(startingPoint.status, 201);
    const startingPointBody = await startingPoint.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.useReleaseAsStartingPoint.responseBodySchema, startingPointBody), true);
    assert.notEqual(startingPointBody.data.workflow.workflowId, workflowId);
    assert.equal(startingPointBody.data.workflow.lifecycle, "draft");
    assert.equal(startingPointBody.data.revision.definition.goal, definition.goal);

    const sharedWorkflow = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(sharedWorkflow.status, 200);
    const sharedWorkflowEtag = sharedWorkflow.headers.get("etag");
    assert.ok(sharedWorkflowEtag);
    const forkablePublish = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-forkable-loop-1",
        "If-Match": sharedWorkflowEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.1", releaseNotes: "Forkable team Loop.", startingPoint: false },
      }),
    });
    assert.equal(forkablePublish.status, 200);
    const forkablePublishBody = await forkablePublish.json();
    assert.equal(forkablePublishBody.data.release.startingPoint, false);

    const forkRequest = JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: { name: "Member B independent meeting actions" },
    });
    const forked = await fetch(
      `${origin}/api/workbench/v1/team-library/${forkablePublishBody.data.release.releaseId}/fork`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-fork-loop-release-1" },
        body: forkRequest,
      },
    );
    assert.equal(forked.status, 201);
    const forkedBody = await forked.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.forkTeamLibraryLoop.responseBodySchema, forkedBody), true);
    assert.notEqual(forkedBody.data.workflow.workflowId, workflowId);
    assert.equal(forkedBody.data.workflow.ownerId, "test-user-b");
    assert.equal(forkedBody.data.workflow.visibility, "private");
    assert.equal(forkedBody.data.workflow.lifecycle, "draft");
    assert.equal(forkedBody.data.workflow.status, "draft");
    assert.deepEqual(forkedBody.data.workflow.sourceWorkflow, {
      workflowId,
      revisionId: savedLoopBody.data.revision.revisionId,
    });
    assert.deepEqual(forkedBody.data.workflow.sourceRelease, {
      releaseId: forkablePublishBody.data.release.releaseId,
      sourceWorkspaceId: "test-workspace-a",
      versionId: forkablePublishBody.data.loopVersion.loopVersionId,
      forkedAt: forkedBody.data.workflow.createdAt,
    });
    assert.equal(Object.hasOwn(forkedBody.data.workflow, "latestCompile"), false);
    assert.equal(Object.hasOwn(forkedBody.data.workflow, "latestRun"), false);
    assert.equal(forkedBody.data.revision.revisionNumber, 1);
    assert.equal(forkedBody.data.revision.baseRevisionId, null);
    assert.deepEqual(forkedBody.data.revision.graph, savedLoopBody.data.revision.graph);
    assert.deepEqual(forkedBody.data.revision.definition, savedLoopBody.data.revision.definition);
    assert.deepEqual(forkedBody.data.revision.compile, { status: "blocked", diagnostics: [] });
    const replayedFork = await fetch(
      `${origin}/api/workbench/v1/team-library/${forkablePublishBody.data.release.releaseId}/fork`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-fork-loop-release-1" },
        body: forkRequest,
      },
    );
    assert.equal(replayedFork.status, 201);
    assert.equal((await replayedFork.json()).data.workflow.workflowId, forkedBody.data.workflow.workflowId);

    const unavailableStartingPoint = await fetch(
      `${origin}/api/workbench/v1/team-library/${forkablePublishBody.data.release.releaseId}/starting-point`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-reject-forkable-starting-point" },
        body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { name: "Not a starting point" } }),
      },
    );
    assert.equal(unavailableStartingPoint.status, 404);
    assert.equal((await unavailableStartingPoint.json()).code, "release_not_available");

    const rejectedForks = [
      {
        releaseId: publishedSkillBody.data.release.releaseId,
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-reject-skill-fork" },
      },
      {
        releaseId: forkablePublishBody.data.release.releaseId,
        headers: {
          Cookie: memberC.cookie,
          Origin: origin,
          "Sec-Fetch-Site": "same-origin",
          "X-Workbench-CSRF": memberC.csrf,
          "Idempotency-Key": "http-reject-cross-workspace-fork",
          "Content-Type": "application/json",
        },
      },
      {
        releaseId: "release-not-available",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-reject-missing-release-fork" },
      },
    ];
    for (const rejectedFork of rejectedForks) {
      const response = await fetch(
        `${origin}/api/workbench/v1/team-library/${rejectedFork.releaseId}/fork`,
        { method: "POST", headers: rejectedFork.headers, body: forkRequest },
      );
      assert.equal(response.status, 404, rejectedFork.releaseId);
      assert.equal((await response.json()).code, "release_not_available", rejectedFork.releaseId);
    }
    const auditActions = (await store.repositories.auditEvents.list({ limit: 20 })).map((event) => event.action);
    assert.ok(auditActions.includes("workspace.membership_added"));
    assert.ok(auditActions.includes("skill.published"));
    assert.ok(auditActions.includes("loop.published"));
    assert.ok(auditActions.includes("team_library.installed"));
    assert.ok(auditActions.includes("team_library.starting_point_created"));
    assert.ok(auditActions.includes("team_library.loop_forked"));

    const crossWorkspace = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}`, {
      headers: { Cookie: memberC.cookie },
    });
    assert.equal(crossWorkspace.status, 404);
    assert.equal((await crossWorkspace.json()).code, "workflow_not_found");
    const memberLibrary = await fetch(`${origin}/api/workbench/v1/team-library`, {
      headers: { Cookie: memberB.cookie },
    });
    assert.equal(memberLibrary.status, 200);
    assert.ok((await memberLibrary.json()).data.some((release) => release.releaseId === publishedBody.data.release.releaseId));
    const otherLibrary = await fetch(`${origin}/api/workbench/v1/team-library`, {
      headers: { Cookie: memberC.cookie },
    });
    assert.equal(otherLibrary.status, 200);
    assert.deepEqual((await otherLibrary.json()).data, []);

    const nextSkillDraft = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts`,
      {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": "http-create-skill-v2-draft",
          "If-Match": skillDraftEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { baseVersionId: publishedSkillBody.data.version.skillVersionId },
        }),
      },
    );
    assert.equal(nextSkillDraft.status, 201);
    const nextSkillDraftBody = await nextSkillDraft.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createNextSkillDraft.responseBodySchema, nextSkillDraftBody), true);
    assert.equal(nextSkillDraftBody.data.baseVersionId, publishedSkillBody.data.version.skillVersionId);
    const nextSkillDraftEtag = nextSkillDraft.headers.get("etag");
    assert.ok(nextSkillDraftEtag);
    const nextPackagePath = `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts/${nextSkillDraftBody.data.skillDraftId}/package`;
    const replacePackageRequest = {
      schemaVersion: "workbench-api-v1",
      data: { uploadId },
    };
    const replacedSkillPackage = await fetch(nextPackagePath, {
      method: "PUT",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-replace-skill-v2-package",
        "If-Match": nextSkillDraftEtag,
      },
      body: JSON.stringify(replacePackageRequest),
    });
    assert.equal(replacedSkillPackage.status, 200, await replacedSkillPackage.clone().text());
    const replacedSkillPackageBody = await replacedSkillPackage.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.replaceSkillDraftPackage.responseBodySchema, replacedSkillPackageBody),
      true,
    );
    assert.equal(replacedSkillPackageBody.data.revision, nextSkillDraftBody.data.revision + 1);
    assert.equal(Object.hasOwn(replacedSkillPackageBody.data, "executionRef"), false);
    const replacedSkillPackageEtag = replacedSkillPackage.headers.get("etag");
    assert.ok(replacedSkillPackageEtag);
    const replayedSkillPackage = await fetch(nextPackagePath, {
      method: "PUT",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-replace-skill-v2-package",
        "If-Match": nextSkillDraftEtag,
      },
      body: JSON.stringify(replacePackageRequest),
    });
    assert.equal(replayedSkillPackage.status, 200);
    assert.deepEqual((await replayedSkillPackage.json()).data, replacedSkillPackageBody.data);
    const staleSkillPackage = await fetch(nextPackagePath, {
      method: "PUT",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-replace-skill-v2-package-stale",
        "If-Match": nextSkillDraftEtag,
      },
      body: JSON.stringify(replacePackageRequest),
    });
    assert.equal(staleSkillPackage.status, 412);
    assert.equal((await staleSkillPackage.json()).code, "skill_draft_conflict");
    const editedSkillDraft = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/drafts/${nextSkillDraftBody.data.skillDraftId}`,
      {
        method: "PATCH",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": "http-edit-skill-v2-draft",
          "If-Match": replacedSkillPackageEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { description: "Summarize a reviewed meeting source with clearer owners and dates." },
        }),
      },
    );
    assert.equal(editedSkillDraft.status, 200);
    const editedSkillDraftBody = await editedSkillDraft.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.updateSkillDraft.responseBodySchema, editedSkillDraftBody), true);
    assert.match(editedSkillDraftBody.data.description, /clearer owners/);
    const editedSkillDraftEtag = editedSkillDraft.headers.get("etag");
    assert.ok(editedSkillDraftEtag);
    await validateSkillDraft(
      createdSkillBody.data.skill.skillId,
      nextSkillDraftBody.data.skillDraftId,
      editedSkillDraftEtag,
      "v2",
    );
    const publishedSkillV2 = await fetch(`${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-skill-v2",
        "If-Match": editedSkillDraftEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "2.0.0", releaseNotes: "Clarified the meeting action output." },
      }),
    });
    assert.equal(publishedSkillV2.status, 200, await publishedSkillV2.clone().text());
    const publishedSkillV2Body = await publishedSkillV2.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.publishSkill.responseBodySchema, publishedSkillV2Body), true);
    assert.equal(publishedSkillV2Body.data.version.version, "2.0.0");
    const immutableSkillV1AfterV2 = await store.repositories.skillVersions.get(
      publishedSkillBody.data.version.skillVersionId,
      { workspaceId: "test-workspace-a" },
    );
    assert.equal(immutableSkillV1AfterV2.version, "1.0.0");
    assert.equal(
      immutableSkillV1AfterV2.skillVersionId,
      publishedSkillBody.data.version.skillVersionId,
    );
    const skillVersionHistory = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/versions`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(skillVersionHistory.status, 200);
    const skillVersionHistoryBody = await skillVersionHistory.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillVersions.responseBodySchema, skillVersionHistoryBody),
      true,
    );
    assert.deepEqual(
      skillVersionHistoryBody.data.map((version) => version.version),
      ["2.0.0", "1.0.0"],
    );
    for (const version of skillVersionHistoryBody.data) {
      for (const forbidden of [
        "workspaceId",
        "packageObjectId",
        "packageHash",
        "contentHash",
        "manifest",
        "inputSchema",
        "outputSchema",
        "executionRef",
      ]) {
        assert.equal(Object.hasOwn(version, forbidden), false, forbidden);
      }
    }
    const crossWorkspaceSkillVersionHistory = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/versions`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspaceSkillVersionHistory.status, 404);
    assert.equal((await crossWorkspaceSkillVersionHistory.json()).code, "skill_not_found");
    const skillVersionDiff = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/versions/${publishedSkillBody.data.version.skillVersionId}/diff/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(skillVersionDiff.status, 200);
    const skillVersionDiffBody = await skillVersionDiff.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillVersionDiff.responseBodySchema, skillVersionDiffBody), true);
    assert.equal(skillVersionDiffBody.data.fromVersion, "1.0.0");
    assert.equal(skillVersionDiffBody.data.toVersion, "2.0.0");
    assert.equal(skillVersionDiffBody.data.entries.find((entry) => entry.field === "purpose").changed, true);
    assert.equal(JSON.stringify(skillVersionDiffBody).includes("executionRef"), false);
    const crossWorkspaceSkillVersionDiff = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/versions/${publishedSkillBody.data.version.skillVersionId}/diff/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspaceSkillVersionDiff.status, 404);
    assert.equal((await crossWorkspaceSkillVersionDiff.json()).code, "skill_not_found");
    const installedSkillBeforeAdoption = await fetch(
      `${origin}/api/workbench/v1/installations/${installedSkillBody.data.installationId}`,
      { headers: { Cookie: memberB.cookie } },
    );
    assert.equal(installedSkillBeforeAdoption.status, 200);
    assert.equal((await installedSkillBeforeAdoption.json()).data.pinnedVersionId, publishedSkillBody.data.version.skillVersionId);
    const adoptedSkillRelease = await fetch(
      `${origin}/api/workbench/v1/installations/${installedSkillBody.data.installationId}/adopt-release`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-adopt-skill-v2" },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { releaseId: publishedSkillV2Body.data.release.releaseId },
        }),
      },
    );
    assert.equal(adoptedSkillRelease.status, 200);
    const adoptedSkillReleaseBody = await adoptedSkillRelease.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.adoptInstallationRelease.responseBodySchema, adoptedSkillReleaseBody), true);
    assert.equal(adoptedSkillReleaseBody.data.pinnedVersionId, publishedSkillV2Body.data.version.skillVersionId);
    const skillUsage = await fetch(`${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/usage`, {
      headers: { Cookie: cookie },
    });
    assert.equal(skillUsage.status, 200);
    const skillUsageBody = await skillUsage.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillUsage.responseBodySchema, skillUsageBody), true);
    assert.equal(skillUsageBody.data.latestVersion, "2.0.0");
    assert.ok(skillUsageBody.data.affectedWorkflows.some((entry) => entry.workflowId === workflowId));
    const crossWorkspaceSkillUsage = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/usage`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspaceSkillUsage.status, 404);
    assert.equal((await crossWorkspaceSkillUsage.json()).code, "skill_not_found");
    const currentWorkflowForUpdate = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(currentWorkflowForUpdate.status, 200);
    const currentWorkflowBeforePreview = await currentWorkflowForUpdate.clone().json();
    const currentWorkflowEtag = currentWorkflowForUpdate.headers.get("etag");
    assert.ok(currentWorkflowEtag);
    const loopSkillUpdatePreview = await fetch(
      `${origin}/api/workbench/v1/loops/${workflowId}/skill-updates/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(loopSkillUpdatePreview.status, 200);
    assert.equal(loopSkillUpdatePreview.headers.get("etag"), currentWorkflowEtag);
    const loopSkillUpdatePreviewBody = await loopSkillUpdatePreview.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopSkillUpdatePreview.responseBodySchema, loopSkillUpdatePreviewBody),
      true,
    );
    assert.equal(loopSkillUpdatePreviewBody.data.currentVersion.version, "1.0.0");
    assert.equal(loopSkillUpdatePreviewBody.data.targetVersion.version, "2.0.0");
    assert.deepEqual(loopSkillUpdatePreviewBody.data.affectedNodes, [{ nodeId: "node-skill", title: "Extract action items" }]);
    assert.equal(JSON.stringify(loopSkillUpdatePreviewBody).includes("packageHash"), false);
    const workflowAfterPreview = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(workflowAfterPreview.status, 200);
    assert.equal((await workflowAfterPreview.json()).data.currentRevisionId, currentWorkflowBeforePreview.data.currentRevisionId);
    const nonOwnerPreview = await fetch(
      `${origin}/api/workbench/v1/loops/${workflowId}/skill-updates/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: memberB.cookie } },
    );
    assert.equal(nonOwnerPreview.status, 403);
    assert.equal((await nonOwnerPreview.json()).code, "loop_owner_required");
    const crossWorkspacePreview = await fetch(
      `${origin}/api/workbench/v1/loops/${workflowId}/skill-updates/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: memberC.cookie } },
    );
    assert.equal(crossWorkspacePreview.status, 404);
    assert.equal((await crossWorkspacePreview.json()).code, "workflow_not_found");

    const memberBWorkflow = await fetch(
      `${origin}/api/workbench/v1/workflows/${forkedBody.data.workflow.workflowId}`,
      { headers: { Cookie: memberB.cookie } },
    );
    assert.equal(memberBWorkflow.status, 200);
    const memberBWorkflowEtag = memberBWorkflow.headers.get("etag");
    assert.ok(memberBWorkflowEtag);
    const memberBUpdatePreview = await fetch(
      `${origin}/api/workbench/v1/loops/${forkedBody.data.workflow.workflowId}/skill-updates/${publishedSkillV2Body.data.version.skillVersionId}`,
      { headers: { Cookie: memberB.cookie } },
    );
    assert.equal(memberBUpdatePreview.status, 200, await memberBUpdatePreview.clone().text());
    const memberBUpdatePreviewBody = await memberBUpdatePreview.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopSkillUpdatePreview.responseBodySchema, memberBUpdatePreviewBody),
      true,
    );
    assert.equal(memberBUpdatePreviewBody.data.currentVersion.version, "1.0.0");
    assert.equal(memberBUpdatePreviewBody.data.targetVersion.version, "2.0.0");
    const memberBUpdatedLoop = await fetch(
      `${origin}/api/workbench/v1/loops/${forkedBody.data.workflow.workflowId}/skill-updates`,
      {
        method: "POST",
        headers: {
          ...memberBMutationHeaders,
          "Idempotency-Key": "http-member-b-update-loop-skill-v2",
          "If-Match": memberBWorkflowEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: {
            skillId: createdSkillBody.data.skill.skillId,
            fromVersion: "1.0.0",
            toVersion: "2.0.0",
          },
        }),
      },
    );
    assert.equal(memberBUpdatedLoop.status, 201, await memberBUpdatedLoop.clone().text());
    const memberBUpdatedLoopBody = await memberBUpdatedLoop.json();
    assert.equal(
      Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopSkillUpdate.responseBodySchema, memberBUpdatedLoopBody),
      true,
    );
    assert.equal(memberBUpdatedLoopBody.data.revision.baseRevisionId, forkedBody.data.revision.revisionId);
    assert.equal(
      forkedBody.data.revision.graph.nodes.find((node) => node.nodeId === "node-skill").skillRef.version,
      "1.0.0",
    );
    assert.equal(
      memberBUpdatedLoopBody.data.revision.graph.nodes.find((node) => node.nodeId === "node-skill").skillRef.version,
      "2.0.0",
    );
    const updatedLoop = await fetch(`${origin}/api/workbench/v1/loops/${workflowId}/skill-updates`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-update-loop-skill-v2",
        "If-Match": currentWorkflowEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          skillId: createdSkillBody.data.skill.skillId,
          fromVersion: "1.0.0",
          toVersion: "2.0.0",
        },
      }),
    });
    assert.equal(updatedLoop.status, 201);
    const updatedLoopBody = await updatedLoop.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopSkillUpdate.responseBodySchema, updatedLoopBody), true);
    assert.equal(
      updatedLoopBody.data.revision.graph.nodes.find((node) => node.nodeId === "node-skill").skillRef.version,
      "2.0.0",
    );
    const compiledV2 = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}/compile`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-compile-loop-skill-v2" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { workflowRevisionId: updatedLoopBody.data.revision.revisionId },
      }),
    });
    assert.equal(compiledV2.status, 200);
    const compiledV2Body = await compiledV2.json();
    assert.equal(Check(WORKBENCH_V1_ENDPOINTS.compileWorkflow.responseBodySchema, compiledV2Body), true);
    assert.equal(compiledV2Body.data.status, "ready");
    const startedV2 = await fetch(`${origin}/api/workbench/v1/workflows/${workflowId}/runs`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-start-loop-skill-v2" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          workflowRevisionId: updatedLoopBody.data.revision.revisionId,
          inputs: { transcript: "Owner will send the revised brief on Friday." },
          resourceRefs: [],
        },
      }),
    });
    assert.equal(startedV2.status, 202);
    const startedV2Body = await startedV2.json();
    const waitingV2Body = await waitFor(async () => {
      const detail = await fetch(`${origin}/api/workbench/v1/runs/${startedV2Body.data.runId}`, { headers: { Cookie: cookie } });
      if (detail.status !== 200) return null;
      const body = await detail.json();
      return body.data.run.status === "waiting_review" && body.data.readModel.reviewPacket ? body : null;
    });
    const approvedV2 = await fetch(`${origin}/api/workbench/v1/runs/${startedV2Body.data.runId}/review-decisions`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-approve-loop-skill-v2" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { nodeId: waitingV2Body.data.readModel.reviewPacket.nodeId, decision: "approve", requestedChanges: [] },
      }),
    });
    assert.equal(approvedV2.status, 200);
    const completedV2Body = await waitFor(async () => {
      const detail = await fetch(`${origin}/api/workbench/v1/runs/${startedV2Body.data.runId}`, { headers: { Cookie: cookie } });
      if (detail.status !== 200) return null;
      const body = await detail.json();
      return body.data.run.status === "completed" ? body : null;
    });
    assert.equal(Check(WORKBENCH_V1_ENDPOINTS.getRun.responseBodySchema, completedV2Body), true);
    assert.equal(completedV2Body.data.run.workflowRevisionId, updatedLoopBody.data.revision.revisionId);
    assert.equal(completedV2Body.data.readModel.finalAnswer.content, completedRunBody.data.readModel.finalAnswer.content);
    assert.equal((await store.repositories.runs.getInternal(startedV2Body.data.runId)).executionSnapshot.skillVersions[0].version, "2.0.0");
    const runComparison = await fetch(
      `${origin}/api/workbench/v1/runs/${startedV2Body.data.runId}/comparison/${retriedRunId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(runComparison.status, 200);
    const runComparisonBody = await runComparison.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getRunComparison.responseBodySchema, runComparisonBody), true);
    assert.deepEqual(runComparisonBody.data.left.skillVersions, ["2.0.0"]);
    assert.deepEqual(runComparisonBody.data.right.skillVersions, ["1.0.0"]);
    assert.equal(runComparisonBody.data.workflowRevisionChanged, true);
    assert.equal(runComparisonBody.data.skillVersionsChanged, true);
    assert.equal(runComparisonBody.data.finalAnswerChanged, false);
    assert.equal(JSON.stringify(runComparisonBody).includes("executionSnapshot"), false);
    assert.equal(JSON.stringify(runComparisonBody).includes("executionRef"), false);
    assert.equal(
      (await store.repositories.runs.getInternal(retriedRunId)).executionSnapshot.skillVersions[0].version,
      "1.0.0",
    );
    const deprecatedSkill = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/deprecate`,
      {
        method: "POST",
        headers: { ...mutationHeaders, "Idempotency-Key": "http-deprecate-skill-v2" },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { reason: "A newer version is available for future workflows." },
        }),
      },
    );
    assert.equal(deprecatedSkill.status, 200, await deprecatedSkill.clone().text());
    const deprecatedSkillBody = await deprecatedSkill.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.deprecateSkill.responseBodySchema, deprecatedSkillBody), true);
    assert.equal(deprecatedSkillBody.data.lifecycle, "deprecated");
    assert.equal(deprecatedSkillBody.data.retirement.reason, "A newer version is available for future workflows.");
    const replayedDeprecation = await fetch(
      `${origin}/api/workbench/v1/skills/${createdSkillBody.data.skill.skillId}/deprecate`,
      {
        method: "POST",
        headers: { ...mutationHeaders, "Idempotency-Key": "http-deprecate-skill-v2" },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: { reason: "A newer version is available for future workflows." },
        }),
      },
    );
    assert.equal(replayedDeprecation.status, 200);
    assert.equal((await replayedDeprecation.json()).data.updatedAt, deprecatedSkillBody.data.updatedAt);
    const updateToRetiredSkill = await fetch(
      `${origin}/api/workbench/v1/loops/${workflowId}/skill-updates`,
      {
        method: "POST",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": "http-update-loop-to-retired-skill",
          "If-Match": updatedLoop.headers.get("etag") || currentWorkflowEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: {
            skillId: createdSkillBody.data.skill.skillId,
            fromVersion: "2.0.0",
            toVersion: "1.0.0",
          },
        }),
      },
    );
    assert.equal(updateToRetiredSkill.status, 409);
    assert.equal((await updateToRetiredSkill.json()).code, "skill_not_available_for_new_workflow");

    const connectionSkillCreate = await fetch(`${origin}/api/workbench/v1/skills`, {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "http-create-connection-skill" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          name: "Calendar briefing",
          description: "Prepare a briefing from a connected team calendar.",
          category: "meetings",
          uploadId,
        },
      }),
    });
    assert.equal(connectionSkillCreate.status, 201, await connectionSkillCreate.clone().text());
    const connectionSkillCreateBody = await connectionSkillCreate.json();
    const connectionSkillId = connectionSkillCreateBody.data.skill.skillId;
    const connectionSkillDraftId = connectionSkillCreateBody.data.draft.skillDraftId;
    const connectionSkillDraftRead = await fetch(
      `${origin}/api/workbench/v1/skills/${connectionSkillId}/drafts/${connectionSkillDraftId}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(connectionSkillDraftRead.status, 200);
    const connectionSkillDraftEtag = connectionSkillDraftRead.headers.get("etag");
    assert.ok(connectionSkillDraftEtag);
    const connectionSkillUpdate = await fetch(
      `${origin}/api/workbench/v1/skills/${connectionSkillId}/drafts/${connectionSkillDraftId}`,
      {
        method: "PATCH",
        headers: {
          ...mutationHeaders,
          "Idempotency-Key": "http-add-connection-requirement",
          "If-Match": connectionSkillDraftEtag,
        },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: {
            connectionRequirements: [{
              requirementId: "calendar-read",
              label: "Calendar access",
              required: true,
              permissionSummary: "Read event titles and times.",
            }],
          },
        }),
      },
    );
    assert.equal(connectionSkillUpdate.status, 200, await connectionSkillUpdate.clone().text());
    const connectionSkillUpdatedEtag = connectionSkillUpdate.headers.get("etag");
    assert.ok(connectionSkillUpdatedEtag);
    const connectionSkillValidation = await validateSkillDraft(
      connectionSkillId,
      connectionSkillDraftId,
      connectionSkillUpdatedEtag,
      "connection-v1",
    );
    assert.equal(connectionSkillValidation.validation.status, "passed");
    const connectionSkillPublish = await fetch(`${origin}/api/workbench/v1/skills/${connectionSkillId}/publish`, {
      method: "POST",
      headers: {
        ...mutationHeaders,
        "Idempotency-Key": "http-publish-connection-skill",
        "If-Match": connectionSkillUpdatedEtag,
      },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { version: "1.0.0", releaseNotes: "Requires local calendar access." },
      }),
    });
    assert.equal(connectionSkillPublish.status, 200, await connectionSkillPublish.clone().text());
    const connectionSkillPublishBody = await connectionSkillPublish.json();
    const connectionReleaseId = connectionSkillPublishBody.data.release.releaseId;
    const missingRebind = await fetch(`${origin}/api/workbench/v1/team-library/${connectionReleaseId}/install`, {
      method: "POST",
      headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-install-connection-skill-missing" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { connectionIds: [], connectionBindings: [] },
      }),
    });
    assert.equal(missingRebind.status, 409);
    assert.equal((await missingRebind.json()).code, "connection_rebind_required");
    const memberCMutationHeaders = {
      Cookie: memberC.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": memberC.csrf,
      "Content-Type": "application/json",
    };
    const foreignConnection = await fetch(`${origin}/api/workbench/v1/connections`, {
      method: "POST",
      headers: { ...memberCMutationHeaders, "Idempotency-Key": "http-create-foreign-connection" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          capabilityKey: "calendar-read",
          label: "Foreign calendar",
          configuration: {
            accountLabel: "Other workspace",
            permissionSummary: "Read event titles and times.",
          },
        },
      }),
    });
    assert.equal(foreignConnection.status, 201);
    const foreignConnectionBody = await foreignConnection.json();
    const foreignConnectionEtag = foreignConnection.headers.get("etag");
    const foreignConnectionValidation = await fetch(
      `${origin}/api/workbench/v1/connections/${foreignConnectionBody.data.connectionId}/validate`,
      {
        method: "POST",
        headers: {
          ...memberCMutationHeaders,
          "Idempotency-Key": "http-validate-foreign-connection",
          "If-Match": foreignConnectionEtag,
        },
        body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: {} }),
      },
    );
    assert.equal(foreignConnectionValidation.status, 200);
    const foreignRebind = await fetch(`${origin}/api/workbench/v1/team-library/${connectionReleaseId}/install`, {
      method: "POST",
      headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-install-connection-skill-foreign" },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: {
          connectionIds: [],
          connectionBindings: [{
            requirementId: "calendar-read",
            connectionId: foreignConnectionBody.data.connectionId,
          }],
        },
      }),
    });
    assert.equal(foreignRebind.status, 409);
    assert.equal((await foreignRebind.json()).code, "connection_rebind_required");
    const installedConnectionSkill = await fetch(
      `${origin}/api/workbench/v1/team-library/${connectionReleaseId}/install`,
      {
        method: "POST",
        headers: { ...memberBMutationHeaders, "Idempotency-Key": "http-install-connection-skill-local" },
        body: JSON.stringify({
          schemaVersion: "workbench-api-v1",
          data: {
            connectionIds: [createdConnectionBody.data.connectionId],
            connectionBindings: [{
              requirementId: "calendar-read",
              connectionId: createdConnectionBody.data.connectionId,
            }],
          },
        }),
      },
    );
    assert.equal(installedConnectionSkill.status, 201, await installedConnectionSkill.clone().text());
    const installedConnectionSkillBody = await installedConnectionSkill.json();
    assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.installRelease.responseBodySchema, installedConnectionSkillBody), true);
    assert.equal(Object.hasOwn(installedConnectionSkillBody.data, "connectionIds"), false);
    assert.equal(JSON.stringify(installedConnectionSkillBody).includes("permissionSummary"), false);
    const persistedConnectionBindings = await store.repositories.connectionBindings.listByTarget({
      workspaceId: "test-workspace-a",
      targetKind: "asset_installation",
      targetId: installedConnectionSkillBody.data.installationId,
    });
    assert.deepEqual(
      persistedConnectionBindings.map(({ requirementId, connectionId }) => ({ requirementId, connectionId })),
      [{ requirementId: "calendar-read", connectionId: createdConnectionBody.data.connectionId }],
    );
    const updateAuditActions = (await store.repositories.auditEvents.list({ limit: 50 })).map((event) => event.action);
    assert.ok(updateAuditActions.includes("skill.next_draft_created"));
    assert.ok(updateAuditActions.includes("skill.draft_updated"));
    assert.ok(updateAuditActions.includes("loop.skill_update_created"));
    assert.ok(updateAuditActions.includes("team_library.installation_updated"));
    assert.ok(updateAuditActions.includes("skill.deprecated"));
    assert.ok(updateAuditActions.includes("connection.created"));
    assert.ok(updateAuditActions.includes("connection.validated"));
    assert.ok(updateAuditActions.includes("connection.rebound"));
  },
);
