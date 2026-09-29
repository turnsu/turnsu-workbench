import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../dist/index.js";

const principal = {
  principalId: "user-alice",
  kind: "user",
  workspaceId: "workspace-team",
  workspaceRole: "member",
  sessionId: "session-alice",
  capabilities: ["object.execute"],
};

const target = {
  objectKind: "workflow",
  objectId: "workflow-private",
  workspaceId: "workspace-team",
  scopeId: "scope-alice",
  version: "3",
  ownerPrincipalId: "user-alice",
  visibility: "private",
  grants: [{ principalId: "user-bob", role: "reviewer" }],
};

test("authorization contracts keep workspace and object authority separate", () => {
  assert.equal(contracts.Check(contracts.PrincipalContextSchema, principal), true);
  assert.equal(contracts.Check(contracts.AuthorizationTargetSchema, target), true);
  assert.equal(contracts.Check(contracts.ObjectAccessRequestSchema, {
    principal,
    target,
    operation: "execute",
  }), true);

  assert.equal(contracts.Check(contracts.PrincipalContextSchema, {
    ...principal,
    objectRole: "owner",
  }), false, "principal context is strict and does not embed object authority");
  assert.equal(contracts.Check(contracts.AuthorizationTargetSchema, {
    ...target,
    grants: [{ principalId: "user-bob", role: "member" }],
  }), false, "workspace membership roles are not object roles");
});

test("canonical workspace roles converge while the migration boundary accepts maintainer", () => {
  for (const role of ["owner", "admin", "member", "viewer"]) {
    assert.equal(contracts.Check(contracts.WorkspaceRoleSchema, role), true);
    assert.equal(contracts.Check(contracts.CompatibleWorkspaceRoleSchema, role), true);
  }
  assert.equal(contracts.Check(contracts.WorkspaceRoleSchema, "maintainer"), false);
  assert.equal(contracts.Check(contracts.CompatibleWorkspaceRoleSchema, "maintainer"), true);
});

test("object access decisions expose one opaque denial shape", () => {
  assert.equal(contracts.Check(contracts.ObjectAccessDecisionSchema, {
    allowed: true,
    code: "authorized",
    objectRole: "reviewer",
  }), true);
  assert.equal(contracts.Check(contracts.ObjectAccessDecisionSchema, {
    allowed: false,
    code: "object_not_found_or_forbidden",
  }), true);
  assert.equal(contracts.Check(contracts.ObjectAccessDecisionSchema, {
    allowed: false,
    code: "object_missing",
  }), false);
  assert.equal(contracts.Check(contracts.ObjectAccessDecisionSchema, {
    allowed: false,
    code: "object_not_found_or_forbidden",
    objectId: "workflow-private",
  }), false, "denials cannot reveal target identity through the decision contract");
});

test("durable object grants keep policy projection and persistence metadata separate", () => {
  const record = {
    grantId: "grant-workflow-bob",
    workspaceId: "workspace-team",
    objectKind: "workflow",
    objectId: "workflow-private",
    principalId: "user-bob",
    role: "reviewer",
    capabilities: ["object.execute"],
    grantedBy: "user-alice",
    revokedAt: null,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:00:00.000Z",
  };

  assert.equal(contracts.Check(contracts.ObjectAccessGrantRecordSchema, record), true);
  assert.equal(contracts.Check(contracts.ObjectAccessGrantSchema, {
    principalId: record.principalId,
    role: record.role,
  }), true);
  assert.equal(contracts.Check(contracts.ObjectAccessGrantSchema, record), false,
    "the authorization target receives only the role projection");
  assert.equal(contracts.Check(contracts.ObjectAccessGrantRecordSchema, {
    ...record,
    capabilities: ["object.execute", "object.execute"],
  }), false, "persisted capabilities are unique");
});
