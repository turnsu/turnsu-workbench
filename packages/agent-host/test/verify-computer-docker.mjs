import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { LocalAgentHost } from '../host.mjs';
import { Computer } from '../computer.mjs';
import { ComputerRuntime } from '../computer-runtime.mjs';
import { runCapability } from '../capability-process.mjs';

const image = process.env.TURNSU_COMPUTER_TEST_IMAGE;
if (!image) throw new Error('Set TURNSU_COMPUTER_TEST_IMAGE to a locally built fixed-version image.');
if (process.argv[2] === '--crash-child') {
  const directory=join(process.argv[3],'state'),runtime=new ComputerRuntime(directory),host=new LocalAgentHost({directory});
  host.computer=new Computer(host,(method,args)=>runtime.dispatch(method,args));
  const project=await host.command('project.open',{path:join(process.argv[3],'项目')});
  const state=await host.command('computer.start',{projectId:project.id,mode:'isolated',target:'browser',minutes:10,origins:['https://example.com'],files:[],network:false,acknowledged:true});
  const artifact=join(runtime.active.scratch,'output','recovered.txt');await writeFile(artifact,'retain interrupted output');
  process.send({container:runtime.active.container,grantId:state.grant.id,artifact});
  await new Promise(()=>{});
}
const root = await mkdtemp(join(tmpdir(), 'turnsu-computer-check-'));
let host, runtime, crashed;
try {
  const directory = join(root, 'state'), projectPath = join(root, '项目'); await mkdir(projectPath); await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, 'computer-runtime'), { mode: 0o700 });
  const inspected = await runCapability('docker', ['image', 'inspect', '--format', '{{.Id}}', image]); assert.equal(inspected.code, 0);
  await writeFile(join(directory, 'computer-runtime', 'installed.json'), JSON.stringify({ version: '0.30.4', image: inspected.stdout.trim() }));
  runtime = new ComputerRuntime(directory); host = new LocalAgentHost({ directory }); host.computer = new Computer(host, (method, args) => runtime.dispatch(method, args));
  const project = await host.command('project.open', { path: projectPath });
  await host.command('computer.start', { projectId: project.id, mode: 'isolated', target: 'browser', minutes: 10, origins: ['https://example.com', 'https://iana.org', 'https://www.iana.org'], files: [], network: true, acknowledged: true });
  const session = await host.command('session.create', { projectId: project.id, agent: 'codex' });
  const call = (tool, args = {}) => host.computer.call(project.id, session.id, { tool, arguments: args });
  await call('start_session', { session: 'turnsu-check' });
  await assert.rejects(call('click', { x: 1, y: 1 }), /清单/);
  const description = await call('describe');
  const pid = description.browser.prepared_pid;
  let windows;
  for (let attempt = 0; attempt < 20; attempt++) {
    windows = (await call('list_windows', {pid})).structuredContent?.windows?.filter(window => window.pid === pid) || [];
    if (windows.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(windows.length, 'Isolated Chrome must expose an actual window');
  const bound = await call('get_browser_state', { session: 'turnsu-check', pid, window_id: windows[0].window_id });
  assert.equal(bound.structuredContent?.binding_quality, 'exact');
  const context = {session: 'turnsu-check', target_id: bound.structuredContent.target_id, tab_id: bound.structuredContent.tabs[0].tab_id};
  await call('browser_navigate', {...context,url:'https://example.com'});
  const page = await call('get_browser_state', context);
  assert.equal(page.structuredContent?.url, 'https://example.com/');
  const link = page.structuredContent.refs.find(ref => ref.node === 'a' && ref.label?.includes('https://iana.org/help/example-domains'));
  assert.ok(link, 'A real page control must be discovered from the current snapshot');
  await call('browser_click', {...context,ref:link.ref,input_route:'dom_event'});
  let followed;
  for(let attempt=0;attempt<10;attempt++) {
    followed = await call('get_browser_state', context);
    if(new URL(followed.structuredContent.url).hostname.endsWith('iana.org'))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(new URL(followed.structuredContent.url).hostname.endsWith('iana.org'), 'Click must actually navigate to the linked document');
  console.log('Confirmed browser result:', followed.structuredContent.url);
  await assert.rejects(call('browser_navigate', {...context,url:'https://example.org'}), /origin|manifest|capability|outside/i);
  const container = runtime.active.container;
  await host.command('computer.stop');
  await assert.rejects(call('start_session'), /授权/);
  assert.notEqual((await runCapability('docker', ['inspect', container])).code, 0, 'Stopped container must be removed');
  assert.equal(runtime.children.size, 0, 'All owned client/driver processes must exit');
  console.log('Driver startup, reviewed tool denial, browser launch, revocation and cleanup passed.');
  await host.close();host=null;await runtime.close();runtime=null;
  crashed=fork(new URL(import.meta.url),['--crash-child',root],{stdio:['ignore','ignore','pipe','ipc']});crashed.stderr.resume();
  const active=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Crash fixture did not start')),45_000);crashed.once('message',value=>{clearTimeout(timeout);resolve(value);});crashed.once('exit',code=>{clearTimeout(timeout);reject(Error(`Crash fixture exited ${code}`));});});
  const exited=new Promise(resolve=>crashed.once('exit',resolve));crashed.kill('SIGKILL');await exited;crashed=null;
  let running=true;
  for(let attempt=0;attempt<30;attempt++){
    const state=await runCapability('docker',['inspect','--format','{{.State.Running}}',active.container]);
    running=state.code===0&&state.stdout.trim()==='true';if(!running)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.equal(running,false,'Driver and browser must exit when their owning workbench crashes');
  runtime=new ComputerRuntime(directory);const recovered=await runtime.status();
  assert.equal(recovered.active,null);assert.equal(recovered.cleanupPending,false);
  assert.notEqual((await runCapability('docker',['inspect',active.container])).code,0);
  assert.equal(await readFile(active.artifact,'utf8'),'retain interrupted output');
  console.log('Owner SIGKILL stopped the real isolated Driver; reopen removed the container and preserved output.');
} finally { crashed?.kill('SIGKILL'); await host?.close(); await runtime?.close(); await rm(root, { recursive: true, force: true }); }
