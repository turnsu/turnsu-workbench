/**
 * PostgreSQL Command Intake for a Workflow Run review decision.  Approve and
 * revise are local review commands; reject is the separate, explicit
 * `workflow_run_cancel` command that closes the held execution lineage.
 */
export class PostgresWorkflowRunReviewCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_workflow_review_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, uow = undefined } = {}) {
    assertPrincipal(principal);
    assertCommand(command);
    return this.#store.withTransaction(async (transaction) => {
      const commandKind = command.decision === "reject"
        ? "workflow_run_cancel"
        : "workflow_run_review";
      const existing = (await this.#query(transaction, `
        SELECT command_id, scope_id, quota_user_id, target_id, status,
               created_at, updated_at, finished_at, payload
          FROM public.product_commands
         WHERE workspace_id = $1 AND command_id = $2
           AND kind = $3
         FOR UPDATE
      `, [principal.workspaceId, command.commandId, commandKind])).rows[0];
      if (existing) {
        assertStoredCommand(existing, principal, command);
        const reviewId = command.decision === "reject"
          ? existing.payload?.reviewId
          : existing.target_id;
        if (typeof reviewId !== "string" || !reviewId) {
          throw coded("product_command_identity_conflict");
        }
        return this.#result(transaction, reviewId, command);
      }

      const review = (await this.#query(transaction, `
        SELECT review.review_id, review.run_id, review.node_id, review.revision,
               review.scope_id, review.status, review.node_attempt_id
          FROM public.workflow_run_reviews review
          JOIN public.workflow_runs run
            ON run.workspace_id = review.workspace_id AND run.run_id = review.run_id
         WHERE review.workspace_id = $1 AND review.run_id = $2
           AND review.node_id = $3 AND review.status = 'pending'
           AND run.status = 'waiting_review' AND run.current_node_id = review.node_id
         FOR UPDATE OF review, run
      `, [principal.workspaceId, command.runId, command.nodeId])).rows[0];
      if (!review) throw coded("workflow_run_review_not_waiting");
      if (command.expectedNodeRunId !== undefined && command.expectedNodeRunId !== review.node_attempt_id) throw coded("review_stale");
      if (review.scope_id !== command.scopeId) throw coded("workflow_run_review_scope_mismatch");

      const databaseNow = (await this.#query(transaction, "SELECT clock_timestamp() AS now")).rows[0].now;
      const authority = await this.#authority(transaction, {
        principal,
        command,
        actionId: command.decision === "reject" ? "workflow_run_cancel" : "workflow_run_review",
        effectClass: command.decision === "reject" ? "execute" : "write_local",
        databaseNow,
      });
      if (!authority) throw coded("workflow_run_review_authorization_required");

      if (command.decision === "reject") {
        await this.#query(transaction, `
          INSERT INTO public.product_commands (
            command_id, workspace_id, scope_id,
            actor_principal_id, actor_principal_kind,
            effective_principal_id, effective_principal_kind,
            authorization_decision_id, policy_revision_id,
            effect_class, argument_digest, quota_user_id,
            schema_version, kind, target_kind, target_id, target_revision,
            status, created_at, updated_at, finished_at, payload
          ) VALUES (
            $1, $2, $3,
            $4, 'user', $4, 'user',
            $5, $6,
            'execute', $7, $4,
            'workbench-v1', 'workflow_run_cancel', 'workflow_run_cancellation', $8, 1,
            'completed', $9, $9, $9, $10::jsonb
          )
        `, [
          command.commandId, principal.workspaceId, command.scopeId, principal.userId,
          authority.authorization_decision_id, authority.policy_revision_id,
          command.argumentDigest, command.runId, databaseNow,
          JSON.stringify({
            source: "review_rejection",
            reviewId: review.review_id,
            nodeId: command.nodeId,
            decision: command.decision,
            comment: command.comment ?? null,
            requestedChanges: command.requestedChanges,
          }),
        ]);
        await this.#query(transaction, `
          SELECT * FROM public.reject_workflow_run_review($1, $2, $3)
        `, [principal.workspaceId, review.review_id, command.commandId]);
      } else {
        await this.#query(transaction, `
          INSERT INTO public.product_commands (
            command_id, workspace_id, scope_id,
            actor_principal_id, actor_principal_kind,
            effective_principal_id, effective_principal_kind,
            authorization_decision_id, policy_revision_id,
            effect_class, argument_digest, quota_user_id,
            schema_version, kind, target_kind, target_id, target_revision,
            status, created_at, updated_at, finished_at, payload
          ) VALUES (
            $1, $2, $3,
            $4, 'user', $4, 'user',
            $5, $6,
            'write_local', $7, $4,
            'workbench-v1', 'workflow_run_review', 'workflow_run_review', $8, $9,
            'completed', $10, $10, $10, $11::jsonb
          )
        `, [
          command.commandId, principal.workspaceId, command.scopeId, principal.userId,
          authority.authorization_decision_id, authority.policy_revision_id,
          command.argumentDigest, review.review_id, review.revision, databaseNow,
          JSON.stringify({
            runId: command.runId,
            nodeId: command.nodeId,
            decision: command.decision,
            comment: command.comment ?? null,
            requestedChanges: command.requestedChanges,
          }),
        ]);
        await this.#query(transaction, `
          SELECT * FROM public.decide_workflow_run_review($1, $2, $3, $4)
        `, [principal.workspaceId, review.review_id, command.commandId, command.decision]);
      }
      await this.#dismissInbox(transaction, {
        workspaceId: principal.workspaceId,
        userId: principal.userId,
        reviewId: review.review_id,
        revision: review.revision,
      });
      return this.#result(transaction, review.review_id, command);
    }, uow === undefined || uow === null ? {} : { uow });
  }

  async #authority(transaction, { principal, command, actionId, effectClass, databaseNow }) {
    return (await this.#query(transaction, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = $5 AND effect_class = $6
         AND argument_digest = $7 AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $8::timestamptz)
       FOR SHARE
    `, [
      principal.workspaceId, command.authorizationDecisionId, command.scopeId,
      principal.userId, actionId, effectClass, command.argumentDigest, databaseNow,
    ])).rows[0];
  }

  async #dismissInbox(transaction, { workspaceId, userId, reviewId, revision }) {
    await this.#query(transaction, `
      UPDATE public.inbox_items
         SET status = 'dismissed', dismissed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE workspace_id = $1
         AND recipient_user_id = $2
         AND source_domain = 'workflow_run_review'
         AND source_id = $3
         AND source_revision = $4
         AND status <> 'dismissed'
    `, [workspaceId, userId, reviewId, revision]);
  }

  async #result(uow, reviewId, command) {
    const review = (await this.#query(uow, `
      SELECT review_id, run_id, node_id, decision, status, decided_at, cancelled_at
        FROM public.workflow_run_reviews
       WHERE workspace_id = $1 AND review_id = $2
    `, [command.workspaceId, reviewId])).rows[0];
    const run = (await this.#query(uow, `
      SELECT run_id, status, current_node_id, updated_at
        FROM public.workflow_runs
       WHERE workspace_id = $1 AND run_id = $2
    `, [command.workspaceId, command.runId])).rows[0];
    const event = (await this.#query(uow, `
      SELECT event_id, run_id, sequence, type, status, node_id, summary, occurred_at
        FROM public.workflow_run_events
       WHERE workspace_id = $1 AND run_id = $2
         AND review_id = $3 AND product_command_id = $4
         AND type = $5
    `, [
      command.workspaceId, command.runId, reviewId, command.commandId,
      command.decision === "reject" ? "run.cancelled" : "review.decided",
    ])).rows[0];
    const rejected = command.decision === "reject";
    if (!review || !run || !event
      || (rejected ? review.status !== "cancelled" : review.status !== "decided")) {
      throw coded("workflow_run_review_decision_incomplete");
    }
    return {
      decision: {
        schemaVersion: "workbench-v1",
        decisionId: review.review_id,
        runId: review.run_id,
        nodeId: review.node_id,
        decision: rejected ? "reject" : review.decision,
        requestedChanges: [...command.requestedChanges],
        decidedBy: command.decidedBy,
        decidedAt: iso(rejected ? review.cancelled_at : review.decided_at),
        applicationStatus: "applied",
        appliedByPersistence: true,
      },
      run: {
        runId: run.run_id,
        status: run.status,
        currentNodeId: run.current_node_id,
        updatedAt: iso(run.updated_at),
      },
      event: {
        schemaVersion: "workbench-run-event-v1",
        eventId: event.event_id,
        runId: event.run_id,
        sequence: Number(event.sequence),
        type: event.type,
        status: event.status,
        nodeId: event.node_id,
        summary: event.summary,
        occurredAt: iso(event.occurred_at),
      },
    };
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function assertPrincipal(principal) {
  if (typeof principal?.workspaceId !== "string" || !principal.workspaceId
    || typeof principal?.userId !== "string" || !principal.userId) {
    throw coded("postgres_workflow_review_principal_required");
  }
}

function assertCommand(command) {
  for (const [value, code] of [
    [command?.commandId, "postgres_workflow_review_command_id_required"],
    [command?.workspaceId, "postgres_workflow_review_workspace_required"],
    [command?.scopeId, "postgres_workflow_review_scope_required"],
    [command?.authorizationDecisionId, "workflow_run_review_authorization_required"],
    [command?.argumentDigest, "postgres_workflow_review_digest_required"],
    [command?.runId, "postgres_workflow_review_run_required"],
    [command?.nodeId, "postgres_workflow_review_node_required"],
    [command?.decidedBy, "postgres_workflow_review_actor_required"],
  ]) if (typeof value !== "string" || !value) throw coded(code);
  if (!/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)
    || !["approve", "revise", "reject"].includes(command.decision)
    || !Array.isArray(command.requestedChanges)) {
    throw coded("postgres_workflow_review_command_shape_invalid");
  }
}

function assertStoredCommand(row, principal, command) {
  const expectedTarget = command.decision === "reject" ? command.runId : undefined;
  if (row.scope_id !== command.scopeId
    || row.quota_user_id !== principal.userId
    || row.target_id == null
    || (expectedTarget !== undefined && row.target_id !== expectedTarget)
    || row.status !== "completed") {
    throw coded("product_command_identity_conflict");
  }
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresWorkflowRunReviewCommandIntakeError";
  error.code = code;
  return error;
}
