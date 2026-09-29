import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkBuddy, WorkBuddyCloudChannel, cloudEndpoint } from '../../src/connectors/workbuddy.mjs';

test('WorkBuddy decodes documented task and assistant response shapes separately', async () => {
  const api = new WorkBuddy({fetch: async url => Response.json(String(url).endsWith('/tasks') ? {task_id:'native-1',status:'CREATING'} : {code:0,data:{online:true}})});
  assert.equal((await api.api('key','/tasks',{prompt:'read selected material'})).task_id,'native-1');
  assert.equal((await api.api('key','/localassistant')).online,true);
  for (const link of ['http://x.agentos-run.net/acp','https://agentos-run.net.evil.test/acp','https://acp.workbuddy.cn/sessions/other','https://x.agentos-run.net/acp?secret=x']) assert.throws(()=>cloudEndpoint(link,'native-1'));
  assert.equal(cloudEndpoint('https://acp.workbuddy.cn/sessions/native-1','native-1').hostname,'acp.workbuddy.cn');
});

test('WorkBuddy ACP uses paired SSE/POST, batches text and awaits the actual prompt result', async t => {
  let stream, prompt, closed=false; const sent=[],events=[],states=[];
  const push = message => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
  const channel = new WorkBuddyCloudChannel({task:{native_id:'native-1'},ticket:{link:'https://x.agentos-run.net/acp',token:'server-only'},onClose:()=>{closed=true;},onEvent:async(key,event)=>events.push({key,event}),onState:async(state,waiting)=>states.push({state,waiting}),fetch:async(_url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer server-only');
    if(options.method!=='POST') return new Response(new ReadableStream({start(c){stream=c;},cancel(){}}),{headers:{'Content-Type':'text/event-stream','Acp-Connection-Id':'paired-1'}});
    assert.equal(options.headers['Acp-Connection-Id'],'paired-1'); const msg=JSON.parse(options.body);sent.push(msg);
    if(msg.method==='initialize')push({id:msg.id,result:{agentCapabilities:{promptCapabilities:{embeddedContext:true}}}});
    if(msg.method==='session/load')push({id:msg.id,result:{}});
    if(msg.method==='session/prompt')prompt=msg;
    return new Response(null,{status:202});
  }});
  t.after(()=>{channel.close();});
  await channel.start();await channel.prompt('汇总资料',[]);
  push({method:'session/update',params:{sessionId:'native-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'真实协议'}}}});
  push({method:'session/update',params:{sessionId:'native-1',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'增量'}}}});
  await new Promise(r=>setImmediate(r));assert.equal(states.length,0,'a tool/message event cannot imply completion');
  push({id:prompt.id,result:{stopReason:'end_turn'}});
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(states,[{state:'completed',waiting:null}]);
  assert.equal(events.map(e=>e.event.assistant_message.content).join(''),'真实协议增量');
  assert.equal(sent.filter(m=>m.method==='session/prompt').length,1);assert.equal(closed,true);
});
