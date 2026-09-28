/**
 * PostgreSQL read-side owner for the immutable base snapshot of a Module
 * Agent branch. It intentionally exposes neither a repository facade nor a
 * raw SQL client to the Agent runner.
 */
export function createPostgresAgentObjectBaseVersionResolver({ store } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_agent_base_version_store_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query: (uow, text, values = []) => execute(uow, { text, values }),
  }));
  return async ({ objectKind, objectId, workspaceId } = {}) => {
    required(objectKind); required(objectId); required(workspaceId);
    return store.withTransaction(async (uow) => {
      const query = (text, values) => sql.query(uow, text, values);
      if (objectKind === "workflow") {
        const row = (await query(`
          SELECT revision.*, compile.status AS compile_status, compile.warnings AS compile_warnings
            FROM public.workflows workflow
            JOIN public.workflow_revisions revision
              ON revision.workspace_id = workflow.workspace_id
             AND revision.workflow_id = workflow.workflow_id
             AND revision.revision_id = workflow.current_revision_id
            LEFT JOIN LATERAL (
              SELECT status, warnings
                FROM public.compile_results
               WHERE workspace_id = revision.workspace_id
                 AND workflow_id = revision.workflow_id
                 AND workflow_revision_id = revision.revision_id
               ORDER BY compiled_at DESC, compile_result_id DESC
               LIMIT 1
            ) compile ON true
           WHERE workflow.workspace_id = $1 AND workflow.workflow_id = $2
           LIMIT 1
        `, [workspaceId, objectId])).rows[0];
        return row ? {
          baseVersionId: row.revision_id,
          baseSnapshot: workflowRevision(row),
        } : null;
      }
      if (objectKind === "skill_draft") {
        const row = (await query(`
          SELECT * FROM public.skill_drafts
           WHERE workspace_id = $1 AND skill_draft_id = $2
           LIMIT 1
        `, [workspaceId, objectId])).rows[0];
        return row ? {
          baseVersionId: `${row.skill_draft_id}:${row.draft_revision}`,
          baseSnapshot: skillDraft(row),
        } : null;
      }
      return null;
    });
  };
}

function workflowRevision(row) {
  return {
    schemaVersion: row.schema_version,
    revisionId: row.revision_id,
    workflowId: row.workflow_id,
    revisionNumber: Number(row.revision_number),
    baseRevisionId: row.base_revision_id ?? null,
    contentHash: row.content_hash,
    graph: structuredClone(row.graph),
    inputForm: structuredClone(row.input_form),
    outputDefinition: structuredClone(row.output_definition),
    resourceRefs: structuredClone(row.resource_refs),
    runSettings: structuredClone(row.run_settings),
    ...(row.definition == null ? {} : { definition: structuredClone(row.definition) }),
    authoredBy: row.authored_by,
    saveReason: row.save_reason,
    compile: {
      status: row.compile_status ?? "blocked",
      diagnostics: structuredClone(row.compile_warnings ?? []),
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function skillDraft(row) {
  return {
    ...(row.definition ?? {}),
    schemaVersion: row.schema_version,
    skillDraftId: row.skill_draft_id,
    skillId: row.skill_id,
    baseVersionId: row.base_version_id,
    revision: Number(row.draft_revision),
    contentHash: row.content_hash,
    package: row.package_object_id ? {
      objectId: row.package_object_id,
      objectKind: row.package_object_kind,
      contentHash: row.package_object_hash,
      packageHash: row.package_hash,
    } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function required(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("agent_base_version_identity_required");
  }
}
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
