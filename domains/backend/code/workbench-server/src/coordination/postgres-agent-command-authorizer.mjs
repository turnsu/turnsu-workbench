import { randomUUID } from "node:crypto";

import { canonicalRequestHash } from "../store/serialization.mjs";

const EXPLICIT_COMMANDS = new Set([
  "member_agent_request_create", "member_agent_request_accept", "member_agent_request_decline", "member_agent_request_cancel",
  "agent_turn",
  "cancel_agent_turn",
  "agent_tool_approval_decide",
  "builder_proposal",
  "skill_test",
  "skill_validation",
  "cancel_skill_test",
  "workflow_run",
  "workflow_run_cancel",
  "workflow_run_review",
  "work_item_promote",
  "work_item_thread_entry",
  "work_item_decision_record",
  "agent_handoff_confirm",
  "agent_proposal_apply",
  "agent_proposal_reject",
  "device_register",
  "device_revoke",
  "model_profile_create",
]);

/**
 * Product-owned authority issuer for an explicit user Agent action.
 *
 * The browser never supplies an authority record.  This port resolves the
 * caller's active personal operation scope, records the user's explicit
 * approval request and its final decision, and returns only the immutable
 * command authority required by Command Intake. It is intentionally an
 * interactive-user path: unattended auto/custom authority is represented by
 * a policy-grant principal, not by silently reusing a human browser command.
 *
 * The only narrow exceptions are a human resolving an already-paused
 * ReviewGate from an accepted Automation occurrence, and an explicitly
 * approved native Device registration/revocation while a personal scope is
 * configured for auto/custom Automation. Neither exception grants unattended
 * browser authority: each still records a principal approval decision.
 */
export class PostgresAgentCommandAuthorizer {
  #store;
  #sql;
  #clock;
  #idFactory;

  constructor({
    store,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_agent_command_authorizer_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_agent_command_authorizer_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  authorizeAgentTurn({
    workspaceId,
    userId,
    sessionId,
    turnId,
    workItemId = null,
    workItemTarget = null,
    continuationTurnTarget = null,
    input,
    uow,
  } = {}) {
    if (workItemId !== null && (typeof workItemId !== "string" || !workItemId)) {
      throw coded("postgres_agent_command_work_item_required");
    }
    if (workItemTarget !== null && (workItemId === null
      || !workItemTarget || typeof workItemTarget !== "object" || Array.isArray(workItemTarget))) {
      throw coded("postgres_agent_command_work_item_target_invalid");
    }
    if (continuationTurnTarget !== null && (workItemId === null
      || !continuationTurnTarget || typeof continuationTurnTarget !== "object"
      || Array.isArray(continuationTurnTarget))) {
      throw coded("postgres_agent_command_work_item_continuation_target_invalid");
    }
    return this.#authorize({
      workspaceId,
      userId,
      sessionId,
      turnId,
      actionId: "agent_turn",
      intent: {
        kind: "agent_turn",
        sessionId,
        turnId,
        ...(workItemId === null ? {} : { workItemId }),
        ...(workItemTarget === null ? {} : { workItemTarget: structuredClone(workItemTarget) }),
        ...(continuationTurnTarget === null ? {} : {
          continuationTurnTarget: structuredClone(continuationTurnTarget),
        }),
        input,
      },
      uow,
    });
  }

  authorizeCancellation({ workspaceId, userId, sessionId, turnId, targetCommandId, reason, uow } = {}) {
    return this.#authorize({
      workspaceId,
      userId,
      sessionId,
      turnId,
      actionId: "cancel_agent_turn",
      intent: { kind: "cancel_agent_turn", sessionId, turnId, targetCommandId, reason: reason ?? null },
      uow,
    });
  }

  /**
   * This authorizes the human decision command, not the external Tool.  The
   * latter remains a separate immutable authorization decision referencing
   * the Worker-created approval request inside the Product approval aggregate.
   */
  authorizeAgentToolApprovalDecision({
    workspaceId,
    userId,
    approvalId,
    decision,
    requiredScopeId = null,
    uow,
  } = {}) {
    if (typeof approvalId !== "string" || !approvalId
      || !["approve", "reject"].includes(decision)) {
      throw coded("postgres_agent_tool_approval_decision_invalid");
    }
    const intent = {
      kind: "agent_tool_approval_decide",
      approvalId,
      decision,
      decidedBy: userId,
    };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "agent_tool_approval_decide",
      effectClass: "execute",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      requiredScopeId,
      uow,
    });
  }

  // Builder proposals are an explicit, bounded user action. They use the
  // same personal operation scope and immutable decision shape as Agent
  // turns, but deliberately have no conversational session/turn lineage.
  authorizeBuilderProposal({ workspaceId, userId, proposalId, input, uow } = {}) {
    if (typeof proposalId !== "string" || !proposalId) throw coded("postgres_builder_command_proposal_required");
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "builder_proposal",
      intent: { kind: "builder_proposal", proposalId, input },
      uow,
    });
  }

  authorizeSkillTest({ workspaceId, userId, draftId, testRunId, input, uow } = {}) {
    return this.#authorizeSkillLifecycle({ workspaceId, userId, draftId, commandId: testRunId, actionId: "skill_test", input, uow });
  }

  authorizeSkillValidation({ workspaceId, userId, draftId, validationId, input, uow } = {}) {
    return this.#authorizeSkillLifecycle({ workspaceId, userId, draftId, commandId: validationId, actionId: "skill_validation", input, uow });
  }

  authorizeSkillTestCancellation({ workspaceId, userId, draftId, testRunId, reason = null, uow } = {}) {
    return this.#authorizeSkillLifecycle({
      workspaceId, userId, draftId, commandId: testRunId, actionId: "cancel_skill_test",
      input: { kind: "cancel_skill_test", draftId, testRunId, reason }, uow,
    });
  }

  authorizeWorkflowRun({
    workspaceId,
    userId,
    workflowId,
    workflowRevisionId,
    inputs,
    resourceRefs,
    materialBindings,
    companionKind = null,
    uow,
  } = {}) {
    for (const [value, code] of [
      [workflowId, "postgres_workflow_command_workflow_required"],
      [workflowRevisionId, "postgres_workflow_command_revision_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    // This object deliberately matches WorkflowRunner.#createRun exactly.
    // The persisted Command Intake compares the digest, so adding a wrapper
    // or browser-only metadata here would make authorization fail closed.
    const request = {
      workflowId,
      workflowRevisionId,
      inputs,
      resourceRefs,
      materialBindings,
      requestedBy: userId,
      retryOf: null,
      ...(companionKind === null ? {} : { companionKind }),
    };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "workflow_run",
      intent: request,
      argumentDigest: canonicalRequestHash(request),
      uow,
    });
  }

  /**
   * A retry is a new `workflow_run` command, not a mutable continuation of
   * the old Run.  Read the immutable source on the server so its decision
   * digest covers the exact pinned inputs and material bindings that the
   * WorkflowRunner will carry forward.  A caller may only recover a Run in
   * their own active personal scope; an Automation owner therefore makes an
   * explicit, interactive recovery decision rather than silently reusing the
   * unattended scheduler grant.
   */
  authorizeWorkflowRunRetry({
    workspaceId,
    userId,
    runId,
    reason = null,
    uow,
  } = {}) {
    if (typeof runId !== "string" || !runId) {
      throw coded("postgres_workflow_retry_run_required");
    }
    if (reason != null && (typeof reason !== "string" || reason.length === 0 || reason.length > 2_000)) {
      throw coded("postgres_workflow_retry_reason_invalid");
    }
    return this.#store.withTransaction(async (transaction) => {
      const source = (await this.#query(transaction, `
        SELECT workflow_id, workflow_revision_id, scope_id, inputs,
               resource_refs, payload, status
          FROM public.workflow_runs
         WHERE workspace_id = $1 AND run_id = $2
         FOR SHARE
      `, [workspaceId, runId])).rows[0];
      if (!source) throw coded("workflow_run_retry_source_not_found");
      if (!['failed', 'cancelled'].includes(source.status)) {
        throw coded("workflow_run_retry_source_invalid");
      }
      const materialBindings = source.payload?.skillMaterialBindings ?? [];
      if (!Array.isArray(materialBindings)) {
        throw coded("workflow_run_retry_source_invalid");
      }
      const intent = {
        workflowId: source.workflow_id,
        workflowRevisionId: source.workflow_revision_id,
        inputs: structuredClone(source.inputs),
        resourceRefs: structuredClone(source.resource_refs),
        materialBindings: structuredClone(materialBindings),
        requestedBy: userId,
        retryOf: runId,
        retryCommand: { requestedBy: userId, reason },
      };
      return this.#authorize({
        workspaceId,
        userId,
        sessionId: null,
        turnId: null,
        actionId: "workflow_run",
        intent,
        argumentDigest: canonicalRequestHash(intent),
        requiredScopeId: source.scope_id,
        uow: transaction,
      });
    }, uow === undefined || uow === null ? {} : { uow });
  }

  authorizeWorkflowRunReview({
    workspaceId,
    userId,
    runId,
    nodeId,
    expectedNodeRunId,
    decision,
    comment,
    requestedChanges = [],
    uow,
  } = {}) {
    for (const [value, code] of [
      [runId, "postgres_workflow_review_run_required"],
      [nodeId, "postgres_workflow_review_node_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (!["approve", "revise", "reject"].includes(decision)
      || !Array.isArray(requestedChanges)) {
      throw coded("postgres_workflow_review_decision_invalid");
    }
    const intent = {
      runId,
      nodeId,
      ...(expectedNodeRunId === undefined ? {} : { expectedNodeRunId }),
      decision,
      comment,
      requestedChanges,
      decidedBy: userId,
    };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "workflow_run_review",
      effectClass: "write_local",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      explicitReviewRun: { runId, nodeId },
      uow,
    });
  }

  authorizeWorkflowRunCancellation({
    workspaceId,
    userId,
    runId,
    nodeId,
    expectedNodeRunId,
    decision,
    comment,
    requestedChanges = [],
    uow,
  } = {}) {
    for (const [value, code] of [
      [runId, "postgres_workflow_cancellation_run_required"],
      [nodeId, "postgres_workflow_cancellation_node_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (decision !== "reject" || !Array.isArray(requestedChanges)) {
      throw coded("postgres_workflow_cancellation_decision_invalid");
    }
    const intent = {
      runId,
      nodeId,
      ...(expectedNodeRunId === undefined ? {} : { expectedNodeRunId }),
      decision,
      comment,
      requestedChanges,
      decidedBy: userId,
    };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "workflow_run_cancel",
      effectClass: "execute",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      explicitReviewRun: { runId, nodeId },
      uow,
    });
  }

  authorizeWorkflowRunCancellationRequest({
    workspaceId,
    userId,
    runId,
    reason = null,
    uow,
  } = {}) {
    if (typeof runId !== "string" || !runId) {
      throw coded("postgres_workflow_cancellation_run_required");
    }
    if (reason != null && (typeof reason !== "string" || reason.length === 0 || reason.length > 2000)) {
      throw coded("postgres_workflow_cancellation_reason_invalid");
    }
    // This object deliberately matches WorkflowRunner.cancelRun exactly.
    // The cancellation intake compares this digest against the immutable
    // decision, so the browser cannot add an ungoverned cancellation reason.
    const intent = { runId, requestedBy: userId, reason: reason ?? null };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "workflow_run_cancel",
      effectClass: "execute",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      uow,
    });
  }

  authorizeWorkItemPromotion({
    workspaceId,
    userId,
    sourceSessionId,
    promotionId,
    workItemId,
    input,
    uow,
  } = {}) {
    for (const [value, code] of [
      [sourceSessionId, "postgres_work_item_promotion_source_session_required"],
      [promotionId, "postgres_work_item_promotion_id_required"],
      [workItemId, "postgres_work_item_promotion_work_item_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "work_item_promote",
      intent: {
        kind: "work_item_promote",
        sourceSessionId,
        promotionId,
        workItemId,
        input,
      },
      uow,
    });
  }

  authorizeWorkItemThreadEntry({
    workspaceId,
    userId,
    workItemId,
    entryId,
    input,
    uow,
  } = {}) {
    for (const [value, code] of [
      [workItemId, "postgres_work_item_thread_entry_work_item_required"],
      [entryId, "postgres_work_item_thread_entry_id_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "work_item_thread_entry",
      effectClass: "write_local",
      intent: {
        kind: "work_item_thread_entry",
        workItemId,
        entryId,
        input,
      },
      uow,
    });
  }

  authorizeWorkItemDecisionRecord({
    workspaceId,
    userId,
    workItemId,
    decisionId,
    entryId,
    input,
    uow,
  } = {}) {
    for (const [value, code] of [
      [workItemId, "postgres_work_item_decision_work_item_required"],
      [decisionId, "postgres_work_item_decision_id_required"],
      [entryId, "postgres_work_item_decision_entry_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "work_item_decision_record",
      effectClass: "write_local",
      intent: {
        kind: "work_item_decision_record",
        workItemId,
        decisionId,
        entryId,
        input,
      },
      uow,
    });
  }

  authorizeAgentHandoffConfirm({ workspaceId, userId, sessionId, handoffId, targetRevision = 1, uow } = {}) {
    for (const [value, code] of [
      [sessionId, "postgres_agent_handoff_command_session_required"],
      [handoffId, "postgres_agent_handoff_command_handoff_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw coded("postgres_agent_handoff_command_revision_invalid");
    }
    const intent = { kind: "agent_handoff_confirm", sessionId, handoffId, targetRevision };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "agent_handoff_confirm",
      effectClass: "write_local",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      uow,
    });
  }

  authorizeAgentProposalApply({ workspaceId, userId, sessionId, proposalId, targetRevision = 1, uow } = {}) {
    return this.#authorizeAgentProposalDecision({
      workspaceId, userId, sessionId, proposalId, targetRevision,
      actionId: "agent_proposal_apply", uow,
    });
  }

  authorizeAgentProposalReject({ workspaceId, userId, sessionId, proposalId, targetRevision = 1, uow } = {}) {
    return this.#authorizeAgentProposalDecision({
      workspaceId, userId, sessionId, proposalId, targetRevision,
      actionId: "agent_proposal_reject", uow,
    });
  }

  /**
   * Registering a Desktop Device is an explicit administrative action by the
   * native-session owner. The Device lifecycle independently verifies that
   * the client session is active, desktop-kind, and bound to the fingerprint
   * included in this immutable decision.
   */
  authorizeDeviceRegistration({
    workspaceId,
    userId,
    deviceId,
    clientSessionId,
    displayName,
    platform,
    architecture,
    appVersion,
    workerProtocolVersion,
    capabilityInventory,
    publicIdentity,
    uow,
  } = {}) {
    for (const [value, code] of [
      [deviceId, "postgres_device_command_device_required"],
      [clientSessionId, "postgres_device_command_session_required"],
      [publicIdentity, "postgres_device_command_identity_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (!Array.isArray(capabilityInventory)) throw coded("postgres_device_command_capabilities_invalid");
    const intent = {
      kind: "device_register",
      deviceId,
      clientSessionId,
      displayName,
      platform,
      architecture,
      appVersion,
      workerProtocolVersion,
      capabilityInventory: [...capabilityInventory].sort(),
      publicIdentity,
    };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "device_register",
      effectClass: "administrative",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      uow,
    });
  }

  /** An Owner/Admin's device revocation remains a separate, explicit command. */
  authorizeDeviceRevocation({ workspaceId, userId, deviceId, reason = null, uow } = {}) {
    if (typeof deviceId !== "string" || !deviceId) {
      throw coded("postgres_device_command_device_required");
    }
    const intent = { kind: "device_revoke", deviceId, reason };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId: "device_revoke",
      effectClass: "administrative",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      uow,
    });
  }

  authorizeModelProfileCreation({ workspaceId, userId, scopeId, configHash, uow } = {}) {
    if (typeof scopeId !== "string" || !scopeId || !/^sha256:[a-f0-9]{64}$/.test(configHash ?? "")) {
      throw coded("model_configuration_authority_invalid");
    }
    return this.#authorize({ workspaceId, userId, sessionId: null, turnId: null,
      actionId: "model_profile_create", effectClass: "administrative", requiredScopeId: scopeId,
      intent: { kind: "model_profile_create", configHash }, argumentDigest: configHash, uow });
  }

  #authorizeSkillLifecycle({ workspaceId, userId, draftId, commandId, actionId, input, uow }) {
    for (const [value, code] of [[draftId, "postgres_skill_command_draft_required"], [commandId, "postgres_skill_command_id_required"]]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    return this.#authorize({
      workspaceId, userId, sessionId: draftId, turnId: commandId, actionId,
      intent: { kind: actionId, draftId, commandId, input }, uow,
    });
  }

  #authorizeAgentProposalDecision({ workspaceId, userId, sessionId, proposalId, targetRevision, actionId, uow }) {
    for (const [value, code] of [
      [sessionId, "postgres_agent_proposal_command_session_required"],
      [proposalId, "postgres_agent_proposal_command_proposal_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw coded("postgres_agent_proposal_command_revision_invalid");
    }
    const intent = { kind: actionId, sessionId, proposalId, targetRevision };
    return this.#authorize({
      workspaceId,
      userId,
      sessionId: null,
      turnId: null,
      actionId,
      effectClass: "write_local",
      intent,
      argumentDigest: canonicalRequestHash(intent),
      uow,
    });
  }

  authorizeMemberAgentRequest({ workspaceId, userId, actionId, intent, uow }) {
    if (!["member_agent_request_create", "member_agent_request_accept", "member_agent_request_decline", "member_agent_request_cancel"].includes(actionId)) throw coded("postgres_agent_command_action_invalid");
    return this.#authorize({workspaceId,userId,sessionId:null,turnId:null,actionId,intent,effectClass:actionId === "member_agent_request_accept" ? "execute" : "write_local",uow});
  }

  async #authorize({
    workspaceId,
    userId,
    sessionId,
    turnId,
    actionId,
    effectClass = "execute",
    intent,
    argumentDigest = canonicalRequestHash(intent),
    requiredScopeId = null,
    explicitReviewRun = null,
    uow,
  }) {
    for (const [value, code] of [
      [workspaceId, "postgres_agent_command_workspace_required"],
      [userId, "postgres_agent_command_user_required"],
    ]) {
      if (typeof value !== "string" || !value) throw coded(code);
    }
    if (["agent_turn", "cancel_agent_turn", "skill_test", "skill_validation", "cancel_skill_test"].includes(actionId)) {
      for (const [value, code] of [[sessionId, "postgres_agent_command_session_required"], [turnId, "postgres_agent_command_turn_required"]]) {
        if (typeof value !== "string" || !value) throw coded(code);
      }
    }
    const requiresAdministrativeEffect = ["device_register", "device_revoke", "model_profile_create"].includes(actionId);
    if (!EXPLICIT_COMMANDS.has(actionId)
      || (requiresAdministrativeEffect
        ? effectClass !== "administrative"
        : !["execute", "write_local"].includes(effectClass))) {
      throw coded("postgres_agent_command_action_invalid");
    }
    return this.#store.withTransaction(async (uow) => {
      const authority = (await this.#query(uow, `
        SELECT scope.scope_id, scope.current_policy_revision_id,
               policy.permission_mode, policy.auto_approved_effect_classes,
               policy.auto_approved_action_ids, scope_grant.grant_id
          FROM public.product_scopes scope
          JOIN public.scope_policy_revisions policy
            ON policy.workspace_id = scope.workspace_id
           AND policy.scope_id = scope.scope_id
           AND policy.policy_revision_id = scope.current_policy_revision_id
          JOIN public.scope_principal_grants scope_grant
            ON scope_grant.workspace_id = scope.workspace_id
           AND scope_grant.scope_id = scope.scope_id
           AND scope_grant.principal_id = $2
           AND scope_grant.principal_kind = 'user'
           AND scope_grant.access_kind = 'operation'
           AND scope_grant.status = 'active'
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = scope.workspace_id
           AND membership.user_id = $2
           AND membership.status = 'active'
         WHERE scope.workspace_id = $1
           AND scope.scope_kind = 'personal'
           AND scope.owner_user_id = $2
           AND scope.status = 'active'
           ${actionId === "model_profile_create" ? "AND membership.role IN ('owner', 'admin') AND scope_grant.can_approve = true" : ""}
           ${requiredScopeId === null ? "" : "AND scope.scope_id = $3"}
         FOR SHARE OF scope, policy, scope_grant, membership
      `, requiredScopeId === null
        ? [workspaceId, userId]
        : [workspaceId, userId, requiredScopeId])).rows[0];
      if (!authority) throw coded("agent_command_authority_unavailable");
      const explicitDeviceAdministration = ["device_register", "device_revoke", "model_profile_create"].includes(actionId)
        && ["auto", "custom"].includes(authority.permission_mode);
      const explicitAutomationReview = !explicitDeviceAdministration
        && authority.permission_mode !== "interactive"
        && await this.#isPendingAutomationReview(uow, {
          workspaceId,
          userId,
          scopeId: authority.scope_id,
          actionId,
          review: explicitReviewRun,
        });
      if (authority.permission_mode !== "interactive"
        && !explicitAutomationReview
        && !explicitDeviceAdministration) {
        throw coded("agent_command_explicit_approval_required");
      }
      const decidedAt = await this.#databaseNow(uow);
      const expiresAt = new Date(Date.parse(decidedAt) + 5 * 60_000).toISOString();
      const approvalId = this.#idFactory("authorization-approval");
      const authorizationDecisionId = this.#idFactory("authorization-decision");
      const shared = [
        workspaceId, authority.scope_id, authority.current_policy_revision_id,
        userId, authority.grant_id, actionId, effectClass, argumentDigest,
        authority.permission_mode, authority.auto_approved_effect_classes,
        authority.auto_approved_action_ids, decidedAt, expiresAt,
      ];
      await this.#query(uow, `
        INSERT INTO public.authorization_decisions (
          workspace_id, authorization_decision_id, scope_id, policy_revision_id,
          actor_principal_id, actor_principal_kind, actor_scope_grant_id,
          effective_principal_id, effective_principal_kind, effective_scope_grant_id,
          authorization_source, authorizer_principal_id, authorizer_principal_kind,
          authorizer_scope_grant_id, action_id, effect_class, argument_digest,
          permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
          destructive_rule_version, disposition, approval_id, reason_code,
          decided_at, expires_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, 'user', $6, $5, 'user', $6,
          'principal', $5, 'user', $6, $7, $8, $9,
          $10, $11::text[], $12::text[],
          'authority-v1', 'approval_required', $2, 'explicit_user_request',
          $13::timestamptz, $14::timestamptz, '{"issuer":"agent_command_authorizer"}'::jsonb
        )
      `, [workspaceId, approvalId, ...shared.slice(1)]);
      await this.#query(uow, `
        INSERT INTO public.authorization_decisions (
          workspace_id, authorization_decision_id, scope_id, policy_revision_id,
          actor_principal_id, actor_principal_kind, actor_scope_grant_id,
          effective_principal_id, effective_principal_kind, effective_scope_grant_id,
          authorization_source, authorizer_principal_id, authorizer_principal_kind,
          authorizer_scope_grant_id, action_id, effect_class, argument_digest,
          permission_mode, auto_approved_effect_classes, auto_approved_action_ids,
          destructive_rule_version, disposition, approval_id, reason_code,
          decided_at, expires_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, 'user', $6, $5, 'user', $6,
          'principal', $5, 'user', $6, $7, $8, $9,
          $10, $11::text[], $12::text[],
          'authority-v1', 'authorized', $13, 'explicit_user_request',
          $14::timestamptz, $15::timestamptz, '{"issuer":"agent_command_authorizer"}'::jsonb
        )
      `, [workspaceId, authorizationDecisionId, ...shared.slice(1, -2), approvalId, decidedAt, expiresAt]);
      return Object.freeze({
        workspaceId,
        scopeId: authority.scope_id,
        policyRevisionId: authority.current_policy_revision_id,
        authorizationDecisionId,
        argumentDigest,
        authorizedAt: decidedAt,
      });
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #databaseNow(uow) {
    const row = (await this.#query(uow, "SELECT clock_timestamp() AS now")).rows[0];
    const value = row?.now ?? this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_agent_command_authorizer_clock_invalid");
    return date.toISOString();
  }

  /**
   * An auto/custom policy only permits this explicit user decision when the
   * exact Run is still paused at a pending ReviewGate and is durably linked to
   * one accepted Automation occurrence in the same personal scope. The
   * review command intake repeats the pending-review check while consuming the
   * resulting authority, so a stale authority fails closed.
   */
  async #isPendingAutomationReview(uow, {
    workspaceId,
    userId,
    scopeId,
    actionId,
    review,
  }) {
    if (![
      "workflow_run_review",
      "workflow_run_cancel",
    ].includes(actionId)
      || typeof review?.runId !== "string" || !review.runId
      || typeof review?.nodeId !== "string" || !review.nodeId) {
      return false;
    }
    const row = (await this.#query(uow, `
      SELECT 1
        FROM public.workflow_runs run
        JOIN public.workflow_run_reviews review
          ON review.workspace_id = run.workspace_id
         AND review.run_id = run.run_id
         AND review.scope_id = run.scope_id
         AND review.node_id = $5
         AND review.status = 'pending'
        JOIN public.automation_occurrences occurrence
          ON occurrence.workspace_id = run.workspace_id
         AND occurrence.run_id = run.run_id
         AND occurrence.status = 'accepted'
        JOIN public.automations automation
          ON automation.workspace_id = occurrence.workspace_id
         AND automation.automation_id = occurrence.automation_id
         AND automation.scope_id = run.scope_id
         AND automation.owner_user_id = $4
        JOIN public.automation_revisions revision
          ON revision.workspace_id = occurrence.workspace_id
         AND revision.automation_id = occurrence.automation_id
         AND revision.automation_revision_id = occurrence.automation_revision_id
         AND revision.trigger_revision = occurrence.trigger_revision
         AND revision.scope_id = run.scope_id
         AND revision.owner_user_id = $4
       WHERE run.workspace_id = $1
         AND run.run_id = $2
         AND run.scope_id = $3
         AND run.status = 'waiting_review'
         AND run.current_node_id = $5
       FOR SHARE OF run, review, occurrence, automation, revision
    `, [workspaceId, review.runId, scopeId, userId, review.nodeId])).rows[0];
    return Boolean(row);
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresAgentCommandAuthorizationError";
  error.code = code;
  return error;
}
