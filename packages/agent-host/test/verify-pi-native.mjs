// Run explicitly with an installed official Pi >= 0.87 binary. No model prompt is issued:
// verify the extension command exists before invoking the native interaction-only command.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { LocalAgentHost } from '../host.mjs';
import { PiConnection } from '../pi.mjs';
const binary = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), 'turnsu-native-pi-'));
const projectPath = join(root, 'project'); await mkdir(projectPath);
const extension = join(root, 'interaction.mjs');
await writeFile(extension, `export default function(pi) {
  pi.registerCommand('turnsu-native-interaction-check', { description: 'Local interaction acceptance without model execution', handler: async (_args, ctx) => {
    const value = await ctx.ui.select('Native Pi selection', ['Continue', 'Cancel']);
    const accepted = await ctx.ui.confirm('Native Pi confirmation', 'Record this local interaction result?');
    ctx.ui.notify('Native result: ' + value + '/' + accepted, 'info');
  }});
}`);
let host;
try {
  host = new LocalAgentHost({ directory: join(root, 'state'), piFactory: (options) => new PiConnection({ ...options, binary, spawnProcess: (file, args, options) => spawn(file, [...args, '--extension', extension], options) }) });
  const project = await host.command('project.open', { path: projectPath });
  const session = await host.command('session.create', { projectId: project.id, agent: 'pi' });
  const connection = await host.pi(session.id);
  const commands = await connection.request('get_commands');
  assert.ok(commands.commands.some((command) => command.name === 'turnsu-native-interaction-check'), 'Never submit an unregistered command to a model');
  const input = { sessionId: session.id, inputId: 'native-extension-only', text: '/turnsu-native-interaction-check' };
  await host.command('session.send', input);
  async function until(predicate) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await host.command('session.read', { sessionId: session.id });
      if (predicate(state)) return state;
      if (['failed', 'interrupted'].includes(state.status)) throw new Error(state.error);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Native interaction did not reach the expected state');
  }
  let state = await until((s) => s.interactions.some((i) => i.method === 'pi/select'));
  await host.command('interaction.respond', { sessionId: session.id, id: state.interactions[0].id, answers: { answer: 'Continue' } });
  state = await until((s) => s.interactions.some((i) => i.method === 'pi/confirm'));
  await host.command('interaction.respond', { sessionId: session.id, id: state.interactions[0].id, decision: 'accept' });
  state = await until((s) => s.status === 'idle');
  assert.ok(state.messages.some((m) => m.text === 'Native result: Continue/true'));
  await host.command('session.send', input);
  assert.equal((await host.command('session.read', { sessionId: session.id })).status, 'idle');
  await host.command('session.send', { ...input, inputId: 'native-cancel' });
  await until((s) => s.interactions.length > 0);
  await host.command('session.stop', { sessionId: session.id });
  state = await until((s) => s.status === 'interrupted');
  assert.equal(state.interactions.length, 0);
  console.log(JSON.stringify({ cancellation: 'passed', nativePiDialogs: 'passed', immediateCommandCompletion: 'passed', duplicateSubmission: 'passed', modelExecution: false }));
} finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
