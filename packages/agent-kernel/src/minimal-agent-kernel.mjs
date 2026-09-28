import {
  AgentKernelError,
  AgentKernelPort,
  assertAgentLoop,
  assertEffectClass,
  assertExecutionGrant,
  assertIdentifier,
  assertSessionPort,
  cloneValue,
  freeze,
  normalizeKernelEvent,
  normalizeSessionRef,
  toModelVisibleEvent,
} from "./contracts.mjs";
import { MinimalKernelContext } from "./context.mjs";
import { composeKernelProfile, installKernelProfile } from "./profile.mjs";

const DEFAULT_PROFILE = Object.freeze({
  id: "minimal-agent-kernel",
  revision: "1",
  mode: "production_locked",
  plugins: [],
});

/**
 * A deliberately small implementation of AgentKernelPort.  It owns only
 * plugin lifecycle, event dispatch, model-visible SessionPort persistence and
 * a narrow tool pipeline.  Product ownership stays behind injected ports.
 */
export class MinimalAgentKernel extends AgentKernelPort {
  #loop;
  #sessionPort;
  #toolPipeline;
  #activeLoop = null;
  #activeSessionPort = null;
  #activeToolPipeline = null;
  #loopProvidedByProfile = false;
  #profile;
  #rootServices;
  #clock;
  #idFactory;
  #rootContext = null;
  #profileInstallation = null;
  #initialization = null;
  #activeRuns = new Map();
  #disposed = false;

  constructor({
    loop,
    sessionPort,
    toolPipeline,
    profile = DEFAULT_PROFILE,
    rootServices = {},
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  } = {}) {
    super();
    this.#loop = loop === undefined || loop === null ? null : assertAgentLoop(loop);
    this.#sessionPort = sessionPort === undefined || sessionPort === null ? null : assertSessionPort(sessionPort);
    this.#toolPipeline = toolPipeline === undefined || toolPipeline === null
      ? null
      : toolPipeline;
    if (this.#toolPipeline !== null && typeof this.#toolPipeline.execute !== "function") {
      throw new AgentKernelError("kernel_tool_pipeline_invalid");
    }
    if (!rootServices || typeof rootServices !== "object" || Array.isArray(rootServices)
      || typeof clock !== "function" || typeof idFactory !== "function") {
      throw new AgentKernelError("minimal_kernel_dependencies_invalid");
    }
    this.#clock = clock;
    this.#idFactory = idFactory;
    const provisionalProviders = profileProviderTokens(profile);
    const fallbackServices = {};
    if (!provisionalProviders.has("agent.loop")) {
      if (!this.#loop) throw new AgentKernelError("agent_loop_invalid");
      fallbackServices["agent.loop"] = this.#loop;
    }
    if (!provisionalProviders.has("kernel.session_port")) {
      if (!this.#sessionPort) throw new AgentKernelError("session_port_invalid");
      fallbackServices["kernel.session_port"] = this.#sessionPort;
    }
    if (!provisionalProviders.has("kernel.tool_pipeline")) {
      fallbackServices["kernel.tool_pipeline"] = this.#toolPipeline ?? unavailableToolPipeline();
    }
    for (const token of Object.keys(fallbackServices)) {
      if (Object.hasOwn(rootServices, token)) {
        throw new AgentKernelError("kernel_root_service_conflict");
      }
    }
    const baseServices = [...Object.keys(fallbackServices), ...Object.keys(rootServices)];
    this.#profile = profile?.schemaVersion === "agent-kernel-profile-v1"
      ? profile
      : composeKernelProfile({ ...DEFAULT_PROFILE, ...profile, baseServices });
    const profileProviders = profileProviderTokens(this.#profile);
    for (const token of Object.keys({ ...fallbackServices, ...rootServices })) {
      if (profileProviders.has(token)) {
        throw new AgentKernelError("kernel_service_provider_conflict");
      }
    }
    // Root providers are executable ports, so structuredClone would reject
    // legitimate functions. They are injected only by the host and pinned.
    this.#rootServices = Object.freeze({ ...fallbackServices, ...rootServices });
    this.#loopProvidedByProfile = profileProviders.has("agent.loop");
  }

  capabilities() {
    return freeze({
      schemaVersion: "agent-kernel-capabilities-v1",
      profile: {
        id: this.#profile.id,
        revision: this.#profile.revision,
        mode: this.#profile.mode,
        plugins: this.#profile.plugins.map((plugin) => ({
          id: plugin.id,
          version: plugin.version,
          trust: plugin.trust,
          lifetime: plugin.lifetime,
          contentHash: plugin.contentHash,
        })),
      },
      operations: ["run", "resume", "cancel", "compact", "dispose"],
      sessionPort: {
        replay: true,
        checkpoint: typeof (this.#activeSessionPort ?? this.#sessionPort)?.checkpoint === "function",
      },
    });
  }

  async *run(request = {}) {
    this.#assertActive();
    await this.#initialize();
    const prepared = this.#prepareRunRequest(request, "run");
    yield* this.#iterateRun(prepared);
  }

  async *resume(session, input = {}) {
    this.#assertActive();
    await this.#initialize();
    const prepared = this.#prepareRunRequest({ ...input, session }, "resume");
    yield* this.#iterateRun(prepared);
  }

  async cancel(runId) {
    const normalizedRunId = assertIdentifier(runId, "kernel_run_id_invalid");
    const active = this.#activeRuns.get(normalizedRunId);
    if (!active) return freeze({ cancelled: false });
    active.controller.abort(new AgentKernelError("kernel_run_cancelled"));
    try { await this.#activeLoop?.cancel(normalizedRunId); } catch {}
    return freeze({ cancelled: true });
  }

  async compact(session) {
    this.#assertActive();
    await this.#initialize();
    if (typeof this.#activeLoop?.compact !== "function") {
      throw new AgentKernelError("agent_loop_compaction_unavailable");
    }
    const result = await this.#activeLoop.compact(normalizeSessionRef(session));
    return freeze(cloneValue(result, "kernel_compaction_invalid"));
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const activeRuns = [...this.#activeRuns.keys()];
    await Promise.allSettled(activeRuns.map((runId) => this.cancel(runId)));
    await Promise.allSettled([...this.#activeRuns.values()].map((active) => active.task));
    this.#activeRuns.clear();
    const errors = [];
    try { await this.#profileInstallation?.dispose(); } catch (error) { errors.push(error); }
    if (!this.#loopProvidedByProfile) {
      try { await this.#activeLoop?.dispose?.(); } catch (error) { errors.push(error); }
    }
    try { await this.#rootContext?.dispose(); } catch (error) { errors.push(error); }
    this.#activeLoop = null;
    this.#activeSessionPort = null;
    this.#activeToolPipeline = null;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "minimal_kernel_dispose_failed");
  }

  async #initialize() {
    if (this.#initialization) return this.#initialization;
    this.#initialization = (async () => {
      const context = new MinimalKernelContext({ scope: "kernel" });
      for (const [token, value] of Object.entries(this.#rootServices)) {
        context.provide(token, value, { pinned: true });
      }
      this.#rootContext = context;
      this.#profileInstallation = await installKernelProfile({ context, profile: this.#profile });
      this.#activeLoop = assertAgentLoop(context.use("agent.loop"));
      this.#activeSessionPort = assertSessionPort(context.use("kernel.session_port"));
      const activeToolPipeline = context.use("kernel.tool_pipeline");
      if (!activeToolPipeline || typeof activeToolPipeline.execute !== "function") {
        throw new AgentKernelError("kernel_tool_pipeline_invalid");
      }
      this.#activeToolPipeline = activeToolPipeline;
    })();
    try {
      await this.#initialization;
    } catch (error) {
      this.#initialization = null;
      await this.#rootContext?.dispose().catch(() => {});
      this.#rootContext = null;
      this.#activeLoop = null;
      this.#activeSessionPort = null;
      this.#activeToolPipeline = null;
      throw error;
    }
  }

  #prepareRunRequest(request, mode) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new AgentKernelError("kernel_run_request_invalid");
    }
    const runId = assertIdentifier(request.runId, "kernel_run_request_invalid");
    if (this.#activeRuns.has(runId)) throw new AgentKernelError("kernel_run_already_active");
    const session = normalizeSessionRef(request.session, "kernel_run_request_invalid");
    const executionGrant = assertExecutionGrant(request.executionGrant);
    return freeze({
      runId,
      session,
      executionGrant,
      input: cloneValue(request.input === undefined ? null : request.input, "kernel_run_input_invalid"),
      mode,
    });
  }

  async *#iterateRun(prepared) {
    const context = this.#rootContext.child({
      scope: `run:${prepared.runId}`,
      metadata: { runId: prepared.runId, sessionId: prepared.session.sessionId, mode: prepared.mode },
    });
    const queue = new KernelEventQueue();
    const controller = new AbortController();
    const active = {
      runId: prepared.runId,
      context,
      queue,
      controller,
      sequence: 0,
      terminal: false,
      waiting: false,
      task: null,
    };
    const emit = (event) => {
      if (active.terminal) return;
      trackActiveEvent(active, event);
      queue.push(cloneValue(event, "kernel_event_invalid"));
    };
    const grantState = { usedToolCalls: 0 };
    const loopInput = {
      runId: prepared.runId,
      session: prepared.session,
      sessionPort: this.#activeSessionPort,
      input: prepared.input,
      mode: prepared.mode,
      executionGrant: prepared.executionGrant,
      signal: controller.signal,
      context,
      tools: freeze({
        execute: (call) => this.#activeToolPipeline.execute({
          call,
          executionGrant: prepared.executionGrant,
          grantState,
          emit,
          signal: controller.signal,
        }),
      }),
    };
    active.task = this.#driveLoop(active, loopInput);
    this.#activeRuns.set(prepared.runId, active);
    try {
      for await (const rawEvent of queue) {
        const event = normalizeKernelEvent(rawEvent, {
          runId: prepared.runId,
          session: prepared.session,
          sequence: ++active.sequence,
          eventId: this.#nextId("kernel-event"),
          occurredAt: this.#clock(),
        });
        if (event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.waiting") {
          active.terminal = true;
        }
        // This ordering is deliberate: model-visible content is durably sent
        // to SessionPort before plugin listeners or the caller can observe it.
        if (event.modelVisible) await this.#activeSessionPort.append(toModelVisibleEvent(event));
        await context.emit(event);
        yield event;
      }
    } finally {
      if (!active.terminal) await this.cancel(prepared.runId);
      await active.task.catch(() => {});
      this.#activeRuns.delete(prepared.runId);
      await context.dispose();
    }
  }

  async #driveLoop(active, loopInput) {
    try {
      for await (const event of this.#activeLoop.run(loopInput)) {
        if (active.terminal) break;
        active.queue.push(cloneValue(event, "kernel_event_invalid"));
        trackActiveEvent(active, event);
      }
      if (!active.terminal) {
        active.queue.push(active.waiting
          ? { type: "run.waiting", modelVisible: false, payload: { status: "waiting_for_approval" } }
          : { type: "run.completed", modelVisible: false, payload: { status: "completed" } });
        active.terminal = true;
      }
    } catch (error) {
      const cancelled = active.controller.signal.aborted;
      active.queue.push({
        type: cancelled ? "run.cancelled" : "run.failed",
        modelVisible: false,
        payload: cancelled
          ? { code: "kernel_run_cancelled" }
          : { code: safeErrorCode(error?.code, "agent_loop_failed") },
      });
      active.terminal = true;
    } finally {
      active.queue.end();
    }
  }

  #nextId(kind) {
    return assertIdentifier(this.#idFactory(kind), "kernel_id_factory_invalid");
  }

  #assertActive() {
    if (this.#disposed) throw new AgentKernelError("agent_kernel_disposed");
  }
}

export function createMinimalAgentKernel(options = {}) {
  return new MinimalAgentKernel(options);
}

class KernelEventQueue {
  #items = [];
  #waiters = [];
  #closed = false;

  push(value) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#items.push(value);
  }

  end() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next() {
    if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift(), done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  [Symbol.asyncIterator]() { return this; }
}

function safeErrorCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function unavailableToolPipeline() {
  return freeze({
    async execute({ call, emit } = {}) {
      if (!call || typeof call !== "object" || Array.isArray(call) || typeof emit !== "function") {
        throw new AgentKernelError("kernel_tool_pipeline_execution_invalid");
      }
      const toolId = assertIdentifier(call.toolId, "tool_call_invalid");
      const effectClass = assertEffectClass(call.effectClass, "tool_call_invalid");
      emit({ type: "tool.requested", modelVisible: true, payload: { toolId, effectClass } });
      const result = freeze({ status: "denied", toolId, effectClass, code: "kernel_tool_pipeline_unavailable" });
      emit({ type: "tool.denied", modelVisible: true, payload: result });
      return result;
    },
  });
}

function trackActiveEvent(active, event) {
  if (event?.type === "approval.pending" || event?.type === "tool.pending") active.waiting = true;
  if (event?.type === "run.completed" || event?.type === "run.failed" || event?.type === "run.cancelled" || event?.type === "run.waiting") {
    active.terminal = true;
  }
}

function profileProviderTokens(profile) {
  const tokens = new Set();
  for (const plugin of Array.isArray(profile?.plugins) ? profile.plugins : []) {
    for (const token of Array.isArray(plugin?.provides) ? plugin.provides : []) {
      if (typeof token === "string") tokens.add(token);
    }
  }
  return tokens;
}
