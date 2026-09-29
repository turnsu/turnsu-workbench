import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
  AuthorityLineageSchema,
  checkAuthorityLineageSemantics,
} from "./authority.js";
import {
  AuthorizationDecisionIdSchema,
  ConnectionIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";
import {
  EffectClassSchema,
  PermissionModeConfigSchema,
} from "./scopes.js";

export const EFFECT_AUTHORIZATION_DISPOSITIONS = [
  "authorized",
  "approval_required",
  "denied",
] as const;

export const EffectAuthorizationDispositionSchema = stringEnum(
  EFFECT_AUTHORIZATION_DISPOSITIONS,
);

const StableReasonCodeSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9_]*$",
});

export const DestructiveEvaluationSchema = Type.Union(
  [
    strictObject({
      status: Type.Literal("clear"),
      ruleVersion: StableIdSchema,
    }),
    strictObject({
      status: Type.Literal("hard_denied"),
      ruleVersion: StableIdSchema,
      reasonCode: StableReasonCodeSchema,
    }),
  ],
  { $id: "DestructiveEvaluation" },
);

export const EffectDescriptorSchema = strictObject(
  {
    actionId: StableIdSchema,
    effectClass: EffectClassSchema,
    argumentDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    resourceRefs: Type.Optional(
      Type.Array(StableIdSchema, {
        maxItems: 128,
        uniqueItems: true,
      }),
    ),
    connectionId: Type.Optional(ConnectionIdSchema),
    destructiveEvaluation: DestructiveEvaluationSchema,
  },
  { $id: "EffectDescriptor" },
);

const decisionBase = {
  decisionId: AuthorizationDecisionIdSchema,
  descriptor: EffectDescriptorSchema,
  mode: PermissionModeConfigSchema,
  reasonCode: StableReasonCodeSchema,
  lineage: AuthorityLineageSchema,
  decidedAt: UtcTimestampSchema,
  expiresAt: Type.Optional(UtcTimestampSchema),
};

export const ActionAuthorizationDecisionSchema = Type.Union(
  [
    strictObject({
      ...decisionBase,
      disposition: Type.Literal("authorized"),
      approvalId: Type.Optional(StableIdSchema),
    }),
    strictObject({
      ...decisionBase,
      disposition: Type.Literal("approval_required"),
      approvalId: StableIdSchema,
    }),
    strictObject({
      ...decisionBase,
      disposition: Type.Literal("denied"),
    }),
  ],
  { $id: "ActionAuthorizationDecision" },
);

export function isActionAuthorizationDecisionSemanticallyValid(
  value: unknown,
): value is ActionAuthorizationDecision {
  if (!Check(ActionAuthorizationDecisionSchema, value)) return false;

  const { descriptor, disposition, mode } = value;
  const hasApproval =
    "approvalId" in value && typeof value.approvalId === "string";
  if (!checkAuthorityLineageSemantics(value.lineage)) return false;
  if (value.decisionId !== value.lineage.authorizationDecisionId) return false;
  if (
    disposition === "authorized" &&
    value.lineage.authorizedBy.kind === "principal" &&
    !samePrincipal(
      value.lineage.authorizedBy.principal,
      value.lineage.effectivePrincipal,
    ) &&
    !hasApproval
  ) {
    return false;
  }
  if (
    disposition === "authorized" &&
    (mode.mode === "auto" || mode.mode === "custom") &&
    value.lineage.authorizedBy.kind !== "policy_grant"
  ) {
    return false;
  }
  if (descriptor.destructiveEvaluation.status === "hard_denied") {
    return disposition === "denied";
  }

  if (mode.mode === "discuss" || mode.mode === "plan") {
    if (descriptor.effectClass !== "read") return disposition === "denied";
    return disposition !== "approval_required";
  }

  if (disposition !== "authorized") return true;

  if (mode.mode === "interactive") {
    return descriptor.effectClass === "read" || hasApproval;
  }

  if (descriptor.effectClass === "administrative") return false;
  if (mode.mode === "auto") {
    return mode.autoApprovedEffectClasses.includes(descriptor.effectClass);
  }
  if (mode.mode === "custom") {
    return mode.autoApprovedActionIds.includes(descriptor.actionId);
  }

  return false;
}

function samePrincipal(
  left: { principalId: string; kind: string },
  right: { principalId: string; kind: string },
) {
  return left.principalId === right.principalId && left.kind === right.kind;
}

export type EffectAuthorizationDisposition = Static<
  typeof EffectAuthorizationDispositionSchema
>;
export type DestructiveEvaluation = Static<
  typeof DestructiveEvaluationSchema
>;
export type EffectDescriptor = Static<typeof EffectDescriptorSchema>;
export type ActionAuthorizationDecision = Static<
  typeof ActionAuthorizationDecisionSchema
>;
