import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererState, taskValues, sendsToAssistant, actionPlanError } from '../../src/intelligence-ui/task-state.mjs';

test('historical edits keep business keys and exclude generated read-only/form state', () => {
  const document = { data: { note: '原草稿', amount: '174.50' }, migration: {
    bindings: { $v0: 'note', $v1: 'amount' }, fields: [{ binding: 'note' }],
  } };
  assert.deepEqual(rendererState(document), { $v0: '原草稿', $v1: '174.50' });
  assert.deepEqual(taskValues(document, { $v0: '新草稿', $v1: '1.00', form: { label: 'ignored' } }), { note: '新草稿' });
});
test('Host confirmation cannot share a plan with edits or asynchronous actions', () => {
  for (const steps of [
    [{ type: 'set' }, { type: 'continue_conversation' }],
    [{ type: 'custom_action', name: 'ImportFiles' }, { type: 'continue_conversation' }],
    [{ type: 'open_url' }, { type: 'continue_conversation' }],
    [{ type: 'continue_conversation' }, { type: 'reset' }],
  ]) assert.match(actionPlanError({ steps }), /拆成独立步骤/);
  for (const steps of [[{ type: 'set' }, { type: 'reset' }], [{ type: 'continue_conversation' }], [{ type: 'custom_action', name: 'ImportFiles' }]])
    assert.equal(actionPlanError({ steps }), null);
});
test('local page actions remain usable after a confirmation; mixed actions cannot resend', () => {
  assert.equal(sendsToAssistant({ steps: [{ type: 'set' }] }), false);
  assert.equal(sendsToAssistant({ steps: [{ type: 'set' }, { type: 'continue_conversation' }] }), true);
  assert.equal(sendsToAssistant(undefined, true), true);
});
