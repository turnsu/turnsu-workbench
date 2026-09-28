import { Type } from "typebox";

import { ClientSessionIdSchema, InvitationIdSchema, UserIdSchema } from "./common.js";
import {
  EmptyHeadersSchema,
  EmptyObjectSchema,
  IdempotencyHeadersSchema,
  ListResponseEnvelopeSchema,
  MutationRequestEnvelopeSchema,
  ResponseEnvelopeSchema,
  type WorkbenchEndpointMetadata,
  WORKBENCH_API_PREFIX,
} from "./endpoint-core.js";
import {
  AuthPasswordSchema,
  AuthResultSchema,
  AuthStatusSchema,
  AuthUsernameSchema,
  InvitationAcceptanceSchema,
  InvitationEmailSchema,
  NativeAuthorizationSchema,
  NativeClientKindSchema,
  NativeClientSessionSummarySchema,
  NativeTokenSetSchema,
  OAuthProviderSchema,
  AuthUserSchema,
  UpdateMemberResultSchema,
  WorkspaceInvitationSchema,
} from "./auth.js";
import { strictObject } from "./schema.js";

const readMetadata = {
  mutation: false,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const idempotentMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: IdempotencyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: ["Idempotency-Key"],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const browserMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const nativePublicMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const nativeBrowserApprovalMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: EmptyHeadersSchema,
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: [],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const nativeTokenMutationMetadata = {
  mutation: true,
  successStatus: 200,
  responseMediaType: "application/json",
  requestHeadersSchema: strictObject({
    Authorization: Type.String({ minLength: 40, maxLength: 1024, pattern: "^Bearer [A-Za-z0-9_-]{32,512}$" }),
  }),
  responseHeadersSchema: EmptyHeadersSchema,
  requiredRequestHeaders: ["Authorization"],
  optionalRequestHeaders: [],
  responseHeaders: [],
} as const;

const NoStoreHeadersSchema = strictObject({
  "Cache-Control": Type.Literal("no-store"),
});

const noStoreResponseMetadata = {
  responseHeadersSchema: NoStoreHeadersSchema,
  responseHeaders: ["Cache-Control"],
} as const;

export const RegisterRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    username: AuthUsernameSchema,
    password: AuthPasswordSchema,
    bootstrapToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }),
  "RegisterRequest",
);

export const LoginRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    username: AuthUsernameSchema,
    password: AuthPasswordSchema,
  }),
  "LoginRequest",
);

export const LogoutRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "LogoutRequest",
);

export const UpdateMemberRequestSchema = MutationRequestEnvelopeSchema(
  strictObject(
    {
      role: Type.Optional(Type.Union([Type.Literal("admin"), Type.Literal("member")])),
      disabled: Type.Optional(Type.Boolean()),
    },
    { minProperties: 1 },
  ),
  "UpdateMemberRequest",
);

export const CreateInvitationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({ email: InvitationEmailSchema }),
  "CreateInvitationRequest",
);

export const RevokeInvitationRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "RevokeInvitationRequest",
);

export const ResendInvitationRequestSchema = MutationRequestEnvelopeSchema(
  EmptyObjectSchema,
  "ResendInvitationRequest",
);

export const InspectInvitationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({ token: Type.String({ minLength: 16, maxLength: 2048 }) }),
  "InspectInvitationRequest",
);

export const StartOAuthRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    token: Type.String({ minLength: 16, maxLength: 2048 }),
    bindExistingAccount: Type.Optional(Type.Boolean()),
  }),
  "StartOAuthRequest",
);

export const StartNativeAuthorizationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    clientKind: NativeClientKindSchema,
    redirectUri: Type.String({ minLength: 1, maxLength: 2048, format: "uri" }),
    codeChallenge: Type.String({ minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    devicePublicKey: Type.String({ minLength: 43, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
  }),
  "StartNativeAuthorizationRequest",
);

export const CompleteNativeAuthorizationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    authorizationId: Type.String({ minLength: 1, maxLength: 128 }),
    authorizationCode: Type.String({ minLength: 32, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" }),
    codeVerifier: Type.String({ minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" }),
    devicePublicKey: Type.String({ minLength: 43, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
  }),
  "CompleteNativeAuthorizationRequest",
);

export const ApproveNativeAuthorizationRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    authorizationId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  "ApproveNativeAuthorizationRequest",
);

export const RefreshNativeTokenRequestSchema = MutationRequestEnvelopeSchema(
  strictObject({
    refreshToken: Type.String({ minLength: 32, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" }),
  }),
  "RefreshNativeTokenRequest",
);

const MemberPathParamsSchema = strictObject({ userId: UserIdSchema });
const InvitationPathParamsSchema = strictObject({ invitationId: InvitationIdSchema });
const OAuthProviderPathParamsSchema = strictObject({ provider: OAuthProviderSchema });
const OAuthCallbackQuerySchema = strictObject({
  state: Type.Optional(Type.String({ minLength: 16, maxLength: 2048 })),
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  error: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  error_description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  error_uri: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  authuser: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

export const WORKBENCH_V1_AUTH_ENDPOINTS = {
  authStatus: {
    ...readMetadata,
    ...noStoreResponseMetadata,
    operationId: "authStatus",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/auth/status`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ResponseEnvelopeSchema(AuthStatusSchema, "AuthStatusResponse"),
  },
  register: {
    ...idempotentMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "register",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/register`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RegisterRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(AuthResultSchema, "RegisterResponse"),
  },
  login: {
    ...browserMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "login",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/login`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: LoginRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(AuthResultSchema, "LoginResponse"),
  },
  logout: {
    ...browserMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "logout",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/logout`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: LogoutRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ revoked: Type.Boolean() }),
      "LogoutResponse",
    ),
  },
  listMembers: {
    ...readMetadata,
    operationId: "listMembers",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/members`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ListResponseEnvelopeSchema(AuthUserSchema, "MemberListResponse"),
  },
  updateMember: {
    ...idempotentMutationMetadata,
    operationId: "updateMember",
    method: "PATCH",
    path: `${WORKBENCH_API_PREFIX}/members/{userId}`,
    pathParamsSchema: MemberPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: UpdateMemberRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(UpdateMemberResultSchema, "UpdateMemberResponse"),
  },
  listInvitations: {
    ...readMetadata,
    ...noStoreResponseMetadata,
    operationId: "listInvitations",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/workspace/invitations`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ListResponseEnvelopeSchema(WorkspaceInvitationSchema, "InvitationListResponse"),
  },
  createInvitation: {
    ...idempotentMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "createInvitation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workspace/invitations`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CreateInvitationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ invitation: WorkspaceInvitationSchema }),
      "CreateInvitationResponse",
    ),
  },
  revokeInvitation: {
    ...idempotentMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "revokeInvitation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workspace/invitations/{invitationId}/revoke`,
    pathParamsSchema: InvitationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RevokeInvitationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ invitation: WorkspaceInvitationSchema }),
      "RevokeInvitationResponse",
    ),
  },
  resendInvitation: {
    ...idempotentMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "resendInvitation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/workspace/invitations/{invitationId}/resend`,
    successStatus: 201,
    pathParamsSchema: InvitationPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ResendInvitationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ invitation: WorkspaceInvitationSchema }),
      "ResendInvitationResponse",
    ),
  },
  inspectInvitation: {
    ...browserMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "inspectInvitation",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/invitations/inspect`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: InspectInvitationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(InvitationAcceptanceSchema, "InspectInvitationResponse"),
  },
  startOAuth: {
    ...browserMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "startOAuth",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/oauth/{provider}/start`,
    pathParamsSchema: OAuthProviderPathParamsSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: StartOAuthRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ authorizationUrl: Type.String({ minLength: 1, maxLength: 4096 }) }),
      "StartOAuthResponse",
    ),
  },
  completeOAuth: {
    // This is the OAuth provider's browser redirect. It changes durable state,
    // but has no JSON request body and is protected by one-time signed state,
    // not by same-origin CSRF headers.
    ...readMetadata,
    ...noStoreResponseMetadata,
    operationId: "completeOAuth",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/auth/oauth/{provider}/callback`,
    pathParamsSchema: OAuthProviderPathParamsSchema,
    querySchema: OAuthCallbackQuerySchema,
    responseBodySchema: ResponseEnvelopeSchema(AuthResultSchema, "CompleteOAuthResponse"),
  },
  startNativeAuthorization: {
    ...nativePublicMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "startNativeAuthorization",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/authorize`,
    successStatus: 201,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: StartNativeAuthorizationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(NativeAuthorizationSchema, "StartNativeAuthorizationResponse"),
  },
  completeNativeAuthorization: {
    ...nativePublicMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "completeNativeAuthorization",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/token`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: CompleteNativeAuthorizationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(NativeTokenSetSchema, "CompleteNativeAuthorizationResponse"),
  },
  approveNativeAuthorization: {
    ...nativeBrowserApprovalMetadata,
    ...noStoreResponseMetadata,
    operationId: "approveNativeAuthorization",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/approve`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: ApproveNativeAuthorizationRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ redirectUrl: Type.String({ minLength: 1, maxLength: 4096 }) }),
      "ApproveNativeAuthorizationResponse",
    ),
  },
  refreshNativeToken: {
    ...nativePublicMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "refreshNativeToken",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/refresh`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: RefreshNativeTokenRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(NativeTokenSetSchema, "RefreshNativeTokenResponse"),
  },
  listOwnNativeClientSessions: {
    ...readMetadata,
    ...noStoreResponseMetadata,
    operationId: "listOwnNativeClientSessions",
    method: "GET",
    path: `${WORKBENCH_API_PREFIX}/auth/native/sessions`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    responseBodySchema: ListResponseEnvelopeSchema(NativeClientSessionSummarySchema, "OwnNativeClientSessionsResponse"),
  },
  revokeOwnNativeClientSession: {
    ...browserMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "revokeOwnNativeClientSession",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/sessions/{clientSessionId}/revoke`,
    pathParamsSchema: strictObject({ clientSessionId: ClientSessionIdSchema }),
    querySchema: EmptyObjectSchema,
    requestBodySchema: LogoutRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(strictObject({ revoked: Type.Boolean() }), "RevokeOwnNativeClientSessionResponse"),
  },
  revokeNativeClientSession: {
    ...nativeTokenMutationMetadata,
    ...noStoreResponseMetadata,
    operationId: "revokeNativeClientSession",
    method: "POST",
    path: `${WORKBENCH_API_PREFIX}/auth/native/revoke`,
    pathParamsSchema: EmptyObjectSchema,
    querySchema: EmptyObjectSchema,
    requestBodySchema: LogoutRequestSchema,
    responseBodySchema: ResponseEnvelopeSchema(
      strictObject({ revoked: Type.Boolean() }),
      "RevokeNativeClientSessionResponse",
    ),
  },
} as const satisfies Record<string, WorkbenchEndpointMetadata>;
