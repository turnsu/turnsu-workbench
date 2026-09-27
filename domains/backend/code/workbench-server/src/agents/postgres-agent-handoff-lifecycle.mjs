import { canonicalRequestHash } from "../store/serialization.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import { PostgresAgentSessionDecisionCommandIntake } from "../coordination/postgres-agent-session-decision-command-intake.mjs";

const MEMBER_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/**
 * PostgreSQL owner for a Main Agent handoff decision. It owns this one
 * receipt-backed transition and never copies a Module transcript or creates
 * another Agent control path.
 */
export class PostgresAgentHandoffLifecycle {
  #store;
  #sql;
  #clock;
  #idFactory;
  #commandAuthorizer;
  #commandIntake;

  constructor({ store, clock = () => new Date().toISOString(), idFactory, commandAuthorizer, commandIntake } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function" || typeof idFactory !== "function"
      || typeof commandAuthorizer?.authorizeAgentHandoffConfirm !== "function") {
      throw new TypeError("postgres_agent_handoff_lifecycle_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#commandAuthorizer = commandAuthorizer;
    this.#commandIntake = commandIntake ?? new PostgresAgentSessionDecisionCommandIntake({ store });
    if (typeof this.#commandIntake.accept !== "function") {
      throw new TypeError("postgres_agent_handoff_lifecycle_command_intake_required");
    }
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async confirm({ sessionId, handoffId, idempotencyKey, request, context } = {}) {
    for (const [value, code] of [
      [sessionId, "agent_session_id_required"], [handoffId, "agent_handoff_id_required"],
      [idempotencyKey, "idempotency_key_required"], [context?.workspaceId, "workspace_id_required"],
      [context?.userId, "user_id_required"],
    ]) required(value, code);
    const scope = `confirm-agent-handoff:${handoffId}`;
    const requestHash = canonicalRequestHash(request);
    return this.#store.withTransaction(async (uow) => {
      const query = (text, values = []) => this.#sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`,
      [context.workspaceId, context.userId])).rows[0];
      if (!membership || MEMBER_RANK[membership.role] < MEMBER_RANK.member) throw coded("workspace_role_forbidden");
      const receipt = (await query(`INSERT INTO public.product_idempotency_receipts (
        workspace_id, effective_principal_id, operation_scope, idempotency_key,
        request_hash, response, created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)
      ON CONFLICT (workspace_id, effective_principal_id, operation_scope, idempotency_key)
      DO UPDATE SET operation_scope = EXCLUDED.operation_scope
      RETURNING request_hash, response`,
      [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, iso(this.#clock())])).rows[0];
      if (receipt.request_hash !== requestHash) throw coded("idempotency_key_reused");
      if (receipt.response !== null) return structuredClone(receipt.response);

      const session = (await query(`SELECT definition_id, status, event_sequence FROM public.agent_sessions
        WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3 FOR UPDATE`,
      [sessionId, context.workspaceId, context.userId])).rows[0];
      if (!session || session.definition_id !== "main" || session.status !== "active") throw coded("agent_handoff_target_invalid");
      const handoff = (await query(`SELECT * FROM public.agent_handoffs
        WHERE handoff_id = $1 AND target_session_id = $2 AND workspace_id = $3 AND user_id = $4 FOR UPDATE`,
      [handoffId, sessionId, context.workspaceId, context.userId])).rows[0];
      if (!handoff) throw coded("agent_handoff_not_found");
      if (!["pending", "confirmed"].includes(handoff.status)) throw coded("agent_handoff_state_invalid");
      if (handoff.status === "confirmed") {
        const response = handoffView(handoff);
        const completedAt = iso(this.#clock());
        await query(`UPDATE public.product_idempotency_receipts
          SET response = $6::jsonb, completed_at = $7::timestamptz
          WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
            AND idempotency_key = $4 AND request_hash = $5`,
        [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, JSON.stringify(response), completedAt]);
        return response;
      }
      const confirmedAt = iso(this.#clock());
      const targetRevision = Number(session.event_sequence) + 1;
      const authority = await this.#commandAuthorizer.authorizeAgentHandoffConfirm({
        workspaceId: context.workspaceId,
        userId: context.userId,
        sessionId,
        handoffId,
        targetRevision,
        uow,
      });
      const accepted = await this.#commandIntake.accept({
        principal: context,
        command: {
          commandId: this.#idFactory("product-command"),
          kind: "agent_handoff_confirm",
          targetId: handoffId,
          targetRevision,
          ...authority,
        },
        at: confirmedAt,
        uow,
        persistTarget: async ({ command }) => {
          const updated = (await query(`UPDATE public.agent_handoffs
            SET status = 'confirmed', confirmed_at = $3::timestamptz
            WHERE handoff_id = $1 AND target_session_id = $2 AND status = 'pending'
            RETURNING *`, [handoffId, sessionId, confirmedAt])).rows[0];
          if (!updated) throw coded("agent_handoff_state_invalid");
          const progressed = (await query(`UPDATE public.agent_sessions
            SET event_sequence = event_sequence + 1, updated_at = $4::timestamptz
            WHERE session_id = $1 AND workspace_id = $2 AND user_id = $3
            RETURNING event_sequence`, [sessionId, context.workspaceId, context.userId, confirmedAt])).rows[0];
          if (!progressed || Number(progressed.event_sequence) !== targetRevision) {
            throw coded("agent_handoff_target_invalid");
          }
          const eventId = this.#idFactory("agent-event");
          await query(`INSERT INTO public.agent_session_events (
            event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
          ) VALUES ($1, $2, NULL, 'workbench-v1', $3, 'agent.handoff.confirmed', 'completed', $4, $5::timestamptz, $6::jsonb)`,
          [eventId, sessionId, targetRevision,
            "Module Agent handoff confirmed.", confirmedAt, JSON.stringify({
              handoffId,
              sourceSessionId: updated.source_session_id,
              productCommandId: command.commandId,
            })]);
          await query(`INSERT INTO public.agent_session_decision_events (
            workspace_id, decision_event_id, product_command_id, session_id, session_event_id,
            target_kind, target_id, target_revision, action_kind, status_after, actor_user_id, created_at, payload
          ) VALUES ($1, $2, $3, $4, $5, 'agent_handoff', $6, $7, 'agent_handoff_confirm', 'confirmed', $8, $9::timestamptz, '{}'::jsonb)`,
          [context.workspaceId, this.#idFactory("agent-session-decision"), command.commandId,
            sessionId, eventId, handoffId, targetRevision, context.userId, confirmedAt]);
          return handoffView(updated);
        },
      });
      const response = accepted.target;
      await query(`UPDATE public.product_idempotency_receipts
        SET response = $6::jsonb, completed_at = $7::timestamptz
        WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3
          AND idempotency_key = $4 AND request_hash = $5`,
      [context.workspaceId, context.userId, scope, idempotencyKey, requestHash, JSON.stringify(response), confirmedAt]);
      return response;
    });
  }
}

function handoffView(row) {
  return {
    ...(row.payload ?? {}), schemaVersion: row.schema_version, handoffId: row.handoff_id,
    workspaceId: row.workspace_id, userId: row.user_id, sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id, status: row.status,
    createdAt: iso(row.created_at), confirmedAt: row.confirmed_at ? iso(row.confirmed_at) : null,
  };
}
function required(value, code) { if (typeof value !== "string" || !value) throw coded(code); }
function coded(code) { return new ProductStoreError(code, code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_agent_handoff_clock_invalid"); return date.toISOString(); }
