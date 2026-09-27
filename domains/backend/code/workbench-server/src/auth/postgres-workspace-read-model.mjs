import { ProductStoreError } from "../store/errors.mjs";

/** PostgreSQL read boundary for the authenticated workspace/session surface. */
export class PostgresWorkspaceReadModel {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_workspace_read_model_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async getWorkspace({ workspaceId } = {}) {
    required(workspaceId, "workspace_id_required");
    return this.#transact(async (query) => {
      const row = (await query(`SELECT workspace_id, schema_version, name, created_by, created_at, updated_at
        FROM public.product_workspaces WHERE workspace_id = $1`, [workspaceId])).rows[0];
      if (!row) throw unavailable();
      return workspaceView(row);
    });
  }

  async getActiveSession({ workspaceId, userId } = {}) {
    required(workspaceId, "workspace_id_required"); required(userId, "user_id_required");
    return this.#transact(async (query) => {
      const row = (await query(`SELECT workspace.workspace_id, workspace.schema_version AS workspace_schema_version,
          workspace.name, workspace.created_by, workspace.created_at AS workspace_created_at, workspace.updated_at AS workspace_updated_at,
          membership.membership_id, membership.user_id, membership.role, membership.created_at AS membership_created_at, membership.updated_at AS membership_updated_at
        FROM public.product_workspaces workspace
        JOIN public.workspace_memberships membership ON membership.workspace_id = workspace.workspace_id
        JOIN public.product_users user_account ON user_account.user_id = membership.user_id
        WHERE workspace.workspace_id = $1 AND membership.user_id = $2
          AND membership.status = 'active' AND user_account.disabled = false`, [workspaceId, userId])).rows[0];
      if (!row) throw unavailable();
      return Object.freeze({
        workspace: workspaceView({ workspace_id: row.workspace_id, schema_version: row.workspace_schema_version, name: row.name, created_by: row.created_by, created_at: row.workspace_created_at, updated_at: row.workspace_updated_at }),
        membership: Object.freeze({ schemaVersion: "workbench-v1", membershipId: row.membership_id, workspaceId: row.workspace_id, userId: row.user_id, role: row.role, createdAt: iso(row.membership_created_at), updatedAt: iso(row.membership_updated_at) }),
      });
    });
  }

  async listMemberships({ workspaceId, query = {} } = {}) {
    required(workspaceId, "workspace_id_required");
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    return this.#transact(async (sql) => (await sql(`SELECT membership_id, workspace_id, user_id, role, created_at, updated_at
      FROM public.workspace_memberships
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY created_at ASC, membership_id ASC LIMIT $2`, [workspaceId, limit])).rows.map((row) => Object.freeze({
      schemaVersion: "workbench-v1", membershipId: row.membership_id, workspaceId: row.workspace_id,
      userId: row.user_id, role: row.role, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    })));
  }

  #transact(work) { return this.#store.withTransaction((uow) => work((text, values = []) => this.#sql.query(uow, text, values))); }
}

function workspaceView(row) { return Object.freeze({ schemaVersion: row.schema_version, workspaceId: row.workspace_id, name: row.name, createdBy: row.created_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }); }
function required(value, code) { if (typeof value !== "string" || !value) throw new TypeError(code); }
function unavailable() { return new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace."); }
function iso(value) { const date = value instanceof Date ? value : new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : String(value); }
