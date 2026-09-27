import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Check, LoopVersionSchema, WorkspaceAssetReleaseSchema, SourceReleaseRefSchema, WorkItemWorkflowRunSchema } from "@looloomi/workbench-contracts";
import { PostgresTeamWorkLifecycle } from "../../src/work-items/postgres-team-work-lifecycle.mjs";
import { PostgresWorkItemPromotionLifecycle } from "../../src/work-items/postgres-work-item-promotion-lifecycle.mjs";
import { PostgresLoopDraftLifecycle } from "../../src/loops/postgres-loop-draft-lifecycle.mjs";
import { PostgresWorkflowCompileLifecycle } from "../../src/loops/postgres-workflow-compile-lifecycle.mjs";
import { PostgresTeamLibraryLifecycle } from "../../src/store/postgres/postgres-team-library-lifecycle.mjs";
import { PostgresTeamLibraryReadModel } from "../../src/store/postgres/postgres-team-library-read-model.mjs";
import { createPostgresProductCommandResolver, PostgresAgentCommandAuthorizer } from "../../src/coordination/index.mjs";
import { createPostgresRunControl, createPostgresWorkflowRunPersistence, createPostgresWorkflowExecutionResolver, createWorkflowRunner, WorkflowRunnerError, PostgresWorkflowRunCommandIntake, PostgresWorkflowRunReviewCommandIntake, PostgresWorkflowRunCancellationCommandIntake } from "../../src/runner/index.mjs";
import { AdmissionController, AdmittedExecutionDispatcher, ExecutionBroker, PostgresCapacityPersistence, PostgresExecutionPersistence } from "../../src/execution/index.mjs";
import { formatWorkflowEtag } from "../../src/store/serialization.mjs";
import { makeSkillNode, makeReviewNode } from "../compiler/fixtures.mjs";
import { exerciseNativeParticipation } from "./native-product-participation-scenario.mjs";

// Real Product lifecycles, compiler, admission, runner and PostgreSQL. The sole
// execution backend is a deterministic echo test capability: no model/provider
// acceptance is inferred from this storage and publication scenario.
export async function exerciseLoopPublication({ pool, store, resourceHash }) {
  const workspaceId = "b2-workspace-a", userId = "b2-user-a";
  const idFactory = (kind) => `${kind}-${randomUUID()}`;
  const memberId = "loop-consumer";
  // Activate a genuinely separate member through the Product identity lifecycle.
  // The verified OAuth identity is the only simulated identity-provider boundary.
  await pool.query("UPDATE public.product_users SET account_role = 'admin', updated_at = clock_timestamp() WHERE user_id = $1", [userId]);
  const auth = store.createAuthPersistence({ idFactory });
  const tokenHash = `sha256:${createHash("sha256").update("isolated-loop-invitation").digest("hex")}`;
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await auth.createWorkspaceInvitation({ requestedBy: userId, workspaceId, invitationId: "loop-invitation", invitedEmail: "loop@example.test", tokenHash, expiresAt, idempotencyKey: "loop-invite" });
  await auth.createOAuthLoginTransaction({ transactionId: "loop-oauth", invitationId: "loop-invitation", provider: "google", stateHash: tokenHash, expiresAt });
  await auth.activateOAuthInvitation({ transactionId: "loop-oauth", provider: "google", stateHash: tokenHash,
    providerSubject: "loop-consumer-subject", verifiedEmail: "loop@example.test", newUserId: memberId, newUsername: "loop-consumer" });
  const lifecycle = new PostgresLoopDraftLifecycle({ store, idFactory });
  const compiler = new PostgresWorkflowCompileLifecycle({ store, idFactory, probeSkill: async () => ({ status: "ready" }) });
  const created = await lifecycle.createLoop({ workspaceId, authoredBy: userId, idempotencyKey: "publication-create",
    request: { data: { name: "Shared team echo", definition: { goal: "Echo the input", context: "", constraints: [], doneWhen: ["Input returned"], verify: [], expectedResult: "Team result", stopRules: [] } } } });
  const workflowId = created.workflow.workflowId;
  const graph = structuredClone(created.revision.graph);
  const skillNode = makeSkillNode({ nodeId: "node-echo", skillId: "b2-skill", inputPortId: "goal", targetPortId: "goal", outputPortId: "result",
    outputSchema: graph.nodes[1].inputPorts[0].schema });
  graph.nodes.splice(1, 0, skillNode);
  graph.nodes[2].inputBindings[0].source = { kind: "nodeOutput", nodeId: "node-echo", portId: "result" };
  graph.edges = [
    { edgeId: "input-echo", sourceNodeId: "node-input", sourcePort: "goal", targetNodeId: "node-echo", targetPort: "goal" },
    { edgeId: "echo-output", sourceNodeId: "node-echo", sourcePort: "result", targetNodeId: "node-output", targetPort: "result" },
  ];
  const reviewNode=makeReviewNode({sourceNodeId:'node-echo',sourcePortId:'result'});
  reviewNode.configuration.revisionTarget={nodeId:'node-echo',portId:'goal'};
  reviewNode.inputPorts[0].schema=structuredClone(graph.nodes[2].inputPorts[0].schema);
  reviewNode.outputPorts[0].schema=structuredClone(graph.nodes[2].inputPorts[0].schema);
  graph.nodes.splice(2,0,reviewNode);
  graph.nodes[3].inputBindings[0].source={kind:'nodeOutput',nodeId:'node-review',portId:'approved'};
  graph.edges[1]={edgeId:'echo-review',sourceNodeId:'node-echo',sourcePort:'result',targetNodeId:'node-review',targetPort:'candidate'};
  graph.edges.push({edgeId:'review-output',sourceNodeId:'node-review',sourcePort:'approved',targetNodeId:'node-output',targetPort:'result'});
  const saved = await lifecycle.saveWorkflowRevision({ workspaceId, authoredBy: userId, workflowId,
    idempotencyKey: "publication-save", ifMatch: formatWorkflowEtag(created.workflow),
    request: { data: { ...created.revision, baseRevisionId: created.revision.revisionId, graph,
      resourceRefs: [{ resourceId: "b2-resource", version: "1.0.0", contentHash: resourceHash }] } } });
  const revisionId = saved.revision.revisionId;
  const compiled = await compiler.compileWorkflow({ workspaceId, compiledBy: userId, workflowId, revisionId, idempotencyKey: "publication-compile", request: { data: {} } });
  assert.equal(compiled.status, "ready", JSON.stringify(compiled));
  const readWorkflow = () => store.createWorkflowReadModel().getWorkflow({ workspaceId, workflowId });
  const publish = async () => lifecycle.publishLoop({ workspaceId, workflowId, releasedBy: userId,
    ifMatch: (await readWorkflow()).etag, idempotencyKey: "publication-publish",
    request: { data: { version: "1.0.0", releaseNotes: "Tested method", startingPoint: true } } });
  await assert.rejects(publish(), { code: "loop_test_run_required" });

  let cancellationStarted=false;const revisionInputs=[];let interruptedRevision=null;
  const makeRunner=(workerId,faultInjector=async()=>{})=>{
    const admission = new AdmissionController({ persistence: new PostgresCapacityPersistence({ store }), idFactory,
      resolveProductCommand: createPostgresProductCommandResolver({ store }) });
    const broker = new ExecutionBroker({ persistence: new PostgresExecutionPersistence({ store }), capacityAuthorizer: admission, idFactory });
    broker.registerBackend({ mode: "deterministic_skill", isolation: "process", backend: {
      async execute({ request, signal }) {
        if(request.input.goal.startsWith('Revise this result'))revisionInputs.push(request.input.goal);
        if(request.input.goal==='Cancel this result'){cancellationStarted=true;await delay(10000,null,{signal});}
        return { status: "completed", output: { result: request.input.goal }, summary: "Echoed input", evidence: [], usage: { steps: 1, modelRequests: 0, inputBytes: 10, outputBytes: 10 } };
      },
    } });
    return createWorkflowRunner({ store, idFactory, workerId, leaseDurationMs:2000, faultInjector,
      commandIntake: new PostgresWorkflowRunCommandIntake({ store }),
      reviewCommandIntake:new PostgresWorkflowRunReviewCommandIntake({store}), cancellationCommandIntake:new PostgresWorkflowRunCancellationCommandIntake({store}),
      runPersistence: createPostgresWorkflowRunPersistence({ store, workspaceId }), runControl: createPostgresRunControl({ store, workspaceId, idFactory }),
      resolveExecution: createPostgresWorkflowExecutionResolver({ store }),
      executionBroker: new AdmittedExecutionDispatcher({ broker, admissionController: admission }),
      agentRuntime: { async buildAuthoritativeFinal({ runId, finalText, evidenceGaps, reviewPacket }) {
        return { finalText, evidenceGaps, reviewPacket, agentFinalReadModel: { schemaVersion: "agent-final-read-model-v1", runID: runId, finalText } };
      } },
    });
  };
  const runner=makeRunner('desktop-original-worker',async(boundary,context)=>{
    if(boundary==='review-revision-completed'&&!interruptedRevision){interruptedRevision=context.runId;throw new WorkflowRunnerError('run_lease_lost');}
  });
  const recoverRevision=async(runId)=>{
    const deadline=Date.now()+8000;let expired=false;
    do{
      if(interruptedRevision===runId)expired=(await pool.query(`SELECT clock_timestamp()>lease_expires_at AS expired FROM public.workflow_run_jobs WHERE workspace_id=$1 AND run_id=$2`,[workspaceId,runId])).rows[0]?.expired;
      if(expired)break;await delay(25);
    }while(Date.now()<deadline);
    assert.equal(interruptedRevision,runId);assert.equal(expired,true,'the interrupted worker must lose its actual database lease before recovery');
    await makeRunner('desktop-recovered-worker').recover();
  };
  const finishReviewed=async(runId,actor)=>{
    const deadline=Date.now()+15000;
    let value;
    do{
      value=await runner.getRun(runId);
      if(value.run.status==='waiting_review'){
        const data={runId,nodeId:'node-review',decision:'approve',requestedChanges:[],expectedNodeRunId:value.run.nodeRuns.find(n=>n.status==='waiting_review').nodeRunId};
        const authority=await new PostgresAgentCommandAuthorizer({store}).authorizeWorkflowRunReview({workspaceId,userId:actor,...data});
        await runner.submitReviewDecision({...data,decidedBy:actor,idempotencyKey:'fixture-approve-'+runId,authorizationDecisionId:authority.authorizationDecisionId});
      }
      if(value.run.status==='completed')return value;
      await delay(25);
    }while(Date.now()<deadline);
    throw new Error('Fixture review did not complete: '+JSON.stringify(value));
  };
  const runInput = { workspaceId, userId, workflowId, workflowRevisionId: revisionId, inputs: { goal: "Shared result" }, resourceRefs: [], materialBindings: [] };
  const authority = await new PostgresAgentCommandAuthorizer({ store }).authorizeWorkflowRun(runInput);
  let state = { run: await runner.startRun({ ...runInput, requestedBy: userId, authorizationDecisionId: authority.authorizationDecisionId, idempotencyKey: "publication-run", requestId: "publication-request" }) };
  state=await finishReviewed(state.run.runId,userId);
  assert.equal(state.run.status, "completed", JSON.stringify(state));
  assert.equal(state.readModel.finalAnswer.content, "Shared result");
  const published = await publish();
  assert.equal(Check(LoopVersionSchema, published.loopVersion), true, JSON.stringify(published.loopVersion));
  assert.equal(Check(WorkspaceAssetReleaseSchema, published.release), true, JSON.stringify(published.release));
  assert.deepEqual(published.loopVersion.pinnedSkills, [{ skillId: "b2-skill", version: "1.0.0" }]);
  const pins = (await pool.query(`SELECT skill_version_id FROM public.loop_version_skill_pins WHERE workspace_id = $1 AND loop_version_id = $2`, [workspaceId, published.loopVersion.loopVersionId])).rows;
  assert.deepEqual(pins, [{ skill_version_id: "b2-skill-v1" }]);
  const materials = (await pool.query(`SELECT resource_id, content_hash FROM public.loop_version_resource_pins WHERE workspace_id = $1 AND loop_version_id = $2`, [workspaceId, published.loopVersion.loopVersionId])).rows;
  assert.deepEqual(materials, [{ resource_id: "b2-resource", content_hash: resourceHash }]);
  await assert.rejects(pool.query(`DELETE FROM public.loop_version_skill_pins WHERE workspace_id = $1 AND loop_version_id = $2`, [workspaceId, published.loopVersion.loopVersionId]), { code: "55000" });
  const library = new PostgresTeamLibraryReadModel({ store });
  assert.ok((await library.list({ workspaceId })).some((release) => release.releaseId === published.release.releaseId));
  const installed = await new PostgresTeamLibraryLifecycle({ store, idFactory }).installRelease({ workspaceId, installedBy: memberId, releaseId: published.release.releaseId,
    idempotencyKey: "teammate-install", request: { data: {} } });
  assert.equal(installed.pinnedVersionId, published.loopVersion.loopVersionId);
  const durable = await library.getInstallation({ workspaceId, installationId: installed.installationId });
  assert.equal(durable.installedBy, memberId);
  assert.equal(durable.pinnedVersionId, published.loopVersion.loopVersionId);
  const consumer = await lifecycle.createLoopFromRelease({ workspaceId, authoredBy: memberId, releaseId: published.release.releaseId,
    idempotencyKey: "teammate-use-loop", request: { data: {} } });
  assert.equal(consumer.workflow.ownerId, memberId);
  assert.equal(Check(SourceReleaseRefSchema, consumer.workflow.sourceRelease), true, JSON.stringify(consumer.workflow.sourceRelease));
  assert.equal(consumer.workflow.visibility, "private");
  assert.equal(consumer.workflow.sourceRelease.versionId, published.loopVersion.loopVersionId);
  assert.deepEqual(consumer.revision.resourceRefs, saved.revision.resourceRefs);
  const again = await lifecycle.createLoopFromRelease({ workspaceId, authoredBy: memberId, releaseId: published.release.releaseId,
    idempotencyKey: "teammate-use-loop", request: { data: {} } });
  assert.equal(again.workflow.workflowId, consumer.workflow.workflowId);
  const commandAuthorizer = new PostgresAgentCommandAuthorizer({ store });
  const team = new PostgresTeamWorkLifecycle({ store, idFactory,
    promotionLifecycle: new PostgresWorkItemPromotionLifecycle({ store, commandAuthorizer, idFactory,
      agentTurnRunner: { createSession() { throw new Error("Personal Agent sessions must not be created by shared Loop execution."); } },
    }),
  });
  const ownerContext = { workspaceId, userId, role: "owner" };
  const memberContext = { workspaceId, userId: memberId, role: "member" };
  const project = await team.createProject({ context: ownerContext, request: { data: {
    title: "Team Loop project", objective: "Use a teammate's version with my environment", members: [{ userId: memberId }],
  } } });
  const item = await team.createTeamWorkItem({ context: ownerContext, request: { data: {
    projectId: project.data.projectId, title: "Weekly feedback", objective: "Share the declared outcome", summary: "Approved team input only",
    members: [{ userId: memberId, access: "contribute", roles: ["participant"] }],
  } } });
  const consumerCompile = await compiler.compileWorkflow({ workspaceId, compiledBy: memberId, workflowId: consumer.workflow.workflowId,
    revisionId: consumer.revision.revisionId, idempotencyKey: "teammate-compile", request: { data: {} } });
  assert.equal(consumerCompile.status, "ready", JSON.stringify(consumerCompile));
  const memberInput = { workspaceId, userId: memberId, workflowId: consumer.workflow.workflowId, workflowRevisionId: consumer.revision.revisionId,
    inputs: { goal: "Member's result" }, resourceRefs: [], materialBindings: [] };
  const workItemId = item.data.workItemId;
  const companionKind = `work-item:${workItemId}`;
  const memberAuthority = await commandAuthorizer.authorizeWorkflowRun({ ...memberInput, companionKind });
  const startShared = () => runner.startRunWithCompanion({ ...memberInput, requestedBy: memberId, authorizationDecisionId: memberAuthority.authorizationDecisionId,
    idempotencyKey: "member-run", requestId: "member-request" }, { kind: companionKind,
    persist: ({ run, transactionSession }) => team.attachWorkflowRun({ context: memberContext, workItemId, run, transactionSession }),
  });
  const { run: memberRun } = await startShared();
  assert.equal((await startShared()).run.runId, memberRun.runId, "retry must reuse the shared Run");
  const memberResult = await finishReviewed(memberRun.runId,memberId);
  assert.equal(memberResult.run.status, "completed", JSON.stringify({ ...memberResult, events: await runner.listEvents(memberRun.runId) }));
  assert.equal(memberResult.readModel.finalAnswer.content, "Member's result");
  const owner = (await pool.query(`SELECT command.effective_principal_id, command.quota_user_id, run.scope_id
    FROM public.workflow_runs run JOIN public.product_commands command ON command.workspace_id = run.workspace_id AND command.command_id = run.product_command_id
    WHERE run.workspace_id = $1 AND run.run_id = $2`, [workspaceId, memberRun.runId])).rows[0];
  const memberScope = (await pool.query("SELECT scope_id FROM public.product_scopes WHERE workspace_id = $1 AND owner_user_id = $2 AND scope_kind = 'personal'", [workspaceId, memberId])).rows[0].scope_id;
  assert.deepEqual(owner, { effective_principal_id: memberId, quota_user_id: memberId, scope_id: memberScope });
  const shared = await team.listWorkflowRuns({ context: ownerContext, workItemId });
  assert.equal(shared.length, 1);
  assert.equal(Check(WorkItemWorkflowRunSchema, shared[0]), true, JSON.stringify(shared[0]));
  assert.equal(shared[0].finalAnswer.content, "Member's result");
  assert.equal(shared[0].requestedByUserId, memberId);
  assert.equal(Object.hasOwn(shared[0], "resourceRefs"), false);
  assert.equal(Object.hasOwn(shared[0], "workflowId"), false);
  assert.notEqual((await team.getWorkItem({ context: ownerContext, workItemId })).data.workItem.status, "completed", "Run completion does not accept team work");
  await assert.rejects(team.listWorkflowRuns({ context: { workspaceId: "b2-workspace-b", userId: "b2-user-b", role: "owner" }, workItemId }), { code: "work_item_access_forbidden" });
  await exerciseNativeParticipation({ store, team, context: memberContext, workItemId,
    desktopLoop: { projectId: project.data.projectId, releaseId: published.release.releaseId, lifecycle, compiler, library, runner, commandAuthorizer, cancellationReady:()=>cancellationStarted, revisionInputs, recoverRevision,
      verifyCancellationBoundary:async(runId)=>{
        await assert.rejects(pool.query(`UPDATE public.execution_invocations SET status='cancellation_requested'
          WHERE invocation_id IN (SELECT invocation_id FROM public.workflow_run_node_attempts WHERE workspace_id=$1 AND run_id=$2 AND status='running')`,[workspaceId,runId]),{code:'23514'});
      },
      verifyCancellationClosed:async(runId)=>{
        const rows=(await pool.query(`SELECT node.status AS node_status,invocation.status,lease.status AS capacity_status,capability.status AS capability_status
          FROM public.workflow_run_node_attempts node JOIN public.execution_invocations invocation ON invocation.invocation_id=node.invocation_id
          JOIN public.capacity_leases lease ON lease.capacity_lease_id=invocation.capacity_lease_id
          JOIN public.capability_leases capability ON capability.invocation_id=invocation.invocation_id
          WHERE node.workspace_id=$1 AND node.run_id=$2`,[workspaceId,runId])).rows;
        assert.equal(rows.length,1);assert.deepEqual(rows[0],{node_status:'cancelled',status:'cancelled',capacity_status:'released',capability_status:'revoked'});
      } },
    revoke: () => team.revokeAccessGrant({ context: ownerContext, workItemId, grantId: item.data.members.find((member) => member.userId === memberId).accessGrant.grantId }),
  });
  await assert.rejects(team.listWorkflowRuns({ context: memberContext, workItemId }), { code: "work_item_access_forbidden" });
  await assert.rejects(team.requireWorkflowRunAccess({ context: memberContext, workItemId }), { code: "work_item_access_forbidden" });
}
