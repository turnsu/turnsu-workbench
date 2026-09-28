import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Check, LocalLoopTrialReceiptSchema } from "@turnsu/workbench-contracts";

// Real authenticated Product HTTP/PG; report contents are synthetic member
// attestations, not claims that a real provider or managed Run executed them.
export async function verifyLocalLoopTrials({ request, pool, restart, headers, memberHeaders, foreignHeaders, ownerUserId }) {
  const created = await request('/loops', { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'local-trial-target' },
    data: { name: 'Locally reviewed feedback', description: 'Private trial evidence', definition: {
      goal: 'Review feedback', context: '', constraints: [], doneWhen: [], verify: [], expectedResult: 'Reviewed summary', stopRules: [],
    } } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { workflow, revision } = created.body.data;
  const path = `/workflows/${workflow.workflowId}/local-trials`;
  const etag = (await request(`/workflows/${workflow.workflowId}`, { headers })).headers.get('etag');
  const data = { workflowRevisionId: revision.revisionId, revisionContentHash: revision.contentHash,
    localTrialId: 'trial-local-feedback-1', agentKind: 'codex', inputSummary: 'Synthetic consented feedback',
    output: 'Synthetic reviewed result: feedback needs clearer ownership.', reviewNote: 'I reviewed the selected result.',
    confirm: true, reportedCompletedAt: new Date().toISOString() };
  const submit = (body = data, extra = {}, key = 'record-local-feedback', credentials = headers) => request(path, {
    method: 'POST', headers: { ...credentials, 'Idempotency-Key': key, 'If-Match': etag, ...extra }, data: body,
  });
  const baseline = (await pool.query('SELECT status, lifecycle, latest_compile_result_id, current_revision_id, write_version FROM workflows WHERE workflow_id=$1', [workflow.workflowId])).rows[0];
  assert.equal((await submit({ ...data, confirm: false })).status, 400);
  assert.equal((await submit({ ...data, reviewedBy: 'forged-reviewer' })).status, 400);
  assert.equal((await submit({ ...data, status: 'failed' })).status, 400);
  assert.equal((await submit({ ...data, reviewNote: ' ' })).status, 400);
  assert.equal((await submit({ ...data, output: ' ' })).status, 400);
  assert.equal((await submit({ ...data, reportedCompletedAt: '2099-01-01T00:00:00.000Z' })).status, 400);
  assert.equal((await submit(data, { 'If-Match': '"stale"' })).status, 412);
  assert.equal((await submit({ ...data, revisionContentHash: `sha256:${'f'.repeat(64)}` })).status, 412);
  assert.equal((await submit(data, {}, 'non-owner', memberHeaders)).status, 404);
  assert.equal((await submit(data, {}, 'foreign-workspace', foreignHeaders)).status, 404);
  const [accepted, duplicate] = await Promise.all([submit(), submit()]);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
  assert.deepEqual(duplicate.body.data, accepted.body.data, 'simultaneous retries return one exact receipt');
  const receipt = accepted.body.data;
  assert.equal(Check(LocalLoopTrialReceiptSchema, receipt), true);
  assert.equal(receipt.reviewedBy, ownerUserId);
  assert.equal(receipt.provenance, 'member_attested_local');
  assert.equal(receipt.cloudReady, false);
  assert.equal(receipt.visibility, 'private');
  assert.equal(receipt.outputHash, `sha256:${createHash('sha256').update(data.output).digest('hex')}`);
  assert.equal(receipt.output, data.output);
  assert.equal(receipt.reviewState, 'human_reviewed');
  const rows = (await pool.query('SELECT * FROM local_loop_trial_receipts WHERE workflow_id=$1', [workflow.workflowId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reviewed_by, ownerUserId);
  assert.equal(rows[0].output, data.output);
  assert.deepEqual((await pool.query('SELECT status, lifecycle, latest_compile_result_id, current_revision_id, write_version FROM workflows WHERE workflow_id=$1', [workflow.workflowId])).rows[0], baseline);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM workflow_runs WHERE workflow_id=$1', [workflow.workflowId])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM loop_versions WHERE workflow_id=$1', [workflow.workflowId])).rows[0].count, 0);
  const publication = await request(`/loops/${workflow.workflowId}/publish`, { method: 'POST',
    headers: { ...headers, 'If-Match': etag, 'Idempotency-Key': 'attestation-does-not-publish' },
    data: { version: '1.0.0', releaseNotes: 'Must remain blocked', startingPoint: false } });
  assert.equal(publication.status, 409, JSON.stringify(publication.body));
  assert.equal(publication.body.code, 'loop_compile_required');
  assert.equal((await submit({ ...data, output: 'Changed reviewed result' })).status, 409);
  assert.equal((await submit(data, {}, 'same-local-trial-new-key')).status, 409);
  await assert.rejects(pool.query('UPDATE local_loop_trial_receipts SET output=$2 WHERE trial_id=$1', [receipt.trialId, 'changed']), /immutable_authority_history/);
  await restart();
  assert.deepEqual((await submit()).body.data, receipt, 'lost response is recoverable after service restart');
  const saved = await request(`/loops/${workflow.workflowId}/revisions`, { method: 'POST',
    headers: { ...headers, 'If-Match': etag, 'Idempotency-Key': 'edit-local-trial-target' }, data: {
      baseRevisionId: revision.revisionId, graph: revision.graph, inputForm: revision.inputForm,
      outputDefinition: revision.outputDefinition, resourceRefs: [], runSettings: revision.runSettings,
      definition: { ...revision.definition, context: 'New source material' }, saveReason: 'Keep old reviewed evidence distinct',
    } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual((await submit()).body.data, receipt, 'a receipt replay does not falsely retarget a newer revision');
  assert.equal((await submit({ ...data, localTrialId: 'trial-obsolete-revision' }, {}, 'obsolete-local-trial')).status, 412);
  assert.equal((await submit(data, {}, 'record-local-feedback', memberHeaders)).status, 404);
  assert.equal((await submit(data, {}, 'record-local-feedback', foreignHeaders)).status, 404);
  return { replay: submit, receipt };
}
