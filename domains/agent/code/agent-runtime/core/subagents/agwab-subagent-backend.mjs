const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function createAgwaSubagentBackend({
  api = null,
  cwd,
  runsDir = ".pi/product-agent-runs",
  providerProbe = async () => ({ ready: false, reason: "provider_unavailable" }),
} = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("agwab_subagent_cwd_required");
  const active = new Map();
  let loadedApi = api;
  const getApi = async () => {
    loadedApi ??= await import("@agwab/pi-subagent/api");
    return loadedApi;
  };

  return {
    async execute({ request, signal, emit }) {
      const provider = await providerProbe({ request });
      if (provider?.ready !== true) throw backendError("provider_unavailable", "Agent provider is unavailable.", "blocked");
      const runtime = await getApi();
      const model = request.metadata?.model ?? provider.model;
      if (typeof model !== "string" || model.length === 0) {
        throw backendError("model_configuration_missing", "Agent model configuration is missing.", "blocked");
      }
      await emit?.("agwab.subagent.launching", { backend: "pi-subagent" });
      const launch = await runtime.runSubagent({
        backend: "headless",
        cwd,
        runsDir,
        task: request.goal,
        roleContext: safeString(request.metadata?.roleContext),
        agentScope: "global",
        confirmProjectAgents: false,
        model,
        thinking: normalizeThinking(request.metadata?.thinking),
        tools: [...request.capabilities.toolAllowlist],
        skills: safeStringArray(request.metadata?.skillPaths),
        extensions: [],
        timeoutMs: request.limits.timeoutMs,
        correlationId: request.invocationId,
        async: true,
        onComplete: "detach",
        signal,
      });
      if (!launch?.runId) throw backendError("agwab_launch_invalid", "Subagent launch did not return a run reference.");
      active.set(request.invocationId, { runId: launch.runId, runtime });
      try {
        const snapshot = TERMINAL.has(launch.status)
          ? launch
          : await waitForSubagent({ runtime, runId: launch.runId, cwd, runsDir, timeoutMs: request.limits.timeoutMs, signal });
        const logs = await runtime.getSubagentLogs({ cwd, runsDir, runId: launch.runId }).catch(() => null);
        const status = normalizeSubagentStatus(snapshot?.status);
        const output = parseBoundedOutput(logs?.logText?.output);
        await emit?.("agwab.subagent.completed", { status });
        return {
          status,
          output,
          summary: safeSummary(status, logs?.logText?.stderr),
          evidence: [{ kind: "agwab_output", ref: `agwab-subagent:${launch.runId}:output` }],
          usage: usageFrom(snapshot?.metadata?.usage ?? logs?.metadata?.usage, request, output),
        };
      } finally {
        active.delete(request.invocationId);
      }
    },
    async cancel({ invocationId, reason }) {
      const run = active.get(invocationId);
      if (!run) return { status: "not_running" };
      return run.runtime.interruptSubagent({ cwd, runsDir, runId: run.runId, reason: safeString(reason) ?? "product_cancelled" });
    },
    async reconcile({ runId }) {
      const runtime = await getApi();
      return runtime.reconcileSubagentRun({ cwd, runsDir, runId });
    },
  };
}

async function waitForSubagent({ runtime, runId, cwd, runsDir, timeoutMs, signal }) {
  if (signal?.aborted) throw signal.reason ?? backendError("execution_cancelled", "Execution cancelled.", "cancelled");
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => {
      void runtime.interruptSubagent({ cwd, runsDir, runId, reason: "product_cancelled" }).catch(() => {});
      reject(signal.reason ?? backendError("execution_cancelled", "Execution cancelled.", "cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const waited = await Promise.race([
      runtime.waitForSubagent({ cwd, runsDir, runId, timeoutMs, pollIntervalMs: 100 }),
      aborted,
    ]);
    if (waited?.outcome === "timeout") {
      await runtime.interruptSubagent({ cwd, runsDir, runId, reason: "product_timeout" }).catch(() => {});
      throw backendError("execution_timeout", "Subagent execution timed out.", "timeout");
    }
    return waited?.snapshot;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function parseBoundedOutput(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { text: text.slice(0, 100_000) };
  }
}

function usageFrom(value, request, output) {
  const usage = value && typeof value === "object" ? value : {};
  return {
    steps: Math.min(Math.max(Number(usage.steps ?? 1), 0), request.limits.maxSteps),
    modelRequests: Math.min(Math.max(Number(usage.modelRequests ?? 1), 0), request.limits.maxModelRequests),
    inputBytes: Buffer.byteLength(JSON.stringify(request.input), "utf8"),
    outputBytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
  };
}

function normalizeSubagentStatus(status) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function safeSummary(status, stderr) {
  if (status === "completed") return "Bounded Agent completed.";
  if (status === "cancelled") return "Bounded Agent cancelled.";
  return typeof stderr === "string" && stderr.trim() ? "Bounded Agent failed; diagnostic artifact retained." : "Bounded Agent failed.";
}

function safeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 8000) : undefined;
}

function safeStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0).slice(0, 64) : [];
}

function normalizeThinking(value) {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value) ? value : "medium";
}

function backendError(code, message, status = "failed") {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
