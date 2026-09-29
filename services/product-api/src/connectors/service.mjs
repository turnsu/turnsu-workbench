import { randomUUID, randomBytes } from 'node:crypto';
import { ConnectorStore, ConnectorError, requireValue, secretHash } from './store.mjs';
import { WorkBuddy, WorkBuddyCloudChannel } from './workbuddy.mjs';

const localScopes = ['user.localassistant.readable','user.localassistant.invokable'];
const cloudScopes = ['user.task.readable','user.task.invokable'];
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const publicAccount = row => ({ id:row.id, name:row.name, provider:row.provider, agents:row.provider === 'muse' ? ['muse'] : [...(localScopes.every(s => row.scopes.includes(s)) ? ['workbuddy-local'] : []), ...(cloudScopes.every(s => row.scopes.includes(s)) ? ['workbuddy-cloud'] : [])], revoked:Boolean(row.revoked_at), needsAuthorization:row.refresh_pending, expiresAt:row.provider === 'muse' ? row.expires_at : null });

export class ManagedAgentConnectors {
  constructor({ store, env, origin, fetch }) {
    requireValue(origin && /^https:\/\//.test(origin), '托管接入需要显式 HTTPS 公网服务地址。',503);
    this.db = new ConnectorStore(store, env.TURNSU_CONNECTOR_SECRET_KEY); this.origin = new URL(origin).origin; this.fetch = fetch || globalThis.fetch; this.channels = new Map();
    this.workbuddy = env.TURNSU_WORKBUDDY_CLIENT_ID && env.TURNSU_WORKBUDDY_CLIENT_SECRET ? new WorkBuddy({ clientId:env.TURNSU_WORKBUDDY_CLIENT_ID, clientSecret:env.TURNSU_WORKBUDDY_CLIENT_SECRET, callback:`${this.origin}/api/workbench/v1/agent-connectors/callback/workbuddy`, fetch:this.fetch }) : null;
  }
  async connections(identity) {
    const rows = await this.db.tx(q => q('SELECT * FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 12', this.db.scope(identity)));
    return { connections:rows.rows.map(publicAccount), available:{ workbuddy:Boolean(this.workbuddy), muse:true }, verification:'connector-service-only' };
  }
  async authorize(identity, { cloud = false, acknowledged }) {
    requireValue(this.workbuddy, 'Turnsu 尚未配置获批的 WorkBuddy 第三方应用。',503); requireValue(acknowledged === true, '请确认所申请的 Agent 权限。');
    const state = randomBytes(32).toString('base64url'), scopes = [...localScopes, ...(cloud ? cloudScopes : [])];
    await this.db.tx(q => q("INSERT INTO agent_connector_authorizations(state_hash,workspace_id,user_id,provider,requested_scopes,expires_at) VALUES($1,$2,$3,'workbuddy',$4,now()+interval '10 minutes')", [secretHash(state), ...this.db.scope(identity), JSON.stringify(scopes)]));
    return { authorizationId:secretHash(state), url:this.workbuddy.authorize(state,scopes), scopes };
  }
  async callback({ state, code, error }) {
    requireValue(typeof state === 'string' && state.length < 200, '授权状态无效。');
    const row = await this.db.tx(async q => (await q("UPDATE agent_connector_authorizations SET consumed_at=now(),status=$2 WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING *", [secretHash(state), error ? 'cancelled' : 'exchanging'])).rows[0]);
    requireValue(row, '授权已过期或已使用，请从工作台重新连接。',409);
    if (error) return { cancelled:true };
    requireValue(typeof code === 'string' && code.length < 4096 && this.workbuddy, '授权码或应用配置不可用。');
    try {
      const token = await this.workbuddy.token({ grant_type:'authorization_code',code,redirect_uri:this.workbuddy.callback });
      const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : [];
      requireValue(row.requested_scopes.every(s => scopes.includes(s)) && typeof token.open_id === 'string' && token.refresh_token, '账号未授予所需权限。请重新授权。',403);
      const id = randomUUID(), expires = new Date(Date.now()+token.expires_in*1000);
      await this.db.tx(async q => {
        const count = (await q('SELECT count(*)::int AS n FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL', [row.workspace_id,row.user_id])).rows[0].n; requireValue(count<12,'最多保存 12 个托管连接。');
        await q("INSERT INTO agent_connector_accounts(id,workspace_id,user_id,provider,name,credentials,scopes,native_account,expires_at) VALUES($1,$2,$3,'workbuddy','WorkBuddy',$4,$5,$6,$7)", [id,row.workspace_id,row.user_id,this.db.seal(token,`${row.workspace_id}:${row.user_id}:${id}`),JSON.stringify(scopes),token.open_id,expires]);
        await q("UPDATE agent_connector_authorizations SET status='connected',connection_id=$2 WHERE state_hash=$1",[row.state_hash,id]);
      }); return { connected:true };
    } catch (cause) { await this.db.tx(q => q("UPDATE agent_connector_authorizations SET status='failed' WHERE state_hash=$1",[row.state_hash])); throw cause; }
  }
  async credential(identity, id) {
    let account = await this.db.connection(identity,id);
    requireValue(account.provider === 'workbuddy' && this.workbuddy,'WorkBuddy 连接不可用。',409);
    requireValue(!account.refresh_pending,'上次刷新未确认，请重新授权；不会重复使用刷新凭据。',409);
    const aad = `${account.workspace_id}:${account.user_id}:${account.id}`;
    let token = this.db.open(account.credentials,aad);
    if (new Date(account.expires_at).getTime()>Date.now()+30_000) return { account,token:token.access_token };
    const claimed = await this.db.tx(q => q('UPDATE agent_connector_accounts SET refresh_pending=true WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND refresh_pending=false AND revoked_at IS NULL RETURNING id',[...this.db.scope(identity),id]));
    requireValue(claimed.rows.length,'连接正在刷新或已撤销。',409);
    token = await this.workbuddy.token({ grant_type:'refresh_token',refresh_token:token.refresh_token });
    requireValue(!token.open_id || token.open_id===account.native_account,'授权账号已变化，请新建连接。',409);
    const previous = this.db.open(account.credentials,aad); token.refresh_token ||= previous.refresh_token;
    const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/) : account.scopes; token.scope = scopes.join(' ');
    const updated = await this.db.tx(q => q('UPDATE agent_connector_accounts SET credentials=$4,expires_at=$5,refresh_pending=false,scopes=$6 WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING *',[...this.db.scope(identity),id,this.db.seal(token,aad),new Date(Date.now()+token.expires_in*1000),JSON.stringify(scopes)]));
    requireValue(updated.rows.length,'此连接已撤销。',403); return { account:updated.rows[0],token:token.access_token };
  }
  async check(identity,{ connectionId }) { const account = await this.db.connection(identity,connectionId); if (account.provider==='muse') return { connected:new Date(account.expires_at)>new Date(), state:'waiting_connector_pickup' }; const { token } = await this.credential(identity,connectionId); return { ...(await this.workbuddy.api(token,'/localassistant')), verification:'online-only' }; }
  async revoke(identity,{ connectionId }) {
    await this.db.connection(identity,connectionId);
    const tasks = await this.db.tx(async q => {
      await q('UPDATE agent_connector_accounts SET revoked_at=now(),credentials=NULL,connector_key_hash=NULL WHERE workspace_id=$1 AND user_id=$2 AND id=$3',[...this.db.scope(identity),connectionId]);
      return (await q("UPDATE agent_connector_tasks SET state='revoked',waiting=NULL WHERE workspace_id=$1 AND user_id=$2 AND connection_id=$3 RETURNING id",[...this.db.scope(identity),connectionId])).rows;
    }); for (const task of tasks) { this.channels.get(task.id)?.close(); this.channels.delete(task.id); } return { revoked:true, remoteOperationsMayContinue:true };
  }
  async mutate(identity, input, run) {
    requireValue(identifier(input.requestId),'需要唯一请求标识。'); const scope=this.db.scope(identity), fingerprint=secretHash(JSON.stringify(input));
    const previous=await this.db.tx(async q => { await q("INSERT INTO agent_connector_mutations(workspace_id,user_id,request_id,request_hash,status) VALUES($1,$2,$3,$4,'claimed') ON CONFLICT DO NOTHING",[...scope,input.requestId,fingerprint]); const row=(await q('SELECT * FROM agent_connector_mutations WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3 FOR UPDATE',[...scope,input.requestId])).rows[0]; requireValue(row.request_hash===fingerprint,'请求标识对应的内容已变化。',409); if(row.status==='claimed') { await q("UPDATE agent_connector_mutations SET status='sending' WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...scope,input.requestId]); return null; } return row; });
    if(previous) { requireValue(previous.status==='completed','上次操作结果尚未确认，请先核对任务；不会重复提交。',409); return this.db.open(previous.receipt,`${scope.join(':')}:${input.requestId}`); }
    try { const result=await run(); await this.db.tx(q=>q("UPDATE agent_connector_mutations SET status='completed',receipt=$4 WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...scope,input.requestId,this.db.seal(result,`${scope.join(':')}:${input.requestId}`)])); return result; }
    catch(error) { await this.db.tx(q=>q("UPDATE agent_connector_mutations SET status='uncertain' WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...scope,input.requestId])); throw error; }
  }
  async send(identity,input) {
    requireValue(input.acknowledged===true && ['workbuddy-local','workbuddy-cloud','muse'].includes(input.agent) && typeof input.prompt==='string' && input.prompt.trim() && input.prompt.length<=100_000,'任务、执行器或外发授权无效。');
    requireValue(Array.isArray(input.files) && input.files.length<=10 && Buffer.byteLength(JSON.stringify(input.files))<=45_000_000,'选定材料超过限制。');
    const account=await this.db.connection(identity,input.connectionId); requireValue(publicAccount(account).agents.includes(input.agent),'此连接未授权所选 Agent。',403);
    return this.mutate(identity,input,async()=>{
      let task=input.taskId ? await this.db.task(identity,input.taskId) : null;
      if(task) {
        requireValue(task.connection_id===input.connectionId && task.agent===input.agent && !['revoked','sending','uncertain','running'].includes(task.state),'任务账号不符或上次执行仍需核对。',409);
        const claimed=await this.db.tx(q=>q("UPDATE agent_connector_tasks SET state='sending',payload=$2,updated_at=now() WHERE id=$1 AND state IN ('completed','waiting','stopped') RETURNING id",[task.id,this.db.seal({prompt:input.prompt,files:input.files},task.id)]));
        requireValue(claimed.rows.length,'此任务已有提交或仍在等待接手，请先核对当前进展。',409);
      }
      else {
        const id=randomUUID(); task={id,workspace_id:identity.workspaceId,user_id:identity.userId,connection_id:input.connectionId,agent:input.agent,native_id:null,state:'sending'};
        await this.db.tx(async q=> { const locked=(await q('SELECT revoked_at FROM agent_connector_accounts WHERE id=$1 FOR UPDATE',[account.id])).rows[0]; requireValue(locked && !locked.revoked_at,'连接已撤销。',403); if(input.agent==='workbuddy-local') requireValue(!(await q("SELECT 1 FROM agent_connector_tasks WHERE connection_id=$1 AND state IN ('running','waiting','sending') LIMIT 1",[account.id])).rows.length,'此本地助理已有任务。',409); const n=(await q("SELECT count(*)::int AS n FROM agent_connector_tasks WHERE workspace_id=$1 AND user_id=$2 AND state NOT IN ('completed','revoked','failed','stopped')",this.db.scope(identity))).rows[0].n; requireValue(n<20,'请先处理已有交接，最多同时保留 20 项未结束任务。',409); await q("INSERT INTO agent_connector_tasks(id,workspace_id,user_id,connection_id,agent,state,payload) VALUES($1,$2,$3,$4,$5,'sending',$6)",[id,...this.db.scope(identity),input.connectionId,input.agent,this.db.seal({ prompt:input.prompt,files:input.files },id)]); });
      }
      await this.db.event(task,`input:${input.requestId}`,{ user_message:{ content:input.prompt }, materials:input.files.map(f=>({filename:f.filename,sha256:secretHash(f.file_data || '')})) });
      try {
        if(input.agent==='muse') { await this.db.tx(q=>q("UPDATE agent_connector_tasks SET state='waiting_external',payload=$2,updated_at=now() WHERE id=$1 AND state<>'revoked'",[task.id,this.db.seal({prompt:input.prompt,files:input.files},task.id)])); return { taskId:task.id,state:'waiting_external',url:null }; }
        const {token,account:authorized}=await this.credential(identity,input.connectionId); requireValue(publicAccount(authorized).agents.includes(input.agent),'此连接的权限已变化，请重新授权。',403);
        if(input.agent==='workbuddy-local') {
          requireValue(input.files.length===0,'WorkBuddy 本地助理接口未声明文件附件上传。');
          const other=await this.db.tx(q=>q("SELECT id FROM agent_connector_tasks WHERE connection_id=$1 AND id<>$2 AND state IN ('running','waiting','sending') LIMIT 1",[account.id,task.id])); requireValue(!other.rows.length,'此 WorkBuddy 本地助理已有一项工作台任务，请先处理完毕。',409);
          const online=await this.workbuddy.api(token,'/localassistant'); requireValue(online.online===true,'WorkBuddy 本地助理不在线。',409);
          const receipt=await this.workbuddy.api(token,'/localassistant/message',{content:input.prompt,msg_type:'text'}); requireValue(typeof receipt.message_id==='string','未收到 WorkBuddy 消息标识。',502);
          await this.setState(task.id,'running',null,receipt.message_id); return {taskId:task.id,state:'running',url:null};
        }
        requireValue(this.channels.size<16,'接入服务的电脑任务资源已占用，请稍后重试。',429);
        let ticket;
        if(!task.native_id) { ticket=await this.workbuddy.api(token,'/tasks',{prompt:input.prompt}); requireValue(identifier(ticket.task_id),'未收到 WorkBuddy 云端任务 ID。',502); task.native_id=ticket.task_id; await this.setState(task.id,'preparing',null,ticket.task_id); }
        await this.setState(task.id,'preparing',null);
        return await this.advanceCloud(identity,task,token);
      } catch(error) {
        await this.setState(task.id,'uncertain',{waiting_description:error.message});
        // The service task ID is already durable. Return it even when a provider response was lost;
        // callers can inspect this exact handoff instead of creating a second remote task.
        return {taskId:task.id,state:'uncertain',url:null};
      }
    });
  }
  setState(id,state,waiting,nativeId=null) { return this.db.tx(q=>q("UPDATE agent_connector_tasks SET state=$2,waiting=$3,native_id=COALESCE($4,native_id),updated_at=now() WHERE id=$1 AND state<>'revoked' AND expires_at>now() AND EXISTS(SELECT 1 FROM agent_connector_accounts a WHERE a.id=connection_id AND a.revoked_at IS NULL)",[id,state,waiting ? this.db.seal(waiting,id):null,nativeId])); }
  async advanceCloud(identity,task,accessToken) {
    const ticket=await this.workbuddy.api(accessToken,`/tasks/${task.native_id}`);
    if (!ticket.link || !ticket.token) return {taskId:task.id,state:'preparing',url:null};
    const channel=await this.channel(task,ticket);
    const payload=this.db.open((await this.db.task(identity,task.id)).payload,task.id);
    // Persist the dispatch boundary before sending; a crash here is uncertain and never replays.
    const claimed=await this.db.tx(q=>q("UPDATE agent_connector_tasks SET state='dispatching',updated_at=now() WHERE id=$1 AND state='preparing' AND EXISTS(SELECT 1 FROM agent_connector_accounts a WHERE a.id=connection_id AND a.revoked_at IS NULL) RETURNING id",[task.id]));
    if (!claimed.rows.length) return {taskId:task.id,state:(await this.db.task(identity,task.id)).state,url:null};
    await channel.prompt(payload.prompt,payload.files);
    // A fast final response may already have changed the state; never resurrect a finished task.
    await this.db.tx(q=>q("UPDATE agent_connector_tasks SET state='running',updated_at=now() WHERE id=$1 AND state='dispatching'",[task.id]));
    return {taskId:task.id,state:(await this.db.task(identity,task.id)).state,url:null};
  }
  async channel(task,ticket) {
    const old=this.channels.get(task.id); if(old && !old.closed) { await old.ready; return old; }
    const channel=new WorkBuddyCloudChannel({task,ticket,fetch:this.fetch,onEvent:(key,event)=>this.db.event(task,key,event),onState:(state,waiting)=>this.setState(task.id,state,waiting),onClose:()=>{if(this.channels.get(task.id)===channel)this.channels.delete(task.id);}});
    this.channels.set(task.id,channel);
    try { channel.ready=channel.start(); await channel.ready; return channel; } catch(error) { channel.close(); this.channels.delete(task.id); throw error; }
  }
  async poll(identity,{ taskId,cursor={} }) {
    let task=await this.db.task(identity,taskId); await this.db.connection(identity,task.connection_id);
    if(task.agent==='workbuddy-cloud' && task.state==='preparing' && task.native_id) { try { const {token}=await this.credential(identity,task.connection_id); await this.advanceCloud(identity,task,token); } catch(error) {await this.setState(task.id,'uncertain',{waiting_description:error.message});} task=await this.db.task(identity,taskId); }
    requireValue(Number.isSafeInteger(Number(cursor.sequence || 0)) && Number(cursor.sequence || 0)>=0,'交接游标无效。');
    if(task.agent==='workbuddy-local' && task.native_id && task.state==='running') {
      const {token}=await this.credential(identity,task.connection_id); const messages=await this.workbuddy.api(token,`/localassistant/message?message_id=${encodeURIComponent(cursor.message || task.native_id)}`);
      requireValue(Array.isArray(messages.messages) && messages.messages.length<=100,'本地助理消息增量不可用。',502);
      for(const message of messages.messages) if(message.role==='assistant' && typeof message.message_id==='string') await this.db.event(task,message.message_id,{assistant_message:{content:(message.content||[]).filter(x=>typeof x==='string').join('\n')},source:'shared-local-assistant-stream'});
      if(messages.messages.length) cursor={...cursor,message:messages.messages.at(-1).message_id};
      if(Date.now()-new Date(task.updated_at).getTime()>10*60_000) { await this.setState(task.id,'waiting',{waiting_description:'本地助理接口没有任务结束标记，请在原生应用核对后结束本次查询。'}); task=await this.db.task(identity,taskId); }
    }
    if(task.agent==='workbuddy-cloud' && ['running','waiting','dispatching'].includes(task.state) && (!this.channels.get(task.id) || this.channels.get(task.id).closed)) { await this.setState(task.id,'uncertain',null); task=await this.db.task(identity,taskId); }
    const artifactEvents=[]; let artifactMore=false;
    if(task.agent==='workbuddy-cloud' && task.native_id && task.state!=='preparing') {
      try {
        const {token}=await this.credential(identity,task.connection_id), ticket=await this.workbuddy.api(token,`/tasks/${task.native_id}`);
        // Provider state is a read-only recovery source; never resend a prompt to recover events.
        // An old completed task cannot confirm whether the latest uncertain prompt was received.
        if(ticket.link && ticket.token) {
          const offset=Number(cursor.artifactOffset||0); requireValue(Number.isSafeInteger(offset)&&offset>=0&&offset<500,'成果游标无效。');
          const page=await this.workbuddy.artifacts(ticket,task.native_id,offset);
          let consumed=0,artifactBytes=0;
          for(const entry of page.artifacts) {
            const estimated=Buffer.byteLength(JSON.stringify(entry)); if(artifactBytes+estimated>300_000&&consumed) break; artifactBytes+=estimated; consumed++;
            const a=entry.artifact; if(!a || typeof a.uri!=='string' || a.uri.length>4096 || entry.sessionId!==task.native_id) continue;
            const key=`artifact:${secretHash(`${a.uri}:${a.updatedAt || entry.md5 || ''}`)}`;
            if(entry.event==='deleted') { artifactEvents.push({id:key,removedArtifact:a.uri}); continue; }
            if(a.type==='media') {
              const metadata={filename:String(a.name||'result').slice(0,200),file_uid:a.uri,managed_uri:a.uri};
              if(typeof entry.url==='string'&&entry.url.startsWith('https://')) metadata.url=entry.url;
              artifactEvents.push({id:key,assistant_message:{content:`成果：${String(a.title||a.name||'文件').slice(0,200)}`,attachments:[metadata]}});
            } else if(['plan','overview'].includes(a.type)&&typeof a.text==='string') artifactEvents.push({id:key,assistant_message:{content:a.text.slice(0,40_000)+(a.text.length>40_000?'\n[这里只同步前 40,000 字符，请在原生服务查看完整成果。]':'')}});
          }
          artifactMore=page.pagination?.hasMore===true||consumed<page.artifacts.length;
          requireValue(!artifactMore||offset+consumed<500,'本次成果超过 500 项，请在原生服务核对。',413);
          cursor={...cursor,artifactOffset:artifactMore?offset+consumed:0};
        }
      }catch(error){artifactEvents.push({id:'artifact-sync-unavailable',error_message:{content:`成果同步未完成：${error.message} 请刷新查询；不会重新执行任务。`}});}
    }
    // Do not return decrypted results after a concurrent account revocation.
    await this.db.connection(identity,task.connection_id);
    const rows=(await this.db.tx(q=>q('SELECT sequence,event_key,payload FROM agent_connector_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 50',[task.id,Number(cursor.sequence||0)]))).rows;
    const selected=[]; let eventBytes=0;
    for(const row of rows) {const event={id:row.event_key,...this.db.open(row.payload,task.id)},bytes=Buffer.byteLength(JSON.stringify(event));if(eventBytes+bytes>1_000_000)break;eventBytes+=bytes;selected.push({row,event});}
    const eventMore=selected.length<rows.length||rows.length===50;
    const requests=(await this.db.tx(q=>q("SELECT id,input,status,result FROM agent_connector_local_requests WHERE task_id=$1 AND status='pending' ORDER BY created_at LIMIT 5",[task.id]))).rows;
    return {state:(artifactMore||eventMore)&&task.state==='completed'?'syncing':task.state,events:[...selected.map(v=>v.event),...artifactEvents],cursor:{...cursor,sequence:Number(selected.at(-1)?.row.sequence || cursor.sequence || 0)},waiting:task.waiting ? this.db.open(task.waiting,task.id):null,nativeTaskId:task.native_id,localRequests:requests.map(r=>({id:r.id,input:this.db.open(r.input,task.id)})),more:eventMore||artifactMore,url:null};
  }
  async download(identity,{taskId,uri}) {
    const task=await this.db.task(identity,taskId); requireValue(task.agent==='workbuddy-cloud' && task.native_id,'此交接没有云端成果。');
    const {token}=await this.credential(identity,task.connection_id),ticket=await this.workbuddy.api(token,`/tasks/${task.native_id}`);
    let found;
    for(let offset=0;offset<500;offset+=50) { const page=await this.workbuddy.artifacts(ticket,task.native_id,offset); found=page.artifacts.find(e=>e.sessionId===task.native_id&&e.artifact?.uri===uri&&e.event!=='deleted'); if(found||!page.pagination?.hasMore)break; }
    requireValue(found?.artifact?.type==='media','成果不属于此任务或已移除。',404);
    const bytes=await this.workbuddy.artifactBytes(ticket,task.native_id,uri);
    await this.db.connection(identity,task.connection_id);
    return {base64:bytes.toString('base64'),sha256:secretHash(bytes),bytes:bytes.length};
  }
  async action(identity,input) {
    const task=await this.db.task(identity,input.taskId); await this.db.connection(identity,task.connection_id);
    return this.mutate(identity,input,async()=>{
      if(input.operation==='withdraw' && task.agent==='muse') { await this.setState(task.id,'revoked',null); return {requested:true,remoteOperationsMayContinue:true}; }
      if(input.operation==='finish' && task.agent==='workbuddy-local' && input.acknowledged===true) { await this.setState(task.id,'completed',null); return {confirmedByUser:true}; }
      if(input.operation==='resolve' && task.agent==='workbuddy-cloud') {
        requireValue(task.state==='uncertain' && input.acknowledged===true && ['completed','stopped'].includes(input.outcome),'请先核对原生任务和最近一次输入的实际结果。',409);
        const nativeId=task.native_id||input.nativeId;
        requireValue(identifier(nativeId) && (!task.native_id||!input.nativeId||input.nativeId===task.native_id),'请填写已核对的原生任务 ID。');
        const {token}=await this.credential(identity,task.connection_id),ticket=await this.workbuddy.api(token,`/tasks/${nativeId}`);
        requireValue(ticket.task_id===nativeId,'无法核验此账号的原生任务。',403);
        await this.db.event(task,`resolved:${input.requestId}`,{assistant_message:{content:`用户已在 WorkBuddy 核对最近一次输入，确认任务${input.outcome==='completed'?'完成':'停止'}。未重新发送原任务。`},confirmedByUser:true});
        this.channels.get(task.id)?.close();
        await this.setState(task.id,input.outcome,null,nativeId);return {confirmedByUser:true,nativeTaskId:nativeId};
      }
      let channel=this.channels.get(task.id); if(input.operation==='stop'&&task.agent==='workbuddy-cloud'&&task.native_id&&(!channel||channel.closed)) {const {token}=await this.credential(identity,task.connection_id);channel=await this.channel(task,await this.workbuddy.api(token,`/tasks/${task.native_id}`));}
      requireValue(channel && !channel.closed,'此任务实时通道不可用，请在原生应用核对后处理。',409);
      if(input.operation==='stop') return channel.stop();
      if(input.operation==='approve') return channel.approve(input.input);
      throw new ConnectorError('不支持这项 Agent 操作。');
    });
  }
  async createMuse(identity,input) {
    requireValue(input.acknowledged===true,'请确认创建可读取选定交接材料的 Muse 连接器凭据。');
    return this.mutate(identity,input,async()=>{
      const id=randomUUID(), token=randomBytes(32).toString('base64url');
      const count=await this.connections(identity); requireValue(count.connections.length<12,'最多保存 12 个托管连接。');
      await this.db.tx(q=>q("INSERT INTO agent_connector_accounts(id,workspace_id,user_id,provider,name,connector_key_hash,expires_at) VALUES($1,$2,$3,'muse','Muse 任务收件箱',$4,now()+interval '30 days')",[id,...this.db.scope(identity),secretHash(token)]));
      return {id,token,endpoint:`${this.origin}/api/workbench/v1/agent-connectors/muse`,expiresInDays:30,verification:'registration-required'};
    });
  }
  async muse(token,operation,input) {
    requireValue(typeof token==='string' && token.length<=200,'Muse 连接器凭据无效。',401);
    const account=(await this.db.tx(q=>q("SELECT * FROM agent_connector_accounts WHERE provider='muse' AND connector_key_hash=$1 AND revoked_at IS NULL AND expires_at>now()",[secretHash(token)]))).rows[0]; requireValue(account,'Muse 连接器授权已失效。',401);
    if(operation==='inbox') return {tasks:(await this.db.tx(q=>q("SELECT id,state,created_at FROM agent_connector_tasks WHERE connection_id=$1 AND state IN ('waiting_external','running','waiting') AND expires_at>now() ORDER BY created_at LIMIT 20",[account.id]))).rows};
    const identity={workspaceId:account.workspace_id,userId:account.user_id},task=await this.db.task(identity,input.taskId); requireValue(task.connection_id===account.id && task.agent==='muse' && !['revoked','failed'].includes(task.state) && (task.state!=='completed'||operation==='local.result') && new Date(task.expires_at)>new Date(),'该交接不属于此 Muse 连接器或已关闭。',403);
    if(operation==='pickup') { requireValue(input.confirmedByUser===true,'首次接手需要用户在 Muse 确认。'); await this.setState(task.id,'running',null); return {taskId:task.id,...this.db.open(task.payload,task.id)}; }
    if(operation==='progress' || operation==='result') { requireValue(identifier(input.eventId) && typeof input.text==='string' && input.text.length<=100_000,'进展内容无效。'); const attachments=input.attachments||[]; requireValue(Array.isArray(attachments)&&attachments.length<=20&&attachments.every(a=>a&&typeof a.filename==='string'&&a.filename.length<=200&&typeof a.url==='string'&&a.url.length<=4096&&a.url.startsWith('https://')),'成果附件格式无效。'); if(operation==='result') {const pending=await this.db.tx(q=>q("SELECT 1 FROM agent_connector_local_requests WHERE task_id=$1 AND status='pending' LIMIT 1",[task.id]));requireValue(!pending.rows.length,'仍有本机操作等待批准，不能报告任务完成。',409);} await this.db.event(task,input.eventId,{assistant_message:{content:input.text,attachments}}); if(operation==='result') await this.setState(task.id,'completed',null); return {received:true}; }
    if(operation==='local.request') {
      requireValue(identifier(input.requestId) && ['documents','computer'].includes(input.tool) && typeof input.reason==='string' && input.reason.length<=4000 && Buffer.byteLength(JSON.stringify(input.arguments||{}))<=100_000,'本机操作请求无效。');
      const value={tool:input.tool,reason:input.reason,arguments:input.arguments||{}};
      await this.db.tx(async q=>{ const existing=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1',[input.requestId])).rows[0]; if(existing) {requireValue(existing.task_id===task.id&&JSON.stringify(this.db.open(existing.input,task.id))===JSON.stringify(value),'操作请求标识已被使用。',409);return;} const n=(await q("SELECT count(*)::int AS n FROM agent_connector_local_requests WHERE task_id=$1 AND status='pending'",[task.id])).rows[0].n; requireValue(n<5,'已有本机请求等待批准。',429); await q('INSERT INTO agent_connector_local_requests(id,task_id,input) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.requestId,task.id,this.db.seal(value,task.id)]); const old=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1',[input.requestId])).rows[0]; requireValue(old.task_id===task.id && JSON.stringify(this.db.open(old.input,task.id))===JSON.stringify(value),'操作请求标识已被使用。',409); });
      await this.setState(task.id,'waiting',{waiting_description:'Muse 请求本机操作，请在工作台查看范围后批准。'}); return {waitingForDesktop:true};
    }
    if(operation==='local.result') { const row=(await this.db.tx(q=>q('SELECT status,result FROM agent_connector_local_requests WHERE id=$1 AND task_id=$2',[input.requestId,task.id]))).rows[0]; requireValue(row,'本机请求不存在。',404); return {status:row.status,result:row.result ? this.db.open(row.result,task.id):null}; }
    throw new ConnectorError('未知 Muse 连接器操作。');
  }
  async localResult(identity,input) {
    const task=await this.db.task(identity,input.taskId); await this.db.connection(identity,task.connection_id);
    requireValue(['completed','denied','uncertain','failed'].includes(input.status) && Buffer.byteLength(JSON.stringify(input.result))<=512_000,'本机结果无效。');
    await this.db.tx(async q=>{ const row=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1 AND task_id=$2 FOR UPDATE',[input.localRequestId,task.id])).rows[0]; requireValue(row,'本机请求不存在。',404); if(row.status!=='pending') { requireValue(row.status===input.status && JSON.stringify(this.db.open(row.result,task.id))===JSON.stringify(input.result),'已有结果不能覆盖。',409); return; } await q('UPDATE agent_connector_local_requests SET status=$2,result=$3 WHERE id=$1',[row.id,input.status,this.db.seal(input.result,task.id)]); }); return {received:true};
  }
  async close() { for(const channel of this.channels.values()) channel.close(); this.channels.clear(); }
}
