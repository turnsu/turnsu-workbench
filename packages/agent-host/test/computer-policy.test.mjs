import test from 'node:test';
import assert from 'node:assert/strict';
import { computerPolicy } from '../computer-policy.mjs';
import { ComputerRuntime } from '../computer-runtime.mjs';
import { Computer } from '../computer.mjs';
import { LocalAgentHost } from '../host.mjs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
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

test('simultaneous Agent requests send only one action to the authorized desktop',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turnsu-computer-owner-')),projectPath=join(root,'project');
  await mkdir(projectPath);const host=new LocalAgentHost({directory:join(root,'state')});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  let effects=0,entered,release;
  const firstEntered=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
  host.computer=new Computer(host,async(method)=>{
    if(method==='status')return {active:{id:'single-desktop'}};
    if(method==='stop')return {stopped:true};
    effects++;entered();await response;return {clicked:true};
  });
  const project=await host.command('project.open',{path:projectPath});
  const firstSession=await host.command('session.create',{projectId:project.id,agent:'codex'});
  const secondSession=await host.command('session.create',{projectId:project.id,agent:'codex'});
  host.computer.active={id:'single-desktop',projectId:project.id,root:await realpath(projectPath),expiresAt:Date.now()+60_000,manifest:{allow:{tools:['browser_click']}}};
  const input={tool:'browser_click',arguments:{ref:'submit'}};
  const results=Promise.allSettled([host.computer.call(project.id,firstSession.id,input),host.computer.call(project.id,secondSession.id,input)]);
  await firstEntered;release();
  const [first,second]=await results;
  assert.equal(first.status,'fulfilled');assert.equal(second.status,'rejected');assert.match(second.reason.message,/另一项任务|尚未完成/);
  assert.equal(effects,1,'one desktop write, not two concurrent Agent actions');
});

test('stop during desktop preparation cannot restore a grant from a late startup response',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turnsu-computer-cancel-')),projectPath=join(root,'project');await mkdir(projectPath);
  const host=new LocalAgentHost({directory:join(root,'state')});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  let entered,release,running=false;
  const enteredStart=new Promise(resolve=>{entered=resolve;}),startup=new Promise(resolve=>{release=resolve;});
  host.computer=new Computer(host,async(method)=>{
    if(method==='start'){entered();await startup;running=true;return {started:true};}
    if(method==='stop'){running=false;return {stopped:true};}
    if(method==='status')return {active:running?{id:'late-response'}:null};
  });
  const project=await host.command('project.open',{path:projectPath});
  const starting=host.computer.start({...browser,projectId:project.id,files:[]});
  const rejected=assert.rejects(starting,/已取消/);
  await enteredStart;await host.computer.stop();release();await rejected;
  assert.equal(running,false);assert.equal(host.computer.active,null);
  assert.equal(host.db.prepare("SELECT count(*) AS n FROM computer_grants WHERE status='active'").get().n,0);
});

test('runtime cancellation also fences a start waiting for recovery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turnsu-runtime-cancel-')),runtime=new ComputerRuntime(root);await runtime.ready;
  t.after(async()=>{await runtime.close();await rm(root,{recursive:true,force:true});});
  let release;runtime.ready=new Promise(resolve=>{release=resolve;});
  const starting=assert.rejects(runtime.start({}),/已取消/),stopping=runtime.stop();release();await Promise.all([starting,stopping]);
  assert.equal(runtime.active,null);assert.equal(runtime.children.size,0);
});
