const TERMINAL_WORKFLOW = new Set(["completed", "failed", "interrupted", "blocked"]);

export function createAgwaWorkflowBackend({
  api = null,
  cwd,
  providerProbe = async () => ({ ready: false, reason: "provider_unavailable" }),
} = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("agwab_workflow_cwd_required");
  const active = new Map();
  let loadedApi = api;
  const getApi = async () => {
    loadedApi ??= await import("@agwab/pi-workflow");
    return loadedApi;
  };

  return {
    async execute({ request, signal, emit }) {
      if (!safeString(request.metadata?.outerNodeId)) {
        throw backendError("orchestrator_outer_node_required", "Dynamic orchestration must remain inside one pinned outer node.", "blocked");
      }
      const provider = await providerProbe({ request });
      if (provider?.ready !== true) throw backendError("provider_unavailable", "Agent provider is unavailable.", "blocked");
      const runtime = await getApi();
      await emit?.("agwab.workflow.launching", { outerNodeId: request.metadata.outerNodeId });
      const run = await startOrRecoverRun({ runtime, request, cwd, provider });
      if (!run?.runId) throw backendError("agwab_workflow_launch_invalid", "Workflow launch did not return a run reference.");
      active.set(request.invocationId, { runId: run.runId, runtime });
      const abort = () => { void runtime.stopRun(cwd, run.runId).catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const finalRun = TERMINAL_WORKFLOW.has(run.status)
          ? run
          : await runtime.waitForRun(cwd, run.runId, request.limits.timeoutMs);
        if (signal?.aborted) throw signal.reason ?? backendError("execution_cancelled", "Execution cancelled.", "cancelled");
        const status = normalizeWorkflowStatus(finalRun.status, finalRun.degradation);
        const children = (finalRun.tasks ?? []).slice(0, request.limits.maxChildren).map((task) => productChild(task, request));
        for (const child of children) {
          await emit?.("agwab.workflow.child", { childRef: child.childRef, status: child.status });
        }
        const output = projectFinalOutput(finalRun, request.resultSchema);
        const nextLoopProposal = request.metadata?.allowReusableProposal === true ? {
          kind: "loop_revision_proposal",
          sourceInvocationId: request.invocationId,
          childGoals: children.map((child) => child.goal),
        } : null;
        return {
          status,
          output,
          summary: status === "completed" ? "Agent orchestration completed inside the pinned outer node." : "Agent orchestration did not complete cleanly.",
          evidence: [{ kind: "agwab_workflow", ref: `agwab-workflow:${run.runId}` }],
          usage: rollupUsage(children, request, output),
          children,
          outerGraphChanged: false,
          nextLoopProposal,
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        active.delete(request.invocationId);
      }
    },
    async cancel({ invocationId }) {
      const run = active.get(invocationId);
      if (!run) return { status: "not_running" };
      return run.runtime.stopRun(cwd, run.runId);
    },
    async resume({ runId, timeoutMs = 60_000 }) {
      const runtime = await getApi();
      const current = await runtime.refreshRun(cwd, runId);
      if (current.status === "completed") return current;
      if (["failed", "interrupted", "blocked"].includes(current.status)) await runtime.resumeRun(cwd, runId);
      return runtime.waitForRun(cwd, runId, timeoutMs);
    },
  };
}

async function startOrRecoverRun({ runtime, request, cwd, provider }) {
  const resumeRunId = safeString(request.metadata?.resumeRunId);
  if (!resumeRunId) {
    return runtime.runDynamicTask(cwd, {
      task: request.goal,
      runId: safeString(request.metadata?.agwaRunId),
      runtimeOverrides: {
        model: safeString(request.metadata?.model) ?? safeString(provider?.model),
        thinking: normalizeThinking(request.metadata?.thinking),
        tools: [...request.capabilities.toolAllowlist],
        maxConcurrency: request.limits.maxChildren,
        maxRuntimeMs: request.limits.timeoutMs,
        approvalMode: "non-interactive",
        worktreePolicy: "off",
      },
    });
  }
  const current = await runtime.refreshRun(cwd, resumeRunId);
  if (current.status === "completed" || current.status === "running") return current;
  if (["failed", "interrupted", "blocked"].includes(current.status)) {
    const resumed = await runtime.resumeRun(cwd, resumeRunId);
    return resumed.run;
  }
  return current;
}

function productChild(task, request) {
  const status = normalizeTaskStatus(task.status);
  const usage = task.usage ?? {};
  return {
    childRef: String(task.taskId || task.specId || "agwab-task").slice(0, 128),
    goal: String(task.displayName || task.specId || "AgwaB workflow task").slice(0, 8000),
    status,
    output: {
      taskRef: String(task.specId || task.taskId || "task").slice(0, 128),
      status: task.status,
      summary: safeString(task.lastMessage)?.slice(0, 2000) ?? "Task finished.",
    },
    summary: status === "completed" ? "Orchestrator child completed." : `Orchestrator child ${status}.`,
    evidence: [{ kind: "agwab_task_output", ref: `agwab-task:${String(task.taskId || "task").slice(0, 128)}:output` }],
    usage: {
      steps: 1,
      modelRequests: task.status === "skipped" ? 0 : 1,
      inputBytes: 0,
      outputBytes: Buffer.byteLength(String(task.lastMessage || ""), "utf8"),
    },
    capabilities: structuredClone(request.capabilities),
  };
}

function rollupUsage(children, request, output) {
  return {
    steps: Math.min(children.reduce((sum, child) => sum + child.usage.steps, 0), request.limits.maxSteps),
    modelRequests: Math.min(children.reduce((sum, child) => sum + child.usage.modelRequests, 0), request.limits.maxModelRequests),
    inputBytes: Buffer.byteLength(JSON.stringify(request.input), "utf8"),
    outputBytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
  };
}

function projectFinalOutput(run, resultSchema) {
  const terminal = [...(run.tasks ?? [])].reverse().find((task) => task.status === "completed" && safeString(task.lastMessage));
  const text = safeString(terminal?.lastMessage) ?? "Agent orchestration completed.";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  const required = Array.isArray(resultSchema?.required) ? resultSchema.required : [];
  const properties = resultSchema?.properties && typeof resultSchema.properties === "object" ? resultSchema.properties : {};
  if (required.length === 1 && properties[required[0]]?.type === "string") return { [required[0]]: text };
  return { workflowStatus: run.status, taskSummary: safeTaskSummary(run.taskSummary) };
}

function normalizeWorkflowStatus(status, degradation) {
  if (status === "completed") return degradation ? "partial" : "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "blocked") return "blocked";
  return "failed";
}

function normalizeTaskStatus(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "cancelled";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "partial";
  return "failed";
}

function safeTaskSummary(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(["pending", "running", "blocked", "completed", "failed", "skipped", "interrupted", "total"]
    .map((key) => [key, Math.max(0, Number(source[key] ?? 0))]));
}

function safeString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 8000) : undefined;
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
