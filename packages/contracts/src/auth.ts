import { Type, type Static } from "typebox";

import {
  ClientSessionIdSchema,
  InvitationIdSchema,
  NativeAuthorizationIdSchema,
  UserIdSchema,
  UtcTimestampSchema,
  WorkspaceIdSchema,
} from "./common.js";
import { strictObject, stringEnum } from "./schema.js";

export const ACCOUNT_ROLES = ["admin", "member"] as const;
export const AccountRoleSchema = stringEnum(ACCOUNT_ROLES);

/** @deprecated Use AccountRoleSchema; object and workspace authority are separate. */
export const AuthRoleSchema = AccountRoleSchema;

export const AuthUsernameSchema = Type.String({
  minLength: 3,
  maxLength: 32,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$",
});

export const AuthPasswordSchema = Type.String({
  minLength: 8,
  maxLength: 128,
});

export const InvitationEmailSchema = Type.String({
  minLength: 3,
  maxLength: 320,
  pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
});

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export const OAuthProviderSchema = stringEnum(OAUTH_PROVIDERS);

export const InvitationDeliveryStatusSchema = stringEnum([
  "queued",
  "leased",
  "delivered",
  "failed",
] as const);

export const WorkspaceInvitationSchema = strictObject(
  {
    invitationId: InvitationIdSchema,
    workspaceId: WorkspaceIdSchema,
    email: InvitationEmailSchema,
    role: Type.Literal("member"),
    status: stringEnum(["pending", "accepted", "revoked", "expired"] as const),
    expiresAt: UtcTimestampSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    deliveryStatus: Type.Optional(InvitationDeliveryStatusSchema),
  },
  { $id: "WorkspaceInvitation" },
);

export const InvitationAcceptanceSchema = strictObject(
  {
    invitationId: InvitationIdSchema,
    expiresAt: UtcTimestampSchema,
    providers: Type.Array(OAuthProviderSchema, { minItems: 1, maxItems: 2 }),
  },
  { $id: "InvitationAcceptance" },
);

export const AuthUserSchema = strictObject(
  {
    userId: UserIdSchema,
    username: AuthUsernameSchema,
    role: AuthRoleSchema,
    disabled: Type.Boolean(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  },
  { $id: "AuthUser" },
);

const AuthStatusBaseSchema = {
  registrationOpen: Type.Boolean(),
  bootstrapRequired: Type.Boolean(),
  bootstrapAvailable: Type.Boolean(),
};

export const AuthStatusSchema = Type.Union(
  [
    strictObject({
      ...AuthStatusBaseSchema,
      authenticated: Type.Literal(false),
    }),
    strictObject({
      ...AuthStatusBaseSchema,
      authenticated: Type.Literal(true),
      user: AuthUserSchema,
      workspaceId: WorkspaceIdSchema,
    }),
  ],
  { $id: "AuthStatus" },
);

export const AuthResultSchema = strictObject(
  {
    user: AuthUserSchema,
    workspaceId: WorkspaceIdSchema,
  },
  { $id: "AuthResult" },
);

export const NativeClientKindSchema = stringEnum([
  "desktop",
  "mobile",
] as const);

export const NativeAuthorizationSchema = strictObject(
  {
    authorizationId: NativeAuthorizationIdSchema,
    expiresAt: UtcTimestampSchema,
    authorizationUrl: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { $id: "NativeAuthorization" },
);

export const NativeClientSessionSummarySchema = strictObject({
  clientSessionId: ClientSessionIdSchema,
  clientKind: NativeClientKindSchema,
  createdAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
}, { $id: "NativeClientSessionSummary" });

export const NativeTokenSetSchema = strictObject(
  {
    accessToken: Type.String({ minLength: 32, maxLength: 512 }),
    accessTokenExpiresAt: UtcTimestampSchema,
    refreshToken: Type.String({ minLength: 32, maxLength: 512 }),
    refreshTokenExpiresAt: UtcTimestampSchema,
    clientSessionId: ClientSessionIdSchema,
    workspaceId: WorkspaceIdSchema,
  },
  { $id: "NativeTokenSet" },
);

export const UpdateMemberResultSchema = strictObject(
  {
    user: AuthUserSchema,
    workspaceId: WorkspaceIdSchema,
  },
  { $id: "UpdateMemberResult" },
);

export type AccountRole = Static<typeof AccountRoleSchema>;
/** @deprecated Use AccountRole. */
export type AuthRole = AccountRole;
export type AuthUser = Static<typeof AuthUserSchema>;
export type AuthStatus = Static<typeof AuthStatusSchema>;
export type AuthResult = Static<typeof AuthResultSchema>;
export type NativeClientKind = Static<typeof NativeClientKindSchema>;
export type NativeAuthorization = Static<typeof NativeAuthorizationSchema>;
export type NativeTokenSet = Static<typeof NativeTokenSetSchema>;
