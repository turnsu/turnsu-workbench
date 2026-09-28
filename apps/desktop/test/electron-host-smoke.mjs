// Run with: electron test/electron-host-smoke.mjs. No renderer, account or real model is used.
import { app, safeStorage, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostClient } from '../electron/host-client.mjs';
import { ConnectionVault } from '../electron/connection-vault.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'turnsu-electron-'));
app.setPath('userData', join(temp, 'browser'));
app.whenReady().then(async () => {
let host, server;
try {
  const directory = join(temp, 'state'); await mkdir(directory, { mode: 0o700 });
  const projectPath = join(temp, '真实项目'); await mkdir(projectPath);
  // Reproduce a Keychain authorization wait without touching the user's Keychain permissions.
  let probes = 0, timerRan = false;
  const unavailable = new ConnectionVault(join(temp, 'locked'), { isAsyncEncryptionAvailable: () => { probes++; return new Promise(() => {}); } }, { timeout: 20 });
  await unavailable.read(); unavailable.list(); assert.equal(probes, 0, 'an empty vault must not request Keychain access on startup');
  setTimeout(() => { timerRan = true; }, 1);
  await assert.rejects(unavailable.prepare({ name: 'locked', baseUrl: 'https://example.invalid/v1', protocol: 'responses', apiKey: 'never-saved' }), /尚未响应/);
  assert.equal(timerRan, true, 'the main event loop remains responsive during a Keychain wait');
  await assert.rejects(readFile(unavailable.path), { code: 'ENOENT' });
  server = createServer((request, response) => {
    assert.equal(request.url, '/v1/models'); assert.equal(request.headers.authorization, 'Bearer isolated-test-key');
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'company-model' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const vault = new ConnectionVault(directory, safeStorage); await vault.read();
  assert.equal(await vault.available(), true, 'OS key protection must be available; do not downgrade to plaintext');
  await vault.write(await vault.prepare({ name: '测试连接', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'responses', apiKey: 'isolated-test-key' }));
  assert.ok(!(await readFile(vault.path, 'utf8')).includes('isolated-test-key'));
  assert.ok(!JSON.stringify(vault.list()).includes('isolated-test-key'));
  const reopened = new ConnectionVault(directory, safeStorage); await reopened.read(); assert.equal(reopened.profiles[0].apiKey, 'isolated-test-key');
  await assert.rejects(reopened.prepare({ ...reopened.profiles[0], baseUrl: 'https://other.example/v1' }), /新建连接/);
  function start() { const child = utilityProcess.fork(join(root, 'host-dist/desktop-entry.mjs'), [directory], { stdio: 'pipe', serviceName: 'Turnsu test host' }); child.stdout?.resume(); child.stderr?.on('data', data => process.stderr.write(data)); return new HostClient(child); }
  host = start(); await host.request('desktop.connections.configure', { connections: reopened.profiles });
  const project = await host.request('project.open', { path: projectPath });
  const task = await host.request('session.create', { projectId: project.id, agent: 'codex', connectionId: reopened.profiles[0].id });
  await host.request('models.list', { sessionId: task.id, agent: 'codex' });
  await host.request('session.model', { sessionId: task.id, model: 'company-model' });
  await host.request('draft.save', { projectId: project.id, sessionId: task.id, text: '关闭后继续的本地草稿' });
  await host.close(); assert.equal(host.closed, true);
  host = start(); await host.request('desktop.connections.configure', { connections: reopened.profiles });
  const restored = await host.request('session.read', { sessionId: task.id });
  assert.equal(restored.connection_id, task.connection_id); assert.equal(restored.model, 'company-model');
  assert.equal((await host.request('draft.read', { projectId: project.id, sessionId: task.id })).text, '关闭后继续的本地草稿');
  await assert.rejects(host.request('project.open', { path: '/' }), /项目文件夹/);
  console.log(JSON.stringify({ status: 'passed', electron: process.versions.electron, node: process.versions.node, evidence: ['OS encrypted credential reopen', 'real utility process / SQLite / gateway HTTP', 'task source and draft reopen', 'graceful Host exit'], realProvider: false }));
} catch (error) { process.stderr.write(String(error.stack) + '\n'); process.exitCode = 1; }
finally { await host?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); app.exit(process.exitCode || 0); }

});
