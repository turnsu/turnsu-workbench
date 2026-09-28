import { ProductStoreError } from "../store/errors.mjs";
import { requireWorkflowReferences } from "./postgres-workflow-references.mjs";

/** Resolve a selected release, never the publisher's moving current revision. */
export async function loadLoopReleaseDraft({ query, workspaceId, userId, releaseId }) {
  const native = (await query(`SELECT native_loop_version_id FROM public.workspace_asset_releases
    WHERE source_workspace_id=$1 AND release_id=$2 AND visibility='workspace' FOR SHARE`, [workspaceId, releaseId])).rows[0];
  if (native?.native_loop_version_id) throw new ProductStoreError("native_loop_managed_execution_unavailable", "Use this method with your own local Agent.");
  const row = (await query(`SELECT release.release_id, release.loop_version_id,
      workflow.name, workflow.description, revision.graph, revision.input_form,
      revision.output_definition, revision.resource_refs, revision.run_settings, version.definition
    FROM public.workspace_asset_releases release
    JOIN public.loop_versions version ON version.workspace_id = release.source_workspace_id
      AND version.loop_version_id = release.loop_version_id AND version.pins_finalized = true
    JOIN public.workflows workflow ON workflow.workspace_id = version.workspace_id AND workflow.workflow_id = version.workflow_id
    JOIN public.workflow_revisions revision ON revision.workspace_id = version.workspace_id
      AND revision.workflow_id = version.workflow_id AND revision.revision_id = version.workflow_revision_id
    WHERE release.source_workspace_id = $1 AND release.release_id = $2 AND release.asset_kind = 'loop'
      AND release.visibility = 'workspace' AND workflow.visibility = 'workspace'
      AND workflow.lifecycle = 'shared' AND workflow.archived = false
    FOR SHARE OF release, version, workflow, revision`, [workspaceId, releaseId])).rows[0];
  if (!row) throw new ProductStoreError("release_not_available", "This published workflow is not available.");
  const graph = structuredClone(row.graph);
  // Personal model routes and connection bindings are not method contents.
  // Compilation resolves the consuming member's permitted configuration anew.
  for (const node of graph.nodes ?? []) {
    for (const key of ["modelProfileId", "fallbackModelProfileIds"]) delete node.configuration?.[key];
  }
  const references = await requireWorkflowReferences({ query, workspaceId, userId,
    revision: { graph, resourceRefs: row.resource_refs } });
  return {
    name: row.name, description: row.description, definition: structuredClone(row.definition),
    graph, inputForm: structuredClone(row.input_form), outputDefinition: structuredClone(row.output_definition),
    resourceRefs: references.resourceRefs,
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: row.run_settings.defaultTimeoutSeconds, workflowFallbackAllowed: false },
    sourceRelease: { releaseId, sourceWorkspaceId: workspaceId, versionId: row.loop_version_id },
  };
}
