import { ProductStoreError } from "../store/errors.mjs";

export async function requireWorkItemRunAccess(query, { context, workItemId, write = false }) {
  const row = (await query(`SELECT grant_row.grant_id, grant_row.access_level, item.status, item.project_id
    FROM public.work_items item
    JOIN public.work_item_access_grants grant_row USING (workspace_id, work_item_id)
    JOIN public.workspace_memberships membership ON membership.workspace_id = item.workspace_id
      AND membership.user_id = grant_row.user_id AND membership.status = 'active'
    JOIN public.product_users account ON account.user_id = membership.user_id AND account.disabled = false
    WHERE item.workspace_id = $1 AND item.work_item_id = $2
      AND grant_row.user_id = $3 AND grant_row.status = 'active'
    FOR SHARE OF item, grant_row, membership`, [context.workspaceId, workItemId, context.userId])).rows[0];
  if (!row) throw new ProductStoreError("work_item_access_forbidden", "This Work Item is not available.");
  if (row.project_id) {
    const project = (await query(`SELECT project.project_id FROM public.projects project
      JOIN public.project_memberships member USING (workspace_id, project_id)
      WHERE project.workspace_id = $1 AND project.project_id = $2 AND ($4::boolean = false OR project.status = 'active')
        AND member.user_id = $3 AND member.status = 'active' FOR SHARE OF project, member`,
    [context.workspaceId, row.project_id, context.userId, write])).rows[0];
    if (!project) throw new ProductStoreError("work_item_access_forbidden", "This Project is not available.");
  }
  if (write && (!["owner", "contribute"].includes(row.access_level) || ["completed", "cancelled"].includes(row.status))) {
    throw new ProductStoreError("work_item_run_forbidden", "Reopen the Work Item or ask an authorized contributor to run this workflow.");
  }
  return row;
}

export async function attachWorkItemRun(query, { context, workItemId, run }) {
  const access = await requireWorkItemRunAccess(query, { context, workItemId, write: true });
  if (run.workspaceId !== context.workspaceId || run.requestedBy !== context.userId) {
    throw new ProductStoreError("work_item_run_forbidden", "The execution must belong to the requesting member.");
  }
  // This executes in the Run's command transaction. A failed share rolls back
  // the accepted Run; the Runner only schedules after that transaction commits.
  await query(`SET CONSTRAINTS ALL DEFERRED`);
  await query(`INSERT INTO public.work_item_workflow_runs
    (workspace_id, work_item_id, run_id, requested_by_user_id, access_grant_id, share_final_output, created_at)
    VALUES ($1, $2, $3, $4, $5, true, $6)`,
  [context.workspaceId, workItemId, run.runId, context.userId, access.grant_id, run.createdAt]);
  return { workItemId, runId: run.runId };
}

export async function listWorkItemRuns(query, { context, workItemId }) {
  await requireWorkItemRunAccess(query, { context, workItemId });
  const rows = (await query(`SELECT link.run_id, link.requested_by_user_id, link.created_at,
      run.status, run.inputs, run.updated_at, run.workflow_revision_id, workflow.name,
      workflow.source_release_id, workflow.source_release_version_id,
      output.final_answer
    FROM public.work_item_workflow_runs link
    JOIN public.workflow_runs run USING (workspace_id, run_id)
    JOIN public.workflows workflow ON workflow.workspace_id = run.workspace_id AND workflow.workflow_id = run.workflow_id
    LEFT JOIN public.workflow_run_final_outputs output ON output.workspace_id = run.workspace_id AND output.run_id = run.run_id
    WHERE link.workspace_id = $1 AND link.work_item_id = $2
    ORDER BY link.created_at DESC, link.run_id DESC LIMIT 100`, [context.workspaceId, workItemId])).rows;
  // Deliberately do not project native Session IDs, raw events, node outputs,
  // traces, resources, connection bindings or the private workflow's identifier.
  return rows.map((row) => ({
    workItemId, runId: row.run_id, requestedByUserId: row.requested_by_user_id,
    workflowName: row.name, status: row.status, inputs: row.inputs,
    sourceReleaseId: row.source_release_id ?? null,
    sourceVersionId: row.source_release_version_id ?? null,
    finalAnswer: row.status === "completed" && row.final_answer ? {
      format: row.final_answer.format, content: row.final_answer.content, createdAt: row.final_answer.createdAt,
    } : null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  }));
}
