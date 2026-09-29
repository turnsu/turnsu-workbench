import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionBroker,
  InMemoryExecutionPersistence,
} from "../../src/execution/index.mjs";

const NOW = "2026-08-04T10:00:00.000Z";
const SDP_OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const SDP_ANSWER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n";
let nextId = 0;

function realtimeRequest(overrides = {}) {
  const invocationId = overrides.invocationId ?? `invocation-realtime-${++nextId}`;
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: overrides.attemptId ?? `attempt-${invocationId}`,
    workspaceId: "workspace-alpha",
    actor: { userId: "user-alpha" },
    lineage: {
      productCommandId: `command-${invocationId}`,
      sessionId: "skill-creation-session-alpha",
      turnId: `turn-${invocationId}`,
    },
    capacityAuthority: {
      admissionId: `admission-${invocationId}`,
      capacityLeaseId: `capacity-${invocationId}`,
      fence: 1,
    },
    controller: {
      kind: "skill_creation_turn",
      controllerId: `turn-${invocationId}`,
      fence: 1,
    },
    mode: "realtime_audio",
    isolation: "process",
    modelProfileRevisionId: "model-revision-realtime-alpha",
    modelCapability: "realtime_audio",
    fallbackModelProfileRevisionIds: [],
    goal: "Hold a governed Skill creation conversation.",
    limits: {
      timeoutMs: 60_000,
      maxSteps: 20,
      maxModelRequests: 20,
      maxChildren: 0,
      maxDepth: 0,
      maxSpawnedChildren: 0,
      maxInputTokens: 50_000,
      maxOutputTokens: 20_000,
      maxInputBytes: 100_000,
      maxOutputBytes: 100_000,
      maxImageCount: 0,
      maxCostUsdMicros: 5_000_000,
    },
    capabilities: {
      toolAllowlist: ["propose_skill_creation_patch"],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: { type: "object", additionalProperties: true },
    evidenceRequirements: [],
    metadata: { creationSessionId: "skill-creation-session-alpha" },
    ...overrides,
  };
}

function fixture({ capacityAuthorizer, streamBackendSettlementTimeoutMs = 20 } = {}) {
  const persistence = new InMemoryExecutionPersistence();
  let sequence = 0;
  const broker = new ExecutionBroker({
    persistence,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-realtime-${++sequence}`,
    capacityAuthorizer: capacityAuthorizer ?? { async authorize() { return true; } },
    streamBackendSettlementTimeoutMs,
  });
  return { broker, persistence };
}

function realtimeBackend(overrides = {}) {
  return {
    async open() {
      return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-alpha" } };
    },
    async update() { return {}; },
    async finish() {
      return {
        output: { state: "finished" },
        summary: "Realtime conversation finished.",
        usage: {
          steps: 1,
          modelRequests: 1,
          inputBytes: 100,
          outputBytes: 200,
          imageCount: 0,
          costUsdMicros: 1_000,
        },
      };
    },
    async cancel() { return { status: "cancelled" }; },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Realtime open persists execution authority before backend signaling and finishes idempotently", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-lifecycle" });
  let updateHandle = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ request, lease, offer }) {
        assert.equal((await persistence.getInvocation(request.invocationId)).status, "running");
        assert.equal((await persistence.getAttempt(request.attemptId)).status, "running");
        assert.equal(
          (await persistence.getActiveLease(request.invocationId, request.attemptId, NOW)).capabilityLeaseId,
          lease.capabilityLeaseId,
        );
        assert.equal(offer.sdpOffer, SDP_OFFER);
        assert.doesNotMatch(JSON.stringify(await persistence.getInvocation(request.invocationId)), /m=audio/);
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-lifecycle" } };
      },
      async update({ handle, update }) {
        updateHandle = handle;
        assert.equal(update.kind, "session_instructions");
        return {};
      },
    }),
  });

  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  let completed = false;
  void opened.completion.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(opened.ready.status, "running");
  assert.equal(opened.ready.sdpAnswer, SDP_ANSWER);
  assert.equal(Object.hasOwn(opened.ready, "authority"), false);
  assert.equal(typeof opened.authority.capabilityLeaseId, "string");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "running");

  await broker.updateStream(input.invocationId, {
    kind: "session_instructions",
    instructions: "Ask for the missing output description.",
  }, { authority: opened.authority });
  assert.deepEqual(updateHandle, { callId: "call-lifecycle" });

  const first = await broker.finishStream(input.invocationId, {
    authority: opened.authority,
  });
  const second = await broker.finishStream(input.invocationId, {
    authority: opened.authority,
  });
  assert.equal(first.status, "completed");
  assert.deepEqual(second, first);
  assert.deepEqual(await opened.completion, first);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "completed");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => event.type),
    [
      "execution.started",
      "execution.stream_ready",
      "execution.stream_updated",
      "execution.completed",
    ],
  );
});

test("Realtime terminal cleanup failure is observable without changing the terminal result", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-cleanup-failure" });
  broker.registerBackend({ mode: "realtime_audio", isolation: "process", backend: realtimeBackend() });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    async onTerminal() {
      const error = new Error("capacity release failed");
      error.code = "capacity_release_failed";
      throw error;
    },
  });

  const result = await broker.finishStream(input.invocationId, { authority: opened.authority });
  assert.equal(result.status, "completed");
  assert.deepEqual(await opened.completion, result);
  const events = persistence.events.get(input.invocationId);
  assert.equal(events.at(-1).type, "execution.stream_cleanup_failed");
  assert.deepEqual(events.at(-1).payload, { reasonCode: "capacity_release_failed" });
});

test("Realtime backend completion cannot precede the persisted ready event", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-immediate-completion" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open() {
        return {
          sdpAnswer: SDP_ANSWER,
          handle: { callId: "call-immediate-completion" },
          completion: Promise.resolve({
            output: { state: "provider_finished" },
            summary: "Provider finished the stream.",
            usage: {
              steps: 1,
              modelRequests: 1,
              inputBytes: 1,
              outputBytes: 1,
              imageCount: 0,
              costUsdMicros: 1,
            },
          }),
        };
      },
    }),
  });

  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  assert.equal(opened.ready.status, "running");
  assert.equal((await opened.completion).status, "completed");
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => event.type),
    ["execution.started", "execution.stream_ready", "execution.completed"],
  );
});

test("Realtime update rejects stale authority without closing the valid stream", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-stale-authority" });
  broker.registerBackend({ mode: "realtime_audio", isolation: "process", backend: realtimeBackend() });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  await assert.rejects(
    broker.updateStream(input.invocationId, {
      kind: "session_instructions",
      instructions: "stale",
    }, {
      authority: { ...opened.authority, fence: opened.authority.fence + 1 },
    }),
    { code: "execution_stream_authority_invalid", status: "permission_denied" },
  );
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "running");
  await broker.cancel(input.invocationId);
});

test("Realtime finish persists timeout without waiting for a hung Provider", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-hung-finish" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async finish() { return new Promise(() => {}); },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  const result = await broker.finishStream(input.invocationId, { authority: opened.authority });
  assert.equal(result.status, "timeout");
  assert.deepEqual(await opened.completion, result);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "timeout");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
});

test("Realtime execution deadline preempts an already hung finish settlement", async () => {
  const { broker, persistence } = fixture({ streamBackendSettlementTimeoutMs: 1_000 });
  const base = realtimeRequest({ invocationId: "invocation-realtime-deadline-preempts-finish" });
  const input = { ...base, limits: { ...base.limits, timeoutMs: 100 } };
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async finish() { return new Promise(() => {}); },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  const result = await broker.finishStream(input.invocationId, { authority: opened.authority });
  assert.equal(result.status, "timeout");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "timeout");
  assert.deepEqual(await opened.completion, result);
});

test("Realtime cancel persists cancellation without waiting for a hung Provider cleanup", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-hung-cancel" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async cancel() { return new Promise(() => {}); },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  const result = await broker.cancel(input.invocationId, { reason: "user_stopped" });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(await opened.completion, result);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "cancelled");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
});

test("Realtime cancel preempts a hung finish and both callers observe one terminal result", async () => {
  const { broker, persistence } = fixture({ streamBackendSettlementTimeoutMs: 1_000 });
  const input = realtimeRequest({ invocationId: "invocation-realtime-cancel-preempts-finish" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async finish() { return new Promise(() => {}); },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const finishing = broker.finishStream(input.invocationId, { authority: opened.authority });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelling = broker.cancel(input.invocationId, { reason: "user_stopped" });

  const [finishResult, cancelResult] = await Promise.all([finishing, cancelling]);
  assert.equal(finishResult.status, "cancelled");
  assert.deepEqual(cancelResult, finishResult);
  assert.deepEqual(await opened.completion, finishResult);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "cancelled");
});

test("Realtime backend events accept only fixed Product-safe schemas", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-safe-events" });
  let providerEmit = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ emit }) {
        providerEmit = emit;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-safe-events" } };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  await providerEmit("realtime.state", { state: "listening" });
  await assert.rejects(
    providerEmit("realtime.transcript", { text: "raw transcript" }),
    { code: "execution_stream_event_invalid" },
  );
  await assert.rejects(
    providerEmit("realtime.state", { state: "listening", providerPayload: { audio: "raw" } }),
    { code: "execution_stream_event_invalid" },
  );
  assert.deepEqual(
    persistence.events.get(input.invocationId).filter((event) => event.type.startsWith("realtime."))
      .map((event) => [event.type, event.payload]),
    [["realtime.state", { state: "listening" }]],
  );
  await broker.cancel(input.invocationId);
  await opened.completion;
});

test("Realtime service events and session config stay ephemeral and strictly normalized", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-service-events" });
  const observed = [];
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ sessionConfig, realtimeEventSink }) {
        assert.deepEqual(sessionConfig, { voice: "alloy", instructions: "ephemeral-only" });
        await realtimeEventSink({ type: "state", state: "listening" });
        await realtimeEventSink({
          type: "transcript",
          segmentId: "segment-1",
          speaker: "user",
          text: "ephemeral transcript",
          final: true,
        });
        assert.deepEqual(await realtimeEventSink({
          type: "function_call",
          name: "propose_skill_creation_patch",
          callId: "call-1",
          arguments: "{\"operations\":[]}",
        }), { accepted: true });
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-service-events" } };
      },
    }),
  });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    sessionConfig: { voice: "alloy", instructions: "ephemeral-only" },
    async realtimeEventSink(event) {
      observed.push(event);
      return event.type === "function_call" ? { accepted: true } : undefined;
    },
  });

  assert.equal(observed.length, 3);
  assert.deepEqual(observed[1], {
    type: "transcript",
    segmentId: "segment-1",
    speaker: "user",
    text: "ephemeral transcript",
    final: true,
  });
  const persisted = JSON.stringify(await persistence.getInvocation(input.invocationId));
  assert.doesNotMatch(persisted, /ephemeral-only|ephemeral transcript/);
  await broker.cancel(input.invocationId);
  await opened.completion;
});

test("Realtime service Tool calls require an exact active Tool allowlist entry", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-wrong-service-tool" });
  let providerSink = null;
  let productCalls = 0;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ realtimeEventSink }) {
        providerSink = realtimeEventSink;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-wrong-service-tool" } };
      },
    }),
  });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    async realtimeEventSink() { productCalls += 1; },
  });

  await assert.rejects(providerSink({
    type: "function_call",
    name: "unlisted_admin_action",
    callId: "call-unlisted",
    arguments: "{}",
  }), { code: "execution_permission_denied", status: "permission_denied" });
  assert.equal(productCalls, 0);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "running");
  await broker.cancel(input.invocationId);
  await opened.completion;
});

test("Realtime service events arriving after cancellation never reach the Product sink", async () => {
  const { broker } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-late-service-event" });
  let providerSink = null;
  let productCalls = 0;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ realtimeEventSink }) {
        providerSink = realtimeEventSink;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-late-service-event" } };
      },
    }),
  });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    async realtimeEventSink() { productCalls += 1; },
  });
  await broker.cancel(input.invocationId);
  await opened.completion;

  await assert.rejects(providerSink({
    type: "transcript",
    segmentId: "segment-late",
    speaker: "user",
    text: "must not be applied",
    final: true,
  }), { code: "execution_result_rejected_by_fence" });
  assert.equal(productCalls, 0);
});

test("Realtime Product sink guard blocks a delayed mutation racing cancellation", async () => {
  const { broker } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-service-cancel-race" });
  const entered = deferred();
  const release = deferred();
  let providerSink = null;
  let productMutation = false;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ realtimeEventSink }) {
        providerSink = realtimeEventSink;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-service-cancel-race" } };
      },
    }),
  });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    async realtimeEventSink(_event, guard) {
      entered.resolve();
      await release.promise;
      await guard.assertActive();
      productMutation = true;
    },
  });
  const delivery = providerSink({
    type: "transcript",
    segmentId: "segment-racing",
    speaker: "user",
    text: "cancel before applying",
    final: true,
  });
  await entered.promise;
  const cancellation = broker.cancel(input.invocationId);
  release.resolve();

  await assert.rejects(delivery, { code: "execution_stream_closed", status: "cancelled" });
  assert.equal((await cancellation).status, "cancelled");
  assert.equal((await opened.completion).status, "cancelled");
  assert.equal(productMutation, false);
});

test("Realtime Provider checkpoints are disabled and cannot persist Provider payload", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-checkpoint-privacy" });
  let providerCheckpoint = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ checkpoint }) {
        providerCheckpoint = checkpoint;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-checkpoint-privacy" } };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  await assert.rejects(async () => providerCheckpoint({
    providerSessionId: "secret-provider-session",
    transcript: "private transcript",
    audio: "raw-audio",
  }), { code: "execution_stream_checkpoint_unsupported", status: "permission_denied" });
  assert.equal(persistence.checkpoints.size, 0);
  assert.doesNotMatch(JSON.stringify(await persistence.getInvocation(input.invocationId)), /secret-provider-session|private transcript|raw-audio/);
  await broker.cancel(input.invocationId);
  await opened.completion;
});

test("Realtime update times out instead of waiting for a hung Provider", async () => {
  const { broker, persistence } = fixture({ streamBackendSettlementTimeoutMs: 20 });
  const input = realtimeRequest({ invocationId: "invocation-realtime-hung-update" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({ async update() { return new Promise(() => {}); } }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  await assert.rejects(broker.updateStream(input.invocationId, {
    kind: "session_instructions",
    instructions: "must not hang",
  }, { authority: opened.authority }), {
    code: "execution_stream_provider_timeout",
    status: "timeout",
  });
  assert.equal((await opened.completion).status, "timeout");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "timeout");
});

test("Realtime cancellation settles an update that is already hung", async () => {
  const { broker } = fixture({ streamBackendSettlementTimeoutMs: 1_000 });
  const input = realtimeRequest({ invocationId: "invocation-realtime-cancel-hung-update" });
  const updateStarted = deferred();
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async update() {
        updateStarted.resolve();
        return new Promise(() => {});
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const update = broker.updateStream(input.invocationId, {
    kind: "session_instructions",
    instructions: "cancel this update",
  }, { authority: opened.authority });
  await updateStarted.promise;
  const cancelled = await broker.cancel(input.invocationId);

  await assert.rejects(update, { code: "execution_stream_closed", status: "cancelled" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await opened.completion).status, "cancelled");
});

test("Realtime open authority is atomic when a conflicting attempt already exists", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-atomic-conflict" });
  await persistence.createAttempt({ attemptId: input.attemptId });
  let backendOpened = false;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({ async open() { backendOpened = true; } }),
  });

  await assert.rejects(
    broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } }),
    { code: "execution_attempt_exists" },
  );
  assert.equal(backendOpened, false);
  assert.equal(persistence.invocations.size, 0);
  assert.equal(persistence.attempts.size, 1);
  assert.equal(persistence.leases.size, 0);
});

test("Realtime startup recovery fails closed, fences the old attempt, and revokes its lease", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-recovery" });
  broker.registerBackend({ mode: "realtime_audio", isolation: "process", backend: realtimeBackend() });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const recoveryBroker = new ExecutionBroker({
    persistence,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-recovery`,
    capacityAuthorizer: { async authorize() { return true; } },
    streamBackendSettlementTimeoutMs: 20,
  });

  const recovered = await recoveryBroker.recoverStreams();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].invocationId, input.invocationId);
  assert.equal(recovered[0].capacityLeaseId, input.capacityAuthority.capacityLeaseId);
  assert.equal(recovered[0].result.status, "failed");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "failed");
  assert.equal((await persistence.getInvocation(input.invocationId)).executionFence, 2);
  assert.equal((await persistence.getAttempt(input.attemptId)).fence, 2);
  assert.equal([...persistence.leases.values()][0].status, "revoked");
  await assert.rejects(
    broker.finishStream(input.invocationId, { authority: opened.authority }),
    { code: "execution_result_rejected_by_fence" },
  );
  assert.equal((await opened.completion).status, "permission_denied");
});

test("Realtime recovery terminalizes a legacy partial open without inventing an Attempt", async () => {
  const source = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-partial-recovery" });
  source.broker.registerBackend({ mode: "realtime_audio", isolation: "process", backend: realtimeBackend() });
  const opened = await source.broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const partial = new InMemoryExecutionPersistence();
  await partial.createInvocation(await source.persistence.getInvocation(input.invocationId));
  await source.broker.cancel(input.invocationId);
  await opened.completion;
  const recoveryBroker = new ExecutionBroker({
    persistence: partial,
    clock: () => NOW,
    idFactory: (kind) => `${kind}-partial-recovery`,
    capacityAuthorizer: { async authorize() { return true; } },
  });

  assert.equal((await recoveryBroker.recoverStreams()).length, 1);
  assert.equal((await partial.getInvocation(input.invocationId)).status, "failed");
  assert.equal(await partial.getAttempt(input.attemptId), null);
  assert.equal(partial.leases.size, 0);
});

test("Realtime capability lease loss terminally fences the stream", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-lease-loss" });
  let cancelledHandle = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async cancel({ handle }) {
        cancelledHandle = handle;
        return { status: "cancelled" };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  persistence.leases.get(opened.authority.capabilityLeaseId).status = "revoked";

  await assert.rejects(
    broker.updateStream(input.invocationId, {
      kind: "session_instructions",
      instructions: "must not reach backend",
    }, { authority: opened.authority }),
    { code: "execution_capability_lease_invalid", status: "permission_denied" },
  );
  const result = await opened.completion;
  assert.equal(result.status, "permission_denied");
  assert.deepEqual(cancelledHandle, { callId: "call-alpha" });
  assert.equal((await persistence.getAttempt(input.attemptId)).status, "permission_denied");
});

test("Realtime authority heartbeat failure remains failed instead of becoming user cancellation", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-authority-heartbeat-failed" });
  const authority = new AbortController();
  let providerSignal = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ signal }) {
        providerSignal = signal;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-authority-heartbeat-failed" } };
      },
    }),
  });
  const opened = await broker.openStream(input, {
    offer: { sdpOffer: SDP_OFFER },
    authoritySignal: authority.signal,
  });
  authority.abort(Object.assign(new Error("heartbeat unavailable"), {
    code: "capacity_lease_heartbeat_failed",
  }));

  const result = await opened.completion;
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "Execution capacity lease heartbeat failed.");
  assert.equal(providerSignal.aborted, true);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "failed");
});

test("Realtime fence mismatch rejects a late finish", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-fence" });
  let cancelled = 0;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async cancel() {
        cancelled += 1;
        return { status: "cancelled" };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  persistence.invocations.get(input.invocationId).executionFence += 1;

  await assert.rejects(
    broker.finishStream(input.invocationId, { authority: opened.authority }),
    { code: "execution_result_rejected_by_fence", status: "permission_denied" },
  );
  assert.equal((await opened.completion).status, "permission_denied");
  assert.equal(cancelled, 1);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "running");
});

test("Realtime cancel revokes authority, interrupts the backend, and resolves completion", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-cancel" });
  let cancellation = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async cancel(value) {
        cancellation = value;
        return { status: "cancelled" };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const result = await broker.cancel(input.invocationId, { reason: "user_stopped" });

  assert.equal(result.status, "cancelled");
  assert.deepEqual(await opened.completion, result);
  assert.equal(cancellation.reason, "user_stopped");
  assert.deepEqual(cancellation.handle, { callId: "call-alpha" });
  assert.equal([...persistence.leases.values()][0].status, "revoked");
  assert.equal((await persistence.getInvocation(input.invocationId)).executionFence, 2);
});

test("Realtime open failure persists a terminal failure and revokes the lease", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-open-failure" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open({ request, lease }) {
        assert.equal((await persistence.getInvocation(request.invocationId)).status, "running");
        assert.equal(
          (await persistence.getActiveLease(request.invocationId, request.attemptId, NOW)).capabilityLeaseId,
          lease.capabilityLeaseId,
        );
        const failure = new Error("provider_unavailable");
        failure.code = "provider_unavailable";
        throw failure;
      },
    }),
  });

  await assert.rejects(
    broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } }),
    { code: "provider_unavailable" },
  );
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "failed");
  assert.equal((await persistence.getAttempt(input.attemptId)).status, "failed");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => event.type),
    ["execution.started", "execution.failed"],
  );
});

test("Realtime usage budget overflow interrupts and terminally fails the stream", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-budget" });
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async update() {
        return {
          usageDelta: {
            steps: 1,
            modelRequests: 1,
            inputBytes: 1,
            outputBytes: 1,
            imageCount: 0,
            costUsdMicros: input.limits.maxCostUsdMicros + 1,
          },
        };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });

  await assert.rejects(
    broker.updateStream(input.invocationId, {
      kind: "session_instructions",
      instructions: "continue",
    }, { authority: opened.authority }),
    { code: "execution_budget_exceeded" },
  );
  assert.equal((await opened.completion).status, "failed");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "failed");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
});

test("Realtime Broker accumulates token usage and fails the stream at the cumulative threshold", async () => {
  const { broker, persistence } = fixture();
  const base = realtimeRequest({ invocationId: "invocation-realtime-token-budget" });
  const input = { ...base, limits: { ...base.limits, maxInputTokens: 15 } };
  let reportUsage;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async open(options) {
        reportUsage = options.reportUsage;
        return { sdpAnswer: SDP_ANSWER, handle: { callId: "call-token-budget" } };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const usage = (inputTokens) => ({
    steps: 1,
    modelRequests: 1,
    inputBytes: 0,
    outputBytes: 0,
    imageCount: 0,
    costUsdMicros: 1,
    inputTokens,
    outputTokens: 1,
    totalTokens: inputTokens + 1,
    audioInputTokens: inputTokens,
    audioOutputTokens: 1,
    cachedInputTokens: 0,
  });

  assert.equal((await reportUsage(usage(10))).inputTokens, 10);
  await assert.rejects(reportUsage(usage(6)), { code: "execution_budget_exceeded" });

  const result = await opened.completion;
  assert.equal(result.status, "failed");
  assert.equal(result.usage.inputTokens, 16);
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(result.usage.totalTokens, 18);
  assert.equal(result.usage.costUsdMicros, 2);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "failed");
  assert.deepEqual(
    persistence.events.get(input.invocationId)
      .filter((event) => event.type === "execution.stream_usage")
      .map((event) => event.payload.inputTokens),
    [10],
  );
});

test("Realtime timeout owns terminal cleanup after ready returns", async () => {
  const { broker, persistence } = fixture();
  const base = realtimeRequest({ invocationId: "invocation-realtime-timeout" });
  const input = {
    ...base,
    limits: { ...base.limits, timeoutMs: 100 },
  };
  let cancelled = 0;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: realtimeBackend({
      async cancel() {
        cancelled += 1;
        return { status: "cancelled" };
      },
    }),
  });
  const opened = await broker.openStream(input, { offer: { sdpOffer: SDP_OFFER } });
  const result = await opened.completion;

  assert.equal(result.status, "timeout");
  assert.equal(cancelled, 1);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "timeout");
  assert.equal([...persistence.leases.values()][0].status, "revoked");
});

test("Realtime signaling rejects browser data channels before persistence", async () => {
  const { broker, persistence } = fixture();
  const input = realtimeRequest({ invocationId: "invocation-realtime-data-channel" });
  broker.registerBackend({ mode: "realtime_audio", isolation: "process", backend: realtimeBackend() });

  await assert.rejects(
    broker.openStream(input, {
      offer: { sdpOffer: `${SDP_OFFER}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n` },
    }),
    { code: "execution_stream_offer_invalid" },
  );
  assert.equal(persistence.invocations.size, 0);
});
