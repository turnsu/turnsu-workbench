import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalAgentHost } from '../host.mjs';

// Real SQLite/HTTP/PostgreSQL; Pi transport is controlled, no provider inference.
export async function verifyCrossWorkDesktop({ directory, owner, member, memberUserId }) {
  const call = async (name, input) => owner.fileCall(await owner.identity(), name, input);
  const project = await owner.desktopCall(await owner.identity(), 'createProject', { idempotencyKey: randomUUID(), data: { title: '跨工作资料复用', objective: '在相同成员范围内接续', members: [{ userId: memberUserId }] } });
  const members = [{ userId: memberUserId, access: 'contribute', roles: ['participant'] }];
  async function create(title) { return (await call('turnsu_create_work', { idempotencyKey: randomUUID(), data: { projectId: project.data.projectId, title, objective: title, summary: title, members } })).data.workItemId; }
  const source = await create('已完成的反馈分析'), target = await create('本周改进计划');
  await call('turnsu_submit_update', { pathParams: { workItemId: source }, idempotencyKey: randomUUID(), data: { content: '来源结论：先解决重启恢复问题。' } });
  await call('turnsu_record_decision', { pathParams: { workItemId: source }, idempotencyKey: randomUUID(), data: { question: '验收优先项', options: ['保留草稿'], chosenOutcome: '保留草稿', rationale: '防止重复工作' } });
  const path = join(directory, 'cross-work-desktop'), state = join(directory, 'cross-work-desktop-state'); await mkdir(path);
  const prompts = [], deliveries = []; let offline = false, host;
  function open() {
    host = new LocalAgentHost({ directory: state, piFactory: () => ({ ready: Promise.resolve(), closed: false, close: async () => {}, async request(method, args) {
      if (method === 'get_messages') return { messages: [] };
      if (method === 'get_state') return { isStreaming: true, isCompacting: false, pendingMessageCount: 0 };
      if (method === 'prompt') { prompts.push(args.message); return {}; }
      throw new Error('unexpected ' + method);
    } }) });
    host.cloud = { identity: (...args) => member.identity(...args), viewer: (...args) => member.viewer(...args), close: async () => {}, async fileCall(...args) {
      if (offline) throw Object.assign(new Error('offline'), { code: 'product_client_transport_failed' });
      if (args[1] === 'turnsu_submit_update') deliveries.push(structuredClone(args[2]));
      return member.fileCall(...args);
    } };
    if (host.shared) host.shared.cloud = host.cloud;
    if (host.work) host.work.cloud = host.cloud;
  }
  async function reviseSource(next) {
    const before = await call('turnsu_work_context', { pathParams: { workItemId: source } });
    return call('turnsu_update_work', { pathParams: { workItemId: source }, ifMatch: before.etag, idempotencyKey: randomUUID(), data: { members: next } });
  }
  async function finish(id, text, timestamp) { host.onPiEvent(id, { type: 'message_end', message: { role: 'assistant', timestamp, content: [{ type: 'text', text }] } }); host.onPiEvent(id, { type: 'agent_settled' }); await host.work.flush(id); }
  open();
  try {
    const local = await host.command('project.open', { path }); await host.command('sync.attach', { projectId: local.id, remoteId: project.data.projectId }); await host.command('sync.pause', { projectId: local.id });
    const task = await host.command('work.continue', { projectId: local.id, workItemId: target, agent: 'pi', requestId: randomUUID() });
    const sources = await host.command('references.sources', { sessionId: task.id }); assert.ok(sources.items.some(item => item.workItemId === source));
    const listed = await host.command('references.list', { sessionId: task.id, sourceWorkItemId: source });
    const choose = ({ text, byteLength, ...value }) => value;
    const references = [choose(listed.entries.find(item => item.text.includes('来源结论'))), choose(listed.decisions[0])];
    await host.command('draft.save', { projectId: local.id, sessionId: task.id, text: '依据引用整理改进计划', references });
    await host.close(); open();
    await host.command('session.send', { sessionId: task.id, inputId: 'cross-desktop-online', text: '依据引用整理改进计划', references });
    assert.match(prompts[0], /来源结论：先解决重启恢复问题/); assert.match(prompts[0], /保留草稿/);
    assert.deepEqual(deliveries[0].data.sourceWorkItemIds, [source]);
    await finish(task.id, '在线改进计划：先保留草稿。', 1);
    offline = true;
    await assert.rejects(host.command('session.send', { sessionId: task.id, inputId: 'cross-desktop-offline', text: '继续用原资料整理', references }));
    await host.command('session.send', { sessionId: task.id, inputId: 'cross-desktop-offline', text: '继续用原资料整理', references, continueOffline: true });
    await finish(task.id, '离线改进计划仍保留原资料约束。', 2);
    await host.close(); open(); assert.equal(host.work.state(task.id).pending, 2);
    const queued = host.db.prepare('SELECT input_id,source_work_ids FROM shared_work_outbox WHERE sent_at IS NULL ORDER BY rowid').all();
    queued.forEach(row => assert.deepEqual(JSON.parse(row.source_work_ids), [source]));
    await reviseSource([]); offline = false;
    await host.command('work.retry', { sessionId: task.id }); assert.equal(host.work.state(task.id).pending, 2);
    let visible = await call('turnsu_work_updates', { pathParams: { workItemId: target } }); assert.ok(!visible.data.some(item => item.summary.includes('离线改进计划')));
    assert.equal(prompts.length, 2, 'permission failure never reruns Pi');
    await reviseSource(members); await host.command('work.retry', { sessionId: task.id }); assert.equal(host.work.state(task.id).pending, 0);
    visible = await call('turnsu_work_updates', { pathParams: { workItemId: target } }); assert.equal(visible.data.filter(item => item.summary.includes('离线改进计划')).length, 1);
    assert.equal(prompts.length, 2);
    await host.command('session.send', { sessionId: task.id, inputId: 'cross-desktop-followup', text: '接着做下一步', references: [] });
    assert.deepEqual(deliveries.at(-1).data.sourceWorkItemIds, [source]);
    await finish(task.id, '后续答复继续受来源范围约束。', 3);
  } finally { await host.close(); }
}
