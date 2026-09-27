import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { AuthService } from "../../src/auth/auth-service.mjs";
import { AgentTurnRunner } from "../../src/agents/agent-turn-runner.mjs";
import { createProductAgentExecutor } from "../../src/agents/product-agent-executor.mjs";
import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { HmacIdentityTokenSigner } from "../../src/auth/hmac-identity-token-signer.mjs";
import {
  PostgresAgentCommandAuthorizer,
  PostgresAgentTurnCommandIntake,
  createPostgresIdempotentMutationPort,
  createPostgresProductCommandResolver,
} from "../../src/coordination/index.mjs";
import {
  AdmissionController,
  AdmittedExecutionDispatcher,
  ExecutionBroker,
  PostgresCapacityPersistence,
  PostgresExecutionPersistence,
} from "../../src/execution/index.mjs";
import { createWorkbenchHttpHandler } from "../../src/http/workbench-http-handler.mjs";
import { PostgresWorkbenchSessionStore } from "../../src/security/postgres-workbench-session-store.mjs";
import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const ORIGIN = "https://app.example.test";
const PRIVATE_TASK_MODEL_PROFILE_ID = "http-invite-private-task-model";
const PRIVATE_TASK_MODEL_REVISION_ID = "http-invite-private-task-model-r1";
const TEAM_ENTRY_MODEL_PROFILE_ID = "http-invite-team-entry-model";
const TEAM_ENTRY_MODEL_REVISION_ID = "http-invite-team-entry-model-r1";
const CONTINUATION_MODEL_PROFILE_ID = "http-invite-continuation-model";
const CONTINUATION_MODEL_REVISION_ID = "http-invite-continuation-model-r1";
const FOREIGN_WORKSPACE_ID = "http-invite-foreign-workspace";
const FOREIGN_MODEL_PROFILE_ID = "http-invite-foreign-model";
const FOREIGN_MODEL_REVISION_ID = "http-invite-foreign-model-r1";
const PRIVATE_TASK_ARTIFACT_ID = "http-invite-private-task-artifact";
const PRIVATE_TASK_ARTIFACT_HASH = `sha256:${"c".repeat(64)}`;
const DIRECTORY_FOREIGN_USER_ID = "directory-foreign-user";
const DIRECTORY_DISABLED_USER_ID = "directory-disabled-user";

test("real PostgreSQL HTTP invitation activation promotes only safe private-task results and survives handler restart", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5_000 });
  const store = new ProductPostgresStore({ pool });
  const signer = new HmacIdentityTokenSigner({ secret: "0123456789abcdef0123456789abcdef" });
  const outbound = [];
  const oauth = {
    async authorizationUrl({ state, codeVerifier, nonce }) {
      assert.equal(typeof codeVerifier, "string");
      assert.equal(typeof nonce, "string");
      return `https://provider.example.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async complete({ code, codeVerifier, nonce }) {
      assert.equal(code, "provider-code");
      assert.equal(typeof codeVerifier, "string");
      assert.equal(typeof nonce, "string");
      return {
        provider: "google",
        providerSubject: "google-http-member",
        verifiedEmail: "member@example.test",
      };
    },
  };
  const githubOAuth = {
    async authorizationUrl({ state, codeVerifier }) {
      assert.equal(typeof codeVerifier, "string");
      return `https://github.example.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async complete({ code, codeVerifier }) {
      assert.equal(code, "github-provider-code");
      assert.equal(typeof codeVerifier, "string");
      return {
        provider: "github",
        providerSubject: "github-http-teammate",
        verifiedEmail: "teammate@example.test",
      };
    },
  };
  const authPersistence = store.createAuthPersistence();
  const authService = new AuthService({
    store,
    persistence: authPersistence,
    bootstrapAdminToken: "bootstrap-token",
    workspaceId: "http-invite-workspace",
    workspaceName: "HTTP invitation workspace",
    bcryptCost: 10,
    invitationTokenSigner: signer,
    invitationMailer: {
      async sendWorkspaceInvitation(message) {
        outbound.push(message);
        return { receiptId: `smtp-${randomUUID()}` };
      },
    },
    invitationBaseUrl: ORIGIN,
    oauthProviders: { google: oauth, github: githubOAuth },
  });
  const sessionStore = new PostgresWorkbenchSessionStore({ store });
  await store.runMigrations();
  const product = createPrivateTaskRuntime({ store });
  const internalErrors = [];
  const server = await startServer(createWorkbenchHttpHandler({
    application: product.application,
    authService,
    sessionStore,
    origin: ORIGIN,
    internalErrorReporter: (error) => internalErrors.push(error),
  }));
  t.after(async () => {
    await stopServer(server);
    await store.close();
    await pool.end();
  });

  const ownerRegistration = await request(server, "/api/workbench/v1/auth/register", {
    method: "POST",
    headers: browserHeaders({ "Idempotency-Key": "owner-register" }),
    body: { schemaVersion: "workbench-api-v1", data: {
      username: "owner", password: "password-123", bootstrapToken: "bootstrap-token",
    } },
  });
  assert.equal(ownerRegistration.status, 201);
  const ownerCookie = cookie(ownerRegistration);
  const ownerSession = await sessionStore.get(ownerCookie);
  assert.ok(ownerSession);

  const created = await request(server, "/api/workbench/v1/workspace/invitations", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "invite-member",
    }),
    body: { schemaVersion: "workbench-api-v1", data: { email: "Member@Example.Test" } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.invitation.status, "pending");
  assert.equal(outbound.length, 0, "creation only queues an outbox delivery");

  const dispatch = await authService.deliverInvitationOutbox({ limit: 1 });
  assert.deepEqual(dispatch, { delivered: 1, failed: 0, queued: 0 });
  assert.equal(outbound.length, 1);
  const invitationToken = new URLSearchParams(new URL(outbound[0].invitationUrl).hash.slice(1)).get("token");
  assert.equal(typeof invitationToken, "string");
  assert.match(invitationToken, /^v1~invitation~/u);

  const inspected = await request(server, "/api/workbench/v1/auth/invitations/inspect", {
    method: "POST",
    headers: browserHeaders(),
    body: { schemaVersion: "workbench-api-v1", data: { token: invitationToken } },
  });
  assert.equal(inspected.status, 200);
  assert.deepEqual(inspected.body.data.providers, ["github", "google"]);

  const started = await request(server, "/api/workbench/v1/auth/oauth/google/start", {
    method: "POST",
    headers: browserHeaders(),
    body: { schemaVersion: "workbench-api-v1", data: { token: invitationToken } },
  });
  assert.equal(started.status, 200);
  const state = new URL(started.body.data.authorizationUrl).searchParams.get("state");
  assert.ok(state);

  const callback = await request(
    server,
    `/api/workbench/v1/auth/oauth/google/callback?state=${encodeURIComponent(state)}&code=provider-code`,
  );
  assert.equal(callback.status, 200);
  const memberCookie = cookie(callback);
  assert.equal(callback.body.data.workspaceId, "http-invite-workspace");
  const memberSession = await sessionStore.get(memberCookie);
  assert.ok(memberSession);
  const memberUserId = callback.body.data.user.userId;

  await seedPromotionParticipantDecoys({
    pool,
    workspaceId: callback.body.data.workspaceId,
    workspaceOwnerUserId: ownerRegistration.body.data.user.userId,
  });
  const memberPromotionParticipants = await request(
    server,
    "/api/workbench/v1/work-items/promotion-participants",
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberPromotionParticipants.status, 200, JSON.stringify(memberPromotionParticipants.body));
  assert.equal(memberPromotionParticipants.headers.get("cache-control"), "no-store");
  assert.deepEqual(memberPromotionParticipants.body.data, [{
    userId: ownerRegistration.body.data.user.userId,
    displayName: "owner",
    username: "owner",
    role: "owner",
  }]);
  assert.equal(JSON.stringify(memberPromotionParticipants.body).includes("example.test"), false);
  const ownerPromotionParticipants = await request(
    server,
    "/api/workbench/v1/work-items/promotion-participants",
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerPromotionParticipants.status, 200, JSON.stringify(ownerPromotionParticipants.body));
  assert.deepEqual(ownerPromotionParticipants.body.data, [{
    userId: callback.body.data.user.userId,
    displayName: "Member",
    username: callback.body.data.user.username,
    role: "member",
  }]);

  // Activate a second invited member through the GitHub branch. The provider
  // adapter itself is tested against GitHub's verified-email response shape;
  // this proves the public HTTP callback reaches the same atomic PostgreSQL
  // account/membership/principal/personal-scope activation path.
  const teammateInvitation = await request(server, "/api/workbench/v1/workspace/invitations", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "invite-github-teammate",
    }),
    body: { schemaVersion: "workbench-api-v1", data: { email: "Teammate@Example.Test" } },
  });
  assert.equal(teammateInvitation.status, 201, JSON.stringify(teammateInvitation.body));
  assert.deepEqual(
    await authService.deliverInvitationOutbox({ limit: 1 }),
    { delivered: 1, failed: 0, queued: 0 },
  );
  assert.equal(outbound.length, 2);
  const teammateToken = new URLSearchParams(
    new URL(outbound[1].invitationUrl).hash.slice(1),
  ).get("token");
  const githubStarted = await request(server, "/api/workbench/v1/auth/oauth/github/start", {
    method: "POST",
    headers: browserHeaders(),
    body: { schemaVersion: "workbench-api-v1", data: { token: teammateToken } },
  });
  assert.equal(githubStarted.status, 200, JSON.stringify(githubStarted.body));
  const githubState = new URL(githubStarted.body.data.authorizationUrl).searchParams.get("state");
  assert.ok(githubState);
  const githubCallback = await request(
    server,
    `/api/workbench/v1/auth/oauth/github/callback?state=${encodeURIComponent(githubState)}&code=github-provider-code`,
  );
  assert.equal(githubCallback.status, 200, JSON.stringify(githubCallback.body));
  const teammateCookie = cookie(githubCallback);
  const teammateSession = await sessionStore.get(teammateCookie);
  assert.ok(teammateSession);
  assert.notEqual(githubCallback.body.data.user.userId, callback.body.data.user.userId);
  assert.match(
    await personalScopeId(
      pool,
      githubCallback.body.data.workspaceId,
      githubCallback.body.data.user.userId,
    ),
    /^scope-/u,
  );

  const projectCreated = await request(server, "/api/workbench/v1/projects", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-create-team-project",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      title: "HTTP Team Launch",
      objective: "Coordinate the launch through a durable Project boundary.",
      members: [{ userId: memberUserId }],
    } },
  });
  assert.equal(projectCreated.status, 201, JSON.stringify(projectCreated.body));
  assert.equal(projectCreated.headers.get("cache-control"), "no-store");
  const projectId = projectCreated.body.data.projectId;
  const projectEtag = projectCreated.headers.get("etag");
  assert.match(projectId, /^project-/u);
  assert.match(projectEtag, /^"projectv1:/u);
  assert.equal(projectCreated.body.data.scopeId.startsWith("scope-project-"), true);
  assert.deepEqual(projectCreated.body.data.members, [
    { userId: ownerRegistration.body.data.user.userId, role: "owner" },
    { userId: memberUserId, role: "member" },
  ]);

  const memberProjects = await request(server, "/api/workbench/v1/projects", {
    headers: { Cookie: `workbench_session=${memberCookie}` },
  });
  assert.equal(memberProjects.status, 200, JSON.stringify(memberProjects.body));
  assert.deepEqual(memberProjects.body.data.map((item) => item.projectId), [projectId]);

  const revisedProject = await request(
    server,
    `/api/workbench/v1/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: "PUT",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-revise-team-project-members",
        "If-Match": projectEtag,
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        members: [{ userId: memberUserId }, { userId: githubCallback.body.data.user.userId }],
      } },
    },
  );
  assert.equal(revisedProject.status, 200, JSON.stringify(revisedProject.body));
  const revisedProjectEtag = revisedProject.headers.get("etag");
  assert.match(revisedProjectEtag, /^"projectv1:/u);
  assert.notEqual(revisedProjectEtag, projectEtag);

  const teamWorkCreated = await request(server, "/api/workbench/v1/work-items", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-create-team-work-item",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      projectId,
      title: "Launch approval",
      objective: "Produce a shared, decision-ready launch approval.",
      summary: "Share only this product-safe launch context with the team.",
      priority: "high",
      members: [{
        userId: memberUserId,
        access: "contribute",
        roles: ["assignee"],
      }],
    } },
  });
  assert.equal(teamWorkCreated.status, 201, JSON.stringify(teamWorkCreated.body));
  assert.equal(teamWorkCreated.headers.get("cache-control"), "no-store");
  const teamWorkItemId = teamWorkCreated.body.data.workItemId;
  let teamWorkEtag = teamWorkCreated.headers.get("etag");
  assert.match(teamWorkEtag, /^"workv1:/u);
  assert.equal(teamWorkCreated.body.data.projectId, projectId);
  assert.equal(teamWorkCreated.body.data.source.kind, "team_work_item");
  assert.equal(JSON.stringify(teamWorkCreated.body).includes("Private investment research task"), false);

  // PRD §8.1: this is not a front-end sequence of create Work, continue,
  // then send. One HTTP command must leave a Work root, a private personal
  // continuation and its first Agent Turn with one shared Product Command.
  await seedPrivateTaskModel({ pool, workspaceId: callback.body.data.workspaceId,
    userId: ownerRegistration.body.data.user.userId,
    profileId: TEAM_ENTRY_MODEL_PROFILE_ID, revisionId: TEAM_ENTRY_MODEL_REVISION_ID });
  await seedPrivateTaskModel({ pool, workspaceId: callback.body.data.workspaceId,
    userId: callback.body.data.user.userId });
  const teamWorkAgentEntry = await request(server, "/api/workbench/v1/work-items/agent-entry", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-create-team-work-agent-entry",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      projectId,
      title: "Agent-led launch checklist",
      objective: "Produce an accountable first launch checklist for the team.",
      summary: "The team receives only this safe checklist context and no private transcript.",
      priority: "high",
      members: [{
        userId: memberUserId,
        access: "contribute",
        roles: ["assignee"],
      }],
      modelProfileId: TEAM_ENTRY_MODEL_PROFILE_ID,
      initialTask: { message: "Create the first accountable launch checklist." },
    } },
  });
  assert.equal(teamWorkAgentEntry.status, 202, JSON.stringify({ body: teamWorkAgentEntry.body, internalErrors }));
  assert.equal(teamWorkAgentEntry.headers.get("cache-control"), "no-store");
  const agentEntryWorkItemId = teamWorkAgentEntry.body.data.workItem.workItemId;
  const agentEntryContinuation = teamWorkAgentEntry.body.data.continuation;
  const agentEntryTurn = teamWorkAgentEntry.body.data.turn;
  assert.equal(agentEntryContinuation.workItemId, agentEntryWorkItemId);
  assert.equal(agentEntryTurn.sessionId, agentEntryContinuation.agentSessionId);
  assert.equal(agentEntryTurn.status, "queued");
  assert.equal(JSON.stringify(teamWorkAgentEntry.body).includes("Private investment research task"), false);

  const teamWorkAgentEntryReplay = await request(server, "/api/workbench/v1/work-items/agent-entry", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-create-team-work-agent-entry",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      projectId,
      title: "Agent-led launch checklist",
      objective: "Produce an accountable first launch checklist for the team.",
      summary: "The team receives only this safe checklist context and no private transcript.",
      priority: "high",
      members: [{ userId: memberUserId, access: "contribute", roles: ["assignee"] }],
      modelProfileId: TEAM_ENTRY_MODEL_PROFILE_ID,
      initialTask: { message: "Create the first accountable launch checklist." },
    } },
  });
  assert.equal(teamWorkAgentEntryReplay.status, 202, JSON.stringify(teamWorkAgentEntryReplay.body));
  assert.equal(teamWorkAgentEntryReplay.body.data.workItem.workItemId, agentEntryWorkItemId);
  assert.equal(teamWorkAgentEntryReplay.body.data.turn.turnId, agentEntryTurn.turnId);

  const agentEntryLedger = await pool.query(`
    SELECT command.kind, command.status, command.target_kind, command.target_id,
           command.target_revision, command.session_id, command.turn_id,
           continuation.agent_session_id, lifecycle.kind AS lifecycle_kind,
           thread.entry_kind
      FROM public.product_commands command
      JOIN public.agent_turns turn_row ON turn_row.product_command_id = command.command_id
      JOIN public.work_item_continuations continuation
        ON continuation.agent_session_id = command.session_id
      JOIN public.work_item_lifecycle_events lifecycle
        ON lifecycle.product_command_id = command.command_id
      JOIN public.work_thread_entries thread
        ON thread.product_command_id = command.command_id
     WHERE command.command_id = $1
  `, [agentEntryTurn.productCommandId]);
  assert.equal(agentEntryLedger.rows.length, 1);
  assert.ok(["accepted", "running", "completed"].includes(agentEntryLedger.rows[0].status));
  assert.deepEqual(agentEntryLedger.rows.map(({ status, ...entry }) => entry), [{
    kind: "agent_turn",
    target_kind: "work_item",
    target_id: agentEntryWorkItemId,
    target_revision: 1,
    session_id: agentEntryContinuation.agentSessionId,
    turn_id: agentEntryTurn.turnId,
    agent_session_id: agentEntryContinuation.agentSessionId,
    lifecycle_kind: "work_item_create",
    entry_kind: "handoff",
  }]);
  await product.agentTurnRunner.waitForIdle(agentEntryContinuation.agentSessionId);
  const completedAgentEntryTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(agentEntryContinuation.agentSessionId)}/turns/${encodeURIComponent(agentEntryTurn.turnId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(completedAgentEntryTurn.status, 200, JSON.stringify(completedAgentEntryTurn.body));
  assert.equal(completedAgentEntryTurn.body.data.status, "completed");

  const rejectedAgentEntry = await request(server, "/api/workbench/v1/work-items/agent-entry", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${ownerCookie}`,
      "X-Workbench-CSRF": ownerSession.csrfToken,
      "Idempotency-Key": "owner-rejected-team-work-agent-entry",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      title: "Must roll back",
      objective: "This entry must not persist when model resolution fails.",
      summary: "No handoff is allowed after a failed model resolution.",
      modelProfileId: "missing-team-entry-model",
      initialTask: { message: "This must fail before acceptance." },
    } },
  });
  assert.equal(rejectedAgentEntry.status, 404, JSON.stringify(rejectedAgentEntry.body));
  const rejectedAgentEntryRows = await pool.query(`
    SELECT count(*)::int AS count FROM public.work_items
     WHERE workspace_id = $1 AND title = 'Must roll back'
  `, [callback.body.data.workspaceId]);
  assert.equal(Number(rejectedAgentEntryRows.rows[0].count), 0);

  const memberTeamWork = await request(server, "/api/workbench/v1/work-items", {
    headers: { Cookie: `workbench_session=${memberCookie}` },
  });
  assert.equal(memberTeamWork.status, 200, JSON.stringify(memberTeamWork.body));
  assert.equal(memberTeamWork.body.data.some((item) => item.workItemId === teamWorkItemId), true);

  const activatedTeamWork = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}`,
    {
      method: "PATCH",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-activate-team-work-item",
        "If-Match": teamWorkEtag,
      }),
      body: { schemaVersion: "workbench-api-v1", data: { status: "active" } },
    },
  );
  assert.equal(activatedTeamWork.status, 200, JSON.stringify(activatedTeamWork.body));
  assert.equal(activatedTeamWork.body.data.status, "active");
  teamWorkEtag = activatedTeamWork.headers.get("etag");
  assert.match(teamWorkEtag, /^"workv1:/u);

  const reviewTeamWork = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}`,
    {
      method: "PATCH",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-review-team-work-item",
        "If-Match": teamWorkEtag,
      }),
      body: { schemaVersion: "workbench-api-v1", data: { status: "waiting_review" } },
    },
  );
  assert.equal(reviewTeamWork.status, 200, JSON.stringify(reviewTeamWork.body));
  teamWorkEtag = reviewTeamWork.headers.get("etag");

  const completedTeamWork = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}`,
    {
      method: "PATCH",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-complete-team-work-item",
        "If-Match": teamWorkEtag,
      }),
      body: { schemaVersion: "workbench-api-v1", data: { status: "completed" } },
    },
  );
  assert.equal(completedTeamWork.status, 200, JSON.stringify(completedTeamWork.body));
  assert.equal(completedTeamWork.body.data.status, "completed");
  assert.ok(completedTeamWork.body.data.completedAt);

  const teamWorkDetail = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}`,
    { headers: { Cookie: `workbench_session=${teammateCookie}` } },
  );
  assert.equal(teamWorkDetail.status, 200, JSON.stringify(teamWorkDetail.body));
  assert.equal(teamWorkDetail.body.data.workItem.workItemId, teamWorkItemId);
  assert.equal(teamWorkDetail.body.data.handoffCapsule.summary, "Share only this product-safe launch context with the team.");
  assert.equal(JSON.stringify(teamWorkDetail.body).includes("Private investment research task"), false);

  const teamWorkContinuation = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}/continuations`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-continue-direct-team-work-item",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {} },
    },
  );
  assert.equal(teamWorkContinuation.status, 201, JSON.stringify(teamWorkContinuation.body));
  assert.equal(teamWorkContinuation.body.data.workItemId, teamWorkItemId);
  assert.match(teamWorkContinuation.body.data.agentSessionId, /^agent-session-/u);
  assert.equal(teamWorkContinuation.body.data.handoffId, teamWorkDetail.body.data.handoffCapsule.handoffId);
  const teamWorkContinuationSession = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(teamWorkContinuation.body.data.agentSessionId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(teamWorkContinuationSession.status, 200, JSON.stringify(teamWorkContinuationSession.body));
  assert.equal(teamWorkContinuationSession.body.data.userId, memberUserId);
  assert.equal(teamWorkContinuationSession.body.data.scope.kind, "main");
  assert.deepEqual(teamWorkContinuationSession.body.data.workItemContext, {
    workItemId: teamWorkItemId,
    continuationId: teamWorkContinuation.body.data.continuationId,
  });
  const privateSessionList = await request(server, "/api/workbench/v1/agent-sessions", {
    headers: { Cookie: `workbench_session=${memberCookie}` },
  });
  assert.equal(privateSessionList.status, 200, JSON.stringify(privateSessionList.body));
  assert.deepEqual(privateSessionList.body.data.find(
    (session) => session.sessionId === teamWorkContinuation.body.data.agentSessionId,
  )?.workItemContext, teamWorkContinuationSession.body.data.workItemContext);
  const ownerCannotReadMemberContinuation = await request(server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(teamWorkContinuation.body.data.agentSessionId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } });
  assert.equal(ownerCannotReadMemberContinuation.status, 404);

  const teamWorkContinuationAgentEntry = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}/agent-entry`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-continue-direct-team-work-item-agent-entry",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        initialTask: { message: "Continue the shared launch handoff in my own branch." },
      } },
    },
  );
  assert.equal(teamWorkContinuationAgentEntry.status, 202, JSON.stringify(teamWorkContinuationAgentEntry.body));
  assert.equal(
    teamWorkContinuationAgentEntry.body.data.continuation.continuationId,
    teamWorkContinuation.body.data.continuationId,
  );
  assert.equal(
    teamWorkContinuationAgentEntry.body.data.turn.sessionId,
    teamWorkContinuation.body.data.agentSessionId,
  );
  const teamWorkContinuationAgentEntryReplay = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(teamWorkItemId)}/agent-entry`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-continue-direct-team-work-item-agent-entry",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        initialTask: { message: "Continue the shared launch handoff in my own branch." },
      } },
    },
  );
  assert.equal(teamWorkContinuationAgentEntryReplay.status, 202, JSON.stringify(teamWorkContinuationAgentEntryReplay.body));
  assert.equal(
    teamWorkContinuationAgentEntryReplay.body.data.turn.turnId,
    teamWorkContinuationAgentEntry.body.data.turn.turnId,
  );
  const continuationAgentEntryLedger = await pool.query(`
    SELECT command.kind, command.status, command.target_kind, command.target_id,
           command.target_revision, command.session_id, command.turn_id,
           event.work_item_id, event.continuation_id, event.agent_session_id, event.turn_id AS event_turn_id
      FROM public.product_commands command
      JOIN public.work_item_continuation_turn_events event
        ON event.workspace_id = command.workspace_id
       AND event.product_command_id = command.command_id
     WHERE command.command_id = $1
  `, [teamWorkContinuationAgentEntry.body.data.turn.productCommandId]);
  assert.equal(continuationAgentEntryLedger.rows.length, 1);
  assert.ok(["accepted", "running", "completed"].includes(continuationAgentEntryLedger.rows[0].status));
  assert.deepEqual(continuationAgentEntryLedger.rows.map(({ status, ...entry }) => entry), [{
    kind: "agent_turn",
    target_kind: "work_item_continuation_turn",
    target_id: teamWorkContinuationAgentEntry.body.data.turn.turnId,
    target_revision: 1,
    session_id: teamWorkContinuation.body.data.agentSessionId,
    turn_id: teamWorkContinuationAgentEntry.body.data.turn.turnId,
    work_item_id: teamWorkItemId,
    continuation_id: teamWorkContinuation.body.data.continuationId,
    agent_session_id: teamWorkContinuation.body.data.agentSessionId,
    event_turn_id: teamWorkContinuationAgentEntry.body.data.turn.turnId,
  }]);
  await product.agentTurnRunner.waitForIdle(teamWorkContinuation.body.data.agentSessionId);
  const completedTeamWorkContinuationEntry = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(teamWorkContinuation.body.data.agentSessionId)}/turns/${encodeURIComponent(teamWorkContinuationAgentEntry.body.data.turn.turnId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(completedTeamWorkContinuationEntry.status, 200, JSON.stringify(completedTeamWorkContinuationEntry.body));
  assert.equal(completedTeamWorkContinuationEntry.body.data.status, "completed");

  const teamWorkLedger = await pool.query(`
    SELECT command.kind, command.status, event.kind AS event_kind, event.target_revision
      FROM public.product_commands command
      JOIN public.work_item_lifecycle_events event
        ON event.product_command_id = command.command_id
     WHERE command.workspace_id = $1 AND event.work_item_id = $2
     ORDER BY event.target_revision
  `, [callback.body.data.workspaceId, teamWorkItemId]);
  assert.deepEqual(teamWorkLedger.rows.map((row) => [
    row.kind,
    row.status,
    row.event_kind,
    Number(row.target_revision),
  ]), [
    ["work_item_create", "completed", "work_item_create", 1],
    ["work_item_update", "completed", "work_item_update", 2],
    ["work_item_update", "completed", "work_item_update", 3],
    ["work_item_update", "completed", "work_item_update", 4],
  ]);

  const privateTask = await request(server, "/api/workbench/v1/agent-sessions", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${memberCookie}`,
      "X-Workbench-CSRF": memberSession.csrfToken,
      "Idempotency-Key": "member-private-task",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      definitionId: "main",
      title: "Private investment research task",
    } },
  });
  assert.equal(privateTask.status, 201, JSON.stringify(privateTask.body));
  assert.equal(privateTask.body.data.userId, callback.body.data.user.userId);
  assert.equal(privateTask.body.data.scope.kind, "main");
  assert.equal(privateTask.body.data.source.kind, "manual");
  assert.equal(privateTask.body.data.taskStatus, "idle");

  const teammateCannotReadPrivateTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${teammateCookie}` } },
  );
  assert.equal(teammateCannotReadPrivateTask.status, 404);
  assert.equal(teammateCannotReadPrivateTask.body.code, "agent_session_not_found");

  const privateTaskReplay = await request(server, "/api/workbench/v1/agent-sessions", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${memberCookie}`,
      "X-Workbench-CSRF": memberSession.csrfToken,
      "Idempotency-Key": "member-private-task",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      definitionId: "main",
      title: "Private investment research task",
    } },
  });
  assert.equal(privateTaskReplay.status, 201, JSON.stringify(privateTaskReplay.body));
  assert.equal(privateTaskReplay.body.data.sessionId, privateTask.body.data.sessionId);

  const queuedTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-private-task-turn",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        input: { message: "Summarize the private research evidence." },
      } },
    },
  );
  assert.equal(queuedTurn.status, 202, JSON.stringify(queuedTurn.body));
  assert.equal(queuedTurn.body.data.status, "queued");
  await product.agentTurnRunner.waitForIdle(privateTask.body.data.sessionId);

  const completedTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/turns/${encodeURIComponent(queuedTurn.body.data.turnId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(completedTurn.status, 200, JSON.stringify(completedTurn.body));
  assert.equal(completedTurn.body.data.status, "completed");
  assert.equal(completedTurn.body.data.result.response, "Private task completed through the governed test worker.");
  assert.equal(completedTurn.body.data.result.requestedModelRevisionId, PRIVATE_TASK_MODEL_REVISION_ID);
  assert.equal(completedTurn.body.data.result.actualModelRevisionId, PRIVATE_TASK_MODEL_REVISION_ID);

  const commandRows = await pool.query(`
    SELECT command.status, command.scope_id, decision.disposition
      FROM public.product_commands command
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
     WHERE command.command_id = $1
  `, [queuedTurn.body.data.productCommandId]);
  assert.deepEqual(commandRows.rows.map((row) => ({
    status: row.status,
    disposition: row.disposition,
    scopeId: row.scope_id,
  })), [{
    status: "completed",
    disposition: "authorized",
    scopeId: await personalScopeId(pool, callback.body.data.workspaceId, callback.body.data.user.userId),
  }]);
  const invocationRows = await pool.query(`
    SELECT status, controller_kind, product_command_id, lineage_session_id, lineage_turn_id
      FROM public.execution_invocations
     WHERE lineage_turn_id = $1
  `, [queuedTurn.body.data.turnId]);
  assert.deepEqual(invocationRows.rows, [{
    status: "completed",
    controller_kind: "agent_turn",
    product_command_id: queuedTurn.body.data.productCommandId,
    lineage_session_id: privateTask.body.data.sessionId,
    lineage_turn_id: queuedTurn.body.data.turnId,
  }]);
  const invocationIdentity = (await pool.query(`
    SELECT invocation_id, attempt_id, execution_fence, capability_lease_id
      FROM public.execution_invocations
     WHERE lineage_turn_id = $1
  `, [queuedTurn.body.data.turnId])).rows[0];
  assert.ok(invocationIdentity);
  await seedPrivateTaskArtifact({
    pool,
    workspaceId: callback.body.data.workspaceId,
    userId: callback.body.data.user.userId,
    sessionId: privateTask.body.data.sessionId,
    invocation: invocationIdentity,
  });

  // Reuse the already authenticated owner in a second tenant.  That makes a
  // wrong-workspace browser session a meaningful denial: it cannot be
  // attributed solely to a different user identity.
  await seedForeignWorkspaceOwner({
    pool,
    workspaceId: FOREIGN_WORKSPACE_ID,
    ownerUserId: ownerRegistration.body.data.user.userId,
  });
  assert.ok(await personalScopeId(pool, FOREIGN_WORKSPACE_ID, ownerRegistration.body.data.user.userId));
  const foreignIssued = await sessionStore.issue({
    userId: ownerRegistration.body.data.user.userId,
    activeWorkspaceId: FOREIGN_WORKSPACE_ID,
  });
  const foreignCookie = foreignIssued.token;
  const foreignSession = await sessionStore.get(foreignCookie);
  assert.ok(foreignSession);
  await seedPrivateTaskModel({
    pool,
    workspaceId: FOREIGN_WORKSPACE_ID,
    userId: ownerRegistration.body.data.user.userId,
    profileId: FOREIGN_MODEL_PROFILE_ID,
    revisionId: FOREIGN_MODEL_REVISION_ID,
    label: "Foreign workspace test model",
  });
  const foreignTask = await request(server, "/api/workbench/v1/agent-sessions", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${foreignCookie}`,
      "X-Workbench-CSRF": foreignSession.csrfToken,
      "Idempotency-Key": "foreign-private-task",
    }),
    body: { schemaVersion: "workbench-api-v1", data: {
      definitionId: "main",
      title: "Foreign workspace private task",
    } },
  });
  assert.equal(foreignTask.status, 201, JSON.stringify(foreignTask.body));
  assert.equal(foreignTask.body.data.workspaceId, FOREIGN_WORKSPACE_ID);
  assert.equal(foreignTask.body.data.userId, ownerRegistration.body.data.user.userId);
  const foreignQueuedTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${foreignCookie}`,
        "X-Workbench-CSRF": foreignSession.csrfToken,
        "Idempotency-Key": "foreign-private-task-turn",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: FOREIGN_MODEL_PROFILE_ID,
        input: { message: "Complete this task only in the foreign workspace." },
      } },
    },
  );
  assert.equal(foreignQueuedTurn.status, 202, JSON.stringify(foreignQueuedTurn.body));
  await product.agentTurnRunner.waitForIdle(foreignTask.body.data.sessionId);
  const foreignCompletedTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}/turns/${encodeURIComponent(foreignQueuedTurn.body.data.turnId)}`,
    { headers: { Cookie: `workbench_session=${foreignCookie}` } },
  );
  assert.equal(foreignCompletedTurn.status, 200, JSON.stringify(foreignCompletedTurn.body));
  assert.equal(foreignCompletedTurn.body.data.status, "completed");
  assert.equal(foreignCompletedTurn.body.data.result.actualModelRevisionId, FOREIGN_MODEL_REVISION_ID);

  const memberCannotReadForeignTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberCannotReadForeignTask.status, 404);
  assert.equal(memberCannotReadForeignTask.body.code, "agent_session_not_found");
  const sameOwnerCannotReadForeignTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(sameOwnerCannotReadForeignTask.status, 404);
  assert.equal(sameOwnerCannotReadForeignTask.body.code, "agent_session_not_found");
  const foreignCannotReadMemberTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${foreignCookie}` } },
  );
  assert.equal(foreignCannotReadMemberTask.status, 404);
  assert.equal(foreignCannotReadMemberTask.body.code, "agent_session_not_found");
  const memberCannotWriteForeignTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-cannot-write-foreign-task",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        input: { message: "This cross-workspace write must be denied." },
      } },
    },
  );
  assert.equal(memberCannotWriteForeignTask.status, 404);
  assert.equal(memberCannotWriteForeignTask.body.code, "agent_session_not_found");
  const sameOwnerCannotWriteForeignTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(foreignTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-cannot-write-foreign-task-from-main-workspace",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        input: { message: "This same-user cross-workspace write must be denied." },
      } },
    },
  );
  assert.equal(sameOwnerCannotWriteForeignTask.status, 404);
  assert.equal(sameOwnerCannotWriteForeignTask.body.code, "agent_session_not_found");
  const foreignCannotWriteMemberTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${foreignCookie}`,
        "X-Workbench-CSRF": foreignSession.csrfToken,
        "Idempotency-Key": "foreign-cannot-write-member-task",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: FOREIGN_MODEL_PROFILE_ID,
        input: { message: "This cross-workspace write must be denied." },
      } },
    },
  );
  assert.equal(foreignCannotWriteMemberTask.status, 404);
  assert.equal(foreignCannotWriteMemberTask.body.code, "agent_session_not_found");

  const memberDenied = await request(server, "/api/workbench/v1/workspace/invitations", {
    method: "POST",
    headers: browserHeaders({
      Cookie: `workbench_session=${memberCookie}`,
      "X-Workbench-CSRF": (await sessionStore.get(memberCookie)).csrfToken,
      "Idempotency-Key": "member-cannot-invite",
    }),
    body: { schemaVersion: "workbench-api-v1", data: { email: "other@example.test" } },
  });
  assert.equal(memberDenied.status, 403);
  assert.equal(memberDenied.body.code, "member_admin_required");

  const ownerCannotReadPrivateTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerCannotReadPrivateTask.status, 404);
  assert.equal(ownerCannotReadPrivateTask.body.code, "agent_session_not_found");

  const ownerCannotWritePrivateTask = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-cannot-write-member-task",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
        input: { message: "This cross-user write must be denied." },
      } },
    },
  );
  assert.equal(ownerCannotWritePrivateTask.status, 404);
  assert.equal(ownerCannotWritePrivateTask.body.code, "agent_session_not_found");

  const disabledParticipantPromotion = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/promote-to-work-item`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-cannot-share-with-disabled-account",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        title: "Unsafe disabled-account share",
        objective: "This promotion must reject a disabled workspace account.",
        summary: "No safe handoff can be issued to a disabled account.",
        participants: [{ userId: DIRECTORY_DISABLED_USER_ID, access: "contribute" }],
      } },
    },
  );
  assert.equal(disabledParticipantPromotion.status, 404, JSON.stringify(disabledParticipantPromotion.body));
  assert.equal(disabledParticipantPromotion.body.code, "work_item_participant_not_found");

  const promotionRequest = {
    schemaVersion: "workbench-api-v1",
    data: {
      title: "Team launch research",
      objective: "Prepare the team to make a launch decision from the private research.",
      summary: "Two launch risks need review; the recommended mitigation is ready for teammate follow-up.",
      priority: "high",
      participants: [{
        userId: ownerRegistration.body.data.user.userId,
        access: "contribute",
      }],
      decisions: [{
        question: "Which launch risk should be addressed first?",
        options: ["Onboarding", "Provider readiness"],
        chosenOutcome: "Provider readiness",
        rationale: "It has the widest impact on the planned launch window.",
        evidenceRefs: ["evidence-provider-readiness"],
        affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
      }],
      artifactIds: [PRIVATE_TASK_ARTIFACT_ID],
    },
  };
  const promoted = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/promote-to-work-item`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-promote-private-task",
      }),
      body: promotionRequest,
    },
  );
  assert.equal(promoted.status, 201, JSON.stringify(promoted.body));
  assert.equal(promoted.body.data.workItem.status, "ready");
  assert.equal(promoted.body.data.workItem.source.kind, "private_agent_task");
  assert.deepEqual(promoted.body.data.workItem.artifactRefs, [{
    artifactId: PRIVATE_TASK_ARTIFACT_ID,
    mediaType: "image/png",
    contentHash: PRIVATE_TASK_ARTIFACT_HASH,
    storageVersion: PRIVATE_TASK_ARTIFACT_HASH,
    publishedAt: promoted.body.data.workItem.createdAt,
  }]);
  assert.equal(promoted.body.data.decisions.length, 1);
  assert.equal(promoted.body.data.initialThreadEntry.kind, "handoff");
  assert.equal(promoted.body.data.initialThreadEntry.summary, promotionRequest.data.summary);
  const publicPromotionJson = JSON.stringify(promoted.body);
  assert.equal(publicPromotionJson.includes(privateTask.body.data.sessionId), false);
  assert.equal(publicPromotionJson.includes("Summarize the private research evidence."), false);
  assert.equal(publicPromotionJson.includes("Private task completed through the governed test worker."), false);

  const promotedReplay = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/promote-to-work-item`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-promote-private-task",
      }),
      body: promotionRequest,
    },
  );
  assert.equal(promotedReplay.status, 201, JSON.stringify(promotedReplay.body));
  assert.equal(promotedReplay.body.data.workItem.workItemId, promoted.body.data.workItem.workItemId);

  const workItemId = promoted.body.data.workItem.workItemId;
  const ownerWorkItem = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerWorkItem.status, 200, JSON.stringify(ownerWorkItem.body));
  assert.equal(ownerWorkItem.headers.get("cache-control"), "no-store");
  assert.equal(ownerWorkItem.body.data.workItem.workItemId, workItemId);
  assert.equal(ownerWorkItem.body.data.handoffCapsule.summary, promotionRequest.data.summary);
  assert.equal(ownerWorkItem.body.data.workItem.members.some((member) => (
    member.userId === ownerRegistration.body.data.user.userId
      && member.roles.includes("participant")
      && member.accessGrant.access === "contribute"
  )), true);
  assert.equal(JSON.stringify(ownerWorkItem.body).includes(privateTask.body.data.sessionId), false);
  assert.deepEqual(
    await product.workItemLifecycle.authorizedArtifactScopes({
      workspaceId: callback.body.data.workspaceId,
      userId: ownerRegistration.body.data.user.userId,
      artifactId: PRIVATE_TASK_ARTIFACT_ID,
    }),
    [{ objectKind: "agent_session", objectId: privateTask.body.data.sessionId }],
    "an active Work Item grant resolves only the explicitly published artifact's internal scope",
  );

  const ownerThread = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerThread.status, 200, JSON.stringify(ownerThread.body));
  assert.equal(ownerThread.headers.get("cache-control"), "no-store");
  assert.deepEqual(ownerThread.body.data.map((entry) => entry.kind), ["handoff"]);
  assert.equal(ownerThread.body.data[0].summary, promotionRequest.data.summary);

  const commentRequest = {
    schemaVersion: "workbench-api-v1",
    data: { content: "I will validate provider readiness and report the remaining risk to the team." },
  };
  const postedComment = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-post-work-item-comment",
      }),
      body: commentRequest,
    },
  );
  assert.equal(postedComment.status, 201, JSON.stringify(postedComment.body));
  assert.equal(postedComment.headers.get("cache-control"), "no-store");
  assert.equal(postedComment.body.data.kind, "comment");
  assert.equal(postedComment.body.data.sequence, 2);
  assert.equal(postedComment.body.data.summary, commentRequest.data.content);
  assert.equal(postedComment.body.data.createdByUserId, ownerRegistration.body.data.user.userId);
  assert.equal(postedComment.body.data.handoffId, null);
  assert.equal(postedComment.body.data.decisionId, null);
  assert.equal(postedComment.body.data.artifactId, null);
  assert.equal(JSON.stringify(postedComment.body).includes(privateTask.body.data.sessionId), false);
  assert.equal(JSON.stringify(postedComment.body).includes("Private task completed through the governed test worker."), false);

  const postedCommentReplay = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-post-work-item-comment",
      }),
      body: commentRequest,
    },
  );
  assert.equal(postedCommentReplay.status, 201, JSON.stringify(postedCommentReplay.body));
  assert.equal(postedCommentReplay.body.data.entryId, postedComment.body.data.entryId);

  const memberThreadAfterComment = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberThreadAfterComment.status, 200, JSON.stringify(memberThreadAfterComment.body));
  assert.deepEqual(memberThreadAfterComment.body.data.map((entry) => entry.kind), ["handoff", "comment"]);
  assert.equal(memberThreadAfterComment.body.data[1].summary, commentRequest.data.content);

  const recentThreadPath = `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries?order=desc&limit=1`;
  const recentThread = await request(server, recentThreadPath, { headers: { Cookie: `workbench_session=${memberCookie}` } });
  assert.equal(recentThread.status, 200, JSON.stringify(recentThread.body));
  assert.equal(recentThread.body.data[0].entryId, postedComment.body.data.entryId, "recent activity starts with the newest shared entry");
  assert.equal(recentThread.body.page.hasMore, true);
  const olderThread = await request(server, `${recentThreadPath}&cursor=${encodeURIComponent(recentThread.body.page.nextCursor)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } });
  assert.equal(olderThread.status, 200, JSON.stringify(olderThread.body));
  assert.deepEqual(olderThread.body.data.map((entry) => entry.kind), ["handoff"]);
  assert.equal(olderThread.body.page.hasMore, false);

  const commentCommandRows = await pool.query(`
    SELECT command.kind, command.status, command.target_kind, command.target_id,
           command.effect_class, decision.action_id, decision.disposition,
           entry_row.product_command_id
      FROM public.product_commands command
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
      JOIN public.work_thread_entries entry_row
        ON entry_row.product_command_id = command.command_id
     WHERE command.target_id = $1
  `, [postedComment.body.data.entryId]);
  assert.deepEqual(commentCommandRows.rows.map(({ product_command_id, ...row }) => row), [{
    kind: "work_item_thread_entry",
    status: "completed",
    target_kind: "work_thread_entry",
    target_id: postedComment.body.data.entryId,
    effect_class: "write_local",
    action_id: "work_item_thread_entry",
    disposition: "authorized",
  }]);
  assert.match(commentCommandRows.rows[0].product_command_id, /^product-command-/);

  const contributorDecisionDenied = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/decisions`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "contributor-cannot-record-work-item-decision",
      }),
      body: {
        schemaVersion: "workbench-api-v1",
        data: {
          question: "Can a contributor silently settle the team decision?",
          options: ["Yes", "No"],
          chosenOutcome: "No",
        },
      },
    },
  );
  assert.equal(contributorDecisionDenied.status, 403, JSON.stringify(contributorDecisionDenied.body));
  assert.equal(contributorDecisionDenied.body.code, "work_item_decision_write_forbidden");

  const decisionRequest = {
    schemaVersion: "workbench-api-v1",
    data: {
      question: "Which team action should close the provider-readiness risk?",
      options: ["Proceed without validation", "Validate provider readiness first"],
      chosenOutcome: "Validate provider readiness first",
      rationale: "The accountable owner accepts the added validation time before the launch decision.",
      evidenceRefs: ["evidence-provider-readiness"],
      affectedObjects: [{ kind: "workflow", id: "workflow-launch" }],
    },
  };
  const recordedDecision = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/decisions`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "owner-record-work-item-decision",
      }),
      body: decisionRequest,
    },
  );
  assert.equal(recordedDecision.status, 201, JSON.stringify(recordedDecision.body));
  assert.equal(recordedDecision.headers.get("cache-control"), "no-store");
  assert.equal(recordedDecision.body.data.workItemId, workItemId);
  assert.equal(recordedDecision.body.data.question, decisionRequest.data.question);
  assert.equal(recordedDecision.body.data.chosenOutcome, decisionRequest.data.chosenOutcome);
  assert.equal(recordedDecision.body.data.authorUserId, callback.body.data.user.userId);
  assert.equal(recordedDecision.body.data.approverUserId, callback.body.data.user.userId);
  assert.equal(JSON.stringify(recordedDecision.body).includes(privateTask.body.data.sessionId), false);
  assert.equal(JSON.stringify(recordedDecision.body).includes("Private task completed through the governed test worker."), false);

  const recordedDecisionReplay = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/decisions`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "owner-record-work-item-decision",
      }),
      body: decisionRequest,
    },
  );
  assert.equal(recordedDecisionReplay.status, 201, JSON.stringify(recordedDecisionReplay.body));
  assert.equal(recordedDecisionReplay.body.data.decisionId, recordedDecision.body.data.decisionId);

  const memberThreadAfterDecision = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberThreadAfterDecision.status, 200, JSON.stringify(memberThreadAfterDecision.body));
  assert.deepEqual(memberThreadAfterDecision.body.data.map((entry) => entry.kind), [
    "handoff",
    "comment",
    "decision",
  ]);
  assert.equal(memberThreadAfterDecision.body.data[2].decisionId, recordedDecision.body.data.decisionId);
  assert.match(memberThreadAfterDecision.body.data[2].summary, /Validate provider readiness first/);

  const memberWorkItemAfterDecision = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberWorkItemAfterDecision.status, 200, JSON.stringify(memberWorkItemAfterDecision.body));
  assert.equal(memberWorkItemAfterDecision.body.data.decisions.some((decision) => (
    decision.decisionId === recordedDecision.body.data.decisionId
      && decision.approverUserId === callback.body.data.user.userId
  )), true);

  const decisionCommandRows = await pool.query(`
    SELECT command.kind, command.status, command.target_kind, command.target_id,
           command.effect_class, decision.action_id, decision.disposition,
           entry_row.product_command_id
      FROM public.product_commands command
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
      JOIN public.work_thread_entries entry_row
        ON entry_row.product_command_id = command.command_id
     WHERE command.target_id = $1
  `, [recordedDecision.body.data.decisionId]);
  assert.deepEqual(decisionCommandRows.rows.map(({ product_command_id, ...row }) => row), [{
    kind: "work_item_decision_record",
    status: "completed",
    target_kind: "work_item_decision",
    target_id: recordedDecision.body.data.decisionId,
    effect_class: "write_local",
    action_id: "work_item_decision_record",
    disposition: "authorized",
  }]);
  assert.match(decisionCommandRows.rows[0].product_command_id, /^product-command-/);

  const createdContinuation = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/continuations`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-continue-work-item",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {} },
    },
  );
  assert.equal(createdContinuation.status, 201, JSON.stringify(createdContinuation.body));
  assert.equal(createdContinuation.headers.get("cache-control"), "no-store");
  const continuation = createdContinuation.body.data;
  assert.equal(continuation.workItemId, workItemId);
  assert.equal(continuation.handoffId, promoted.body.data.handoffCapsule.handoffId);
  assert.notEqual(continuation.agentSessionId, privateTask.body.data.sessionId);
  assert.equal(JSON.stringify(createdContinuation.body).includes(privateTask.body.data.sessionId), false);
  assert.equal(JSON.stringify(createdContinuation.body).includes("Private task completed through the governed test worker."), false);

  const continuationReplay = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/continuations`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-continue-work-item",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {} },
    },
  );
  assert.equal(continuationReplay.status, 201, JSON.stringify(continuationReplay.body));
  assert.equal(continuationReplay.body.data.continuationId, continuation.continuationId);

  const ownerWorkItemWithContinuation = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerWorkItemWithContinuation.status, 200, JSON.stringify(ownerWorkItemWithContinuation.body));
  assert.deepEqual(
    ownerWorkItemWithContinuation.body.data.workItem.authorizedBranchRefs,
    [continuation.continuationId],
    "a member sees only their own authorized continuation reference",
  );

  const continuationLedger = await pool.query(`
    SELECT continuation_id, agent_session_id, handoff_id, continuation_context
      FROM public.work_item_continuations
     WHERE workspace_id = $1 AND work_item_id = $2 AND user_id = $3
  `, [callback.body.data.workspaceId, workItemId, ownerRegistration.body.data.user.userId]);
  assert.deepEqual(continuationLedger.rows.map((row) => ({
    continuation_id: row.continuation_id,
    agent_session_id: row.agent_session_id,
    handoff_id: row.handoff_id,
  })), [{
    continuation_id: continuation.continuationId,
    agent_session_id: continuation.agentSessionId,
    handoff_id: continuation.handoffId,
  }]);
  assert.match(continuationLedger.rows[0].continuation_context, /UNTRUSTED_SHARED_WORK_HANDOFF/);
  assert.match(continuationLedger.rows[0].continuation_context, /Provider readiness/);
  assert.equal(continuationLedger.rows[0].continuation_context.includes(privateTask.body.data.sessionId), false);
  assert.equal(continuationLedger.rows[0].continuation_context.includes("Summarize the private research evidence."), false);
  assert.equal(continuationLedger.rows[0].continuation_context.includes("Private task completed through the governed test worker."), false);

  await seedPrivateTaskModel({
    pool,
    workspaceId: callback.body.data.workspaceId,
    userId: ownerRegistration.body.data.user.userId,
    profileId: CONTINUATION_MODEL_PROFILE_ID,
    revisionId: CONTINUATION_MODEL_REVISION_ID,
    label: "Continuation test model",
  });
  const queuedContinuationTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(continuation.agentSessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-continue-work-item-turn",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: CONTINUATION_MODEL_PROFILE_ID,
        input: { message: "Continue the shared launch work from this handoff." },
      } },
    },
  );
  assert.equal(queuedContinuationTurn.status, 202, JSON.stringify(queuedContinuationTurn.body));
  await product.agentTurnRunner.waitForIdle(continuation.agentSessionId);
  const completedContinuationTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(continuation.agentSessionId)}/turns/${encodeURIComponent(queuedContinuationTurn.body.data.turnId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(completedContinuationTurn.status, 200, JSON.stringify(completedContinuationTurn.body));
  assert.equal(completedContinuationTurn.body.data.status, "completed");
  assert.equal(completedContinuationTurn.body.data.result.actualModelRevisionId, CONTINUATION_MODEL_REVISION_ID);
  const continuationTranscript = product.workerTranscripts.at(-1);
  const handoffContext = continuationTranscript.find((message) => message.kind === "work_item_handoff");
  assert.ok(handoffContext, "the receiving member's Worker receives the dedicated safe Handoff context");
  assert.match(handoffContext.content, /UNTRUSTED_SHARED_WORK_HANDOFF/);
  assert.match(handoffContext.content, /Provider readiness/);
  assert.equal(handoffContext.content.includes(privateTask.body.data.sessionId), false);
  assert.equal(handoffContext.content.includes("Summarize the private research evidence."), false);
  assert.equal(handoffContext.content.includes("Private task completed through the governed test worker."), false);

  const promotionCommandRows = await pool.query(`
    SELECT command.kind, command.status, command.target_kind, command.target_id,
           command.session_id, command.turn_id, decision.disposition
      FROM public.product_commands command
      JOIN public.authorization_decisions decision
        ON decision.workspace_id = command.workspace_id
       AND decision.authorization_decision_id = command.authorization_decision_id
     WHERE command.target_id = $1
  `, [workItemId]);
  assert.deepEqual(promotionCommandRows.rows, [{
    kind: "work_item_promote",
    status: "completed",
    target_kind: "work_item",
    target_id: workItemId,
    session_id: null,
    turn_id: null,
    disposition: "authorized",
  }]);
  const privatePromotionLedger = await pool.query(`
    SELECT source_session_id, source_user_id FROM public.work_item_promotions
     WHERE workspace_id = $1 AND work_item_id = $2
  `, [callback.body.data.workspaceId, workItemId]);
  assert.deepEqual(privatePromotionLedger.rows, [{
    source_session_id: privateTask.body.data.sessionId,
    source_user_id: callback.body.data.user.userId,
  }], "private provenance remains in the restricted promotion ledger only");

  const ownerGrant = promoted.body.data.workItem.members.find((member) => (
    member.userId === ownerRegistration.body.data.user.userId
  ))?.accessGrant;
  assert.ok(ownerGrant);
  const revokeOwnerAccess = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/access-grants/${encodeURIComponent(ownerGrant.grantId)}/revoke`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${memberCookie}`,
        "X-Workbench-CSRF": memberSession.csrfToken,
        "Idempotency-Key": "member-revoke-owner-work-item-access",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {} },
    },
  );
  assert.equal(revokeOwnerAccess.status, 200, JSON.stringify(revokeOwnerAccess.body));
  assert.equal(revokeOwnerAccess.body.data.status, "revoked");

  const revokedContinuationTurn = await request(
    server,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(continuation.agentSessionId)}/turns`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-revoked-continuation-turn",
      }),
      body: { schemaVersion: "workbench-api-v1", data: {
        kind: "agent_message",
        modelProfileId: CONTINUATION_MODEL_PROFILE_ID,
        input: { message: "This turn must not run after Work Item access is revoked." },
      } },
    },
  );
  assert.equal(revokedContinuationTurn.status, 403, JSON.stringify(revokedContinuationTurn.body));
  assert.equal(revokedContinuationTurn.body.code, "work_item_continuation_access_revoked");

  const revokedOwnerComment = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}/thread-entries`,
    {
      method: "POST",
      headers: browserHeaders({
        Cookie: `workbench_session=${ownerCookie}`,
        "X-Workbench-CSRF": ownerSession.csrfToken,
        "Idempotency-Key": "owner-revoked-work-item-comment",
      }),
      body: {
        schemaVersion: "workbench-api-v1",
        data: { content: "This revoked contributor comment must not be persisted." },
      },
    },
  );
  assert.equal(revokedOwnerComment.status, 404, JSON.stringify(revokedOwnerComment.body));
  assert.equal(revokedOwnerComment.body.code, "work_item_access_forbidden");

  const ownerAfterRevocation = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(ownerAfterRevocation.status, 404);
  assert.equal(ownerAfterRevocation.body.code, "work_item_not_found");
  assert.deepEqual(
    await product.workItemLifecycle.authorizedArtifactScopes({
      workspaceId: callback.body.data.workspaceId,
      userId: ownerRegistration.body.data.user.userId,
      artifactId: PRIVATE_TASK_ARTIFACT_ID,
    }),
    [],
    "a revoked Work Item grant cannot resolve the source Artifact scope",
  );
  const memberWorkItem = await request(
    server,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(memberWorkItem.status, 200, JSON.stringify(memberWorkItem.body));

  // Reference discovery is bounded by the current Product turn. A later queued
  // upload, another task, or another principal cannot enter the tool's context.
  const materialAccess = { userId: memberUserId, workspaceId: callback.body.data.workspaceId };
  const materialSession = await product.agentTurnRunner.createSession({ definitionId: "main", ...materialAccess });
  const firstRef = { attachmentId: "attachment-scope-first", version: 1, contentHash: `sha256:${"d".repeat(64)}`, mediaType: "text/plain" };
  const laterRef = { ...firstRef, attachmentId: "attachment-scope-later" };
  const materialTurns = [];
  for (const ref of [firstRef, laterRef]) {
    materialTurns.push(await product.agentTurnRunner.enqueueTurn({ ...materialAccess,
      sessionId: materialSession.sessionId, kind: "agent_message", modelProfileId: PRIVATE_TASK_MODEL_PROFILE_ID,
      input: { message: "Inspect this material.", attachments: [ref] }, idempotencyKey: ref.attachmentId }));
    await product.agentTurnRunner.waitForIdle(materialSession.sessionId);
  }
  const materialPersistence = store.createAgentPersistence({ commandIntake: new PostgresAgentTurnCommandIntake({ store }) });
  const materialContext = { ...materialAccess, sessionId: materialSession.sessionId, throughTurnId: materialTurns[0].turnId };
  assert.deepEqual(await materialPersistence.listSessionAttachmentRefs(materialContext), { refs: [firstRef], hasMore: false });
  assert.deepEqual(await materialPersistence.listSessionAttachmentRefs({ ...materialContext, throughTurnId: materialTurns[1].turnId }),
    { refs: [laterRef, firstRef], hasMore: false });
  assert.deepEqual(await materialPersistence.listSessionAttachmentRefs({ ...materialContext, attachmentId: laterRef.attachmentId }),
    { refs: [], hasMore: false });
  await assert.rejects(materialPersistence.listSessionAttachmentRefs({ ...materialContext, userId: ownerRegistration.body.data.user.userId }),
    { code: "attachment_forbidden" });
  await assert.rejects(materialPersistence.listSessionAttachmentRefs({ ...materialContext, sessionId: privateTask.body.data.sessionId }),
    { code: "attachment_forbidden" });

  await stopServer(server);
  const restartedProduct = createPrivateTaskRuntime({ store });
  const restarted = await startServer(createWorkbenchHttpHandler({
    application: restartedProduct.application,
    authService: new AuthService({
      store,
      persistence: store.createAuthPersistence(),
      bootstrapAdminToken: "bootstrap-token",
      workspaceId: "http-invite-workspace",
      workspaceName: "HTTP invitation workspace",
      bcryptCost: 10,
      invitationTokenSigner: signer,
      invitationMailer: { async sendWorkspaceInvitation() { return { receiptId: "smtp-restart" }; } },
      invitationBaseUrl: ORIGIN,
      oauthProviders: { google: oauth, github: githubOAuth },
    }),
    sessionStore: new PostgresWorkbenchSessionStore({ store }),
    origin: ORIGIN,
  }));
  t.after(() => stopServer(restarted));
  const afterRestart = await request(restarted, "/api/workbench/v1/auth/status", {
    headers: { Cookie: `workbench_session=${memberCookie}` },
  });
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.body.data.authenticated, true);
  assert.equal(afterRestart.body.data.user.userId, callback.body.data.user.userId);

  const privateTaskAfterRestart = await request(
    restarted,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(privateTaskAfterRestart.status, 200, JSON.stringify(privateTaskAfterRestart.body));
  assert.equal(privateTaskAfterRestart.body.data.sessionId, privateTask.body.data.sessionId);
  assert.equal(privateTaskAfterRestart.body.data.userId, callback.body.data.user.userId);
  assert.equal(Object.hasOwn(privateTaskAfterRestart.body.data, "workItemContext"), false);

  const continuationAfterRestart = await request(
    restarted,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(continuation.agentSessionId)}`,
    { headers: { Cookie: `workbench_session=${ownerCookie}` } },
  );
  assert.equal(continuationAfterRestart.status, 200, JSON.stringify(continuationAfterRestart.body));
  assert.equal(continuationAfterRestart.body.data.sessionId, continuation.agentSessionId);
  assert.equal(continuationAfterRestart.body.data.userId, ownerRegistration.body.data.user.userId);
  assert.deepEqual(continuationAfterRestart.body.data.workItemContext, {
    workItemId: continuation.workItemId,
    continuationId: continuation.continuationId,
  });
  assert.equal(JSON.stringify(continuationAfterRestart.body).includes(privateTask.body.data.sessionId), false);

  const completedTurnAfterRestart = await request(
    restarted,
    `/api/workbench/v1/agent-sessions/${encodeURIComponent(privateTask.body.data.sessionId)}/turns/${encodeURIComponent(queuedTurn.body.data.turnId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(completedTurnAfterRestart.status, 200, JSON.stringify(completedTurnAfterRestart.body));
  assert.equal(completedTurnAfterRestart.body.data.status, "completed");
  assert.equal(completedTurnAfterRestart.body.data.result.response, "Private task completed through the governed test worker.");

  const workItemAfterRestart = await request(
    restarted,
    `/api/workbench/v1/work-items/${encodeURIComponent(workItemId)}`,
    { headers: { Cookie: `workbench_session=${memberCookie}` } },
  );
  assert.equal(workItemAfterRestart.status, 200, JSON.stringify(workItemAfterRestart.body));
  assert.equal(workItemAfterRestart.body.data.workItem.workItemId, workItemId);
  assert.equal(JSON.stringify(workItemAfterRestart.body).includes(privateTask.body.data.sessionId), false);
});

function createPrivateTaskRuntime({ store }) {
  const clock = () => new Date().toISOString();
  const idFactory = (prefix) => `${prefix}-${randomUUID()}`;
  const commandIntake = new PostgresAgentTurnCommandIntake({ store });
  const commandAuthorizer = new PostgresAgentCommandAuthorizer({ store, clock, idFactory });
  const workerTranscripts = [];
  const admissionController = new AdmissionController({
    persistence: new PostgresCapacityPersistence({ store }),
    clock,
    idFactory,
    resolveProductCommand: createPostgresProductCommandResolver({ store }),
  });
  const broker = new ExecutionBroker({
    persistence: new PostgresExecutionPersistence({ store }),
    capacityAuthorizer: admissionController,
    clock,
    idFactory,
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: {
      async execute({ request }) {
        workerTranscripts.push(structuredClone(request.input?.transcript ?? []));
        return {
          output: { response: "Private task completed through the governed test worker." },
          requestedModelRevisionId: request.metadata.modelProfileRevisionId,
          actualModelRevisionId: request.metadata.modelProfileRevisionId,
          usage: {
            steps: 1,
            modelRequests: 0,
            inputBytes: 0,
            outputBytes: 64,
            imageCount: 0,
            costUsdMicros: 0,
          },
        };
      },
    },
  });
  const agentTurnRunner = new AgentTurnRunner({
    persistence: store.createAgentPersistence({
      commandIntake,
    }),
    executionBroker: new AdmittedExecutionDispatcher({ broker, admissionController }),
    executor: createProductAgentExecutor(),
    commandAuthorizer,
    clock,
    idFactory,
    resolveBaseVersion: async () => {
      throw new Error("main_private_task_does_not_resolve_object_base_version");
    },
    resolveModelSelection: async ({ modelProfileId, requiredCapabilities }) => {
      const revisionId = new Map([
        [PRIVATE_TASK_MODEL_PROFILE_ID, PRIVATE_TASK_MODEL_REVISION_ID],
        [TEAM_ENTRY_MODEL_PROFILE_ID, TEAM_ENTRY_MODEL_REVISION_ID],
        [CONTINUATION_MODEL_PROFILE_ID, CONTINUATION_MODEL_REVISION_ID],
        [FOREIGN_MODEL_PROFILE_ID, FOREIGN_MODEL_REVISION_ID],
      ]).get(modelProfileId);
      if (!revisionId || !requiredCapabilities.includes("tool_calling")) {
        throw Object.assign(new Error("private_task_model_selection_invalid"), { code: "model_profile_not_found" });
      }
      return {
        profileId: modelProfileId,
        revisionId,
        capability: "tool_calling",
        limits: { maxInputTokens: 128_000 },
      };
    },
  });
  const promotionLifecycle = store.createWorkItemPromotionLifecycle({
    commandAuthorizer,
    agentTurnRunner,
    clock,
    idFactory,
  });
  const workItemLifecycle = store.createTeamWorkLifecycle({
    promotionLifecycle,
    clock,
    idFactory,
  });
  return {
    agentTurnRunner,
    workItemLifecycle,
    workerTranscripts,
    application: createWorkbenchApplication({
    store,
    agentTurnRunner,
    admissionController,
    workItemLifecycle,
    idempotentMutationPort: createPostgresIdempotentMutationPort({ store }),
    }),
  };
}

async function seedPrivateTaskArtifact({ pool, workspaceId, userId, sessionId, invocation }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const createdAt = (await client.query(
      "SELECT clock_timestamp() - interval '1 second' AS now",
    )).rows[0].now;
    const objectId = `object-${PRIVATE_TASK_ARTIFACT_ID}`;
    await client.query(`
      INSERT INTO public.product_objects (
        workspace_id, object_id, schema_version, object_kind, content_hash,
        size_bytes, media_type, storage_backend, storage_key, storage_version,
        state, created_at, payload
      ) VALUES ($1, $2, 'workbench-v1', 'artifact_content', $3,
        1, 'image/png', 'governed_object_store', $5::text, $3,
        'promoted', $4::timestamptz, '{}'::jsonb)
    `, [workspaceId, objectId, PRIVATE_TASK_ARTIFACT_HASH, createdAt, objectId]);
    await client.query(`
      INSERT INTO public.product_artifact_metadata (
        workspace_id, artifact_id, schema_version, object_id, state, media_type,
        byte_length, content_hash, owner_user_id, invocation_id, attempt_id,
        execution_fence, capability_lease_id, requested_model_revision_id,
        actual_model_revision_id, expires_at, ready_at, failure_code,
        created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-v1', $3, 'ready', 'image/png',
        1, $4, $5, $6, $7,
        $8, $9, $10,
        $10, NULL, $11::timestamptz, NULL,
        $11::timestamptz, $11::timestamptz, $12::jsonb)
    `, [
      workspaceId,
      PRIVATE_TASK_ARTIFACT_ID,
      objectId,
      PRIVATE_TASK_ARTIFACT_HASH,
      userId,
      invocation.invocation_id,
      invocation.attempt_id,
      Number(invocation.execution_fence),
      invocation.capability_lease_id,
      PRIVATE_TASK_MODEL_REVISION_ID,
      createdAt,
      JSON.stringify({ objectScope: { objectKind: "agent_session", objectId: sessionId } }),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedPromotionParticipantDecoys({ pool, workspaceId, workspaceOwnerUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const createdAt = (await client.query(
      "SELECT clock_timestamp() - interval '1 second' AS now",
    )).rows[0].now;
    await client.query(`
      INSERT INTO public.product_users (
        user_id, schema_version, display_name, username, username_normalized,
        password_hash, account_role, disabled, bootstrap_admin_claim,
        created_at, updated_at, payload
      ) VALUES
        ($1, 'workbench-v1', 'Foreign workspace member', 'foreign.member', 'foreign.member',
          NULL, 'member', false, false, $3::timestamptz, $3::timestamptz, '{}'::jsonb),
        ($2, 'workbench-v1', 'Disabled workspace member', 'disabled.member', 'disabled.member',
          NULL, 'member', true, false, $3::timestamptz, $3::timestamptz, '{}'::jsonb)
    `, [DIRECTORY_FOREIGN_USER_ID, DIRECTORY_DISABLED_USER_ID, createdAt]);
    await client.query(`
      INSERT INTO public.product_workspaces (
        workspace_id, schema_version, name, created_by, created_at, updated_at, payload
      ) VALUES ('directory-foreign-workspace', 'workbench-v1', 'Foreign directory workspace',
        $1, $2::timestamptz, $2::timestamptz, '{}'::jsonb)
    `, [workspaceOwnerUserId, createdAt]);
    await client.query(`
      INSERT INTO public.workspace_memberships (
        membership_id, workspace_id, user_id, schema_version, role, status, revision,
        suspended_at, removed_at, created_at, updated_at, payload
      ) VALUES
        ('directory-foreign-membership', 'directory-foreign-workspace', $1,
          'workbench-v1', 'member', 'active', 1, NULL, NULL,
          $3::timestamptz, $3::timestamptz, '{}'::jsonb),
        ('directory-disabled-membership', $2, $4,
          'workbench-v1', 'member', 'active', 1, NULL, NULL,
          $3::timestamptz, $3::timestamptz, '{}'::jsonb)
    `, [DIRECTORY_FOREIGN_USER_ID, workspaceId, createdAt, DIRECTORY_DISABLED_USER_ID]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Fixture-only tenant bootstrap for the cross-workspace HTTP boundary.  It
// follows the same one-time owner seed aggregate as PostgresAuthPersistence;
// all actual task and turn operations below still enter through HTTP.
async function seedForeignWorkspaceOwner({ pool, workspaceId, ownerUserId }) {
  const membershipId = `membership-${workspaceId}-${ownerUserId}`;
  const scopeId = `${workspaceId}-${ownerUserId}-personal`;
  const policyRevisionId = `${workspaceId}-${ownerUserId}-policy-1`;
  const grantId = `${workspaceId}-${ownerUserId}-operation`;
  const aggregatePayload = JSON.stringify({ bootstrap: "workspace_initial_seed" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    const createdAt = (await client.query(
      "SELECT clock_timestamp() - interval '1 second' AS now",
    )).rows[0].now;
    await client.query(`
      INSERT INTO public.product_workspaces (
        workspace_id, schema_version, name, created_by, created_at, updated_at, payload
      ) VALUES ($1, 'workbench-v1', 'Foreign HTTP isolation workspace', $2,
        $3::timestamptz, $3::timestamptz, '{}'::jsonb)
    `, [workspaceId, ownerUserId, createdAt]);
    await client.query(`
      INSERT INTO public.workspace_memberships (
        membership_id, workspace_id, user_id, schema_version, role, status, revision,
        created_at, updated_at, payload
      ) VALUES ($1, $2, $3, 'workbench-v1', 'owner', 'active', 1,
        $4::timestamptz, $4::timestamptz, $5::jsonb)
    `, [membershipId, workspaceId, ownerUserId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.workspace_principals (
        workspace_id, principal_id, principal_kind, user_id, membership_id,
        status, revision, created_at, updated_at, revoked_at, payload
      ) VALUES ($1, $2, 'user', $2, $3, 'active', 1,
        $4::timestamptz, $4::timestamptz, NULL, $5::jsonb)
    `, [workspaceId, ownerUserId, membershipId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id, owner_principal_id,
        current_policy_revision_id, created_by_principal_id, created_by_principal_kind,
        creation_mode, created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user',
        'workspace_initial_seed', $5::timestamptz, $5::timestamptz, $6::jsonb)
    `, [workspaceId, scopeId, ownerUserId, policyRevisionId, createdAt, aggregatePayload]);
    await client.query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier, permission_mode,
        auto_approved_effect_classes, auto_approved_action_ids, policy_content_hash,
        created_by_principal_id, created_by_principal_kind, created_at, payload
      ) VALUES ($1, $2, $3, 1, 'workspace_readable', 'interactive',
        ARRAY[]::text[], ARRAY[]::text[], $4, $5, 'user', $6::timestamptz, $7::jsonb)
    `, [
      workspaceId,
      scopeId,
      policyRevisionId,
      `sha256:${"e".repeat(64)}`,
      ownerUserId,
      createdAt,
      aggregatePayload,
    ]);
    await client.query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true,
        $4, 'user', 'scope_creation', $5::timestamptz, $5::timestamptz, $6::jsonb)
    `, [workspaceId, scopeId, grantId, ownerUserId, createdAt, aggregatePayload]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedPrivateTaskModel({
  pool,
  workspaceId,
  userId,
  profileId = PRIVATE_TASK_MODEL_PROFILE_ID,
  revisionId = PRIVATE_TASK_MODEL_REVISION_ID,
  label = "Private task test model",
}) {
  const scopeId = await personalScopeId(pool, workspaceId, userId);
  const secretBindingId = `${profileId}-secret`;
  const storeBindingRef = `${profileId}-binding`;
  const deploymentKey = `${profileId}-deployment`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const createdAt = (await client.query(
      "SELECT clock_timestamp() - interval '1 second' AS now",
    )).rows[0].now;
    await client.query(`
      INSERT INTO public.model_profiles (
        profile_id, workspace_id, scope_id, schema_version, profile_scope,
        display_name, current_revision_id, current_revision_number,
        created_by_principal_id, created_by_principal_kind, created_at, updated_at
      ) VALUES ($1, $2, $3, 'workbench-model-catalog-v1', 'workspace',
        $4, $5, 1, $6, 'user', $7, $7)
    `, [profileId, workspaceId, scopeId, label, revisionId, userId, createdAt]);
    await client.query(`
      INSERT INTO public.secret_bindings (
        workspace_id, secret_binding_id, scope_id, schema_version,
        owner_kind, owner_id, secret_source, store_binding_ref,
        store_binding_revision, credential_fingerprint, status,
        created_by_principal_id, created_by_principal_kind,
        probed_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 'workbench-secret-binding-v1',
        'model_profile_revision', $4, 'cloud_secret_store', $5,
        1, $6, 'active', $7, 'user', $8, $8, $8)
    `, [workspaceId, secretBindingId, scopeId, revisionId, storeBindingRef,
      `sha256:${"a".repeat(64)}`, userId, createdAt]);
    await client.query(`
      INSERT INTO public.model_profile_revisions (
        revision_id, workspace_id, profile_id, revision_number, schema_version,
        provider, protocol, provider_model_ref, capabilities,
        parameter_support, limits, data_policy, cost_policy,
        parameter_schema_version, policy_version, config_hash,
        deployment_key, secret_binding_id,
        created_by_principal_id, created_by_principal_kind, created_at
      ) VALUES ($1, $2, $3, 1, 'workbench-model-catalog-v1',
        'openai', 'openai_compatible_chat', 'private-task-test-model', ARRAY['chat', 'tool_calling'],
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '1.0.0', '1.0.0', $4, $5,
        $6, $7, 'user', $8)
    `, [revisionId, workspaceId, profileId,
      `sha256:${"b".repeat(64)}`, deploymentKey, secretBindingId, userId, createdAt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function personalScopeId(pool, workspaceId, userId) {
  const row = (await pool.query(`
    SELECT scope_id FROM public.product_scopes
     WHERE workspace_id = $1 AND owner_user_id = $2
       AND scope_kind = 'personal' AND status = 'active'
  `, [workspaceId, userId])).rows[0];
  assert.ok(row?.scope_id, "an activated member must have one active personal scope");
  return row.scope_id;
}

function browserHeaders(extra = {}) {
  return {
    Origin: ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/json",
    ...extra,
  };
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request(server, path, { method = "GET", headers = {}, body } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function cookie(response) {
  const value = response.headers.get("set-cookie");
  assert.equal(typeof value, "string");
  const match = /^workbench_session=([^;]+);/u.exec(value);
  assert.ok(match);
  return match[1];
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  return value;
}
