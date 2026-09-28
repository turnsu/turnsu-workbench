// Result submissions point at immutable, explicitly shared entries. No private Agent context is copied.
export async function readWorkItemResults(query, workspaceId, workItemId) {
  const rows=(await query(`SELECT event.*, entry.entry_id,entry.work_thread_id,entry.sequence,entry.entry_kind,
      entry.summary,entry.handoff_id,entry.decision_id,entry.artifact_id,entry.content_hash,entry.created_by_user_id,
      entry.occurred_at,entry.payload AS entry_payload
    FROM public.work_item_lifecycle_events event
    LEFT JOIN public.work_thread_entries entry ON entry.workspace_id=event.workspace_id AND entry.work_item_id=event.work_item_id
      AND entry.entry_id=event.payload->'resultReview'->>'entryId'
    WHERE event.workspace_id=$1 AND event.work_item_id=$2 AND event.payload ? 'resultReview'
    ORDER BY event.target_revision ASC`,[workspaceId,workItemId])).rows;
  const history=[];
  for(const row of rows) {
    const event=row.payload.resultReview;
    if(event.action==='submit') history.unshift({submissionId:row.event_id,submittedByUserId:row.actor_user_id,submittedAt:new Date(row.created_at).toISOString(),status:'pending',review:null,
      entry:{entryId:row.entry_id,workItemId,workThreadId:row.work_thread_id,sequence:Number(row.sequence),kind:row.entry_kind,summary:row.summary,
        handoffId:row.handoff_id,decisionId:row.decision_id,artifactId:row.artifact_id,contentHash:row.content_hash,createdByUserId:row.created_by_user_id,
        occurredAt:new Date(row.occurred_at).toISOString(),...(row.entry_payload?.fileReferences?{fileReferences:row.entry_payload.fileReferences}:{})}});
    else if(event.action==='review') {
      const submission=history.find(item=>item.submissionId===event.submissionId);
      if(submission) {submission.status=event.decision==='accept'?'accepted':'changes_requested';submission.review={decision:event.decision,feedback:event.feedback,reviewerUserId:row.actor_user_id,reviewedAt:new Date(row.created_at).toISOString()};}
    }
  }
  return {currentSubmission:history[0]??null,history};
}
