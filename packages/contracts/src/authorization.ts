import { Type, type Static } from "typebox";

import {
  SessionIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  VersionSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { WorkspaceRoleSchema } from "./workspace-role.js";
import { strictObject, stringEnum } from "./schema.js";

export const PRINCIPAL_KINDS = [
  "user",
  "automation",
  "connector",
  "scheduler",
  "system",
] as const;

export const OBJECT_ACCESS_ROLES = [
  "owner",
  "maintainer",
  "editor",
  "reviewer",
  "viewer",
] as const;

export const AUTHORIZATION_OPERATIONS = [
  "discover",
  "read",
  "read_content",
  "read_events",
  "create",
  "update",
  "review",
  "execute",
  "publish",
  "delete",
  "share",
  "manage_access",
] as const;

export const AUTHORIZATION_CAPABILITIES = [
  "object.execute",
  "object.publish",
  "object.delete",
  "object.share",
  "object.manage_access",
] as const;

export const PrincipalKindSchema = stringEnum(PRINCIPAL_KINDS);
export const ObjectAccessRoleSchema = stringEnum(OBJECT_ACCESS_ROLES);
export const AuthorizationOperationSchema = stringEnum(AUTHORIZATION_OPERATIONS);
export const AuthorizationCapabilitySchema = stringEnum(AUTHORIZATION_CAPABILITIES);

/**
 * Accepted only while persisted memberships are converged to WorkspaceRoleSchema.
 * Product API responses and all new writes use the canonical schema.
 */
export const CompatibleWorkspaceRoleSchema = Type.Union([
  WorkspaceRoleSchema,
  Type.Literal("maintainer"),
]);

export const PrincipalContextSchema = strictObject(
  {
    principalId: StableIdSchema,
    kind: PrincipalKindSchema,
    workspaceId: WorkspaceIdSchema,
    workspaceRole: CompatibleWorkspaceRoleSchema,
    sessionId: Type.Optional(SessionIdSchema),
    capabilities: Type.Array(AuthorizationCapabilitySchema, {
      maxItems: AUTHORIZATION_CAPABILITIES.length,
      uniqueItems: true,
    }),
  },
  { $id: "PrincipalContext" },
);

export const ObjectAccessGrantSchema = strictObject(
  {
    principalId: StableIdSchema,
    role: ObjectAccessRoleSchema,
  },
  { $id: "ObjectAccessGrant" },
);

/**
 * Durable authority record. AuthorizationTarget.grants intentionally remains a
 * role-only projection so persistence metadata never leaks into policy inputs.
 */
export const ObjectAccessGrantRecordSchema = strictObject(
  {
    grantId: StableIdSchema,
    workspaceId: WorkspaceIdSchema,
    objectKind: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_]*$",
    }),
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
  { $id: "ObjectAccessGrantRecord" },
);

export const AuthorizationTargetSchema = strictObject(
  {
    objectKind: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z][a-z0-9_]*$",
    }),
    objectId: StableIdSchema,
    workspaceId: WorkspaceIdSchema,
    scopeId: Type.Optional(StableIdSchema),
    version: Type.Optional(VersionSchema),
    ownerPrincipalId: StableIdSchema,
    visibility: stringEnum(["private", "workspace"]),
    grants: Type.Array(ObjectAccessGrantSchema, { maxItems: 256 }),
  },
  { $id: "AuthorizationTarget" },
);

export const ObjectAccessRequestSchema = strictObject(
  {
    principal: PrincipalContextSchema,
    target: Type.Union([AuthorizationTargetSchema, Type.Null()]),
    operation: AuthorizationOperationSchema,
  },
  { $id: "ObjectAccessRequest" },
);

export const ObjectAccessDecisionSchema = Type.Union([
  strictObject({
    allowed: Type.Literal(true),
    code: Type.Literal("authorized"),
    objectRole: ObjectAccessRoleSchema,
  }),
  strictObject({
    allowed: Type.Literal(false),
    code: Type.Literal("object_not_found_or_forbidden"),
  }),
], { $id: "ObjectAccessDecision" });

export type PrincipalKind = Static<typeof PrincipalKindSchema>;
export type PrincipalContext = Static<typeof PrincipalContextSchema>;
export type WorkspaceRoleInput = Static<typeof CompatibleWorkspaceRoleSchema>;
export type ObjectAccessRole = Static<typeof ObjectAccessRoleSchema>;
export type AuthorizationOperation = Static<typeof AuthorizationOperationSchema>;
export type AuthorizationCapability = Static<typeof AuthorizationCapabilitySchema>;
export type ObjectAccessGrant = Static<typeof ObjectAccessGrantSchema>;
export type ObjectAccessGrantRecord = Static<typeof ObjectAccessGrantRecordSchema>;
export type AuthorizationTarget = Static<typeof AuthorizationTargetSchema>;
export type ObjectAccessRequest = Static<typeof ObjectAccessRequestSchema>;
export type ObjectAccessDecision = Static<typeof ObjectAccessDecisionSchema>;
