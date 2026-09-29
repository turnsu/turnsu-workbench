import {verifyMemberAgentDesktop} from "../../../../packages/agent-runtime/test/verify-member-agent-desktop.mjs";
import assert from 'node:assert/strict';
import {readNativeProfile} from '../../../../packages/agent-runtime/integrations/native/session.mjs';
export async function verifyMemberAgentRequests({request,pool,nativeProfile,headers,memberHeaders,foreignHeaders,providerUserId,method,root,authService,sessionStore,workspaceId,oversizedMethod,restart,getBorrowing}) {
 const profile=await readNativeProfile(nativeProfile), nativeHeaders={Authorization:`Bearer ${profile.tokens.accessToken}`};
 const send=(path,data,key,auth=headers)=>request(path,{method:'POST',data,headers:{...auth,'Idempotency-Key':key}});
 const device=await send('/devices',{displayName:'Restricted Pi verification',platform:'macos',architecture:'arm64',appVersion:'test',workerProtocolVersion:'workbench-device-worker-v1',capabilityInventory:[]},'borrow-device',nativeHeaders);
 assert.equal(device.status,201,JSON.stringify(device.body));
 // Third active member shares the Work Item, but must not see other members' private requests.
 const observerId='borrow-list-observer';
 await pool.query(`INSERT INTO product_users(user_id,schema_version,display_name,account_role,created_at,updated_at)
   VALUES($1,'workbench-v1','Request list observer','member',clock_timestamp(),clock_timestamp())`,[observerId]);
 await pool.query(`INSERT INTO workspace_memberships(membership_id,workspace_id,user_id,schema_version,role,status,created_at,updated_at)
   VALUES('borrow-list-observer-membership',$1,$2,'workbench-v1','member','active',clock_timestamp(),clock_timestamp())`,[workspaceId,observerId]);
 const observerSession=await sessionStore.issue({userId:observerId,activeWorkspaceId:workspaceId});
 const observerHeaders={Cookie:`workbench_session=${observerSession.token}`,'X-Workbench-CSRF':observerSession.csrfToken};
 const project=await send('/projects',{title:'Member assistance',objective:'One explicit isolated task',members:[{userId:providerUserId},{userId:observerId}]},'borrow-project');
 assert.equal(project.status,201,JSON.stringify(project.body));
 const work=await send('/work-items',{projectId:project.body.data.projectId,title:'Declared text',objective:'Summarize declared feedback',summary:'Bounded member assistance',members:[{userId:providerUserId,access:'contribute',roles:['participant']},{userId:observerId,access:'contribute',roles:['participant']}]},'borrow-work');
 assert.equal(work.status,201,JSON.stringify(work.body));
 const workItemId=work.body.data.workItemId, base=`/work-items/${workItemId}/agent-requests`;
 const limits={timeoutMs:30000,maxModelRequests:2,maxOutputTokens:1000,maxOutputBytes:8000};
 const data={providerUserId,method,goal:'Summarize only the declared text.',inputs:[{id:'feedback',title:'Feedback',text:'Declared team feedback'}],expiresAt:new Date(Date.now()+120000).toISOString(),limits};
 assert.equal((await send(base,{...data,method:oversizedMethod},'borrow-oversized-method')).status,409,'oversized published instruction packages are not silently truncated');
 const created=await send(base,data,'borrow-create');assert.equal(created.status,201,JSON.stringify(created.body));
 assert.deepEqual((await send(base,data,'borrow-create')).body.data,created.body.data);
 assert.equal((await send(base,{...data,goal:'changed'},'borrow-create')).status,409);
 const display=(await pool.query(`SELECT s.definition->>'name' AS name,r.version FROM workspace_asset_releases r JOIN skill_versions s ON s.workspace_id=r.source_workspace_id AND s.skill_version_id=r.skill_version_id WHERE r.release_id=$1`,[method.releaseId])).rows[0];
 assert.equal(created.body.data.methodName,display.name);assert.equal(created.body.data.methodVersion,display.version);
 const newest=await send(base,data,'borrow-list-newest');assert.equal(newest.status,201);
 const firstPage=await request(`${base}?limit=1`,{headers});assert.equal(firstPage.status,200,JSON.stringify(firstPage.body));
 assert.equal(firstPage.headers.get('cache-control'),'private, no-store');
 assert.deepEqual(firstPage.body.data.items.map(x=>x.requestId),[newest.body.data.requestId]);
 assert.ok(firstPage.body.data.nextCursor);
 const pageCursor=encodeURIComponent(firstPage.body.data.nextCursor);
 const addedDuringPaging=await send(base,data,'borrow-list-concurrent-insert');assert.equal(addedDuringPaging.status,201);
 const secondPage=await request(`${base}?limit=1&cursor=${pageCursor}`,{headers});assert.equal(secondPage.status,200,JSON.stringify(secondPage.body));
 assert.deepEqual(secondPage.body.data.items.map(x=>x.requestId),[created.body.data.requestId]);assert.equal(secondPage.body.data.nextCursor,null);
 assert.equal((await request(`${base}?cursor=${pageCursor}`,{headers:memberHeaders})).status,400,'cursor is bound to the authenticated viewer');
 assert.equal((await request(`${base}?cursor=not-a-cursor`,{headers})).status,400);
 const absentAnchor=JSON.parse(Buffer.from(firstPage.body.data.nextCursor,'base64url').toString());absentAnchor.id='absent-agent-request';
 const absentCursor=Buffer.from(JSON.stringify(absentAnchor)).toString('base64url');
 assert.equal((await request(`${base}?cursor=${absentCursor}`,{headers})).status,400,'unknown anchor is rejected rather than silently showing an empty page');
 assert.equal((await request(`${base}?limit=0`,{headers})).status,400);
 assert.equal((await request(base,{headers:foreignHeaders})).status,404);
 const empty=await request(base,{headers:observerHeaders});assert.equal(empty.status,200,JSON.stringify(empty.body));assert.deepEqual(empty.body.data,{items:[],nextCursor:null});
 const providerList=await request(base,{headers:memberHeaders});assert.equal(providerList.status,200);assert.equal(providerList.body.data.items.length,3);
 const otherWork=await send('/work-items',{projectId:project.body.data.projectId,title:'Other request scope',objective:'Cursor scope',summary:'Cursor scope',members:[{userId:providerUserId,access:'contribute',roles:['participant']}]},'borrow-other-work');assert.equal(otherWork.status,201);
 assert.equal((await request(`/work-items/${otherWork.body.data.workItemId}/agent-requests?cursor=${pageCursor}`,{headers})).status,400);
 const privateRequest=await send(base,{...data,providerUserId:observerId,goal:'PRIVATE THIRD MEMBER GOAL'},'borrow-other-pair',memberHeaders);assert.equal(privateRequest.status,201,JSON.stringify(privateRequest.body));
 assert.equal((await request(base,{headers})).body.data.items.length,3,'requester never discovers another pair');
 const observerList=await request(base,{headers:observerHeaders});assert.equal(observerList.body.data.items.length,1);assert.equal(observerList.body.data.items[0].requestId,privateRequest.body.data.requestId);
 assert.ok(!(await request(base,{headers})).body.data.items.some(x=>x.goal==='PRIVATE THIRD MEMBER GOAL'));
 assert.equal((await request(`${base}/${created.body.data.requestId}`,{headers:observerHeaders})).status,404);
 const currentForRemoval=await request(`/work-items/${workItemId}`,{headers});
 const observerRemoved=await request(`/work-items/${workItemId}`,{method:'PATCH',headers:{...headers,'Idempotency-Key':'borrow-list-revoke','If-Match':currentForRemoval.headers.get('etag')},data:{members:[{userId:providerUserId,access:'contribute',roles:['participant']}]}});
 assert.equal(observerRemoved.status,200,JSON.stringify(observerRemoved.body));
 assert.equal((await request(base,{headers:observerHeaders})).status,404,'revoked Work Item reader cannot refresh their own request');
 assert.equal((await request(`${base}/${privateRequest.body.data.requestId}`,{headers:observerHeaders})).status,404);
 const path=`${base}/${created.body.data.requestId}`;
 assert.equal((await request(path,{headers:foreignHeaders})).status,404);
 const accept={confirm:true,requestDigest:created.body.data.requestDigest,deviceId:device.body.data.deviceId,profile:'pi-declared-text-v1',selectedModel:{provider:'controlled',modelId:'isolated-sdk-test'},limits};
 assert.equal((await send(`${path}/accept`,accept,'borrow-browser',memberHeaders)).status,403);
 const accepted=await send(`${path}/accept`,accept,'borrow-accept',nativeHeaders);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 const ticket=accepted.body.data;assert.equal(ticket.providerUserId,providerUserId);assert.match(ticket.instructions,/Published text:/);
 assert.deepEqual((await send(`${path}/accept`,accept,'borrow-accept',nativeHeaders)).body.data,ticket);
 assert.equal((await send(`${path}/accept`,accept,'borrow-second-accept',nativeHeaders)).status,409);
 const grant=await request(`${path}/execution`,{headers:nativeHeaders});assert.equal(grant.status,200,JSON.stringify(grant.body));assert.equal(grant.body.data.ticket.invocationId,ticket.invocationId);
 const output={invocationId:ticket.invocationId,attemptId:ticket.attemptId,fence:ticket.fence,deliveryId:'borrow-result',outcome:'result',output:'Declared result from controlled protocol.'};
 assert.equal((await send(`${path}/output`,{...output,attemptId:'other-attempt'},'borrow-wrong',nativeHeaders)).status,409);
 const delivered=await send(`${path}/output`,output,'borrow-delivery',nativeHeaders);assert.equal(delivered.status,200,JSON.stringify(delivered.body));assert.equal(delivered.body.data.executionStatus,'completed');
 assert.deepEqual((await send(`${path}/output`,output,'borrow-delivery',nativeHeaders)).body.data,delivered.body.data);
 assert.equal((await send(`${path}/output`,{...output,output:'changed'},'borrow-delivery',nativeHeaders)).status,409);
 assert.equal((await request(path,{headers})).body.data.output,output.output);
 const rows=(await pool.query('SELECT i.*,c.quota_user_id FROM execution_invocations i JOIN product_commands c ON c.command_id=i.product_command_id WHERE i.controller_id=$1',[created.body.data.requestId])).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].quota_user_id,providerUserId);assert.equal(rows[0].controller_kind,'member_agent_request');assert.equal(rows[0].lineage_session_id,null);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM execution_attempts WHERE invocation_id=$1',[ticket.invocationId])).rows[0].n,1);
 const cancelled=await send(base,data,'borrow-create-cancel');assert.equal(cancelled.status,201,JSON.stringify(cancelled.body));const cancelPath=`${base}/${cancelled.body.data.requestId}`;
 const second=await send(`${cancelPath}/accept`,{...accept,requestDigest:cancelled.body.data.requestDigest},'borrow-accept-cancel',nativeHeaders);assert.equal(second.status,200,JSON.stringify(second.body));
 assert.equal((await send(`${cancelPath}/cancel`,{},'borrow-cancel')).status,200);
 assert.equal((await request(`${cancelPath}/execution`,{headers:nativeHeaders})).status,403);
 assert.equal((await send(`${cancelPath}/output`,{...output,invocationId:second.body.data.invocationId,attemptId:second.body.data.attemptId},'borrow-revoked-output',nativeHeaders)).status,403);
 const declined=await send(base,data,'borrow-create-decline');const declinePath=`${base}/${declined.body.data.requestId}`;
 assert.equal((await send(`${declinePath}/decline`,{},'borrow-decline',memberHeaders)).status,200);
 assert.equal((await send(`${declinePath}/accept`,{...accept,requestDigest:declined.body.data.requestDigest},'borrow-declined-accept',nativeHeaders)).status,409);
 // Project removal revokes one-time consent even if rejoining happens before the next desktop grant check.
 const projectBorrow=await send(base,data,'borrow-project-revoke');assert.equal(projectBorrow.status,201,JSON.stringify(projectBorrow.body));
 const projectBorrowPath=`${base}/${projectBorrow.body.data.requestId}`;
 const projectAccept={...accept,requestDigest:projectBorrow.body.data.requestDigest};
 const projectTicket=await send(`${projectBorrowPath}/accept`,projectAccept,'borrow-project-accept',nativeHeaders);assert.equal(projectTicket.status,200,JSON.stringify(projectTicket.body));
 const pendingBorrow=await send(base,data,'borrow-project-pending');assert.equal(pendingBorrow.status,201,JSON.stringify(pendingBorrow.body));
 const projectPath=`/projects/${project.body.data.projectId}`;
 const projectBefore=await request(projectPath,{headers});
 const removedMember=await request(`${projectPath}/members`,{method:'PUT',headers:{...headers,'Idempotency-Key':'borrow-project-remove','If-Match':projectBefore.headers.get('etag')},data:{members:[{userId:observerId}]}});
 assert.equal(removedMember.status,200,JSON.stringify(removedMember.body));
 const rejoinedMember=await request(`${projectPath}/members`,{method:'PUT',headers:{...headers,'Idempotency-Key':'borrow-project-rejoin','If-Match':removedMember.headers.get('etag')},data:{members:[{userId:providerUserId},{userId:observerId}]}});
 assert.equal(rejoinedMember.status,200,JSON.stringify(rejoinedMember.body));
 assert.equal((await pool.query('SELECT consent FROM member_agent_requests WHERE request_id=$1',[projectBorrow.body.data.requestId])).rows[0].consent,'revoked');
 assert.equal((await pool.query('SELECT status FROM capability_leases WHERE invocation_id=$1',[projectTicket.body.data.invocationId])).rows[0].status,'revoked');
 assert.equal((await request(`${projectBorrowPath}/execution`,{headers:nativeHeaders})).status,403);
 assert.equal((await send(`${projectBorrowPath}/accept`,projectAccept,'borrow-project-accept',nativeHeaders)).status,403,'an old acceptance receipt cannot resurrect consent');
 assert.equal((await send(`${projectBorrowPath}/output`,{...output,invocationId:projectTicket.body.data.invocationId,attemptId:projectTicket.body.data.attemptId},'borrow-project-old-output',nativeHeaders)).status,403);
 assert.equal((await send(`${base}/${pendingBorrow.body.data.requestId}/accept`,{...accept,requestDigest:pendingBorrow.body.data.requestDigest},'borrow-project-pending-accept',nativeHeaders)).status,403);
 const freshBorrow=await send(base,data,'borrow-project-new-consent');assert.equal(freshBorrow.status,201,JSON.stringify(freshBorrow.body));
 const freshPath=`${base}/${freshBorrow.body.data.requestId}`;
 assert.equal((await send(`${freshPath}/accept`,{...accept,requestDigest:freshBorrow.body.data.requestDigest},'borrow-project-fresh-accept',nativeHeaders)).status,200);
 assert.equal((await request(`${freshPath}/execution`,{headers:nativeHeaders})).status,200);
 assert.equal((await send(`${freshPath}/cancel`,{},'borrow-project-fresh-cancel')).status,200);
 // A real persisted accepted command without a registered Invocation is never retried as an execution.
 const interrupted=await send(base,data,'borrow-accept-gap'); const gapPath=`${base}/${interrupted.body.data.requestId}`;
 const prepareDispatcher=getBorrowing().dispatcher;
 getBorrowing().dispatcher=new Proxy(prepareDispatcher,{get(target,key){if(key==='prepareExecution')return async()=>{throw new Error('injected interruption before Invocation registration');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 try { assert.equal((await send(`${gapPath}/accept`,{...accept,requestDigest:interrupted.body.data.requestDigest},'borrow-gap-accept',nativeHeaders)).status,500); }
 finally {getBorrowing().dispatcher=prepareDispatcher;}
 const gapReplay=await send(`${gapPath}/accept`,{...accept,requestDigest:interrupted.body.data.requestDigest},'borrow-gap-accept',nativeHeaders);
 assert.equal(gapReplay.status,409);assert.equal(gapReplay.body.code,'member_agent_registration_interrupted');
 const gap=(await pool.query('SELECT c.status,r.invocation_id FROM member_agent_requests r JOIN product_commands c ON c.command_id=r.accept_command_id WHERE r.request_id=$1',[interrupted.body.data.requestId])).rows[0];
 assert.equal(gap.status,'blocked');assert.equal(gap.invocation_id,null);
 // Failure after registration but before backend.execute must return, not hang waiting for a start event.
 const early=await send(base,data,'borrow-early-fail');const earlyPath=`${base}/${early.body.data.requestId}`;
 const executeDispatcher=getBorrowing().dispatcher;
 getBorrowing().dispatcher=new Proxy(executeDispatcher,{get(target,key){if(key==='execute')return async()=>{throw new Error('injected dispatch failure before backend opens');};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 try {assert.equal((await send(`${earlyPath}/accept`,{...accept,requestDigest:early.body.data.requestDigest},'borrow-early-accept',nativeHeaders)).status,500);}
 finally {getBorrowing().dispatcher=executeDispatcher;}
 // Recreate Product services over the same PostgreSQL records. Recovery fences the old attempt; it never dispatches it.
 const restartRequest=await send(base,data,'borrow-restart');const restartPath=`${base}/${restartRequest.body.data.requestId}`;
 const beforeRestart=await send(`${restartPath}/accept`,{...accept,requestDigest:restartRequest.body.data.requestDigest},'borrow-restart-accept',nativeHeaders);
 assert.equal(beforeRestart.status,200,JSON.stringify(beforeRestart.body));
 const oldService=getBorrowing(); await restart(); await getBorrowing().recover(); await oldService.dispose();
 const recovered=await request(restartPath,{headers});assert.equal(recovered.body.data.executionStatus,'partial');assert.equal(recovered.body.data.output,null);assert.equal(recovered.body.data.executionReasonCode,'member_agent_restart_outcome_unknown');
 assert.equal((await pool.query('SELECT payload FROM execution_invocations WHERE invocation_id=$1',[beforeRestart.body.data.invocationId])).rows[0].payload.recoveredAfterRestart,true);
 assert.equal((await request(`${restartPath}/execution`,{headers:nativeHeaders})).status,409);
 assert.deepEqual((await send(`${restartPath}/accept`,{...accept,requestDigest:restartRequest.body.data.requestDigest},'borrow-restart-accept',nativeHeaders)).body.data,beforeRestart.body.data);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM execution_attempts WHERE invocation_id=$1',[beforeRestart.body.data.invocationId])).rows[0].n,1);
 const metering=(await pool.query('SELECT payload FROM execution_invocations WHERE invocation_id=$1',[ticket.invocationId])).rows[0].payload;
 assert.equal(metering.request.limits.maxCostUsdMicros,null);assert.equal(metering.result.usageAccounting,'local_unmetered');assert.equal(metering.result.usage.costUsdMicros,null);assert.equal(metering.result.usage.modelRequests,null);
 await verifyMemberAgentDesktop({baseUrl:authService.publicOrigin,authService,workspaceId,providerUserId,workItemId,method,root,createRequest:async(data,key)=>{const result=await send(base,data,key||'borrow-local-sdk');assert.equal(result.status,201,JSON.stringify(result.body));return result.body.data;},cancelRequest:async requestId=>{const result=await send(`${base}/${requestId}/cancel`,{},`borrow-sdk-cancel-${requestId}`);assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;}});
 // Work Item permission loss fences both new dispatch and a late result, even while the desktop session is valid.
 const revokeRequest=await send(base,data,'borrow-work-revoke');const revokePath=`${base}/${revokeRequest.body.data.requestId}`;
 const revokeTicket=await send(`${revokePath}/accept`,{...accept,requestDigest:revokeRequest.body.data.requestDigest},'borrow-work-revoke-accept',nativeHeaders);assert.equal(revokeTicket.status,200,JSON.stringify(revokeTicket.body));
 const currentWork=await request(`/work-items/${workItemId}`,{headers});
 const revoked=await request(`/work-items/${workItemId}`,{method:'PATCH',headers:{...headers,'Idempotency-Key':'borrow-drop-contributor','If-Match':currentWork.headers.get('etag')},data:{members:[{userId:providerUserId,access:'read',roles:['watcher']}]}});
 assert.equal(revoked.status,200,JSON.stringify(revoked.body));assert.equal((await request(`${revokePath}/execution`,{headers:nativeHeaders})).status,403);
 assert.equal((await send(`${revokePath}/output`,{...output,invocationId:revokeTicket.body.data.invocationId,attemptId:revokeTicket.body.data.attemptId},'borrow-permission-revoked-output',nativeHeaders)).status,403);
 await send(`${revokePath}/cancel`,{},'borrow-revoked-cleanup');

}
