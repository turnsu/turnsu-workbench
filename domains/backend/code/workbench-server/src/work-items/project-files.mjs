import { createHash } from 'node:crypto';
import { ProductStoreError } from '../store/errors.mjs';
export const projectFileError = code => new ProductStoreError(code, code);
export const PROJECT_FILE_MAX_BYTES = 8 * 1024 * 1024;

export function prepareProjectFile(data) {
  if (!data || typeof data.path !== 'string' || data.path.length > 512 || !data.path || data.path !== data.path.normalize('NFC')) throw projectFileError('project_file_path_invalid');
  const parts = data.path.split('/');
  if (parts.some(p => !p || p.length > 128 || p.startsWith('.') || /[\\\x00-\x1f\x7f:<>"|?*]/u.test(p) || /[. ]$/u.test(p)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))) throw projectFileError('project_file_path_invalid');
  if (typeof data.contentBase64 !== 'string' || data.contentBase64.length > 11184812 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data.contentBase64)) throw projectFileError('project_file_content_invalid');
  const bytes = Buffer.from(data.contentBase64, 'base64');
  if (bytes.length > PROJECT_FILE_MAX_BYTES || bytes.toString('base64') !== data.contentBase64) throw projectFileError('project_file_content_invalid');
  if (typeof data.mediaType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(data.mediaType)) throw projectFileError('project_file_content_invalid');
  if (data.baseRevisionId !== null && (typeof data.baseRevisionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(data.baseRevisionId))) throw projectFileError('project_file_revision_invalid');
  if (data.deleted !== undefined && typeof data.deleted !== 'boolean') throw projectFileError('project_file_content_invalid');
  const deleted = data.deleted === true;
  if (deleted && (!data.baseRevisionId || data.contentBase64 !== '')) throw projectFileError('project_file_revision_invalid');
  const resolvesRevisionIds = data.resolvesRevisionIds || [];
  if (!Array.isArray(resolvesRevisionIds) || resolvesRevisionIds.length > 16 || new Set(resolvesRevisionIds).size !== resolvesRevisionIds.length || resolvesRevisionIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) throw projectFileError('project_file_revision_invalid');
  const hash = createHash('sha256').update(bytes).digest('hex');
  return { deleted, path: data.path, pathKey: data.path.toLowerCase(), baseRevisionId: data.baseRevisionId, mediaType: data.mediaType,
    bytes, resolvesRevisionIds, contentHash: `sha256:${hash}`, objectId: `project-file-${hash}` };
}
export function publicProjectFile(row) {
  return { deleted: row.deleted === true, revisionId: row.revision_id, projectId: row.project_id, path: row.path,
    baseRevisionId: row.base_revision_id, contentHash: row.content_hash, byteLength: Number(row.byte_length),
    mediaType: row.media_type, outcome: row.outcome, createdByUserId: row.created_by_user_id,
    createdAt: new Date(row.created_at).toISOString() };
}

export async function commitProjectFileRows({ query, objectStore, workspaceId, projectId, userId, prepared, revisionId, commandId, now }) {
  const current = (await query(`SELECT revision.* FROM public.project_file_heads head JOIN public.project_file_revisions revision
    ON revision.workspace_id=head.workspace_id AND revision.revision_id=head.revision_id
    WHERE head.workspace_id=$1 AND head.project_id=$2 AND head.path_key=$3`, [workspaceId, projectId, prepared.pathKey])).rows[0];
  if (current && current.path !== prepared.path) throw projectFileError('project_file_path_collision');
  if (prepared.baseRevisionId && !(await query(`SELECT revision_id FROM public.project_file_revisions
    WHERE workspace_id=$1 AND project_id=$2 AND path_key=$3 AND revision_id=$4`, [workspaceId, projectId, prepared.pathKey, prepared.baseRevisionId])).rows.length) throw projectFileError('project_file_revision_invalid');
  const outcome = (current?.revision_id || null) === prepared.baseRevisionId ? 'synced' : 'conflict';
  for (const id of prepared.resolvesRevisionIds) {
    if (!(await query(`SELECT revision_id FROM public.project_file_revisions WHERE workspace_id=$1 AND project_id=$2 AND path_key=$3 AND revision_id=$4 AND outcome='conflict'`, [workspaceId, projectId, prepared.pathKey, id])).rows.length) throw projectFileError('project_file_revision_invalid');
  }
  const stored = await objectStore.put({ workspaceId, objectId: prepared.objectId, bytes: prepared.bytes, contentHash: prepared.contentHash, mediaType: prepared.mediaType, state: 'quarantined', metadata: { source: 'project_file' } });
  await objectStore.promote({ workspaceId, objectId: prepared.objectId });
  await query(`INSERT INTO public.product_objects(workspace_id,object_id,schema_version,object_kind,content_hash,size_bytes,media_type,storage_backend,storage_key,storage_version,state,created_at,payload)
    VALUES($1::text,$2::text,'workbench-v1','project_file_content',$3::text,$4::bigint,$5::text,'governed_object_store',$2::text,$3::text,'promoted',$6::timestamptz,'{}'::jsonb)
    ON CONFLICT(workspace_id,object_id) DO NOTHING`, [workspaceId, prepared.objectId, prepared.contentHash, prepared.bytes.length, stored.mediaType, now]);
  const row = (await query(`INSERT INTO public.project_file_revisions(workspace_id,project_id,revision_id,path,path_key,base_revision_id,object_id,content_hash,byte_length,media_type,outcome,created_by_user_id,product_command_id,created_at,deleted)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15) RETURNING *`,
    [workspaceId, projectId, revisionId, prepared.path, prepared.pathKey, prepared.baseRevisionId, prepared.objectId, prepared.contentHash, prepared.bytes.length, prepared.mediaType, outcome, userId, commandId, now, prepared.deleted])).rows[0];
  if (outcome === 'synced') {
    if (current) await query(`UPDATE public.project_file_heads SET revision_id=$4 WHERE workspace_id=$1 AND project_id=$2 AND path_key=$3`, [workspaceId, projectId, prepared.pathKey, revisionId]);
    else await query(`INSERT INTO public.project_file_heads(workspace_id,project_id,path_key,revision_id) VALUES($1,$2,$3,$4)`, [workspaceId, projectId, prepared.pathKey, revisionId]);
    for (const id of prepared.resolvesRevisionIds) await query(`INSERT INTO public.project_file_conflict_resolutions(workspace_id,project_id,path_key,conflict_revision_id,resolution_revision_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,conflict_revision_id) DO NOTHING`, [workspaceId, projectId, prepared.pathKey, id, revisionId]);
  }
  return { revision: publicProjectFile(row), headRevisionId: outcome === 'synced' ? revisionId : current.revision_id };
}

// Reused by file reads/writes and shared comment references; membership stays Product-owned.
export async function requireProjectFileAccess(query, projectId, context, write = false) {
  const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE`, [context.workspaceId, context.userId])).rows[0];
  if (!membership || (write && membership.role === 'viewer')) throw projectFileError('project_file_forbidden');
  const project = (await query(`SELECT project.* FROM public.projects project
    WHERE project.workspace_id=$1 AND project.project_id=$2 AND ($3::boolean OR EXISTS (
      SELECT 1 FROM public.project_memberships member WHERE member.workspace_id=project.workspace_id
        AND member.project_id=project.project_id AND member.user_id=$4 AND member.status='active'))
    FOR UPDATE OF project`, [context.workspaceId, projectId, ['owner', 'admin'].includes(membership.role), context.userId])).rows[0];
  if (!project) throw projectFileError('project_file_forbidden');
  if (write && project.status !== 'active') throw projectFileError('project_file_archived');
  return project;
}

export async function resolveWorkFileReferences(query, projectId, revisionIds, context) {
  if (!revisionIds?.length) return [];
  if (!projectId) throw projectFileError('project_file_revision_invalid');
  await requireProjectFileAccess(query, projectId, context);
  const rows = (await query(`SELECT revision_id,project_id,path,content_hash,byte_length FROM public.project_file_revisions
    WHERE workspace_id=$1 AND project_id=$2 AND revision_id=ANY($3::text[]) AND outcome='synced' AND deleted=false`, [context.workspaceId, projectId, revisionIds])).rows;
  if (rows.length !== revisionIds.length) throw projectFileError('project_file_revision_invalid');
  return revisionIds.map(id => { const row = rows.find(row => row.revision_id === id); return {
    revisionId: row.revision_id, projectId: row.project_id, path: row.path, contentHash: row.content_hash, byteLength: Number(row.byte_length),
  }; });
}
