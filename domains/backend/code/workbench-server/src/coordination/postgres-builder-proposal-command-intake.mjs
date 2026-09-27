/**
 * PostgreSQL Command Intake for a bounded Builder proposal. This is a named
 * product command boundary, not a generic command/repository facade.
 */
export class PostgresBuilderProposalCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_builder_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, uow } = {}) {
    assertPrincipal(principal); assertCommand(command);
    if (typeof persistTarget !== "function") throw coded("product_command_target_persistence_required");
    return this.#store.withTransaction(async (unit) => {
      const existing = await this.#command(unit, principal, command.commandId, true);
      if (existing) {
        assertSameCommand(existing, principal, command);
        return {
          command: view(existing),
          target: typeof loadTarget === "function" ? await loadTarget({ command: view(existing), uow: unit }) : null,
          replayed: true,
        };
      }
      const decision = await this.#decision(unit, principal, command, at);
      const inserted = (await this.#query(unit, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, session_id, turn_id, status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', 'builder_proposal', $8, $9, 'accepted', clock_timestamp(), clock_timestamp(), '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, status,
                  created_at, updated_at, finished_at
      `, [command.commandId, principal.workspaceId, command.scopeId, principal.userId,
        decision.authorization_decision_id, decision.policy_revision_id,
        command.argumentDigest, command.sessionId ?? null, command.turnId ?? null])).rows[0];
      const target = await persistTarget({ command: view(inserted), uow: unit });
      return { command: view(inserted), target, replayed: false };
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async start({ principal, commandId, at, uow } = {}) {
    return this.#transition({ principal, commandId, at, uow, from: ["accepted"], to: "running" });
  }

  async settle({ principal, commandId, status, at, uow } = {}) {
    if (!["completed", "failed", "blocked", "cancelled"].includes(status)) throw coded("product_command_terminal_status_required");
    return this.#transition({ principal, commandId, at, uow, from: ["accepted", "running", "cancellation_requested"], to: status });
  }

  async recover({ principal, commandId, uow } = {}) {
    assertPrincipal(principal);
    return this.#store.withTransaction(async (unit) => {
      const row = await this.#command(unit, principal, commandId, false);
      return row ? view(row) : null;
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #transition({ principal, commandId, at, uow, from, to }) {
    assertPrincipal(principal);
    return this.#store.withTransaction(async (unit) => {
      const current = await this.#command(unit, principal, commandId, true);
      if (!current) throw coded("product_command_not_found");
      if (current.status === to) return view(current);
      if (!from.includes(current.status)) throw coded("product_command_transition_invalid");
      const now = timestamp(at);
      const terminal = ["completed", "failed", "blocked", "cancelled"].includes(to);
      const row = (await this.#query(unit, `
        UPDATE public.product_commands
           SET status = $4, updated_at = $5::timestamptz,
               finished_at = CASE WHEN $6 THEN $5::timestamptz ELSE NULL END
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, status,
                  created_at, updated_at, finished_at
      `, [principal.workspaceId, commandId, principal.userId, to, now, terminal])).rows[0];
      return view(row);
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #decision(uow, principal, command, at) {
    const row = (await this.#query(uow, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = 'builder_proposal' AND effect_class = 'execute'
         AND argument_digest = $5 AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $6::timestamptz)
       FOR SHARE
    `, [principal.workspaceId, command.authorizationDecisionId, command.scopeId, principal.userId,
      command.argumentDigest, timestamp(at)])).rows[0];
    if (!row) throw coded("builder_proposal_authorization_required");
    return row;
  }

  async #command(uow, principal, commandId, lock) {
    if (typeof commandId !== "string" || !commandId) throw coded("product_command_id_required");
    return (await this.#query(uow, `
      SELECT command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id, status,
             created_at, updated_at, finished_at
        FROM public.product_commands
       WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
         AND kind = 'builder_proposal' ${lock ? "FOR UPDATE" : ""}
    `, [principal.workspaceId, commandId, principal.userId])).rows[0] ?? null;
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw coded("postgres_builder_command_principal_required");
  }
}

function assertCommand(command) {
  for (const [value, code] of [[command?.commandId, "postgres_builder_command_id_required"], [command?.scopeId, "postgres_builder_command_scope_required"], [command?.authorizationDecisionId, "builder_proposal_authorization_required"], [command?.argumentDigest, "postgres_builder_command_digest_required"]]) {
    if (typeof value !== "string" || !value) throw coded(code);
  }
  if ((command.sessionId == null) !== (command.turnId == null)
    || (command.sessionId != null && (typeof command.sessionId !== "string" || !command.sessionId || typeof command.turnId !== "string" || !command.turnId))) {
    throw coded("postgres_builder_command_lineage_invalid");
  }
  if (command.kind !== "builder_proposal" || !/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)) {
    throw coded("postgres_builder_command_shape_invalid");
  }
}

function assertSameCommand(row, principal, command) {
  if (row.workspace_id !== principal.workspaceId || row.quota_user_id !== principal.userId
    || row.scope_id !== command.scopeId || row.kind !== "builder_proposal"
    || (row.session_id ?? null) !== (command.sessionId ?? null)
    || (row.turn_id ?? null) !== (command.turnId ?? null)) {
    throw coded("product_command_identity_conflict");
  }
}

function view(row) {
  return {
    commandId: row.command_id, workspaceId: row.workspace_id, scopeId: row.scope_id,
    userId: row.quota_user_id, kind: row.kind, status: row.status,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    finishedAt: row.finished_at == null ? null : timestamp(row.finished_at),
  };
}
function timestamp(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_builder_command_clock_invalid"); return date.toISOString(); }
function coded(code) { const error = new Error(code); error.name = "PostgresBuilderProposalCommandIntakeError"; error.code = code; return error; }
