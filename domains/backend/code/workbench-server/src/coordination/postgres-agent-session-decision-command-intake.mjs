const DECISION_COMMANDS = Object.freeze({
  agent_handoff_confirm: Object.freeze({
    targetKind: "agent_handoff",
    authorizationCode: "agent_handoff_authorization_required",
  }),
  agent_proposal_apply: Object.freeze({
    targetKind: "agent_proposal",
    authorizationCode: "agent_proposal_authorization_required",
  }),
  agent_proposal_reject: Object.freeze({
    targetKind: "agent_proposal",
    authorizationCode: "agent_proposal_authorization_required",
  }),
});

/**
 * PostgreSQL Command Intake for the three user-owned Session decisions that
 * used to rely on a receipt plus membership check alone.  It is intentionally
 * narrow: each command resolves one Handoff or Module proposal and completes
 * in the same transaction as that aggregate's Session event.
 */
export class PostgresAgentSessionDecisionCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_agent_session_decision_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, uow } = {}) {
    assertPrincipal(principal);
    const definition = assertCommand(command);
    if (typeof persistTarget !== "function") {
      throw coded("product_command_target_persistence_required");
    }
    return this.#store.withTransaction(async (unit) => {
      const existing = await this.#command(unit, principal, command.commandId, true);
      if (existing) {
        assertSameCommand(existing, principal, command, definition);
        return {
          command: view(existing),
          target: typeof loadTarget === "function"
            ? await loadTarget({ command: view(existing), uow: unit })
            : null,
          replayed: true,
        };
      }

      const decision = await this.#decision(unit, principal, command, definition, at);
      const createdAt = timestamp(at);
      const accepted = (await this.#query(unit, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, target_kind, target_id, target_revision, status, created_at, updated_at, finished_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'write_local', $7, $4,
          'workbench-v1', $8, $9, $10, $11, 'completed', $12::timestamptz, $12::timestamptz,
          $12::timestamptz, '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, target_kind,
                  target_id, target_revision, status, created_at, updated_at, finished_at
      `, [
        command.commandId,
        principal.workspaceId,
        command.scopeId,
        principal.userId,
        decision.authorization_decision_id,
        decision.policy_revision_id,
        command.argumentDigest,
        command.kind,
        definition.targetKind,
        command.targetId,
        command.targetRevision,
        createdAt,
      ])).rows[0];
      const target = await persistTarget({ command: view(accepted), uow: unit });
      return { command: view(accepted), target, replayed: false };
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #decision(uow, principal, command, definition, at) {
    const row = (await this.#query(uow, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = $5 AND effect_class = 'write_local'
         AND argument_digest = $6 AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $7::timestamptz)
       FOR SHARE
    `, [
      principal.workspaceId,
      command.authorizationDecisionId,
      command.scopeId,
      principal.userId,
      command.kind,
      command.argumentDigest,
      timestamp(at),
    ])).rows[0];
    if (!row) throw coded(definition.authorizationCode);
    return row;
  }

  async #command(uow, principal, commandId, lock) {
    if (typeof commandId !== "string" || !commandId) {
      throw coded("product_command_id_required");
    }
    return (await this.#query(uow, `
      SELECT command_id, workspace_id, scope_id, quota_user_id, kind, target_kind,
             target_id, target_revision, status, created_at, updated_at, finished_at
        FROM public.product_commands
       WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
       ${lock ? "FOR UPDATE" : ""}
    `, [principal.workspaceId, commandId, principal.userId])).rows[0] ?? null;
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw coded("postgres_agent_session_decision_principal_required");
  }
}

function assertCommand(command) {
  for (const [value, code] of [
    [command?.commandId, "postgres_agent_session_decision_command_id_required"],
    [command?.scopeId, "postgres_agent_session_decision_command_scope_required"],
    [command?.authorizationDecisionId, "agent_session_decision_authorization_required"],
    [command?.argumentDigest, "postgres_agent_session_decision_command_digest_required"],
    [command?.targetId, "postgres_agent_session_decision_target_required"],
  ]) {
    if (typeof value !== "string" || !value) throw coded(code);
  }
  const definition = DECISION_COMMANDS[command.kind];
  if (!definition || !Number.isInteger(command.targetRevision) || command.targetRevision < 1
    || !/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)) {
    throw coded("postgres_agent_session_decision_command_shape_invalid");
  }
  return definition;
}

function assertSameCommand(row, principal, command, definition) {
  if (row.workspace_id !== principal.workspaceId
    || row.quota_user_id !== principal.userId
    || row.scope_id !== command.scopeId
    || row.kind !== command.kind
    || row.target_kind !== definition.targetKind
    || row.target_id !== command.targetId
    || Number(row.target_revision) !== command.targetRevision) {
    throw coded("product_command_identity_conflict");
  }
}

function view(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    userId: row.quota_user_id,
    kind: row.kind,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetRevision: Number(row.target_revision),
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    finishedAt: row.finished_at == null ? null : timestamp(row.finished_at),
  };
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("postgres_agent_session_decision_command_clock_invalid");
  }
  return date.toISOString();
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresAgentSessionDecisionCommandIntakeError";
  error.code = code;
  return error;
}
