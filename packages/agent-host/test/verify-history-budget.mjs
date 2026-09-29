import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const benchmark = fileURLToPath(new URL('./benchmark-history.mjs', import.meta.url));
const { stdout } = await execute(process.execPath, [benchmark], {
  env: { ...process.env, TURNSU_BENCH_SESSIONS: '10000' },
  timeout: 120_000,
  maxBuffer: 2 * 1024 * 1024,
});
const result = JSON.parse(stdout);

assert.equal(result.sessionCount, 10000);
assert.equal(result.returnedStartupSessions, 0, 'startup must not restore all sessions');
assert.ok(result.startupBytes <= 16 * 1024, 'startup response must stay bounded');
assert.ok(result.returnedIndexSessions <= 40, 'project index must be paged');
assert.ok(result.indexBytes <= 64 * 1024, 'project index response must stay bounded');
for (const read of result.reads) {
  assert.ok(read.returnedMessages <= 40, 'one history read must be paged');
  assert.ok(read.bytes <= 512 * 1024, 'one history response must stay bounded');
}
assert.ok(Number.isFinite(result.rssBeforeReadsKiB) && Number.isFinite(result.rssAfterReadsKiB), 'Linux Host RSS must be measured');
assert.ok(result.rssAfterReadsKiB - result.rssBeforeReadsKiB <= 64 * 1024, 'repeated history reads must not retain unbounded memory');

console.log(JSON.stringify({ status: 'passed', sessions: result.sessionCount, messages: result.messageCount,
  startupSessions: result.returnedStartupSessions, indexSessions: result.returnedIndexSessions,
  historyMessages: result.reads[0]?.returnedMessages, rssGrowthKiB: result.rssAfterReadsKiB - result.rssBeforeReadsKiB }));
