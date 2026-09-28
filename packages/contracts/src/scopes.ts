import { Type, type Static } from "typebox";

import {
  PolicyRevisionIdSchema,
  ProjectIdSchema,
  ScopeIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  UserIdSchema,
  WorkbenchSchemaVersionSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const SCOPE_KINDS = ["personal", "project"] as const;
export const SCOPE_OBSERVATION_TIERS = [
  "private",
  "workspace_readable",
  "observation_disabled",
] as const;
export const EFFECT_CLASSES = [
  "read",
  "write_local",
  "execute",
  "external_write",
  "administrative",
] as const;

export const ScopeKindSchema = stringEnum(SCOPE_KINDS);
export const ScopeObservationTierSchema = stringEnum(
  SCOPE_OBSERVATION_TIERS,
);
export const EffectClassSchema = stringEnum(EFFECT_CLASSES);

export const PermissionModeConfigSchema = Type.Union(
  [
    strictObject({ mode: Type.Literal("discuss") }),
    strictObject({ mode: Type.Literal("plan") }),
    strictObject({ mode: Type.Literal("interactive") }),
    strictObject({
      mode: Type.Literal("auto"),
      autoApprovedEffectClasses: Type.Array(EffectClassSchema, {
        minItems: 1,
        maxItems: EFFECT_CLASSES.length,
        uniqueItems: true,
      }),
    }),
    strictObject({
      mode: Type.Literal("custom"),
      autoApprovedActionIds: Type.Array(StableIdSchema, {
        minItems: 1,
        maxItems: 128,
        uniqueItems: true,
      }),
    }),
  ],
  { $id: "PermissionModeConfig" },
);

export const ScopePolicySchema = strictObject(
  {
    policyRevisionId: PolicyRevisionIdSchema,
    observationTier: ScopeObservationTierSchema,
    defaultPermission: PermissionModeConfigSchema,
  },
  { $id: "ScopePolicy" },
);

const scopeFields = {
  schemaVersion: WorkbenchSchemaVersionSchema,
  scopeId: ScopeIdSchema,
  workspaceId: WorkspaceIdSchema,
  policy: ScopePolicySchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
};

export const PersonalScopeSchema = strictObject(
  {
    ...scopeFields,
    kind: Type.Literal("personal"),
    ownerUserId: UserIdSchema,
  },
  { $id: "PersonalScope" },
);

export const ProjectScopeSchema = strictObject(
  {
    ...scopeFields,
    kind: Type.Literal("project"),
    projectId: ProjectIdSchema,
  },
  { $id: "ProjectScope" },
);

export const ProductScopeSchema = Type.Union(
  [PersonalScopeSchema, ProjectScopeSchema],
  { $id: "ProductScope" },
);

export type ScopeKind = Static<typeof ScopeKindSchema>;
export type ScopeObservationTier = Static<
  typeof ScopeObservationTierSchema
>;
export type EffectClass = Static<typeof EffectClassSchema>;
export type PermissionModeConfig = Static<typeof PermissionModeConfigSchema>;
export type ScopePolicy = Static<typeof ScopePolicySchema>;
export type PersonalScope = Static<typeof PersonalScopeSchema>;
export type ProjectScope = Static<typeof ProjectScopeSchema>;
export type ProductScope = Static<typeof ProductScopeSchema>;
