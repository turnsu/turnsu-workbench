import { randomUUID } from 'node:crypto';
import { Check, CreateMemberAgentRequestDataSchema, CursorPageRequestSchema, AcceptMemberAgentRequestDataSchema, DeliverMemberAgentOutputDataSchema } from '@looloomi/workbench-contracts';
import { canonicalRequestHash } from '../store/serialization.mjs';
import { ProductStoreError } from '../store/errors.mjs';
import { requireWorkItemRunAccess } from '../work-items/postgres-work-item-runs.mjs';
import { revokeMemberAgentRequests } from './revoke-member-agent-requests.mjs';
import { parseSkillPackage } from '../skills/skill-package-format.mjs';
import { ExecutionBrokerError } from '../execution/execution-broker.mjs';
const PROFILE = 'pi-declared-text-v1';
const fail = code => { throw new ProductStoreError(code, code); };
const iso = value => new Date(value).toISOString();
const terminal = status => !['queued','running','cancellation_requested'].includes(status);

/** Explicit consent owns business intent; Broker alone owns execution and settlement. */
export class PostgresMemberAgentService {
  constructor({store,authorizer,dispatcher,readSkillPackage,readLoopPackage,idFactory=kind=>`${kind}-${randomUUID()}`,clock=()=>new Date().toISOString()}) {
    Object.assign(this,{store,authorizer,dispatcher,readSkillPackage,readLoopPackage,idFactory,clock});
    this.sql=store.bindAdapter(({execute})=>({query:(uow,text,values=[])=>execute(uow,{text,values})}));
    this.active=new Map();
    this.backend={execute:args=>this.executeTransport(args),cancel:async({invocationId})=>this.active.has(invocationId)?{status:'cancelled'}:{status:'partial'}};
  }
  transaction(work) { return this.store.withTransaction(uow=>work((text,values)=>this.sql.query(uow,text,values),uow)); }
  async command(query,uow,context,action,requestId,intent) {
    const authority=await this.authorizer.authorizeMemberAgentRequest({workspaceId:context.workspaceId,userId:context.userId,actionId:action,intent,uow});
    const now=iso((await query('SELECT clock_timestamp() AS now')).rows[0].now), commandId=this.idFactory('product-command');
    const revision=action.endsWith('_create')?1:Number((await query('SELECT revision FROM public.member_agent_requests WHERE workspace_id=$1 AND request_id=$2',[context.workspaceId,requestId])).rows[0].revision)+1;
    await query(`INSERT INTO public.product_commands(command_id,workspace_id,scope_id,actor_principal_id,actor_principal_kind,effective_principal_id,effective_principal_kind,authorization_decision_id,policy_revision_id,effect_class,argument_digest,quota_user_id,schema_version,kind,target_kind,target_id,target_revision,status,created_at,updated_at,finished_at,payload)
      VALUES($1,$2,$3,$4,'user',$4,'user',$5,$6,$7,$8,$4,'workbench-v1',$9,'member_agent_request',$10,$14,$11,$12,$12,$13,'{}')`,[commandId,context.workspaceId,authority.scopeId,context.userId,authority.authorizationDecisionId,authority.policyRevisionId,action.endsWith('_accept')?'execute':'write_local',authority.argumentDigest,action,requestId,action.endsWith('_accept')?'accepted':'completed',now,action.endsWith('_accept')?null:now,revision]);
    return commandId;
  }
  async row(query,{context,workItemId,requestId},lock=false) {
    await requireWorkItemRunAccess(query,{context,workItemId});
    const row=(await query(`SELECT * FROM public.member_agent_requests WHERE workspace_id=$1 AND work_item_id=$2 AND request_id=$3 ${lock?'FOR UPDATE':''}`,[context.workspaceId,workItemId,requestId])).rows[0];
    if(!row||![row.requester_user_id,row.provider_user_id].includes(context.userId)) fail('member_agent_request_not_found');
    return row;
  }
  async both(query,row,write=true) {
    for(const userId of [row.requester_user_id,row.provider_user_id]) await requireWorkItemRunAccess(query,{context:{workspaceId:row.workspace_id,userId},workItemId:row.work_item_id,write});
  }
  async receipt(query,context,scope,key,hash) {
    if(!key) fail('member_agent_request_invalid');
    await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`${context.workspaceId}:${context.userId}:${scope}:${key}`]);
    const old=(await query('SELECT request_hash,response FROM public.product_idempotency_receipts WHERE workspace_id=$1 AND effective_principal_id=$2 AND operation_scope=$3 AND idempotency_key=$4',[context.workspaceId,context.userId,scope,key])).rows[0];
    if(old&&old.request_hash!==hash) fail('idempotency_key_reused');
    return old?.response??null;
  }
  async saveReceipt(query,context,scope,key,hash,response) {
    await query(`INSERT INTO public.product_idempotency_receipts(workspace_id,effective_principal_id,operation_scope,idempotency_key,request_hash,response,created_at,completed_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp())`,[context.workspaceId,context.userId,scope,key,hash,JSON.stringify(response)]);
  }
  async method(context,method) {
    const release=await this.transaction(async q=>(await q(`SELECT asset_kind,native_loop_version_id FROM public.workspace_asset_releases WHERE release_id=$1 AND source_workspace_id IN ($2,'system-catalog') AND visibility='workspace'`,[method.releaseId,context.workspaceId])).rows[0]);
    if(!release) fail('member_agent_method_unavailable');
    const readSkill=async releaseId=>{
      const pack=await this.readSkillPackage({workspaceId:context.workspaceId,userId:context.userId,releaseId});
      const files=parseSkillPackage(Buffer.from(pack.packageContentBase64,'base64'));
      // This first profile has no file-read tools. Only a self-contained text instruction is supported.
      if(!files.some(f=>f.path==='SKILL.md')||files.some(f=>!/(\.md|\.txt)$/i.test(f.path))) fail('member_agent_method_unsupported');
      return {pack,text:files.map(f=>`Published text: ${f.path}\n${new TextDecoder('utf-8',{fatal:true}).decode(f.content)}`).join('\n\n')};
    };
    let value,text;
    if(release.asset_kind==='skill') {const skill=await readSkill(method.releaseId);value=skill.pack;text=skill.text;}
    else if(release.native_loop_version_id) {
      value=await this.readLoopPackage({workspaceId:context.workspaceId,userId:context.userId,releaseId:method.releaseId});
      const skills=[];for(const pin of value.skillPins) skills.push((await readSkill(pin.releaseId)).text);
      text=`Follow this reviewed recipe as guidance. It is not an enforced DAG.\n${JSON.stringify(value.recipe)}\n\n${skills.join('\n\n')}`;
    } else fail('member_agent_method_unsupported');
    if(value.versionId!==method.versionId||value.contentHash!==method.contentHash) fail('member_agent_method_changed');
    if(!text.trim()||text.length>57000) fail('member_agent_method_unsupported');
    return text;
  }
  async dispose() {
    const states=[...this.active.values()];
    for(const state of states)state.result.reject(new ExecutionBrokerError('member_agent_transport_disconnected','Member execution transport ended.',{status:'partial'}));
    await Promise.allSettled(states.map(state=>state.completion));
  }
  async recover() {
    const recovered=await this.dispatcher.recoverMemberAgentRequests();
    await this.transaction(async q=>{
      for(const item of recovered) await q(`UPDATE public.product_commands SET status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE invocation_id=$1 AND status IN ('accepted','running','cancellation_requested')`,[item.invocationId]);
      await q(`UPDATE public.product_commands c SET status='failed',finished_at=clock_timestamp(),updated_at=clock_timestamp() FROM public.member_agent_requests r JOIN public.execution_invocations i ON i.invocation_id=r.invocation_id WHERE c.command_id=r.accept_command_id AND c.status IN ('accepted','running','cancellation_requested') AND i.status='partial' AND i.payload->'result'->>'failureCode'='member_agent_restart_outcome_unknown'`);
      await q(`UPDATE public.product_commands c SET status='blocked',finished_at=clock_timestamp(),updated_at=clock_timestamp() FROM public.member_agent_requests r WHERE c.command_id=r.accept_command_id AND r.invocation_id IS NULL AND c.status='accepted'`);
    });
    return recovered;
  }
  async create({context,workItemId,request,idempotencyKey}) {
    const data=request?.data;if(!Check(CreateMemberAgentRequestDataSchema,data)||data.inputs.some(x=>!x.text.trim())||context.userId===data.providerUserId||new Set(data.inputs.map(x=>x.id)).size!==data.inputs.length||Buffer.byteLength(JSON.stringify(data.inputs))>128000) fail('member_agent_request_invalid');
    const instructions=await this.method(context,data.method);
    await this.method({...context,userId:data.providerUserId},data.method);
    const scope=`member-agent-create:${workItemId}`,hash=canonicalRequestHash({workItemId,request});
    return this.transaction(async(q,uow)=>{
      const provisional={workspace_id:context.workspaceId,work_item_id:workItemId,requester_user_id:context.userId,provider_user_id:data.providerUserId};await this.both(q,provisional);
      const old=await this.receipt(q,context,scope,idempotencyKey,hash);if(old)return {...old,...await this.methodDisplay(q,context.workspaceId,old.method)};
      const now=iso((await q('SELECT clock_timestamp() AS now')).rows[0].now);
      if(Date.parse(data.expiresAt)<=Date.parse(now)||Date.parse(data.expiresAt)>Date.parse(now)+86400000) fail('member_agent_request_invalid');
      const requestId=this.idFactory('agent-request'),requestDigest=canonicalRequestHash({workspaceId:context.workspaceId,workItemId,requesterUserId:context.userId,...data,instructions});
      const commandId=await this.command(q,uow,context,'member_agent_request_create',requestId,{workItemId,requestId,requestDigest,...data});
      await q(`INSERT INTO public.member_agent_requests(workspace_id,request_id,work_item_id,requester_user_id,provider_user_id,request_digest,contract,instructions,create_command_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[context.workspaceId,requestId,workItemId,context.userId,data.providerUserId,requestDigest,JSON.stringify(data),instructions,commandId,data.expiresAt,now]);
      const value=await this.view(q,{...provisional,request_id:requestId,request_digest:requestDigest,contract:data,consent:'pending',created_at:now,expires_at:data.expiresAt,invocation_id:null});
      await this.saveReceipt(q,context,scope,idempotencyKey,hash,value);return value;
    });
  }
  async methodDisplay(q,workspaceId,method) {
    // Immutable version metadata keeps history readable after a new private draft or deprecation.
    const value=(await q(`SELECT release.version AS "methodVersion",
        COALESCE(skill.definition->>'name',native.recipe->>'name') AS "methodName"
      FROM public.workspace_asset_releases release
      LEFT JOIN public.skill_versions skill ON skill.workspace_id=release.source_workspace_id
        AND skill.skill_version_id=release.skill_version_id AND skill.content_hash=release.content_hash
      LEFT JOIN public.native_loop_versions native ON native.workspace_id=release.source_workspace_id
        AND native.version_id=release.native_loop_version_id AND native.content_hash=release.content_hash
      WHERE release.release_id=$1 AND release.version_id=$2 AND release.content_hash=$3
        AND release.source_workspace_id IN ($4,'system-catalog')`,[method.releaseId,method.versionId,method.contentHash,workspaceId])).rows[0];
    if(!value?.methodName||!value.methodVersion)fail('member_agent_method_unavailable');
    return value;
  }
  async list({context,workItemId,query={}}) {
    if(!Check(CursorPageRequestSchema,query))fail('member_agent_request_invalid');
    const limit=query.limit??25;
    const scope=canonicalRequestHash({workspaceId:context.workspaceId,workItemId,userId:context.userId});
    let anchorId=null;
    if(query.cursor) {
      try {
        const decoded=Buffer.from(query.cursor,'base64url');
        if(decoded.toString('base64url')!==query.cursor)throw new Error();
        const cursor=JSON.parse(decoded.toString('utf8'));
        if(cursor.scope!==scope||typeof cursor.id!=='string'||!cursor.id.match(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)||Object.keys(cursor).length!==2)throw new Error();
        anchorId=cursor.id;
      } catch {fail('member_agent_cursor_invalid');}
    }
    return this.transaction(async q=>{
      await requireWorkItemRunAccess(q,{context,workItemId});
      let anchorTime=null;
      if(anchorId) {
        // Keep PostgreSQL microsecond precision; do not round the cursor through a JS Date.
        const anchor=(await q(`SELECT created_at::text AS created_at FROM public.member_agent_requests
          WHERE workspace_id=$1 AND work_item_id=$2 AND request_id=$3
            AND (requester_user_id=$4 OR provider_user_id=$4)`,[context.workspaceId,workItemId,anchorId,context.userId])).rows[0];
        if(!anchor)fail('member_agent_cursor_invalid');
        anchorTime=anchor.created_at;
      }
      // Each side uses its own member index. No workspace-wide request projection or filtering in JS.
      const branch=role=>`SELECT * FROM public.member_agent_requests WHERE workspace_id=$1 AND work_item_id=$2 AND ${role}=$3
        AND ($4::timestamptz IS NULL OR (created_at,request_id)<($4::timestamptz,$5::text)) ORDER BY created_at DESC,request_id DESC LIMIT $6`;
      const rows=(await q(`SELECT * FROM ((${branch('requester_user_id')}) UNION ALL (${branch('provider_user_id')})) visible
        ORDER BY created_at DESC,request_id DESC LIMIT $6`,[context.workspaceId,workItemId,context.userId,anchorTime,anchorId,limit+1])).rows;
      const page=rows.slice(0,limit),items=[];
      for(const row of page)items.push(await this.view(q,row));
      return {items,nextCursor:rows.length>limit?Buffer.from(JSON.stringify({scope,id:page.at(-1).request_id})).toString('base64url'):null};
    });
  }
  async view(q,row) {
    const invocation=row.invocation_id?(await q(`SELECT status,payload FROM public.execution_invocations WHERE workspace_id=$1 AND invocation_id=$2`,[row.workspace_id,row.invocation_id])).rows[0]:null;
    return {requestId:row.request_id,workspaceId:row.workspace_id,workItemId:row.work_item_id,requesterUserId:row.requester_user_id,providerUserId:row.provider_user_id,requestDigest:row.request_digest,method:row.contract.method,...await this.methodDisplay(q,row.workspace_id,row.contract.method),goal:row.contract.goal,inputs:row.contract.inputs,limits:row.contract.limits,expiresAt:iso(row.expires_at),consent:row.consent,createdAt:iso(row.created_at),invocationId:row.invocation_id??null,executionStatus:invocation?.status??null,executionReasonCode:invocation?.payload?.result?.failureCode??null,output:invocation?.status==='completed'?invocation.payload?.result?.output?.text??null:null};
  }
  get(args){return this.transaction(async q=>this.view(q,await this.row(q,args)));}
  async device(q,context,deviceId) {
    if(context.clientKind!=='desktop'||!context.clientSessionId||!context.devicePublicKey)fail('device_native_session_required');
    const row=(await q(`SELECT d.device_id FROM public.devices d JOIN public.native_client_sessions s ON s.client_session_id=d.native_client_session_id WHERE d.workspace_id=$1 AND d.device_id=$2 AND d.owner_user_id=$3 AND d.native_client_session_id=$4 AND d.registration_status='active' AND s.status='active' AND s.client_kind='desktop' AND s.device_public_key=$5 AND s.expires_at>clock_timestamp() FOR SHARE OF d,s`,[context.workspaceId,deviceId,context.userId,context.clientSessionId,context.devicePublicKey])).rows[0];
    if(!row)fail('member_agent_device_forbidden');
  }
  async accept(args) {
    const {context,workItemId,requestId,request,idempotencyKey}=args,data=request?.data;
    if(!Check(AcceptMemberAgentRequestDataSchema,data))fail('member_agent_request_invalid');
    const scope=`member-agent-accept:${requestId}`,hash=canonicalRequestHash({workItemId,requestId,request});let created=false;
    // Recheck the exact public package without holding Product row locks across object-store IO.
    const current=await this.transaction(q=>this.row(q,args));await this.method(context,current.contract.method);
    const ticket=await this.transaction(async(q,uow)=>{
      const row=await this.row(q,args,true);await this.both(q,row);if(context.userId!==row.provider_user_id)fail('member_agent_provider_required');await this.device(q,context,data.deviceId);
      if(row.consent==='revoked')fail('member_agent_request_revoked');
      const old=await this.receipt(q,context,scope,idempotencyKey,hash);if(old){
        const command=(await q('SELECT status FROM public.product_commands WHERE command_id=$1',[old.commandId])).rows[0];
        if(!row.invocation_id&&command?.status==='blocked')fail('member_agent_registration_interrupted');
        return old;
      }
      if(row.consent!=='pending')fail('member_agent_request_decided');
      const now=Date.now();if(Date.parse(row.expires_at)<=now)fail('member_agent_request_expired');
      if(data.requestDigest!==row.request_digest)fail('member_agent_request_changed');
      for(const key of Object.keys(data.limits))if(data.limits[key]>row.contract.limits[key])fail('member_agent_limits_invalid');
      const commandId=await this.command(q,uow,context,'member_agent_request_accept',requestId,{workItemId,requestId,...data});
      const ticket={workspaceId:context.workspaceId,workItemId,requestId,requestDigest:row.request_digest,providerUserId:context.userId,deviceId:data.deviceId,commandId,invocationId:this.idFactory('invocation'),attemptId:this.idFactory('attempt'),fence:1,profile:PROFILE,expiresAt:new Date(Math.min(Date.parse(row.expires_at),now+data.limits.timeoutMs)).toISOString(),selectedModel:data.selectedModel,limits:data.limits,instructions:`Task: ${row.contract.goal}\n\n${row.instructions}`,inputs:row.contract.inputs};
      await q(`UPDATE public.member_agent_requests SET consent='accepted',revision=revision+1,accept_command_id=$3,device_id=$4,native_client_session_id=$5,ticket=$6 WHERE workspace_id=$1 AND request_id=$2`,[context.workspaceId,requestId,commandId,data.deviceId,context.clientSessionId,JSON.stringify(ticket)]);
      await this.saveReceipt(q,context,scope,idempotencyKey,hash,ticket);created=true;return ticket;
    });
    if(created)await this.start(ticket,context);
    return ticket;
  }
  async start(ticket,context) {
    const request={schemaVersion:'workbench-execution-fabric-v1',invocationId:ticket.invocationId,attemptId:ticket.attemptId,workspaceId:ticket.workspaceId,actor:{userId:ticket.providerUserId},lineage:{productCommandId:ticket.commandId},controller:{kind:'member_agent_request',controllerId:ticket.requestId,fence:1},mode:'bounded_agent',isolation:'remote',goal:'Perform the explicitly accepted declared-text task.',input:{inputs:ticket.inputs},resultSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},evidenceRequirements:[],metadata:{profile:PROFILE,requestDigest:ticket.requestDigest,usageAccounting:'local_unmetered'},limits:{...ticket.limits,maxSteps:100,maxChildren:0,maxInputBytes:262144,maxImageCount:0,maxCostUsdMicros:null},capabilities:{toolAllowlist:['read_input','write_result'],connectionIds:[],network:false,filesystem:'none',externalActions:false}};
    const state={ticket,context,started:Promise.withResolvers(),result:Promise.withResolvers(),delivering:false,payloadHash:null,job:null};this.active.set(ticket.invocationId,state);
    try {
      const prepared=await this.dispatcher.prepareExecution(request);
      await this.transaction(async q=>{const row=await this.row(q,{context,workItemId:ticket.workItemId,requestId:ticket.requestId},true);await this.both(q,row);if(row.consent!=='accepted')fail('member_agent_request_revoked');await q('UPDATE public.member_agent_requests SET invocation_id=$3 WHERE workspace_id=$1 AND request_id=$2',[ticket.workspaceId,ticket.requestId,ticket.invocationId]);});
      state.job=this.dispatcher.execute(request,{preparedExecution:prepared,deferSettlement:true});
      state.completion=state.job.then(async deferred=>{
        // A terminal result can arrive before the backend opens (e.g. permission/capacity failure).
        state.started.reject(new ProductStoreError('member_agent_execution_unavailable'));
        if(!state.delivering)await this.settleBackground(state,deferred);
      },error=>{state.started.reject(error);}).catch(()=>{});
      await state.started.promise;
    } catch(error) {this.active.delete(ticket.invocationId);await this.dispatcher.cancel(ticket.invocationId,{reason:'member_agent_admission_failed'}).catch(()=>{});await this.transaction(q=>q(`UPDATE public.product_commands SET status='blocked',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE command_id=$1 AND status='accepted'`,[ticket.commandId]));throw error;}
  }
  async executeTransport({request,lease,signal}) {
    const state=this.active.get(request.invocationId);if(!state||request.controller.kind!=='member_agent_request'||request.metadata.profile!==PROFILE)throw new ExecutionBrokerError('member_agent_execution_unavailable');
    state.lease=lease;state.started.resolve();
    const abort=()=>state.result.reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const timer=setInterval(()=>this.check({context:state.context,workItemId:state.ticket.workItemId,requestId:state.ticket.requestId}).catch(()=>{void this.dispatcher.cancel(request.invocationId,{reason:'member_agent_authority_revoked'}).catch(()=>{});}),1000);timer.unref();
    try {return await state.result.promise;}finally{clearInterval(timer);signal.removeEventListener('abort',abort);}
  }
  async authorized(q,args,{allowTerminal=false}={}) {
    const row=await this.row(q,args,true);if(args.context.userId!==row.provider_user_id)fail('member_agent_provider_required');await this.device(q,args.context,row.device_id);
    if(row.native_client_session_id!==args.context.clientSessionId)fail('member_agent_device_forbidden');
    if(row.consent!=='accepted')fail('member_agent_request_revoked');
    const inv=(await q(`SELECT i.status,i.attempt_id,i.execution_fence,i.capability_lease_id,l.status AS lease_status,l.expires_at,i.payload,a.status AS attempt_status,a.fence AS attempt_fence,l.fence AS lease_fence,c.status AS command_status,capacity.status AS capacity_status,capacity.expires_at AS capacity_expires_at,capacity.fence AS capacity_fence,i.capacity_fence AS expected_capacity_fence FROM public.execution_invocations i JOIN public.capability_leases l ON l.capability_lease_id=i.capability_lease_id JOIN public.execution_attempts a ON a.attempt_id=i.attempt_id JOIN public.product_commands c ON c.command_id=i.product_command_id JOIN public.capacity_leases capacity ON capacity.capacity_lease_id=i.capacity_lease_id WHERE i.workspace_id=$1 AND i.invocation_id=$2`,[row.workspace_id,row.invocation_id])).rows[0];
    if(!inv)fail('member_agent_execution_unavailable');
    await this.both(q,row,!terminal(inv.status));
    if(allowTerminal&&terminal(inv.status))return {row,inv};
    if(!['queued','running'].includes(inv.status)||!this.active.has(row.invocation_id))fail('member_agent_execution_unavailable');
    if(Date.parse(row.ticket.expiresAt)<=Date.now()||Date.parse(inv.expires_at)<=Date.now()||Date.parse(inv.capacity_expires_at)<=Date.now())fail('member_agent_request_expired');
    if(inv.lease_status!=='active'||inv.capacity_status!=='active'||!['accepted','running'].includes(inv.command_status)||!['queued','running'].includes(inv.attempt_status)||Number(inv.attempt_fence)!==Number(inv.execution_fence)||Number(inv.lease_fence)!==Number(inv.execution_fence)||Number(inv.capacity_fence)!==Number(inv.expected_capacity_fence))fail('member_agent_request_revoked');
    return {row,inv};
  }
  async check(args) {return this.transaction(async q=>{const {row,inv}=await this.authorized(q,args);return {active:true,ticket:row.ticket,lease:{capabilityLeaseId:inv.capability_lease_id,fence:Number(inv.execution_fence),expiresAt:new Date(Math.min(Date.parse(row.ticket.expiresAt),Date.parse(inv.expires_at),Date.now()+3000)).toISOString(),checkedAt:iso(this.clock())}};});}
  async deliver(args) {
    const data=args.request?.data;if(!Check(DeliverMemberAgentOutputDataSchema,data))fail('member_agent_request_invalid');
    const hash=canonicalRequestHash(data),scope=`member-agent-output:${args.requestId}`;let deferred=null;
    const value=await this.transaction(async(q,uow)=>{
      const {row,inv}=await this.authorized(q,args,{allowTerminal:true});
      const old=await this.receipt(q,args.context,scope,args.idempotencyKey,hash);if(old)return old;
      if(data.invocationId!==row.invocation_id||data.attemptId!==inv.attempt_id||data.fence!==Number(inv.execution_fence))fail('member_agent_execution_mismatch');
      if(terminal(inv.status))fail('member_agent_execution_finished');
      await this.authorized(q,args);
      const state=this.active.get(row.invocation_id);
      if(state.payloadHash&&state.payloadHash!==hash)fail('member_agent_output_changed');
      if(data.outcome==='result'&&(!data.output.trim()||Buffer.byteLength(data.output)>row.ticket.limits.maxOutputBytes))fail('member_agent_output_invalid');
      state.delivering=true;state.payloadHash=hash;
      state.result.resolve(data.outcome==='result'?{status:'completed',output:{text:data.output},summary:'Declared work result received.'}:{status:data.outcome==='interrupted'?'partial':'failed',summary:'The local execution did not complete.'});
      deferred=await state.job;
      const result=await this.dispatcher.settleExecution(deferred,{uow});
      await this.finishCommand(q,row.accept_command_id,result.status);
      const receipt={deliveryId:data.deliveryId,invocationId:data.invocationId,attemptId:data.attemptId,fence:data.fence,resultHash:hash,executionStatus:result.status};
      await this.saveReceipt(q,args.context,scope,args.idempotencyKey,hash,receipt);return receipt;
    });
    if(deferred){this.dispatcher.confirmExecutionSettlement(deferred);this.active.delete(data.invocationId);}return value;
  }
  async finishCommand(q,commandId,status) {await q(`UPDATE public.product_commands SET status=$2,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE command_id=$1 AND status IN ('accepted','running','cancellation_requested')`,[commandId,status==='completed'?'completed':status==='cancelled'?'cancelled':'failed']);}
  async settleBackground(state,deferred) {
    try{const deferredResult=deferred.schemaVersion==='workbench-deferred-execution-settlement-v1';await this.transaction(async(q,uow)=>{const result=deferredResult?await this.dispatcher.settleExecution(deferred,{uow}):deferred;await this.finishCommand(q,state.ticket.commandId,result.status);});if(deferredResult)this.dispatcher.confirmExecutionSettlement(deferred);}finally{this.active.delete(state.ticket.invocationId);}
  }
  async decide(args,decision) {
    const {context,requestId,workItemId,idempotencyKey}=args,scope=`member-agent-${decision}:${requestId}`,hash=canonicalRequestHash({workItemId,requestId,request:args.request});let invocationId;
    const value=await this.transaction(async(q,uow)=>{
      const row=await this.row(q,args,true);if(decision==='decline'&&context.userId!==row.provider_user_id)fail('member_agent_provider_required');
      const old=await this.receipt(q,context,scope,idempotencyKey,hash);if(old)return {...old,...await this.methodDisplay(q,context.workspaceId,old.method)};
      if(decision==='decline'&&row.consent!=='pending')fail('member_agent_request_decided');
      if(decision==='cancel'&&['declined','revoked'].includes(row.consent))fail('member_agent_request_decided');
      await this.command(q,uow,context,`member_agent_request_${decision}`,requestId,{workItemId,requestId,requestDigest:row.request_digest});
      const consent=decision==='decline'?'declined':'revoked';
      if(decision==='cancel') await revokeMemberAgentRequests(q,{workspaceId:context.workspaceId,requestIds:[requestId]});
      else await q('UPDATE public.member_agent_requests SET consent=$3,revision=revision+1 WHERE workspace_id=$1 AND request_id=$2',[context.workspaceId,requestId,consent]);
      invocationId=row.invocation_id;
      const result=await this.view(q,{...row,consent});await this.saveReceipt(q,context,scope,idempotencyKey,hash,result);return result;
    });
    if(invocationId)await this.dispatcher.cancel(invocationId,{reason:'member_agent_request_revoked'});return value;
  }
}
