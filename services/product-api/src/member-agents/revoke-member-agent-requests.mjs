// Consent and capability leases are existing authorities. Call inside the
// authorizing Product command transaction; Broker remains the execution owner.
export async function revokeMemberAgentRequests(query, { workspaceId, requestIds }) {
  if (!requestIds.length) return;
  const rows = (await query(`UPDATE public.member_agent_requests
    SET consent='revoked',revision=revision+1
    WHERE workspace_id=$1 AND request_id=ANY($2::text[]) AND consent IN ('pending','accepted')
    RETURNING invocation_id`, [workspaceId, requestIds])).rows;
  const invocationIds = rows.map(row => row.invocation_id).filter(Boolean);
  if (invocationIds.length) await query(`UPDATE public.capability_leases
    SET status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND invocation_id=ANY($2::text[]) AND status='active'`, [workspaceId, invocationIds]);
}
