import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { ProductPostgresStore } from '../../src/store/postgres/index.mjs';
import { PostgresAgentConnectorStore } from '../../src/connections/postgres-agent-connectors.mjs';
import { createManagedConnectorHttp } from '../../src/connectors/http.mjs';

const enabled=process.env.WORKBENCH_POSTGRES_INTEGRATION==='1';
test('managed connectors isolate customers, encrypt credentials, fence replay and require explicit two-way handoff', {skip:!enabled}, async t=>{
  const connectionString=process.env.WORKBENCH_POSTGRES_URL;assert.match(new URL(connectionString).pathname,/_test$/);
  const pool=new Pool({connectionString,max:5});const store=new ProductPostgresStore({pool,maxTransactionRetries:0});await store.runMigrations();
  const identities={alice:{workspaceId:'connector-a',userId:'alice',clientKind:'desktop',devicePublicKey:'A'.repeat(43)},bob:{workspaceId:'connector-b',userId:'bob',clientKind:'desktop',devicePublicKey:'B'.repeat(43)}};
  let exchanges=0,sends=0;
  const provider=async(url,options)=>{
    if(String(url).endsWith('/token')){exchanges++;return Response.json({access_token:'provider-secret',refresh_token:'provider-refresh',token_type:'Bearer',expires_in:3600,scope:'user.localassistant.readable user.localassistant.invokable',open_id:'wb-alice'});}
    assert.equal(options.headers.Authorization,'Bearer provider-secret');
    if(String(url).endsWith('/localassistant'))return Response.json({code:0,data:{online:true}});
    if(options.method==='POST'){sends++;return Response.json({code:0,data:{message_id:'message-one'}});}
    return Response.json({code:0,data:{messages:[]}});
  };
  const handler=createManagedConnectorHttp({createPersistence:key=>new PostgresAgentConnectorStore(store,key),authService:{authenticateNativeAccessToken:async({accessToken})=>identities[accessToken]},origin:'https://turnsu.example.test',env:{TURNSU_CONNECTOR_SECRET_KEY:randomBytes(32).toString('base64'),TURNSU_WORKBUDDY_CLIENT_ID:'reviewed-app',TURNSU_WORKBUDDY_CLIENT_SECRET:'server-only-secret'},fetch:provider});
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/workbench/v1/agent-connectors/`;
  t.after(async()=>{await handler.close();await new Promise(r=>server.close(r));await store.close();await pool.end();});
  async function call(operation,input={},token='alice',status=200){const response=await fetch(base+operation,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,status,result.error);return result.data;}
  const oauth=await call('authorize',{acknowledged:true});const authurl=new URL(oauth.url);assert.equal(authurl.searchParams.get('scope'),'user.localassistant.readable user.localassistant.invokable');assert.equal(oauth.url.includes('server-only-secret'),false);
  const callback=await fetch(base+`callback/workbuddy?state=${authurl.searchParams.get('state')}&code=one-time`);assert.equal(callback.status,200);
  assert.equal((await fetch(base+`callback/workbuddy?state=${authurl.searchParams.get('state')}&code=one-time`)).status,409);assert.equal(exchanges,1);
  const account=(await call('connections')).connections[0];assert.equal(account.provider,'workbuddy');assert.deepEqual((await call('connections',{},'bob')).connections,[]);
  await call('check',{connectionId:account.id},'bob',404);
  const persisted=(await pool.query('SELECT credentials FROM agent_connector_accounts WHERE id=$1',[account.id])).rows[0].credentials;assert.equal(persisted.includes('provider-secret'),false);assert.equal(persisted.includes('provider-refresh'),false);
  const input={requestId:'input-one',connectionId:account.id,agent:'workbuddy-local',prompt:'客户主动选定的任务',files:[],acknowledged:true};const first=await call('send',input);assert.deepEqual(await call('send',input),first);assert.equal(sends,1);await call('send',{...input,prompt:'different'},'alice',409);await call('poll',{taskId:first.taskId},'bob',404);
  const muse=await call('muse-create',{requestId:'muse-one',acknowledged:true});const aliceTask=await call('send',{requestId:'muse-input',connectionId:muse.id,agent:'muse',prompt:'整理主动交接的材料',files:[],acknowledged:true});
  let poll=await call('poll',{taskId:aliceTask.taskId});assert.equal(poll.state,'waiting_external');
  const inbox=await call('muse/inbox',{},muse.token);assert.equal(inbox.tasks[0].id,aliceTask.taskId);
  await call('muse/pickup',{taskId:aliceTask.taskId},muse.token,400);
  const pickup=await call('muse/pickup',{taskId:aliceTask.taskId,confirmedByUser:true},muse.token);assert.equal(pickup.prompt,'整理主动交接的材料');
  const local={taskId:aliceTask.taskId,requestId:'local-one',tool:'documents',reason:'从已选材料生成报表',arguments:{operation:'create',output:'报表.xlsx',content:{sheets:[{name:'数据',rows:[[1,2]]}]}}};
  await call('muse/local.request',local,muse.token);poll=await call('poll',{taskId:aliceTask.taskId});assert.equal(poll.localRequests[0].id,'local-one');
  await call('local-result',{taskId:aliceTask.taskId,localRequestId:'local-one',status:'denied',result:{declined:true}},'bob',404);
  await call('local-result',{taskId:aliceTask.taskId,localRequestId:'local-one',status:'denied',result:{declined:true}});
  assert.equal((await call('muse/local.result',{taskId:aliceTask.taskId,requestId:'local-one'},muse.token)).status,'denied');
  await call('muse/result',{taskId:aliceTask.taskId,eventId:'final-one',text:'已收到拒绝，未进行本机操作'},muse.token);assert.equal((await call('poll',{taskId:aliceTask.taskId})).state,'completed');
  await call('revoke',{connectionId:muse.id});await call('muse/inbox',{},muse.token,401);
  const cancelled=await call('authorize',{acknowledged:true});await call('cancel',{authorizationId:cancelled.authorizationId});assert.equal((await fetch(base+`callback/workbuddy?state=${new URL(cancelled.url).searchParams.get('state')}&code=unused`)).status,409);assert.equal(exchanges,1);
});

test('WorkBuddy cloud persists its native task before readiness, sends once, downloads scoped artifacts and fences revocation', {skip:!enabled,timeout:60_000}, async t=>{
  const pool=new Pool({connectionString:process.env.WORKBENCH_POSTGRES_URL,max:6}),store=new ProductPostgresStore({pool,maxTransactionRetries:0});await store.runMigrations();
  const identity={workspaceId:'cloud-customer',userId:'cloud-alice',clientKind:'desktop',devicePublicKey:'C'.repeat(43)};
  let ready=false,creates=0,prompts=0,stream,promptId,streamNumber=0;const frames=[];
  const push=message=>stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
  const provider=async(raw,options={})=>{
    const url=new URL(raw);
    if(url.pathname.endsWith('/token'))return Response.json({access_token:'cloud-secret',refresh_token:'cloud-refresh',token_type:'Bearer',expires_in:3600,scope:'user.localassistant.readable user.localassistant.invokable user.task.readable user.task.invokable',open_id:'cloud-owner'});
    if(url.pathname.endsWith('/tasks')&&options.method==='POST'){creates++;return Response.json({task_id:'native-cloud',status:'CREATING'});}
    if(url.pathname.endsWith('/tasks/native-cloud'))return Response.json({task_id:'native-cloud',status:ready?'RUNNING':'CREATING',...(ready?{link:'https://qa.agentos-run.net/acp',token:'task-only-secret'}:{})});
    if(url.pathname==='/api/session/artifacts'){assert.equal(options.headers.Authorization,'Bearer task-only-secret');return Response.json({code:0,data:{sessionId:'native-cloud',artifacts:[{sessionId:'native-cloud',event:'created',artifact:{type:'media',uri:'agent:///artifacts/result.txt',name:'result.txt',updatedAt:'v1'}}],pagination:{hasMore:false}}});}
    if(url.pathname==='/artifacts/result.txt'){assert.equal(options.headers.Authorization,'Bearer task-only-secret');return new Response('真实协议成果 174.50');}
    assert.equal(url.pathname,'/acp');assert.equal(options.headers.Authorization,'Bearer task-only-secret');
    if(options.method!=='POST')return new Response(new ReadableStream({start(c){stream=c;options.signal.addEventListener('abort',()=>{try{c.error(Error('closed'));}catch{}});}}),{headers:{'Content-Type':'text/event-stream','Acp-Connection-Id':`channel-${++streamNumber}`}});
    const message=JSON.parse(options.body);frames.push(message);
    if(message.method==='initialize')push({id:message.id,result:{agentCapabilities:{promptCapabilities:{embeddedContext:true}}}});
    if(message.method==='session/load')push({id:message.id,result:{}});
    if(message.method==='session/prompt'){prompts++;promptId=message.id;}
    return new Response(null,{status:202});
  };
  const handler=createManagedConnectorHttp({createPersistence:key=>new PostgresAgentConnectorStore(store,key),authService:{authenticateNativeAccessToken:async()=>identity},origin:'https://turnsu.example.test',env:{TURNSU_CONNECTOR_SECRET_KEY:randomBytes(32).toString('base64'),TURNSU_WORKBUDDY_CLIENT_ID:'test-app',TURNSU_WORKBUDDY_CLIENT_SECRET:'private'},fetch:provider});
  const server=createServer((req,res)=>handler(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/workbench/v1/agent-connectors/`;
  t.after(async()=>{await handler.close();await new Promise(r=>server.close(r));await store.close();await pool.end();});
  async function call(operation,input={},expected=200){const response=await fetch(base+operation,{method:'POST',headers:{Authorization:'Bearer customer','Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,expected,result.error);return result.data;}
  const oauth=await call('authorize',{cloud:true,acknowledged:true});assert.equal((await fetch(base+`callback/workbuddy?state=${new URL(oauth.url).searchParams.get('state')}&code=approved`)).status,200);
  const connection=(await call('connections')).connections[0];
  const input={requestId:'cloud-create',connectionId:connection.id,agent:'workbuddy-cloud',prompt:'读取客户选定的材料',files:[],acknowledged:true};
  const receipt=await call('send',input);assert.equal(receipt.state,'preparing');assert.equal(creates,1);assert.equal(prompts,0);
  assert.deepEqual(await call('send',input),receipt);
  await call('poll',{taskId:receipt.taskId});assert.equal(prompts,0);
  ready=true;await Promise.all([call('poll',{taskId:receipt.taskId}),call('poll',{taskId:receipt.taskId})]);assert.equal(creates,1);assert.equal(prompts,1);
  push({method:'session/request_permission',id:'approval-one',params:{sessionId:'native-cloud',toolCall:{title:'创建成果',rawInput:{path:'result.txt'}},options:[{optionId:'once',kind:'allow_once',name:'允许一次'},{optionId:'always',kind:'allow_always',name:'始终允许'}]}});
  await new Promise(r=>setTimeout(r,40));let state=await call('poll',{taskId:receipt.taskId});assert.equal(state.state,'waiting');assert.equal(state.waiting.options.length,1);
  await call('action',{taskId:receipt.taskId,requestId:'bad-approval',operation:'approve',input:{requestId:'approval-one',optionId:'always'}},400);
  await call('action',{taskId:receipt.taskId,requestId:'good-approval',operation:'approve',input:{requestId:'approval-one',optionId:'once'}});
  push({id:promptId,result:{stopReason:'end_turn'}});await new Promise(r=>setTimeout(r,40));state=await call('poll',{taskId:receipt.taskId});assert.equal(state.state,'completed');assert.equal(state.nativeTaskId,'native-cloud');
  const file=await call('download',{taskId:receipt.taskId,uri:'agent:///artifacts/result.txt'});assert.match(Buffer.from(file.base64,'base64').toString(),/174.50/);
  await call('download',{taskId:receipt.taskId,uri:'agent:///artifacts/other.txt'},404);
  await call('send',{...input,requestId:'followup',taskId:receipt.taskId,prompt:'检查这份成果'});assert.equal(prompts,2);
  stream.error(Error('simulated transport loss'));await new Promise(r=>setTimeout(r,40));state=await call('poll',{taskId:receipt.taskId});assert.equal(state.state,'uncertain');assert.equal(prompts,2,'poll must never replay latest prompt');
  await call('action',{taskId:receipt.taskId,requestId:'manual-resolve',operation:'resolve',outcome:'completed',acknowledged:true});assert.equal((await call('poll',{taskId:receipt.taskId})).state,'completed');assert.equal(prompts,2);
  await call('revoke',{connectionId:connection.id});await call('poll',{taskId:receipt.taskId},404);await call('download',{taskId:receipt.taskId,uri:'agent:///artifacts/result.txt'},404);
  assert.equal((await pool.query('SELECT state FROM agent_connector_tasks WHERE id=$1',[receipt.taskId])).rows[0].state,'revoked');
});
