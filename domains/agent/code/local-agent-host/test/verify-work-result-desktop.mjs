import assert from 'node:assert/strict';

// Real native-auth Product HTTP/PG and public desktop commands; only Pi inference is controlled
// by the parent fixture. This never uses or changes a real user's model account.
export async function verifyWorkResultDesktop({ a, b, owner, member }) {
  const parent = await a.host.command('work.start', { projectId: a.local.id, agent: 'codex', description: '成果验收：让同事按反馈改进已共享的分类结果', requestId: 'desktop-result-parent' });
  const workItemId = a.host.work.state(parent.id).workItemId;
  const memberScope = { projectId: b.local.id, workItemId }, ownerScope = { projectId: a.local.id, workItemId };
  const task = await b.host.command('work.continue', { ...memberScope, agent: 'pi' });
  const before = b.requests.filter(call => call.method === 'prompt').length;
  async function answer(inputId, input, output, timestamp) {
    await b.host.command('session.send', { sessionId: task.id, inputId, text: input });
    b.host.onPiEvent(task.id, { type: 'message_end', message: { role: 'assistant', timestamp, content: [{ type: 'text', text: output }] } });
    b.host.onPiEvent(task.id, { type: 'agent_settled' }); await b.host.work.flush(task.id);
    const context = await b.host.command('work.read', memberScope);
    const entry = context.entries.find(item => item.summary.includes(output)); assert.ok(entry);
    return { context, entry };
  }
  const first = await answer('result-round-one', '给出分类成果。', '第一版成果：体验与稳定性两类。', 11);
  const submitted = { ...memberScope, actionId: 'desktop-result-submit', kind: 'submit', entryId: first.entry.entryId, contentHash: first.entry.contentHash, etag: first.context.etag, confirm: true };
  const memberCall = member.desktopCall.bind(member); let lose = true, requests = [];
  member.desktopCall = async (...args) => { const response = await memberCall(...args); if (args[1] === 'submitWorkItemResult') { requests.push(structuredClone(args[2])); if (lose) { lose = false; throw new Error('submission committed but acknowledgement lost'); } } return response; };
  await assert.rejects(b.host.command('work.result.submit', submitted), /尚未确认/);
  assert.equal((await b.host.command('work.result.state', memberScope)).actions.length, 1);
  await b.host.command('work.result.submit', { ...memberScope, actionId: submitted.actionId, kind: 'submit', confirm: true, retry: true });
  member.desktopCall = memberCall;
  assert.deepEqual(requests[0], requests[1]);
  let waiting = await a.host.command('work.read', ownerScope), current = waiting.resultReview.currentSubmission;
  assert.equal(waiting.workItem.status, 'waiting_review'); assert.equal(waiting.resultReview.history.length, 1);
  assert.equal(current.entry.entryId, first.entry.entryId); assert.equal(current.entry.summary, first.entry.summary);
  const feedback = '请补充缺失能力分类，并逐项给出下一步。';
  await a.host.command('work.result.submit', { ...ownerScope, actionId: 'desktop-result-changes', kind: 'request_changes', entryId: current.entry.entryId, contentHash: current.entry.contentHash, submissionId: current.submissionId, etag: waiting.etag, feedback, confirm: true });
  const changed = await b.host.command('work.read', memberScope);
  assert.equal(changed.workItem.status, 'active'); assert.equal(changed.workItem.nextAction, feedback);
  assert.equal(changed.resultReview.currentSubmission.review.feedback, feedback);
  const second = await answer('result-round-two', '根据负责人的验收意见改进结果。', '修订成果：体验、稳定性和缺失能力，每类均附下一步。', 12);
  assert.ok(b.requests.filter(call => call.method === 'prompt').at(-1).params.message.includes(feedback));
  await b.host.command('work.result.submit', { ...memberScope, actionId: 'desktop-result-resubmit', kind: 'submit', entryId: second.entry.entryId, contentHash: second.entry.contentHash, etag: second.context.etag, confirm: true });
  // The owner cannot reuse their old view to accept a new version accidentally.
  await assert.rejects(a.host.command('work.result.submit', { ...ownerScope, actionId: 'desktop-result-stale', kind: 'accept', entryId: current.entry.entryId, contentHash: current.entry.contentHash, submissionId: current.submissionId, etag: waiting.etag, feedback: '', confirm: true }), /已更新/);
  waiting = await a.host.command('work.read', ownerScope); current = waiting.resultReview.currentSubmission;
  const accept = { ...ownerScope, actionId: 'desktop-result-accept', kind: 'accept', entryId: current.entry.entryId, contentHash: current.entry.contentHash, submissionId: current.submissionId, etag: waiting.etag, feedback: '已核对三类及对应行动。', confirm: true };
  const ownerCall = owner.desktopCall.bind(owner); lose = true; requests = [];
  owner.desktopCall = async (...args) => { const response = await ownerCall(...args); if (args[1] === 'reviewWorkItemResult') { requests.push(structuredClone(args[2])); if (lose) { lose = false; throw new Error('acceptance committed but acknowledgement lost'); } } return response; };
  await assert.rejects(a.host.command('work.result.submit', accept), /尚未确认/);
  await a.host.command('work.result.submit', { ...ownerScope, actionId: accept.actionId, kind: 'accept', confirm: true, retry: true });
  owner.desktopCall = ownerCall; assert.deepEqual(requests[0], requests[1]);
  const completed = await b.host.command('work.read', memberScope);
  assert.equal(completed.workItem.status, 'completed'); assert.equal(completed.resultReview.history.length, 2);
  assert.equal(completed.resultReview.currentSubmission.status, 'accepted');
  assert.equal(completed.resultReview.currentSubmission.entry.entryId, second.entry.entryId);
  await assert.rejects(b.host.command('session.send', { sessionId: task.id, inputId: 'after-acceptance', text: '不能无提示地继续已结束的工作' }), /已经结束/);
  assert.equal(b.requests.filter(call => call.method === 'prompt').length, before + 2, 'submit/review/retry never invokes an Agent');
}
