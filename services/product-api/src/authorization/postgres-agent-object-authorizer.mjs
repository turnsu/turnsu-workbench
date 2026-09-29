import { AUTHORIZATION_CAPABILITIES } from "@turnsu/workbench-contracts";

/**
 * Resolves the canonical object + grant projection required by Module Agent
 * and object-scoped Memory reads. The caller receives only an authorization
 * decision; PostgreSQL SQL and rows remain inside this adapter.
 */
export function createPostgresAgentObjectAuthorizer({ store, objectAccessPolicy } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction || !objectAccessPolicy?.evaluate) {
    throw new TypeError("postgres_agent_object_authorizer_dependencies_invalid");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
  return async ({ objectKind, objectId, userId, workspaceId, capabilities = null } = {}) => {
    required(objectKind); required(objectId); required(userId); required(workspaceId);
    const projection = await store.withTransaction(async (uow) => {
      const query = (text, values) => sql.query(uow, text, values);
      const membership = (await query(`
        SELECT role FROM public.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'
         LIMIT 1
      `, [workspaceId, userId])).rows[0];
      if (!membership) return null;
      const target = await loadTarget({ query, objectKind, objectId, workspaceId });
      if (!target) return null;
      const grants = (await query(`
        SELECT principal_id, role, capabilities
          FROM public.object_access_grants
         WHERE workspace_id = $1 AND object_kind = $2 AND object_id = $3
           AND principal_id = $4 AND principal_kind = 'user' AND status = 'active'
         ORDER BY grant_id ASC
      `, [workspaceId, objectKind, objectId, userId])).rows;
      return { membership, target, grants };
    });
    if (!projection) throw forbidden();
    const ownsObject = projection.target.ownerPrincipalId === userId;
    const decision = objectAccessPolicy.evaluate({
      principal: {
        principalId: userId,
        kind: "user",
        workspaceId,
        // The persisted membership is the authority. A read context may carry
        // a display role, but it must never upgrade an object's permission.
        workspaceRole: projection.membership.role,
        capabilities: Array.isArray(capabilities)
          ? capabilities
          : ownsObject
            ? AUTHORIZATION_CAPABILITIES
            : projection.grants.flatMap((grant) => Array.isArray(grant.capabilities) ? grant.capabilities : []),
      },
      target: {
        ...projection.target,
        grants: projection.grants.map((grant) => ({ principalId: grant.principal_id, role: grant.role })),
      },
      operation: "read",
    });
    if (!decision.allowed) throw forbidden();
    return true;
  };
}

async function loadTarget({ query, objectKind, objectId, workspaceId }) {
  if (objectKind === "skill_draft") {
    const row = (await query(`
      SELECT draft.skill_draft_id, asset.workspace_id, asset.owner_user_id, asset.visibility
        FROM public.skill_drafts draft
        JOIN public.skill_assets asset
          ON asset.workspace_id = draft.workspace_id AND asset.skill_id = draft.skill_id
       WHERE draft.workspace_id = $1 AND draft.skill_draft_id = $2
       LIMIT 1
    `, [workspaceId, objectId])).rows[0];
    return row ? {
      objectKind, objectId, workspaceId: row.workspace_id,
      ownerPrincipalId: row.owner_user_id, visibility: row.visibility,
    } : null;
  }
  if (objectKind === "workflow") {
    const row = (await query(`
      SELECT workspace_id, owner_user_id, visibility
        FROM public.workflows
       WHERE workspace_id = $1 AND workflow_id = $2
       LIMIT 1
    `, [workspaceId, objectId])).rows[0];
    return row ? {
      objectKind, objectId, workspaceId: row.workspace_id,
      ownerPrincipalId: row.owner_user_id, visibility: row.visibility,
    } : null;
  }
  return null;
}

function required(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("agent_object_authorization_identity_required");
  }
}
function forbidden() {
  const error = new Error("This private object is not available to the current user.");
  error.name = "ProductExecutionError";
  error.code = "agent_object_forbidden";
  error.status = "permission_denied";
  error.productSafe = true;
  return error;
}
