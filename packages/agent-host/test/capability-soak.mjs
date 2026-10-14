// Linux capability-runtime soak. This does not claim Electron, real-provider or customer-device QA.
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { LocalAgentHost } from '../host.mjs';
import { Computer } from '../computer.mjs';
import { ComputerRuntime } from '../computer-runtime.mjs';
import { runCapability } from '../capability-process.mjs';

const duration = Number(process.env.TURNSU_SOAK_HOURS || 8) * 3600_000;
if (process.platform !== 'linux' || !Number.isFinite(duration) || duration <= 0 || duration > 9 * 3600_000) throw new Error('Run on Linux for at most nine hours.');
const output = resolve(process.env.TURNSU_SOAK_OUTPUT || 'capability-soak.jsonl');
const directory = await mkdtemp(join(tmpdir(), 'turnsu-soak-'));
let host, runtime, sampler, sampling = false, sample, stopped = false;
const started = Date.now();
const log = value => appendFile(output, JSON.stringify({at: new Date().toISOString(), elapsedMs: Date.now()-started, ...value})+'\n');
async function metrics() {
  if (sampling) return;
  sampling = true;
  try {
    const result = await runCapability('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
    const rows = result.stdout.trim().split('\n').map(line => {const [pid,ppid,rss,...name]=line.trim().split(/\s+/);return {pid:+pid,ppid:+ppid,rssKiB:+rss,name:name.join(' ')};});
    const owned=new Set([process.pid]);let changed=true;
    while(changed){changed=false;for(const row of rows)if(owned.has(row.ppid)&&!owned.has(row.pid)){owned.add(row.pid);changed=true;}}
    const processes=rows.filter(r=>owned.has(r.pid)&&!['ps'].includes(r.name));
    const containers=[...host.capabilities.running.keys()].map(id=>`turnsu-doc-${id}`);
    if(runtime.active?.container) containers.push(runtime.active.container);
    const stats=containers.length ? await runCapability('docker',['stats','--no-stream','--format','{{json .}}',...containers],{timeout:10_000}) : null;
    await log({type:'memory',processes,totalRssKiB:processes.reduce((n,r)=>n+r.rssKiB,0),containers:stats?.stdout.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))||[],sharedRuntime:rows.filter(r=>['dockerd','containerd'].includes(r.name)),scope:'test host and owned children/containers; shared daemon separately; no Electron or provider'});
  } finally {sampling=false;}
}
try {
  await writeFile(output,'',{flag:'wx',mode:0o600});
  const projectPath=join(directory,'中文, 客户项目');await mkdir(projectPath);await mkdir(join(projectPath,'成果'));
  const state=join(directory,'state');await mkdir(join(state,'computer-runtime'),{recursive:true,mode:0o700});
  async function image(name){assert.ok(name,'Set both TURNSU_DOCUMENT_TEST_IMAGE and TURNSU_COMPUTER_TEST_IMAGE');const r=await runCapability('docker',['image','inspect','--format','{{.Id}}',name]);assert.equal(r.code,0,r.stderr);return r.stdout.trim();}
  const documentImage=await image(process.env.TURNSU_DOCUMENT_TEST_IMAGE), computerImage=await image(process.env.TURNSU_COMPUTER_TEST_IMAGE);
  await writeFile(join(state,'computer-runtime','installed.json'),JSON.stringify({version:'0.30.4',image:computerImage}));
  host=new LocalAgentHost({directory:state});runtime=new ComputerRuntime(state);host.computer=new Computer(host,(method,args)=>runtime.dispatch(method,args));
  const project=await host.command('project.open',{path:projectPath});
  host.db.prepare("INSERT INTO capability_packages VALUES('documents','1.0.0','enabled',?,NULL)").run(JSON.stringify({image:documentImage}));
  await host.command('capabilities.grant',{projectId:project.id,reads:['成果'],output:'成果',hours:9,acknowledged:true});
  const task=await host.command('session.create',{projectId:project.id,agent:'codex'});
  await log({type:'started',hours:duration/3600_000,documentImage,computerImage,realProvider:false,visibleDesktop:false});
  sampler=setInterval(()=>{sample=metrics().catch(error=>log({type:'measurement-error',error:error.message}));},2000);
  process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
  let iteration=0;
  while(!stopped && Date.now()-started<duration) {
    const id=randomUUID();
    const created=await host.capabilities.call(project.id,null,{operation:'create',output:'中文报表.xlsx',content:{sheets:[{name:'订单',rows:[['金额'],[174.5],['=SUM(A2:A2)']]}]}},id);
    const reread=await host.capabilities.call(project.id,null,{operation:'read',path:created.path});
    assert.equal(reread.sheets[0].rows[1][0].value,174.5);
    assert.equal((await host.capabilities.call(project.id,null,{operation:'create',output:'中文报表.xlsx',content:{sheets:[{name:'订单',rows:[['金额'],[174.5],['=SUM(A2:A2)']]}]}},id)).path,created.path);
    if(iteration%3===0) {
      await host.command('computer.start',{projectId:project.id,mode:'isolated',target:'browser',minutes:5,origins:['https://example.com'],files:[],network:true,acknowledged:true});
      const call=(tool,args={})=>host.computer.call(project.id,task.id,{tool,arguments:args});
      const d=await call('describe'),pid=d.browser.prepared_pid;
      let windows=[];for(let n=0;n<20&&!windows.length;n++){windows=(await call('list_windows',{pid})).structuredContent.windows; if(!windows.length)await new Promise(r=>setTimeout(r,250));}
      assert.ok(windows.length);
      const bound=(await call('get_browser_state',{pid,window_id:windows[0].window_id})).structuredContent;
      const context={target_id:bound.target_id,tab_id:bound.tabs[0].tab_id};
      await call('browser_navigate',{...context,url:'https://example.com'});
      assert.equal((await call('get_browser_state',context)).structuredContent.url,'https://example.com/');
      const container=runtime.active.container;
      await host.command('computer.stop');
      assert.notEqual((await runCapability('docker',['inspect',container])).code,0);
      await host.command('computer.collect',{projectId:project.id,grantId:host.computer.history(project.id)[0].id});
    }
    await log({type:'cycle',iteration:++iteration,file:created.path,resourceUsage:host.resourceUsage()});
    const until=Math.min(started+duration,Date.now()+5*60_000);
    while(!stopped&&Date.now()<until)await new Promise(r=>setTimeout(r,Math.min(1000,until-Date.now())));
  }
  await log({type:stopped?'interrupted':'passed',iterations:iteration,hours:(Date.now()-started)/3600_000});
} catch(error) {await log({type:'failed',error:error.stack});process.exitCode=1;}
finally {clearInterval(sampler);await sample;await host?.close();await runtime?.close();await rm(directory,{recursive:true,force:true});}
