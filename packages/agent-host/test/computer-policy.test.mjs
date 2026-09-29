import test from 'node:test';
import assert from 'node:assert/strict';
import { computerPolicy } from '../computer-policy.mjs';
import { ComputerRuntime } from '../computer-runtime.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('a lost computer action response ends the grant before another write can be attempted',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turnsu-computer-timeout-')),runtime=new ComputerRuntime(root);
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});await runtime.ready;
  let effects=0,closed=false;
  runtime.active={id:'reviewed-grant',mode:'local',manifestHash:'reviewed',expiresAt:Date.now()+60_000,manifest:{allow:{tools:['browser_click']}}};
  runtime.toolCatalog=[{name:'browser_click',inputSchema:{}}];
  runtime.rpc={request:async()=>{effects++;throw Error('response lost after click');},close:async()=>{closed=true;}};
  const call=()=>runtime.dispatch('call',{grantId:'reviewed-grant',manifestHash:'reviewed',tool:'browser_click',arguments:{ref:'button'}});
  await assert.rejects(call(),/response lost/);assert.equal(effects,1);assert.equal(closed,true);assert.equal((await runtime.status()).active,null);
  await assert.rejects(call(),/授权已失效/);assert.equal(effects,1);
});
