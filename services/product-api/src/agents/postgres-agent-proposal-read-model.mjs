import { ProductStoreError } from "../store/errors.mjs";

/** Read-only PG owner for a Module Agent's persisted proposal branch. */
export class PostgresAgentProposalReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) throw new TypeError("postgres_agent_proposal_read_model_store_required");
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({ query: (uow, text, values = []) => execute(uow, { text, values }) }));
  }

  async getProposal({ proposalId, sessionId, workspaceId, userId } = {}) {
    for (const [value, code] of [[proposalId, "agent_proposal_id_required"], [sessionId, "agent_session_id_required"], [workspaceId, "workspace_id_required"], [userId, "user_id_required"]]) required(value, code);
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#sql.query(uow, `SELECT * FROM public.agent_object_proposals
        WHERE proposal_id = $1 AND session_id = $2 AND workspace_id = $3 AND user_id = $4 AND created_by = $4`, [proposalId, sessionId, workspaceId, userId])).rows;
      const row = rows[0];
      if (!row) throw new ProductStoreError("agent_proposal_not_found", "Agent proposal not found.", { proposalId });
      return proposalView(row);
    });
  }
}

function proposalView(row) {
  return Object.freeze({
    ...(row.payload ?? {}), schemaVersion: row.schema_version, proposalId: row.proposal_id,
    workspaceId: row.workspace_id, userId: row.user_id, sessionId: row.session_id, turnId: row.turn_id,
    branchId: row.branch_id, definitionId: row.definition_id, objectKind: row.object_kind,
    objectId: row.object_id, baseVersionId: row.base_version_id, status: row.status,
    createdBy: row.created_by, createdAt: iso(row.created_at), decidedAt: row.decided_at ? iso(row.decided_at) : null,
  });
}
function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
