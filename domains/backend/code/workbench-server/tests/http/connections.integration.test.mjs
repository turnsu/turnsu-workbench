import assert from "node:assert/strict";
import test from "node:test";

import { Check, WORKBENCH_V1_LIFECYCLE_ENDPOINTS } from "@looloomi/workbench-contracts";
import { workflowRevisionExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { createWorkbenchServer } from "../../src/server.mjs";
import { ProductMongoStore } from "../../src/store/index.mjs";

const ENABLED = process.env.WORKBENCH_MONGO_INTEGRATION === "1";
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/?replicaSet=rs0";
const DATABASE_NAME = process.env.MONGODB_DB ?? "looloomi_workbench_test";

if (!DATABASE_NAME.endsWith("_test")) throw new Error(`integration_database_must_end_in_test:${DATABASE_NAME}`);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("Connection API is tenant-safe and release consumption requires explicit workspace rebinding", {
  skip: !ENABLED,
  timeout: 30_000,
}, async (context) => {
  const store = new ProductMongoStore({ uri: MONGODB_URI, dbName: DATABASE_NAME });
  await store.connect();
  await store.dropTestDatabase();
  const application = createWorkbenchApplication({ store, agentRuntime: {}, runner: {} });
  const composed = createWorkbenchServer({
    store,
    application,
    bootstrapCatalog: false,
    distDirectory: null,
    env: { ...process.env, WORKBENCH_TEST_MODE: "1", WECHAT_AGENT_TEST_MODE: "1" },
  });
  context.after(async () => {
    await composed.close();
    await store.dropTestDatabase();
    await store.close();
  });
  await composed.ready;
  const port = await listen(composed.server);
  const origin = `http://127.0.0.1:${port}`;

  async function bootstrap(userId, workspaceId) {
    const response = await fetch(`${origin}/api/workbench/v1/workspace`, {
      headers: {
        "X-Workbench-Test-User": userId,
        "X-Workbench-Test-Workspace": workspaceId,
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    return {
      cookie: response.headers.get("set-cookie").split(";", 1)[0],
      csrf: body.data.session.csrfToken,
    };
  }

  const owner = await bootstrap("connection-owner", "connection-workspace");
  const ownerHeaders = {
    Cookie: owner.cookie,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": owner.csrf,
    "Content-Type": "application/json",
  };
  async function invite(userId, role) {
    const response = await fetch(`${origin}/api/workbench/v1/workspace/memberships`, {
      method: "POST",
      headers: { ...ownerHeaders, "Idempotency-Key": `invite-${userId}` },
      body: JSON.stringify({
        schemaVersion: "workbench-api-v1",
        data: { userId, displayName: userId, role },
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
  }
  await invite("connection-member", "member");
  await invite("connection-viewer", "viewer");
  const member = await bootstrap("connection-member", "connection-workspace");
  const viewer = await bootstrap("connection-viewer", "connection-workspace");
  const outsider = await bootstrap("connection-outsider", "connection-other-workspace");
  const memberHeaders = {
    Cookie: member.cookie,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": member.csrf,
    "Content-Type": "application/json",
  };
  const viewerHeaders = {
    Cookie: viewer.cookie,
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Workbench-CSRF": viewer.csrf,
    "Content-Type": "application/json",
  };

  const created = await fetch(`${origin}/api/workbench/v1/connections`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-create-calendar" },
    body: JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: {
        capabilityKey: "calendar-read",
        label: "Team calendar",
        configuration: {
          accountLabel: "Operations calendar",
          permissionSummary: "Read calendars selected by this workspace.",
        },
      },
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json();
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createConnection.responseBodySchema, createdBody), true);
  assert.equal(JSON.stringify(createdBody).toLowerCase().includes("secret"), false);
  const connectionId = createdBody.data.connectionId;
  const createdEtag = created.headers.get("etag");
  assert.ok(createdEtag);

  await store.repositories.connections.patch(connectionId, {
    internalSecretHandle: "publisher-secret-handle-must-not-leak",
  }, { workspaceId: "connection-workspace" });

  const listed = await fetch(`${origin}/api/workbench/v1/connections`, { headers: { Cookie: viewer.cookie } });
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(Check(WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listConnections.responseBodySchema, listedBody), true);
  assert.equal(JSON.stringify(listedBody).includes("publisher-secret-handle"), false);
  const detail = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}`, {
    headers: { Cookie: viewer.cookie },
  });
  assert.equal(detail.status, 200);
  assert.equal(Check(
    WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getConnection.responseBodySchema,
    await detail.json(),
  ), true);
  assert.equal(detail.headers.get("etag"), createdEtag);

  const viewerDenied = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}`, {
    method: "PATCH",
    headers: {
      ...viewerHeaders,
      "Idempotency-Key": "viewer-cannot-update-connection",
      "If-Match": createdEtag,
    },
    body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { label: "Forbidden rename" } }),
  });
  assert.equal(viewerDenied.status, 403);
  assert.equal((await viewerDenied.json()).code, "workspace_role_forbidden");

  const updatedConnection = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}`, {
    method: "PATCH",
    headers: {
      ...memberHeaders,
      "Idempotency-Key": "connection-update-calendar",
      "If-Match": createdEtag,
    },
    body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: { label: "Primary team calendar" } }),
  });
  assert.equal(updatedConnection.status, 200, await updatedConnection.clone().text());
  const updatedConnectionBody = await updatedConnection.json();
  assert.equal(updatedConnectionBody.data.label, "Primary team calendar");
  assert.equal(updatedConnectionBody.data.status, "needs_setup");
  const updatedEtag = updatedConnection.headers.get("etag");
  assert.notEqual(updatedEtag, createdEtag);

  const staleValidation = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}/validate`, {
    method: "POST",
    headers: {
      ...memberHeaders,
      "Idempotency-Key": "connection-validate-stale",
      "If-Match": createdEtag,
    },
    body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: {} }),
  });
  assert.equal(staleValidation.status, 412);
  assert.equal((await staleValidation.json()).code, "connection_revision_conflict");

  const validated = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}/validate`, {
    method: "POST",
    headers: {
      ...memberHeaders,
      "Idempotency-Key": "connection-validate-calendar",
      "If-Match": updatedEtag,
    },
    body: JSON.stringify({ schemaVersion: "workbench-api-v1", data: {} }),
  });
  assert.equal(validated.status, 200, await validated.clone().text());
  const validatedBody = await validated.json();
  assert.equal(validatedBody.data.status, "connected");
  assert.equal(validatedBody.data.validation.status, "valid");
  assert.equal(JSON.stringify(validatedBody).includes("publisher-secret-handle"), false);

  const crossTenantRead = await fetch(`${origin}/api/workbench/v1/connections/${connectionId}`, {
    headers: { Cookie: outsider.cookie },
  });
  assert.equal(crossTenantRead.status, 404);
  assert.equal((await crossTenantRead.json()).code, "connection_not_found");
  const crossTenantList = await fetch(`${origin}/api/workbench/v1/connections`, {
    headers: { Cookie: outsider.cookie },
  });
  assert.equal(crossTenantList.status, 200);
  assert.deepEqual((await crossTenantList.json()).data, []);

  const now = "2026-07-14T00:00:00.000Z";
  const requirement = {
    requirementId: "calendar-read",
    label: "Calendar access",
    required: true,
    permissionSummary: "Read calendars selected by this workspace.",
  };
  const skillVersion = {
    schemaVersion: "workbench-v1",
    skillVersionId: "connection-skill-version-1",
    skillId: "connection-skill",
    workspaceId: "connection-workspace",
    version: "1.0.0",
    connectionRequirements: [requirement],
  };
  await store.repositories.skillVersions.insert(skillVersion);
  const skillRelease = await store.repositories.assetReleases.insert({
    schemaVersion: "workbench-v1",
    releaseId: "connection-skill-release-1",
    sourceWorkspaceId: "connection-workspace",
    assetKind: "skill",
    assetId: skillVersion.skillId,
    versionId: skillVersion.skillVersionId,
    version: skillVersion.version,
    contentHash: "sha256:1111111111111111",
    visibility: "workspace",
    startingPoint: false,
    releaseNotes: "Connection test release.",
    dependencies: [],
    publishedBy: "connection-owner",
    publishedAt: now,
  });
  const installBody = (connectionBindings = []) => JSON.stringify({
    schemaVersion: "workbench-api-v1",
    data: { connectionIds: [], connectionBindings },
  });
  const missingInstall = await fetch(`${origin}/api/workbench/v1/team-library/${skillRelease.releaseId}/install`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-install-missing" },
    body: installBody(),
  });
  assert.equal(missingInstall.status, 409);
  assert.equal((await missingInstall.json()).code, "connection_rebind_required");

  const binding = { requirementId: requirement.requirementId, connectionId };
  const installed = await fetch(`${origin}/api/workbench/v1/team-library/${skillRelease.releaseId}/install`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-install-bound" },
    body: installBody([binding]),
  });
  assert.equal(installed.status, 201, await installed.clone().text());
  const installation = (await installed.json()).data;
  assert.equal(JSON.stringify(installation).includes("publisher-secret-handle"), false);
  assert.deepEqual(
    (await store.repositories.connectionBindings.listByTarget({
      workspaceId: "connection-workspace",
      targetKind: "asset_installation",
      targetId: installation.installationId,
    })).map(({ requirementId, connectionId: id }) => ({ requirementId, connectionId: id })),
    [binding],
  );

  const skillVersion2 = { ...skillVersion, skillVersionId: "connection-skill-version-2", version: "2.0.0" };
  await store.repositories.skillVersions.insert(skillVersion2);
  const skillRelease2 = await store.repositories.assetReleases.insert({
    ...skillRelease,
    releaseId: "connection-skill-release-2",
    versionId: skillVersion2.skillVersionId,
    version: skillVersion2.version,
    contentHash: "sha256:2222222222222222",
  });
  const missingUpdate = await fetch(`${origin}/api/workbench/v1/installations/${installation.installationId}/adopt-release`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-update-missing" },
    body: JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: { releaseId: skillRelease2.releaseId, connectionBindings: [] },
    }),
  });
  assert.equal(missingUpdate.status, 409);
  assert.equal((await missingUpdate.json()).code, "connection_rebind_required");
  const updated = await fetch(`${origin}/api/workbench/v1/installations/${installation.installationId}/adopt-release`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-update-bound" },
    body: JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: { releaseId: skillRelease2.releaseId, connectionBindings: [binding] },
    }),
  });
  assert.equal(updated.status, 200, await updated.clone().text());

  const sourceRevision = structuredClone(workflowRevisionExample);
  sourceRevision.revisionId = "connection-source-revision";
  sourceRevision.workflowId = "connection-source-loop";
  sourceRevision.revisionNumber = 1;
  sourceRevision.baseRevisionId = null;
  sourceRevision.contentHash = "sha256:3333333333333333";
  sourceRevision.authoredBy = "connection-owner";
  sourceRevision.createdAt = now;
  sourceRevision.updatedAt = now;
  await store.repositories.workflowRevisions.insert(sourceRevision);
  const loopVersion = await store.repositories.loopVersions.insert({
    schemaVersion: "workbench-v1",
    loopVersionId: "connection-loop-version-1",
    workflowId: sourceRevision.workflowId,
    workflowRevisionId: sourceRevision.revisionId,
    workspaceId: "connection-workspace",
    version: "1.0.0",
    definition: sourceRevision.definition,
    pinnedSkills: [{ skillId: skillVersion.skillId, version: skillVersion.version }],
    contentHash: sourceRevision.contentHash,
    releasedBy: "connection-owner",
    releasedAt: now,
  });
  const loopRelease = await store.repositories.assetReleases.insert({
    schemaVersion: "workbench-v1",
    releaseId: "connection-loop-release-1",
    sourceWorkspaceId: "connection-workspace",
    assetKind: "loop",
    assetId: sourceRevision.workflowId,
    versionId: loopVersion.loopVersionId,
    version: loopVersion.version,
    contentHash: sourceRevision.contentHash,
    visibility: "workspace",
    startingPoint: true,
    releaseNotes: "Connection Loop starting point.",
    dependencies: [],
    publishedBy: "connection-owner",
    publishedAt: now,
  });
  const missingStart = await fetch(`${origin}/api/workbench/v1/team-library/${loopRelease.releaseId}/starting-point`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-start-missing" },
    body: JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: { name: "Consumer Loop", connectionBindings: [] },
    }),
  });
  assert.equal(missingStart.status, 409);
  assert.equal((await missingStart.json()).code, "connection_rebind_required");
  const started = await fetch(`${origin}/api/workbench/v1/team-library/${loopRelease.releaseId}/starting-point`, {
    method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "connection-start-bound" },
    body: JSON.stringify({
      schemaVersion: "workbench-api-v1",
      data: { name: "Consumer Loop", connectionBindings: [binding] },
    }),
  });
  assert.equal(started.status, 201, await started.clone().text());
  const startedBody = await started.json();
  assert.deepEqual(
    (await store.repositories.connectionBindings.listByTarget({
      workspaceId: "connection-workspace",
      targetKind: "workflow_revision",
      targetId: startedBody.data.revision.revisionId,
    })).map(({ requirementId, connectionId: id }) => ({ requirementId, connectionId: id })),
    [binding],
  );

  const outsiderInstall = await fetch(`${origin}/api/workbench/v1/team-library/${skillRelease.releaseId}/install`, {
    method: "POST",
    headers: {
      Cookie: outsider.cookie,
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      "X-Workbench-CSRF": outsider.csrf,
      "Idempotency-Key": "connection-cross-tenant-install",
      "Content-Type": "application/json",
    },
    body: installBody([binding]),
  });
  assert.equal(outsiderInstall.status, 404);
  assert.equal((await outsiderInstall.json()).code, "release_not_available");

  const audits = await store.repositories.auditEvents.list();
  assert.ok(audits.some((event) => event.action === "connection.created"));
  assert.ok(audits.some((event) => event.action === "connection.validated"));
  assert.ok(audits.filter((event) => event.action === "connection.rebound").length >= 3);
  assert.equal(JSON.stringify(audits).includes("publisher-secret-handle"), false);
});
