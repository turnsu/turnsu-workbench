import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

import {
  AuthorizationDecisionIdSchema,
  PolicyGrantIdSchema,
  PolicyRevisionIdSchema,
  ScopeIdSchema,
  SessionIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  VersionSchema,
  WorkspaceIdSchema,
} from "./common.js";
import {
  AUTHORIZATION_CAPABILITIES,
  AuthorizationCapabilitySchema,
  AuthorizationOperationSchema,
  ObjectAccessGrantSchema,
  ObjectAccessRoleSchema,
  PrincipalKindSchema,
} from "./authorization.js";
import { WorkspaceRoleSchema } from "./workspace-role.js";
import { strictObject, stringEnum } from "./schema.js";
import { PermissionModeConfigSchema } from "./scopes.js";

export const PrincipalRefSchema = strictObject(
  {
    principalId: StableIdSchema,
    kind: PrincipalKindSchema,
  },
  { $id: "PrincipalRef" },
);

const UserPrincipalRefSchema = strictObject({
  principalId: StableIdSchema,
  kind: Type.Literal("user"),
});

const NonUserPrincipalRefSchema = strictObject({
  principalId: StableIdSchema,
  kind: stringEnum(["automation", "connector", "scheduler", "system"]),
});

export const PrincipalAuthorizationSourceSchema = strictObject(
  {
    kind: Type.Literal("principal"),
    principal: PrincipalRefSchema,
  },
  { $id: "PrincipalAuthorizationSource" },
);

export const PolicyGrantAuthorizationSourceSchema = strictObject(
  {
    kind: Type.Literal("policy_grant"),
    policyGrantId: PolicyGrantIdSchema,
    subject: PrincipalRefSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
  },
  { $id: "PolicyGrantAuthorizationSource" },
);

export const AuthorizationSourceSchema = Type.Union(
  [PrincipalAuthorizationSourceSchema, PolicyGrantAuthorizationSourceSchema],
  { $id: "AuthorizationSource" },
);

/**
 * Product authority provenance. Product display names intentionally live outside
 * this record so UI metadata cannot become an authorization input.
 */
export const AuthorityLineageSchema = strictObject(
  {
    actor: PrincipalRefSchema,
    effectivePrincipal: PrincipalRefSchema,
    authorizedBy: AuthorizationSourceSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    policyRevisionId: PolicyRevisionIdSchema,
    authorizationDecisionId: AuthorizationDecisionIdSchema,
  },
  { $id: "AuthorityLineage" },
);

const resolvedPrincipalFields = {
  actor: PrincipalRefSchema,
  authorizedBy: AuthorizationSourceSchema,
  workspaceId: WorkspaceIdSchema,
  scopeId: ScopeIdSchema,
  sessionId: Type.Optional(SessionIdSchema),
  capabilities: Type.Array(AuthorizationCapabilitySchema, {
    maxItems: AUTHORIZATION_CAPABILITIES.length,
    uniqueItems: true,
  }),
  permission: PermissionModeConfigSchema,
  policyRevisionId: PolicyRevisionIdSchema,
};

/**
 * Server-resolved context for policy evaluation. A human effective principal
 * carries a canonical workspace membership role. Service principals do not
 * borrow a human workspace role; their authority is represented by authorizedBy.
 */
export const ResolvedPrincipalContextV2Schema = Type.Union(
  [
    strictObject({
      ...resolvedPrincipalFields,
      effectivePrincipal: UserPrincipalRefSchema,
      workspaceRole: WorkspaceRoleSchema,
    }),
    strictObject({
      ...resolvedPrincipalFields,
      effectivePrincipal: NonUserPrincipalRefSchema,
      authorizedBy: PolicyGrantAuthorizationSourceSchema,
      workspaceRole: Type.Null(),
    }),
  ],
  { $id: "ResolvedPrincipalContextV2" },
);

const ObjectKindSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9_]*$",
});

export const AuthorizationTargetV2Schema = strictObject(
  {
    objectKind: ObjectKindSchema,
    objectId: StableIdSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    version: Type.Optional(VersionSchema),
    ownerPrincipalId: StableIdSchema,
    visibility: stringEnum(["private", "scope_readable"]),
    grants: Type.Array(ObjectAccessGrantSchema, { maxItems: 256 }),
  },
  { $id: "AuthorizationTargetV2" },
);

export const ObjectAccessGrantRecordV2Schema = strictObject(
  {
    grantId: StableIdSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: ScopeIdSchema,
    objectKind: ObjectKindSchema,
    objectId: StableIdSchema,
    principalId: StableIdSchema,
    role: ObjectAccessRoleSchema,
    capabilities: Type.Array(AuthorizationCapabilitySchema, {
      maxItems: AUTHORIZATION_CAPABILITIES.length,
      uniqueItems: true,
    }),
    grantedBy: StableIdSchema,
    revokedAt: Type.Union([UtcTimestampSchema, Type.Null()]),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "ObjectAccessGrantRecordV2" },
);

export const ObjectAccessRequestV2Schema = strictObject(
  {
    principal: ResolvedPrincipalContextV2Schema,
    target: Type.Union([AuthorizationTargetV2Schema, Type.Null()]),
    operation: AuthorizationOperationSchema,
  },
  { $id: "ObjectAccessRequestV2" },
);

export type PrincipalRef = Static<typeof PrincipalRefSchema>;
export type PrincipalAuthorizationSource = Static<
  typeof PrincipalAuthorizationSourceSchema
>;
export type PolicyGrantAuthorizationSource = Static<
  typeof PolicyGrantAuthorizationSourceSchema
>;
export type AuthorizationSource = Static<typeof AuthorizationSourceSchema>;
export type AuthorityLineage = Static<typeof AuthorityLineageSchema>;
export type ResolvedPrincipalContextV2 = Static<
  typeof ResolvedPrincipalContextV2Schema
>;
export type AuthorizationTargetV2 = Static<typeof AuthorizationTargetV2Schema>;
export type ObjectAccessGrantRecordV2 = Static<
  typeof ObjectAccessGrantRecordV2Schema
>;
export type ObjectAccessRequestV2 = Static<typeof ObjectAccessRequestV2Schema>;

function samePrincipal(
  left: { principalId: string; kind: string },
  right: { principalId: string; kind: string },
) {
  return left.principalId === right.principalId && left.kind === right.kind;
}

/**
 * Validates authority provenance without conflating an independent human
 * approver with the effective principal. Approval requirements are evaluated
 * by the effect policy layer; grant provenance is always scope-bound here.
 */
export function checkAuthorityLineageSemantics(
  value: unknown,
): value is AuthorityLineage {
  if (!Check(AuthorityLineageSchema, value)) {
    return false;
  }

  const lineage = value as AuthorityLineage;
  if (lineage.authorizedBy.kind === "principal") {
    return true;
  }

  return (
    samePrincipal(lineage.authorizedBy.subject, lineage.effectivePrincipal) &&
    lineage.authorizedBy.workspaceId === lineage.workspaceId &&
    lineage.authorizedBy.scopeId === lineage.scopeId &&
    lineage.authorizedBy.policyRevisionId === lineage.policyRevisionId
  );
}

/**
 * Checks the cross-field authority invariants intentionally not expressible in
 * the structural TypeBox union. This is not an ACL role evaluator.
 */
export function checkResolvedPrincipalContextV2Semantics(
  value: unknown,
): value is ResolvedPrincipalContextV2 {
  if (!Check(ResolvedPrincipalContextV2Schema, value)) {
    return false;
  }

  const context = value as ResolvedPrincipalContextV2;
  if (context.authorizedBy.kind === "principal") {
    return samePrincipal(
      context.authorizedBy.principal,
      context.effectivePrincipal,
    );
  }

  return (
    samePrincipal(context.authorizedBy.subject, context.effectivePrincipal) &&
    context.authorizedBy.workspaceId === context.workspaceId &&
    context.authorizedBy.scopeId === context.scopeId &&
    context.authorizedBy.policyRevisionId === context.policyRevisionId
  );
}

/**
 * Validates request-local isolation invariants before an object ACL evaluator
 * considers roles or capabilities.
 */
export function checkObjectAccessRequestV2Semantics(
  value: unknown,
): value is ObjectAccessRequestV2 {
  if (!Check(ObjectAccessRequestV2Schema, value)) {
    return false;
  }

  const request = value as ObjectAccessRequestV2;
  if (!checkResolvedPrincipalContextV2Semantics(request.principal)) {
    return false;
  }
  if (request.target === null) {
    return true;
  }

  return (
    request.principal.workspaceId === request.target.workspaceId &&
    request.principal.scopeId === request.target.scopeId
  );
}
