import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";

import { Pool } from "pg";

import { AuthService } from "../../src/auth/auth-service.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresAgentCommandAuthorizer, createPostgresIdempotentMutationPort } from "../../src/coordination/index.mjs";
import { PostgresDeviceLifecycle } from "../../src/devices/postgres-device-lifecycle.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { PostgresWorkbenchSessionStore } from "../../src/security/postgres-workbench-session-store.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const origin = "https://workspace.example.test";
const workspaceId = "native-http-workspace";
const verifier = "A".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const devicePublicKey = "B".repeat(43);

test("real PostgreSQL HTTP native authorization binds browser approval, PKCE, Device registration, heartbeat, and revocation", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/u);
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  const commandAuthorizer = new PostgresAgentCommandAuthorizer({ store });
  const deviceLifecycle = new PostgresDeviceLifecycle({ store, commandAuthorizer });
  const application = createWorkbenchApplication({
    store,
    workspaceReadModel: store.createWorkspaceReadModel(),
    workspaceAuthorizer: store.createAuthPersistence(),
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }),
    deviceLifecycle,
  });
  const authService = new AuthService({
    store,
    persistence: store.createAuthPersistence(),
    workspaceId,
    workspaceName: "Native HTTP workspace",
    bootstrapAdminToken: "native-http-bootstrap-token",
    bcryptCost: 10,
    nativeClientSessions: store.createNativeClientSessionStore(),
    publicOrigin: origin,
  });
  await store.runMigrations();
  const server = await startServer(createWorkbenchHttpHandler({
    application,
    authService,
    sessionStore,
    origin,
    internalErrorReporter: (error) => t.diagnostic(JSON.stringify(error)),
  }));
  t.after(async () => {
    await stopServer(server);
    await store.close();
    await pool.end();
  });

  const owner = await request(server, "/api/workbench/v1/auth/register", {
    method: "POST",
    headers: browserHeaders({ "Idempotency-Key": "native-http-owner-register" }),
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        username: "nativeowner",
        password: "password-123",
        bootstrapToken: "native-http-bootstrap-token",
      },
    },
  });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  const ownerCookie = cookie(owner);
  const ownerSession = await sessionStore.get(ownerCookie);
  assert.ok(ownerSession);

  const started = await request(server, "/api/workbench/v1/auth/native/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        clientKind: "desktop",
        redirectUri: "http://127.0.0.1:41853/native/callback",
        codeChallenge: challenge,
        devicePublicKey,
      },
    },
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(
    started.body.data.authorizationUrl,
    `${origin}/native/authorize?authorizationId=${encodeURIComponent(started.body.data.authorizationId)}`,
  );

  const approved = await request(server, "/api/workbench/v1/auth/native/approve", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
    }),
    body: {
      schemaVersion: "workbench-api-v1",
      data: { authorizationId: started.body.data.authorizationId },
    },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const redirect = new URL(approved.body.data.redirectUrl);
  assert.equal(redirect.origin, "http://127.0.0.1:41853");
  assert.equal(redirect.searchParams.get("authorization_id"), started.body.data.authorizationId);
  const authorizationCode = redirect.searchParams.get("code");
  assert.ok(authorizationCode);

  const complete = await request(server, "/api/workbench/v1/auth/native/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        authorizationId: started.body.data.authorizationId,
        authorizationCode,
        codeVerifier: verifier,
        devicePublicKey,
      },
    },
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  const tokenSet = complete.body.data;
  assert.equal(tokenSet.workspaceId, workspaceId);

  const ownConnections = await request(server, "/api/workbench/v1/auth/native/sessions", {
    headers: { Cookie: `workbench_session=${ownerCookie}` },
  });
  assert.equal(ownConnections.status, 200, JSON.stringify(ownConnections.body));
  assert.equal(ownConnections.headers.get("cache-control"), "no-store");
  assert.deepEqual(ownConnections.body.data.map((entry) => entry.clientSessionId), [tokenSet.clientSessionId]);
  assert.deepEqual(Object.keys(ownConnections.body.data[0]).sort(), ["clientKind", "clientSessionId", "createdAt", "expiresAt"].sort());
  assert.equal((await request(server, "/api/workbench/v1/auth/native/sessions")).status, 401);
  // A second real membership is fixture setup; authorization checks below use HTTP and durable sessions.
  await pool.query(`INSERT INTO product_users (user_id, schema_version, display_name, username, username_normalized,
    password_hash, account_role, disabled, bootstrap_admin_claim, created_at, updated_at, payload)
    SELECT 'native-http-other', schema_version, 'Other member', 'othernative', 'othernative',
      password_hash, 'member', false, false, created_at, updated_at, '{}'::jsonb
    FROM product_users WHERE user_id = $1`, [owner.body.data.user.userId]);
  await pool.query(`INSERT INTO workspace_memberships (membership_id, workspace_id, user_id, schema_version, role, status,
    revision, created_at, updated_at, payload) VALUES ('native-http-other-membership', $1, 'native-http-other',
    'workbench-v1', 'member', 'active', 1, clock_timestamp(), clock_timestamp(), '{}'::jsonb)`, [workspaceId]);
  const otherBrowser = await sessionStore.issue({ userId: "native-http-other", activeWorkspaceId: workspaceId });
  const otherSession = await sessionStore.get(otherBrowser.token);
  const otherList = await request(server, "/api/workbench/v1/auth/native/sessions", {
    headers: { Cookie: `workbench_session=${otherBrowser.token}` },
  });
  assert.equal(otherList.status, 200, JSON.stringify(otherList.body));
  assert.deepEqual(otherList.body.data, []);
  const forbiddenRevoke = await request(server, `/api/workbench/v1/auth/native/sessions/${tokenSet.clientSessionId}/revoke`, {
    method: "POST", headers: browserHeaders({ Cookie: `workbench_session=${otherBrowser.token}`, "X-Workbench-CSRF": otherSession.csrfToken }),
    body: { schemaVersion: "workbench-api-v1", data: {} },
  });
  assert.equal(forbiddenRevoke.status, 200, JSON.stringify(forbiddenRevoke.body));
  assert.equal(forbiddenRevoke.body.data.revoked, false, "another member cannot revoke this client's session");

  const nativeWorkspace = await request(server, "/api/workbench/v1/workspace", {
    headers: { Authorization: `Bearer ${tokenSet.accessToken}` },
  });
  assert.equal(nativeWorkspace.status, 200, JSON.stringify(nativeWorkspace.body));
  assert.equal(nativeWorkspace.body.data.session.csrfToken, "");
  assert.equal(nativeWorkspace.body.data.session.workspaceId, workspaceId);

  const browserDeviceRegistration = await request(server, "/api/workbench/v1/devices", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "browser-device-registration-must-fail",
    }),
    body: deviceRegistrationRequest(),
  });
  assert.equal(browserDeviceRegistration.status, 403, JSON.stringify(browserDeviceRegistration.body));
  assert.equal(browserDeviceRegistration.body.code, "device_native_session_required");

  const registeredDevice = await request(server, "/api/workbench/v1/devices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenSet.accessToken}`,
      "Idempotency-Key": "native-device-register-1",
      "Content-Type": "application/json",
    },
    body: deviceRegistrationRequest(),
  });
  assert.equal(registeredDevice.status, 201, JSON.stringify(registeredDevice.body));
  assert.equal(registeredDevice.body.data.ownerUserId, owner.body.data.user.userId);
  assert.equal(registeredDevice.body.data.publicIdentity, `sha256:${createHash("sha256").update(devicePublicKey).digest("hex")}`);
  assert.equal(JSON.stringify(registeredDevice.body).includes(devicePublicKey), false);
  assert.equal(JSON.stringify(registeredDevice.body).includes(tokenSet.clientSessionId), false);

  const heartbeat = await request(server, `/api/workbench/v1/devices/${encodeURIComponent(registeredDevice.body.data.deviceId)}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenSet.accessToken}`,
      "Idempotency-Key": "native-device-heartbeat-1",
      "Content-Type": "application/json",
    },
    body: {
      schemaVersion: "workbench-api-v1",
      data: {
        appVersion: "0.3.1-test",
        workerProtocolVersion: "workbench-device-worker-v1",
        capabilityInventory: ["file_read", "notification", "sandbox_oci"],
      },
    },
  });
  assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));
  assert.equal(heartbeat.body.data.revision, 2);
  assert.equal(heartbeat.body.data.health, "ready");
  assert.deepEqual(heartbeat.body.data.capabilityInventory, ["file_read", "notification", "sandbox_oci"]);

  const browserDevices = await request(server, "/api/workbench/v1/devices", {
    headers: { Cookie: `workbench_session=${ownerCookie}` },
  });
  assert.equal(browserDevices.status, 200, JSON.stringify(browserDevices.body));
  assert.deepEqual(browserDevices.body.data.map((device) => device.deviceId), [registeredDevice.body.data.deviceId]);

  const revokedDevice = await request(server, `/api/workbench/v1/devices/${encodeURIComponent(registeredDevice.body.data.deviceId)}/revoke`, {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-device-revoke-1",
    }),
    body: { schemaVersion: "workbench-api-v1", data: { reason: "Lost device" } },
  });
  assert.equal(revokedDevice.status, 200, JSON.stringify(revokedDevice.body));
  assert.equal(revokedDevice.body.data.registrationStatus, "revoked");
  assert.equal(revokedDevice.body.data.health, "revoked");

  const deviceLedger = await pool.query(`
    SELECT command.kind, event.kind AS event_kind, device.registration_status,
           session.status AS native_session_status
      FROM public.devices device
      JOIN public.native_client_sessions session
        ON session.client_session_id = device.native_client_session_id
      JOIN public.device_lifecycle_events event
        ON event.workspace_id = device.workspace_id AND event.device_id = device.device_id
      JOIN public.product_commands command
        ON command.workspace_id = event.workspace_id AND command.command_id = event.product_command_id
     WHERE device.workspace_id = $1 AND device.device_id = $2
     ORDER BY event.target_revision ASC
  `, [workspaceId, registeredDevice.body.data.deviceId]);
  assert.deepEqual(deviceLedger.rows, [
    {
      kind: "device_register",
      event_kind: "device_register",
      registration_status: "revoked",
      native_session_status: "revoked",
    },
    {
      kind: "device_revoke",
      event_kind: "device_revoke",
      registration_status: "revoked",
      native_session_status: "revoked",
    },
  ]);

  const afterDeviceRevoke = await request(server, "/api/workbench/v1/workspace", {
    headers: { Authorization: `Bearer ${tokenSet.accessToken}` },
  });
  assert.equal(afterDeviceRevoke.status, 401, JSON.stringify(afterDeviceRevoke.body));
  assert.equal(afterDeviceRevoke.body.code, "native_access_token_invalid");

  const freshAuthorization = await authService.startNativeAuthorization({ clientKind: "desktop", redirectUri: "http://127.0.0.1:41853/native/callback", codeChallenge: challenge, devicePublicKey });
  const freshApproval = await authService.approveNativeAuthorization({ authorizationId: freshAuthorization.authorizationId, auth: ownerSession });
  const freshTokens = await authService.completeNativeAuthorization({ authorizationId: freshAuthorization.authorizationId,
    authorizationCode: new URL(freshApproval.redirectUrl).searchParams.get("code"), codeVerifier: verifier, devicePublicKey });
  const revokePath = `/api/workbench/v1/auth/native/sessions/${freshTokens.clientSessionId}/revoke`;
  const noCsrf = await request(server, revokePath, { method: "POST", headers: browserHeaders({ Cookie: `workbench_session=${ownerCookie}` }), body: { schemaVersion: "workbench-api-v1", data: {} } });
  assert.equal(noCsrf.status, 403);
  assert.equal((await request(server, "/api/workbench/v1/workspace", { headers: { Authorization: `Bearer ${freshTokens.accessToken}` } })).status, 200);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stopped = await request(server, revokePath, { method: "POST", headers: browserHeaders({ Cookie: `workbench_session=${ownerCookie}`, "X-Workbench-CSRF": ownerSession.csrfToken }), body: { schemaVersion: "workbench-api-v1", data: {} } });
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.data.revoked, true);
  }
  assert.equal((await request(server, "/api/workbench/v1/workspace", { headers: { Authorization: `Bearer ${freshTokens.accessToken}` } })).status, 401);
  const refreshAfterStop = await request(server, "/api/workbench/v1/auth/native/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: { schemaVersion: "workbench-api-v1", data: { refreshToken: freshTokens.refreshToken } } });
  assert.equal(refreshAfterStop.status, 410, JSON.stringify(refreshAfterStop.body));
  assert.equal(refreshAfterStop.body.code, "native_authorization_expired");
  const emptyConnections = await request(server, "/api/workbench/v1/auth/native/sessions", { headers: { Cookie: `workbench_session=${ownerCookie}` } });
  assert.deepEqual(emptyConnections.body.data, []);

});

function deviceRegistrationRequest() {
  return {
    schemaVersion: "workbench-api-v1",
    data: {
      displayName: "Native test Mac",
      platform: "macos",
      architecture: "arm64",
      appVersion: "0.3.0-test",
      workerProtocolVersion: "workbench-device-worker-v1",
      capabilityInventory: ["file_read", "notification"],
    },
  };
}

function browserHeaders(extra = {}) {
  return {
    Origin: origin,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(server, path, { method = "GET", headers = {}, body } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  const match = /^workbench_session=([^;]+);/u.exec(String(value ?? ""));
  assert.ok(match);
  return match[1];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  return value;
}
