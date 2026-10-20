import test from 'node:test';
import assert from 'node:assert/strict';
import { describeActivity, activityPhase, activitySummary } from '../../src/workbench/activity-presentation.mjs';

test('an employee can read a short operation without opening another generic disclosure', () => {
  const item = describeActivity({kind:'command',text:'核对金额 100.00 + 74.50 = 174.50'});
  assert.equal(item.title, '核对金额 100.00 + 74.50 = 174.50');
  assert.equal(item.expandable, false);
});

test('a shell command with a Chinese filename is shown as the actual command, never a fabricated business result', () => {
  const text = 'python 核对订单.py --output="待审核.xlsx"';
  const item = describeActivity({kind:'command',text});
  assert.equal(item.title, '运行命令');
  assert.equal(item.detail, text);
  assert.equal(item.text, text);
});

test('multiple changed files retain their complete paths and offer a full record', () => {
  const text = 'Outputs/销售 报告.xlsx\nOutputs/核对说明.docx';
  const item = describeActivity({kind:'file',text});
  assert.equal(item.title, '文件变更');
  assert.ok(item.detail.includes('销售 报告.xlsx') && item.detail.includes('2 个文件'));
  assert.equal(item.text, text);
  assert.ok(item.expandable);
});

test('old work is not marked live when another task runs, and failure remains distinct from completion', () => {
  assert.equal(activityPhase('running', false), 'settled');
  assert.equal(activityPhase('waiting', true), 'waiting');
  assert.equal(activityPhase('failed', true), 'failed');
  assert.equal(activityPhase('interrupted', true), 'interrupted');
});

test('the folded summary names the real action and count without claiming success', () => {
  assert.equal(activitySummary([{kind:'command',text:'读取订单'},{kind:'command',text:'核对金额'}]), '读取订单等 2 项操作');
});
