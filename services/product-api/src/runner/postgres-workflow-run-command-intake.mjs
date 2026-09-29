/**
 * Product command adapter for the canonical B3 Workflow Run root.
 *
 * It consumes an already-governed authorization decision; it never mints one
 * from a browser request or turns a workflow into a synthetic Agent Turn.
 */
export class PostgresWorkflowRunCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_workflow_run_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, session } = {}) {
    if (typeof persistTarget !== "function") {
      throw new TypeError("postgres_workflow_run_command_target_persistence_required");
    }
    assertWorkflowCommand(principal, command);
    return this.#store.withTransaction(async (uow) => {
      const existing = (await this.#query(uow, `
        SELECT command_id, workspace_id, scope_id, quota_user_id, kind, status,
               actor_principal_id, actor_principal_kind,
               effective_principal_id, effective_principal_kind,
               target_id, created_at, updated_at, finished_at
          FROM public.product_commands
         WHERE workspace_id = $1 AND command_id = $2
         FOR UPDATE
      `, [principal.workspaceId, command.commandId])).rows[0];
      if (existing) {
        assertStoredCommandMatches(existing, principal, command);
        const target = typeof loadTarget === "function"
          ? await loadTarget({ command: commandView(existing), session: uow })
          : null;
        return { command: commandView(existing), target, replayed: true };
      }

      const databaseNow = (await this.#query(
        uow,
        "SELECT clock_timestamp() AS now",
      )).rows[0].now;

      const authority = commandAuthority(principal, command);
      const decision = (await this.#query(uow, `
        SELECT authorization_decision_id, scope_id, policy_revision_id,
               actor_principal_id, actor_principal_kind,
               effective_principal_id, effective_principal_kind,
               effect_class, argument_digest, disposition, expires_at
          FROM public.authorization_decisions
         WHERE workspace_id = $1 AND authorization_decision_id = $2
           AND scope_id = $3 AND actor_principal_id = $4
           AND actor_principal_kind = $5
           AND effective_principal_id = $6 AND effective_principal_kind = $7
           AND action_id = 'workflow_run' AND effect_class = 'execute'
           AND argument_digest = $8 AND disposition = 'authorized'
           AND (expires_at IS NULL OR expires_at > $9::timestamptz)
         FOR SHARE
      `, [
        principal.workspaceId, command.authorizationDecisionId, command.scopeId,
        authority.actorPrincipalId, authority.actorPrincipalKind,
        authority.effectivePrincipalId, authority.effectivePrincipalKind,
        command.argumentDigest, databaseNow,
      ])).rows[0];
      if (!decision) throw coded("workflow_run_authorization_required");

      const inserted = (await this.#query(uow, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id,
          actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind,
          authorization_decision_id, policy_revision_id,
          effect_class, argument_digest, quota_user_id,
          schema_version, kind, target_kind, target_id, target_revision,
          status, created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3,
          $4, $5, $6, $7,
          $8, $9,
          'execute', $10, $11,
          'workbench-v1', 'workflow_run', 'workflow_run', $12, 1,
          'accepted', $13, $13, '{}'::jsonb
        )
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, status,
                  target_id, created_at, updated_at, finished_at
      `, [
        command.commandId, principal.workspaceId, command.scopeId,
        authority.actorPrincipalId, authority.actorPrincipalKind,
        authority.effectivePrincipalId, authority.effectivePrincipalKind,
        decision.authorization_decision_id, decision.policy_revision_id,
        command.argumentDigest, principal.userId, command.targetId, databaseNow,
      ])).rows[0];
      const persisted = await persistTarget({ session: uow, command: commandView(inserted) });
      return { command: commandView(inserted), target: persisted, replayed: false };
    }, session === undefined ? {} : { uow: session });
  }

  async start({ principal, commandId, at, session } = {}) {
    return this.#transition({ principal, commandId, at, session, target: "running" });
  }

  async requestCancellation({ principal, commandId, at, session } = {}) {
    return this.#transition({ principal, commandId, at, session, target: "cancellation_requested" });
  }

  async settle({ principal, commandId, status, at, session } = {}) {
    if (!["completed", "failed", "cancelled", "blocked"].includes(status)) {
      throw coded("product_command_terminal_status_required");
    }
    return this.#transition({ principal, commandId, at, session, target: status });
  }

  async recover({ principal, commandId, session } = {}) {
    assertPrincipal(principal);
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        SELECT command_id, workspace_id, scope_id, quota_user_id, kind, status,
               target_id, created_at, updated_at, finished_at
          FROM public.product_commands
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
           AND kind = 'workflow_run'
      `, [principal.workspaceId, commandId, principal.userId])).rows[0];
      return row ? commandView(row) : null;
    }, session === undefined ? {} : { uow: session });
  }

  async #transition({ principal, commandId, at, session, target }) {
    assertPrincipal(principal);
    return this.#store.withTransaction(async (uow) => {
      const current = (await this.#query(uow, `
        SELECT command_id, workspace_id, scope_id, quota_user_id, kind, status,
               target_id, created_at, updated_at, finished_at
          FROM public.product_commands
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
           AND kind = 'workflow_run'
         FOR UPDATE
      `, [principal.workspaceId, commandId, principal.userId])).rows[0];
      if (!current) throw coded("product_command_not_found");
      if (current.status === target) return commandView(current);
      const legal = target === "running"
        ? current.status === "accepted"
        : target === "cancellation_requested"
          ? ["accepted", "running"].includes(current.status)
          : ["accepted", "running", "cancellation_requested"].includes(current.status);
      if (!legal) throw coded("product_command_transition_invalid");
      const finished = ["completed", "failed", "cancelled", "blocked"].includes(target);
      const updated = (await this.#query(uow, `
        WITH authority_clock AS (
          SELECT clock_timestamp() AS now
        )
        UPDATE public.product_commands
           SET status = $4, updated_at = authority_clock.now,
               finished_at = CASE WHEN $5 THEN authority_clock.now ELSE NULL END
          FROM authority_clock
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
         RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, status,
                   target_id, created_at, updated_at, finished_at
      `, [principal.workspaceId, commandId, principal.userId, target, finished])).rows[0];
      return commandView(updated);
    }, session === undefined ? {} : { uow: session });
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw new TypeError("postgres_workflow_run_command_principal_required");
  }
}

function assertWorkflowCommand(principal, command) {
  assertPrincipal(principal);
  for (const [value, code] of [
    [command?.commandId, "postgres_workflow_run_command_id_required"],
    [command?.scopeId, "postgres_workflow_run_command_scope_required"],
    [command?.targetId, "postgres_workflow_run_command_target_required"],
    [command?.authorizationDecisionId, "postgres_workflow_run_authorization_required"],
    [command?.argumentDigest, "postgres_workflow_run_argument_digest_required"],
  ]) {
    if (typeof value !== "string" || !value) throw coded(code);
  }
  if (command.kind !== "workflow_run" || command.targetKind !== "workflow_run"
    || command.targetRevision !== 1 || !/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)) {
    throw coded("postgres_workflow_run_command_shape_invalid");
  }
  commandAuthority(principal, command);
}

function assertStoredCommandMatches(row, principal, command) {
  const authority = commandAuthority(principal, command);
  if (row.workspace_id !== principal.workspaceId || row.quota_user_id !== principal.userId
    || row.kind !== "workflow_run" || row.scope_id !== command.scopeId
    || row.target_id !== command.targetId
    || row.actor_principal_id !== authority.actorPrincipalId
    || row.actor_principal_kind !== authority.actorPrincipalKind
    || row.effective_principal_id !== authority.effectivePrincipalId
    || row.effective_principal_kind !== authority.effectivePrincipalKind) {
    throw coded("product_command_identity_conflict");
  }
}

function commandAuthority(principal, command) {
  const supplied = command?.actorPrincipalId !== undefined
    || command?.actorPrincipalKind !== undefined
    || command?.effectivePrincipalId !== undefined
    || command?.effectivePrincipalKind !== undefined;
  if (!supplied) {
    return {
      actorPrincipalId: principal.userId,
      actorPrincipalKind: "user",
      effectivePrincipalId: principal.userId,
      effectivePrincipalKind: "user",
    };
  }
  if (command.actorPrincipalKind !== "scheduler"
    || command.effectivePrincipalKind !== "automation"
    || typeof command.actorPrincipalId !== "string"
    || !command.actorPrincipalId
    || typeof command.effectivePrincipalId !== "string"
    || !command.effectivePrincipalId) {
    throw coded("postgres_workflow_run_command_authority_invalid");
  }
  return {
    actorPrincipalId: command.actorPrincipalId,
    actorPrincipalKind: command.actorPrincipalKind,
    effectivePrincipalId: command.effectivePrincipalId,
    effectivePrincipalKind: command.effectivePrincipalKind,
  };
}

function commandView(row) {
  return {
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    userId: row.quota_user_id,
    kind: row.kind,
    targetId: row.target_id,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    finishedAt: iso(row.finished_at),
  };
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
