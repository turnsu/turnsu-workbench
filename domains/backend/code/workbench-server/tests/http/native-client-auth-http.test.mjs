import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

const ORIGIN = "http://127.0.0.1";
const devicePublicKey = "B".repeat(43);

class MockResponse extends EventEmitter {
  constructor() { super(); this.status = null; this.headers = {}; this.body = ""; }
  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  }
  end(value = "") { this.body += value; this.emit("finish"); }
}

function request({ method = "GET", url, headers = {}, body } = {}) {
  const value = new EventEmitter();
  value.method = method;
  value.url = url;
  value.headers = {
    host: "127.0.0.1",
    ...Object.fromEntries(Object.entries(headers).map(([key, entry]) => [key.toLowerCase(), entry])),
  };
  value[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return value;
}

async function invoke(handler, input) {
  const response = new MockResponse();
  await handler(request(input), response);
  return response;
}

const envelope = (data) => ({ schemaVersion: "workbench-api-v1", data });
const body = (response) => JSON.parse(response.body);

test("native HTTP authorization separates browser approval, token exchange, bearer Product access, and revoke", async () => {
  const sessionStore = new WorkbenchSessionStore({
    tokenFactory: () => "browser-session-token",
    csrfTokenFactory: () => "csrf-token-1234567890-abcdefghijklmnopqrstuvwxyz",
  });
  const browser = await sessionStore.issue({ userId: "user-native", activeWorkspaceId: "workspace-native" });
  const calls = [];
  const authService = {
    async startNativeAuthorization(input) {
      calls.push(["start", input]);
      return {
        authorizationId: "native-auth-1",
        authorizationUrl: "/native/authorize?authorizationId=native-auth-1",
        expiresAt: "2026-08-12T01:10:00.000Z",
      };
    },
    async approveNativeAuthorization(input) {
      calls.push(["approve", input]);
      return { redirectUrl: "http://127.0.0.1:41853/native/callback?code=code-native-1" };
    },
    async completeNativeAuthorization(input) {
      calls.push(["complete", input]);
      return tokenSet();
    },
    async refreshNativeToken(input) { calls.push(["refresh", input]); return tokenSet(); },
    async authenticateNativeAccessToken(input) {
      calls.push(["authenticate", input]);
      return input.accessToken === "access-native-token-12345678901234567890"
        ? {
            clientSessionId: "client-session-1",
            userId: "user-native",
            activeWorkspaceId: "workspace-native",
            expiresAt: "2026-08-12T01:15:00.000Z",
          }
        : null;
    },
    async revokeNativeClientSession(input) { calls.push(["revoke", input]); return { revoked: true }; },
  };
  const application = {
    async workspace({ auth }) {
      calls.push(["workspace", auth]);
      return {
        workspace: {
          workspaceId: "workspace-native",
          name: "Native workspace",
          capabilities: { builderProposal: false, resources: false, maxParallelism: 1 },
          createdAt: "2026-08-12T01:00:00.000Z",
          updatedAt: "2026-08-12T01:00:00.000Z",
        },
      };
    },
  };
  const handler = createWorkbenchHttpHandler({
    application,
    authService,
    sessionStore,
    origin: ORIGIN,
    requestIdFactory: () => "request-native-http",
  });
  const browserHeaders = { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };

  const started = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/authorize",
    headers: { "Content-Type": "application/json" },
    body: envelope({
      clientKind: "desktop",
      redirectUri: "http://127.0.0.1:41853/native/callback",
      codeChallenge: "A".repeat(43),
      devicePublicKey,
    }),
  });
  assert.equal(started.status, 201);
  assert.equal(body(started).data.authorizationId, "native-auth-1");

  const approved = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/approve",
    headers: {
      ...browserHeaders,
      Cookie: `workbench_session=${browser.token}`,
      "X-Workbench-CSRF": browser.csrfToken,
    },
    body: envelope({ authorizationId: "native-auth-1" }),
  });
  assert.equal(approved.status, 200);
  assert.match(body(approved).data.redirectUrl, /code=code-native-1/);
  assert.equal(calls.find(([kind]) => kind === "approve")[1].auth.userId, "user-native");

  const completed = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/token",
    headers: { "Content-Type": "application/json" },
    body: envelope({
      authorizationId: "native-auth-1",
      authorizationCode: "C".repeat(43),
      codeVerifier: "A".repeat(43),
      devicePublicKey,
    }),
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(body(completed).data, tokenSet());

  const workspace = await invoke(handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Authorization: "Bearer access-native-token-12345678901234567890" },
  });
  assert.equal(workspace.status, 200);
  assert.equal(body(workspace).data.session.csrfToken, "");
  assert.equal(calls.find(([kind]) => kind === "workspace")[1].clientSessionId, "client-session-1");

  const revoked = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/revoke",
    headers: { Authorization: "Bearer access-native-token-12345678901234567890", "Content-Type": "application/json" },
    body: envelope({}),
  });
  assert.equal(revoked.status, 200);
  assert.deepEqual(body(revoked).data, { revoked: true });

  const rejectedBrowser = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/approve",
    headers: browserHeaders,
    body: envelope({ authorizationId: "native-auth-1" }),
  });
  assert.equal(rejectedBrowser.status, 401);
  assert.equal(body(rejectedBrowser).code, "session_required");

  const rejectedCookieExchange = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/native/refresh",
    headers: {
      "Content-Type": "application/json",
      Cookie: `workbench_session=${browser.token}`,
    },
    body: envelope({ refreshToken: "R".repeat(43) }),
  });
  assert.equal(rejectedCookieExchange.status, 403);
  assert.equal(body(rejectedCookieExchange).code, "native_cookie_forbidden");
});

function tokenSet() {
  return {
    accessToken: "access-native-token-12345678901234567890",
    accessTokenExpiresAt: "2026-08-12T01:15:00.000Z",
    refreshToken: "refresh-native-token-1234567890123456789",
    refreshTokenExpiresAt: "2026-09-11T01:00:00.000Z",
    clientSessionId: "client-session-1",
    workspaceId: "workspace-native",
  };
}
