// Manual end-to-end smoke. Requires a working OpenCode model; uses only an isolated temporary project.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgentHost } from '../host.mjs';

const root = await mkdtemp(join(tmpdir(), 'turnsu-opencode-host-'));
const projectPath = join(root, 'project'); await mkdir(projectPath);
await writeFile(join(projectPath, 'source.txt'), 'The token is H7A2.\n');
const directory = join(root, 'state');
let host = new LocalAgentHost({ directory });
async function finished(sessionId) {
  let result;
  for (let index = 0; index < 240; index++) {
    result = await host.command('session.read', { sessionId });
    if (result.status === 'waiting') {
      for (const item of result.interactions || []) await host.command('interaction.respond', { sessionId, id: item.id, decision: 'accept' });
    }
    if (['idle', 'failed', 'interrupted'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('OpenCode 任务在 120 秒内未结束。');
}
try {
  const project = await host.command('project.open', { path: projectPath });
  const session = await host.command('session.create', { projectId: project.id, agent: 'opencode' });
  await host.command('session.send', {
    sessionId: session.id, inputId: 'smoke-file-task',
    text: 'Read source.txt in this project. Create result.md with one line: Token: followed by the token found in source.txt. Use only this project.',
  });
  let result = await finished(session.id);
  if (result.status !== 'idle') throw new Error(`OpenCode 文件任务未完成：${result.status} ${result.error || ''}`);
  const content = await readFile(join(projectPath, 'result.md'), 'utf8');
  if (content.trim() !== 'Token: H7A2') throw new Error(`Agent 产出的文件与源资料不符：${content.slice(0, 200)}`);
  if (result.lastSubmission?.status !== 'completed') throw new Error('工作台没有保存完成状态。');
  await host.close(); host = new LocalAgentHost({ directory });
  result = await host.command('session.read', { sessionId: session.id });
  if (result.native_id === null || result.lastSubmission?.status !== 'completed') throw new Error('工作台重开后没有保留原生会话或完成状态。');
  await host.command('session.resume', { sessionId: session.id });
  await host.command('session.send', { sessionId: session.id, inputId: 'smoke-recovery', text: 'Read result.md and reply with its only line. Do not modify files.' });
  result = await finished(session.id);
  if (result.status !== 'idle' || !result.messages.some(item => item.role === 'assistant' && item.text.includes('H7A2'))) throw new Error('工作台重开后没有从同一项目继续得到成果。');
  console.log(JSON.stringify({ agent: 'opencode', status: result.status, file: 'result.md', content: content.trim(), resumed: true }));
} finally {
  await host.close();
  await rm(root, { recursive: true, force: true });
}
