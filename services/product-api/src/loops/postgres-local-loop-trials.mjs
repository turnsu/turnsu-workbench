import { createHash } from "node:crypto";
import { Check, RecordLocalLoopTrialDataSchema } from "@turnsu/workbench-contracts";
import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash, formatWorkflowEtag } from "../store/serialization.mjs";

/** Uses the Loop owner's transaction/clock; local reports never mutate a Run. */
export async function recordLocalLoopTrial(owner, { workflowId, workspaceId, reviewedBy, idempotencyKey, ifMatch, request } = {}) {
  const data = request?.data;
  if (![workflowId, workspaceId, reviewedBy, idempotencyKey, ifMatch].every(value => typeof value === "string" && value.length)) throw error("local_loop_trial_invalid");
  if (!Check(RecordLocalLoopTrialDataSchema, data) || !data.output.trim() || !data.reviewNote.trim()) throw error("local_loop_trial_invalid");
  const requestHash = canonicalRequestHash({ workflowId, ifMatch, request });
  const operationScope = `local-loop-trial:${workflowId}`;
  return owner.store.withTransaction(async uow => {
    const query = (text, values) => owner.sql.query(uow, text, values);
    const membership = (await query(`SELECT member.role FROM public.workspace_memberships member
      JOIN public.product_users account ON account.user_id = member.user_id
      WHERE member.workspace_id = $1 AND member.user_id = $2 AND member.status = 'active'
        AND account.disabled = false FOR SHARE OF member, account`, [workspaceId, reviewedBy])).rows[0];
    if (!membership || !["owner", "admin", "member"].includes(membership.role)) throw error("loop_creation_forbidden");
    // This lock serializes competing submissions and revision edits. Reauthorize
    // before looking up a receipt, even when the first response was lost.
    const workflow = (await query(`SELECT * FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`, [workspaceId, workflowId])).rows[0];
    if (!workflow || workflow.owner_user_id !== reviewedBy) throw error("workflow_not_found");
    const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts
      WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`,
    [workspaceId, reviewedBy, operationScope, idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) throw error("idempotency_key_reused");
      if (!existing.response) throw error("idempotency_record_incomplete");
      return structuredClone(existing.response);
    }
    const duplicate = (await query(`SELECT trial_id FROM public.local_loop_trial_receipts
      WHERE workspace_id = $1 AND reviewed_by = $2 AND local_trial_id = $3`, [workspaceId, reviewedBy, data.localTrialId])).rows[0];
    if (duplicate) throw error("local_loop_trial_exists");
    if (workflow.visibility !== "private" || workflow.archived) throw error("local_loop_trial_private_required");
    const etag = formatWorkflowEtag({ workflowId, currentRevisionId: workflow.current_revision_id, writeVersion: Number(workflow.write_version) });
    if (ifMatch !== etag || workflow.current_revision_id !== data.workflowRevisionId) throw error("workflow_revision_conflict");
    const revision = (await query(`SELECT content_hash FROM public.workflow_revisions
      WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR SHARE`, [workspaceId, workflowId, data.workflowRevisionId])).rows[0];
    if (!revision || revision.content_hash !== data.revisionContentHash) throw error("workflow_revision_conflict");
    const now = new Date(owner.clock()).toISOString();
    if (new Date(data.reportedCompletedAt).getTime() > new Date(now).getTime() + 300_000) throw error("local_loop_trial_invalid");
    const trialId = owner.idFactory("local-trial");
    const outputHash = `sha256:${createHash("sha256").update(data.output, "utf8").digest("hex")}`;
    const { confirm, ...reviewed } = data;
    const response = { trialId, workspaceId, workflowId, ...reviewed, outputHash,
      provenance: "member_attested_local", reviewState: "human_reviewed", reviewedBy,
      recordedAt: now, visibility: "private", cloudReady: false };
    await query(`INSERT INTO public.product_idempotency_receipts
      (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at)
      VALUES ($1,$2,$3,$4,$5,NULL,$6::timestamptz,NULL)`, [workspaceId, reviewedBy, operationScope, idempotencyKey, requestHash, now]);
    await query(`INSERT INTO public.local_loop_trial_receipts
      (workspace_id, trial_id, workflow_id, workflow_revision_id, revision_content_hash, local_trial_id, reviewed_by,
       agent_kind, input_summary, output, output_hash, review_note, reported_completed_at, recorded_at, request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15)`,
    [workspaceId, trialId, workflowId, data.workflowRevisionId, data.revisionContentHash, data.localTrialId, reviewedBy,
      data.agentKind, data.inputSummary, data.output, outputHash, data.reviewNote, data.reportedCompletedAt, now, requestHash]);
    await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz
      WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`,
    [workspaceId, reviewedBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
    return response;
  }).catch(cause => {
    if (cause?.code === "23505" && cause.constraint === "local_loop_trial_identity_uq") throw error("local_loop_trial_exists");
    throw cause;
  });
}
function error(code) { return new ProductStoreError(code, code); }
