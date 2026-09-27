import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostgresModelConfiguration } from "../../src/models/postgres-model-configuration.mjs";
import { PostgresModelCatalog } from "../../src/models/postgres-model-catalog.mjs";
import { MountedCloudSecretStore, PostgresSecretBindingGateway } from "../../src/security/mounted-cloud-secret-store.mjs";
import { PostgresAgentCommandAuthorizer } from "../../src/coordination/postgres-agent-command-authorizer.mjs";
import { Pool } from "pg";
import { HmacIdentityTokenSigner } from "../../src/auth/hmac-identity-token-signer.mjs";
import { AuthService } from "../../src/auth/auth-service.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";
import { PostgresWorkbenchSessionStore } from "../../src/security/postgres-workbench-session-store.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { createPostgresIdempotentMutationPort, createPostgresProductCommandResolver, PostgresAgentTurnCommandIntake, PostgresBuilderProposalCommandIntake } from "../../src/coordination/index.mjs";
import { AgentTurnRunner } from "../../src/agents/agent-turn-runner.mjs";
import { createProductAgentExecutor } from "../../src/agents/product-agent-executor.mjs";
import { AdmissionController, AdmittedExecutionDispatcher, ExecutionBroker, PostgresCapacityPersistence, PostgresExecutionPersistence } from "../../src/execution/index.mjs";

const ORIGIN = "https://model-setup.example.test";
test("administrator configures a model through Product HTTP with durable replay and isolated authority", {
  skip: process.env.WORKBENCH_POSTGRES_INTEGRATION !== "1",
}, async (t) => {
  const connectionString = process.env.WORKBENCH_POSTGRES_URL;
  assert.match(new URL(connectionString).pathname, /_test$/);
  const pool = new Pool({ connectionString, max: 8 });
  const store = new ProductPostgresStore({ pool });
  t.after(async () => { await store.close(); await pool.end(); });
  await store.runMigrations();
  const invitations = [];
  const authService = new AuthService({ store, persistence: store.createAuthPersistence(),
    bootstrapAdminToken: "model-setup-bootstrap", workspaceId: "model-setup-workspace",
    workspaceName: "Model setup test", bcryptCost: 10,
    invitationTokenSigner: new HmacIdentityTokenSigner({ secret: "0123456789abcdef0123456789abcdef" }),
    invitationBaseUrl: ORIGIN,
    invitationMailer: { async sendWorkspaceInvitation(message) { invitations.push(message); return { receiptId: "test-delivery" }; } },
    oauthProviders: { google: {
      async authorizationUrl({ state }) { return `https://identity.example.test/authorize?state=${encodeURIComponent(state)}`; },
      async complete() { return { provider: "google", providerSubject: "model-member", verifiedEmail: "member@example.test" }; },
    } },
  });
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  const secretRoot = await mkdtemp(join(tmpdir(), "turnsu-model-configuration-"));
  t.after(() => rm(secretRoot, { recursive: true, force: true }));
  await mkdir(join(secretRoot, "model-setup-workspace"), { mode: 0o700 });
  await writeFile(join(secretRoot, "model-setup-workspace", "model-setup.v1.secret"), "test-provider-credential", { mode: 0o600 });
  const secretStore = new MountedCloudSecretStore({ rootDirectory: secretRoot });
  const gateway = new PostgresSecretBindingGateway({ persistence: store.createSecretBindingPersistence(), secretStore });
  const catalog = new PostgresModelCatalog({ store, readinessResolver: async ({ revision }) => {
    await gateway.resolve(revision.secretBindingId, { workspaceId: revision.workspaceId, revision });
    return { state: "ready" };
  } });
  const probes = [];
  let providerStatus = 200;
  // Only the external provider is simulated. Auth, command authority, secrets,
  // HTTP contracts, transactions, catalog and idempotence are real adapters.
  const configuration = new PostgresModelConfiguration({ store,
    authorizer: new PostgresAgentCommandAuthorizer({ store }), secretStore,
    fetchImpl: async (url, options) => {
      probes.push(url); assert.equal(url, "https://api.deepseek.com/models");
      assert.equal(options.headers.Authorization, "Bearer test-provider-credential");
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ data: [{ id: "deepseek-chat" }] }), { status: providerStatus });
    },
  });
  const authorizer = new PostgresAgentCommandAuthorizer({ store });
  const admissionController = new AdmissionController({ persistence: new PostgresCapacityPersistence({ store }),
    resolveProductCommand: createPostgresProductCommandResolver({ store }), idFactory: (kind) => `${kind}-${randomUUID()}` });
  const broker = new ExecutionBroker({ persistence: new PostgresExecutionPersistence({ store }), capacityAuthorizer: admissionController, clock: () => new Date().toISOString(), idFactory: (kind) => `${kind}-${randomUUID()}` });
  const agentTurnRunner = new AgentTurnRunner({
    persistence: store.createAgentPersistence({ commandIntake: new PostgresAgentTurnCommandIntake({ store }) }),
    executor: createProductAgentExecutor(), commandAuthorizer: authorizer,
    executionBroker: new AdmittedExecutionDispatcher({ broker, admissionController }),
    idFactory: (kind) => `${kind}-${randomUUID()}`,
    resolveBaseVersion: async () => { throw new Error("main_session_has_no_object_version"); },
    resolveModelSelection: async ({ workspaceId, userId, modelProfileId, requiredCapabilities }) => {
      const resolved = await catalog.resolveCurrentProfile({ workspaceId, userId, profileId: modelProfileId, capabilities: requiredCapabilities });
      return { profileId: resolved.profile.profileId, revisionId: resolved.revision.revisionId, capability: "tool_calling", limits: resolved.revision.limits };
    },
  });
  let proposalExecutions = 0;
  const proposalBroker = new ExecutionBroker({ persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admissionController, idFactory: (kind) => `${kind}-${randomUUID()}` });
  proposalBroker.registerBackend({ mode: "bounded_agent", isolation: "container", backend: {
    async probe() { return { available: true, verified: true }; },
    async execute({ request: execution }) {
      proposalExecutions += 1;
      assert.equal(execution.metadata.modelCapability, "tool_calling");
      return { status: "completed", output: { summary: "A reviewed outline", operations: [{ op: "updateDefinition",
        definition: { ...execution.input.revision.definition, expectedResult: "A checked summary" } }], diagnostics: [], permissionImpact: [] },
        evidence: [], summary: "Proposal prepared.", usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 } };
    },
  } });
  const application = createWorkbenchApplication({ store,
    workflowReadModel: store.createWorkflowReadModel(),
    externalMutationPort: store.createExternalMutationPort(),
    builderProposalReadModel: store.createBuilderProposalReadModel(),
    // Command acceptance time belongs to PostgreSQL, even with small host clock skew.
    builderProposalLifecycle: store.createBuilderProposalLifecycle({
      clock: () => new Date(Date.now() + 1000).toISOString(),
      commandIntake: new PostgresBuilderProposalCommandIntake({ store }), commandAuthorizer: authorizer,
    }),
    // Model output is controlled; HTTP, scope, command, admission and persistence are real.
    executionBroker: new AdmittedExecutionDispatcher({ broker: proposalBroker, admissionController }),
    modelConfiguration: configuration, modelCatalog: catalog, agentTurnRunner, admissionController,
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }) });
  const server = http.createServer(createWorkbenchHttpHandler({ application, authService, sessionStore, origin: ORIGIN, internalErrorReporter: (error) => console.error("controlled_test_http_error", error) }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const request = async (path, { method = "GET", data, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workbench/v1${path}`, {
      method, headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", ...headers },
      ...(data ? { body: JSON.stringify({ schemaVersion: "workbench-api-v1", data }) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const registered = await request("/auth/register", { method: "POST", headers: { "Idempotency-Key": "model-owner-register" },
    data: { username: "model-owner", password: "Model-Test-2026!", bootstrapToken: "model-setup-bootstrap" } });
  assert.equal(registered.status, 201);
  const cookie = /^workbench_session=([^;]+)/.exec(registered.headers.get("set-cookie"))[1];
  const session = await sessionStore.get(cookie);
  const headers = { Cookie: `workbench_session=${cookie}`, "X-Workbench-CSRF": session.csrfToken, "Idempotency-Key": "first-model" };
  const data = {
    displayName: "My reasoning model", provider: "deepseek", providerModelId: "deepseek-chat",
    secretRef: "model-setup:1", makeDefault: true,
  };
  const configured = await request("/model-profiles", { method: "POST", headers, data });
  assert.equal(configured.status, 201, JSON.stringify(configured.body));
  const { profileId, revisionId } = configured.body.data;
  const replay = await request("/model-profiles", { method: "POST", headers, data });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body.data, configured.body.data);
  assert.equal(probes.length, 1, "replay must not probe or create another binding");
  const changed = await request("/model-profiles", { method: "POST", headers, data: { ...data, displayName: "Changed" } });
  assert.equal(changed.status, 409, "an idempotency key is bound to the exact request");
  const listed = await request("/model-profiles", { headers });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.data.length, 1);
  assert.equal(listed.body.data[0].profileId, profileId);
  assert.equal(listed.body.data[0].selectable, true);
  const ownerReadiness = await request("/workspace/feature-readiness", { headers });
  assert.equal(ownerReadiness.status, 200, JSON.stringify(ownerReadiness.body));
  assert.equal(ownerReadiness.body.data.support.selectableBuilderModelCount, 1, "the configured personal model must enable this owner's builder");
  assert.equal(ownerReadiness.body.data.actions.stagedLoopProposal.draftable.status, "ready");
  const serialized = JSON.stringify(listed.body);
  for (const privateValue of ["test-provider-credential", "model-setup:1", "configurationCommandId", "secretBindingId", "api.deepseek.com"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  const persisted = (await pool.query(`SELECT revision.config_hash, command.argument_digest, command.status,
      command.authorization_decision_id, binding.status AS binding_status
    FROM model_profile_revisions revision JOIN secret_bindings binding USING (workspace_id, secret_binding_id)
    JOIN product_commands command ON command.workspace_id = revision.workspace_id AND command.target_id = revision.revision_id
    WHERE revision.revision_id = $1`, [revisionId])).rows[0];
  assert.equal(persisted.status, "completed"); assert.equal(persisted.binding_status, "active");
  assert.equal(persisted.config_hash, persisted.argument_digest);
  assert.ok(persisted.authorization_decision_id);
  // A second account activates through the real invitation/session boundary;
  // only delivery and the external OAuth identity assertion are simulated.
  const invite = await request("/workspace/invitations", { method: "POST", headers: { ...headers, "Idempotency-Key": "invite-member" }, data: { email: "member@example.test" } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  await authService.deliverInvitationOutbox({ limit: 1 });
  const token = new URLSearchParams(new URL(invitations[0].invitationUrl).hash.slice(1)).get("token");
  const oauth = await request("/auth/oauth/google/start", { method: "POST", data: { token } });
  assert.equal(oauth.status, 200, JSON.stringify(oauth.body));
  const state = new URL(oauth.body.data.authorizationUrl).searchParams.get("state");
  const login = await request(`/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=verified-provider-code`);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const member = login.body.data;
  const memberCookie = /^workbench_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1];
  const memberSession = await sessionStore.get(memberCookie);
  const memberHeaders = { Cookie: `workbench_session=${memberCookie}`, "X-Workbench-CSRF": memberSession.csrfToken, "Idempotency-Key": "member-model" };
  const denied = await request("/model-profiles", { method: "POST", headers: memberHeaders, data });
  assert.equal(denied.status, 403);
  assert.equal(probes.length, 1, "membership is checked before probing credentials");
  const memberList = await request("/model-profiles", { headers: memberHeaders });
  assert.equal(memberList.status, 200);
  assert.deepEqual(memberList.body.data, [], "private model profiles are not another member's selections");
  const memberReadiness = await request("/workspace/feature-readiness", { headers: memberHeaders });
  assert.equal(memberReadiness.body.data.support.selectableBuilderModelCount, 0, "another person's model cannot make the member's builder ready");
  assert.equal(memberReadiness.body.data.actions.stagedLoopProposal.draftable.reasonCode, "model_route_unresolved");
  const deniedProposal = await request("/loop-draft-proposals", { method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "member-foreign-builder-model" },
    data: { name: "Private model check", sourceText: "Summarize a short note.", modelProfileId: profileId,
      definition: { goal: "Summarize a short note.", context: "", constraints: [], doneWhen: ["Summary produced"], verify: [], expectedResult: "A summary", stopRules: [] } } });
  assert.equal(deniedProposal.status, 404, JSON.stringify(deniedProposal.body));
  assert.equal(proposalExecutions, 0, "a foreign personal model cannot reach the proposal worker");
  const ownerProposal = await request("/loop-draft-proposals", { method: "POST",
    headers: { ...headers, "Idempotency-Key": "owner-builder-personal-model" },
    data: { name: "Personal workflow", sourceText: "Summarize a short note.", modelProfileId: profileId,
      definition: { goal: "Summarize a short note.", context: "", constraints: [], doneWhen: ["Summary produced"], verify: [], expectedResult: "A summary", stopRules: [] } } });
  assert.equal(ownerProposal.status, 201, JSON.stringify(ownerProposal.body));
  assert.equal(ownerProposal.body.data.draft.definition.expectedResult, "A checked summary");
  assert.equal(proposalExecutions, 1);
  const proposalCommand = (await pool.query(`SELECT command.status, command.session_id, command.turn_id,
    proposal.generation_status, invocation.status AS execution_status FROM builder_proposals proposal
    JOIN product_commands command ON command.command_id = proposal.product_command_id
    JOIN execution_invocations invocation ON invocation.invocation_id = proposal.source_invocation_id
    WHERE proposal.proposal_id = $1`, [ownerProposal.body.data.proposalId])).rows[0];
  assert.equal(proposalCommand.status, "completed");
  assert.equal(proposalCommand.generation_status, "completed");
  assert.equal(proposalCommand.execution_status, "completed");
  assert.equal(proposalCommand.session_id, `builder-${ownerProposal.body.data.proposalId}`);
  assert.equal(proposalCommand.turn_id, proposalCommand.session_id);
  const proposalPath = `/loop-draft-proposals/${ownerProposal.body.data.proposalId}`;
  const restoredProposal = await request(proposalPath, { headers });
  assert.equal(restoredProposal.status, 200, JSON.stringify(restoredProposal.body));
  assert.equal(Object.hasOwn(restoredProposal.body.data, "generationStatus"), false);
  assert.equal((await request(proposalPath, { headers: memberHeaders })).status, 404);
  const reviewedDraft = { ...restoredProposal.body.data.draft, name: "My reviewed workflow",
    definition: { ...restoredProposal.body.data.draft.definition, goal: "My edited goal" } };
  const commitOptions = { method: "POST", headers: { ...headers, "Idempotency-Key": "owner-commit-workflow" }, data: { draft: reviewedDraft } };
  const committedProposal = await request(`${proposalPath}/commit`, commitOptions);
  assert.equal(committedProposal.status, 201, JSON.stringify(committedProposal.body));
  assert.equal(committedProposal.body.data.workflow.name, reviewedDraft.name);
  assert.equal(committedProposal.body.data.revision.definition.goal, "My edited goal");
  assert.equal(committedProposal.body.data.workflow.visibility, "private");
  const commitReplay = await request(`${proposalPath}/commit`, commitOptions);
  assert.equal(commitReplay.body.data.workflow.workflowId, committedProposal.body.data.workflow.workflowId);
  const workflowPath = `/workflows/${committedProposal.body.data.workflow.workflowId}`;
  const savedWorkflow = await request(workflowPath, { headers });
  assert.equal(savedWorkflow.status, 200, JSON.stringify(savedWorkflow.body));
  assert.equal(savedWorkflow.body.data.name, reviewedDraft.name);
  assert.equal(Object.hasOwn(savedWorkflow.body.data, "writeVersion"), false);
  const listedWorkflows = await request("/workflows", { headers });
  assert.equal(listedWorkflows.status, 200, JSON.stringify(listedWorkflows.body));
  assert.ok(listedWorkflows.body.data.some((workflow) => workflow.name === reviewedDraft.name));
  assert.equal((await request(workflowPath, { headers: memberHeaders })).status, 404);
  const savedRevision = await request(`${workflowPath}/revisions/${savedWorkflow.body.data.currentRevisionId}`, { headers });
  assert.equal(savedRevision.status, 200, JSON.stringify(savedRevision.body));
  assert.equal(savedRevision.body.data.definition.goal, "My edited goal");
  const memberPolicy = await catalog.getWorkspacePolicy("model-setup-workspace", { userId: member.user.userId });
  assert.equal(memberPolicy, null, "a later owner policy cannot become another member's default");
  assert.equal(await catalog.getWorkspacePolicy("model-setup-workspace"), null, "a scope is required for routing");
  await assert.rejects(catalog.resolveRevision({ workspaceId: "model-setup-workspace", userId: member.user.userId, revisionId }), { code: "model_profile_not_found" });
  const privateSelection = await request("/agent-sessions", { method: "POST",
    headers: { ...memberHeaders, "Idempotency-Key": "member-private-model-selection" },
    data: { definitionId: "main", title: "Forbidden private model", lastUsedModelProfileId: profileId } });
  assert.equal(privateSelection.status, 404, JSON.stringify(privateSelection.body));
  const ownerPolicy = await catalog.getWorkspacePolicy("model-setup-workspace", { userId: registered.body.data.user.userId });
  assert.equal(ownerPolicy.defaultProfileIdsByCapability.tool_calling, profileId);
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM model_profiles) AS profiles,
    (SELECT count(*)::int FROM secret_bindings) AS bindings,
    (SELECT count(*)::int FROM authorization_decisions) AS decisions,
    (SELECT count(*)::int FROM workspace_model_policy_revisions) AS policies`)).rows[0];
  const beforeFailure = await counts();
  providerStatus = 401;
  const rejected = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "bad-provider" }, data });
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "model_provider_auth_failed");
  assert.deepEqual(await counts(), beforeFailure, "failed probe rolls back authority and all configuration records");
  providerStatus = 200;
  const missing = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "missing-secret" }, data: { ...data, secretRef: "missing:1" } });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "model_secret_unavailable");
  assert.deepEqual(await counts(), beforeFailure);
  const foreign = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "foreign-scope" }, data: { ...data, workspaceId: "foreign-workspace" } });
  assert.equal(foreign.status, 400, "the browser cannot choose another workspace or scope");
  assert.deepEqual(await counts(), beforeFailure);
  const unavailableModel = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "unavailable-model" }, data: { ...data, providerModelId: "retired-model" } });
  assert.equal(unavailableModel.status, 409);
  assert.deepEqual(unavailableModel.body.details.availableModelIds, ["deepseek-chat"]);
  assert.deepEqual(await counts(), beforeFailure);
  const duplicate = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "duplicate-reference" }, data });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.code, "model_secret_already_bound");
  assert.deepEqual(await counts(), beforeFailure);

  // The administrator may provision a separate personal model for an active
  // teammate, without gaining access to that teammate's private scope.
  await writeFile(join(secretRoot, "model-setup-workspace", "member-model.v1.secret"), "test-provider-credential", { mode: 0o600 });
  const memberData = { ...data, displayName: "Member reasoning model", secretRef: "member-model:1", forUserId: member.user.userId };
  const beforeTargetProbes = probes.length;
  const missingTarget = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "missing-recipient" }, data: { ...memberData, forUserId: "user-not-a-workspace-member" } });
  assert.equal(missingTarget.status, 403, JSON.stringify(missingTarget.body));
  assert.equal(probes.length, beforeTargetProbes, "invalid recipients cannot cause credential access");
  await pool.query("UPDATE product_users SET disabled = true WHERE user_id = $1", [member.user.userId]);
  const disabledTarget = await request("/model-profiles", { method: "POST", headers: { ...headers, "Idempotency-Key": "disabled-recipient" }, data: memberData });
  assert.equal(disabledTarget.status, 403, JSON.stringify(disabledTarget.body));
  assert.equal(probes.length, beforeTargetProbes);
  await pool.query("UPDATE product_users SET disabled = false WHERE user_id = $1", [member.user.userId]);
  const provisionHeaders = { ...headers, "Idempotency-Key": "provision-member-model" };
  const provisioned = await request("/model-profiles", { method: "POST", headers: provisionHeaders, data: memberData });
  assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
  assert.deepEqual((await request("/model-profiles", { method: "POST", headers: provisionHeaders, data: memberData })).body.data, provisioned.body.data);
  assert.equal(probes.length, beforeTargetProbes + 1, "provisioning replay preserves the original receipt");
  const memberModels = await request("/model-profiles", { headers: memberHeaders });
  const provisionedReadiness = await request("/workspace/feature-readiness", { headers: memberHeaders });
  assert.equal(provisionedReadiness.body.data.support.selectableBuilderModelCount, 1);
  assert.equal(provisionedReadiness.body.data.actions.stagedLoopProposal.draftable.status, "ready");
  assert.deepEqual(memberModels.body.data.map((model) => model.profileId), [provisioned.body.data.profileId]);
  assert.equal((await catalog.getWorkspacePolicy("model-setup-workspace", { userId: member.user.userId })).defaultProfileIdsByCapability.tool_calling, provisioned.body.data.profileId);
  assert.equal((await catalog.getWorkspacePolicy("model-setup-workspace", { userId: registered.body.data.user.userId })).defaultProfileIdsByCapability.tool_calling, profileId);
  await assert.rejects(catalog.resolveRevision({ workspaceId: "model-setup-workspace", userId: registered.body.data.user.userId, revisionId: provisioned.body.data.revisionId }), { code: "model_profile_not_found" });
  const provenance = (await pool.query(`SELECT actor_scope.owner_user_id AS administrator, recipient_scope.owner_user_id AS recipient,
    command.actor_principal_id, command.argument_digest, revision.config_hash
    FROM model_profile_revisions revision JOIN model_profiles profile USING (workspace_id, profile_id)
    JOIN product_commands command ON command.workspace_id = revision.workspace_id AND command.target_id = revision.revision_id
    JOIN product_scopes actor_scope ON actor_scope.workspace_id = command.workspace_id AND actor_scope.scope_id = command.scope_id
    JOIN product_scopes recipient_scope ON recipient_scope.workspace_id = profile.workspace_id AND recipient_scope.scope_id = profile.scope_id
    WHERE revision.revision_id = $1`, [provisioned.body.data.revisionId])).rows[0];
  assert.equal(provenance.administrator, registered.body.data.user.userId);
  assert.equal(provenance.actor_principal_id, registered.body.data.user.userId);
  assert.equal(provenance.recipient, member.user.userId);
  assert.equal(provenance.argument_digest, provenance.config_hash);
  const memberTask = await request("/agent-sessions", { method: "POST", headers: { ...memberHeaders, "Idempotency-Key": "member-provisioned-task" }, data: { definitionId: "main", title: "Member's private task", lastUsedModelProfileId: provisioned.body.data.profileId } });
  assert.equal(memberTask.status, 201, JSON.stringify(memberTask.body));
  assert.equal((await request(`/agent-sessions/${memberTask.body.data.sessionId}`, { headers })).status, 404, "provisioning a model does not expose the recipient's private task");

  // Consume the configured model through real Agent intake. An intentionally
  // absent sandbox must produce a readable blocked task, never a malformed API.
  const createdSession = await request("/agent-sessions", { method: "POST", headers: { ...headers, "Idempotency-Key": "model-task-session" }, data: { definitionId: "main", title: "Configured model task" } });
  assert.equal(createdSession.status, 201, JSON.stringify(createdSession.body));
  const sessionId = createdSession.body.data.sessionId;
  const turn = await request(`/agent-sessions/${sessionId}/turns`, { method: "POST", headers: { ...headers, "Idempotency-Key": "model-task-turn" }, data: { kind: "agent_message", modelProfileId: profileId, input: { message: "Verify task recovery." } } });
  assert.equal(turn.status, 202, JSON.stringify(turn.body));
  await agentTurnRunner.waitForIdle(sessionId);
  const completedTurn = await request(`/agent-sessions/${sessionId}/turns/${turn.body.data.turnId}`, { headers });
  assert.equal(completedTurn.status, 200, JSON.stringify(completedTurn.body));
  assert.equal(completedTurn.body.data.status, "blocked");
  const events = await request(`/agent-sessions/${sessionId}/events`, { headers });
  assert.equal(events.status, 200, JSON.stringify(events.body));
  assert.ok(events.body.data.some((event) => event.type === "turn.blocked"));
  assert.ok(events.body.data.every((event) => !Object.hasOwn(event, "productCommandId")));
});
