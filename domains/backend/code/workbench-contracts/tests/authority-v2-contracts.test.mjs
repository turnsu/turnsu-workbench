import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import {
  AuthorityLineageSchema,
  AuthorizationSourceSchema,
  AuthorizationTargetV2Schema,
  ObjectAccessGrantRecordV2Schema,
  ObjectAccessRequestV2Schema,
  PolicyGrantAuthorizationSourceSchema,
  PrincipalRefSchema,
  PrincipalAuthorizationSourceSchema,
  ResolvedPrincipalContextV2Schema,
  checkAuthorityLineageSemantics,
  checkObjectAccessRequestV2Semantics,
  checkResolvedPrincipalContextV2Semantics,
} from "../dist/authority.js";

const actor = {
  principalId: "user-alice",
  kind: "user",
};

const principalAuthorization = {
  kind: "principal",
  principal: actor,
};

const policyGrantAuthorization = {
  kind: "policy_grant",
  policyGrantId: "grant-daily-loop",
  subject: {
    principalId: "automation-daily-loop",
    kind: "automation",
  },
  workspaceId: "workspace-team",
  scopeId: "scope-project-ops",
  policyRevisionId: "policy-v7",
};

const userPrincipal = {
  actor,
  effectivePrincipal: actor,
  authorizedBy: principalAuthorization,
  workspaceId: "workspace-team",
  scopeId: "scope-alice",
  workspaceRole: "member",
  sessionId: "session-alice",
  capabilities: ["object.execute"],
  permission: { mode: "interactive" },
  policyRevisionId: "policy-v7",
};

const automationPrincipal = {
  actor: {
    principalId: "scheduler-cloud",
    kind: "scheduler",
  },
  effectivePrincipal: {
    principalId: "automation-daily-loop",
    kind: "automation",
  },
  authorizedBy: policyGrantAuthorization,
  workspaceId: "workspace-team",
  scopeId: "scope-project-ops",
  workspaceRole: null,
  capabilities: ["object.execute"],
  permission: {
    mode: "auto",
    autoApprovedEffectClasses: ["read", "execute"],
  },
  policyRevisionId: "policy-v7",
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

test("principal and authority lineage contracts reject display metadata", () => {
  assert.equal(Check(PrincipalRefSchema, actor), true);
  assert.equal(Check(PrincipalAuthorizationSourceSchema, principalAuthorization), true);
  assert.equal(Check(PolicyGrantAuthorizationSourceSchema, policyGrantAuthorization), true);
  assert.equal(Check(AuthorizationSourceSchema, principalAuthorization), true);
  assert.equal(Check(AuthorizationSourceSchema, policyGrantAuthorization), true);

  const lineage = {
    actor: { principalId: "scheduler-cloud", kind: "scheduler" },
    effectivePrincipal: policyGrantAuthorization.subject,
    authorizedBy: policyGrantAuthorization,
    workspaceId: "workspace-team",
    scopeId: "scope-project-ops",
    policyRevisionId: "policy-v7",
    authorizationDecisionId: "decision-42",
  };
  assert.equal(Check(AuthorityLineageSchema, lineage), true);
  assert.equal(checkAuthorityLineageSemantics(lineage), true);
  assert.equal(Check(AuthorityLineageSchema, {
    ...lineage,
    displayAgent: "Looloomi",
  }), false);
  assert.equal(Check(AuthorityLineageSchema, {
    ...lineage,
    performedFor: "Alice",
  }), false);
  assert.equal(Check(AuthorityLineageSchema, {
    ...lineage,
    authorizedByDisplayName: "Team admin",
  }), false);
});

test("authority lineage binds policy grants but permits an independent human authorizer", () => {
  const independentApproval = {
    actor,
    effectivePrincipal: actor,
    authorizedBy: {
      kind: "principal",
      principal: { principalId: "user-reviewer", kind: "user" },
    },
    workspaceId: "workspace-team",
    scopeId: "scope-alice",
    policyRevisionId: "policy-v7",
    authorizationDecisionId: "decision-human-review",
  };
  assert.equal(checkAuthorityLineageSemantics(independentApproval), true);

  const grantLineage = {
    actor: { principalId: "scheduler-cloud", kind: "scheduler" },
    effectivePrincipal: policyGrantAuthorization.subject,
    authorizedBy: policyGrantAuthorization,
    workspaceId: "workspace-team",
    scopeId: "scope-project-ops",
    policyRevisionId: "policy-v7",
    authorizationDecisionId: "decision-policy-grant",
  };
  for (const authorizedBy of [
    {
      ...policyGrantAuthorization,
      subject: { principalId: "automation-other", kind: "automation" },
    },
    { ...policyGrantAuthorization, workspaceId: "workspace-other" },
    { ...policyGrantAuthorization, scopeId: "scope-other" },
    { ...policyGrantAuthorization, policyRevisionId: "policy-v8" },
  ]) {
    assert.equal(checkAuthorityLineageSemantics({
      ...grantLineage,
      authorizedBy,
    }), false);
  }
});

test("resolved user and service principal shapes keep workspace roles separate", () => {
  assert.equal(Check(ResolvedPrincipalContextV2Schema, userPrincipal), true);
  assert.equal(Check(ResolvedPrincipalContextV2Schema, automationPrincipal), true);
  assert.equal(checkResolvedPrincipalContextV2Semantics(userPrincipal), true);
  assert.equal(checkResolvedPrincipalContextV2Semantics(automationPrincipal), true);

  assert.equal(Check(ResolvedPrincipalContextV2Schema, {
    ...userPrincipal,
    workspaceRole: null,
  }), false, "a user authority must resolve a current canonical membership role");
  assert.equal(Check(ResolvedPrincipalContextV2Schema, {
    ...automationPrincipal,
    workspaceRole: "member",
  }), false, "a service principal cannot borrow a human membership role");
  assert.equal(Check(ResolvedPrincipalContextV2Schema, {
    ...automationPrincipal,
    authorizedBy: principalAuthorization,
  }), false, "a service principal requires an explicit policy grant");
  assert.equal(Check(ResolvedPrincipalContextV2Schema, {
    ...userPrincipal,
    workspaceRole: "maintainer",
  }), false, "the legacy compatibility role is rejected by V2");
});

test("resolved authority semantics bind policy grants to subject and scope", () => {
  assert.equal(checkResolvedPrincipalContextV2Semantics({
    ...userPrincipal,
    authorizedBy: {
      kind: "principal",
      principal: { principalId: "user-bob", kind: "user" },
    },
  }), false, "a direct principal source must be the effective principal");

  for (const authorizedBy of [
    {
      ...policyGrantAuthorization,
      subject: { principalId: "automation-other", kind: "automation" },
    },
    { ...policyGrantAuthorization, workspaceId: "workspace-other" },
    { ...policyGrantAuthorization, scopeId: "scope-other" },
    { ...policyGrantAuthorization, policyRevisionId: "policy-v8" },
  ]) {
    assert.equal(checkResolvedPrincipalContextV2Semantics({
      ...automationPrincipal,
      authorizedBy,
    }), false);
  }
});

test("scope is mandatory on resolved principals, targets, grants and requests", () => {
  const { scopeId: _principalScope, ...principalWithoutScope } = userPrincipal;
  const { scopeId: _targetScope, ...targetWithoutScope } = target;

  assert.equal(Check(ResolvedPrincipalContextV2Schema, principalWithoutScope), false);
  assert.equal(Check(AuthorizationTargetV2Schema, targetWithoutScope), false);

  const grant = {
    grantId: "grant-workflow-bob",
    workspaceId: "workspace-team",
    scopeId: "scope-alice",
    objectKind: "workflow",
    objectId: "workflow-private",
    principalId: "user-bob",
    role: "reviewer",
    capabilities: ["object.execute"],
    grantedBy: "user-alice",
    revokedAt: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
  assert.equal(Check(ObjectAccessGrantRecordV2Schema, grant), true);
  const { scopeId: _grantScope, ...grantWithoutScope } = grant;
  assert.equal(Check(ObjectAccessGrantRecordV2Schema, grantWithoutScope), false);

  assert.equal(Check(ObjectAccessRequestV2Schema, {
    principal: userPrincipal,
    target,
    operation: "execute",
  }), true);
  assert.equal(checkObjectAccessRequestV2Semantics({
    principal: userPrincipal,
    target,
    operation: "execute",
  }), true);
  assert.equal(Check(ObjectAccessRequestV2Schema, {
    principal: principalWithoutScope,
    target,
    operation: "execute",
  }), false);
});

test("object request semantics reject cross-workspace and cross-scope targets", () => {
  assert.equal(Check(ObjectAccessRequestV2Schema, {
    principal: userPrincipal,
    target: { ...target, scopeId: "scope-bob" },
    operation: "read",
  }), true, "structural validation alone does not evaluate isolation equality");
  assert.equal(checkObjectAccessRequestV2Semantics({
    principal: userPrincipal,
    target: { ...target, scopeId: "scope-bob" },
    operation: "read",
  }), false);
  assert.equal(checkObjectAccessRequestV2Semantics({
    principal: userPrincipal,
    target: { ...target, workspaceId: "workspace-other" },
    operation: "read",
  }), false);
});

test("V2 target visibility is scope-local and all authority objects are strict", () => {
  assert.equal(Check(AuthorizationTargetV2Schema, target), true);
  assert.equal(Check(AuthorizationTargetV2Schema, {
    ...target,
    visibility: "scope_readable",
  }), true);
  assert.equal(Check(AuthorizationTargetV2Schema, {
    ...target,
    visibility: "workspace",
  }), false);
  assert.equal(Check(AuthorizationTargetV2Schema, {
    ...target,
    displayAgent: "Looloomi",
  }), false);
  assert.equal(Check(ResolvedPrincipalContextV2Schema, {
    ...userPrincipal,
    performedFor: "Alice",
  }), false);
});
