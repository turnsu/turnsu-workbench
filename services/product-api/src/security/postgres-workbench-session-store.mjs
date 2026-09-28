import { randomBytes, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { hashSessionToken } from "./workbench-session-store.mjs";

const token = () => randomBytes(32).toString("base64url");

const nowDate = (clock) => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("workbench_session_clock_invalid");
  return date;
};

const iso = (value) => new Date(value).toISOString();

const sessionFromRow = (row) => row ? ({
  sessionId: row.session_id,
  csrfToken: row.csrf_token,
  expiresAt: iso(row.expires_at),
  userId: row.user_id,
  activeWorkspaceId: row.active_workspace_id,
}) : null;

/**
 * PostgreSQL owner for browser sessions.  The public session contract remains
 * storage-neutral; this adapter receives only ProductPostgresStore's opaque
 * unit of work and never exposes a Pool or SQL callback to HTTP callers.
 */
export class PostgresWorkbenchSessionStore {
  #store;
  #clock;
  #ttlMilliseconds;
  #tokenFactory;
  #csrfTokenFactory;
  #idFactory;
  #sql;

  constructor({
    store,
    clock = () => new Date(),
    ttlMilliseconds = 7 * 24 * 60 * 60 * 1000,
    tokenFactory = token,
    csrfTokenFactory = token,
    idFactory = () => `session-${randomUUID()}`,
  } = {}) {
    if (!store?.connect || !store?.withTransaction || !store?.bindAdapter) {
      throw new TypeError("postgres_workbench_session_store_required");
    }
    if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds <= 0) {
      throw new TypeError("workbench_session_ttl_invalid");
    }
    for (const factory of [tokenFactory, csrfTokenFactory, idFactory]) {
      if (typeof factory !== "function") throw new TypeError("workbench_session_factory_required");
    }
    this.#store = store;
    this.#clock = clock;
    this.#ttlMilliseconds = ttlMilliseconds;
    this.#tokenFactory = tokenFactory;
    this.#csrfTokenFactory = csrfTokenFactory;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async issue({ userId, activeWorkspaceId } = {}) {
    await this.#store.connect();
    const rawToken = this.#tokenFactory();
    const csrfToken = this.#csrfTokenFactory();
    const now = nowDate(this.#clock);
    const expiresAt = new Date(now.getTime() + this.#ttlMilliseconds).toISOString();
    const session = {
      sessionId: this.#idFactory(),
      tokenHash: hashSessionToken(rawToken),
      csrfToken,
      userId,
      activeWorkspaceId,
      createdAt: now.toISOString(),
      expiresAt,
    };
    await this.#transaction(async (query) => {
      const membership = await query(`
        SELECT 1
          FROM public.workspace_memberships membership
          JOIN public.product_users user_account ON user_account.user_id = membership.user_id
         WHERE membership.workspace_id = $1
           AND membership.user_id = $2
           AND membership.status = 'active'
           AND user_account.disabled = false
      `, [activeWorkspaceId, userId]);
      if (membership.rowCount !== 1) {
        throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
      }
      await query(`
        INSERT INTO public.workbench_browser_sessions (
          session_id, user_id, active_workspace_id, schema_version, token_hash,
          csrf_token, created_at, expires_at, revoked_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, $5, $6::timestamptz, $7::timestamptz, NULL, '{}'::jsonb)
      `, [
        session.sessionId,
        session.userId,
        session.activeWorkspaceId,
        session.tokenHash,
        session.csrfToken,
        session.createdAt,
        session.expiresAt,
      ]);
    });
    return {
      token: rawToken,
      csrfToken,
      expiresAt,
      sessionId: session.sessionId,
      userId,
      activeWorkspaceId,
    };
  }

  async get(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    await this.#store.connect();
    const now = nowDate(this.#clock);
    return this.#transaction(async (query) => {
      const result = await query(`
        SELECT session.session_id, session.user_id, session.active_workspace_id,
               session.csrf_token, session.expires_at,
               user_account.disabled AS user_disabled,
               membership.status AS membership_status
          FROM public.workbench_browser_sessions session
          JOIN public.product_users user_account ON user_account.user_id = session.user_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = session.active_workspace_id
           AND membership.user_id = session.user_id
         WHERE session.token_hash = $1
           AND session.revoked_at IS NULL
         FOR UPDATE OF session
      `, [hashSessionToken(rawToken)]);
      const row = result.rows[0];
      if (!row) return null;
      const invalid = new Date(row.expires_at).getTime() <= now.getTime()
        || row.user_disabled === true
        || row.membership_status !== "active";
      if (invalid) {
        await query(`
          UPDATE public.workbench_browser_sessions
             SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
           WHERE session_id = $1
        `, [row.session_id, now.toISOString()]);
        return null;
      }
      return sessionFromRow(row);
    });
  }

  async revoke(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length === 0) return { revoked: false };
    await this.#store.connect();
    const revokedAt = nowDate(this.#clock).toISOString();
    return this.#transaction(async (query) => {
      const result = await query(`
        UPDATE public.workbench_browser_sessions
           SET revoked_at = $2::timestamptz
         WHERE token_hash = $1
           AND revoked_at IS NULL
        RETURNING session_id
      `, [hashSessionToken(rawToken), revokedAt]);
      return { revoked: result.rowCount === 1 };
    });
  }

  #transaction(work) {
    return this.#store.withTransaction((uow) => work((text, values) => this.#sql.query(uow, text, values)));
  }
}
