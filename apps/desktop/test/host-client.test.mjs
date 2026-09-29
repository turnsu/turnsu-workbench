import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HostClient } from '../electron/host-client.mjs';

function port() { const child = new EventEmitter(); child.sent = []; child.postMessage = message => child.sent.push(message); child.kill = () => child.emit('exit', 1); return child; }

test('out-of-order Host responses stay with the originating operation and disconnect rejects pending work', async () => {
  const child = port(), events = [], host = new HostClient(child, e => events.push(e));
  const first = host.request('draft.read'), second = host.request('session.read');
  child.emit('message', { id: 2, result: { title: 'second' } });
  child.emit('message', { event: { type: 'changed' } });
  child.emit('message', { id: 1, result: { text: 'first' } });
  assert.deepEqual(await first, { text: 'first' }); assert.deepEqual(await second, { title: 'second' });
  const pending = assert.rejects(host.request('session.send'), /本地服务已停止/);
  child.emit('exit', 1); await pending;
  assert.equal(host.pending.size, 0); assert.equal(events.at(-1).type, 'disconnected');
});

test('an uncertain timeout never resubmits native work; shutdown waits for Host exit', async () => {
  const child = port(), host = new HostClient(child);
  await assert.rejects(host.request('session.send', { inputId: 'once' }, 5), /不要重复/);
  child.emit('message', { id: 1, result: { accepted: true } });
  assert.equal(child.sent.length, 1); assert.equal(host.pending.size, 0);
  const closing = host.close(); assert.equal(child.sent.at(-1).method, 'shutdown');
  child.emit('exit', 0); await closing; assert.equal(host.closed, true);
});
