import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCommand } from '../native-process.mjs';

test('Windows npm CLI entry preserves spaced paths and metacharacter arguments without a shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'turnsu 中文 CLI ')); t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'node_modules/@openai/codex/bin/codex.js'); await mkdir(join(root, 'node_modules/@openai/codex/bin'), { recursive: true }); await writeFile(entry, '// installed npm CLI fixture');
  const args = ['app-server', '-c', 'model="name & with spaces"'];
  assert.deepEqual(nativeCommand(join(root, 'codex.cmd'), args, 'C:\\Program Files\\nodejs\\node.exe'), { file: 'C:\\Program Files\\nodejs\\node.exe', args: [entry, ...args], entry });
  assert.throws(() => nativeCommand(join(root, 'unknown.cmd'), [], 'node.exe'), /无法启动/);
  assert.throws(() => nativeCommand(join(root, 'codex.cmd'), [], null), /无法启动/);
});
