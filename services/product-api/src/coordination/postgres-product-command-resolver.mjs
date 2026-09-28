/**
 * Narrow read port used by AdmissionController to revalidate the command that
 * owns an execution request. It is deliberately not a repository facade: the
 * caller can only resolve one product-safe command identity.
 */
export function createPostgresProductCommandResolver({ store } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_product_command_resolver_store_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
  return async ({ commandId, workspaceId, userId } = {}) => {
    for (const value of [commandId, workspaceId, userId]) {
      if (typeof value !== "string" || !value) return null;
    }
    return store.withTransaction(async (uow) => {
      const row = (await sql.query(uow, `
        SELECT command_id, workspace_id, quota_user_id, kind, session_id, turn_id,
               target_kind, target_id, target_revision,
               status, created_at, updated_at, finished_at
          FROM public.product_commands
         WHERE command_id = $1 AND workspace_id = $2 AND quota_user_id = $3
      `, [commandId, workspaceId, userId])).rows[0];
      return row ? {
        schemaVersion: "workbench-v1",
        commandId: row.command_id,
        workspaceId: row.workspace_id,
        userId: row.quota_user_id,
        kind: row.kind,
        sessionId: row.session_id,
        turnId: row.turn_id,
        targetKind: row.target_kind ?? null,
        targetId: row.target_id ?? null,
        targetRevision: row.target_revision === null ? null : Number(row.target_revision),
        status: row.status,
        createdAt: iso(row.created_at),
        updatedAt: iso(row.updated_at),
        finishedAt: iso(row.finished_at),
      } : null;
    });
  };
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}
