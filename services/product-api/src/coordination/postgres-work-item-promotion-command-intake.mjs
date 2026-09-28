/**
 * PostgreSQL Command Intake for the synchronous, atomic private-task → Work
 * Item promotion.  It is intentionally not a generic command facade: the
 * target is always one newly-created Work Item and the command is completed in
 * the same transaction as the safe shared projection.
 */
export class PostgresWorkItemPromotionCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_work_item_promotion_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, uow } = {}) {
    assertPrincipal(principal);
    assertCommand(command);
    if (typeof persistTarget !== "function") throw coded("product_command_target_persistence_required");
    return this.#store.withTransaction(async (unit) => {
      const existing = await this.#command(unit, principal, command.commandId, true);
      if (existing) {
        assertSameCommand(existing, principal, command);
        return {
          command: view(existing),
          target: typeof loadTarget === "function"
            ? await loadTarget({ command: view(existing), uow: unit })
            : null,
          replayed: true,
        };
      }

      const decision = await this.#decision(unit, principal, command, at);
      const createdAt = timestamp(at);
      const accepted = (await this.#query(unit, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, target_kind, target_id, target_revision, status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', 'work_item_promote', 'work_item', $8, 1, 'accepted',
          $9::timestamptz, $9::timestamptz, '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, target_kind,
                  target_id, target_revision, status, created_at, updated_at, finished_at
      `, [
        command.commandId, principal.workspaceId, command.scopeId, principal.userId,
        decision.authorization_decision_id, decision.policy_revision_id,
        command.argumentDigest, command.workItemId, createdAt,
      ])).rows[0];
      const target = await persistTarget({ command: view(accepted), uow: unit });
      const completed = (await this.#query(unit, `
        UPDATE public.product_commands
           SET status = 'completed', updated_at = $4::timestamptz,
               finished_at = $4::timestamptz
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
           AND status = 'accepted'
         RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, target_kind,
                   target_id, target_revision, status, created_at, updated_at, finished_at
      `, [principal.workspaceId, command.commandId, principal.userId, createdAt])).rows[0];
      if (!completed) throw coded("product_command_transition_conflict");
      return { command: view(completed), target, replayed: false };
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #decision(uow, principal, command, at) {
    const row = (await this.#query(uow, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = 'work_item_promote' AND effect_class = 'execute'
         AND argument_digest = $5 AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $6::timestamptz)
       FOR SHARE
    `, [
      principal.workspaceId, command.authorizationDecisionId, command.scopeId,
      principal.userId, command.argumentDigest, timestamp(at),
    ])).rows[0];
    if (!row) throw coded("work_item_promote_authorization_required");
    return row;
  }

  async #command(uow, principal, commandId, lock) {
    if (typeof commandId !== "string" || !commandId) throw coded("product_command_id_required");
    return (await this.#query(uow, `
      SELECT command_id, workspace_id, scope_id, quota_user_id, kind, target_kind,
             target_id, target_revision, status, created_at, updated_at, finished_at
        FROM public.product_commands
       WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
         AND kind = 'work_item_promote'
       ${lock ? "FOR UPDATE" : ""}
    `, [principal.workspaceId, commandId, principal.userId])).rows[0] ?? null;
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw coded("postgres_work_item_promotion_principal_required");
  }
}

function assertCommand(command) {
  for (const [value, code] of [
    [command?.commandId, "postgres_work_item_promotion_command_id_required"],
    [command?.scopeId, "postgres_work_item_promotion_command_scope_required"],
    [command?.authorizationDecisionId, "work_item_promote_authorization_required"],
    [command?.argumentDigest, "postgres_work_item_promotion_command_digest_required"],
    [command?.workItemId, "postgres_work_item_promotion_work_item_required"],
  ]) if (typeof value !== "string" || !value) throw coded(code);
  if (command.kind !== "work_item_promote" || !/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)) {
    throw coded("postgres_work_item_promotion_command_shape_invalid");
  }
}

function assertSameCommand(row, principal, command) {
  if (row.workspace_id !== principal.workspaceId || row.quota_user_id !== principal.userId
    || row.scope_id !== command.scopeId || row.kind !== "work_item_promote"
    || row.target_kind !== "work_item" || row.target_id !== command.workItemId
    || Number(row.target_revision) !== 1) {
    throw coded("product_command_identity_conflict");
  }
}

function view(row) {
  return {
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    userId: row.quota_user_id,
    kind: row.kind,
    workItemId: row.target_id,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    finishedAt: row.finished_at == null ? null : timestamp(row.finished_at),
  };
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_work_item_promotion_command_clock_invalid");
  return date.toISOString();
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresWorkItemPromotionCommandIntakeError";
  error.code = code;
  return error;
}
