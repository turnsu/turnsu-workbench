import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';

// npm's Windows .cmd shims cannot be spawned with shell:false. Resolve only known CLI entries;
// never interpolate user paths, prompts or model IDs through cmd.exe.
export function nativeCommand(binary, args, nodeBinary) {
  if (!binary?.toLowerCase().endsWith('.cmd')) return { file: binary, args };
  const entries = {
    'codex.cmd': ['@openai/codex/bin/codex.js'],
    'pi.cmd': ['@mariozechner/pi-coding-agent/dist/cli.js', '@earendil-works/pi-coding-agent/dist/cli.js'],
    'claude.cmd': ['@anthropic-ai/claude-code/cli.js'],
    'opencode.cmd': ['opencode-ai/bin/opencode.exe'],
  }[basename(binary).toLowerCase()];
  const entry = entries?.map(p => join(dirname(binary), 'node_modules', p)).find(p => existsSync(p));
  if (entry?.toLowerCase().endsWith('.exe')) return { file: entry, args, entry };
  if (!entry || !nodeBinary) throw new Error('无法启动这个 Windows CLI，请检查 Node.js 与原生 Agent 的安装。');
  return { file: nodeBinary, args: [entry, ...args], entry };
}

async function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    child.once('exit', done); timer = setTimeout(done, timeout);
  });
}
export async function closeNativeProcess(child) {
  // Do not signal an old numeric PID after an already-observed exit; it may have been reused.
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (child.exitCode === null && child.signalCode === null) { child.stdin?.end(); await waitForExit(child, 1200); }
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve()));
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGTERM'); }
    await waitForExit(child, 700);
    // A tool descendant can outlive its parent. Each owned CLI has a separate process group.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
  await waitForExit(child, 700);
}
