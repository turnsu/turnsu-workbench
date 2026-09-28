/**
 * PostgreSQL Command Intake for a public Workflow Run cancellation.
 *
 * The command is separate from review rejection: a pending Review has its
 * own aggregate and must be rejected through that bounded decision path.
 * This intake records the immutable execution authority and delegates the
 * Run state transition to `request_workflow_run_cancellation` in the same
 * PostgreSQL transaction.
 */
export class PostgresWorkflowRunCancellationCommandIntake {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_workflow_cancellation_command_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async accept({ principal, command, uow = undefined } = {}) {
    assertPrincipal(principal);
    assertCommand(command);
    try {
      return await this.#store.withTransaction(async (transaction) => {
        await this.#query(transaction, "SET CONSTRAINTS ALL DEFERRED");
        const existing = (await this.#query(transaction, `
          SELECT command_id, workspace_id, scope_id, quota_user_id, kind,
                 target_kind, target_id, target_revision, status, payload
            FROM public.product_commands
           WHERE workspace_id = $1 AND command_id = $2
             AND kind = 'workflow_run_cancel'
           FOR UPDATE
        `, [principal.workspaceId, command.commandId])).rows[0];
        if (existing) {
          assertStoredCommand(existing, principal, command);
          return this.#result(transaction, command);
        }

        const run = (await this.#query(transaction, `
          SELECT run_id, scope_id
            FROM public.workflow_runs
           WHERE workspace_id = $1 AND run_id = $2
           FOR UPDATE
        `, [principal.workspaceId, command.runId])).rows[0];
        if (!run) throw coded("run_not_found");
        if (run.scope_id !== command.scopeId) {
          throw coded("workflow_run_cancellation_scope_mismatch");
        }

        const databaseNow = (await this.#query(
          transaction,
          "SELECT clock_timestamp() AS now",
        )).rows[0].now;
        const authority = await this.#authority(transaction, {
          principal,
          command,
          databaseNow,
        });
        if (!authority) throw coded("workflow_run_cancellation_authorization_required");

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
            source: "run_cancellation",
            requestedBy: command.requestedBy,
            reason: command.reason ?? null,
          }),
        ]);
        await this.#query(transaction, `
          SELECT * FROM public.request_workflow_run_cancellation($1, $2, $3)
        `, [principal.workspaceId, command.runId, command.commandId]);
        return this.#result(transaction, command);
      }, uow === undefined || uow === null ? {} : { uow });
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async #authority(transaction, { principal, command, databaseNow }) {
    return (await this.#query(transaction, `
      SELECT authorization_decision_id, policy_revision_id
        FROM public.authorization_decisions
       WHERE workspace_id = $1 AND authorization_decision_id = $2
         AND scope_id = $3 AND actor_principal_id = $4 AND actor_principal_kind = 'user'
         AND effective_principal_id = $4 AND effective_principal_kind = 'user'
         AND action_id = 'workflow_run_cancel' AND effect_class = 'execute'
         AND argument_digest = $5 AND disposition = 'authorized'
         AND (expires_at IS NULL OR expires_at > $6::timestamptz)
       FOR SHARE
    `, [
      principal.workspaceId, command.authorizationDecisionId, command.scopeId,
      principal.userId, command.argumentDigest, databaseNow,
    ])).rows[0];
  }

  async #result(uow, command) {
    const run = (await this.#query(uow, `
      SELECT run_id, status, current_node_id, updated_at
        FROM public.workflow_runs
       WHERE workspace_id = $1 AND run_id = $2
    `, [command.workspaceId, command.runId])).rows[0];
    const event = (await this.#query(uow, `
      SELECT event_id, run_id, sequence, type, status, node_id, summary, occurred_at
        FROM public.workflow_run_events
       WHERE workspace_id = $1 AND run_id = $2
         AND product_command_id = $3
         AND type IN ('run.cancellation_requested', 'run.cancelled')
       -- A queued Run has both controller events under this command, while a
       -- running Run is terminally settled by its fenced Worker and retains
       -- only the original request event under the cancellation command.
       -- Prefer the immediate terminal event when it exists, otherwise make
       -- command replay return the durable intent rather than failing after
       -- the Worker has safely closed the Run.
       ORDER BY CASE type WHEN 'run.cancelled' THEN 0 ELSE 1 END, sequence DESC
       LIMIT 1
    `, [command.workspaceId, command.runId, command.commandId])).rows[0];
    if (!run || !event) throw coded("workflow_run_cancellation_incomplete");
    return {
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
    throw coded("postgres_workflow_cancellation_principal_required");
  }
}

function assertCommand(command) {
  for (const [value, code] of [
    [command?.commandId, "postgres_workflow_cancellation_command_id_required"],
    [command?.workspaceId, "postgres_workflow_cancellation_workspace_required"],
    [command?.scopeId, "postgres_workflow_cancellation_scope_required"],
    [command?.authorizationDecisionId, "workflow_run_cancellation_authorization_required"],
    [command?.argumentDigest, "postgres_workflow_cancellation_digest_required"],
    [command?.runId, "postgres_workflow_cancellation_run_required"],
    [command?.requestedBy, "postgres_workflow_cancellation_actor_required"],
  ]) if (typeof value !== "string" || !value) throw coded(code);
  if (!/^sha256:[a-f0-9]{64}$/.test(command.argumentDigest)
    || (command.reason != null && (typeof command.reason !== "string"
      || command.reason.length === 0 || command.reason.length > 2000))) {
    throw coded("postgres_workflow_cancellation_command_shape_invalid");
  }
}

function assertStoredCommand(row, principal, command) {
  const payload = row.payload ?? {};
  if (row.workspace_id !== principal.workspaceId
    || row.scope_id !== command.scopeId
    || row.quota_user_id !== principal.userId
    || row.kind !== "workflow_run_cancel"
    || row.target_kind !== "workflow_run_cancellation"
    || row.target_id !== command.runId
    || row.target_revision !== 1
    || row.status !== "completed"
    || payload.source !== "run_cancellation"
    || payload.requestedBy !== command.requestedBy
    || (payload.reason ?? null) !== (command.reason ?? null)) {
    throw coded("product_command_identity_conflict");
  }
}

function normalizeError(error) {
  if (error?.code && String(error.code).startsWith("workflow_run_")) return error;
  const message = String(error?.message ?? "");
  const code = [
    "workflow_run_cancellation_not_found",
    "workflow_run_cancellation_command_invalid",
    "workflow_run_cancellation_in_progress",
    "workflow_run_cancellation_terminal",
    "workflow_run_review_decision_required",
    "workflow_run_cancellation_state_invalid",
    "workflow_run_cancellation_queue_state_invalid",
    "workflow_run_cancellation_lease_state_invalid",
  ].find((candidate) => message.includes(candidate));
  return code ? coded(code) : error;
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresWorkflowRunCancellationCommandIntakeError";
  error.code = code;
  return error;
}
