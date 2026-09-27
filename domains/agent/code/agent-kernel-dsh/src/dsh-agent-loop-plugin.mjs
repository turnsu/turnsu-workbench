import {
  AgentKernelError,
  AgentLoop,
  assertIdentifier,
  cloneValue,
  freeze,
  normalizeSessionRef,
} from "../../agent-kernel/src/contracts.mjs";

const DEFAULT_MAX_REPLAY_EVENTS = 128;
const DEFAULT_MAX_REPLAY_CHARS = 100_000;

/**
 * Experimental DeepSeek Harness/Cordis compatibility seam.  It intentionally
 * accepts only a tiny runtime-shaped port supplied by an integration package;
 * no Cordis type, Product repository, gateway, or credential crosses this
 * boundary.  It is not a production default Kernel.
 */
export class DshAgentLoopPlugin extends AgentLoop {
  #createRuntime;
  #maxReplayEvents;
  #maxReplayChars;
  #runtimeBySession = new Map();
  #activeRuns = new Map();
  #disposed = false;

  constructor({
    createRuntime,
    maxReplayEvents = DEFAULT_MAX_REPLAY_EVENTS,
    maxReplayChars = DEFAULT_MAX_REPLAY_CHARS,
  } = {}) {
    super();
    if (typeof createRuntime !== "function"
      || !Number.isInteger(maxReplayEvents) || maxReplayEvents < 1 || maxReplayEvents > 4_096
      || !Number.isInteger(maxReplayChars) || maxReplayChars < 1_024 || maxReplayChars > 4_000_000) {
      throw new AgentKernelError("dsh_agent_loop_dependencies_invalid");
    }
    this.#createRuntime = createRuntime;
    this.#maxReplayEvents = maxReplayEvents;
    this.#maxReplayChars = maxReplayChars;
  }

  capabilities() {
    return freeze({
      schemaVersion: "dsh-agent-loop-capabilities-v1",
      experimental: true,
      replayFromSessionPort: true,
      adapterPrivateSessionCache: true,
      directProviderAccess: "forbidden_by_adapter_contract",
      defaultEligible: false,
    });
  }

  async *run(input = {}) {
    this.#assertActive();
    const runId = assertIdentifier(input.runId, "dsh_agent_run_invalid");
    const session = normalizeSessionRef(input.session, "dsh_agent_run_invalid");
    const sessionPort = input.sessionPort;
    if (!sessionPort || typeof sessionPort.replay !== "function") {
      throw new AgentKernelError("dsh_agent_session_port_required");
    }
    if (this.#activeRuns.has(runId)) throw new AgentKernelError("dsh_agent_run_already_active");
    const key = sessionKey(session);
    if ([...this.#activeRuns.values()].some((active) => active.sessionKey === key)) {
      throw new AgentKernelError("dsh_agent_session_concurrent_run_forbidden");
    }
    const runtime = await this.#replaceRuntime({ key, session });
    const replay = await replaySessionPort(sessionPort, session, {
      maxEvents: this.#maxReplayEvents,
      maxChars: this.#maxReplayChars,
    });
    const active = { runId, sessionKey: key, runtime, cancelled: false };
    this.#activeRuns.set(runId, active);
    try {
      if (typeof runtime.bindKernelTools === "function") {
        await runtime.bindKernelTools({
          runId,
          session: cloneValue(session, "dsh_agent_run_invalid"),
          executionGrant: input.executionGrant,
          tools: input.tools,
        });
      }
      const stream = runtime.run({
        runId,
        session: cloneValue(session, "dsh_agent_run_invalid"),
        sessionPort,
        replay,
        input: cloneValue(input.input, "dsh_agent_run_invalid"),
        executionGrant: input.executionGrant,
        tools: input.tools,
        signal: input.signal,
        mode: input.mode,
        context: input.context,
      });
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw new AgentKernelError("dsh_agent_stream_invalid");
      }
      for await (const event of stream) {
        if (active.cancelled) break;
        yield normalizeDshEvent(event);
      }
      if (active.cancelled) {
        yield { type: "run.cancelled", modelVisible: false, payload: { code: "dsh_run_cancelled" } };
      }
    } catch (error) {
      if (error instanceof AgentKernelError) throw error;
      const code = safeCode(error?.code, "dsh_runtime_failed");
      throw new AgentKernelError(code);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  async cancel(runId) {
    const normalized = assertIdentifier(runId, "dsh_agent_run_invalid");
    const active = this.#activeRuns.get(normalized);
    if (!active) return freeze({ cancelled: false });
    active.cancelled = true;
    try { await active.runtime.cancel?.(normalized); } catch {}
    return freeze({ cancelled: true });
  }

  async compact(session) {
    this.#assertActive();
    const normalized = normalizeSessionRef(session, "dsh_agent_compaction_invalid");
    const key = sessionKey(normalized);
    const runtime = this.#runtimeBySession.get(key)
      ?? await this.#replaceRuntime({ key, session: normalized });
    if (typeof runtime.compact !== "function") {
      throw new AgentKernelError("dsh_agent_compaction_unavailable");
    }
    return freeze(cloneValue(await runtime.compact(cloneValue(normalized)), "dsh_agent_compaction_invalid"));
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.allSettled([...this.#activeRuns.keys()].map((runId) => this.cancel(runId)));
    this.#activeRuns.clear();
    const runtimes = [...this.#runtimeBySession.values()];
    this.#runtimeBySession.clear();
    await Promise.allSettled(runtimes.map((runtime) => disposeRuntime(runtime)));
  }

  async #replaceRuntime({ key, session }) {
    const previous = this.#runtimeBySession.get(key);
    if (previous) await disposeRuntime(previous);
    let runtime;
    try {
      runtime = await this.#createRuntime({ session: cloneValue(session, "dsh_agent_session_invalid") });
      if (!runtime || typeof runtime.ensure !== "function" || typeof runtime.run !== "function"
        || typeof runtime.dispose !== "function" || runtime.directProductAccess === true) {
        throw new AgentKernelError("dsh_agent_runtime_invalid");
      }
      await runtime.ensure();
    } catch (error) {
      if (error instanceof AgentKernelError) throw error;
      throw new AgentKernelError("dsh_runtime_unavailable");
    }
    this.#runtimeBySession.set(key, runtime);
    return runtime;
  }

  #assertActive() {
    if (this.#disposed) throw new AgentKernelError("dsh_agent_loop_disposed");
  }
}

export function createDshAgentLoopPlugin(options = {}) {
  return new DshAgentLoopPlugin(options);
}

async function replaySessionPort(port, session, { maxEvents, maxChars }) {
  const replay = [];
  let characters = 0;
  for await (const event of port.replay(session)) {
    const line = formatReplayEvent(event);
    if (!line || line.length > maxChars) continue;
    while (replay.length >= maxEvents || characters + line.length > maxChars) {
      const removed = replay.shift();
      characters -= removed.length;
    }
    replay.push(line);
    characters += line.length;
  }
  return replay;
}

function formatReplayEvent(event) {
  if (!event || typeof event !== "object") return null;
  try {
    const serialized = JSON.stringify(event.payload);
    return `[${typeof event.type === "string" ? event.type : "event"}] ${serialized ?? "null"}`.slice(0, 20_000);
  } catch {
    return "[event] [unserializable]";
  }
}

function normalizeDshEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new AgentKernelError("dsh_agent_event_invalid");
  }
  return {
    type: assertIdentifier(event.type, "dsh_agent_event_invalid"),
    modelVisible: event.modelVisible === true,
    payload: cloneValue(event.payload === undefined ? null : event.payload, "dsh_agent_event_invalid"),
  };
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

async function disposeRuntime(runtime) {
  try { await runtime.dispose(); } catch {}
}

function sessionKey(session) {
  return `${session.sessionId}\u0000${session.branchId ?? ""}`;
}
