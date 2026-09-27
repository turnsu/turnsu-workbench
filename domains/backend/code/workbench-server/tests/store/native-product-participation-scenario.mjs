import { LocalAgentHost } from "../../../../../agent/code/local-agent-host/host.mjs";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../../src/auth/auth-service.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { createPostgresIdempotentMutationPort } from "../../src/coordination/index.mjs";
import { loginNativeProduct } from "../../../../../agent/code/agent-runtime/integrations/native/login.mjs";
import { connectNativeMcp, loginPortableNative } from "../../../../../agent/code/agent-runtime/test/native-mcp-harness.mjs";
import { runNativeModelParticipant } from "../../../../../agent/code/agent-runtime/test/native-model-harness.mjs";

// Real stdio MCP process -> HTTP native bearer auth -> Product application -> PG.
// This is protocol acceptance, not a claim that a model chose the tool correctly.
export async function exerciseNativeParticipation({ store, team, context, workItemId, revoke, desktopLoop }) {
  const sessions = store.createNativeClientSessionStore();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = new AuthService({ store, persistence: store.createAuthPersistence(), workspaceId: context.workspaceId,
    nativeClientSessions: sessions, publicOrigin: origin });
  const app = createWorkbenchApplication({ store, workspaceAuthorizer: store.createAuthPersistence(), workspaceReadModel: store.createWorkspaceReadModel(),
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }), workItemLifecycle: team,
    ...(desktopLoop ? { teamLibraryReadModel: desktopLoop.library, loopDraftLifecycle: desktopLoop.lifecycle,
      workflowReadModel: store.createWorkflowReadModel(), skillReadModel: store.createSkillReadModel(), workflowCompileLifecycle: desktopLoop.compiler,
      workflowCommandAuthorizer: desktopLoop.commandAuthorizer, runner: desktopLoop.runner } : {}) });
  server.on("request", createWorkbenchHttpHandler({ application: app, authService: auth, origin, allowedHosts: ["127.0.0.1"], internalErrorReporter: error => console.error("isolated-native-http", JSON.stringify(error)) }));
  const dir = await mkdtemp(join(tmpdir(), "turnsu-native-pg-"));
  let client, desktop, desktopProjectId, desktopRequestId;
  const authorizeProfile = async (path) => {
    const approve = async (url) => {
      const approved = await auth.approveNativeAuthorization({ authorizationId: new URL(url).searchParams.get("authorizationId"),
        auth: { userId: context.userId, activeWorkspaceId: context.workspaceId } });
      assert.equal((await fetch(approved.redirectUrl)).status, 200);
    };
    if (process.env.TURNSU_NATIVE_CONNECTOR_CLI) {
      await loginPortableNative({ cliPath: process.env.TURNSU_NATIVE_CONNECTOR_CLI, baseUrl: origin, sessionPath: path, approve });
    } else {
      await loginNativeProduct({ baseUrl: origin, sessionPath: path, timeoutMs: 15_000, onAuthorization: approve });
    }
  };
  try {
    const path = join(dir, "session.json");
    await authorizeProfile(path);
    client = await connectNativeMcp(path);
    const result = await client.callTool({ name: "turnsu_work_results", arguments: { pathParams: { workItemId } } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(JSON.parse(result.content[0].text).data[0].finalAnswer.content, "Member's result");
    const update = { name: "turnsu_submit_update", arguments: { pathParams: { workItemId }, idempotencyKey: "native-shared-update", data: { content: "Native client reviewed the shared result; awaiting owner acceptance." } } };
    const submitted = await client.callTool(update);
    assert.notEqual(submitted.isError, true, JSON.stringify(submitted));
    const replay = await client.callTool(update);
    assert.equal(JSON.parse(submitted.content[0].text).data.entryId, JSON.parse(replay.content[0].text).data.entryId);
    const failures = [];
    for (const kind of (process.env.TURNSU_NATIVE_CLIENT_ACCEPTANCE ?? "").split(",").filter(Boolean)) {
      const sessionPath = join(dir, `${kind}-session.json`);
      await authorizeProfile(sessionPath);
      const directory = await mkdtemp(join(tmpdir(), `turnsu-${kind}-acceptance-`));
      const receipt = await runNativeModelParticipant({ kind, sessionPath, directory, workItemId });
      const entries = await team.listThreadEntries({ context, workItemId });
      const submitted = entries.filter((entry) => entry.summary?.startsWith(receipt.marker));
      const passed = receipt.code === 0 && submitted.length === 1 && submitted[0].summary.includes("Member's result");
      console.log(JSON.stringify({ nativeClient: kind, passed, ...receipt, entries: submitted.length }));
      if (!passed) failures.push({ kind, ...receipt });
    }
    assert.deepEqual(failures, [], "real native clients must read and submit the persisted shared result");
    if (desktopLoop) {
      const localState=join(dir,'desktop-state'),folder=join(dir,'desktop-project');
      await mkdir(localState,{mode:0o700});await mkdir(folder);
      await authorizeProfile(join(localState,'cloud-session.json'));
      desktop=new LocalAgentHost({directory:localState,connectionFactory:()=>{throw new Error('A cloud Loop must not start a native Agent');}});
      const project=await desktop.command('project.open',{path:folder});desktopProjectId=project.id;
      await desktop.command('sync.attach',{projectId:project.id,remoteId:desktopLoop.projectId});
      const catalog=await desktop.command('loops.catalog',{projectId:project.id,workItemId});
      assert.equal(catalog.items.find(r=>r.releaseId===desktopLoop.releaseId).loopSummary.goal,'Echo the input');
      const all=[];let cursor;
      do {
        const page=await desktop.cloud.session.product.call('turnsu_methods',{query:{assetKind:'loop',limit:1,...(cursor?{cursor}:{})}});
        assert.ok(page.data.every(r=>r.assetKind==='loop'));all.push(...page.data.map(r=>r.releaseId));cursor=page.page.nextCursor;
        assert.equal(new Set(all).size,all.length,'catalog pagination cannot repeat releases');
      } while(cursor);
      assert.ok(all.includes(desktopLoop.releaseId));assert.equal(all.length,catalog.items.length);
      const choice={projectId:project.id,workItemId,releaseId:desktopLoop.releaseId,requestId:'desktop-loop-choice'};
      const copy=await desktop.command('loops.prepare',choice);
      assert.equal(copy.prepared.workflow.ownerId,context.userId);
      assert.equal(copy.prepared.workflow.sourceRelease.releaseId,desktopLoop.releaseId);
      assert.equal((await desktop.command('loops.prepare',choice)).prepared.workflow.workflowId,copy.prepared.workflow.workflowId);
      const original=desktop.cloud.fileCall.bind(desktop.cloud);let lose=true;
      desktop.cloud.fileCall=async(...args)=>{let result;try{result=await original(...args);}catch(error){console.error('isolated-desktop-call',args[1],error.code,error.status);throw error;}if(args[1]==='turnsu_run_loop'&&lose){lose=false;throw new Error('lost accepted HTTP receipt');}return result;};
      desktopRequestId='desktop-loop-run';
      await assert.rejects(desktop.command('loops.run',{preparationId:copy.id,inputs:{goal:'Desktop shared result'},requestId:desktopRequestId}),/提交记录/);
      assert.equal(lose,false,'the server must accept the original run before simulating a lost receipt');
      await desktop.close();desktop=new LocalAgentHost({directory:localState,connectionFactory:()=>{throw new Error('No native execution during recovery');}});
      const accepted=await desktop.command('loops.retry',{requestId:desktopRequestId});assert.ok(accepted.runId);
      const scope={projectId:project.id,workItemId};
      const waitStatus=async(runId,status)=>{
        const deadline=Date.now()+15000;let value;
        do{value=await desktop.command('loops.state',scope);if(value.runs.some(r=>r.runId===runId&&r.status===status))return value;await delay(25);}while(Date.now()<deadline);
        assert.fail('Expected '+status+': '+JSON.stringify(value));
      };
      await waitStatus(accepted.runId,'waiting_review');
      const review=(await desktop.command('loops.inspect',{...scope,runId:accepted.runId})).review;
      assert.ok(review.expectedNodeRunId);assert.ok(review.items.length);
      const action={...scope,runId:accepted.runId,kind:'review',data:{nodeId:review.nodeId,expectedNodeRunId:review.expectedNodeRunId,decision:'approve',requestedChanges:[]}};
      await assert.rejects(desktop.command('loops.action',{...action,requestId:'stale-review',data:{...action.data,expectedNodeRunId:'old-node-attempt'}}),/复核已变化/);
      assert.equal((await desktopLoop.runner.getRun(accepted.runId)).run.status,'waiting_review');
      const beforeAction=desktop.cloud.fileCall.bind(desktop.cloud);let loseDecision=true;
      desktop.cloud.fileCall=async(...args)=>{const result=await beforeAction(...args);if(args[1]==='turnsu_review_run'&&loseDecision){loseDecision=false;throw new Error('Lost accepted review receipt');}return result;};
      await assert.rejects(desktop.command('loops.action',{...action,requestId:'desktop-review'}),/尚未确认/);
      assert.equal(loseDecision,false,'actual HTTP review response must succeed before receipt loss');
      await desktop.close();desktop=new LocalAgentHost({directory:localState,connectionFactory:()=>{throw new Error('No native execution during recovery');}});
      assert.equal((await desktop.command('loops.state',scope)).actions.length,1);
      await desktop.command('loops.retryAction',{requestId:'desktop-review'});
      const visible=await waitStatus(accepted.runId,'completed');
      assert.equal(visible.actions.length,0);
      assert.equal((await desktopLoop.runner.getRun(accepted.runId)).run.reviewDecisions.length,1);
      // A second real run is cancelled while its controlled execution is in progress.
      const stop=await desktop.command('loops.run',{preparationId:copy.id,inputs:{goal:'Cancel this result'},requestId:'desktop-cancel-run'});
      const cancelDeadline=Date.now()+5000;while(!desktopLoop.cancellationReady()&&Date.now()<cancelDeadline)await delay(25);
      assert.ok(desktopLoop.cancellationReady(),'controlled execution must start before cancelling');
      await desktopLoop.verifyCancellationBoundary(stop.runId);
      const beforeCancel=desktop.cloud.fileCall.bind(desktop.cloud);let loseCancel=true;
      desktop.cloud.fileCall=async(...args)=>{let result;try{result=await beforeCancel(...args);}catch(error){console.error('isolated-cancel-call',error.code,error.status);throw error;}if(args[1]==='turnsu_cancel_run'&&loseCancel){loseCancel=false;throw new Error('Lost cancellation receipt');}return result;};
      await assert.rejects(desktop.command('loops.action',{...scope,runId:stop.runId,kind:'cancel',data:{},requestId:'desktop-cancel'}),/尚未确认/);
      assert.equal(loseCancel,false);
      await desktop.close();desktop=new LocalAgentHost({directory:localState,connectionFactory:()=>{throw new Error('No native execution during recovery');}});
      await desktop.command('loops.retryAction',{requestId:'desktop-cancel'});
      await waitStatus(stop.runId,'cancelled');
      await desktopLoop.verifyCancellationClosed(stop.runId);
      const rejected=await desktop.command('loops.run',{preparationId:copy.id,inputs:{goal:'Reject this result'},requestId:'desktop-reject-run'});
      await waitStatus(rejected.runId,'waiting_review');
      const rejection=(await desktop.command('loops.inspect',{...scope,runId:rejected.runId})).review;
      await desktop.command('loops.action',{...scope,runId:rejected.runId,requestId:'desktop-reject',kind:'review',data:{nodeId:rejection.nodeId,expectedNodeRunId:rejection.expectedNodeRunId,decision:'reject',comment:'Result does not meet the request',requestedChanges:[]}});
      await waitStatus(rejected.runId,'cancelled');
      assert.equal((await desktopLoop.runner.getRun(rejected.runId)).run.reviewDecisions[0].decision,'reject');
      const revise=await desktop.command('loops.run',{preparationId:copy.id,inputs:{goal:'Revise this result'},requestId:'desktop-revise-run'});
      await waitStatus(revise.runId,'waiting_review');
      const firstRound=(await desktop.command('loops.inspect',{...scope,runId:revise.runId})).review;
      assert.equal(firstRound.canRequestChanges,true);
      const change={...scope,runId:revise.runId,requestId:'desktop-revise',kind:'review',data:{nodeId:firstRound.nodeId,expectedNodeRunId:firstRound.expectedNodeRunId,decision:'revise',requestedChanges:['Include a clear next step']}};
      const beforeRevision=desktop.cloud.fileCall.bind(desktop.cloud);let loseRevision=true;
      desktop.cloud.fileCall=async(...args)=>{const value=await beforeRevision(...args);if(args[1]==='turnsu_review_run'&&args[2].data.decision==='revise'&&loseRevision){loseRevision=false;throw new Error('lost revision receipt');}return value;};
      await assert.rejects(desktop.command('loops.action',change),/尚未确认/);assert.equal(loseRevision,false);
      await desktop.close();desktop=new LocalAgentHost({directory:localState,connectionFactory:()=>{throw new Error('No native execution during recovery');}});
      await desktopLoop.recoverRevision(revise.runId);
      await desktop.command('loops.retryAction',{requestId:'desktop-revise'});
      let nextRound;const reviseDeadline=Date.now()+15000;
      do{nextRound=await desktop.command('loops.inspect',{...scope,runId:revise.runId});if(nextRound.review&&nextRound.review.expectedNodeRunId!==firstRound.expectedNodeRunId)break;await delay(25);}while(Date.now()<reviseDeadline);
      assert.ok(nextRound.review);assert.notEqual(nextRound.review.expectedNodeRunId,firstRound.expectedNodeRunId);
      assert.match(nextRound.review.items.join(' '),/Include a clear next step/);
      assert.deepEqual(desktopLoop.revisionInputs,['Revise this result','Revise this result\n\nReviewer feedback:\n- Include a clear next step']);
      assert.equal(nextRound.rounds.length,2);assert.equal(nextRound.rounds[0].packet.items[0],'Revise this result');assert.equal(nextRound.rounds[0].decision.decision,'revise');
      await assert.rejects(desktop.command('loops.action',{...change,requestId:'old-round-approval',data:{...change.data,decision:'approve',requestedChanges:[]}}),/复核已变化/);
      await desktop.command('loops.action',{...change,requestId:'second-revision',data:{nodeId:nextRound.review.nodeId,expectedNodeRunId:nextRound.review.expectedNodeRunId,decision:'revise',requestedChanges:['Make ownership explicit']}});
      const secondId=nextRound.review.expectedNodeRunId,secondDeadline=Date.now()+15000;
      do{nextRound=await desktop.command('loops.inspect',{...scope,runId:revise.runId});if(nextRound.review&&nextRound.review.expectedNodeRunId!==secondId)break;await delay(25);}while(Date.now()<secondDeadline);
      assert.ok(nextRound.review);assert.notEqual(nextRound.review.expectedNodeRunId,secondId);
      assert.match(nextRound.review.items[0],/Include a clear next step/);assert.match(nextRound.review.items[0],/Make ownership explicit/);
      assert.equal(desktopLoop.revisionInputs.length,3);assert.equal(nextRound.rounds.length,3);
      await desktop.command('loops.action',{...change,requestId:'revised-approval',data:{nodeId:nextRound.review.nodeId,expectedNodeRunId:nextRound.review.expectedNodeRunId,decision:'approve',requestedChanges:[]}});
      await waitStatus(revise.runId,'completed');
      const revisions=await desktop.command('loops.inspect',{...scope,runId:revise.runId});
      assert.equal(revisions.rounds.length,3);assert.equal(revisions.rounds[2].decision.decision,'approve');assert.equal(desktopLoop.revisionInputs.length,3);
      const finalRun=(await desktopLoop.runner.getRun(revise.runId)).run;assert.equal(finalRun.nodeRuns.filter(n=>n.nodeId==='node-input').length,1);assert.equal(finalRun.nodeRuns.filter(n=>n.nodeId==='node-echo').length,3);
      const result=visible.runs.find(r=>r.runId===accepted.runId);assert.equal(result.status,'completed');assert.equal(result.finalAnswer.content,'Desktop shared result');
      assert.equal(result.requestedByUserId,context.userId);assert.equal(visible.runs.filter(r=>r.inputs.goal==='Desktop shared result').length,1);
      assert.equal((await desktop.command('loops.retry',{requestId:desktopRequestId})).runId,accepted.runId);
      assert.equal((await team.listWorkflowRuns({context:{...context,userId:'b2-user-a',role:'owner'},workItemId})).find(r=>r.runId===accepted.runId).finalAnswer.content,'Desktop shared result');
    }
    await revoke();
    if(desktop){await assert.rejects(desktop.command('loops.state',{projectId:desktopProjectId,workItemId}));await assert.rejects(desktop.command('loops.retry',{requestId:desktopRequestId}));}
    const denied = await client.callTool({ name: "turnsu_work_results", arguments: { pathParams: { workItemId } } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /work_item_access_forbidden/u);
  } finally {
    if (desktop) await desktop.close();
    if (client) await client.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}
