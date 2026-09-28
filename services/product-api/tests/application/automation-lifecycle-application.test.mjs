import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const scope = {
  schemaVersion: "workbench-v1",
  scopeId: "scope-owner",
  workspaceId: "workspace-team",
  kind: "personal",
  ownerUserId: "user-owner",
  policy: {
    policyRevisionId: "policy-1",
    observationTier: "private",
    defaultPermission: { mode: "auto", autoApprovedEffectClasses: ["execute"] },
  },
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

test("application delegates Automation lifecycle only through the authenticated Product owner", async () => {
  const calls = [];
  const lifecycle = {
    async listScopes(input) { calls.push(["listScopes", input]); return [scope]; },
    async reviseScopePolicy(input) { calls.push(["reviseScopePolicy", input]); return { data: scope, etag: '"scopev1:scope-owner:2:policy-2"' }; },
    async listAutomations(input) { calls.push(["listAutomations", input]); return []; },
    async listCandidates(input) { calls.push(["listCandidates", input]); return []; },
    async createAutomation(input) { calls.push(["createAutomation", input]); return { data: { automationId: "automation-1" }, etag: '"autv1:automation-1:1:1"' }; },
    async getAutomation(input) { calls.push(["getAutomation", input]); return { data: { automationId: input.automationId }, etag: '"autv1:automation-1:1:1"' }; },
    async reviseAutomation(input) { calls.push(["reviseAutomation", input]); return { data: { automationId: input.automationId }, etag: '"autv1:automation-1:2:2"' }; },
    async activateAutomation(input) { calls.push(["activateAutomation", input]); return { data: { automationId: input.automationId }, etag: '"autv1:automation-1:3:2"' }; },
    async pauseAutomation(input) { calls.push(["pauseAutomation", input]); return { data: { automationId: input.automationId }, etag: '"autv1:automation-1:4:2"' }; },
    async archiveAutomation(input) { calls.push(["archiveAutomation", input]); return { data: { automationId: input.automationId }, etag: '"autv1:automation-1:5:2"' }; },
    async listOccurrences(input) { calls.push(["listOccurrences", input]); return []; },
  };
  const roleChecks = [];
  const application = createWorkbenchApplication({
    store: {
      async connect() {},
      async authorizeWorkspace(input) { roleChecks.push(input); return { role: "owner" }; },
    },
    automationLifecycle: lifecycle,
  });
  const auth = { userId: "user-owner", activeWorkspaceId: "workspace-team" };
  const request = { data: { displayName: "Daily brief" } };

  const listed = await application.listScopes({ auth });
  assert.deepEqual(listed.data, [scope]);
  assert.equal(listed.responseHeaders["Cache-Control"], "private, no-store");
  await application.reviseScopePolicy({
    scopeId: "scope-owner", idempotencyKey: "scope-policy-1", ifMatch: '"scopev1:scope-owner:1:policy-1"', request, auth,
  });
  await application.listAutomationCandidates({ query: { scopeId: "scope-owner" }, auth });
  await application.createAutomation({ idempotencyKey: "automation-create-1", request, auth });
  await application.reviseAutomation({
    automationId: "automation-1", idempotencyKey: "automation-revise-1", ifMatch: '"autv1:automation-1:1:1"', request, auth,
  });
  await application.activateAutomation({ automationId: "automation-1", idempotencyKey: "automation-activate-1", ifMatch: '"autv1:automation-1:2:2"', auth });
  await application.pauseAutomation({ automationId: "automation-1", idempotencyKey: "automation-pause-1", ifMatch: '"autv1:automation-1:3:2"', auth });
  await application.archiveAutomation({ automationId: "automation-1", idempotencyKey: "automation-archive-1", ifMatch: '"autv1:automation-1:4:2"', auth });
  await application.listAutomationOccurrences({ automationId: "automation-1", query: { limit: 10 }, auth });

  assert.deepEqual(calls.map(([kind]) => kind), [
    "listScopes", "reviseScopePolicy", "listCandidates", "createAutomation", "reviseAutomation",
    "activateAutomation", "pauseAutomation", "archiveAutomation", "listOccurrences",
  ]);
  for (const [, input] of calls) {
    assert.equal(input.context.workspaceId, "workspace-team");
    assert.equal(input.context.userId, "user-owner");
  }
  assert.ok(roleChecks.some((input) => input.minimumRole === "admin"));
});

test("application keeps Automation unavailable when PostgreSQL lifecycle is not composed", async () => {
  const application = createWorkbenchApplication({ store: { async connect() {} } });
  await assert.rejects(
    () => application.listAutomations({ auth: { userId: "user-owner", activeWorkspaceId: "workspace-team" } }),
    { code: "automation_lifecycle_unavailable" },
  );
});
