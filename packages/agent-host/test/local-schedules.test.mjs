import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentHost } from '../host.mjs';
import { nextOccurrence, validateTiming } from '../local-schedules.mjs';

test('daily schedules skip nonexistent DST wall times and never repeat the fallback hour', () => {
  const t = validateTiming({ kind: 'daily', timezone: 'America/New_York', hour: 2, minute: 30 });
  assert.equal(new Date(nextOccurrence(t, Date.parse('2026-03-08T05:00:00Z')).at).toISOString(), '2026-03-09T06:30:00.000Z');
  t.hour = 1;
  const first = nextOccurrence(t, Date.parse('2026-11-01T04:00:00Z'));
  assert.equal(new Date(first.at).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(nextOccurrence(t, first.at, first.key).at).toISOString(), '2026-11-02T06:30:00.000Z');
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-schedules-')), directory = join(root, 'state'), path = join(root, 'project');
  await mkdir(path);
  let now = Date.parse('2026-09-30T00:00:00Z'), sent = 0, host;
  const create = () => new LocalAgentHost({ directory, clock: () => now, kimiFactory: options => ({ ready: Promise.resolve(), sessionId: options.sessionId || 'native', models: [], send: async () => { sent++; }, close: async () => {} }) });
  host = create();
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const project = await host.command('project.open', { path });
  return { get host() { return host; }, get now() { return now; }, set now(v) { now = v; }, get sent() { return sent; }, project,
    reopen: async () => { await host.close(); host = create(); },
    save: more => host.command('schedules.save', { projectId: project.id, name: '整理资料', agent: 'kimi', prompt: '读取资料并写入新文件', references: [], acknowledge: true, misfire: 'skip', timing: { kind: 'interval', timezone: 'Asia/Shanghai', startAt: now + 60_000, minutes: 5 }, ...more }) };
}

test('a claimed task survives restart without sending again, and uncertain work blocks the next run', async t => {
  const ctx = await setup(t); await ctx.save(); ctx.now += 60_000;
  await Promise.all([ctx.host.schedules.tick(), ctx.host.schedules.tick()]);
  assert.equal(ctx.sent, 1);
  const run = ctx.host.schedules.list().items[0].runs[0]; assert.ok(run.session_id);
  await ctx.reopen(); await ctx.host.schedules.tick();
  assert.equal(ctx.sent, 1); assert.equal(ctx.host.schedules.list().items[0].runs[0].status, 'uncertain');
  ctx.now += 300_000; await ctx.host.schedules.tick();
  assert.equal(ctx.sent, 1); assert.equal(ctx.host.schedules.list().items[0].runs[0].status, 'skipped_busy');
  await ctx.host.command('schedules.resolve', { runId: run.id, acknowledged: true });
  ctx.now += 300_000; await ctx.host.schedules.tick(); assert.equal(ctx.sent, 2);
});

test('missed tasks skip by default; latest policy runs only one occurrence and manual requests are idempotent', async t => {
  const ctx = await setup(t); const plan = await ctx.save(); ctx.now += 20 * 60_000;
  await ctx.host.schedules.tick(); assert.equal(ctx.sent, 0);
  assert.equal(ctx.host.schedules.list().items[0].runs[0].status, 'skipped');
  await ctx.host.command('schedules.run', { id: plan.id, requestId: 'run-once' });
  await ctx.host.command('schedules.run', { id: plan.id, requestId: 'run-once' });
  assert.equal(ctx.sent, 1);
});

test('scheduled execution requires consent and a valid timezone', async t => {
  const ctx = await setup(t);
  await assert.rejects(ctx.save({ acknowledge: false }), /确认后台/);
  await assert.rejects(ctx.save({ timing: { kind: 'daily', hour: 12, minute: 0, timezone: 'wrong' } }), /时区/);
  assert.equal(ctx.host.schedules.list().items.length, 0);
});

test('changed tool scope pauses before dispatch; explicit approval keeps the original run and does not grant later widening', async t => {
  const ctx = await setup(t); const plan = await ctx.save();
  const image = 'sha256:' + 'a'.repeat(64);
  ctx.host.db.prepare("INSERT INTO capability_packages VALUES('documents','1.0.0','enabled',?,NULL)").run(JSON.stringify({ image }));
  await ctx.host.capabilities.grant({ projectId: ctx.project.id, reads: ['.'], output: 'Outputs', hours: 1, acknowledged: true });
  ctx.now += 60_000; await ctx.host.schedules.tick();
  let run = ctx.host.schedules.list().items.find(item => item.id === plan.id).runs[0];
  assert.equal(run.status, 'waiting'); assert.equal(ctx.sent, 0);
  assert.equal(ctx.host.resourceUsage().local,0,'approval waiting has no native process and must not consume an execution slot');
  await ctx.reopen(); await ctx.host.schedules.tick(); assert.equal(ctx.sent, 0);
  const review = await ctx.host.command('schedules.review', {runId:run.id});
  await assert.rejects(ctx.host.command('schedules.approve', {runId:run.id,acknowledged:true,reviewHash:'stale'}), /变化/);
  await ctx.host.command('schedules.approve', { runId: run.id, acknowledged: true,reviewHash:review.reviewHash }); assert.equal(ctx.sent, 1);
  ctx.host.schedules.assertTool(run.session_id, 'documents');
  await ctx.host.capabilities.revoke(ctx.project.id);
  assert.throws(() => ctx.host.schedules.assertTool(run.session_id, 'documents'), /变化/);
  await assert.rejects(ctx.host.command('schedules.approve', { runId: run.id, acknowledged: true }), /核对/);
  assert.equal(ctx.sent, 1);
});

test('latest missed policy admits one current snapshot and an edit cannot rewrite its pinned task', async t => {
  const ctx = await setup(t); const plan = await ctx.save({ misfire: 'latest' }); ctx.now += 20 * 60_000;
  await ctx.host.schedules.tick(); assert.equal(ctx.sent, 1);
  const before = ctx.host.schedules.list().items[0], run = before.runs[0]; assert.equal(before.runs.length, 1);
  await ctx.save({ id: plan.id, revision: before.revision, prompt: 'changed future task' });
  assert.equal(JSON.parse(ctx.host.db.prepare('SELECT spec FROM local_schedule_runs WHERE id=?').get(run.id).spec).prompt, '读取资料并写入新文件');
  assert.equal(ctx.host.schedules.list().items[0].spec.prompt, 'changed future task');
});

test('a changed pinned Skill stops before any native Agent turn', async t => {
  const ctx=await setup(t), folder=join(ctx.host.project(ctx.project.id).path,'.agents','skills','orders');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),'---\nname: orders\ndescription: 核对订单\n---\n只读材料。');
  const skill=await ctx.host.projectSkills.read({projectId:ctx.project.id,agent:'kimi',path:'.agents/skills/orders/SKILL.md'});
  await ctx.save({skill:{path:skill.path,expectedHash:skill.hash}});
  await writeFile(join(folder,'SKILL.md'),'---\nname: orders\n---\n修改后的另一套方法。');
  ctx.now+=60_000;await ctx.host.schedules.tick();
  assert.equal(ctx.sent,0);const run=ctx.host.schedules.list().items[0].runs[0];assert.equal(run.status,'failed');assert.match(run.error,/修改/);
});
