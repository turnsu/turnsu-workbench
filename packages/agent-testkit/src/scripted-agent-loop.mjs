import { AgentKernelError, AgentLoop } from "../../agent-kernel/src/contracts.mjs";

/** A controlled AgentLoop for cross-kernel conformance. */
export class ScriptedAgentLoop extends AgentLoop {
  #onRun;
  #onCancel;
  #onCompact;
  runs = [];
  cancellations = [];
  compactions = [];

  constructor({ onRun, onCancel = async () => {}, onCompact = async () => ({ compacted: true }) } = {}) {
    super();
    if (typeof onRun !== "function" || typeof onCancel !== "function" || typeof onCompact !== "function") {
      throw new AgentKernelError("scripted_agent_loop_invalid");
    }
    this.#onRun = onRun;
    this.#onCancel = onCancel;
    this.#onCompact = onCompact;
  }

  async *run(input) {
    this.runs.push(input);
    const iterable = await this.#onRun(input);
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      throw new AgentKernelError("scripted_agent_loop_result_invalid");
    }
    yield* iterable;
  }

  async cancel(runId) {
    this.cancellations.push(runId);
    return this.#onCancel(runId);
  }

  async compact(session) {
    this.compactions.push(session);
    return this.#onCompact(session);
  }
}

export function createScriptedAgentLoop(options) {
  return new ScriptedAgentLoop(options);
}

export function waitForAbort(signal) {
  if (!signal || typeof signal.addEventListener !== "function") {
    throw new AgentKernelError("scripted_agent_loop_signal_invalid");
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
