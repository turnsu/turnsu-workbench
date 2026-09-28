import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import * as scopes from "../dist/scopes.js";

const basePolicy = {
  policyRevisionId: "policy-scope-alice-v1",
  observationTier: "workspace_readable",
  defaultPermission: { mode: "interactive" },
};

const personalScope = {
  schemaVersion: "workbench-v1",
  scopeId: "scope-alice",
  workspaceId: "workspace-team",
  kind: "personal",
  ownerUserId: "user-alice",
  policy: basePolicy,
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
};

const projectScope = {
  schemaVersion: "workbench-v1",
  scopeId: "scope-project-alpha",
  workspaceId: "workspace-team",
  kind: "project",
  projectId: "project-alpha",
  policy: {
    ...basePolicy,
    policyRevisionId: "policy-project-alpha-v1",
    observationTier: "private",
  },
  createdAt: "2026-08-04T12:00:00.000Z",
  updatedAt: "2026-08-04T12:00:00.000Z",
};

test("scope contracts reject unknown fields at every governed boundary", () => {
  assert.equal(Check(scopes.ProductScopeSchema, personalScope), true);
  assert.equal(Check(scopes.ProductScopeSchema, {
    ...personalScope,
    displayName: "Alice",
  }), false);
  assert.equal(Check(scopes.ProductScopeSchema, {
    ...personalScope,
    policy: { ...basePolicy, allowEverything: true },
  }), false);
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "interactive",
    approvalTimeoutSeconds: 30,
  }), false);
});

test("personal and project scopes are an exact discriminated union", () => {
  assert.equal(Check(scopes.PersonalScopeSchema, personalScope), true);
  assert.equal(Check(scopes.ProjectScopeSchema, projectScope), true);
  assert.equal(Check(scopes.ProductScopeSchema, personalScope), true);
  assert.equal(Check(scopes.ProductScopeSchema, projectScope), true);

  assert.equal(Check(scopes.ProductScopeSchema, {
    ...personalScope,
    projectId: "project-alpha",
  }), false, "personal scopes cannot also identify a project");
  assert.equal(Check(scopes.ProductScopeSchema, {
    ...projectScope,
    ownerUserId: "user-alice",
  }), false, "project scopes cannot also identify a personal owner");
  assert.equal(Check(scopes.ProductScopeSchema, {
    ...personalScope,
    kind: "project",
  }), false, "the project discriminant requires a projectId");
  assert.equal(Check(scopes.ProductScopeSchema, {
    ...projectScope,
    kind: "personal",
  }), false, "the personal discriminant requires an ownerUserId");
});

test("auto and custom permission modes carry only their declared policy axis", () => {
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "auto",
    autoApprovedEffectClasses: ["read", "execute"],
  }), true);
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "custom",
    autoApprovedActionIds: ["tool.lark.search", "skill.report.publish"],
  }), true);

  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "auto",
    autoApprovedActionIds: ["tool.lark.search"],
  }), false, "auto approves effect classes, not arbitrary action identifiers");
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "custom",
    autoApprovedEffectClasses: ["read"],
  }), false, "custom approves exact action identifiers, not effect classes");
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "auto",
    autoApprovedEffectClasses: ["read", "read"],
  }), false, "auto effect classes must be unique");
  assert.equal(Check(scopes.PermissionModeConfigSchema, {
    mode: "custom",
    autoApprovedActionIds: ["tool lark search"],
  }), false, "custom actions use stable Product action identifiers");
});

test("invalid permission mode payloads fail closed", () => {
  for (const payload of [
    { mode: "discuss", autoApprovedEffectClasses: ["read"] },
    { mode: "plan", autoApprovedActionIds: ["tool.lark.search"] },
    { mode: "interactive", autoApprovedEffectClasses: [] },
    { mode: "auto" },
    { mode: "auto", autoApprovedEffectClasses: [] },
    { mode: "auto", autoApprovedEffectClasses: ["network_write"] },
    { mode: "custom" },
    { mode: "custom", autoApprovedActionIds: [] },
    { mode: "allow_everything" },
  ]) {
    assert.equal(Check(scopes.PermissionModeConfigSchema, payload), false);
  }
});
