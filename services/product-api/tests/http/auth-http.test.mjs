import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { WorkbenchSessionStore } from "../../src/security/workbench-session-store.mjs";

const ORIGIN = "http://127.0.0.1";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = {};
    this.body = "";
  }
  writeHead(status, headers = {}) {
    this.status = status;
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
  }
  end(value = "") {
    this.body += value;
    this.emit("finish");
  }
}

function request({ method = "GET", url, headers = {}, body } = {}) {
  const value = new EventEmitter();
  value.method = method;
  value.url = url;
  value.headers = {
    host: "127.0.0.1",
    ...Object.fromEntries(Object.entries(headers).map(([key, item]) => [key.toLowerCase(), item])),
  };
  value[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined) yield Buffer.from(JSON.stringify(body));
  };
  return value;
}

async function invoke(handler, options) {
  const response = new MockResponse();
  await handler(request(options), response);
  return response;
}

const browserHeaders = {
  Origin: ORIGIN,
  "Sec-Fetch-Site": "same-origin",
  "Content-Type": "application/json",
};

test("production workspace bootstrap is closed and auth endpoints own session issuance/revocation", async () => {
  const user = {
    userId: "user-owner",
    username: "owner",
    role: "admin",
    disabled: false,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  const authService = {
    async status({ session }) {
      return {
        registrationOpen: false,
        bootstrapRequired: !session,
        bootstrapAvailable: true,
        authenticated: Boolean(session),
        ...(session ? { user, workspaceId: session.activeWorkspaceId } : {}),
      };
    },
    async register() { return { user, workspaceId: "workspace-local" }; },
    async login() { return { user, workspaceId: "workspace-local" }; },
  };
  const sessionStore = new WorkbenchSessionStore({
    tokenFactory: () => "auth-session-token",
    csrfTokenFactory: () => "csrf-token-1234567890-abcdefghijklmnopqrstuvwxyz",
  });
  const handler = createWorkbenchHttpHandler({
    application: {
      async workspace() {
        return {
          workspace: {
            workspaceId: "workspace-local",
            name: "Team workspace",
            capabilities: { builderProposal: false, resources: false, maxParallelism: 1 },
            createdAt: "2026-07-24T00:00:00.000Z",
            updatedAt: "2026-07-24T00:00:00.000Z",
          },
        };
      },
    },
    authService,
    sessionStore,
    origin: ORIGIN,
    requestIdFactory: () => "request-auth-http",
  });

  const denied = await invoke(handler, { url: "/api/workbench/v1/workspace" });
  assert.equal(denied.status, 401);
  assert.equal(JSON.parse(denied.body).code, "session_required");

  const status = await invoke(handler, { url: "/api/workbench/v1/auth/status" });
  assert.equal(status.status, 200);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(JSON.parse(status.body).data.authenticated, false);

  const registered = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/register",
    headers: { ...browserHeaders, "Idempotency-Key": "idem-register-1" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { username: "owner", password: "password-123", bootstrapToken: "bootstrap" },
    },
  });
  assert.equal(registered.status, 201);
  assert.match(registered.headers["set-cookie"], /HttpOnly/);
  assert.equal(registered.headers["cache-control"], "no-store");
  assert.match(registered.headers["set-cookie"], /SameSite=Lax/);
  assert.match(registered.headers["set-cookie"], /Max-Age=604800/);
  const cookie = registered.headers["set-cookie"].split(";")[0];

  const loggedIn = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/login",
    headers: browserHeaders,
    body: {
      schemaVersion: "workbench-api-v1",
      data: { username: "owner", password: "password-123" },
    },
  });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.headers["cache-control"], "no-store");
  assert.match(loggedIn.headers["set-cookie"], /HttpOnly/);
  assert.match(loggedIn.headers["set-cookie"], /SameSite=Lax/);

  const workspace = await invoke(handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Cookie: cookie },
  });
  assert.equal(workspace.status, 200);
  assert.equal(workspace.headers["cache-control"], "no-store");
  const csrf = JSON.parse(workspace.body).data.session.csrfToken;

  const loggedOut = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/logout",
    headers: {
      ...browserHeaders,
      Cookie: cookie,
      "X-Workbench-CSRF": csrf,
    },
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(loggedOut.status, 200);
  assert.equal(loggedOut.headers["cache-control"], "no-store");
  assert.match(loggedOut.headers["set-cookie"], /Max-Age=0/);

  const afterLogout = await invoke(handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Cookie: cookie },
  });
  assert.equal(afterLogout.status, 401);
});

test("public auth mutations require same-origin browser proof without requiring CSRF", async () => {
  const handler = createWorkbenchHttpHandler({
    application: {},
    authService: { async login() { throw new Error("must not run"); } },
    origin: ORIGIN,
  });
  const response = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/login",
    body: {
      schemaVersion: "workbench-api-v1",
      data: { username: "owner", password: "password-123" },
    },
  });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).code, "origin_forbidden");
});

test("unexpected database error codes never escape through the Product API", async () => {
  const sessionStore = new WorkbenchSessionStore({
    tokenFactory: () => "sqlstate-session-token",
    csrfTokenFactory: () => "csrf-token-1234567890-abcdefghijklmnopqrstuvwxyz",
  });
  const session = await sessionStore.issue({ userId: "user-sqlstate", activeWorkspaceId: "workspace-sqlstate" });
  const handler = createWorkbenchHttpHandler({
    application: {
      async workspace() {
        const error = new Error("syntax error at or near grant");
        error.code = "42601";
        throw error;
      },
    },
    sessionStore,
    origin: ORIGIN,
  });
  const response = await invoke(handler, {
    url: "/api/workbench/v1/workspace",
    headers: { Cookie: `workbench_session=${session.token}` },
  });
  const body = JSON.parse(response.body);
  assert.equal(response.status, 500);
  assert.equal(body.code, "internal_error");
  assert.equal(body.message, "The Workbench request could not be completed.");
  assert.deepEqual(body.details, {});
});

test("invitation and OAuth HTTP routes preserve public callback boundaries and owner-only mutations", async () => {
  const user = {
    userId: "user-owner",
    username: "owner",
    role: "admin",
    disabled: false,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
  const calls = [];
  const authService = {
    async inspectInvitation(input) {
      calls.push({ operation: "inspect", input });
      return { invitationId: "invitation-1", expiresAt: "2026-08-12T00:00:00.000Z", providers: ["google", "github"] };
    },
    async startOAuth(input) {
      calls.push({ operation: "start", input });
      return { authorizationUrl: "https://accounts.example.test/authorize?state=opaque" };
    },
    async completeOAuth(input) {
      calls.push({ operation: "complete", input });
      return { user, workspaceId: "workspace-local" };
    },
    async listInvitations(input) {
      calls.push({ operation: "list", input });
      return [{
        invitationId: "invitation-1",
        workspaceId: "workspace-local",
        email: "member@example.test",
        role: "member",
        status: "pending",
        expiresAt: "2026-08-12T00:00:00.000Z",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        deliveryStatus: "queued",
      }];
    },
    async createInvitation(input) {
      calls.push({ operation: "create", input });
      return { invitation: (await this.listInvitations({}))[0] };
    },
    async revokeInvitation() { throw new Error("not used"); },
    async resendInvitation() { throw new Error("not used"); },
  };
  const sessionStore = new WorkbenchSessionStore({
    tokenFactory: () => "owner-session-token",
    csrfTokenFactory: () => "csrf-token-1234567890-abcdefghijklmnopqrstuvwxyz",
  });
  const ownerSession = await sessionStore.issue({ userId: user.userId, activeWorkspaceId: "workspace-local" });
  const handler = createWorkbenchHttpHandler({
    application: {},
    authService,
    sessionStore,
    origin: ORIGIN,
    requestIdFactory: () => "request-invitation-http",
  });

  const inspected = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/invitations/inspect",
    headers: browserHeaders,
    body: { schemaVersion: "workbench-api-v1", data: { token: "v1~invitation~invitation-1~opaque" } },
  });
  assert.equal(inspected.status, 200);
  assert.equal(JSON.parse(inspected.body).data.invitationId, "invitation-1");

  const started = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/auth/oauth/google/start",
    headers: { ...browserHeaders, Cookie: `workbench_session=${ownerSession.token}` },
    body: {
      schemaVersion: "workbench-api-v1",
      data: { token: "v1~invitation~invitation-1~opaque", bindExistingAccount: true },
    },
  });
  assert.equal(started.status, 200);
  assert.equal(calls.find(({ operation }) => operation === "start").input.auth.userId, user.userId);

  const callback = await invoke(handler, {
    url: "/api/workbench/v1/auth/oauth/google/callback?state=v1~oauth%3Agoogle~oauth-1~opaque&code=provider-code",
    headers: { Cookie: `workbench_session=${ownerSession.token}` },
  });
  assert.equal(callback.status, 200);
  assert.match(callback.headers["set-cookie"], /HttpOnly/);
  assert.equal(calls.find(({ operation }) => operation === "complete").input.auth.userId, user.userId);

  const browserCallback = await invoke(handler, {
    url: "/api/workbench/v1/auth/oauth/google/callback?state=v1~oauth%3Agoogle~oauth-2~opaque&code=provider-code",
    headers: { Accept: "text/html,application/xhtml+xml", Cookie: `workbench_session=${ownerSession.token}` },
  });
  assert.equal(browserCallback.status, 303);
  assert.equal(browserCallback.headers.location, "/invite/complete");
  assert.match(browserCallback.headers["set-cookie"], /HttpOnly/);

  const listed = await invoke(handler, {
    url: "/api/workbench/v1/workspace/invitations",
    headers: { Cookie: `workbench_session=${ownerSession.token}` },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers["cache-control"], "no-store");

  const created = await invoke(handler, {
    method: "POST",
    url: "/api/workbench/v1/workspace/invitations",
    headers: {
      ...browserHeaders,
      Cookie: `workbench_session=${ownerSession.token}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "create-invitation-1",
    },
    body: { schemaVersion: "workbench-api-v1", data: { email: "member@example.test" } },
  });
  assert.equal(created.status, 201);
  assert.equal(calls.find(({ operation }) => operation === "create").input.idempotencyKey, "create-invitation-1");
});
