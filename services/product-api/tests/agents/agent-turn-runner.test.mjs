import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentTurnRunner,
  InMemoryAgentPersistence,
  createProductAgentExecutor,
  ProductAgentProposalService,
} from "../../src/agents/index.mjs";

const NOW = "2026-07-16T12:00:00.000Z";

function fixture({
  executor,
  executionBroker,
  resolveModelSelection,
  resolveBaseVersion,
  persistence = new InMemoryAgentPersistence(),
  authorizeObject,
  commandAuthorizer,
} = {}) {
  let id = 0;
  const runner = new AgentTurnRunner({
    persistence,
    executor: executor ?? {
      async execute({ turn }) {
        return {
          response: `done:${turn.input.message}`,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
    executionBroker,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: resolveBaseVersion
      ?? (async ({ objectKind, objectId }) => `${objectKind}-version:${objectId}`),
    authorizeObject: authorizeObject === undefined ? (async () => true) : authorizeObject,
    commandAuthorizer,
    resolveModelSelection: resolveModelSelection ?? (async ({ modelProfileId, modelProfileRevisionId, session, requiredCapabilities }) => ({
      revisionId: modelProfileRevisionId || `model-revision-for-${modelProfileId || session.lastUsedModelProfileId}`,
      profileId: modelProfileId || session.lastUsedModelProfileId,
      capability: requiredCapabilities.includes("tool_calling") ? "tool_calling" : requiredCapabilities[0],
    })),
  });
  return { runner, persistence };
}

function agentTurn(sessionId, message, userId = "alice", revisionId = "model-revision-chat-1") {
  return {
    sessionId,
    kind: "agent_message",
    modelProfileRevisionId: revisionId,
    input: { message },
    userId,
    workspaceId: "workspace-alpha",
  };
}

test("module sessions, branches, transcripts, and permissions are isolated per collaborator", async () => {
  const { runner } = fixture();
  const alice = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const bob = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "bob",
    workspaceId: "workspace-alpha",
  });

  assert.notEqual(alice.sessionId, bob.sessionId);
  assert.notEqual(alice.scope.branchId, bob.scope.branchId);
  const turn = await runner.enqueueTurn(agentTurn(alice.sessionId, "Alice-only draft change"));
  await runner.waitForIdle(alice.sessionId);

  assert.equal(await runner.getSession(alice.sessionId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
  assert.equal(await runner.getTurn(alice.sessionId, turn.turnId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
  assert.equal((await runner.listMessages(alice.sessionId, { userId: "alice", workspaceId: "workspace-alpha" })).length, 2);
  assert.equal(await runner.listMessages(alice.sessionId, { userId: "bob", workspaceId: "workspace-alpha" }), null);
});

test("Agent turns consume backend-issued command authority without exposing it in the Turn", async () => {
  const issued = [];
  const commandAuthorizer = {
    async authorizeAgentTurn(input) {
      issued.push({ type: "turn", input });
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-turn-1",
        argumentDigest: `sha256:${"a".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
    async authorizeCancellation(input) {
      issued.push({ type: "cancel", input });
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-cancel-1",
        argumentDigest: `sha256:${"b".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
  };
  const { runner, persistence } = fixture({ commandAuthorizer });
  const session = await runner.createSession({
    definitionId: "main", userId: "alice", workspaceId: "workspace-alpha",
  });
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "governed turn"));
  assert.equal(issued[0].type, "turn");
  assert.equal(issued[0].input.sessionId, session.sessionId);
  assert.equal(issued[0].input.turnId, queued.turnId);
  assert.deepEqual(issued[0].input.input, { message: "governed turn" });
  assert.equal(Object.hasOwn(queued, "authorizationDecisionId"), false);
  await runner.cancelTurn({
    sessionId: session.sessionId, turnId: queued.turnId,
    userId: "alice", workspaceId: "workspace-alpha", reason: "user_cancelled",
  });
  assert.equal(issued[1].type, "cancel");
  assert.equal(issued[1].input.targetCommandId, queued.productCommandId);
});

test("a Team Work entry keeps the first Turn on the canonical Agent command while binding its Work target", async () => {
  const issued = [];
  const commandAuthorizer = {
    async authorizeAgentTurn(input) {
      issued.push(input);
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-team-work-entry",
        argumentDigest: `sha256:${"c".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
    async authorizeCancellation() {
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-cancel",
        argumentDigest: `sha256:${"d".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
  };
  const { runner } = fixture({ commandAuthorizer });
  const session = await runner.createSession({
    definitionId: "main", userId: "alice", workspaceId: "workspace-alpha",
  });
  const queued = await runner.enqueueTurn({
    ...agentTurn(session.sessionId, "Produce the team launch plan."),
    turnId: "agent-turn-team-entry",
    productCommandId: "product-command-team-entry",
    workItemId: "work-item-team-entry",
    workItemTarget: { kind: "new_team_work_item", workItemId: "work-item-team-entry" },
  });
  assert.equal(queued.productCommandId, "product-command-team-entry");
  assert.equal(issued[0].workItemId, "work-item-team-entry");
  assert.deepEqual(issued[0].workItemTarget, {
    kind: "new_team_work_item",
    workItemId: "work-item-team-entry",
  });
});

test("a Work continuation entry assigns the Agent command a per-Turn Work target", async () => {
  const issued = [];
  const commandAuthorizer = {
    async authorizeAgentTurn(input) {
      issued.push(input);
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-work-continuation-entry",
        argumentDigest: `sha256:${"e".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
    async authorizeCancellation() {
      return {
        scopeId: "scope-personal-alice",
        authorizationDecisionId: "decision-cancel",
        argumentDigest: `sha256:${"f".repeat(64)}`,
        authorizedAt: NOW,
      };
    },
  };
  const { runner } = fixture({ commandAuthorizer });
  const session = await runner.createSession({
    definitionId: "main", userId: "alice", workspaceId: "workspace-alpha",
  });
  const target = {
    kind: "work_item_continuation_turn",
    workItemId: "work-item-launch",
    continuationId: "work-item-continuation-alice",
    handoffId: "handoff-launch",
    workItemRevision: 1,
    workItemStatus: "ready",
  };
  const queued = await runner.enqueueTurn({
    ...agentTurn(session.sessionId, "Continue only from the shared handoff."),
    turnId: "agent-turn-continuation-entry",
    productCommandId: "product-command-continuation-entry",
    workItemId: "work-item-launch",
    continuationTurnTarget: target,
  });
  assert.equal(queued.productCommandId, "product-command-continuation-entry");
  assert.equal(issued[0].workItemId, "work-item-launch");
  assert.deepEqual(issued[0].continuationTurnTarget, target);
});

test("Module sessions fail closed when no object authorizer is configured", async () => {
  const { runner } = fixture({ authorizeObject: null });
  await assert.rejects(runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-private",
    userId: "alice",
    workspaceId: "workspace-alpha",
  }), { code: "agent_object_authorizer_unavailable" });
});

test("startup recovery schedules a durable queued Turn even without an activeTurnId", async () => {
  const persistence = new InMemoryAgentPersistence();
  const claimNextTurn = persistence.claimNextTurn.bind(persistence);
  persistence.claimNextTurn = async () => null;
  const { runner } = fixture({ persistence });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "Recover me"));
  await runner.waitForIdle(session.sessionId);
  assert.equal(
    (await runner.getTurn(session.sessionId, queued.turnId, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).status,
    "queued",
  );

  persistence.claimNextTurn = claimNextTurn;
  assert.deepEqual(await runner.recover(), [session.sessionId]);
  await runner.waitForIdle(session.sessionId);
  assert.equal(
    (await runner.getTurn(session.sessionId, queued.turnId, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).status,
    "completed",
  );
});

test("a failed turn.started event cannot leave the Session FIFO permanently active", async () => {
  const persistence = new InMemoryAgentPersistence();
  const claimNextTurn = persistence.claimNextTurn.bind(persistence);
  let failStarted = true;
  persistence.claimNextTurn = (sessionId, startedAt, eventFactory) => claimNextTurn(
    sessionId,
    startedAt,
    (sequence, claimedTurn) => {
      if (failStarted) {
        failStarted = false;
        throw new Error("event_store_unavailable");
      }
      return eventFactory(sequence, claimedTurn);
    },
  );
  const { runner } = fixture({ persistence });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "Do not stick"));
  await assert.rejects(runner.waitForIdle(session.sessionId), /event_store_unavailable/);

  const queued = await runner.getTurn(session.sessionId, turn.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const updatedSession = await runner.getSession(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(queued.status, "queued");
  assert.equal(updatedSession.activeTurnId, null);
  assert.deepEqual(
    (await runner.listEvents(session.sessionId, { after: 0 }, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).map((event) => [event.sequence, event.type]),
    [[1, "turn.queued"]],
  );

  assert.deepEqual(await runner.recover(), [session.sessionId]);
  await runner.waitForIdle(session.sessionId);
  assert.equal((await runner.getTurn(session.sessionId, turn.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  })).status, "completed");
  assert.deepEqual(
    (await runner.listEvents(session.sessionId, { after: 0 }, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).map((event) => [event.sequence, event.type]),
    [[1, "turn.queued"], [2, "turn.started"], [3, "turn.completed"]],
  );
});

test("Module object authorization is rechecked for branch resume, enqueue, and recovery", async () => {
  let allowed = true;
  let executions = 0;
  const persistence = new InMemoryAgentPersistence();
  const originalClaim = persistence.claimNextTurn.bind(persistence);
  const authorizeObject = async () => {
    if (!allowed) {
      const error = new Error("agent_object_forbidden");
      error.code = "agent_object_forbidden";
      throw error;
    }
  };
  const { runner } = fixture({
    persistence,
    authorizeObject,
    executor: {
      async execute({ turn }) {
        executions += 1;
        return {
          response: "must not run after access is revoked",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-private",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });

  allowed = false;
  await assert.rejects(runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-private",
    branchId: session.scope.branchId,
    userId: "alice",
    workspaceId: "workspace-alpha",
  }), { code: "agent_object_forbidden" });
  await assert.rejects(runner.enqueueTurn(agentTurn(session.sessionId, "denied")), {
    code: "agent_object_forbidden",
  });

  allowed = true;
  persistence.claimNextTurn = async () => null;
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "recheck on recovery"));
  await runner.waitForIdle(session.sessionId);
  persistence.claimNextTurn = originalClaim;
  allowed = false;
  assert.deepEqual(await runner.recover(), [session.sessionId]);
  await runner.waitForIdle(session.sessionId);

  assert.equal(executions, 0);
  assert.equal((await runner.getTurn(session.sessionId, queued.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  })).status, "failed");
});

test("a product model profile is resolved and pinned to one immutable revision when the Turn is queued", async () => {
  const { runner } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "agent_message",
    modelProfileId: "profile-chat",
    input: { message: "Use the selected profile." },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.waitForIdle(session.sessionId);

  assert.equal(turn.requestedModelRevisionId, "model-revision-for-profile-chat");
  assert.equal(turn.modelRoutingState, "pinned");
  assert.equal(
    (await runner.getSession(session.sessionId, { userId: "alice", workspaceId: "workspace-alpha" })).lastUsedModelProfileId,
    "profile-chat",
  );
});

test("an image attachment requires image_input before any Turn state is persisted", async () => {
  const { runner, persistence } = fixture({
    resolveModelSelection: async ({ requiredCapabilities }) => {
      assert.deepEqual(requiredCapabilities, ["chat", "tool_calling", "image_input"]);
      const error = new Error("The selected model cannot read images.");
      error.code = "model_capability_mismatch";
      throw error;
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await assert.rejects(
    runner.enqueueTurn({
      sessionId: session.sessionId,
      kind: "agent_message",
      modelProfileId: "profile-text-only",
      input: {
        message: "Describe it.",
        attachments: [{
          attachmentId: "attachment-1",
          version: 1,
          contentHash: `sha256:${"a".repeat(64)}`,
          mediaType: "image/png",
        }],
      },
      userId: "alice",
      workspaceId: "workspace-alpha",
    }),
    (error) => error.code === "model_capability_mismatch",
  );
  assert.equal(
    (await persistence.listTurns(session.sessionId, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).length,
    0,
  );
  assert.equal(
    (await persistence.listMessages(session.sessionId, {
      userId: "alice",
      workspaceId: "workspace-alpha",
    })).length,
    0,
  );
});

test("a derived-text document attachment executes without requesting image_input", async () => {
  const requests = [];
  const { runner } = fixture({
    resolveModelSelection: async ({ requiredCapabilities, modelProfileRevisionId }) => {
      assert.deepEqual(requiredCapabilities, ["chat", "tool_calling"]);
      return {
        revisionId: modelProfileRevisionId,
        profileId: "profile-chat",
        capability: "tool_calling",
      };
    },
    executionBroker: {
      async execute(request) {
        requests.push(structuredClone(request));
        return {
          status: "completed",
          output: {
            content: [{ type: "text", text: "The document was summarized." }],
            toolCalls: [],
          },
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
          artifactRefs: [],
          usage: {},
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const ref = {
    attachmentId: "attachment-document-1",
    version: 1,
    contentHash: `sha256:${"b".repeat(64)}`,
    mediaType: "application/pdf",
  };

  const queued = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "agent_message",
    modelProfileRevisionId: "model-revision-chat-1",
    input: { message: "Summarize the document.", attachments: [ref] },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelCapability, "tool_calling");
  assert.deepEqual(requests[0].metadata.attachmentRefs, [ref]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.response, "The document was summarized.");
});

test("document uploads and follow-up questions use the bounded Pi worker when material tools are composed", async () => {
  const requests = [];
  const { runner } = fixture({ executor: createProductAgentExecutor({ materialToolsAvailable: true }),
    executionBroker: { async execute(request) {
      requests.push(request);
      return { status: "completed", output: { response: "Read the original material." },
        requestedModelRevisionId: request.metadata.modelProfileRevisionId,
        actualModelRevisionId: request.metadata.modelProfileRevisionId };
    } } });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  for (const input of [
    { message: "Read the file.", attachments: [{ attachmentId: "attachment-doc", version: 1, contentHash: `sha256:${"a".repeat(64)}`, mediaType: "text/plain" }] },
    { message: "Check another fact from that file." },
  ]) {
    const turn = await runner.enqueueTurn({ ...agentTurn(session.sessionId, input.message), input });
    await runner.waitForIdle(session.sessionId);
    assert.equal((await runner.getTurn(session.sessionId, turn.turnId, { userId: "alice", workspaceId: "workspace-alpha" })).status, "completed");
  }
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.mode, "bounded_agent");
    assert.equal(request.isolation, "container");
    assert.deepEqual(request.capabilities.toolAllowlist, ["turnsu_materials"]);
    assert.deepEqual(request.capabilities.connectionIds, []);
    assert.equal(request.capabilities.externalActions, false);
    assert.match(request.input.materialReading, /nextOffset/);
  }
});

test("Main Agent tasks are independently persisted and Loop Run identity is idempotent", async () => {
  const { runner } = fixture();
  const first = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const second = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.notEqual(first.sessionId, second.sessionId);

  await runner.enqueueTurn(agentTurn(first.sessionId, "Summarize the launch research"));
  await runner.waitForIdle(first.sessionId);
  const sessions = await runner.listSessions(
    { definitionId: "main", limit: 20 },
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((item) => item.sessionId === first.sessionId).title, "Summarize the launch research");

  const loopSource = {
    kind: "loop_run",
    workflowId: "workflow-1",
    workflowRevisionId: "workflow-revision-1",
    runId: "run-1",
  };
  const loopTask = await runner.createSession({
    definitionId: "main",
    title: "Research Loop",
    source: loopSource,
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const replayed = await runner.createSession({
    definitionId: "main",
    title: "Research Loop",
    source: loopSource,
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(replayed.sessionId, loopTask.sessionId);
  assert.deepEqual(loopTask.source, loopSource);
});

test("module session creation can resume only the current user's explicit active branch", async () => {
  const { runner } = fixture();
  const created = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const resumed = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    branchId: created.scope.branchId,
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(resumed.sessionId, created.sessionId);

  await assert.rejects(runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    branchId: created.scope.branchId,
    userId: "bob",
    workspaceId: "workspace-alpha",
  }), { code: "agent_branch_not_found" });
});

test("Session model selection is only a last-used preference", async () => {
  const { runner } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    modelProfileId: "deepseek-default",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(session.lastUsedModelProfileId, "deepseek-default");
  assert.equal(session.modelPreferenceState, "preference_only");
  const updated = await runner.selectModel({
    sessionId: session.sessionId,
    modelProfileId: "claude-sonnet",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(updated.lastUsedModelProfileId, "claude-sonnet");
  assert.equal((await runner.getSession(session.sessionId, {
    userId: "alice", workspaceId: "workspace-alpha",
  })).lastUsedModelProfileId, "claude-sonnet");
});

test("Session archive is organizational metadata and never changes an active Turn", async () => {
  let signalStarted;
  let releaseExecution;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const executionGate = new Promise((resolve) => { releaseExecution = resolve; });
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        signalStarted();
        await executionGate;
        return {
          response: "background work completed",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    title: "Original task",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "Continue in background"));
  await started;

  const archived = await runner.updateSession({
    sessionId: session.sessionId,
    title: "  Renamed   task  ",
    archived: true,
    userId: "alice",
    workspaceId: "workspace-alpha",
  });

  assert.equal(archived.title, "Renamed task");
  assert.equal(archived.archived, true);
  assert.equal(archived.activeTurnId, turn.turnId);
  assert.equal(archived.taskStatus, "running");
  assert.equal(archived.status, "active");
  await assert.rejects(runner.updateSession({
    sessionId: session.sessionId,
    archived: false,
    userId: "bob",
    workspaceId: "workspace-alpha",
  }), { code: "agent_session_not_found" });

  releaseExecution();
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, turn.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.response, "background work completed");
  const afterCompletion = await runner.getSession(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(afterCompletion.archived, true);
  assert.equal(afterCompletion.taskStatus, "completed");
});

test("a queued Turn keeps its exact revision after the Session preference changes", async () => {
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];
  const { runner, persistence } = fixture({
    executor: {
      async execute({ turn }) {
        seen.push(turn.requestedModelRevisionId);
        if (seen.length === 1) {
          firstStarted();
          await firstGate;
        }
        return {
          response: "done",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    lastUsedModelProfileId: "profile-old",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(session.sessionId, "first", "alice", "model-revision-chat-1"));
  await firstStartedPromise;
  const queued = await runner.enqueueTurn(agentTurn(
    session.sessionId,
    "second",
    "alice",
    "model-revision-chat-2",
  ));
  assert.equal((await runner.getSession(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  })).taskStatus, "running");
  await runner.selectModel({
    sessionId: session.sessionId,
    lastUsedModelProfileId: "profile-new",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  releaseFirst();
  await runner.waitForIdle(session.sessionId);

  assert.deepEqual(seen, ["model-revision-chat-1", "model-revision-chat-2"]);
  const completed = await runner.getTurn(
    session.sessionId,
    queued.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(completed.requestedModelRevisionId, "model-revision-chat-2");
  assert.equal(completed.actualModelRevisionId, "model-revision-chat-2");
});

test("Turn enqueue rejects a resolver that substitutes another revision", async () => {
  let id = 0;
  const runner = new AgentTurnRunner({
    persistence: new InMemoryAgentPersistence(),
    executor: { async execute() { return {}; } },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: async () => "version-1",
    resolveModelSelection: async () => ({ revisionId: "model-revision-substitute" }),
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await assert.rejects(
    runner.enqueueTurn(agentTurn(session.sessionId, "do not reroute")),
    { code: "agent_model_revision_not_exact" },
  );
});

test("failed model resolution does not mutate the Session preference or enqueue partial Turn state", async () => {
  let id = 0;
  const persistence = new InMemoryAgentPersistence();
  const runner = new AgentTurnRunner({
    persistence,
    executor: { async execute() { return {}; } },
    clock: () => NOW,
    idFactory: (kind) => `${kind}-${++id}`,
    resolveBaseVersion: async () => "version-1",
    resolveModelSelection: async () => {
      const error = new Error("model_profile_not_found");
      error.code = "model_profile_not_found";
      throw error;
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    lastUsedModelProfileId: "profile-known-good",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });

  await assert.rejects(
    runner.enqueueTurn({
      sessionId: session.sessionId,
      kind: "agent_message",
      modelProfileId: "profile-invalid",
      input: { message: "Do not persist this route." },
      userId: "alice",
      workspaceId: "workspace-alpha",
    }),
    { code: "model_profile_not_found" },
  );

  const unchanged = await runner.getSession(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(unchanged.lastUsedModelProfileId, "profile-known-good");
  assert.equal(persistence.turns.size, 0);
  assert.deepEqual(await runner.listMessages(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  }), []);
  assert.deepEqual(await runner.listEvents(
    session.sessionId,
    0,
    100,
    { userId: "alice", workspaceId: "workspace-alpha" },
  ), []);
});

test("a stable Turn operation ID atomically deduplicates the Turn, user message, and queued event", async () => {
  const { runner, persistence } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const request = {
    ...agentTurn(session.sessionId, "Exactly once"),
    turnId: "agent-turn-stable-replay",
  };

  const first = await runner.enqueueTurn(request);
  const replay = await runner.enqueueTurn(request);
  await runner.waitForIdle(session.sessionId);

  assert.equal(first.turnId, "agent-turn-stable-replay");
  assert.equal(replay.turnId, first.turnId);
  assert.equal(persistence.turns.size, 1);
  const messages = await runner.listMessages(session.sessionId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(messages.filter((message) => message.kind === "turn").length, 1);
  const events = await runner.listEvents(
    session.sessionId,
    0,
    100,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(events.filter((event) => event.type === "turn.queued").length, 1);
});

test("InMemory Agent intake reuses only its own outer transaction and rolls back with it", async () => {
  const persistence = new InMemoryAgentPersistence();
  const { runner } = fixture({ persistence });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await assert.rejects(
    persistence.withTransaction(async (transactionSession) => {
      await runner.enqueueTurn({
        ...agentTurn(session.sessionId, "roll back intake"),
        transactionSession,
      });
      throw new Error("outer_transaction_rollback");
    }),
    /outer_transaction_rollback/,
  );
  assert.equal(persistence.turns.size, 0);
  assert.equal(persistence.commands.size, 0);
  assert.equal(persistence.admissions.size, 0);
  assert.deepEqual(persistence.messages.get(session.sessionId) ?? [], []);
  assert.deepEqual(persistence.events.get(session.sessionId) ?? [], []);
  await assert.rejects(
    runner.enqueueTurn({
      ...agentTurn(session.sessionId, "foreign transaction"),
      transactionSession: { notOwnedByPersistence: true },
    }),
    /in_memory_agent_transaction_invalid/,
  );
});

test("concurrent Module Session creation converges on one active personal branch", async () => {
  const { runner, persistence } = fixture();
  const request = {
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  };
  const [left, right] = await Promise.all([
    runner.createSession(request),
    runner.createSession(request),
  ]);
  assert.equal(left.sessionId, right.sessionId);
  assert.equal(left.scope.branchId, right.scope.branchId);
  assert.equal([...persistence.branches.values()].filter((branch) => branch.status === "active").length, 1);
});

test("new Module branches persist the immutable canonical base snapshot used for three-way merge", async () => {
  const baseSnapshot = {
    revisionId: "revision-base",
    workflowId: "workflow-shared",
    graph: { nodes: [], edges: [] },
  };
  const { runner, persistence } = fixture({
    resolveBaseVersion: async () => ({
      baseVersionId: "revision-base",
      baseSnapshot,
    }),
  });

  const session = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-shared",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const branch = persistence.branches.get(session.scope.branchId);

  assert.equal(branch.baseVersionId, "revision-base");
  assert.deepEqual(branch.baseSnapshot, baseSnapshot);
  assert.notEqual(branch.baseSnapshot, baseSnapshot);
});

test("turns in one session execute FIFO while different sessions can run concurrently", async () => {
  const order = [];
  const routes = [];
  const blockers = new Map();
  const { runner } = fixture({
    executor: {
      async execute({ session, turn }) {
        const message = turn.input.message;
        routes.push(`${session.userId}:${turn.requestedModelRevisionId}`);
        order.push(`start:${session.userId}:${message}`);
        if (blockers.has(message)) await blockers.get(message);
        order.push(`end:${session.userId}:${message}`);
        return {
          response: `done:${message}`,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  let releaseFirst;
  blockers.set("first", new Promise((resolve) => { releaseFirst = resolve; }));
  const alice = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const bob = await runner.createSession({ definitionId: "main", userId: "bob", workspaceId: "workspace-alpha" });
  await runner.enqueueTurn(agentTurn(alice.sessionId, "first"));
  await runner.enqueueTurn(agentTurn(alice.sessionId, "second", "alice", "model-revision-chat-2"));
  await runner.enqueueTurn(agentTurn(bob.sessionId, "parallel", "bob", "model-revision-chat-3"));
  await new Promise((resolve) => setImmediate(resolve));

  assert(order.includes("start:alice:first"));
  assert(order.includes("end:bob:parallel"));
  assert(!order.includes("start:alice:second"));
  releaseFirst();
  await Promise.all([runner.waitForIdle(alice.sessionId), runner.waitForIdle(bob.sessionId)]);
  assert(order.indexOf("end:alice:first") < order.indexOf("start:alice:second"));
  assert(routes.includes("alice:model-revision-chat-2"));
  assert(routes.includes("bob:model-revision-chat-3"));
});

test("a user may keep at most three waiting Turns and a cancelled waiter releases its slot", async () => {
  let releaseActive;
  let activeStarted;
  const activeGate = new Promise((resolve) => { releaseActive = resolve; });
  const started = new Promise((resolve) => { activeStarted = resolve; });
  let executions = 0;
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        executions += 1;
        if (executions === 1) {
          activeStarted();
          await activeGate;
        }
        return {
          response: `done:${turn.input.message}`,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(session.sessionId, "active"));
  await started;
  const waiting = [];
  for (const message of ["waiting-1", "waiting-2", "waiting-3"]) {
    waiting.push(await runner.enqueueTurn(agentTurn(session.sessionId, message)));
  }

  await assert.rejects(
    runner.enqueueTurn(agentTurn(session.sessionId, "waiting-4")),
    (error) => {
      assert.equal(error.code, "admission_queue_full");
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, {
        reasonCode: "admission_queue_full",
        recoveryAction: "inspect_queue",
        method: "GET",
        path: `/api/workbench/v1/agent-sessions/${session.sessionId}/queue`,
      });
      return true;
    },
  );
  await runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: waiting[1].turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "make room",
  });
  await assert.doesNotReject(
    runner.enqueueTurn(agentTurn(session.sessionId, "replacement")),
  );

  releaseActive();
  await runner.waitForIdle(session.sessionId);
});

test("one turn launches bounded workers concurrently with product-owned invocation records", async () => {
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const executionBroker = {
    async execute(request) {
      entered.push(request);
      if (entered.length === 2) release();
      await gate;
      return { invocationId: request.invocationId, status: "completed", output: { ok: true } };
    },
  };
  const { runner } = fixture({
    executionBroker,
    executor: {
      async execute({ runWorkers }) {
        const results = await runWorkers([
          { goal: "worker one", isolation: "process" },
          { goal: "worker two", isolation: "process" },
        ]);
        return {
          response: "workers complete",
          workerResults: results,
          requestedModelRevisionId: "model-revision-chat-1",
          actualModelRevisionId: "model-revision-chat-1",
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "parallelize"));
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(entered.length, 2);
  assert.notEqual(entered[0].invocationId, entered[1].invocationId);
  assert(entered.every((request) => request.controller.kind === "agent_turn" && request.controller.controllerId === queued.turnId));
  assert.equal(completed.result.invocationIds.length, 2);
});

test("the bounded Product Agent receives a scope-bound Product Session replay before Pi is rebuilt", async () => {
  const persistence = new InMemoryAgentPersistence();
  const requests = [];
  const { runner } = fixture({
    persistence,
    executor: createProductAgentExecutor(),
    executionBroker: {
      async execute(request) {
        requests.push(structuredClone(request));
        return {
          status: "completed",
          output: { response: "replayed session completed" },
          requestedModelRevisionId: request.metadata.modelProfileRevisionId,
          actualModelRevisionId: request.metadata.modelProfileRevisionId,
          artifactRefs: [],
          usage: {},
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main", userId: "alice", workspaceId: "workspace-alpha",
  });
  await persistence.appendMessage({
    schemaVersion: "workbench-v1",
    messageId: "historical-product-message",
    sessionId: session.sessionId,
    turnId: "historical-turn",
    role: "assistant",
    kind: "result",
    content: "Only Product Session history is replayable.",
    createdAt: NOW,
  });
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "Continue from Product history."));
  await runner.waitForIdle(session.sessionId);

  assert.equal(requests.length, 1);
  const replay = requests[0].input.kernelSessionReplay;
  assert.deepEqual(replay.session, { sessionId: session.sessionId, branchId: null });
  assert.equal(replay.schemaVersion, "agent-kernel-session-replay-v1");
  assert.equal(replay.events.some((event) => event.payload.text === "Only Product Session history is replayable."), true);
  assert.equal(replay.events.some((event) => event.payload.text === "Continue from Product history."), true);
  assert.equal(replay.events.every((event) => event.session.sessionId === session.sessionId), true);
  const completed = await runner.getTurn(session.sessionId, queued.turnId, {
    userId: "alice", workspaceId: "workspace-alpha",
  });
  assert.equal(completed.status, "completed");
});

test("a long Session condenses through a governed model_call before rebuilding the bounded Worker context", async () => {
  const persistence = new InMemoryAgentPersistence();
  const requests = [];
  let workerMessages;
  const { runner } = fixture({
    persistence,
    resolveModelSelection: async () => ({
      revisionId: "model-revision-chat-1",
      profileId: "profile-chat",
      capability: "tool_calling",
      revision: { limits: { maxInputTokens: 256 } },
    }),
    executionBroker: {
      async execute(request) {
        requests.push(request);
        return {
          status: "completed",
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
          output: {
            content: [{
              type: "text",
              text: JSON.stringify({
                summary: "The conversation is about a governed launch.",
                importantState: ["The draft is private."],
                decisions: ["Use the pinned model."],
                risks: ["Inputs remain untrusted."],
              }),
            }],
            toolCalls: [],
          },
        };
      },
      async cancel() {},
    },
    executor: {
      async execute({ turn, messages }) {
        workerMessages = messages;
        return {
          response: "context rebuilt",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  for (let index = 0; index < 10; index += 1) {
    await persistence.appendMessage({
      schemaVersion: "workbench-v1",
      messageId: `history-${index}`,
      sessionId: session.sessionId,
      turnId: `history-turn-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      kind: index % 2 === 0 ? "turn" : "result",
      content: `history-${index}:${"x".repeat(600)}`,
      createdAt: NOW,
    });
  }
  const queued = await runner.enqueueTurn(agentTurn(session.sessionId, "Use the governed context."));
  await runner.waitForIdle(session.sessionId);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "model_call");
  assert.equal(requests[0].metadata.maintenanceKind, "context_condensation");
  assert.match(workerMessages[0].content, /UNTRUSTED_DERIVED_CONTEXT/);
  const contextEvent = await persistence.getLatestContextEvent(session.sessionId, { status: "completed" });
  assert.equal(contextEvent.provenance.turnId, queued.turnId);
  assert.equal(contextEvent.modelProfileRevisionId, "model-revision-chat-1");
  const completed = await runner.getTurn(session.sessionId, queued.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.invocationIds.length, 1);
});

test("model_task shares FIFO but dispatches one direct image model_call without Pi capabilities or fallback", async () => {
  const requests = [];
  const artifactRefs = [{ artifactId: "artifact-image-1", mediaType: "image/png" }];
  const executionBroker = {
    async execute(request) {
      requests.push(request);
      return {
        schemaVersion: "workbench-execution-fabric-v1",
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        status: "completed",
        isolation: "process",
        output: {
          kind: "image_generation",
          artifactRefs,
          seed: 7,
          format: "png",
          dimensions: { width: 1024, height: 1024 },
          safetyStatus: "passed",
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            imageCount: 1,
            costUsdMicros: 1000,
          },
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
        },
        requestedModelRevisionId: request.modelProfileRevisionId,
        actualModelRevisionId: request.modelProfileRevisionId,
        artifactRefs,
      };
    },
  };
  const { runner } = fixture({ executionBroker });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const queued = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "model_task",
    modelProfileRevisionId: "model-revision-image-1",
    input: {
      task: "image_generation",
      prompt: "A small blue circle",
      aspectRatio: "1:1",
      outputFormat: "png",
    },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(
    session.sessionId,
    queued.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].mode, "model_call");
  assert.equal(requests[0].isolation, "process");
  assert.equal(requests[0].modelCapability, "image_generation");
  assert.deepEqual(requests[0].fallbackModelProfileRevisionIds, []);
  assert.deepEqual(requests[0].capabilities, {
    toolAllowlist: [],
    connectionIds: [],
    network: false,
    filesystem: "none",
    externalActions: false,
  });
  assert.equal(requests[0].limits.maxSteps, 1);
  assert.equal(requests[0].limits.maxChildren, 0);
  assert.equal(requests[0].limits.maxImageCount, 1);
  assert.equal(completed.result.kind, "model_task");
  assert.equal(completed.actualModelRevisionId, "model-revision-image-1");
  assert.deepEqual(completed.artifactRefs, artifactRefs);
  assert.deepEqual(completed.result.artifactRefs, artifactRefs);
  assert.equal(completed.result.invocationIds.length, 1);
});

test("cancelling a running model_task cancels its invocation and rejects a late model result", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const cancelled = [];
  const executionBroker = {
    async execute(request, { signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return {
        status: "completed",
        requestedModelRevisionId: request.modelProfileRevisionId,
        actualModelRevisionId: request.modelProfileRevisionId,
        artifactRefs: [{ artifactId: "late-artifact", mediaType: "image/png" }],
        output: {
          kind: "image_generation",
          artifactRefs: [{ artifactId: "late-artifact", mediaType: "image/png" }],
          seed: null,
          format: "png",
          dimensions: { width: 512, height: 512 },
          safetyStatus: "passed",
          usage: {
            inputTokens: 0, outputTokens: 0, totalTokens: 0,
            imageCount: 1, costUsdMicros: 1000,
          },
          requestedModelRevisionId: request.modelProfileRevisionId,
          actualModelRevisionId: request.modelProfileRevisionId,
        },
      };
    },
    async cancel(invocationId) { cancelled.push(invocationId); },
  };
  const { runner } = fixture({ executionBroker });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn({
    sessionId: session.sessionId,
    kind: "model_task",
    modelProfileRevisionId: "model-revision-image-1",
    input: { task: "image_generation", prompt: "Cancel this image." },
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await startedPromise;
  await runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "stop",
  });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(
    session.sessionId,
    turn.turnId,
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.equal(cancelled.length, 1);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.result, null);
  assert.equal(completed.actualModelRevisionId, null);
  assert.deepEqual(completed.artifactRefs, []);
});

test("Turn history is authorized, sequence ordered, and bounded", async () => {
  const { runner } = fixture();
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(session.sessionId, "one"));
  await runner.enqueueTurn(agentTurn(session.sessionId, "two"));
  await runner.waitForIdle(session.sessionId);

  const items = await runner.listTurns(
    session.sessionId,
    { after: 1, limit: 100_000 },
    { userId: "alice", workspaceId: "workspace-alpha" },
  );
  assert.deepEqual(items.map((item) => item.sequence), [2]);
  assert.equal(await runner.listTurns(
    session.sessionId,
    {},
    { userId: "bob", workspaceId: "workspace-alpha" },
  ), null);
});

test("Turn and event cursors page through more than 200 records without truncation or duplication", async () => {
  const persistence = new InMemoryAgentPersistence();
  await persistence.createSession({
    schemaVersion: "workbench-v1",
    sessionId: "session-long-history",
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
    scope: { kind: "main" },
    status: "active",
    activeTurnId: null,
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    title: "Long history",
    source: { kind: "manual" },
    taskStatus: "idle",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const session = persistence.sessions.get("session-long-history");
  for (let sequence = 1; sequence <= 225; sequence += 1) {
    persistence.turns.set(`turn-${sequence}`, {
      schemaVersion: "workbench-v1",
      turnId: `turn-${sequence}`,
      sessionId: session.sessionId,
      sequence,
      status: "completed",
      modelRoutingState: "pinned",
      requestedModelRevisionId: "model-revision-chat-1",
      actualModelRevisionId: "model-revision-chat-1",
      message: `turn ${sequence}`,
      input: { message: `turn ${sequence}` },
      result: null,
      artifactRefs: [],
      queuedAt: NOW,
      startedAt: NOW,
      finishedAt: NOW,
      updatedAt: NOW,
    });
    const events = persistence.events.get(session.sessionId) ?? [];
    events.push({
      schemaVersion: "workbench-v1",
      eventId: `event-${sequence}`,
      sessionId: session.sessionId,
      turnId: `turn-${sequence}`,
      sequence,
      type: "turn.completed",
      summary: `turn ${sequence}`,
      createdAt: NOW,
    });
    persistence.events.set(session.sessionId, events);
  }
  session.turnSequence = 225;
  session.eventSequence = 225;

  async function collect(loader) {
    const values = [];
    let cursor = null;
    do {
      const page = await loader(cursor);
      values.unshift(...page);
      cursor = page.page.nextCursor;
    } while (cursor);
    return values;
  }
  const access = { userId: "alice", workspaceId: "workspace-alpha" };
  const turns = await collect((cursor) => persistence.listTurns(
    session.sessionId,
    { cursor, limit: 37 },
    access,
  ));
  const events = await collect((cursor) => persistence.listEvents(
    session.sessionId,
    { cursor, limit: 41 },
    access,
  ));
  async function collectForward(loader) {
    const values = [];
    let cursor = null;
    do {
      const page = await loader(cursor);
      values.push(...page);
      cursor = page.page.nextCursor;
    } while (cursor);
    return values;
  }
  const forwardTurns = await collectForward((cursor) => persistence.listTurns(
    session.sessionId,
    { after: 0, cursor, limit: 37 },
    access,
  ));
  const forwardEvents = await collectForward((cursor) => persistence.listEvents(
    session.sessionId,
    { after: 0, cursor, limit: 41 },
    access,
  ));
  assert.equal(turns.length, 225);
  assert.equal(events.length, 225);
  assert.deepEqual(turns.map((item) => item.sequence), Array.from({ length: 225 }, (_, index) => index + 1));
  assert.deepEqual(events.map((item) => item.sequence), Array.from({ length: 225 }, (_, index) => index + 1));
  assert.deepEqual(forwardTurns.map((item) => item.sequence), Array.from({ length: 225 }, (_, index) => index + 1));
  assert.deepEqual(forwardEvents.map((item) => item.sequence), Array.from({ length: 225 }, (_, index) => index + 1));
});

test("legacy Session and Turn reads are projected as legacy_unpinned without invented revisions", async () => {
  const persistence = new InMemoryAgentPersistence();
  persistence.sessions.set("legacy-session", {
    schemaVersion: "workbench-v1",
    sessionId: "legacy-session",
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
    scope: { kind: "main" },
    status: "active",
    modelProfileId: "legacy-profile",
    activeTurnId: null,
    turnSequence: 1,
    messageSequence: 0,
    eventSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  persistence.turns.set("legacy-turn", {
    schemaVersion: "workbench-v1",
    turnId: "legacy-turn",
    sessionId: "legacy-session",
    sequence: 1,
    status: "completed",
    message: "legacy message",
    result: {
      response: "legacy response",
      proposalId: null,
      handoffId: null,
      invocationIds: [],
    },
    queuedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
    updatedAt: NOW,
  });

  const session = await persistence.getSession("legacy-session", {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await persistence.getTurn("legacy-session", "legacy-turn", {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(session.lastUsedModelProfileId, "legacy-profile");
  assert.equal(session.modelPreferenceState, "legacy_unpinned");
  assert.equal(Object.hasOwn(session, "modelProfileId"), false);
  assert.equal(turn.modelRoutingState, "legacy_unpinned");
  assert.equal(Object.hasOwn(turn, "requestedModelRevisionId"), false);
  assert.equal(Object.hasOwn(turn, "actualModelRevisionId"), false);
});

test("steer affects only the running turn and does not create another turn", async () => {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const steers = [];
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        started();
        await gate;
        return {
          response: "steered",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
      async steer({ message }) { steers.push(message); },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "start"));
  await startedPromise;
  await runner.steer({ sessionId: session.sessionId, turnId: turn.turnId, message: "focus", userId: "alice", workspaceId: "workspace-alpha" });
  release();
  await runner.waitForIdle(session.sessionId);

  assert.deepEqual(steers, ["focus"]);
  assert.equal((await runner.listMessages(session.sessionId, { userId: "alice", workspaceId: "workspace-alpha" })).filter((item) => item.kind === "turn").length, 1);
});

test("module handoff is a capsule and never copies its transcript", async () => {
  const { runner } = fixture({
    executor: {
      async execute({ turn }) {
        return {
          response: "proposal ready",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
          handoff: {
            importantState: ["Proposal is ready"],
            decisions: ["Keep deterministic default"],
            risks: ["Provider unavailable"],
            artifactRefs: ["artifact-1"],
            transcript: ["must not leak"],
          },
        };
      },
    },
  });
  const main = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const module = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-a",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  await runner.enqueueTurn(agentTurn(module.sessionId, "change it"));
  await runner.waitForIdle(module.sessionId);
  const [handoff] = await runner.listHandoffs({ sessionId: main.sessionId, userId: "alice", workspaceId: "workspace-alpha" });

  assert.deepEqual(handoff.importantState, ["Proposal is ready"]);
  assert.equal(Object.hasOwn(handoff, "transcript"), false);
});

test("a completed Module Turn atomically persists its prepared proposal", async () => {
  const persistence = new InMemoryAgentPersistence();
  const proposalService = new ProductAgentProposalService({
    clock: () => NOW,
    idFactory: () => "agent-proposal-completed",
  });
  const { runner } = fixture({
    persistence,
    executor: {
      async execute({ session, turn }) {
        const proposal = proposalService.prepareFromAgent({
          session,
          turn,
          proposal: {
            summary: "Completed proposal.",
            operations: [{ op: "replace", path: "/definition/goal", value: "complete" }],
            evidenceRefs: [],
            validationResult: { status: "passed", diagnostics: [] },
          },
        });
        return {
          response: "Proposal ready.",
          proposalId: proposal.proposalId,
          proposal,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-private",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "prepare proposal"));
  await runner.waitForIdle(session.sessionId);

  const completed = await runner.getTurn(session.sessionId, turn.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.proposalId, "agent-proposal-completed");
  assert.equal(persistence.proposals.get("agent-proposal-completed").turnId, turn.turnId);
});

test("a durable cancellation fence wins before atomic proposal settlement", async () => {
  const persistence = new InMemoryAgentPersistence();
  const settleTurn = persistence.settleTurn.bind(persistence);
  persistence.settleTurn = async (input) => {
    if (input.proposal) await persistence.requestCancel(input.turnId, NOW);
    return settleTurn(input);
  };
  const proposalService = new ProductAgentProposalService({
    clock: () => NOW,
    idFactory: () => "agent-proposal-fenced",
  });
  const { runner } = fixture({
    persistence,
    executor: {
      async execute({ session, turn }) {
        const proposal = proposalService.prepareFromAgent({
          session,
          turn,
          proposal: {
            summary: "Late proposal.",
            operations: [{ op: "replace", path: "/definition/goal", value: "late" }],
            evidenceRefs: [],
            validationResult: { status: "passed", diagnostics: [] },
          },
        });
        return {
          response: "Proposal prepared.",
          proposalId: proposal.proposalId,
          proposal,
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "loop_creator",
    objectKind: "workflow",
    objectId: "workflow-private",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "prepare proposal"));
  await runner.waitForIdle(session.sessionId);

  const cancelled = await runner.getTurn(session.sessionId, turn.turnId, {
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, null);
  assert.equal(cancelled.turnFence, 2);
  assert.equal(persistence.proposals.size, 0);
});

test("completion winning the cancel race does not append cancellation_requested", async () => {
  let started;
  let release;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const persistence = new InMemoryAgentPersistence();
  const requestCancelWithEvent = persistence.requestCancelWithEvent.bind(persistence);
  persistence.requestCancelWithEvent = async (...args) => {
    release();
    while (persistence.turns.get(args[0])?.status === "running") {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return requestCancelWithEvent(...args);
  };
  const { runner } = fixture({
    persistence,
    executor: {
      async execute({ turn }) {
        started();
        await gate;
        return {
          response: "completion won",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "race completion"));
  await startedPromise;
  const eventCount = (persistence.events.get(session.sessionId) ?? []).length;
  const completed = await runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "too late",
  });
  await runner.waitForIdle(session.sessionId);

  assert.equal(completed.status, "completed");
  assert.equal(Object.hasOwn(completed, "cancellationCommandId"), false);
  assert.deepEqual(
    (persistence.events.get(session.sessionId) ?? []).slice(eventCount).map((event) => event.type),
    ["turn.completed"],
  );
  assert.equal(
    [...persistence.commands.values()].some((command) => command.kind === "cancel_agent_turn"),
    false,
  );
});

test("turn cancellation records intent, cancels child invocations, then aborts the active executor", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const cancelledInvocations = [];
  const executionBroker = {
    async execute(request, { signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return { invocationId: request.invocationId, status: "cancelled" };
    },
    async cancel(invocationId) { cancelledInvocations.push(invocationId); },
  };
  const { runner, persistence } = fixture({
    executionBroker,
    executor: {
      async execute({ runWorkers }) {
        await runWorkers([{ goal: "long worker", isolation: "process" }]);
        return { response: "late result" };
      },
    },
  });
  const session = await runner.createSession({ definitionId: "main", userId: "alice", workspaceId: "workspace-alpha" });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "start"));
  await startedPromise;
  const cancellation = await runner.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId, userId: "alice", workspaceId: "workspace-alpha", reason: "stop" });
  await runner.waitForIdle(session.sessionId);
  const completed = await runner.getTurn(session.sessionId, turn.turnId, { userId: "alice", workspaceId: "workspace-alpha" });

  assert.equal(cancelledInvocations.length, 1);
  assert.equal(completed.status, "cancelled");
  assert.equal(completed.result, null);
  assert.equal(completed.turnFence, 2);
  assert.equal(cancellation.cancellationCommandId, completed.cancellationCommandId);
  assert.equal(persistence.commands.get(completed.cancellationCommandId).kind, "cancel_agent_turn");
  assert.equal(persistence.commands.get(completed.productCommandId).status, "cancelled");
});

test("transactional cancellation defers effects and duplicate requests do not add another fence, event, or command", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const persistence = new InMemoryAgentPersistence();
  const { runner } = fixture({
    persistence,
    executor: {
      async execute({ turn, signal }) {
        started();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return {
          response: "cancelled after commit",
          requestedModelRevisionId: turn.requestedModelRevisionId,
          actualModelRevisionId: turn.requestedModelRevisionId,
          artifactRefs: [],
        };
      },
    },
  });
  const session = await runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await runner.enqueueTurn(agentTurn(session.sessionId, "transactional cancel"));
  await startedPromise;

  const first = await persistence.withTransaction((transactionSession) => runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "commit first",
    transactionSession,
  }));
  const second = await persistence.withTransaction((transactionSession) => runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "duplicate",
    transactionSession,
  }));

  assert.equal(first.cancellationCommandId, second.cancellationCommandId);
  assert.equal(persistence.turns.get(turn.turnId).turnFence, 2);
  assert.equal(
    (persistence.events.get(session.sessionId) ?? [])
      .filter((event) => event.type === "turn.cancellation_requested").length,
    1,
  );
  assert.equal(
    [...persistence.commands.values()].filter((command) => command.kind === "cancel_agent_turn").length,
    1,
  );
  assert.equal(persistence.turns.get(turn.turnId).status, "running");

  await runner.afterCancellationCommitted({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    reason: "commit first",
    turn: first,
  });
  await runner.waitForIdle(session.sessionId);
  assert.equal(persistence.turns.get(turn.turnId).status, "cancelled");
});

test("startup recovery re-drives durable cancellation before terminal settlement", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const cancelled = [];
  const persistence = new InMemoryAgentPersistence();
  const first = fixture({
    persistence,
    executionBroker: {
      async execute(request) {
        started();
        return new Promise(() => {});
      },
    },
    executor: {
      async execute({ runWorkers }) {
        await runWorkers([{ goal: "recover cancellation", isolation: "process" }]);
        return { response: "must not complete" };
      },
    },
  });
  const session = await first.runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await first.runner.enqueueTurn(agentTurn(session.sessionId, "recover cancel"));
  await startedPromise;
  await persistence.withTransaction((transactionSession) => first.runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "persist only",
    transactionSession,
  }));

  const recovered = fixture({
    persistence,
    executionBroker: {
      async cancel(invocationId) { cancelled.push(invocationId); },
    },
  });
  assert.deepEqual(await recovered.runner.recover(), [session.sessionId]);
  await recovered.runner.waitForIdle(session.sessionId);

  assert.equal(cancelled.length, 1);
  assert.equal(persistence.turns.get(turn.turnId).status, "cancelled");
  assert.equal(persistence.commands.get(turn.productCommandId).status, "cancelled");
  assert.equal(
    (persistence.events.get(session.sessionId) ?? [])
      .filter((event) => event.type === "turn.cancelled").length,
    1,
  );
});

test("startup recovery keeps cancellation intent durable when Broker cancellation fails", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const persistence = new InMemoryAgentPersistence();
  const first = fixture({
    persistence,
    executionBroker: {
      async execute() {
        started();
        return new Promise(() => {});
      },
    },
    executor: {
      async execute({ runWorkers }) {
        await runWorkers([{ goal: "durable failed cancel", isolation: "process" }]);
        return { response: "must not complete" };
      },
    },
  });
  const session = await first.runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await first.runner.enqueueTurn(agentTurn(session.sessionId, "retry cancel"));
  await startedPromise;
  await persistence.withTransaction((transactionSession) => first.runner.cancelTurn({
    sessionId: session.sessionId,
    turnId: turn.turnId,
    userId: "alice",
    workspaceId: "workspace-alpha",
    reason: "persist cancellation intent",
    transactionSession,
  }));

  const failedRecovery = fixture({
    persistence,
    executionBroker: {
      async cancel() { throw new Error("cancel_transport_unavailable"); },
    },
  });
  await assert.rejects(failedRecovery.runner.recover(), /cancel_transport_unavailable/);
  assert.equal(persistence.turns.get(turn.turnId).status, "running");
  assert.equal(persistence.turns.get(turn.turnId).internalStatus, "cancellation_requested");
  assert.equal(persistence.commands.get(turn.productCommandId).status, "cancellation_requested");

  const retryRecovery = fixture({
    persistence,
    executionBroker: { async cancel() { return { status: "cancelled" }; } },
  });
  assert.deepEqual(await retryRecovery.runner.recover(), [session.sessionId]);
  await retryRecovery.runner.waitForIdle(session.sessionId);
  assert.equal(persistence.turns.get(turn.turnId).status, "cancelled");
  assert.equal(persistence.commands.get(turn.productCommandId).status, "cancelled");
});

test("startup recovery requeues a running command through CommandIntakeService", async () => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const persistence = new InMemoryAgentPersistence();
  const first = fixture({
    persistence,
    executor: {
      async execute() {
        started();
        return new Promise(() => {});
      },
    },
  });
  const session = await first.runner.createSession({
    definitionId: "main",
    userId: "alice",
    workspaceId: "workspace-alpha",
  });
  const turn = await first.runner.enqueueTurn(agentTurn(session.sessionId, "recover running"));
  await startedPromise;
  assert.equal(persistence.commands.get(turn.productCommandId).status, "running");

  const recovered = fixture({ persistence });
  assert.deepEqual(await recovered.runner.recover(), [session.sessionId]);
  await recovered.runner.waitForIdle(session.sessionId);

  assert.equal(persistence.turns.get(turn.turnId).status, "completed");
  assert.equal(persistence.commands.get(turn.productCommandId).status, "completed");
});
