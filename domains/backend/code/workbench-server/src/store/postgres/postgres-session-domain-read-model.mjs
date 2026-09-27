import {
  Check,
  checkSessionEventSemantics,
  SessionDomainEnvelopeSchema,
  SessionWatermarkSchema,
} from "@looloomi/workbench-contracts";

/**
 * Read-only owner for the non-authoritative Session domain envelope. It is
 * deliberately scoped to the caller's active personal scope; consumers do
 * not get a workspace-wide event feed or a second command surface.
 */
export class PostgresSessionDomainReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_session_domain_read_model_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async replay({ workspaceId, userId, after = 0, limit = 200 } = {}) {
    const identity = assertIdentity({ workspaceId, userId });
    const cursor = assertCursor(after);
    const boundedLimit = assertLimit(limit);
    return this.#store.withTransaction(async (uow) => {
      const scopeId = await this.#activePersonalScope(uow, identity);
      const rows = (await this.#query(uow, `
        SELECT event_id, session_id, session_kind, session_sequence, scope_id,
               domain_sequence, actor, authorizer, branch, lineage, payload_class,
               payload_ref, occurred_at
          FROM public.session_domain_events
         WHERE workspace_id = $1 AND scope_id = $2 AND domain_sequence > $3
         ORDER BY domain_sequence ASC
         LIMIT $4
      `, [identity.workspaceId, scopeId, cursor, boundedLimit + 1])).rows;
      const selected = rows.slice(0, boundedLimit).map(envelope);
      const cursorRow = (await this.#query(uow, `
        SELECT next_sequence FROM public.session_domain_scope_cursors
         WHERE workspace_id = $1 AND scope_id = $2
      `, [identity.workspaceId, scopeId])).rows[0];
      return Object.freeze({
        scopeId,
        events: selected,
        watermark: watermark(scopeId, Math.max(0, Number(cursorRow?.next_sequence ?? 1) - 1)),
        hasMore: rows.length > boundedLimit,
      });
    });
  }

  async watermark({ workspaceId, userId } = {}) {
    const identity = assertIdentity({ workspaceId, userId });
    return this.#store.withTransaction(async (uow) => {
      const scopeId = await this.#activePersonalScope(uow, identity);
      const row = (await this.#query(uow, `
        SELECT next_sequence FROM public.session_domain_scope_cursors
         WHERE workspace_id = $1 AND scope_id = $2
      `, [identity.workspaceId, scopeId])).rows[0];
      return watermark(scopeId, Math.max(0, Number(row?.next_sequence ?? 1) - 1));
    });
  }

  async #activePersonalScope(uow, { workspaceId, userId }) {
    const row = (await this.#query(uow, `
      SELECT scope.scope_id
        FROM public.product_scopes scope
        JOIN public.workspace_memberships membership
          ON membership.workspace_id = scope.workspace_id
         AND membership.user_id = $2 AND membership.status = 'active'
       WHERE scope.workspace_id = $1 AND scope.scope_kind = 'personal'
         AND scope.owner_user_id = $2 AND scope.status = 'active'
       FOR SHARE OF scope, membership
    `, [workspaceId, userId])).rows[0];
    if (!row) throw coded("session_domain_scope_unavailable");
    return row.scope_id;
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function envelope(row) {
  const value = {
    domain: "session",
    seq: Number(row.domain_sequence),
    eventId: row.event_id,
    sessionId: row.session_id,
    sessionKind: row.session_kind,
    sessionSequence: Number(row.session_sequence),
    scopeId: row.scope_id,
    actor: structuredClone(row.actor),
    authorizer: structuredClone(row.authorizer),
    ...(row.branch == null ? {} : { branch: structuredClone(row.branch) }),
    ...(row.lineage == null ? {} : { lineage: structuredClone(row.lineage) }),
    payloadClass: row.payload_class,
    payloadRef: structuredClone(row.payload_ref),
    occurredAt: iso(row.occurred_at),
  };
  if (!Check(SessionDomainEnvelopeSchema, value) || !checkSessionEventSemantics(value)) {
    throw coded("session_domain_event_contract_invalid");
  }
  return Object.freeze(value);
}

function watermark(scopeId, seq) {
  const value = { domain: "session", scopeId, seq };
  if (!Check(SessionWatermarkSchema, value)) throw coded("session_domain_watermark_contract_invalid");
  return Object.freeze(value);
}

function assertIdentity({ workspaceId, userId }) {
  if (typeof workspaceId !== "string" || !workspaceId || typeof userId !== "string" || !userId) {
    throw coded("session_domain_identity_required");
  }
  return { workspaceId, userId };
}
function assertCursor(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw coded("session_domain_cursor_invalid");
  return value;
}
function assertLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw coded("session_domain_limit_invalid");
  return value;
}
function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("session_domain_timestamp_invalid");
  return date.toISOString();
}
function coded(code) {
  const error = new Error(code);
  error.name = "PostgresSessionDomainReadModelError";
  error.code = code;
  return error;
}
