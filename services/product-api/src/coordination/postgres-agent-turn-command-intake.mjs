const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);

/**
 * PostgreSQL Command Intake for Agent turns and resumptive Tool approvals. It consumes an
 * immutable decision created by the product authorizer; it never derives
 * authority from a browser request and it never exposes a raw PostgreSQL
 * client to the Agent persistence owner.
 */
export class PostgresAgentTurnCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_agent_command_intake_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, persistTarget, loadTarget, at, uow } = {}) {
    assertPrincipal(principal);
    assertAgentCommand(command, ["agent_turn", "agent_tool_approval_decide"]);
    if (typeof persistTarget !== "function") throw coded("product_command_target_persistence_required");
    return this.#store.withTransaction(async (uow) => {
      const existing = await this.#command(uow, principal, command.commandId, true);
      if (existing) {
        assertSameCommand(existing, command, principal);
        return {
          command: view(existing),
          target: typeof loadTarget === "function" ? await loadTarget({ command: view(existing), uow }) : null,
          replayed: true,
        };
      }
      const decision = await this.#decision(uow, principal, command, at);
      const inserted = await this.#insertAcceptedCommand(uow, {
        principal,
        command,
        decision,
        at,
      });
      const target = await persistTarget({ command: view(inserted), uow });
      return { command: view(inserted), target, replayed: false };
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async acceptCancellation({
    principal, command, targetCommandId = command?.targetCommandId, targetStatus,
    cancellationStatus = "completed", persistTarget, loadTarget, at, uow,
  } = {}) {
    assertPrincipal(principal);
    assertAgentCommand(command, "cancel_agent_turn");
    if (typeof persistTarget !== "function") throw coded("product_command_target_persistence_required");
    if (!TERMINAL.has(cancellationStatus)) throw coded("product_command_terminal_status_required");
    return this.#store.withTransaction(async (uow) => {
      const existing = await this.#command(uow, principal, command.commandId, true);
      if (existing) {
        assertSameCommand(existing, command, principal);
        const target = await this.#command(uow, principal, targetCommandId, false);
        return {
          command: view(existing),
          target: typeof loadTarget === "function"
            ? await loadTarget({ command: view(existing), targetCommand: view(target), uow }) : null,
          targetCommand: view(target), replayed: true,
        };
      }
      const target = await this.#command(uow, principal, targetCommandId, true);
      if (!target || target.kind !== "agent_turn" || target.scope_id !== command.scopeId
        || target.session_id !== command.sessionId || target.turn_id !== command.turnId) {
        throw coded("product_command_target_not_found");
      }
      if (!['accepted', 'running'].includes(target.status)) {
        throw coded(TERMINAL.has(target.status) ? "product_command_target_finished" : "product_command_transition_invalid");
      }
      const nextTargetStatus = targetStatus ?? (target.status === "accepted" ? "cancelled" : "cancellation_requested");
      const legal = target.status === "accepted"
        ? ["cancelled", "cancellation_requested"] : ["cancellation_requested"];
      if (!legal.includes(nextTargetStatus)) throw coded("product_command_transition_invalid");
      const decision = await this.#decision(uow, principal, command, at);
      const createdAt = timestamp(at);
      const cancellation = (await this.#query(uow, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, session_id, turn_id, target_command_id, status, created_at, updated_at, finished_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', 'cancel_agent_turn', $8, $9, $10, $11, $12::timestamptz,
          $12::timestamptz, $12::timestamptz, '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                  target_command_id, status, created_at, updated_at, finished_at
      `, [command.commandId, principal.workspaceId, command.scopeId, principal.userId,
        decision.authorization_decision_id, decision.policy_revision_id, command.argumentDigest,
        command.sessionId, command.turnId, targetCommandId, cancellationStatus, createdAt])).rows[0];
      const updatedTarget = (await this.#query(uow, `
        UPDATE public.product_commands
           SET status = $4, updated_at = $5::timestamptz,
               finished_at = CASE WHEN $6 THEN $5::timestamptz ELSE NULL END
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
         RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                   status, created_at, updated_at, finished_at
      `, [principal.workspaceId, targetCommandId, principal.userId, nextTargetStatus, createdAt,
        TERMINAL.has(nextTargetStatus)])).rows[0];
      if (!updatedTarget) throw coded("product_command_transition_conflict");
      const persisted = await persistTarget({
        command: view(cancellation), targetCommand: view(updatedTarget), uow,
      });
      return { command: view(cancellation), target: persisted, targetCommand: view(updatedTarget), replayed: false };
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async start({ principal, commandId, at, uow } = {}) {
    return this.#transition({ principal, commandId, at, uow, from: ["accepted"], to: "running" });
  }

  async settle({ principal, commandId, status, at, uow } = {}) {
    if (!TERMINAL.has(status)) throw coded("product_command_terminal_status_required");
    return this.#transition({ principal, commandId, at, uow, from: ["accepted", "running", "cancellation_requested"], to: status });
  }

  async requeue({ principal, commandId, at, uow } = {}) {
    return this.#transition({ principal, commandId, at, uow, from: ["running"], to: "accepted" });
  }

  async #transition({ principal, commandId, at, uow, from, to }) {
    assertPrincipal(principal);
    return this.#store.withTransaction(async (uow) => {
      const current = await this.#command(uow, principal, commandId, true);
      if (!current) throw coded("product_command_not_found");
      if (current.status === to) return view(current);
      if (!from.includes(current.status)) throw coded("product_command_transition_invalid");
      const now = timestamp(at);
      const updated = (await this.#query(uow, `
        UPDATE public.product_commands
           SET status = $4, updated_at = $5::timestamptz,
               finished_at = CASE WHEN $6 THEN $5::timestamptz ELSE NULL END
         WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
         RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                   status, created_at, updated_at, finished_at
      `, [principal.workspaceId, commandId, principal.userId, to, now, TERMINAL.has(to)])).rows[0];
      return view(updated);
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #decision(uow, principal, command, at) {
    const row = (await this.#query(uow, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = $5 AND effect_class = 'execute' AND argument_digest = $6
         AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $7::timestamptz)
       FOR SHARE
    `, [principal.workspaceId, command.authorizationDecisionId, command.scopeId, principal.userId,
      command.kind, command.argumentDigest, timestamp(at)])).rows[0];
    if (!row) throw coded("agent_command_authorization_required");
    return row;
  }

  async #command(uow, principal, commandId, lock) {
    if (typeof commandId !== "string" || !commandId) throw coded("product_command_id_required");
    return (await this.#query(uow, `
      SELECT command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
             target_kind, target_id, target_revision, target_command_id,
             status, created_at, updated_at, finished_at
        FROM public.product_commands
       WHERE workspace_id = $1 AND command_id = $2 AND quota_user_id = $3
       ${lock ? "FOR UPDATE" : ""}
    `, [principal.workspaceId, commandId, principal.userId])).rows[0] ?? null;
  }

  async #insertAcceptedCommand(uow, { principal, command, decision, at }) {
    const createdAt = timestamp(at);
    if (command.kind === "agent_tool_approval_decide") {
      return (await this.#query(uow, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, session_id, turn_id, target_kind, target_id, target_revision,
          status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', 'agent_tool_approval_decide', $8, $9,
          'agent_tool_approval', $10, 1, 'accepted', $11::timestamptz, $11::timestamptz,
          '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                  target_kind, target_id, target_revision, target_command_id,
                  status, created_at, updated_at, finished_at
      `, [
        command.commandId,
        principal.workspaceId,
        command.scopeId,
        principal.userId,
        decision.authorization_decision_id,
        decision.policy_revision_id,
        command.argumentDigest,
        command.sessionId,
        command.turnId,
        command.toolApprovalId,
        createdAt,
      ])).rows[0];
    }
    if (command.workItemId || command.continuationTurnTarget) {
      const targetKind = command.continuationTurnTarget
        ? "work_item_continuation_turn"
        : "work_item";
      const targetId = command.continuationTurnTarget
        ? command.turnId
        : command.workItemId;
      return (await this.#query(uow, `
        INSERT INTO public.product_commands (
          command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
          effective_principal_id, effective_principal_kind, authorization_decision_id,
          policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
          kind, session_id, turn_id, target_kind, target_id, target_revision,
          status, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
          'workbench-v1', 'agent_turn', $8, $9, $10, $11, 1,
          'accepted', $12::timestamptz, $12::timestamptz, '{}'::jsonb)
        RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                  target_kind, target_id, target_revision, target_command_id,
                  status, created_at, updated_at, finished_at
      `, [
        command.commandId,
        principal.workspaceId,
        command.scopeId,
        principal.userId,
        decision.authorization_decision_id,
        decision.policy_revision_id,
        command.argumentDigest,
        command.sessionId,
        command.turnId,
        targetKind,
        targetId,
        createdAt,
      ])).rows[0];
    }
    return (await this.#query(uow, `
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id, actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind, authorization_decision_id,
        policy_revision_id, effect_class, argument_digest, quota_user_id, schema_version,
        kind, session_id, turn_id, status, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'user', $4, 'user', $5, $6, 'execute', $7, $4,
        'workbench-v1', 'agent_turn', $8, $9, 'accepted', $10::timestamptz, $10::timestamptz, '{}'::jsonb)
      RETURNING command_id, workspace_id, scope_id, quota_user_id, kind, session_id, turn_id,
                target_kind, target_id, target_revision, target_command_id,
                status, created_at, updated_at, finished_at
    `, [command.commandId, principal.workspaceId, command.scopeId, principal.userId,
      decision.authorization_decision_id, decision.policy_revision_id,
      command.argumentDigest, command.sessionId, command.turnId, createdAt])).rows[0];
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw coded("postgres_agent_command_principal_required");
  }
}

function assertAgentCommand(command, expectedKind) {
  for (const [value, code] of [
    [command?.commandId, "postgres_agent_command_id_required"],
    [command?.scopeId, "postgres_agent_command_scope_required"],
    [command?.sessionId, "postgres_agent_command_session_required"],
    [command?.turnId, "postgres_agent_command_turn_required"],
    [command?.authorizationDecisionId, "agent_command_authorization_required"],
    [command?.argumentDigest, "postgres_agent_command_digest_required"],
  ]) if (typeof value !== "string" || !value) throw coded(code);
  const allowedKinds = Array.isArray(expectedKind) ? expectedKind : [expectedKind];
  if (!allowedKinds.includes(command.kind) || !/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)) {
    throw coded("postgres_agent_command_shape_invalid");
  }
  if (command.kind === "cancel_agent_turn" && (typeof command.targetCommandId !== "string" || !command.targetCommandId)) {
    throw coded("product_command_target_not_found");
  }
  if (command.kind === "agent_tool_approval_decide"
    && (typeof command.toolApprovalId !== "string" || !command.toolApprovalId)) {
    throw coded("agent_tool_approval_command_target_required");
  }
  if (command.workItemId !== undefined && command.workItemId !== null
    && (command.kind !== "agent_turn" || typeof command.workItemId !== "string" || !command.workItemId)) {
    throw coded("postgres_agent_command_shape_invalid");
  }
  if (command.continuationTurnTarget !== undefined && command.continuationTurnTarget !== null
    && (command.kind !== "agent_turn" || typeof command.continuationTurnTarget !== "object"
      || Array.isArray(command.continuationTurnTarget) || !command.workItemId)) {
    throw coded("postgres_agent_command_shape_invalid");
  }
}

function assertSameCommand(row, command, principal) {
  if (row.workspace_id !== principal.workspaceId || row.quota_user_id !== principal.userId
    || row.kind !== command.kind || row.scope_id !== command.scopeId
    || row.session_id !== command.sessionId || row.turn_id !== command.turnId
    || (row.target_command_id ?? null) !== (command.targetCommandId ?? null)
    || (command.kind === "agent_tool_approval_decide"
      ? row.target_kind !== "agent_tool_approval" || row.target_id !== command.toolApprovalId || Number(row.target_revision) !== 1
      : command.continuationTurnTarget
      ? row.target_kind !== "work_item_continuation_turn" || row.target_id !== command.turnId || Number(row.target_revision) !== 1
      : command.workItemId
      ? row.target_kind !== "work_item" || row.target_id !== command.workItemId || Number(row.target_revision) !== 1
      : row.target_kind !== null || row.target_id !== null || row.target_revision !== null)) {
    throw coded("product_command_identity_conflict");
  }
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_agent_command_clock_invalid");
  return date.toISOString();
}

function view(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    userId: row.quota_user_id,
    kind: row.kind,
    sessionId: row.session_id,
    turnId: row.turn_id,
    workItemId: row.target_kind === "work_item" ? row.target_id : null,
    continuationTurnId: row.target_kind === "work_item_continuation_turn" ? row.target_id : null,
    targetCommandId: row.target_command_id ?? null,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    finishedAt: row.finished_at == null ? null : timestamp(row.finished_at),
  };
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresAgentTurnCommandIntakeError";
  error.code = code;
  return error;
}
