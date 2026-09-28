import { randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import {
  assertNativeDevicePublicKey,
  hashNativeToken,
  issueNativeSecret,
  verifyCodeChallenge,
} from "./native-client-crypto.mjs";

const CLIENT_KINDS = new Set(["desktop", "mobile"]);

const timestamp = (value, code = "native_client_clock_invalid") => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(code);
  return date.toISOString();
};

const required = (value, code) => {
  if (typeof value !== "string" || !value) throw new ProductStoreError(code, code);
  return value;
};

const clientKind = (value) => {
  if (!CLIENT_KINDS.has(value)) {
    throw new ProductStoreError("native_client_kind_invalid", "The native client kind is invalid.");
  }
  return value;
};

const nativeSession = (row) => row ? Object.freeze({
  clientSessionId: row.client_session_id,
  userId: row.user_id,
  workspaceId: row.workspace_id,
  activeWorkspaceId: row.workspace_id,
  clientKind: row.client_kind,
  devicePublicKey: row.device_public_key,
  refreshFamilyId: row.refresh_family_id,
  status: row.status,
  expiresAt: timestamp(row.expires_at),
}) : null;

/**
 * PostgreSQL authority owner for native Desktop/Mobile client credentials.
 * It persists only token hashes and makes refresh replay revoke the whole
 * client session before any newly issued credential can be used.
 */
export class PostgresNativeClientSessionStore {
  #store;
  #sql;
  #clock;
  #idFactory;
  #secretFactory;
  #accessTtlMilliseconds;
  #refreshTtlMilliseconds;
  #authorizationTtlMilliseconds;

  constructor({
    store,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    secretFactory = issueNativeSecret,
    accessTtlMilliseconds = 15 * 60 * 1000,
    refreshTtlMilliseconds = 30 * 24 * 60 * 60 * 1000,
    authorizationTtlMilliseconds = 10 * 60 * 1000,
  } = {}) {
    if (!store?.connect || !store?.withTransaction || !store?.bindAdapter) {
      throw new TypeError("postgres_native_client_session_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function" || typeof secretFactory !== "function") {
      throw new TypeError("native_client_session_dependencies_invalid");
    }
    for (const value of [accessTtlMilliseconds, refreshTtlMilliseconds, authorizationTtlMilliseconds]) {
      if (!Number.isSafeInteger(value) || value < 60_000) throw new TypeError("native_client_session_ttl_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#secretFactory = secretFactory;
    this.#accessTtlMilliseconds = accessTtlMilliseconds;
    this.#refreshTtlMilliseconds = refreshTtlMilliseconds;
    this.#authorizationTtlMilliseconds = authorizationTtlMilliseconds;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async createAuthorization({ authorizationId, clientKind: requestedClientKind, redirectUri, codeChallenge, devicePublicKey } = {}) {
    required(authorizationId, "native_authorization_id_required");
    clientKind(requestedClientKind);
    required(redirectUri, "native_redirect_uri_invalid");
    required(codeChallenge, "native_authorization_invalid");
    assertNativeDevicePublicKey(devicePublicKey);
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const expiresAt = addMilliseconds(now, this.#authorizationTtlMilliseconds);
      await query(`
        INSERT INTO public.native_authorizations (
          authorization_id, client_kind, redirect_uri, code_challenge, device_public_key,
          status, user_id, workspace_id, authorization_code_hash,
          created_at, expires_at, approved_at, consumed_at, payload
        ) VALUES ($1, $2, $3, $4, $5, 'pending', NULL, NULL, NULL,
          $6::timestamptz, $7::timestamptz, NULL, NULL, '{}'::jsonb)
      `, [authorizationId, requestedClientKind, redirectUri, codeChallenge, devicePublicKey, now, expiresAt]);
      return Object.freeze({ authorizationId, expiresAt });
    });
  }

  async approveAuthorization({ authorizationId, userId, workspaceId, authorizationCode = null } = {}) {
    required(authorizationId, "native_authorization_id_required");
    required(userId, "user_id_required");
    required(workspaceId, "workspace_id_required");
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const authorization = (await query(`
        SELECT authorization_id, status, expires_at, redirect_uri
          FROM public.native_authorizations
         WHERE authorization_id = $1
         FOR UPDATE
      `, [authorizationId])).rows[0];
      if (!authorization) throw unavailable();
      if (authorization.status !== "pending" || new Date(authorization.expires_at).getTime() <= new Date(now).getTime()) {
        if (authorization.status === "pending") {
          await query(`DELETE FROM public.native_authorizations WHERE authorization_id = $1`, [authorizationId]);
        }
        throw expired();
      }
      const membership = await query(`
        SELECT 1
          FROM public.workspace_memberships membership
          JOIN public.product_users user_account ON user_account.user_id = membership.user_id
         WHERE membership.workspace_id = $1 AND membership.user_id = $2
           AND membership.status = 'active' AND user_account.disabled = false
         FOR SHARE OF membership, user_account
      `, [workspaceId, userId]);
      if (membership.rowCount !== 1) throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
      const rawAuthorizationCode = authorizationCode ?? this.#secret();
      const authorizationCodeHash = hashNativeToken(rawAuthorizationCode);
      await query(`
        UPDATE public.native_authorizations
           SET status = 'approved', user_id = $2, workspace_id = $3,
               authorization_code_hash = $4, approved_at = $5::timestamptz
         WHERE authorization_id = $1
      `, [authorizationId, userId, workspaceId, authorizationCodeHash, now]);
      return {
        authorizationId,
        authorizationCode: rawAuthorizationCode,
        redirectUri: authorization.redirect_uri,
        expiresAt: timestamp(authorization.expires_at),
      };
    });
  }

  async consumeAuthorization({ authorizationId, authorizationCode, codeVerifier, devicePublicKey } = {}) {
    required(authorizationId, "native_authorization_id_required");
    required(authorizationCode, "native_authorization_code_invalid");
    required(codeVerifier, "native_authorization_invalid");
    assertNativeDevicePublicKey(devicePublicKey);
    const authorizationCodeHash = hashNativeToken(authorizationCode);
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const authorization = (await query(`
        SELECT authorization_id, client_kind, code_challenge, device_public_key,
               user_id, workspace_id, status, expires_at, authorization_code_hash
          FROM public.native_authorizations
         WHERE authorization_id = $1
         FOR UPDATE
      `, [authorizationId])).rows[0];
      if (!authorization || authorization.status !== "approved") throw unavailable();
      if (new Date(authorization.expires_at).getTime() <= new Date(now).getTime()) {
        await query(`DELETE FROM public.native_authorizations WHERE authorization_id = $1`, [authorizationId]);
        throw expired();
      }
      if (authorization.authorization_code_hash !== authorizationCodeHash) throw unavailable();
      if (authorization.device_public_key !== devicePublicKey) {
        throw new ProductStoreError("native_device_key_mismatch", "The native device proof does not match the approved client.");
      }
      verifyCodeChallenge({ codeVerifier, codeChallenge: authorization.code_challenge });
      const membership = await query(`
        SELECT membership.status, user_account.disabled
          FROM public.workspace_memberships membership
          JOIN public.product_users user_account ON user_account.user_id = membership.user_id
         WHERE membership.workspace_id = $1 AND membership.user_id = $2
         FOR SHARE OF membership, user_account
      `, [authorization.workspace_id, authorization.user_id]);
      if (membership.rows[0]?.status !== "active" || membership.rows[0]?.disabled === true) {
        throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
      }
      const issued = await this.#issueTokenSet(query, {
        userId: authorization.user_id,
        workspaceId: authorization.workspace_id,
        clientKind: authorization.client_kind,
        devicePublicKey: authorization.device_public_key,
        now,
      });
      await query(`
        UPDATE public.native_authorizations
           SET status = 'consumed', consumed_at = $2::timestamptz
         WHERE authorization_id = $1
      `, [authorizationId, now]);
      return { ...issued, codeChallenge: authorization.code_challenge };
    });
  }

  async refresh({ refreshToken } = {}) {
    const tokenHash = hashNativeToken(refreshToken);
    await this.#store.connect();
    const outcome = await this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const refresh = (await query(`
        SELECT refresh.refresh_token_id, refresh.client_session_id, refresh.expires_at,
               refresh.consumed_at, refresh.revoked_at,
               session.user_id, session.workspace_id, session.client_kind,
               session.device_public_key, session.status AS session_status,
               session.expires_at AS session_expires_at
          FROM public.native_refresh_tokens refresh
          JOIN public.native_client_sessions session ON session.client_session_id = refresh.client_session_id
         WHERE refresh.token_hash = $1
         FOR UPDATE OF refresh, session
      `, [tokenHash])).rows[0];
      if (!refresh) throw unavailable();
      const invalid = refresh.session_status !== "active"
        || refresh.revoked_at !== null
        || new Date(refresh.expires_at).getTime() <= new Date(now).getTime()
        || new Date(refresh.session_expires_at).getTime() <= new Date(now).getTime();
      if (invalid) {
        await this.#revokeSession(query, refresh.client_session_id, now, "expired");
        return { kind: "expired" };
      }
      if (refresh.consumed_at !== null) {
        await this.#revokeSession(query, refresh.client_session_id, now, "revoked");
        return { kind: "replayed" };
      }
      const membership = await query(`
        SELECT membership.status, user_account.disabled
          FROM public.workspace_memberships membership
          JOIN public.product_users user_account ON user_account.user_id = membership.user_id
         WHERE membership.workspace_id = $1 AND membership.user_id = $2
         FOR SHARE OF membership, user_account
      `, [refresh.workspace_id, refresh.user_id]);
      if (membership.rows[0]?.status !== "active" || membership.rows[0]?.disabled === true) {
        await this.#revokeSession(query, refresh.client_session_id, now, "revoked");
        return { kind: "forbidden" };
      }
      const nextRefreshToken = this.#secret();
      const nextRefreshTokenId = this.#id("native-refresh-token");
      const nextRefreshExpiresAt = addMilliseconds(now, this.#refreshTtlMilliseconds);
      await query(`
        INSERT INTO public.native_refresh_tokens (
          refresh_token_id, client_session_id, token_hash, replaced_by_refresh_token_id,
          issued_at, expires_at, consumed_at, revoked_at, payload
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, $5::timestamptz, NULL, NULL, '{}'::jsonb)
      `, [nextRefreshTokenId, refresh.client_session_id, hashNativeToken(nextRefreshToken), now, nextRefreshExpiresAt]);
      await query(`
        UPDATE public.native_refresh_tokens
           SET consumed_at = $2::timestamptz, replaced_by_refresh_token_id = $3
         WHERE refresh_token_id = $1
      `, [refresh.refresh_token_id, now, nextRefreshTokenId]);
      const access = await this.#issueAccessToken(query, refresh.client_session_id, now);
      await query(`
        UPDATE public.native_client_sessions
           SET last_rotated_at = $2::timestamptz
         WHERE client_session_id = $1
      `, [refresh.client_session_id, now]);
      return Object.freeze({
        kind: "rotated",
        ...access,
        refreshToken: nextRefreshToken,
        refreshTokenExpiresAt: nextRefreshExpiresAt,
        clientSessionId: refresh.client_session_id,
        workspaceId: refresh.workspace_id,
      });
    });
    if (outcome.kind === "expired") throw expired();
    if (outcome.kind === "replayed") {
      throw new ProductStoreError("native_refresh_token_replayed", "This native session was revoked after refresh replay.");
    }
    if (outcome.kind === "forbidden") {
      throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
    }
    const { kind: _kind, ...result } = outcome;
    return Object.freeze(result);
  }

  async authenticateAccessToken({ accessToken } = {}) {
    const tokenHash = hashNativeToken(accessToken);
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const row = (await query(`
        SELECT session.client_session_id, session.user_id, session.workspace_id,
               session.client_kind, session.device_public_key, session.refresh_family_id,
               session.status, session.expires_at, access.expires_at AS access_expires_at,
               access.revoked_at AS access_revoked_at,
               membership.status AS membership_status, user_account.disabled AS user_disabled
          FROM public.native_access_tokens access
          JOIN public.native_client_sessions session ON session.client_session_id = access.client_session_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = session.workspace_id AND membership.user_id = session.user_id
          JOIN public.product_users user_account ON user_account.user_id = session.user_id
         WHERE access.token_hash = $1
         FOR UPDATE OF access, session
      `, [tokenHash])).rows[0];
      if (!row) return null;
      const invalid = row.access_revoked_at !== null || row.status !== "active"
        || row.membership_status !== "active" || row.user_disabled === true
        || new Date(row.access_expires_at).getTime() <= new Date(now).getTime()
        || new Date(row.expires_at).getTime() <= new Date(now).getTime();
      if (invalid) {
        await this.#revokeSession(query, row.client_session_id, now, "expired");
        return null;
      }
      return nativeSession(row);
    });
  }

  async listOwnedSessions({ userId, workspaceId } = {}) {
    required(userId, "user_id_required"); required(workspaceId, "workspace_id_required");
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const rows = (await query(`SELECT client_session_id, client_kind, created_at, expires_at
        FROM public.native_client_sessions
        WHERE user_id = $1 AND workspace_id = $2 AND status = 'active' AND expires_at > $3::timestamptz
        ORDER BY created_at DESC, client_session_id DESC`, [userId, workspaceId, now])).rows;
      return rows.map((row) => ({ clientSessionId: row.client_session_id, clientKind: row.client_kind,
        createdAt: timestamp(row.created_at), expiresAt: timestamp(row.expires_at) }));
    });
  }

  async revokeClientSession({ clientSessionId, userId = null, workspaceId = null } = {}) {
    required(clientSessionId, "native_client_session_id_required");
    await this.#store.connect();
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const row = (await query(`
        SELECT client_session_id, user_id, workspace_id
          FROM public.native_client_sessions
         WHERE client_session_id = $1
         FOR UPDATE
      `, [clientSessionId])).rows[0];
      if (!row || (userId && row.user_id !== userId) || (workspaceId && row.workspace_id !== workspaceId)) {
        return { revoked: false };
      }
      await this.#revokeSession(query, clientSessionId, now, "revoked");
      return { revoked: true };
    });
  }

  async #issueTokenSet(query, { userId, workspaceId, clientKind: requestedClientKind, devicePublicKey, now }) {
    const clientSessionId = this.#id("native-client-session");
    const refreshFamilyId = this.#id("native-refresh-family");
    const sessionExpiresAt = addMilliseconds(now, this.#refreshTtlMilliseconds);
    await query(`
      INSERT INTO public.native_client_sessions (
        client_session_id, user_id, workspace_id, client_kind, device_public_key,
        refresh_family_id, status, created_at, expires_at, last_rotated_at, revoked_at, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::timestamptz, $8::timestamptz,
        $7::timestamptz, NULL, '{}'::jsonb)
    `, [clientSessionId, userId, workspaceId, requestedClientKind, devicePublicKey, refreshFamilyId, now, sessionExpiresAt]);
    const refreshToken = this.#secret();
    const refreshTokenExpiresAt = sessionExpiresAt;
    await query(`
      INSERT INTO public.native_refresh_tokens (
        refresh_token_id, client_session_id, token_hash, replaced_by_refresh_token_id,
        issued_at, expires_at, consumed_at, revoked_at, payload
      ) VALUES ($1, $2, $3, NULL, $4::timestamptz, $5::timestamptz, NULL, NULL, '{}'::jsonb)
    `, [this.#id("native-refresh-token"), clientSessionId, hashNativeToken(refreshToken), now, refreshTokenExpiresAt]);
    const access = await this.#issueAccessToken(query, clientSessionId, now);
    return Object.freeze({
      ...access,
      refreshToken,
      refreshTokenExpiresAt,
      clientSessionId,
      workspaceId,
    });
  }

  async #issueAccessToken(query, clientSessionId, now) {
    const accessToken = this.#secret();
    const accessTokenExpiresAt = addMilliseconds(now, this.#accessTtlMilliseconds);
    await query(`
      INSERT INTO public.native_access_tokens (
        access_token_id, client_session_id, token_hash, issued_at, expires_at, revoked_at, payload
      ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, NULL, '{}'::jsonb)
    `, [this.#id("native-access-token"), clientSessionId, hashNativeToken(accessToken), now, accessTokenExpiresAt]);
    return { accessToken, accessTokenExpiresAt };
  }

  async #revokeSession(query, clientSessionId, now, status) {
    await query(`
      UPDATE public.native_client_sessions
         SET status = $2, revoked_at = COALESCE(revoked_at, $3::timestamptz)
       WHERE client_session_id = $1 AND status = 'active'
    `, [clientSessionId, status, now]);
    await query(`
      UPDATE public.native_refresh_tokens
         SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE client_session_id = $1 AND revoked_at IS NULL
    `, [clientSessionId, now]);
    await query(`
      UPDATE public.native_access_tokens
         SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE client_session_id = $1 AND revoked_at IS NULL
    `, [clientSessionId, now]);
  }

  async #databaseNow(query) {
    const row = (await query("SELECT clock_timestamp() AS now")).rows[0];
    return timestamp(row?.now ?? this.#clock());
  }

  #secret() {
    const value = this.#secretFactory();
    hashNativeToken(value);
    return value;
  }

  #id(kind) {
    const value = this.#idFactory(kind);
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
      throw new TypeError("native_client_session_id_factory_invalid");
    }
    return value;
  }

  #transaction(work) {
    return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values)));
  }
}

function addMilliseconds(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function unavailable() {
  return new ProductStoreError("native_authorization_unavailable", "The native authorization is unavailable.");
}

function expired() {
  return new ProductStoreError("native_authorization_expired", "The native authorization has expired.");
}
