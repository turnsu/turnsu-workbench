import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { PostgresNativeClientSessionStore } from "../../src/auth/postgres-native-client-session-store.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";
import { Pool } from "pg";

const enabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const workspaceId = "native-auth-workspace";
const devicePublicKey = "B".repeat(43);
const verifier = "A".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

test("PostgreSQL native client auth keeps token plaintext out of storage, rotates refresh credentials, and revokes replayed families", {
  skip: enabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000 });
  const ids = new Map();
  const idFactory = (kind) => {
    const sequence = (ids.get(kind) ?? 0) + 1;
    ids.set(kind, sequence);
    return `${kind}-${sequence}`;
  };
  const secrets = ["C".repeat(43), "D".repeat(43), "E".repeat(43), "F".repeat(43), "G".repeat(43)];
  const store = new ProductPostgresStore({ pool, maxTransactionRetries: 0 });
  const auth = store.createAuthPersistence({ clock: () => new Date(), idFactory });
  const native = new PostgresNativeClientSessionStore({
    store,
    clock: () => new Date(),
    idFactory,
    secretFactory: () => {
      const value = secrets.shift();
      assert.ok(value, "the test must provision a distinct native secret");
      return value;
    },
  });
  t.after(async () => {
    await store.close();
    await pool.end();
  });

  await store.runMigrations();
  const owner = await auth.registerAuthAccount({
    username: "nativeowner",
    usernameNormalized: "nativeowner",
    passwordHash: "$2b$12$yW6McEk2Trkg.gFfiQkeMuAY.FtqTkbbJ3gqHQIsLVxNlAPAmrNCS",
    role: "admin",
    workspaceId,
    workspaceName: "Native auth workspace",
    idempotencyKey: "register-native-owner",
    requestFingerprint: { username: "nativeowner", role: "admin" },
  });

  await native.createAuthorization({
    authorizationId: "native-authorization-1",
    clientKind: "desktop",
    redirectUri: "http://127.0.0.1:41853/native/callback",
    codeChallenge: challenge,
    devicePublicKey,
  });
  const approved = await native.approveAuthorization({
    authorizationId: "native-authorization-1",
    userId: owner.user.userId,
    workspaceId,
  });
  assert.equal(approved.authorizationCode, "C".repeat(43));
  const issued = await native.consumeAuthorization({
    authorizationId: "native-authorization-1",
    authorizationCode: approved.authorizationCode,
    codeVerifier: verifier,
    devicePublicKey,
  });
  assert.equal(issued.accessToken, "E".repeat(43));
  assert.equal(issued.refreshToken, "D".repeat(43));
  assert.equal((await native.authenticateAccessToken({ accessToken: issued.accessToken })).userId, owner.user.userId);

  const stored = await pool.query(`
    SELECT authorization_code_hash, refresh.token_hash AS refresh_hash, access.token_hash AS access_hash
      FROM public.native_authorizations authz
      JOIN public.native_client_sessions session ON session.user_id = authz.user_id
      JOIN public.native_refresh_tokens refresh ON refresh.client_session_id = session.client_session_id
      JOIN public.native_access_tokens access ON access.client_session_id = session.client_session_id
     WHERE authz.authorization_id = 'native-authorization-1'
  `);
  assert.equal(stored.rowCount, 1);
  assert.equal(JSON.stringify(stored.rows[0]).includes(approved.authorizationCode), false);
  assert.equal(JSON.stringify(stored.rows[0]).includes(issued.refreshToken), false);
  assert.equal(JSON.stringify(stored.rows[0]).includes(issued.accessToken), false);

  const rotated = await native.refresh({ refreshToken: issued.refreshToken });
  assert.equal(rotated.refreshToken, "F".repeat(43));
  assert.equal(rotated.accessToken, "G".repeat(43));
  await assert.rejects(
    () => native.refresh({ refreshToken: issued.refreshToken }),
    { code: "native_refresh_token_replayed" },
  );
  assert.equal(await native.authenticateAccessToken({ accessToken: rotated.accessToken }), null);
  assert.equal(await native.authenticateAccessToken({ accessToken: issued.accessToken }), null);
  const state = await pool.query(`
    SELECT status, revoked_at IS NOT NULL AS revoked
      FROM public.native_client_sessions
     WHERE client_session_id = $1
  `, [issued.clientSessionId]);
  assert.deepEqual(state.rows, [{ status: "revoked", revoked: true }]);
});

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  return value;
}
