import { ProductStoreError } from '../store/errors.mjs';
import { requireWorkItemRunAccess } from './postgres-work-item-runs.mjs';

// References never mint a grant. Evaluate the existing audience on every read
// and shared write, including retries, inside the caller's Product transaction.
export async function requireWorkItemReferenceAccess(query, { context, workItemId, targetWorkItemId }) {
  const ids = [...new Set([workItemId, targetWorkItemId])].sort();
  const roots = (await query(`SELECT work_item_id,project_id,accountable_owner_user_id
    FROM public.work_items WHERE workspace_id=$1 AND work_item_id=ANY($2::text[])
    ORDER BY work_item_id FOR SHARE`, [context.workspaceId, ids])).rows;
  for (const id of ids) await requireWorkItemRunAccess(query, { context, workItemId: id });
  const source = roots.find(row => row.work_item_id === workItemId);
  const target = roots.find(row => row.work_item_id === targetWorkItemId);
  if (!source?.project_id || source.project_id !== target?.project_id) {
    throw new ProductStoreError('work_item_reference_project_mismatch', 'References must stay within the same shared project.');
  }
  const grants = (await query(`SELECT work_item_id,user_id,status FROM public.work_item_access_grants
    WHERE workspace_id=$1 AND work_item_id=ANY($2::text[])
    ORDER BY work_item_id,user_id FOR SHARE`, [context.workspaceId, ids])).rows;
  const users = [...new Set([...roots.map(row => row.accountable_owner_user_id), ...grants.map(row => row.user_id)])].sort();
  // Lock inactive memberships/accounts too so reactivation cannot widen the
  // audience between this check and the content read/write. Project membership
  // edits already serialize on the Project row held by requireWorkItemRunAccess.
  const memberships = (await query(`SELECT member.user_id,member.status AS workspace_status,
      account.disabled,project_member.status AS project_status
    FROM public.workspace_memberships member
    JOIN public.product_users account ON account.user_id=member.user_id
    LEFT JOIN public.project_memberships project_member
      ON project_member.workspace_id=member.workspace_id AND project_member.user_id=member.user_id AND project_member.project_id=$3
    WHERE member.workspace_id=$1 AND member.user_id=ANY($2::text[])
    ORDER BY member.user_id FOR SHARE OF member,account`, [context.workspaceId, users, source.project_id])).rows;
  const active = new Set(memberships.filter(row => row.workspace_status === 'active' && row.project_status === 'active' && !row.disabled).map(row => row.user_id));
  const readers = root => new Set([root.accountable_owner_user_id, ...grants.filter(row => row.work_item_id === root.work_item_id && row.status === 'active').map(row => row.user_id)].filter(id => active.has(id)));
  const sourceReaders = readers(source);
  if ([...readers(target)].some(id => !sourceReaders.has(id))) {
    throw new ProductStoreError('work_item_reference_audience_forbidden', 'The target work has readers who cannot access this source.');
  }
}
