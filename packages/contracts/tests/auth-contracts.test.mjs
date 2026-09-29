import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthStatusSchema,
  Check,
  CreateInvitationRequestSchema,
  InvitationAcceptanceSchema,
  ApproveNativeAuthorizationRequestSchema,
  CompleteNativeAuthorizationRequestSchema,
  RegisterRequestSchema,
  RefreshNativeTokenRequestSchema,
  StartNativeAuthorizationRequestSchema,
  StartOAuthRequestSchema,
  UpdateMemberRequestSchema,
  WORKBENCH_V1_AUTH_ENDPOINTS,
} from "../dist/index.js";

test("auth endpoints separate public bootstrap/login from authenticated member management", () => {
  assert.deepEqual(
    Object.values(WORKBENCH_V1_AUTH_ENDPOINTS).map(({ operationId, method, path }) => ({
      operationId,
      method,
      path,
    })),
    [
      { operationId: "authStatus", method: "GET", path: "/api/workbench/v1/auth/status" },
      { operationId: "register", method: "POST", path: "/api/workbench/v1/auth/register" },
      { operationId: "login", method: "POST", path: "/api/workbench/v1/auth/login" },
      { operationId: "logout", method: "POST", path: "/api/workbench/v1/auth/logout" },
      { operationId: "listMembers", method: "GET", path: "/api/workbench/v1/members" },
      { operationId: "updateMember", method: "PATCH", path: "/api/workbench/v1/members/{userId}" },
      { operationId: "listInvitations", method: "GET", path: "/api/workbench/v1/workspace/invitations" },
      { operationId: "createInvitation", method: "POST", path: "/api/workbench/v1/workspace/invitations" },
      { operationId: "revokeInvitation", method: "POST", path: "/api/workbench/v1/workspace/invitations/{invitationId}/revoke" },
      { operationId: "resendInvitation", method: "POST", path: "/api/workbench/v1/workspace/invitations/{invitationId}/resend" },
      { operationId: "inspectInvitation", method: "POST", path: "/api/workbench/v1/auth/invitations/inspect" },
      { operationId: "startOAuth", method: "POST", path: "/api/workbench/v1/auth/oauth/{provider}/start" },
      { operationId: "completeOAuth", method: "GET", path: "/api/workbench/v1/auth/oauth/{provider}/callback" },
      { operationId: "startNativeAuthorization", method: "POST", path: "/api/workbench/v1/auth/native/authorize" },
      { operationId: "completeNativeAuthorization", method: "POST", path: "/api/workbench/v1/auth/native/token" },
      { operationId: "approveNativeAuthorization", method: "POST", path: "/api/workbench/v1/auth/native/approve" },
      { operationId: "refreshNativeToken", method: "POST", path: "/api/workbench/v1/auth/native/refresh" },
      { operationId: "listOwnNativeClientSessions", method: "GET", path: "/api/workbench/v1/auth/native/sessions" },
      { operationId: "revokeOwnNativeClientSession", method: "POST", path: "/api/workbench/v1/auth/native/sessions/{clientSessionId}/revoke" },
      { operationId: "revokeNativeClientSession", method: "POST", path: "/api/workbench/v1/auth/native/revoke" },
    ],
  );
  assert.deepEqual(WORKBENCH_V1_AUTH_ENDPOINTS.register.requiredRequestHeaders, ["Idempotency-Key"]);
  assert.deepEqual(WORKBENCH_V1_AUTH_ENDPOINTS.login.requiredRequestHeaders, []);
  for (const operationId of [
    "authStatus", "register", "login", "logout", "listInvitations", "createInvitation",
    "revokeInvitation", "resendInvitation", "inspectInvitation", "startOAuth", "completeOAuth",
    "startNativeAuthorization", "completeNativeAuthorization", "approveNativeAuthorization",
    "refreshNativeToken", "listOwnNativeClientSessions", "revokeOwnNativeClientSession", "revokeNativeClientSession",
  ]) {
    const endpoint = WORKBENCH_V1_AUTH_ENDPOINTS[operationId];
    assert.deepEqual(endpoint.responseHeaders, ["Cache-Control"]);
    assert.equal(Check(endpoint.responseHeadersSchema, { "Cache-Control": "no-store" }), true);
    assert.equal(Check(endpoint.responseHeadersSchema, { "Cache-Control": "private, no-store" }), false);
  }
  assert.deepEqual(WORKBENCH_V1_AUTH_ENDPOINTS.listMembers.responseHeaders, []);
  assert.deepEqual(WORKBENCH_V1_AUTH_ENDPOINTS.updateMember.responseHeaders, []);
});

test("auth input contracts bound usernames/passwords and reject empty member updates", () => {
  assert.equal(Check(RegisterRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { username: "owner.local", password: "correct horse", bootstrapToken: "bootstrap-secret" },
  }), true);
  assert.equal(Check(RegisterRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { username: "../owner", password: "correct horse" },
  }), false);
  assert.equal(Check(UpdateMemberRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {},
  }), false);
  assert.equal(Check(CreateInvitationRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { email: "member@example.test" },
  }), true);
  assert.equal(Check(CreateInvitationRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { email: "member" },
  }), false);
  assert.equal(Check(StartOAuthRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { token: "v1~invitation~invite-123~signature" },
  }), true);
  assert.equal(Check(InvitationAcceptanceSchema, {
    invitationId: "invite-123",
    expiresAt: "2026-08-11T10:00:00.000Z",
    providers: ["github", "google"],
  }), true);
  assert.equal(Check(StartNativeAuthorizationRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      clientKind: "desktop",
      redirectUri: "http://127.0.0.1:41853/native/callback",
      codeChallenge: "A".repeat(43),
      devicePublicKey: "B".repeat(43),
    },
  }), true);
  assert.equal(Check(CompleteNativeAuthorizationRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      authorizationId: "native-authorization-1",
      authorizationCode: "C".repeat(43),
      codeVerifier: "A".repeat(43),
      devicePublicKey: "B".repeat(43),
    },
  }), true);
  assert.equal(Check(ApproveNativeAuthorizationRequestSchema, {
    schemaVersion: "workbench-api-v1", data: { authorizationId: "native-authorization-1" },
  }), true);
  assert.equal(Check(RefreshNativeTokenRequestSchema, {
    schemaVersion: "workbench-api-v1", data: { refreshToken: "D".repeat(43) },
  }), true);
});

test("authenticated status always carries the bound user and workspace", () => {
  const base = {
    registrationOpen: false,
    bootstrapRequired: false,
    bootstrapAvailable: false,
  };
  assert.equal(Check(AuthStatusSchema, { ...base, authenticated: false }), true);
  assert.equal(Check(AuthStatusSchema, {
    ...base,
    authenticated: true,
    user: {
      userId: "user-owner",
      username: "owner.local",
      role: "admin",
      disabled: false,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    },
    workspaceId: "workspace-local",
  }), true);
  assert.equal(Check(AuthStatusSchema, { ...base, authenticated: true }), false);
  assert.equal(Check(AuthStatusSchema, {
    ...base,
    authenticated: false,
    workspaceId: "workspace-local",
  }), false);
});
