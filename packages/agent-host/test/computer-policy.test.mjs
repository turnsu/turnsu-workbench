import test from 'node:test';
import assert from 'node:assert/strict';
import { computerPolicy } from '../computer-policy.mjs';

const scope = { platform: 'linux', inputDirectory: '/input', outputDirectory: '/output' };
const browser = { acknowledged: true, mode: 'isolated', target: 'browser', minutes: 30, origins: ['https://example.com'] };
test('origin-scoped computer grants cannot add generic input, desktop capture, or an unreviewed mode', () => {
  const policy = computerPolicy({ ...browser, tools: ['shell', 'click'], desktop: true }, scope);
  assert.equal(policy.version, 3);
  assert.equal(policy.resources.desktop.display, false);
  assert.deepEqual(policy.resources.browser.origins, ['about:blank','https://example.com']);
  assert.ok(!policy.allow.tools.includes('click'));
  for (const patch of [{ acknowledged: false }, { mode: 'automatic' }, { origins: [] }, { origins: ['https://example.com/path'] }, { origins: ['file:///etc/passwd'] }, { target: 'app' }]) assert.throws(() => computerPolicy({ ...browser, ...patch }, scope));
});
test('native application grants require explicit platform resource identity and bounded expiry', () => {
  const input = { ...browser, mode: 'local', target: 'app', apps: ['com.apple.TextEdit'] };
  const policy = computerPolicy(input, { ...scope, platform: 'darwin' });
  assert.equal(policy.resources.apps[0].bundle_id, 'com.apple.TextEdit');
  assert.equal(policy.resources.browser, undefined);
  assert.equal(policy.resources.apps[0].terminate, 'driver_launched');
  assert.throws(() => computerPolicy(input, scope));
  assert.throws(() => computerPolicy({ ...input, minutes: 10000 }, scope));
});
