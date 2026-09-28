import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshQueue } from './refresh-queue.mjs';

test('rapid refresh requests serialize reads and retain a trailing update', async () => {
  let release, reads = 0, concurrent = 0, peak = 0;
  const refresh = createRefreshQueue(async () => {
    reads++; concurrent++; peak = Math.max(peak, concurrent);
    if (reads === 1) await new Promise(resolve => { release = resolve; });
    concurrent--; return reads;
  });
  const first = refresh();
  await new Promise(resolve => setImmediate(resolve));
  const second = refresh(), third = refresh();
  assert.equal(reads, 1);
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 2);
  assert.equal(await third, 2);
  assert.equal(reads, 2);
  assert.equal(peak, 1);
});

test('a failed read does not prevent a pending refresh', async () => {
  let release, reads = 0;
  const refresh = createRefreshQueue(async () => {
    reads++;
    if (reads === 1) { await new Promise(resolve => { release = resolve; }); throw new Error('temporary'); }
    return 'current';
  });
  const first = refresh();
  await new Promise(resolve => setImmediate(resolve));
  const next = refresh();
  release();
  await assert.rejects(first, /temporary/);
  assert.equal(await next, 'current');
  assert.equal(reads, 2);
});
