import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentHost } from '../host.mjs';
import { Manus } from '../manus.mjs';
import { publicAddress } from '../artifact-download.mjs';

const profile = { id: 'manus-test', name: 'Customer', provider: 'manus', mode: 'api_key', apiKey: 'private-test-key', accountId: 'account-1' };
async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-remote-')), directory = join(root, 'state'), path = join(root, 'project'); await mkdir(path);
  const calls = [], adapter = { check: async () => ({ identity: 'account-1' }), send: async (task, prompt, files) => { calls.push({ task, prompt, files }); return { taskId: task || 'native-1', url: 'https://manus.im/app/native-1' }; }, poll: async () => ({ state: 'completed', cursor: { event: 'one' }, events: [{ id: 'one', assistant_message: { content: '真实边界以外的受控返回' } }] }), ...overrides };
  let host;
  const create = () => { host = new LocalAgentHost({ directory }); host.remote.manusFactory = () => adapter; host.remote.configure([profile]); };
  create(); const project = await host.command('project.open', { path });
  const session = await host.command('session.create', { projectId: project.id, agent: 'manus', agentConnectionId: profile.id });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  return { get host() { return host; }, project, session, path, calls, adapter, reopen: async () => { await host.close(); create(); }, send: extra => host.command('session.send', { sessionId: session.id, inputId: 'input-1', text: '读取选定材料', references: [], materials: ['材料.txt'], allowExternal: true, ...extra }) };
}

test('external material consent, exact snapshot, deduplication and native task resume use real host persistence', async t => {
  const f = await setup(t); await writeFile(join(f.path, '材料.txt'), '中文资料 174.50');
  await assert.rejects(f.send({ allowExternal: false }), /确认/); assert.equal(f.calls.length, 0);
  await f.send(); await f.send(); assert.equal(f.calls.length, 1);
  assert.equal(Buffer.from(f.calls[0].files[0].file_data.split(',')[1], 'base64').toString(), '中文资料 174.50');
  await f.reopen();
  const resumed = await f.host.command('session.resume', { sessionId: f.session.id });
  assert.equal(resumed.native_id, 'native-1'); assert.equal(resumed.status, 'idle'); assert.equal(f.calls.length, 1);
  assert.equal(resumed.messages.filter(m => m.role === 'assistant').length, 1);
  await f.host.command('remote.refresh', { sessionId: f.session.id });
  assert.equal(f.host.readSession(f.session.id).messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(await readFile(join(f.path, '材料.txt'), 'utf8'), '中文资料 174.50');
});

test('lost remote response is never replayed or silently completed by an old stopped task', async t => {
  const f = await setup(t); await f.send({ materials: [] }); await f.host.command('remote.refresh', { sessionId: f.session.id });
  f.adapter.send = async () => { throw new Error('connection lost after dispatch'); };
  await assert.rejects(f.send({ inputId: 'followup', materials: [] }), /connection lost/);
  await f.reopen(); await f.host.command('session.resume', { sessionId: f.session.id });
  let current = f.host.readSession(f.session.id); assert.equal(current.lastSubmission.status, 'unknown'); assert.equal(current.status, 'interrupted');
  await assert.rejects(f.send({ inputId: 'again', materials: [] }), /恢复/);
  await f.host.command('remote.recover', { sessionId: f.session.id, inputId: 'followup', acknowledged: true, outcome: 'not_received' });
  current = f.host.readSession(f.session.id); assert.equal(current.status, 'idle'); assert.equal(current.lastSubmission.status, 'failed');
});

test('remote attachments cannot cross tasks and saved results never replace originals', async t => {
  const f = await setup(t, { poll: async () => ({ state: 'completed', cursor: {}, events: [{ id: 'result', assistant_message: { content: '见成果', attachments: [{ filename: '成果.txt', url: 'https://files.example.test/result' }] } }] }) });
  await writeFile(join(f.path, '成果.txt'), 'original'); await f.send({ materials: [] }); await f.host.command('remote.refresh', { sessionId: f.session.id });
  const id = f.host.readSession(f.session.id).remote.artifacts[0].id; let downloads = 0; f.host.remote.download = async () => { downloads++; return Buffer.from('中文成果'); };
  const result = await f.host.command('remote.download', { sessionId: f.session.id, artifactId: id });
  assert.equal(await readFile(join(f.path, result.path), 'utf8'), '中文成果');
  await f.host.command('remote.download', { sessionId: f.session.id, artifactId: id }); assert.equal(downloads, 1);
  const other = await f.host.command('session.create', { projectId: f.project.id, agent: 'manus', agentConnectionId: profile.id });
  await assert.rejects(f.host.command('remote.download', { sessionId: other.id, artifactId: id }), /不属于/);
  assert.equal(await readFile(join(f.path, '成果.txt'), 'utf8'), 'original');
});

test('Manus API v2 pins private interactive tasks; omitted background state never means complete', async () => {
  const calls = [];
  const manus = new Manus(profile, { fetch: async (url, options) => { calls.push({ url: String(url), ...options }); const operation = url.pathname.split('/').at(-1); const result = operation === 'task.create' ? { task_id: 'native-1' } : operation === 'task.listMessages' ? { messages: [], has_more: false } : { task: { id: 'native-1', status: 'stopped' } }; return new Response(JSON.stringify({ ok: true, ...result })); } });
  await manus.send(null, '测试'); const body = JSON.parse(calls[0].body); assert.equal(body.share_visibility, 'private'); assert.equal(body.interactive_mode, true);
  const result = await manus.poll('native-1', {}); assert.equal(result.state, 'running'); assert.equal(result.backgroundUnknown, true);
  assert.equal(calls[0].headers['x-manus-api-key'], profile.apiKey);
  await assert.rejects(manus.approve('native-1', { waiting_for_event_type: 'unknownAction' }, {}), /先查看/);
});

test('download boundary refuses private, metadata, mapped IPv4 and documentation networks', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.17.0.1','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('1.1.1.1'), true); assert.equal(publicAddress('2606:4700::1111'), true);
});

test('a late remote result cannot revive a revoked connection or publish its data',async t=>{
  let resolve;const f=await setup(t,{poll:()=>new Promise(r=>{resolve=r;})});await f.send({materials:[]});
  const pending=f.host.command('remote.refresh',{sessionId:f.session.id});await new Promise(r=>setImmediate(r));
  f.host.remote.configure([{...profile,revoked:true}]);resolve({state:'completed',cursor:{},events:[{id:'late',assistant_message:{content:'late private data'}}]});
  await assert.rejects(pending,/撤销|变化/);const state=f.host.readSession(f.session.id);assert.equal(state.status,'interrupted');assert.ok(!state.messages.some(m=>m.text.includes('late private data')));
});
