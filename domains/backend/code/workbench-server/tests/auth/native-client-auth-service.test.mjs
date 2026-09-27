import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AuthService } from "../../src/auth/auth-service.mjs";

const verifier = "A".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const devicePublicKey = "B".repeat(43);

class NativeSessions {
  constructor() { this.calls = []; }
  async createAuthorization(input) {
    this.calls.push(["create", input]);
    return { authorizationId: input.authorizationId, expiresAt: "2026-08-12T01:10:00.000Z" };
  }
  async approveAuthorization(input) {
    this.calls.push(["approve", input]);
    return {
      authorizationId: input.authorizationId,
      authorizationCode: "C".repeat(43),
      redirectUri: "http://127.0.0.1:41853/native/callback",
      expiresAt: "2026-08-12T01:10:00.000Z",
    };
  }
  async consumeAuthorization(input) {
    this.calls.push(["consume", input]);
    return tokenSet();
  }
  async refresh(input) { this.calls.push(["refresh", input]); return tokenSet(); }
  async authenticateAccessToken(input) { this.calls.push(["authenticate", input]); return null; }
  async revokeClientSession(input) { this.calls.push(["revoke", input]); return { revoked: true }; }
}

const tokenSet = () => ({
  accessToken: "D".repeat(43),
  accessTokenExpiresAt: "2026-08-12T01:15:00.000Z",
  refreshToken: "E".repeat(43),
  refreshTokenExpiresAt: "2026-09-11T01:00:00.000Z",
  clientSessionId: "native-client-session-1",
  workspaceId: "workspace-native",
});

test("native authorization begins with PKCE/device proof and completes only through a browser approval", async () => {
  const nativeClientSessions = new NativeSessions();
  let sequence = 0;
  const service = new AuthService({
    store: { async connect() {} },
    nativeClientSessions,
    idFactory: (kind) => `${kind}-${++sequence}`,
    nativeAuthorizationBaseUrl: "/native/authorize",
    publicOrigin: "https://workspace.example.test",
  });
  const started = await service.startNativeAuthorization({
    clientKind: "desktop",
    redirectUri: "http://127.0.0.1:41853/native/callback",
    codeChallenge: challenge,
    devicePublicKey,
  });
  assert.equal(started.authorizationId, "native-authorization-1");
  assert.equal(started.authorizationUrl, "https://workspace.example.test/native/authorize?authorizationId=native-authorization-1");
  assert.equal(nativeClientSessions.calls[0][1].codeChallenge, challenge);

  const approved = await service.approveNativeAuthorization({
    authorizationId: started.authorizationId,
    auth: { userId: "user-native", activeWorkspaceId: "workspace-native" },
  });
  assert.match(approved.redirectUrl, /^http:\/\/127\.0\.0\.1:41853\/native\/callback\?code=/);
  assert.match(approved.redirectUrl, /authorization_id=native-authorization-1/);

  const completed = await service.completeNativeAuthorization({
    authorizationId: started.authorizationId,
    authorizationCode: "C".repeat(43),
    codeVerifier: verifier,
    devicePublicKey,
  });
  assert.deepEqual(completed, tokenSet());
  assert.equal(nativeClientSessions.calls[2][0], "consume");
});

test("native refresh and revoke never expose storage-specific fields", async () => {
  const nativeClientSessions = new NativeSessions();
  const service = new AuthService({ store: { async connect() {} }, nativeClientSessions });
  assert.deepEqual(await service.refreshNativeToken({ refreshToken: "F".repeat(43) }), tokenSet());
  assert.deepEqual(await service.revokeNativeClientSession({
    auth: { clientSessionId: "native-client-session-1", userId: "user-native", activeWorkspaceId: "workspace-native" },
  }), { revoked: true });
});
