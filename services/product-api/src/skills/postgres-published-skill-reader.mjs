import { projectPublishedSkillVersion } from "./published-skill-definition.mjs";

/** Exact immutable publication, joined to its approved execution binding. */
export async function readPinnedSkillVersion({ query, workspaceId, ref }) {
  const row = (await query(`SELECT version.*, COALESCE(asset.owner_user_id, asset.owner_system_principal_id) AS owner_user_id, asset.visibility, asset.lifecycle,
      asset.latest_published_version_id,
      EXISTS (SELECT 1 FROM public.workspace_asset_releases release
        WHERE release.source_workspace_id = version.workspace_id AND release.asset_kind = 'skill'
          AND release.skill_id = version.skill_id AND release.skill_version_id = version.skill_version_id
          AND release.content_hash = version.content_hash AND release.visibility = 'workspace') AS workspace_released,
      binding.capability_id, binding.task_intent, binding.adapter_version, binding.execution_mode,
      validation.status AS validation_status, validation.completed_at AS validation_completed_at,
      validation.diagnostics AS validation_diagnostics, validation.primary_test_run_id,
      upload.payload AS upload_payload, source.execution_ref AS source_execution_ref
    FROM public.skill_versions version
    JOIN public.skill_assets asset ON asset.workspace_id = version.workspace_id AND asset.skill_id = version.skill_id
    LEFT JOIN public.skill_execution_bindings binding ON binding.workspace_id = version.workspace_id
      AND binding.execution_binding_id = version.execution_binding_id
    LEFT JOIN public.skill_validations validation ON validation.workspace_id = version.workspace_id
      AND validation.validation_id = version.validation_id
    LEFT JOIN public.upload_sessions upload ON upload.workspace_id = binding.workspace_id AND upload.upload_id = binding.upload_id
    LEFT JOIN public.skill_system_catalog_sources source ON source.workspace_id = version.workspace_id
      AND source.catalog_source_id = version.system_catalog_source_id
    WHERE version.workspace_id = $1 AND version.skill_id = $2 AND version.version = $3
    FOR SHARE OF version, asset`, [workspaceId, ref?.skillId, ref?.version])).rows[0];
  if (!row) return null;
  const executionRef = row.capability_id ? {
    capabilityId: row.capability_id, taskIntent: row.task_intent,
    adapterVersion: row.adapter_version, executionMode: row.execution_mode,
  } : structuredClone(row.source_execution_ref);
  const definition = row.definition ?? {};
  const version = {
    schemaVersion: row.schema_version, workspaceId: row.workspace_id,
    skillId: row.skill_id, skillVersionId: row.skill_version_id, version: row.version,
    packageObjectId: row.package_object_id, packageHash: row.package_hash, contentHash: row.content_hash,
    manifest: structuredClone(row.upload_payload?.inspection?.manifest ?? definition.manifest ?? {}),
    ...Object.fromEntries(["name", "description", "category", "inputSchema", "outputSchema", "risk", "dependencies", "connectionRequirements"]
      .map((key) => [key, structuredClone(definition[key])])),
    validation: row.validation_status ? {
      validationId: row.validation_id, status: row.validation_status,
      diagnostics: structuredClone(row.validation_diagnostics ?? []),
      testedAt: new Date(row.validation_completed_at).toISOString(),
      ...(row.primary_test_run_id ? { testRunIds: [row.primary_test_run_id] } : {}),
    } : structuredClone(definition.validation),
    executionRef, publishedBy: row.published_by_user_id ?? row.published_by_system_principal_id,
    publishedAt: new Date(row.published_at).toISOString(),
  };
  return {
    definition: projectPublishedSkillVersion(version), version,
    ownerId: row.owner_user_id, visibility: row.visibility, lifecycle: row.lifecycle,
    latestPublishedVersionId: row.latest_published_version_id,
    workspaceReleaseVersionId: row.workspace_released ? row.skill_version_id : null,
    toolActions: (row.upload_payload?.inspection?.manifest?.tools ?? []).map((tool) => tool.action),
  };
}
