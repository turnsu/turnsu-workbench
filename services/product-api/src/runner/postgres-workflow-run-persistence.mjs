import { canonicalRequestHash } from "../store/serialization.mjs";
import { assertWorkflowRunPersistence } from "./workflow-run-persistence.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "partial", "effect_outcome_unknown"]);
const NODE_EVENT = new Set([
  "node.started", "node.progress", "node.completed", "node.failed",
  "node.effect_recovery_started", "node.effect_recovery_completed", "node.effect_recovery_unknown",
]);

/**
 * B3 PostgreSQL mapping for WorkflowRunner's durable aggregate port.
 *
 * The adapter is intentionally product-shaped: B3 roots, events, jobs and
 * node attempts remain their own relations. No Mongo repository facade or
 * generic document-to-SQL translator crosses this boundary.
 */
export function createPostgresWorkflowRunPersistence({ store, workspaceId } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_workflow_run_persistence_store_required");
  }
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new TypeError("postgres_workflow_run_persistence_workspace_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  const transact = (work, { uow } = {}) => store.withTransaction(work, uow ? { uow } : {});
  const query = (uow, text, values) => sql.query(uow, text, values);

  return assertWorkflowRunPersistence(Object.freeze({
    // A B3 workflow_run_event is the durable node boundary. PostgreSQL does
    // not manufacture a second checkpoint row after the execution attempt has
    // already been terminally settled by the Execution Broker.
    durableBoundaryMode: "event",

    async createAcceptedAggregate({ run, runJobId, executionPlan, executionSnapshot, eventTemplate, uow }) {
      assertCreateRoot(run);
      return transact(async (transaction) => {
        await query(transaction, "SET CONSTRAINTS ALL DEFERRED");
        await query(transaction, `
          INSERT INTO public.workflow_runs (
            workspace_id, run_id, scope_id, product_command_id,
            workflow_id, workflow_revision_id, workflow_revision_content_hash,
            compile_result_id, execution_plan_id, execution_plan_content_hash,
            retry_of_run_id, schema_version, inputs, resource_refs, idempotency_key, status,
            queued_at, created_at, updated_at, payload
          ) VALUES (
            $1, $2, $3, $4,
            $5, $6, $7,
            $8, $9, $10,
            $11, 'workbench-run-v1', $12::jsonb, $13::jsonb, $14, 'queued',
            $15, $15, $15, $16::jsonb
          )
        `, [
          workspaceId, run.runId, run.scopeId, run.creationCommandId,
          run.workflowId, run.workflowRevisionId, run.workflowRevisionContentHash,
          run.compileResultId, run.executionPlanId, run.executionPlanContentHash,
          run.retryOf ?? null,
          JSON.stringify(run.inputs), JSON.stringify(run.resourceRefs), run.idempotencyKey,
          run.queuedAt, JSON.stringify(rootPayload(run, executionPlan, executionSnapshot)),
        ]);
        await query(transaction, `
          INSERT INTO public.workflow_run_jobs (
            workspace_id, run_id, schema_version, state, available_at, queued_at,
            created_at, updated_at, payload
          ) VALUES ($1, $2, 'workbench-run-job-v1', 'queued', $3, $3, $3, $3, $4::jsonb)
        `, [workspaceId, run.runId, run.queuedAt, JSON.stringify({ runJobId })]);
        await query(transaction, `
          INSERT INTO public.workflow_run_events (
            workspace_id, event_id, run_id, schema_version, sequence, type, status,
            summary, writer_kind, product_command_id, run_fence, occurred_at, payload
          ) VALUES ($1, $2, $3, 'workbench-run-event-v1', 1, 'run.queued', 'queued',
            $4, 'controller', $5, 0, $6, $7::jsonb)
        `, [
          workspaceId, eventTemplate.eventId, run.runId, eventTemplate.summary,
          run.creationCommandId, eventTemplate.occurredAt,
          JSON.stringify({ source: "workflow_runner", state: "queued" }),
        ]);
        return {
          run: await readRun(transaction, run.runId),
          event: eventView({
            event_id: eventTemplate.eventId, run_id: run.runId, sequence: 1,
            type: "run.queued", status: "queued", summary: eventTemplate.summary,
            occurred_at: eventTemplate.occurredAt,
          }, run),
        };
      }, { uow });
    },

    async loadRecoverableAggregates() {
      return transact(async (uow) => {
        const rows = (await query(uow, `
          SELECT r.run_id
            FROM public.workflow_runs r
            JOIN public.workflow_run_jobs j
              ON j.workspace_id = r.workspace_id AND j.run_id = r.run_id
           WHERE r.workspace_id = $1
             AND r.status IN ('queued', 'running', 'cancellation_requested', 'waiting_review')
           ORDER BY j.available_at, j.queued_at, r.run_id
        `, [workspaceId])).rows;
        const aggregates = [];
        for (const row of rows) {
          const run = await readRun(uow, row.run_id);
          const job = await readJob(uow, row.run_id);
          if (run && job) aggregates.push({ run, job, latestDecision: null });
        }
        return aggregates;
      });
    },

    readInternalRun(runId, { uow } = {}) { return transact((transaction) => readRun(transaction, runId), { uow }); },
    readPublicRun(runId, { uow } = {}) {
      return transact(async (transaction) => {
        const run = await readRun(transaction, runId);
        return run ? projectPublicRun(transaction, run) : null;
      }, { uow });
    },
    transact(work, { uow } = {}) { return transact(work, { uow }); },

    async appendRunEvent({ run, eventTemplate, uow }) {
      return transact((transaction) => appendWorkerEvent(transaction, run, eventTemplate), { uow });
    },

    async projectReadModel({ run, overrides = {}, uow }) {
      return transact(async (transaction) => ({
        ...(await derivedReadModel(transaction, run.runId)),
        ...structuredClone(overrides),
      }), { uow });
    },

    async transitionRunState({ runId, patch = {}, uow }) {
      return transact(async (transaction) => {
        const current = await readRun(transaction, runId);
        if (!current) return null;
        // B3 changes lifecycle only in the event trigger. Node events carry
        // currentNodeId/status; terminal/cancellation use named port methods.
        if (patch.status && patch.status !== current.status) {
          throw coded("postgres_workflow_run_lifecycle_requires_event");
        }
        return current;
      }, { uow });
    },

    async saveExecutionSnapshot({ runId, executionPlan, executionSnapshot, uow }) {
      return transact(async (transaction) => {
        const run = await readRun(transaction, runId);
        if (!run) return null;
        const stored = run.executionSnapshot;
        if (canonicalRequestHash(stored) !== canonicalRequestHash(executionSnapshot)
          || canonicalRequestHash(run.executionPlanSnapshot) !== canonicalRequestHash(executionPlan)) {
          throw coded("postgres_workflow_run_snapshot_immutable");
        }
        return run;
      }, { uow });
    },

    readReadModel(runId, { uow } = {}) { return transact((transaction) => derivedReadModel(transaction, runId), { uow }); },
    listRunStateEvents(runId, { uow } = {}) {
      return transact(async (transaction) => (await query(transaction, `
        SELECT event.*, run.workflow_id, run.workflow_revision_id
          FROM public.workflow_run_events event
          JOIN public.workflow_runs run ON run.workspace_id = event.workspace_id AND run.run_id = event.run_id
         WHERE event.workspace_id = $1 AND event.run_id = $2
         ORDER BY event.sequence ASC, event.event_id ASC
      `, [workspaceId, runId])).rows.map(eventView), { uow });
    },
    listRunsByWorkflow(workflowId, { limit = 50 } = {}) {
      return transact(async (transaction) => (await query(transaction, `
        SELECT r.*, plan.plan_document
          FROM public.workflow_runs r
          JOIN public.execution_plans plan
            ON plan.workspace_id = r.workspace_id AND plan.plan_id = r.execution_plan_id
         WHERE r.workspace_id = $1 AND r.workflow_id = $2
         ORDER BY r.updated_at DESC, r.run_id ASC
         LIMIT $3
      `, [workspaceId, workflowId, safeLimit(limit)])).rows.map(runView)
        .reduce(async (pending, run) => [...await pending, await projectPublicRun(transaction, run)], Promise.resolve([])));
    },
    listRecentRuns(targetWorkspaceId, { limit = 3 } = {}) {
      if (targetWorkspaceId !== workspaceId) return Promise.resolve([]);
      return transact(async (transaction) => (await query(transaction, `
        SELECT r.*, plan.plan_document
          FROM public.workflow_runs r
          JOIN public.execution_plans plan
            ON plan.workspace_id = r.workspace_id AND plan.plan_id = r.execution_plan_id
         WHERE r.workspace_id = $1
         ORDER BY r.updated_at DESC, r.run_id ASC
         LIMIT $2
      `, [workspaceId, safeLimit(Math.min(limit, 10))])).rows.map(runView)
        .reduce(async (pending, run) => [...await pending, await projectPublicRun(transaction, run)], Promise.resolve([])));
    },
    listRunEvents(runId, after = 0, { uow } = {}) {
      return transact(async (transaction) => (await query(transaction, `
        SELECT event.*, run.workflow_id, run.workflow_revision_id
          FROM public.workflow_run_events event
          JOIN public.workflow_runs run ON run.workspace_id = event.workspace_id AND run.run_id = event.run_id
         WHERE event.workspace_id = $1 AND event.run_id = $2 AND event.sequence > $3
         ORDER BY event.sequence ASC, event.event_id ASC
      `, [workspaceId, runId, after])).rows.map(eventView), { uow });
    },
    listNodeAttempts(runId, { uow } = {}) { return transact((transaction) => listAttempts(transaction, runId), { uow }); },

    async createNodeAttempt(attempt, { uow } = {}) {
      return transact(async (transaction) => {
        const run = await readRun(transaction, attempt.runId);
        const job = await readJob(transaction, attempt.runId);
        if (!run || !job || job.state !== "leased") return null;
        if (attempt.invocationId) {
          const execution = (await query(transaction, `
            SELECT invocation_id, attempt_id, status
              FROM public.execution_invocations
             WHERE workspace_id = $1 AND invocation_id = $2
               AND attempt_id = $3 AND controller_kind = 'workflow_run'
               AND controller_id = $4 AND controller_fence = $5
          `, [workspaceId, attempt.invocationId, attempt.nodeRunId, attempt.runId, attempt.fence])).rows[0];
          if (!execution) throw coded("postgres_workflow_node_execution_lineage_invalid");
        }
        const inserted = (await query(transaction, `
          INSERT INTO public.workflow_run_node_attempts (
            workspace_id, node_attempt_id, run_id, scope_id, product_command_id,
            node_id, attempt_number, schema_version, status,
            invocation_id, execution_attempt_id, run_fence, lease_owner, lease_token,
            started_at, created_at, updated_at, payload
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, 'workbench-run-node-attempt-v1', 'running',
            $8, $9, $10, $11, $12,
            $13, $13, $13, $14::jsonb
          )
          RETURNING *
        `, [
          workspaceId, attempt.nodeRunId, attempt.runId, run.scopeId, run.creationCommandId,
          attempt.nodeId, attempt.attempt, attempt.invocationId ?? null,
          attempt.invocationId ? attempt.nodeRunId : null,
          attempt.fence, job.leaseOwner, job.leaseToken, attempt.startedAt,
          JSON.stringify(attemptPayload(attempt)),
        ])).rows[0];
        return attemptView(inserted);
      }, { uow });
    },

    async patchNodeAttempt({ runId, nodeId, attempt, patch, uow }) {
      return transact(async (transaction) => {
        const current = (await query(transaction, `
          SELECT * FROM public.workflow_run_node_attempts
           WHERE workspace_id = $1 AND run_id = $2 AND node_id = $3 AND attempt_number = $4
           FOR UPDATE
        `, [workspaceId, runId, nodeId, attempt])).rows[0];
        if (!current) return null;
        const nextStatus = patch.status ?? current.status;
        const completedAt = TERMINAL.has(nextStatus) ? patch.completedAt ?? current.finished_at : null;
        const updated = (await query(transaction, `
          UPDATE public.workflow_run_node_attempts
             SET status = $5, finished_at = $6, updated_at = $7,
                 payload = payload || $8::jsonb
           WHERE workspace_id = $1 AND run_id = $2 AND node_id = $3 AND attempt_number = $4
           RETURNING *
        `, [
          workspaceId, runId, nodeId, attempt, nextStatus, completedAt,
          patch.updatedAt ?? new Date().toISOString(), JSON.stringify(attemptPayload(patch)),
        ])).rows[0];
        return attemptView(updated);
      }, { uow });
    },

    async syncNodeRuns({ runId, uow }) { return transact((transaction) => readRun(transaction, runId), { uow }); },

    async createCheckpoint() {
      // See durableBoundaryMode above: node/terminal events are B3's physical,
      // fenced checkpoints. Returning null makes callers acknowledge that
      // representation instead of inserting a duplicate post-settlement row.
      return null;
    },

    async readRunState(runId, { uow } = {}) {
      return transact(async (transaction) => {
        const run = await readRun(transaction, runId);
        if (!run) throw coded("run_not_found");
        return {
          sequence: run.eventSequence,
          stateHash: null,
          base: null,
          state: {
            status: run.status,
            currentNodeId: run.currentNodeId,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            updatedAt: run.updatedAt,
          },
        };
      }, { uow });
    },

    async withFencedTransaction({
      runId,
      workerId,
      fence,
      leaseToken,
      now,
      uow,
      assertActiveFence,
      mutation,
    }) {
      if (typeof assertActiveFence !== "function" || typeof mutation !== "function") {
        throw new TypeError("postgres_workflow_run_fenced_mutation_required");
      }
      return transact(async (transaction) => {
        const active = await assertActiveFence(runId, {
          workerId,
          fence,
          leaseToken,
          now,
          uow: transaction,
        });
        if (!active) return null;
        return mutation({ uow: transaction });
      }, { uow });
    },

    async settleTerminalAggregate({
      runId,
      status,
      now,
      lease,
      patch = {},
      readModelFactory = null,
      eventTemplate,
      syncCommandLifecycle,
      uow,
    }) {
      if (!TERMINAL.has(status)) throw coded("run_terminal_status_invalid");
      return transact(async (transaction) => {
        const current = await readRun(transaction, runId);
        if (!current) return { kind: "not_found", event: null, run: null };
        if (TERMINAL.has(current.status)) {
          if (current.status !== status) throw coded("run_terminal_status_conflict");
          return { kind: "settled", event: null, run: current };
        }
        const terminalRun = {
          ...current,
          ...structuredClone(patch),
          status,
          finishedAt: now,
          updatedAt: now,
        };
        const terminalReadModel = typeof readModelFactory === "function"
          ? readModelFactory({ run: terminalRun })
          : null;
        const terminalAttempt = await latestAttempt(
          transaction,
          runId,
          current.currentNodeId,
        );
        if (status === "completed" || status === "partial") {
          if (!terminalAttempt || !terminalReadModel?.finalAnswer) {
            throw coded("postgres_workflow_final_output_required");
          }
          await insertFinalOutput(transaction, {
            run: terminalRun,
            attempt: terminalAttempt,
            status,
            finalAnswer: terminalReadModel.finalAnswer,
            now,
            lease,
          });
        }
        const event = await appendWorkerEvent(transaction, current, {
          ...eventTemplate,
          type: `run.${status}`,
          status,
          occurredAt: now,
        });
        const settled = await readRun(transaction, runId);
        await syncCommandLifecycle?.(settled, status, { at: now, uow: transaction });
        return { kind: "settled", event, run: settled };
      }, { uow });
    },

    async recordReviewDecisionAndRequeue() { throw coded("postgres_workflow_review_command_intake_required"); },
    async pauseForReview({
      runId,
      nodeId,
      lease,
      workerId,
      now,
      reviewPacket,
      idFactory,
      syncCommandLifecycle,
      eventTemplate,
      uow,
    }) {
      if (typeof idFactory !== "function" || typeof syncCommandLifecycle !== "function") {
        throw new TypeError("postgres_workflow_review_dependencies_required");
      }
      return transact(async (transaction) => {
        const current = await readRun(transaction, runId);
        const job = await readJob(transaction, runId);
        const attempt = await latestAttempt(transaction, runId, nodeId);
        if (!current || !job || !attempt
          || job.state !== "leased"
          || job.leaseOwner !== workerId
          || job.fence !== lease?.fence
          || job.leaseToken !== lease?.leaseToken
          || attempt.status !== "waiting_review"
          || !attempt.invocationId) return null;
        const reviewId = idFactory("review");
        const insertedEvent = (await query(transaction, `
          INSERT INTO public.workflow_run_events (
            workspace_id, event_id, run_id, schema_version, sequence, type, status,
            node_id, node_attempt_id, review_id, summary, writer_kind, run_fence,
            lease_owner, lease_token, occurred_at, payload
          ) VALUES (
            $1, $2, $3, 'workbench-run-event-v1', $4, 'review.requested', 'waiting_review',
            $5, $6, $7, $8, 'worker', $9,
            $10, $11, GREATEST($12::timestamptz, clock_timestamp()), $13::jsonb
          )
          RETURNING *
        `, [
          workspaceId, eventTemplate.eventId, runId, current.eventSequence + 1,
          nodeId, attempt.nodeRunId, reviewId, eventTemplate.summary,
          job.fence, job.leaseOwner, job.leaseToken, now,
          JSON.stringify({ source: "workflow_runner" }),
        ])).rows[0];
        await query(transaction, `
          INSERT INTO public.workflow_run_reviews (
            workspace_id, review_id, run_id, scope_id, node_id, node_attempt_id,
            revision, schema_version, status, requested_at, updated_at, payload
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, 'workbench-run-review-v1', 'pending', $8::timestamptz, $8::timestamptz, $9::jsonb
          )
        `, [
          workspaceId, reviewId, runId, current.scopeId, nodeId, attempt.nodeRunId,
          attempt.attempt, now, JSON.stringify({ reviewPacket: structuredClone(reviewPacket) }),
        ]);
        await query(transaction, `
          INSERT INTO public.inbox_items (
            workspace_id, inbox_item_id, recipient_user_id,
            source_domain, source_id, source_revision, source_cursor,
            reason_code, severity, title, summary, target_kind, target_id,
            action_id, status, schema_version, created_at, updated_at
          )
          SELECT
            $1::text,
            md5('workflow-run-review-inbox:' || $2::text || ':' || review_grant.principal_id::text)::public.product_identifier,
            review_grant.principal_id,
            'workflow_run_review', $2::text, $3::integer, $2::text || ':' || ($3::integer)::text,
            'review_required', 'warning',
            'Review required', 'A Workflow Run is waiting for your review.',
            'workflow_run_review', $4::text,
            NULL, 'unread', 'workbench-inbox-item-v1', $5::timestamptz, $5::timestamptz
          FROM public.product_scopes scope
          JOIN public.scope_principal_grants review_grant
            ON review_grant.workspace_id = scope.workspace_id
           AND review_grant.scope_id = scope.scope_id
           AND review_grant.principal_kind = 'user'
           AND review_grant.access_kind = 'operation'
           AND review_grant.can_approve = true
           AND review_grant.status = 'active'
           AND review_grant.revoked_at IS NULL
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = scope.workspace_id
           AND membership.user_id = review_grant.principal_id
           AND membership.status = 'active'
           AND membership.removed_at IS NULL
          JOIN public.workspace_principals principal
            ON principal.workspace_id = scope.workspace_id
           AND principal.principal_id = review_grant.principal_id
           AND principal.principal_kind = 'user'
           AND principal.status = 'active'
           AND principal.revoked_at IS NULL
         WHERE scope.workspace_id = $1::text
           AND scope.scope_id = $6::text
           AND scope.scope_kind = 'personal'
           AND scope.owner_user_id = review_grant.principal_id
          ON CONFLICT (workspace_id, recipient_user_id, source_domain, source_id, source_revision)
          DO NOTHING
        `, [workspaceId, reviewId, attempt.attempt, runId, now, current.scopeId]);
        const waiting = await readRun(transaction, runId);
        await syncCommandLifecycle(waiting, "waiting_review", { at: now, uow: transaction });
        return { event: eventView(insertedEvent, waiting), run: waiting, reviewId };
      }, { uow });
    },
    async markReviewDecision() { throw coded("postgres_workflow_review_transition_not_yet_migrated"); },
    async requeueReview() { throw coded("postgres_workflow_review_transition_not_yet_migrated"); },

    async heartbeatLeaseProjection({ runId, workerId, fence, leaseToken, leaseExpiresAt, now }) {
      const duration = Date.parse(leaseExpiresAt) - Date.parse(now);
      if (!Number.isSafeInteger(duration) || duration < 1_000) return null;
      return transact(async (transaction) => {
        const row = (await query(transaction, `
          SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
            FROM public.renew_workflow_run_job_lease($1, $2, $3, $4, $5, $6::interval)
        `, [
          workspaceId, runId, workerId, leaseToken,
          `run-lease-renewal:${runId}:${fence}:${Date.parse(leaseExpiresAt)}`.slice(0, 128),
          `${duration} milliseconds`,
        ])).rows[0];
        return row ? jobView(row) : null;
      });
    },

    async releaseLeaseProjection({ runId, workerId, fence, leaseToken }) {
      return transact(async (transaction) => {
        const job = await readJob(transaction, runId);
        if (!job || job.fence !== fence || job.leaseOwner !== workerId || job.leaseToken !== leaseToken) return null;
        return job;
      });
    },

    async listEffectReceipts({ controllerId, invocationId, nodeId } = {}, { uow } = {}) {
      return transact(async (transaction) => (await query(transaction, `
        SELECT effect_id, invocation_id, attempt_id, controller_id, node_id,
               connection_id, requirement_id, action, status, created_at, payload
          FROM public.external_effect_receipts
         WHERE workspace_id = $1
           AND ($2::text IS NULL OR controller_id = $2)
           AND ($3::text IS NULL OR invocation_id = $3)
           AND ($4::text IS NULL OR node_id = $4)
         ORDER BY created_at, effect_id LIMIT 2
      `, [workspaceId, controllerId ?? null, invocationId ?? null, nodeId ?? null])).rows.map(effectView), { uow });
    },

    async runIdempotently(operation, mutation) {
      if (typeof mutation !== "function") throw new TypeError("postgres_workflow_run_idempotent_mutation_required");
      return transact(async (uow) => {
        const requestHash = canonicalRequestHash(operation.request);
        const now = new Date().toISOString();
        const claimed = (await query(uow, `
          INSERT INTO public.product_idempotency_receipts (
            workspace_id, effective_principal_id, operation_scope, idempotency_key,
            request_hash, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (
            workspace_id, effective_principal_id, operation_scope, idempotency_key
          ) DO NOTHING
          RETURNING request_hash
        `, [workspaceId, operation.effectivePrincipalId, operation.scope, operation.key, requestHash, now])).rows[0];
        if (!claimed) {
          // INSERT .. ON CONFLICT waits for a concurrent owner to commit. At
          // READ COMMITTED the following statement then sees and locks the
          // complete receipt, so two schedulers converge on one aggregate.
          const existing = (await query(uow, `
            SELECT request_hash, response
              FROM public.product_idempotency_receipts
             WHERE workspace_id = $1 AND effective_principal_id = $2
               AND operation_scope = $3 AND idempotency_key = $4
             FOR UPDATE
          `, [workspaceId, operation.effectivePrincipalId, operation.scope, operation.key])).rows[0];
          if (!existing || existing.request_hash !== requestHash) {
            throw coded("idempotency_request_conflict");
          }
          if (existing.response == null) throw coded("idempotency_record_incomplete");
          return existing.response;
        }
        const response = await mutation(uow);
        await query(uow, `
          UPDATE public.product_idempotency_receipts
             SET response = $5::jsonb, completed_at = $6
           WHERE workspace_id = $1 AND effective_principal_id = $2
             AND operation_scope = $3 AND idempotency_key = $4
        `, [workspaceId, operation.effectivePrincipalId, operation.scope, operation.key, JSON.stringify(response), now]);
        return response;
      });
    },

    // Public cancellation is accepted by PostgresWorkflowRunCancellationCommandIntake.
    // Keeping this legacy port fail-closed prevents a generic caller from
    // creating an unfenced cancellation transition behind the command ledger.
    async requestCancellation() { throw coded("postgres_workflow_cancellation_command_intake_required"); },
  }));

  async function appendWorkerEvent(uow, run, eventTemplate) {
    const current = await readRun(uow, run.runId);
    const job = await readJob(uow, run.runId);
    if (!current || !job || job.state !== "leased") throw coded("run_lease_lost");
    // PostgreSQL's event status is the Run projection status. Individual node
    // outcomes live in `workflow_run_node_attempts`, so a completed/failed
    // node event keeps the parent Run `running` until a distinct terminal Run
    // event is committed.
    const status = NODE_EVENT.has(eventTemplate.type) ? "running" : eventTemplate.status;
    let node = (NODE_EVENT.has(eventTemplate.type) || TERMINAL.has(status))
      ? await latestAttempt(uow, run.runId, eventTemplate.nodeId ?? current.currentNodeId)
      : null;
    const recoveredUnknown = ["failed", "effect_outcome_unknown"].includes(status)
      && node?.fence < job.fence
      && node?.invocationStatus === "outcome_unknown";
    if (recoveredUnknown) node = null;
    const requiresNode = NODE_EVENT.has(eventTemplate.type)
      || (TERMINAL.has(status) && !recoveredUnknown);
    if (requiresNode && !node) throw coded("postgres_workflow_event_node_attempt_required");
    const inserted = (await query(uow, `
      INSERT INTO public.workflow_run_events (
        workspace_id, event_id, run_id, schema_version, sequence, type, status,
        node_id, node_attempt_id, summary, writer_kind, run_fence,
        lease_owner, lease_token, occurred_at, payload
      ) VALUES ($1, $2, $3, 'workbench-run-event-v1', $4, $5, $6,
        $7, $8, $9, 'worker', $10, $11, $12,
        GREATEST($13::timestamptz, clock_timestamp()), $14::jsonb)
      RETURNING *
    `, [
      workspaceId, eventTemplate.eventId, run.runId, current.eventSequence + 1,
      eventTemplate.type, status, node?.nodeId ?? null,
      node?.nodeRunId ?? null, eventTemplate.summary, job.fence,
      job.leaseOwner, job.leaseToken, eventTemplate.occurredAt,
      JSON.stringify({ source: "workflow_runner" }),
    ])).rows[0];
    return eventView(inserted, current);
  }

  async function readRun(uow, runId) {
    const row = (await query(uow, `
      SELECT r.*, plan.plan_document,
             (SELECT jsonb_build_object(
                'decisionId', review.review_id, 'nodeId', review.node_id,
                'gateAttemptId', review.node_attempt_id,
                'comment', command.payload->'comment',
                'requestedChanges', command.payload->'requestedChanges'
              ) FROM public.workflow_run_reviews review
              JOIN public.product_commands command
                ON command.workspace_id=review.workspace_id AND command.command_id=review.decision_command_id
              WHERE review.workspace_id=r.workspace_id AND review.run_id=r.run_id
                AND review.status='decided' AND review.decision='revise'
                AND NOT EXISTS (
                  SELECT 1 FROM public.workflow_run_node_attempts newer
                  WHERE newer.workspace_id=review.workspace_id AND newer.run_id=review.run_id
                    AND newer.node_id=review.node_id AND newer.attempt_number>review.revision
                )
              ORDER BY review.requested_at DESC, review.review_id DESC LIMIT 1
             ) AS pending_review_revision,
             EXISTS (
               SELECT 1
                 FROM public.workflow_run_final_outputs output
                WHERE output.workspace_id = r.workspace_id
                  AND output.run_id = r.run_id
             ) AS final_output_available
        FROM public.workflow_runs r
        JOIN public.execution_plans plan
          ON plan.workspace_id = r.workspace_id AND plan.plan_id = r.execution_plan_id
       WHERE r.workspace_id = $1 AND r.run_id = $2
    `, [workspaceId, runId])).rows[0];
    return row ? runView(row) : null;
  }

  async function readJob(uow, runId) {
    const row = (await query(uow, `
      SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
        FROM public.workflow_run_jobs WHERE workspace_id = $1 AND run_id = $2
    `, [workspaceId, runId])).rows[0];
    return row ? jobView(row) : null;
  }

  async function listAttempts(uow, runId) {
    const rows = (await query(uow, `
      SELECT * FROM public.workflow_run_node_attempts
       WHERE workspace_id = $1 AND run_id = $2
       ORDER BY created_at, node_attempt_id
    `, [workspaceId, runId])).rows;
    return rows.map(attemptView);
  }

  async function latestAttempt(uow, runId, nodeId = null) {
    const row = (await query(uow, `
      SELECT * FROM public.workflow_run_node_attempts
       WHERE workspace_id = $1 AND run_id = $2
         AND ($3::text IS NULL OR node_id = $3)
       ORDER BY created_at DESC, node_attempt_id DESC LIMIT 1
    `, [workspaceId, runId, nodeId])).rows[0];
    return row ? attemptView(row) : null;
  }

  async function derivedReadModel(uow, runId) {
    const run = await readRun(uow, runId);
    if (!run) return null;
    const nodeTimeline = await listAttempts(uow, runId);
    const final = await query(uow, `SELECT final_answer, evidence_refs FROM public.workflow_run_final_outputs
                    WHERE workspace_id = $1 AND run_id = $2`, [workspaceId, runId]);
    const reviews = await query(uow, `
      SELECT review_id, node_id, revision, requested_at, status, decision, decided_at, payload
        FROM public.workflow_run_reviews
       WHERE workspace_id = $1 AND run_id = $2
       ORDER BY requested_at ASC, review_id ASC
    `, [workspaceId, runId]);
    const decisions = await publicReviewDecisions(uow, run.runId);
    const rounds = reviews.rows.filter(review => review.payload?.reviewPacket);
    const failure = [...nodeTimeline]
      .reverse()
      .find((attempt) => attempt.failure && (
        ["failed", "partial", "effect_outcome_unknown"].includes(attempt.status)
        || attempt.failure.code === "side_effect_outcome_unknown"
      ))
      ?.failure ?? null;
    return {
      schemaVersion: "workbench-v1",
      runId, workflowId: run.workflowId, workflowRevisionId: run.workflowRevisionId,
      status: run.status, currentNodeId: run.currentNodeId, nodeTimeline: nodeTimeline.map(publicNodeRun),
      finalAnswer: final.rows[0]?.final_answer ?? null,
      evidenceGaps: [],
      reviewPacket: [...reviews.rows].reverse().find((review) => review.status === "pending")?.payload?.reviewPacket ?? null,
      reviewDecisions: decisions,
      reviewRounds: rounds.slice(-10).map(review => ({
        reviewId: review.review_id, attempt: Number(review.revision), requestedAt: iso(review.requested_at),
        packet: review.payload.reviewPacket,
        decision: decisions.find(decision => decision.decisionId === review.review_id) ?? null,
      })),
      olderReviewRounds: Math.max(0, rounds.length - 10),
      failure,
      recoveryActions: [], followUpPrompts: [], resourceRefs: run.resourceRefs,
      evidenceRefs: final.rows[0]?.evidence_refs ?? [], createdAt: run.createdAt, updatedAt: run.updatedAt,
    };
  }

  async function publicReviewDecisions(uow, runId) {
    const reviews = (await query(uow, `SELECT review.*, command.effective_principal_id,
        command.payload AS command_payload, receipt.idempotency_key
      FROM public.workflow_run_reviews review
      JOIN public.product_commands command ON command.workspace_id = review.workspace_id
        AND command.command_id = COALESCE(review.decision_command_id, review.cancellation_command_id)
      LEFT JOIN public.product_idempotency_receipts receipt ON receipt.workspace_id = review.workspace_id
        AND receipt.effective_principal_id = command.effective_principal_id
        AND receipt.operation_scope = $3 AND receipt.response #>> '{decision,decisionId}' = review.review_id
      WHERE review.workspace_id = $1 AND review.run_id = $2
        AND (review.status = 'decided' OR command.payload->>'source' = 'review_rejection')
      ORDER BY review.requested_at, review.review_id`, [workspaceId, runId, `review-decision:${runId}`])).rows;
    return reviews.map((row) => {
      if (!row.idempotency_key) throw coded("workflow_review_receipt_missing");
      const decidedAt = iso(row.decided_at ?? row.cancelled_at);
      return {
        schemaVersion: "workbench-v1", decisionId: row.review_id, runId: row.run_id, nodeId: row.node_id,
        decision: row.command_payload.decision,
        ...(row.command_payload.comment == null ? {} : { comment: row.command_payload.comment }),
        requestedChanges: row.command_payload.requestedChanges ?? [], decidedBy: row.effective_principal_id,
        idempotencyKey: row.idempotency_key, decidedAt, createdAt: decidedAt, updatedAt: decidedAt,
      };
    });
  }

  async function projectPublicRun(uow, run) {
    const attempts = await listAttempts(uow, run.runId);
    const reviewDecisions = await publicReviewDecisions(uow, run.runId);
    return { schemaVersion: "workbench-v1", ...pick(run, [
      "runId", "workflowId", "workflowRevisionId", "retryOf", "inputs", "resourceRefs", "executionPlanVersion",
      "executionPlanContentHash", "status", "currentNodeId", "idempotencyKey", "authoritativeReadModel",
      "queuedAt", "startedAt", "finishedAt", "createdAt", "updatedAt",
    ]), nodeRuns: attempts.map(publicNodeRun), reviewDecisions };
  }

  async function insertFinalOutput(uow, {
    run,
    attempt,
    status,
    finalAnswer,
    now,
    lease,
  }) {
    if (!attempt?.nodeRunId || !attempt.nodeId || !lease?.fence || !lease?.workerId || !lease?.leaseToken) {
      throw coded("postgres_workflow_final_output_lineage_required");
    }
    if (!finalAnswer || typeof finalAnswer !== "object" || Array.isArray(finalAnswer)) {
      throw coded("postgres_workflow_final_output_invalid");
    }
    await query(uow, `
      INSERT INTO public.workflow_run_final_outputs (
        workspace_id, run_id, node_id, node_attempt_id,
        schema_version, outcome, run_fence, lease_owner, lease_token,
        final_answer, artifact_refs, evidence_refs, created_at, payload
      ) VALUES (
        $1, $2, $3, $4,
        'workbench-run-final-output-v1', $5, $6, $7, $8,
        $9::jsonb, '[]'::jsonb, '[]'::jsonb, $10::timestamptz,
        '{"source":"workflow_runner"}'::jsonb
      )
    `, [
      workspaceId,
      run.runId,
      attempt.nodeId,
      attempt.nodeRunId,
      status,
      lease.fence,
      lease.workerId,
      lease.leaseToken,
      JSON.stringify(finalAnswer),
      now,
    ]);
  }
}

function assertCreateRoot(run) {
  for (const value of [
    run?.runId, run?.workspaceId, run?.scopeId, run?.creationCommandId,
    run?.workflowId, run?.workflowRevisionId, run?.workflowRevisionContentHash,
    run?.compileResultId, run?.executionPlanId, run?.executionPlanContentHash,
  ]) if (typeof value !== "string" || !value) throw coded("postgres_workflow_run_root_metadata_required");
}

function rootPayload(run, executionPlan, executionSnapshot) {
  return {
    requestedBy: run.requestedBy,
    ...(run.retryCommand ? { retryCommand: structuredClone(run.retryCommand) } : {}),
    skillMaterialBindings: run.skillMaterialBindings,
    executionPlanSnapshot: executionPlan,
    executionSnapshot,
    authoritativeReadModel: run.authoritativeReadModel,
  };
}

function runView(row) {
  const payload = row.payload ?? {};
  return {
    schemaVersion: row.schema_version,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    scopeId: row.scope_id,
    requestedBy: payload.requestedBy,
    workflowId: row.workflow_id,
    workflowRevisionId: row.workflow_revision_id,
    ...(row.retry_of_run_id ? { retryOf: row.retry_of_run_id } : {}),
    workflowRevisionContentHash: row.workflow_revision_content_hash,
    compileResultId: row.compile_result_id,
    executionPlanId: row.execution_plan_id,
    executionPlanVersion: row.plan_version ?? "workbench-execution-plan-v2",
    executionPlanContentHash: row.execution_plan_content_hash,
    creationCommandId: row.product_command_id,
    commandLineage: "workflow_run_canonical",
    pendingReviewRevision: row.pending_review_revision ?? null,
    inputs: row.inputs,
    resourceRefs: row.resource_refs,
    skillMaterialBindings: payload.skillMaterialBindings ?? [],
    idempotencyKey: row.idempotency_key,
    status: row.status,
    currentNodeId: row.current_node_id,
    queuedAt: iso(row.queued_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    eventSequence: Number(row.event_sequence),
    // B3 event state is owned by workflow_run_events, not Mongo's V2 stream.
    stateModelVersion: 3,
    stateEventSequence: Number(row.event_sequence),
    stateHash: null,
    executionPlanSnapshot: payload.executionPlanSnapshot ?? row.plan_document,
    executionSnapshot: payload.executionSnapshot ?? null,
    authoritativeReadModel: row.final_output_available === true
      ? { available: true, version: 1 }
      : payload.authoritativeReadModel ?? { available: false, version: 0 },
  };
}

function pick(value, keys) { return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])); }
function publicNodeRun(attempt) {
  return { schemaVersion: "workbench-v1", ...pick(attempt, [
    "nodeRunId", "runId", "nodeId", "attempt", "status", "failure", "requestedModelRevisionId",
    "actualModelRevisionId", "artifactRefs", "fallbackUsed", "startedAt", "completedAt", "createdAt", "updatedAt",
  ]), summary: attempt.summary ?? "" };
}

function jobView(row) {
  return {
    runId: row.run_id, workspaceId: row.workspace_id, status: row.state,
    state: row.state, workerId: row.lease_owner, leaseOwner: row.lease_owner,
    leaseToken: row.lease_token, leaseExpiresAt: iso(row.lease_expires_at),
    fence: Number(row.fence),
  };
}

function attemptPayload(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => (
    !["runId", "nodeRunId", "nodeId", "attempt", "status", "invocationId", "fence", "startedAt", "completedAt", "createdAt", "updatedAt", "workerId"].includes(key)
      && item !== undefined
  )));
}

function attemptView(row) {
  const payload = row.payload ?? {};
  return {
    schemaVersion: row.schema_version,
    nodeRunId: row.node_attempt_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: Number(row.attempt_number),
    status: row.status,
    invocationId: row.invocation_id,
    invocationStatus: payload.invocationStatus ?? null,
    workerId: row.lease_owner,
    fence: Number(row.run_fence),
    startedAt: iso(row.started_at), completedAt: iso(row.finished_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...payload,
  };
}

function eventView(row, run = null) {
  return {
    schemaVersion: row.schema_version ?? "workbench-run-event-v1",
    eventId: row.event_id, runId: row.run_id, sequence: Number(row.sequence),
    workflowId: run?.workflowId ?? row.workflow_id,
    workflowRevisionId: run?.workflowRevisionId ?? row.workflow_revision_id,
    type: row.type, status: row.status, ...(row.node_id == null ? {} : { nodeId: row.node_id }),
    summary: row.summary, occurredAt: iso(row.occurred_at),
  };
}

function effectView(row) {
  return {
    effectId: row.effect_id, invocationId: row.invocation_id, attemptId: row.attempt_id,
    controllerId: row.controller_id, nodeId: row.node_id,
    connectionId: row.connection_id, requirementId: row.requirement_id,
    action: row.action, status: row.status, createdAt: iso(row.created_at),
    ...(row.payload ?? {}),
  };
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function safeLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 50;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
