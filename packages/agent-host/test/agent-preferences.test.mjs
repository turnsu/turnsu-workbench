import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

test('personal and per-project Agent choices persist without changing existing sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu-agent-preference-'));
  const directory = join(root, 'state');
  let host = new LocalAgentHost({ directory });
  t.after(async () => { await host?.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ['one', 'two']) await mkdir(join(root, name));
  const one = await host.command('project.open', { path: join(root, 'one') });
  const two = await host.command('project.open', { path: join(root, 'two') });
  const old = await host.command('session.create', { projectId: one.id, agent: 'codex' });
  await host.command('agent.preference.save', { scope: 'personal', agentId: 'pi' });
  await host.command('agent.preference.save', { scope: 'project', projectId: one.id, agentId: 'claude' });
  assert.deepEqual((await host.command('workspace.read', { projectId: one.id })).agentPreference,
    { agentId: 'claude', source: 'project', project: 'claude', personal: 'pi' });
  assert.equal((await host.command('workspace.read', { projectId: two.id })).agentPreference.agentId, 'pi');
  assert.equal((await host.command('session.read', { sessionId: old.id })).agent, 'codex');
  await assert.rejects(host.command('agent.preference.save', { scope: 'project', projectId: 'unknown', agentId: 'pi' }), /找不到/);
  await assert.rejects(host.command('agent.preference.save', { scope: 'personal', agentId: 'unsupported' }), /尚未完成/);
  await host.close(); host = new LocalAgentHost({ directory });
  assert.equal((await host.command('agent.preference.read', { projectId: one.id })).agentId, 'claude');
  await host.command('agent.preference.save', { scope: 'project', projectId: one.id, agentId: null });
  assert.equal((await host.command('agent.preference.read', { projectId: one.id })).agentId, 'pi');
});
