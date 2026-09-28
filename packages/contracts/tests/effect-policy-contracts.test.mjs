import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "typebox/value";

import {
  ActionAuthorizationDecisionSchema,
  DestructiveEvaluationSchema,
  EffectAuthorizationDispositionSchema,
  EffectDescriptorSchema,
  isActionAuthorizationDecisionSemanticallyValid,
} from "../dist/effects.js";

const decisionId = "decision-effect-send-message";

const descriptor = {
  actionId: "lark.task.create",
  effectClass: "external_write",
  argumentDigest: `sha256:${"a".repeat(64)}`,
  resourceRefs: ["resource-meeting-notes:1"],
  connectionId: "connection-lark-team",
  destructiveEvaluation: {
    status: "clear",
    ruleVersion: "destructive-rules-v1",
  },
};

const lineage = {
  actor: { principalId: "user-alice", kind: "user" },
  effectivePrincipal: { principalId: "user-alice", kind: "user" },
  authorizedBy: {
    kind: "principal",
    principal: { principalId: "user-alice", kind: "user" },
  },
  workspaceId: "workspace-team",
  scopeId: "scope-alice",
  policyRevisionId: "policy-effects-v3",
  authorizationDecisionId: decisionId,
};

const policyGrantLineage = {
  ...lineage,
  authorizedBy: {
    kind: "policy_grant",
    policyGrantId: "grant-effects-v3",
    subject: lineage.effectivePrincipal,
    workspaceId: lineage.workspaceId,
    scopeId: lineage.scopeId,
    policyRevisionId: lineage.policyRevisionId,
  },
};

const decision = {
  decisionId,
  descriptor,
  mode: { mode: "interactive" },
  disposition: "authorized",
  reasonCode: "explicit_policy_authorized",
  lineage,
  decidedAt: "2026-08-05T01:00:00.000Z",
  expiresAt: "2026-08-05T01:05:00.000Z",
};

test("effect descriptor binds an exact action and complete argument digest", () => {
  assert.equal(Check(EffectDescriptorSchema, descriptor), true);
  assert.equal(Check(EffectDescriptorSchema, {
    ...descriptor,
    actionId: "*",
  }), false, "wildcard action IDs cannot authorize a family of actions");

  const missingDigest = structuredClone(descriptor);
  delete missingDigest.argumentDigest;
  assert.equal(Check(EffectDescriptorSchema, missingDigest), false);
  assert.equal(Check(EffectDescriptorSchema, {
    ...descriptor,
    argumentDigest: "sha256:0123456789abcdef",
  }), false, "an abbreviated digest cannot bind exact arguments");

  const missingDestructiveEvaluation = structuredClone(descriptor);
  delete missingDestructiveEvaluation.destructiveEvaluation;
  assert.equal(Check(EffectDescriptorSchema, missingDestructiveEvaluation), false);
  assert.equal(Check(EffectDescriptorSchema, {
    ...descriptor,
    destructiveRuleVersion: "destructive-rules-v1",
  }), false, "a rule version alone is not a destructive-action evaluation");
});

test("effect and permission mode values reject unknown policy axes", () => {
  assert.equal(Check(EffectDescriptorSchema, {
    ...descriptor,
    effectClass: "network_write",
  }), false);
  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...decision,
    mode: { mode: "unrestricted" },
  }), false);
});

test("all three authorization dispositions have strict decision records", () => {
  assert.equal(Check(EffectAuthorizationDispositionSchema, "authorized"), true);
  assert.equal(Check(EffectAuthorizationDispositionSchema, "approval_required"), true);
  assert.equal(Check(EffectAuthorizationDispositionSchema, "denied"), true);
  assert.equal(Check(EffectAuthorizationDispositionSchema, "allowed"), false);

  assert.equal(Check(ActionAuthorizationDecisionSchema, decision), true);
  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...decision,
    disposition: "approval_required",
    reasonCode: "human_approval_required",
    approvalId: "approval-effect-send-message",
  }), true);
  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...decision,
    disposition: "denied",
    reasonCode: "effect_not_permitted",
  }), true);
});

test("approval-required decisions bind a stable approval to the decision", () => {
  const approvalRequired = {
    ...decision,
    disposition: "approval_required",
    reasonCode: "human_approval_required",
  };
  assert.equal(Check(ActionAuthorizationDecisionSchema, approvalRequired), false);
  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...approvalRequired,
    approvalId: "*",
  }), false);
  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...approvalRequired,
    approvalId: "approval-effect-send-message",
  }), true);

  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...decision,
    disposition: "denied",
    reasonCode: "effect_not_permitted",
    approvalId: "approval-effect-send-message",
  }), false, "a denial cannot masquerade as an approval-bound decision");
});

test("the strict contract has no generic destructive bypass", () => {
  for (const field of ["allowAll", "allowDestructive", "destructiveBypass"]) {
    assert.equal(Check(EffectDescriptorSchema, {
      ...descriptor,
      [field]: true,
    }), false, `accepted forbidden ${field} field`);
  }

  assert.equal(Check(ActionAuthorizationDecisionSchema, {
    ...decision,
    bypassPolicy: true,
  }), false);
});

test("hard-denied destructive evaluations cannot be approved", () => {
  const hardDeniedDescriptor = {
    ...descriptor,
    destructiveEvaluation: {
      status: "hard_denied",
      ruleVersion: "destructive-rules-v1",
      reasonCode: "recursive_delete_forbidden",
    },
  };
  assert.equal(Check(
    DestructiveEvaluationSchema,
    hardDeniedDescriptor.destructiveEvaluation,
  ), true);
  assert.equal(Check(DestructiveEvaluationSchema, {
    status: "hard_denied",
    ruleVersion: "destructive-rules-v1",
  }), false);
  assert.equal(Check(DestructiveEvaluationSchema, {
    status: "clear",
    ruleVersion: "destructive-rules-v1",
    bypass: true,
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: hardDeniedDescriptor,
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: hardDeniedDescriptor,
    disposition: "approval_required",
    approvalId: "approval-destructive-effect",
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: hardDeniedDescriptor,
    disposition: "denied",
    reasonCode: "destructive_action_hard_denied",
  }), true);
});

test("semantic validation binds authority lineage to the same decision", () => {
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: { ...descriptor, effectClass: "read" },
    lineage: {
      ...lineage,
      authorizationDecisionId: "decision-other-effect",
    },
  }), false);
});

test("an independent human authorizer requires a decision-bound approval", () => {
  const reviewedRead = {
    ...decision,
    mode: { mode: "discuss" },
    descriptor: { ...descriptor, effectClass: "read" },
    lineage: {
      ...lineage,
      authorizedBy: {
        kind: "principal",
        principal: { principalId: "user-bob", kind: "user" },
      },
    },
  };
  assert.equal(isActionAuthorizationDecisionSemanticallyValid(reviewedRead), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...reviewedRead,
    approvalId: undefined,
  }), false, "an undefined approval value is not an approval");
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...reviewedRead,
    approvalId: "approval-bob-reviewed-alice-effect",
  }), true);
});

test("interactive writes require a concrete approval identifier", () => {
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    approvalId: undefined,
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    approvalId: "approval-effect-send-message",
  }), true);
});

test("discuss and plan modes are read-only without redundant approval", () => {
  for (const mode of ["discuss", "plan"]) {
    assert.equal(isActionAuthorizationDecisionSemanticallyValid({
      ...decision,
      mode: { mode },
      descriptor: { ...descriptor, effectClass: "execute" },
    }), false);
    assert.equal(isActionAuthorizationDecisionSemanticallyValid({
      ...decision,
      mode: { mode },
      descriptor: { ...descriptor, effectClass: "execute" },
      disposition: "approval_required",
      approvalId: `approval-${mode}`,
    }), false);
    assert.equal(isActionAuthorizationDecisionSemanticallyValid({
      ...decision,
      mode: { mode },
      descriptor: { ...descriptor, effectClass: "execute" },
      disposition: "denied",
      reasonCode: "mode_is_read_only",
    }), true);
    assert.equal(isActionAuthorizationDecisionSemanticallyValid({
      ...decision,
      mode: { mode },
      descriptor: { ...descriptor, effectClass: "read" },
      disposition: "approval_required",
      approvalId: `approval-read-${mode}`,
    }), false);
    assert.equal(isActionAuthorizationDecisionSemanticallyValid({
      ...decision,
      mode: { mode },
      descriptor: { ...descriptor, effectClass: "read" },
    }), true);
  }
});

test("interactive writes require a decision-bound approval", () => {
  assert.equal(isActionAuthorizationDecisionSemanticallyValid(decision), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    approvalId: "approval-effect-send-message",
  }), true);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: { ...descriptor, effectClass: "read" },
  }), true);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: { ...descriptor, effectClass: "administrative" },
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...decision,
    descriptor: { ...descriptor, effectClass: "administrative" },
    approvalId: "approval-administrative-effect",
  }), true);
});

test("auto mode authorizes only listed non-administrative effect classes", () => {
  const autoDecision = {
    ...decision,
    lineage: policyGrantLineage,
    mode: {
      mode: "auto",
      autoApprovedEffectClasses: ["external_write"],
    },
  };
  assert.equal(isActionAuthorizationDecisionSemanticallyValid(autoDecision), true);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...autoDecision,
    descriptor: { ...descriptor, effectClass: "execute" },
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...autoDecision,
    mode: {
      mode: "auto",
      autoApprovedEffectClasses: ["administrative"],
    },
    descriptor: { ...descriptor, effectClass: "administrative" },
  }), false);
});

test("custom mode authorizes only its exact non-administrative action IDs", () => {
  const customDecision = {
    ...decision,
    lineage: policyGrantLineage,
    mode: {
      mode: "custom",
      autoApprovedActionIds: [descriptor.actionId],
    },
  };
  assert.equal(isActionAuthorizationDecisionSemanticallyValid(customDecision), true);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...customDecision,
    descriptor: { ...descriptor, actionId: "lark.task.update" },
  }), false);
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...customDecision,
    descriptor: { ...descriptor, effectClass: "administrative" },
  }), false);
});

test("auto and custom modes reject principal or mismatched grant authority", () => {
  const autoDecision = {
    ...decision,
    lineage: policyGrantLineage,
    mode: {
      mode: "auto",
      autoApprovedEffectClasses: ["external_write"],
    },
  };
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...autoDecision,
    lineage,
  }), false, "a principal cannot stand in for an auto-mode policy grant");
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...autoDecision,
    lineage: {
      ...policyGrantLineage,
      authorizedBy: {
        ...policyGrantLineage.authorizedBy,
        subject: { principalId: "user-bob", kind: "user" },
      },
    },
  }), false, "the grant subject must be the effective principal");
  assert.equal(isActionAuthorizationDecisionSemanticallyValid({
    ...autoDecision,
    lineage: {
      ...policyGrantLineage,
      authorizedBy: {
        ...policyGrantLineage.authorizedBy,
        scopeId: "scope-other-project",
      },
    },
  }), false, "the grant scope must match the authority lineage");
});
