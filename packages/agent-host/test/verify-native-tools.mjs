// Real native CLI -> registered Turnsu tool -> isolated file worker.
// The model HTTP/SSE endpoint is a controlled fixture, not provider acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalAgentHost } from '../host.mjs';
import { PiConnection } from '../pi.mjs';
import { OpenCodeConnection, OhMyPiConnection } from '../opencode.mjs';
import { CodexConnection } from '../codex.mjs';
import { runCapability } from '../capability-process.mjs';

const agent=process.argv[2], binary=process.argv[3], image=process.env.TURNSU_DOCUMENT_TEST_IMAGE;
assert.ok(['codex','pi','opencode','omp'].includes(agent)&&binary&&image,'usage: TURNSU_DOCUMENT_TEST_IMAGE=... node verify-native-tools.mjs codex|pi|opencode|omp /absolute/cli');
const root=await mkdtemp(join(tmpdir(),'turnsu-native-tools-'));
const nativeHome=join(root,'native');await mkdir(nativeHome);
const projectPath=join(root,'客户项目');await mkdir(projectPath);
let host, round=0, seenTools=[], toolResults=[], outputPath;
const ompPhases=[0,0], discoveredDevices=new Set();
const calls=[{operation:'create',output:'客户订单.xlsx',content:{sheets:[{name:'订单',rows:[['客户','金额'],['南泰',174.5]]}]}},null];
function toolNames(tools) { return (tools||[]).flatMap(t=>[t.name,t.function?.name,...toolNames(t.tools)]).filter(Boolean); }
const server=createServer(async(req,res)=>{
  try {
    let text='';for await(const c of req) {text+=c;if(text.length>2_000_000)throw Error('fixture request too large');}
    const body=text?JSON.parse(text):{}, path=new URL(req.url,'http://localhost').pathname;
    if(path==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'turnsu-contract-model'}]}));return;}
    const names=toolNames(body.tools);seenTools.push(...names);
    const messages=body.messages||body.input||[];
    const results=messages.filter(m=>m.role==='tool'||m.type==='function_call_output');
    const latest=results.at(-1);if(latest)toolResults.push(latest);

    // Every request must expose the actual registered native tool; do not fake its result.
    let name=names.find(n=>n==='turnsu_document'||n.endsWith('turnsu_document'));
    let needCall=Boolean(name)&&(!latest||round===1&&!JSON.stringify(latest).includes('sheets')); // OpenCode also requests titles without tools.
    let args=JSON.stringify(calls[round]);
    if(agent==='omp'){
      // OMP exposes discoverable MCP tools through its native xd read/write transport.
      const device=JSON.stringify(messages).match(/xd:\/\/mcp__turnsu_document/)?.[0];
      assert.ok(device&&names.includes('read')&&names.includes('write'),'OMP did not advertise the registered MCP device');discoveredDevices.add(device);
      needCall=ompPhases[round]<2;name=ompPhases[round]===0?'read':'write';
      args=JSON.stringify(ompPhases[round]===0?{path:device}:{path:device,content:JSON.stringify(calls[round])});
      if(needCall)ompPhases[round]++;
    }
    const id=`turnsu_tool_${round}_${results.length}`;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    if(path==='/v1/chat/completions'){
      const base={id:'chatcmpl_tool',object:'chat.completion.chunk',created:1,model:'turnsu-contract-model'};
      const chunks=needCall?[{role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:args}}]},{}]:[{role:'assistant',content:'文件工具已完成，请检查项目成果。'},{}];
      chunks.forEach((delta,i)=>res.write(`data: ${JSON.stringify({...base,choices:[{index:0,delta,finish_reason:i===1?(needCall?'tool_calls':'stop'):null}]})}\n\n`));res.end('data: [DONE]\n\n');return;
    }
    assert.equal(path,'/v1/responses');
    const item=needCall?{type:'function_call',id:`fc_${round}`,call_id:id,name,arguments:args,status:'completed'}:{id:`msg_${round}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'文件工具已完成，请检查项目成果。',annotations:[]}]};
    const result={id:`resp_${round}_${results.length}`,object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'turnsu-contract-model',output:[item],usage:{input_tokens:8,output_tokens:8,total_tokens:16,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
    const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',...(needCall?{arguments:''}:{content:[]})}}];
    if(needCall)events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:args},{type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:args});
    else events.push({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
    events.push({type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result});
    for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);res.end();
  }catch(error){res.destroy();console.error('MODEL_FIXTURE:',error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const nativeSpawn=(file,args,opts)=>spawn(file,args,{...opts,env:{...opts.env,...(agent==='codex'?{CODEX_HOME:nativeHome}:{PI_CODING_AGENT_DIR:nativeHome,XDG_CONFIG_HOME:join(nativeHome,'config'),XDG_DATA_HOME:join(nativeHome,'data'),XDG_CACHE_HOME:join(nativeHome,'cache')})}});
function openHost(){return new LocalAgentHost({directory:join(root,'state'),ompFactory:opts=>new OhMyPiConnection({...opts,binary:resolve(binary),spawnProcess:nativeSpawn}),opencodeFactory:opts=>new OpenCodeConnection({...opts,binary:resolve(binary),spawnProcess:nativeSpawn}),connectionFactory:opts=>new CodexConnection({...opts,binary:resolve(binary),spawnProcess:nativeSpawn}),piFactory:opts=>new PiConnection({...opts,binary:resolve(binary),spawnProcess:nativeSpawn})});}
async function configure(){
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  if(agent==='omp'){
    // The native account is configured in a private test directory, not through a model gateway adapter.
    await writeFile(join(nativeHome,'models.yml'),JSON.stringify({providers:{'turnsu-contract':{api:'openai-completions',baseUrl,apiKey:'private-fixture-key',models:[{id:'turnsu-contract-model',name:'Contract',contextWindow:128000,maxTokens:4096,supportsTools:true,input:['text'],reasoning:false,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
  }else await host.configureConnections([{id:'contract',name:'受控工具验证',baseUrl,protocol:agent==='codex'?'responses':'chat',apiKey:'private-fixture-key'}]);
}
async function wait(id){const until=Date.now()+60_000;while(Date.now()<until&&['starting','running','waiting'].includes(host.session(id).status))await new Promise(r=>setTimeout(r,100));const state=await host.command('session.read',{sessionId:id});assert.equal(state.status,'idle',state.error||JSON.stringify(state));return state;}
try{
  host=openHost();await configure();
  const project=await host.command('project.open',{path:projectPath});
  const info=await runCapability('docker',['image','inspect','--format','{{.Id}}',image]);assert.equal(info.code,0);
  host.db.prepare("INSERT INTO capability_packages VALUES('documents','1.0.0','enabled',?,NULL)").run(JSON.stringify({image:info.stdout.trim()}));
  await host.command('capabilities.grant',{projectId:project.id,reads:['.'],output:'成果',hours:1,acknowledged:true});
  const session=await host.command('session.create',{projectId:project.id,agent,connectionId:agent==='omp'?null:'contract'});
  await host.command('models.list',{sessionId:session.id,agent});
  await host.command('session.model',{sessionId:session.id,model:agent==='codex'?'turnsu-contract-model':'turnsu-contract/turnsu-contract-model'});
  await host.command('session.send',{sessionId:session.id,inputId:'native-create',text:'使用 turnsu_document 创建客户订单 Excel。'});
  const firstState=await wait(session.id);assert.ok(toolResults.length,'actual native tool result did not return to model: '+JSON.stringify({tools:[...new Set(seenTools)],session:firstState}));
  const receipts=host.db.prepare("SELECT result FROM capability_receipts WHERE status='completed'").all();
  outputPath=receipts.map(r=>JSON.parse(r.result)).find(r=>r.path)?.path;assert.ok(outputPath,'no completed real file receipt');assert.ok((await readFile(join(projectPath,outputPath))).length>100);
  const nativeId=host.session(session.id).native_id;
  await host.close();round=1;calls[1]={operation:'read',path:outputPath};host=openHost();await configure();
  await host.command('session.send',{sessionId:session.id,inputId:'native-read',text:`用文件工具读取上次成果 ${outputPath}，核对金额。`});
  await wait(session.id);assert.equal(host.session(session.id).native_id,nativeId);
  assert.ok(toolResults.some(r=>JSON.stringify(r).includes('174.5')),'read result was not returned through the native Agent');
  await host.command('capabilities.revoke',{projectId:project.id});
  await assert.rejects(host.capabilities.call(project.id,session.id,{operation:'read',path:outputPath}),/授权/);
  console.log(JSON.stringify({status:'passed',native:agent,tool:'turnsu_document',realDocker:true,reopenedNativeSession:true,provider:'controlled HTTP/SSE fixture',tools:[...new Set(seenTools)],devices:[...discoveredDevices]}));
}finally{await host?.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
