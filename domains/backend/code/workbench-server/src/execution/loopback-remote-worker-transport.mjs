import {
  RemoteWorkerTransport,
  remoteBackendUnavailable,
  remoteTransportDisconnected,
} from "./remote-worker-transport.mjs";

export class LoopbackRemoteWorkerTransport extends RemoteWorkerTransport {
  #available;
  #scenarioFactory;
  #sequence = 0;
  #executions = new Map();

  constructor({ available = true, scenarioFactory = defaultScenario } = {}) {
    super();
    if (typeof available !== "boolean" || typeof scenarioFactory !== "function") {
      throw new TypeError("loopback_remote_transport_options_invalid");
    }
    this.#available = available;
    this.#scenarioFactory = scenarioFactory;
    this.calls = {
      probe: [], dispatch: [], streamEvents: [], checkpoint: [], cancel: [], resume: [], dispose: [],
    };
  }

  async probe(input = {}) {
    this.calls.probe.push(safeCall(input));
    return { available: this.#available };
  }

  async dispatch({ request, lease } = {}) {
    this.calls.dispatch.push(safeCall({ request, lease }));
    if (!this.#available) throw remoteBackendUnavailable();
    const remoteExecutionId = `loopback-${++this.#sequence}`;
    const scenario = await this.#scenarioFactory(structuredClone(request), structuredClone(lease));
    if (!scenario || !Array.isArray(scenario.streams) || scenario.streams.length === 0) {
      throw new TypeError("loopback_remote_scenario_invalid");
    }
    this.#executions.set(remoteExecutionId, {
      remoteExecutionId,
      scenario,
      streamIndex: 0,
      cancelled: false,
      disposed: false,
    });
    return { remoteExecutionId };
  }

  streamEvents({ remoteExecutionId, afterSequence = 0, signal } = {}) {
    this.calls.streamEvents.push(safeCall({ remoteExecutionId, afterSequence }));
    const execution = this.#execution(remoteExecutionId);
    const source = execution.scenario.streams[execution.streamIndex] ?? [];
    return streamScenario(source, { execution, signal });
  }

  async checkpoint({ remoteExecutionId, afterSequence = 0 } = {}) {
    this.calls.checkpoint.push(safeCall({ remoteExecutionId, afterSequence }));
    this.#execution(remoteExecutionId);
    return { cursor: afterSequence };
  }

  async cancel({ remoteExecutionId, reason } = {}) {
    this.calls.cancel.push(safeCall({ remoteExecutionId, reason }));
    const execution = this.#execution(remoteExecutionId);
    execution.cancelled = true;
    return { cancelled: true };
  }

  async resume({ remoteExecutionId, afterSequence = 0, checkpoint } = {}) {
    this.calls.resume.push(safeCall({ remoteExecutionId, afterSequence, checkpoint }));
    const execution = this.#execution(remoteExecutionId);
    execution.streamIndex += 1;
    if (execution.streamIndex >= execution.scenario.streams.length) throw remoteBackendUnavailable();
    return { remoteExecutionId };
  }

  async dispose({ remoteExecutionId } = {}) {
    this.calls.dispose.push(safeCall({ remoteExecutionId }));
    const execution = this.#executions.get(remoteExecutionId);
    if (execution) execution.disposed = true;
    return { disposed: Boolean(execution) };
  }

  #execution(remoteExecutionId) {
    const execution = this.#executions.get(remoteExecutionId);
    if (!execution) throw remoteBackendUnavailable();
    return execution;
  }
}

async function* streamScenario(source, { execution, signal }) {
  for (const entry of source) {
    if (signal?.aborted || execution.cancelled) throw signal?.reason ?? new Error("remote_execution_cancelled");
    if (entry?.disconnect === true) throw remoteTransportDisconnected();
    if (entry?.waitForCancel === true) {
      await waitForAbort(signal, execution);
      throw signal?.reason ?? new Error("remote_execution_cancelled");
    }
    yield structuredClone(entry);
  }
}

function defaultScenario(request) {
  return {
    streams: [[{
      eventId: "loopback-result-1",
      sequence: 1,
      type: "execution.result",
      payload: {},
      result: {
        output: structuredClone(request.input),
        summary: "Loopback remote execution completed.",
        evidence: [],
        usage: {
          steps: request.mode === "deterministic_skill" ? 1 : Math.min(1, request.limits.maxSteps),
          modelRequests: 0,
          inputBytes: byteLength(request.input),
          outputBytes: byteLength(request.input),
        },
      },
    }]],
  };
}

function waitForAbort(signal, execution) {
  if (signal?.aborted || execution.cancelled) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
}

function safeCall(value) {
  const cloned = structuredClone(value);
  if (cloned?.lease) cloned.lease = { ...cloned.lease, capabilities: structuredClone(cloned.lease.capabilities) };
  return cloned;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
