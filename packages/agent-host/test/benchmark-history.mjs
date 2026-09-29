import { tmpdir } from 'node:os';
// Synthetic load measurement through the real private stdio entry. No provider or cloud calls.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { openStore } from '../store.mjs';
const root = await mkdtemp(join(tmpdir(), 'turnsu-history-benchmark-')), directory = join(root, 'state');
await mkdir(join(root, 'project'));
const store = openStore(directory), db = store.db, count = 2400;
const sessionCount = Number(process.env.TURNSU_BENCH_SESSIONS || 10000);
if (!Number.isSafeInteger(sessionCount) || sessionCount < 1 || sessionCount > 100000) throw new Error('Invalid benchmark size');
db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('project', join(root, 'project'), 'Synthetic history', 1);
db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES('session','project','Synthetic history','idle',1)").run();
db.exec('BEGIN');
for (let i = 1; i < sessionCount; i++) db.prepare("INSERT INTO sessions(id,project_id,title,status,updated_at) VALUES(?,'project',?,'idle',?)").run('session-' + i, 'Synthetic task ' + i, i + 1);
for (let i = 0; i < count; i++) db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('message-' + i, 'session', i % 2 ? 'assistant' : 'user', `Record ${i}\n` + 'Synthetic text. '.repeat(250), 'text', i + 1);
db.exec('COMMIT'); store.close();
const entry = process.argv[2] || new URL('../entry.mjs', import.meta.url).pathname;
const started = performance.now(), child = spawn(process.execPath, [entry, directory], { stdio: ['pipe','pipe','pipe'] });
let sequence = 0; const pending = new Map();
createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve({ ...value, bytes: Buffer.byteLength(line) }); } });
child.stderr.on('data', () => {});
const exited = new Promise(resolve => child.once('exit', resolve));
const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
child.once('exit', code => { for (const resolve of pending.values()) resolve({ error: 'host exited ' + code }); pending.clear(); });
function call(method, args = {}) { return new Promise(resolve => { const id = ++sequence; pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, args }) + '\n'); }); }
try {
 const workspace = await call('workspace.read'); if (workspace.error) throw new Error(workspace.error);
 const startupMs = performance.now() - started, reads = [];
 const index = await call('workspace.read', { projectId: 'project' }); if (index.error) throw new Error(index.error);
 const rssKiB = () => process.platform === 'win32' ? null : process.platform === 'linux'
   ? Number(readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB$/m)?.[1])
   : Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
 const rssBeforeReads = rssKiB();
 for (let i = 0; i < 5; i++) { const start = performance.now(); const result = await call('session.read', { sessionId: 'session' }); if (result.error) throw new Error(result.error); reads.push({ ms: performance.now() - start, bytes: result.bytes, returnedMessages: result.result.messages.length }); }
 console.log(JSON.stringify({ fixture: 'synthetic-no-provider', sessionCount, messageCount: count, entry, startupMs, startupBytes: workspace.bytes, returnedStartupSessions: workspace.result.sessions.length, indexBytes: index.bytes, returnedIndexSessions: index.result.sessions.length, rssBeforeReadsKiB: rssBeforeReads, rssAfterReadsKiB: rssKiB(), reads }, null, 2));
} finally { child.stdin.end(); await exited; clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
