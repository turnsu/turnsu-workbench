import assert from "node:assert/strict";
import test from "node:test";

import {
  ObjectAccessDeniedError,
  ObjectAccessPolicy,
  normalizeWorkspaceRole,
} from "../../src/authorization/index.mjs";

const policy = new ObjectAccessPolicy();

const principal = (overrides = {}) => ({
  principalId: "user-alice",
  kind: "user",
  workspaceId: "workspace-team",
  workspaceRole: "member",
  capabilities: [],
  ...overrides,
});

const target = (overrides = {}) => ({
  objectKind: "workflow",
  objectId: "workflow-private",
  workspaceId: "workspace-team",
  ownerPrincipalId: "user-alice",
  visibility: "private",
  grants: [],
  ...overrides,
});

test("missing targets and unauthorized targets have the same opaque result and error", () => {
  const missing = policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: null,
    operation: "read",
  });
  const unauthorized = policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: target(),
    operation: "read",
  });
  assert.deepEqual(missing, unauthorized);
  assert.deepEqual(unauthorized, {
    allowed: false,
    code: "object_not_found_or_forbidden",
  });
  assert.throws(
    () => policy.require({
      principal: principal({ principalId: "user-bob" }),
      target: target(),
      operation: "read",
    }),
    (error) => error instanceof ObjectAccessDeniedError
      && error.code === "object_not_found_or_forbidden"
      && error.statusCode === 404,
  );
});

test("a known ID and same-workspace membership do not grant private object access", () => {
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob", workspaceRole: "admin" }),
    target: target(),
    operation: "read",
  }).allowed, false, "workspace administration is not a private object grant");

  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: target({ visibility: "workspace" }),
    operation: "read",
  }).allowed, true, "workspace visibility grants the bounded viewer role");
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: target({ visibility: "workspace" }),
    operation: "update",
  }).allowed, false, "workspace visibility never grants writes");
});

test("object roles are operation-specific rather than a misleading rank", () => {
  const reviewerTarget = target({
    ownerPrincipalId: "user-owner",
    grants: [{ principalId: "user-bob", role: "reviewer" }],
  });
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: reviewerTarget,
    operation: "review",
  }).allowed, true);
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: reviewerTarget,
    operation: "update",
  }).allowed, false);

  const editorTarget = target({
    ownerPrincipalId: "user-owner",
    grants: [{ principalId: "user-bob", role: "editor" }],
  });
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: editorTarget,
    operation: "update",
  }).allowed, true);
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob" }),
    target: editorTarget,
    operation: "review",
  }).allowed, false);
});

test("cross-workspace access and privileged operations fail closed", () => {
  assert.equal(policy.evaluate({
    principal: principal({ workspaceId: "workspace-other" }),
    target: target(),
    operation: "read",
  }).allowed, false);

  assert.equal(policy.evaluate({
    principal: principal(),
    target: target(),
    operation: "execute",
  }).allowed, false, "object ownership does not invent an execution capability");
  assert.deepEqual(policy.evaluate({
    principal: principal({ capabilities: ["object.execute"] }),
    target: target(),
    operation: "execute",
  }), {
    allowed: true,
    code: "authorized",
    objectRole: "owner",
  });
  assert.equal(policy.evaluate({
    principal: principal({ capabilities: ["object.execute"] }),
    target: target(),
    operation: "unknown_operation",
  }).allowed, false);
});

test("legacy workspace maintainer normalizes only to membership and not object authority", () => {
  assert.equal(normalizeWorkspaceRole("maintainer"), "member");
  assert.equal(normalizeWorkspaceRole("administrator"), null);
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-bob", workspaceRole: "maintainer" }),
    target: target(),
    operation: "read",
  }).allowed, false);
});

test("workspace viewers can review an explicitly assigned object but cannot execute it", () => {
  const assigned = target({
    ownerPrincipalId: "user-owner",
    grants: [{ principalId: "user-reviewer", role: "reviewer" }],
  });
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-reviewer", workspaceRole: "viewer" }),
    target: assigned,
    operation: "review",
  }).allowed, true);
  assert.equal(policy.evaluate({
    principal: principal({
      principalId: "user-reviewer",
      workspaceRole: "viewer",
      capabilities: ["object.execute"],
    }),
    target: assigned,
    operation: "execute",
  }).allowed, false);
});

test("only current workspace members execute explicit system catalog Skills without fabricated grants", () => {
  const systemSkill = target({
    objectKind: "skill",
    objectId: "skill-system",
    ownerPrincipalId: "system-catalog",
    visibility: "workspace",
    lifecycle: "published",
    latestPublishedVersionId: "skill-version-current",
    requestedSkillVersionId: "skill-version-current",
  });
  for (const operation of ["discover", "read"]) {
    assert.equal(policy.evaluate({
      principal: principal({ principalId: "user-member" }),
      target: systemSkill,
      operation,
    }).allowed, true, operation);
    assert.equal(policy.evaluate({
      principal: principal({ principalId: "user-viewer", workspaceRole: "viewer" }),
      target: systemSkill,
      operation,
    }).allowed, true, `viewer ${operation}`);
  }
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-member" }),
    target: systemSkill,
    operation: "execute",
  }).allowed, true);
  for (const operation of ["update", "publish", "share", "manage_access"] ) {
    assert.equal(policy.evaluate({
      principal: principal({ principalId: "user-member" }),
      target: systemSkill,
      operation,
    }).allowed, false, operation);
  }
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-viewer", workspaceRole: "viewer" }),
    target: systemSkill,
    operation: "execute",
  }).allowed, false);
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-member" }),
    target: { ...systemSkill, requestedSkillVersionId: "skill-version-old" },
    operation: "execute",
  }).allowed, false, "a stale pin is not executable");
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-member" }),
    target: { ...systemSkill, lifecycle: "deprecated" },
    operation: "read",
  }).allowed, false, "only the governed published lifecycle is exposed as system catalog");
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-member", workspaceId: "workspace-other" }),
    target: systemSkill,
    operation: "execute",
  }).allowed, false);
  assert.equal(policy.evaluate({
    principal: principal({ principalId: "user-member" }),
    target: { ...systemSkill, ownerPrincipalId: "user-owner" },
    operation: "execute",
  }).allowed, false, "workspace-visible user Skills do not inherit system execution authority");
});


test("workspace release permits only its exact Skill version, keeping private drafts and management private", () => {
  const shared = target({ objectKind: "skill", ownerPrincipalId: "user-other", lifecycle: "draft",
    requestedSkillVersionId: "version-released", workspaceReleaseVersionId: "version-released" });
  for (const operation of ["read", "execute"]) {
    assert.equal(policy.evaluate({ principal: principal(), target: shared, operation }).allowed, true);
    assert.equal(policy.evaluate({ principal: principal({ workspaceId: "another-workspace" }), target: shared, operation }).allowed, false);
    assert.equal(policy.evaluate({ principal: principal(), target: { ...shared, requestedSkillVersionId: "unreleased-version" }, operation }).allowed, false);
    assert.equal(policy.evaluate({ principal: principal(), target: { ...shared, requestedSkillVersionId: null }, operation }).allowed, false);
    assert.equal(policy.evaluate({ principal: principal(), target: { ...shared, lifecycle: "deprecated" }, operation }).allowed, false);
  }
  assert.equal(policy.evaluate({ principal: principal({ workspaceRole: "viewer" }), target: shared, operation: "execute" }).allowed, false);
  for (const operation of ["discover", "read_content", "update", "publish", "share", "manage_access"]) {
    assert.equal(policy.evaluate({ principal: principal(), target: shared, operation }).allowed, false);
  }
});
