import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeNativeProcess, nativeCommand } from './native-process.mjs';
import { executable } from './codex.mjs';

export function runCapability(file, args, { input = '', timeout = 120_000, maxBytes = 1_000_000, env = process.env, signal, cwd, children } = {}) {
  const launch = nativeCommand(file, args, executable('node'));
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    children?.add(child);
    let stdout = '', stderr = '', size = 0, failure;
    const stop = reason => { failure ||= reason; closeNativeProcess(child).catch(() => {}); };
    const abort = () => stop(new Error('操作已停止；请检查已有成果。'));
    const timer = setTimeout(() => stop(new Error('能力执行超时，已停止子进程。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) { const decoder = new StringDecoder('utf8'); stream.on('data', bytes => {
      size += bytes.length;
      if (size > maxBytes) { stop(new Error('工具输出超过上限。')); return; }
      if (key === 'stdout') stdout += decoder.write(bytes); else stderr += decoder.write(bytes);
    }); }
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); children?.delete(child);
      if (failure) reject(failure); else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
