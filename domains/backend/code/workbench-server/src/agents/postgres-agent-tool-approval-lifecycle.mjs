import { randomUUID } from "node:crypto";

import { canonicalRequestHash } from "../store/serialization.mjs";

const APPROVAL_TTL_MS = 10 * 60_000;

/**
 * Product authority for an external Tool request made by the Minimal Kernel.
 * It deliberately owns only the approval aggregate and its Inbox projection;
 * it neither executes a Tool nor receives a Worker secret or raw DB port.
 */
export class PostgresAgentToolApprovalLifecycle {
  #store;
  #sql;
  #commandAuthorizer;
  #agentTurnRunner = null;
  #clock;
  #idFactory;

  constructor({
    store,
    commandAuthorizer,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction
      || typeof commandAuthorizer?.authorizeAgentToolApprovalDecision !== "function"
      || typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_agent_tool_approval_dependencies_invalid");
    }
    this.#store = store;
    this.#commandAuthorizer = commandAuthorizer;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  bindAgentTurnRunner(agentTurnRunner) {
    if (!agentTurnRunner || typeof agentTurnRunner.resumeApprovedTool !== "function") {
      throw new TypeError("postgres_agent_tool_approval_runner_invalid");
    }
    if (this.#agentTurnRunner && this.#agentTurnRunner !== agentTurnRunner) {
      throw new TypeError("postgres_agent_tool_approval_runner_already_bound");
    }
    this.#agentTurnRunner = agentTurnRunner;
    return this;
  }

  async request({ binding, message } = {}) {
    const call = normalizeRequest({ binding, message });
    return this.#store.withTransaction(async (uow) => {
      const now = await this.#databaseNow(uow);
      const source = await this.#activeSource(uow, call.binding, now);
      if (call.resumeApprovalId) {
        return this.#consumeApprovedResume({ uow, source, call, now });
      }
      if (source.command_kind !== "agent_turn") throw coded("agent_tool_approval_source_command_invalid");
      const existing = await this.#approvalByRequest(uow, source, call.inputDigest, call.toolId, true);
      if (existing) {
        if (existing.status === "pending" && new Date(existing.expires_at).getTime() > Date.parse(now)) {
          return pendingView(existing);
        }
        if (existing.status === "pending") await this.#expire(uow, existing, now);
        return denied("agent_tool_approval_not_pending");
      }

      const approvalId = stableId(this.#idFactory("agent-tool-approval"), "agent_tool_approval_id_invalid");
      const expiresAt = new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString();
      const intent = {
        kind: "agent_tool_execute",
        approvalId,
        toolId: call.toolId,
        connectionId: call.connectionId,
        inputDigest: call.inputDigest,
        sourceInvocationId: source.invocation_id,
        sourceAttemptId: source.attempt_id,
      };
      const argumentDigest = canonicalRequestHash(intent);
      const requestDecision = await this.#insertApprovalRequiredDecision({
        uow,
        source,
        approvalId,
        argumentDigest,
        expiresAt,
        now,
        approvalContract: approvalTargetContract({ source, call }),
      });
      const inserted = (await this.#query(uow, `
        INSERT INTO public.agent_tool_approvals (
          approval_id, workspace_id, schema_version, scope_id, policy_revision_id,
          owner_user_id, session_id, source_turn_id, source_product_command_id,
          source_invocation_id, source_attempt_id, source_capability_lease_id,
          tool_id, connection_id, input_digest, authorization_request_id,
          status, revision, expires_at, decided_at, created_at, updated_at, payload
        ) VALUES (
          $1, $2, 'workbench-agent-tool-approval-v1', $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15,
          'pending', 1, $16::timestamptz, NULL, $17::timestamptz, $17::timestamptz,
          $18::jsonb
        ) RETURNING *
      `, [
        approvalId,
        source.workspace_id,
        source.scope_id,
        source.policy_revision_id,
        source.owner_user_id,
        source.lineage_session_id,
        source.lineage_turn_id,
        source.product_command_id,
        source.invocation_id,
        source.attempt_id,
        source.capability_lease_id,
        call.toolId,
        call.connectionId,
        call.inputDigest,
        requestDecision.authorization_decision_id,
        expiresAt,
        now,
        JSON.stringify({ targetContract: approvalTargetContract({ source, call }) }),
      ])).rows[0];
      await this.#insertInbox({ uow, approval: inserted, now });
      return pendingView(inserted);
    });
  }

  async decide({ approvalId, decision, userId, workspaceId } = {}) {
    if (typeof approvalId !== "string" || !approvalId
      || typeof userId !== "string" || !userId
      || typeof workspaceId !== "string" || !workspaceId
      || !["approve", "reject"].includes(decision)) {
      throw coded("agent_tool_approval_decision_invalid");
    }
    if (decision === "approve" && !this.#agentTurnRunner) {
      throw coded("agent_tool_approval_resume_unavailable");
    }
    return this.#store.withTransaction(async (uow) => {
      const now = await this.#databaseNow(uow);
      const approval = await this.#approvalForDecision(uow, { approvalId, workspaceId, userId });
      if (!approval) throw coded("agent_tool_approval_not_found");
      if (approval.status !== "pending") {
        if (approval.status === "approved" && decision === "approve") return decisionView(approval);
        if (approval.status === "rejected" && decision === "reject") return decisionView(approval);
        throw coded("agent_tool_approval_not_pending");
      }
      if (new Date(approval.expires_at).getTime() <= Date.parse(now)) {
        await this.#expire(uow, approval, now);
        throw coded("agent_tool_approval_expired");
      }
      const authority = await this.#commandAuthorizer.authorizeAgentToolApprovalDecision({
        workspaceId,
        userId,
        approvalId,
        decision,
        requiredScopeId: approval.scope_id,
        uow,
      });
      if (decision === "reject") {
        const rejected = (await this.#query(uow, `
          UPDATE public.agent_tool_approvals
             SET status = 'rejected', revision = revision + 1,
                 decision_authorization_decision_id = $4,
                 decided_at = $5::timestamptz, updated_at = $5::timestamptz
           WHERE workspace_id = $1 AND approval_id = $2 AND owner_user_id = $3 AND status = 'pending'
           RETURNING *
        `, [workspaceId, approvalId, userId, authority.authorizationDecisionId, now])).rows[0];
        if (!rejected) throw coded("agent_tool_approval_not_pending");
        await this.#dismissInbox(uow, approvalId, now);
        return decisionView(rejected);
      }

      const toolDecisionId = stableId(this.#idFactory("authorization-decision"), "agent_tool_authorization_id_invalid");
      await this.#insertAuthorizedToolDecision({
        uow,
        approval,
        toolDecisionId,
        now,
      });
      const commandId = stableId(this.#idFactory("product-command"), "agent_tool_approval_command_id_invalid");
      const turnId = stableId(this.#idFactory("agent-turn"), "agent_tool_approval_turn_id_invalid");
      const approved = (await this.#query(uow, `
        UPDATE public.agent_tool_approvals
           SET status = 'approved', revision = revision + 1,
               tool_authorization_decision_id = $4,
               decision_authorization_decision_id = $5,
               decision_command_id = $6, resume_turn_id = $7,
               decided_at = $8::timestamptz, updated_at = $8::timestamptz
         WHERE workspace_id = $1 AND approval_id = $2 AND owner_user_id = $3 AND status = 'pending'
         RETURNING *
      `, [
        workspaceId,
        approvalId,
        userId,
        toolDecisionId,
        authority.authorizationDecisionId,
        commandId,
        turnId,
        now,
      ])).rows[0];
      if (!approved) throw coded("agent_tool_approval_not_pending");
      const resumedTurn = await this.#agentTurnRunner.resumeApprovedTool({
        approval: approvalView(approved),
        commandAuthority: authority,
        commandId,
        turnId,
        transactionSession: uow,
      });
      if (!resumedTurn || resumedTurn.turnId !== turnId) {
        throw coded("agent_tool_approval_resume_incomplete");
      }
      await this.#dismissInbox(uow, approvalId, now);
      return decisionView(approved);
    });
  }

  async #activeSource(uow, binding, now) {
    const source = (await this.#query(uow, `
      SELECT invocation.invocation_id, invocation.attempt_id, invocation.workspace_id,
             invocation.product_command_id, invocation.lineage_session_id, invocation.lineage_turn_id,
             invocation.status AS invocation_status, lease.capability_lease_id,
             lease.status AS lease_status, lease.expires_at,
             command.kind AS command_kind, command.scope_id, command.policy_revision_id,
             command.authorization_decision_id, session.user_id AS owner_user_id
        FROM public.execution_invocations invocation
        JOIN public.capability_leases lease
          ON lease.invocation_id = invocation.invocation_id
         AND lease.attempt_id = invocation.attempt_id
         AND lease.capability_lease_id = $3
        JOIN public.product_commands command
          ON command.workspace_id = invocation.workspace_id
         AND command.command_id = invocation.product_command_id
        JOIN public.agent_sessions session
          ON session.session_id = invocation.lineage_session_id
         AND session.workspace_id = invocation.workspace_id
       WHERE invocation.invocation_id = $1
         AND invocation.attempt_id = $2
       FOR SHARE OF invocation, lease, command, session
    `, [binding.invocationId, binding.attemptId, binding.capabilityLeaseId])).rows[0];
    if (!source
      || source.invocation_status !== "running"
      || source.lease_status !== "active"
      || new Date(source.expires_at).getTime() <= Date.parse(now)
      || !source.lineage_session_id || !source.lineage_turn_id
      || !["agent_turn", "agent_tool_approval_decide"].includes(source.command_kind)) {
      throw denied("agent_tool_approval_source_inactive");
    }
    return source;
  }

  async #consumeApprovedResume({ uow, source, call, now }) {
    const approval = (await this.#query(uow, `
      SELECT approval.*, decision.disposition AS tool_decision_disposition,
             decision.approval_id AS tool_decision_approval_id
        FROM public.agent_tool_approvals approval
        JOIN public.authorization_decisions decision
          ON decision.workspace_id = approval.workspace_id
         AND decision.authorization_decision_id = approval.tool_authorization_decision_id
       WHERE approval.workspace_id = $1 AND approval.approval_id = $2
       FOR SHARE OF approval, decision
    `, [source.workspace_id, call.resumeApprovalId])).rows[0];
    if (!approval
      || approval.status !== "approved"
      || new Date(approval.expires_at).getTime() <= Date.parse(now)
      || approval.owner_user_id !== source.owner_user_id
      || approval.session_id !== source.lineage_session_id
      || approval.resume_turn_id !== source.lineage_turn_id
      || approval.decision_command_id !== source.product_command_id
      || approval.tool_id !== call.toolId
      || approval.connection_id !== call.connectionId
      || approval.input_digest !== call.inputDigest
      || approval.tool_decision_disposition !== "authorized"
      || approval.tool_decision_approval_id !== approval.approval_id) {
      throw denied("agent_tool_approval_resume_mismatch");
    }
    return Object.freeze({ status: "approved", approvalId: approval.approval_id });
  }

  async #approvalByRequest(uow, source, inputDigest, toolId, lock) {
    return (await this.#query(uow, `
      SELECT * FROM public.agent_tool_approvals
       WHERE workspace_id = $1 AND source_invocation_id = $2 AND source_attempt_id = $3
         AND tool_id = $4 AND input_digest = $5
       ${lock ? "FOR UPDATE" : ""}
    `, [source.workspace_id, source.invocation_id, source.attempt_id, toolId, inputDigest])).rows[0] ?? null;
  }

  async #approvalForDecision(uow, { approvalId, workspaceId, userId }) {
    return (await this.#query(uow, `
      SELECT * FROM public.agent_tool_approvals
       WHERE workspace_id = $1 AND approval_id = $2 AND owner_user_id = $3
       FOR UPDATE
    `, [workspaceId, approvalId, userId])).rows[0] ?? null;
  }

  async #insertApprovalRequiredDecision({ uow, source, approvalId, argumentDigest, expiresAt, now, approvalContract }) {
    const sourceDecision = await this.#sourceDecision(uow, source);
    const row = (await this.#query(uow, `
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind,
        authorizer_scope_grant_id, action_id, effect_class, argument_digest,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, approval_id, reason_code,
        decided_at, expires_at, target_contract, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        'agent_tool_execute', 'external_write', $15,
        $16, $17::text[], $18::text[],
        $19, 'approval_required', $2, 'agent_tool_approval_requested',
        $20::timestamptz, $21::timestamptz, NULL, $22::jsonb
      ) RETURNING *
    `, [
      source.workspace_id,
      approvalId,
      source.scope_id,
      source.policy_revision_id,
      sourceDecision.actor_principal_id,
      sourceDecision.actor_principal_kind,
      sourceDecision.actor_scope_grant_id,
      sourceDecision.effective_principal_id,
      sourceDecision.effective_principal_kind,
      sourceDecision.effective_scope_grant_id,
      sourceDecision.authorization_source,
      sourceDecision.authorizer_principal_id,
      sourceDecision.authorizer_principal_kind,
      sourceDecision.authorizer_scope_grant_id,
      argumentDigest,
      sourceDecision.permission_mode,
      sourceDecision.auto_approved_effect_classes,
      sourceDecision.auto_approved_action_ids,
      sourceDecision.destructive_rule_version,
      now,
      expiresAt,
      JSON.stringify({
        issuer: "agent_tool_approval_lifecycle",
        approvalContract,
      }),
    ])).rows[0];
    return row;
  }

  async #insertAuthorizedToolDecision({ uow, approval, toolDecisionId, now }) {
    const request = (await this.#query(uow, `
      SELECT * FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
       FOR SHARE
    `, [approval.workspace_id, approval.authorization_request_id])).rows[0];
    if (!request || request.disposition !== "approval_required"
      || request.approval_id !== approval.approval_id
      || new Date(request.expires_at).getTime() <= Date.parse(now)) {
      throw coded("agent_tool_approval_request_invalid");
    }
    await this.#query(uow, `
      INSERT INTO public.authorization_decisions (
        workspace_id, authorization_decision_id, scope_id, policy_revision_id,
        actor_principal_id, actor_principal_kind, actor_scope_grant_id,
        effective_principal_id, effective_principal_kind, effective_scope_grant_id,
        authorization_source, authorizer_principal_id, authorizer_principal_kind,
        authorizer_scope_grant_id, action_id, effect_class, argument_digest,
        permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
        destructive_rule_version, disposition, approval_id, reason_code,
        decided_at, expires_at, target_contract, payload
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16, $17,
        $18, $19::text[], $20::text[],
        $21, 'authorized', $22, 'explicit_user_tool_approval',
        $23::timestamptz, $24::timestamptz, NULL, $25::jsonb
      )
    `, [
      approval.workspace_id,
      toolDecisionId,
      request.scope_id,
      request.policy_revision_id,
      request.actor_principal_id,
      request.actor_principal_kind,
      request.actor_scope_grant_id,
      request.effective_principal_id,
      request.effective_principal_kind,
      request.effective_scope_grant_id,
      request.authorization_source,
      request.authorizer_principal_id,
      request.authorizer_principal_kind,
      request.authorizer_scope_grant_id,
      request.action_id,
      request.effect_class,
      request.argument_digest,
      request.permission_mode,
      request.auto_approved_effect_classes,
      request.auto_approved_action_ids,
      request.destructive_rule_version,
      approval.approval_id,
      now,
      request.expires_at,
      JSON.stringify({
        issuer: "agent_tool_approval_lifecycle",
        approvalId: approval.approval_id,
      }),
    ]);
  }

  async #sourceDecision(uow, source) {
    const decision = (await this.#query(uow, `
      SELECT * FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND policy_revision_id = $4
       FOR SHARE
    `, [
      source.workspace_id,
      source.authorization_decision_id,
      source.scope_id,
      source.policy_revision_id,
    ])).rows[0];
    if (!decision || decision.disposition !== "authorized") {
      throw denied("agent_tool_approval_source_authority_invalid");
    }
    return decision;
  }

  async #insertInbox({ uow, approval, now }) {
    await this.#query(uow, `
      INSERT INTO public.inbox_items (
        workspace_id, inbox_item_id, recipient_user_id,
        source_domain, source_id, source_revision, source_cursor,
        reason_code, severity, title, summary, target_kind, target_id,
        status, schema_version, created_at, updated_at
      ) VALUES (
        $1, $2, $3,
        'authorization_decision', $4, 1, $5::text,
        'review_required', 'warning',
        'Agent Tool approval required.',
        'A governed external Tool action is waiting for your explicit approval.',
        'authorization_decision', $4,
        'unread', 'workbench-inbox-item-v1', $6::timestamptz, $6::timestamptz
      ) ON CONFLICT (workspace_id, recipient_user_id, source_domain, source_id, source_revision)
        DO NOTHING
    `, [
      approval.workspace_id,
      stableId(this.#idFactory("inbox-item"), "agent_tool_approval_inbox_id_invalid"),
      approval.owner_user_id,
      approval.authorization_request_id,
      approval.authorization_request_id,
      now,
    ]);
  }

  async #dismissInbox(uow, approvalId, now) {
    await this.#query(uow, `
      UPDATE public.inbox_items
         SET status = 'dismissed', dismissed_at = $2::timestamptz, updated_at = $2::timestamptz
       WHERE source_domain = 'authorization_decision'
         AND source_id = $1
         AND status IN ('unread', 'read')
    `, [approvalId, now]);
  }

  async #expire(uow, approval, now) {
    const expired = (await this.#query(uow, `
      UPDATE public.agent_tool_approvals
         SET status = 'expired', revision = revision + 1,
             decided_at = $3::timestamptz, updated_at = $3::timestamptz
       WHERE workspace_id = $1 AND approval_id = $2 AND status = 'pending'
       RETURNING *
    `, [approval.workspace_id, approval.approval_id, now])).rows[0];
    if (expired) await this.#dismissInbox(uow, approval.approval_id, now);
    return expired;
  }

  async #databaseNow(uow) {
    const value = (await this.#query(uow, "SELECT clock_timestamp() AS now")).rows[0]?.now ?? this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("agent_tool_approval_clock_invalid");
    return date.toISOString();
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function normalizeRequest({ binding, message }) {
  if (!binding || ![binding.invocationId, binding.attemptId, binding.capabilityLeaseId]
    .every((value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value))
    || !message || typeof message !== "object" || Array.isArray(message)
    || message.operation !== "approval"
    || message.invocationId !== binding.invocationId
    || message.attemptId !== binding.attemptId
    || message.capabilityLeaseId !== binding.capabilityLeaseId
    || typeof message.toolId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(message.toolId)
    || message.effectClass !== "external_write"
    || typeof message.connectionId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(message.connectionId)
    || !isJsonValue(message.input)
    || byteLength(message.input) > 1_000_000
    || (message.resumeApprovalId !== undefined
      && (typeof message.resumeApprovalId !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(message.resumeApprovalId)))) {
    throw denied("agent_tool_approval_request_invalid");
  }
  return Object.freeze({
    binding: Object.freeze({
      invocationId: binding.invocationId,
      attemptId: binding.attemptId,
      capabilityLeaseId: binding.capabilityLeaseId,
    }),
    toolId: message.toolId,
    connectionId: message.connectionId,
    inputDigest: canonicalRequestHash({
      toolId: message.toolId,
      connectionId: message.connectionId,
      input: structuredClone(message.input),
    }),
    ...(message.resumeApprovalId ? { resumeApprovalId: message.resumeApprovalId } : {}),
  });
}

function approvalTargetContract({ source, call }) {
  return Object.freeze({
    kind: "agent_tool_approval",
    toolId: call.toolId,
    connectionId: call.connectionId,
    inputDigest: call.inputDigest,
    sourceInvocationId: source.invocation_id,
    sourceAttemptId: source.attempt_id,
  });
}

function pendingView(row) {
  return Object.freeze({ status: "pending", approvalId: row.approval_id });
}

function approvalView(row) {
  return Object.freeze({
    approvalId: row.approval_id,
    workspaceId: row.workspace_id,
    userId: row.owner_user_id,
    sessionId: row.session_id,
    sourceTurnId: row.source_turn_id,
    toolId: row.tool_id,
    inputDigest: row.input_digest,
  });
}

function decisionView(row) {
  return Object.freeze({
    approvalId: row.approval_id,
    status: row.status,
    sessionId: row.session_id,
    ...(row.resume_turn_id ? { resumeTurnId: row.resume_turn_id } : {}),
    ...(row.decision_command_id ? { commandId: row.decision_command_id } : {}),
  });
}

function stableId(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError(code);
  }
  return value;
}

function denied(code) {
  const error = new Error(code);
  error.code = code;
  error.status = "permission_denied";
  error.productSafe = true;
  return error;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function byteLength(value) { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isJsonValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
