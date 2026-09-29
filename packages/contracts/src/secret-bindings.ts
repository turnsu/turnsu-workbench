import { Type, type Static, type TProperties } from "typebox";

import {
  ContentHashSchema,
  ScopeIdSchema,
  SecretBindingIdSchema,
  StableIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const SECRET_SOURCES = [
  "cloud_secret_store",
  "desktop_keychain",
] as const;

export const SECRET_BINDING_OWNER_KINDS = [
  "connection",
  "model_profile_revision",
  "automation",
] as const;

export const SECRET_BINDING_STATES = [
  "pending",
  "active",
  "expired",
  "revoked",
  "invalid",
] as const;

export const SecretSourceSchema = stringEnum(SECRET_SOURCES);
export const SecretBindingOwnerKindSchema = stringEnum(
  SECRET_BINDING_OWNER_KINDS,
);
export const SecretBindingStateSchema = stringEnum(SECRET_BINDING_STATES);

const internalBindingFields = {
  secretBindingId: SecretBindingIdSchema,
  workspaceId: WorkspaceIdSchema,
  scopeId: ScopeIdSchema,
  ownerKind: SecretBindingOwnerKindSchema,
  ownerId: StableIdSchema,
  secretSource: SecretSourceSchema,
  /** Internal-only opaque locator. Product API summaries must never expose it. */
  storeBindingRef: StableIdSchema,
  storeBindingRevision: Type.Integer({ minimum: 1 }),
  /** Internal comparison metadata. Product API summaries must never expose it. */
  credentialFingerprint: ContentHashSchema,
  createdBy: StableIdSchema,
  createdAt: UtcTimestampSchema,
};

const bindingStateVariants = <const Fields extends TProperties>(fields: Fields) =>
  [
    strictObject({
      ...fields,
      status: Type.Literal("pending"),
      expiresAt: Type.Optional(UtcTimestampSchema),
    }),
    strictObject({
      ...fields,
      status: Type.Literal("active"),
      probedAt: UtcTimestampSchema,
      expiresAt: Type.Optional(UtcTimestampSchema),
    }),
    strictObject({
      ...fields,
      status: Type.Literal("invalid"),
      probedAt: Type.Optional(UtcTimestampSchema),
      expiresAt: Type.Optional(UtcTimestampSchema),
    }),
    strictObject({
      ...fields,
      status: Type.Literal("expired"),
      probedAt: Type.Optional(UtcTimestampSchema),
      expiresAt: UtcTimestampSchema,
    }),
    strictObject({
      ...fields,
      status: Type.Literal("revoked"),
      probedAt: Type.Optional(UtcTimestampSchema),
      expiresAt: Type.Optional(UtcTimestampSchema),
      revokedAt: UtcTimestampSchema,
    }),
  ] as const;

export const SecretBindingSchema = Type.Union(
  [...bindingStateVariants(internalBindingFields)],
  { $id: "SecretBinding" },
);

const publicSummaryFields = {
  secretBindingId: SecretBindingIdSchema,
  workspaceId: WorkspaceIdSchema,
  scopeId: ScopeIdSchema,
  ownerKind: SecretBindingOwnerKindSchema,
  ownerId: StableIdSchema,
  secretSource: SecretSourceSchema,
  storeBindingRevision: Type.Integer({ minimum: 1 }),
  createdBy: StableIdSchema,
  createdAt: UtcTimestampSchema,
};

/** Product-safe metadata. Store locators, fingerprints, and secret values are omitted. */
export const PublicSecretBindingSummarySchema = Type.Union(
  [...bindingStateVariants(publicSummaryFields)],
  { $id: "PublicSecretBindingSummary" },
);

export type SecretSource = Static<typeof SecretSourceSchema>;
export type SecretBindingOwnerKind = Static<
  typeof SecretBindingOwnerKindSchema
>;
export type SecretBindingState = Static<typeof SecretBindingStateSchema>;
export type SecretBinding = Static<typeof SecretBindingSchema>;
export type PublicSecretBindingSummary = Static<
  typeof PublicSecretBindingSummarySchema
>;
