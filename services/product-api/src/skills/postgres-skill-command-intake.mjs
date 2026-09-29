/**
 * Product command owner for the two immutable Skill lifecycle operations.
 * It intentionally supports no arbitrary command kind or target contract.
 */
const KINDS = new Set(["skill_test", "skill_validation"]);
const TERMINAL = new Set(["completed", "failed", "blocked", "cancelled"]);

export class PostgresSkillCommandIntake {
  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) throw new TypeError("postgres_skill_command_store_required");
    this.store = store;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, uow } = {}) {
    principalOf(principal); commandOf(command);
    if (typeof persistTarget !== "function") throw coded("product_command_target_persistence_required");
    return this.store.withTransaction(async (unit) => {
      const existing = await this.#command(unit, principal, command.commandId, command.kind, true);
      if (existing) {
        same(existing, principal, command);
        return { command: view(existing), target: typeof loadTarget === "function" ? await loadTarget({ command: view(existing), uow: unit }) : null, replayed: true };
      }
      const decision = await this.#decision(unit, principal, command, at);
      const inserted = (await this.#query(unit, `INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, session_id, turn_id, status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', $8, $9, $10, 'accepted', clock_timestamp(), clock_timestamp(), '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
          status, invocation_id, attempt_id, created_at, updated_at, finished_at`, [
        command.commandId, principal.workspaceId, command.scopeId, principal.userId,
        decision.authorization_decision_id, decision.policy_revision_id, command.argumentDigest,
        command.kind, command.sessionId, command.turnId,
      ])).rows[0];
      const target = await persistTarget({ command: view(inserted), uow: unit });
      return { command: view(inserted), target, replayed: false };
    }, uow == null ? {} : { uow });
  }

  start({ principal, commandId, invocationId, attemptId, at, uow } = {}) { return this.#transition({ principal, commandId, at, uow, from: ["accepted"], to: "running", patch: { invocationId, attemptId } }); }
  async requestCancellation({ principal, commandId, authorizationDecisionId, argumentDigest, at, uow } = {}) {
    principalOf(principal);
    if (!allText([authorizationDecisionId, argumentDigest]) || !/^sha256:[a-f0-9]{64}$/.test(argumentDigest)) throw coded("cancel_skill_test_authorization_required");
    return this.store.withTransaction(async (unit) => {
      const current = await this.#commandAny(unit, principal, commandId, true);
      if (!current) throw coded("product_command_not_found");
      if (current.kind !== "skill_test" || !["accepted", "running", "cancellation_requested"].includes(current.status)) throw coded("product_command_transition_invalid");
      if (current.status === "cancellation_requested") return view(current);
      const decision = (await this.#query(unit, `SELECT authorization_decision_id FROM public.authorization_decisions
        WHERE workspace_id = $1 AND authorization_decision_id = $2 AND scope_id = $3
          AND actor_principal_id = $4 AND actor_principal_kind = 'user'
          AND effective_principal_id = $4 AND effective_principal_kind = 'user'
          AND action_id = 'cancel_skill_test' AND effect_class = 'execute' AND argument_digest = $5
          AND disposition = 'authorized' AND (expires_at IS NULL OR expires_at > $6::timestamptz) FOR SHARE`, [
        principal.workspaceId, authorizationDecisionId, current.scope_id, principal.userId, argumentDigest, timestamp(at),
      ])).rows[0];
      if (!decision) throw coded("cancel_skill_test_authorization_required");
      const now = timestamp(at);
      const row = (await this.#query(unit, `UPDATE public.product_commands SET status = 'cancellation_requested',
          updated_at = $4::timestamptz WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
          RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
          status, invocation_id, attempt_id, created_at, updated_at, finished_at`, [
        principal.workspaceId, commandId, principal.userId, now,
      ])).rows[0];
      return view(row);
    }, uow == null ? {} : { uow });
  }
  settle({ principal, commandId, status, at, uow } = {}) { if (!TERMINAL.has(status)) throw coded("product_command_terminal_status_required"); return this.#transition({ principal, commandId, at, uow, from: ["accepted", "running", "cancellation_requested"], to: status }); }
  requeue({ principal, commandId, at, uow } = {}) { return this.#transition({ principal, commandId, at, uow, from: ["running"], to: "accepted", clearAttempt: true }); }

  async recover({ principal, commandId, uow } = {}) {
    principalOf(principal);
    return this.store.withTransaction(async (unit) => {
      const row = await this.#commandAny(unit, principal, commandId, false);
      return row ? view(row) : null;
    }, uow == null ? {} : { uow });
  }

  async recoverByLineage({ commandId, workspaceId, kind, sessionId, turnId, uow } = {}) {
    if (!KINDS.has(kind) || !allText([commandId, workspaceId, sessionId, turnId])) throw coded("product_command_lineage_invalid");
    return this.store.withTransaction(async (unit) => {
      const row = (await this.#query(unit, `SELECT command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
          status, invocation_id, attempt_id, created_at, updated_at, finished_at
        FROM public.product_commands WHERE workspace_id = $1 AND command_id = $2 AND kind = $3 AND session_id = $4 AND turn_id = $5`, [workspaceId, commandId, kind, sessionId, turnId])).rows[0];
      return row ? view(row) : null;
    }, uow == null ? {} : { uow });
  }

  async listRecoverable({ kind, limit = 1_000, uow } = {}) {
    if (kind !== "skill_test") throw coded("product_command_recovery_kind_unsupported");
    const bounded = Math.min(Math.max(Number(limit) || 1_000, 1), 1_000);
    return this.store.withTransaction(async (unit) => (await this.#query(unit, `SELECT command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
        status, invocation_id, attempt_id, created_at, updated_at, finished_at
      FROM public.product_commands WHERE kind = 'skill_test' AND status IN ('accepted', 'running', 'cancellation_requested')
      ORDER BY updated_at, command_id LIMIT $1`, [bounded])).rows.map(view), uow == null ? {} : { uow });
  }

  async #transition({ principal, commandId, at, uow, from, to, patch = {}, clearAttempt = false }) {
    principalOf(principal);
    return this.store.withTransaction(async (unit) => {
      const current = await this.#commandAny(unit, principal, commandId, true);
      if (!current) throw coded("product_command_not_found");
      if (current.status === to) return view(current);
      if (!from.includes(current.status)) throw coded("product_command_transition_invalid");
      const now = timestamp(at); const terminal = TERMINAL.has(to);
      const row = (await this.#query(unit, `UPDATE public.product_commands SET status = $4, updated_at = $5::timestamptz,
          finished_at = CASE WHEN $6 THEN $5::timestamptz ELSE NULL END,
          invocation_id = CASE WHEN $7::boolean THEN NULL ELSE COALESCE($8, invocation_id) END,
          attempt_id = CASE WHEN $7::boolean THEN NULL ELSE COALESCE($9, attempt_id) END
        WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
          status, invocation_id, attempt_id, created_at, updated_at, finished_at`, [principal.workspaceId, commandId, principal.userId, to, now, terminal, clearAttempt, patch.invocationId ?? null, patch.attemptId ?? null])).rows[0];
      return view(row);
    }, uow == null ? {} : { uow });
  }

  async #decision(uow, principal, command, at) {
    const row = (await this.#query(uow, `SELECT authorization_decision_id, policy_revision_id FROM public.authorization_decisions
      WHERE workspace_id = $1 AND authorization_decision_id = $2 AND scope_id = $3
        AND actor_principal_id = $4 AND actor_principal_kind = 'user'
        AND effective_principal_id = $4 AND effective_principal_kind = 'user'
        AND action_id = $5 AND effect_class = 'execute' AND argument_digest = $6
        AND disposition = 'authorized' AND (expires_at IS NULL OR expires_at > $7::timestamptz) FOR SHARE`, [principal.workspaceId, command.authorizationDecisionId, command.scopeId, principal.userId, command.kind, command.argumentDigest, timestamp(at)])).rows[0];
    if (!row) throw coded(`${command.kind}_authorization_required`);
    return row;
  }
  async #command(unit, principal, commandId, kind, lock) { return this.#one(unit, principal, commandId, kind, lock); }
  async #commandAny(unit, principal, commandId, lock) { return this.#one(unit, principal, commandId, null, lock); }
  async #one(unit, principal, commandId, kind, lock) {
    if (typeof commandId !== "string" || !commandId) throw coded("product_command_id_required");
    return (await this.#query(unit, `SELECT command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
      status, invocation_id, attempt_id, created_at, updated_at, finished_at FROM public.product_commands
      WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3${kind ? " AND kind = $4" : ""} ${lock ? "FOR UPDATE" : ""}`, kind ? [principal.workspaceId, commandId, principal.userId, kind] : [principal.workspaceId, commandId, principal.userId])).rows[0] ?? null;
  }
  #query(uow, text, values = []) { return this.sql.query(uow, text, values); }
}

function principalOf(value) { if (!allText([value?.workspaceId, value?.userId])) throw coded("postgres_skill_command_principal_required"); }
function commandOf(value) { if (!KINDS.has(value?.kind) || !allText([value?.commandId, value?.scopeId, value?.authorizationDecisionId, value?.argumentDigest, value?.sessionId, value?.turnId]) || !/^sha256:[a-f0-9]{64}$/.test(value.argumentDigest)) throw coded("postgres_skill_command_shape_invalid"); }
function same(row, principal, command) { if (row.workspace_id !== principal.workspaceId || row.quota_user_id !== principal.userId || row.scope_id !== command.scopeId || row.kind !== command.kind || row.session_id !== command.sessionId || row.turn_id !== command.turnId) throw coded("product_command_identity_conflict"); }
function view(row) { return Object.freeze({ commandId: row.command_id, workspaceId: row.workspace_id, scopeId: row.scope_id, userId: row.quota_user_id, kind: row.kind, sessionId: row.session_id ?? null, turnId: row.turn_id ?? null, status: row.status, invocationId: row.invocation_id ?? null, attemptId: row.attempt_id ?? null, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), finishedAt: row.finished_at == null ? null : timestamp(row.finished_at) }); }
function allText(values) { return values.every((value) => typeof value === "string" && value.length > 0); }
function timestamp(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_skill_command_clock_invalid"); return date.toISOString(); }
function coded(code) { const error = new Error(code); error.name = "PostgresSkillCommandIntakeError"; error.code = code; return error; }
