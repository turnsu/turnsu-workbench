import { createHash } from "node:crypto";

const TERMINAL_WORKFLOW = new Set(["completed", "failed", "interrupted", "blocked"]);
const MAX_SUBAGENT_SESSION_ID_LENGTH = 64;

export function createAgwaWorkflowBackend({
  api = null,
  cwd,
  pollIntervalMs = 100,
  providerProbe = async () => ({ ready: false, reason: "provider_unavailable" }),
} = {}) {
  if (typeof cwd !== "string" || cwd.length === 0) throw new TypeError("agwab_workflow_cwd_required");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 10_000) {
    throw new TypeError("agwab_workflow_poll_interval_invalid");
  }
  const active = new Map();
  let loadedApi = api;
  const getApi = async () => {
    loadedApi ??= await import("@agwab/pi-workflow");
    return loadedApi;
  };

  return {
    async execute({ request, signal, emit, reportChild }) {
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
      const observed = new Map();
      const observe = (snapshot) => observeWorkflowChildren({ snapshot, request, reportChild, observed });
      const monitorController = new AbortController();
      let monitor = null;
      let monitorError = null;
      try {
        await observe(run);
        if (!TERMINAL_WORKFLOW.has(run.status) && typeof reportChild === "function") {
          monitor = monitorWorkflowChildren({
            runtime, cwd, runId: run.runId, request, reportChild, observed,
            signal: monitorController.signal, pollIntervalMs,
          }).catch((error) => { monitorError = error; });
        }
        const finalRun = TERMINAL_WORKFLOW.has(run.status)
          ? run
          : await runtime.waitForRun(cwd, run.runId, request.limits.timeoutMs);
        if (signal?.aborted) throw signal.reason ?? backendError("execution_cancelled", "Execution cancelled.", "cancelled");
        monitorController.abort();
        await monitor;
        if (monitorError && monitorError.code !== "agwab_child_monitor_stopped") throw monitorError;
        await observe(finalRun);
        const status = normalizeWorkflowStatus(finalRun.status, finalRun.degradation);
        const children = (finalRun.tasks ?? []).slice(0, request.limits.maxChildren)
          .map((task) => productChild(task, request, finalRun.runId));
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
          evidence: [],
          workerTranscript: {
            mediaType: "application/json",
            content: JSON.stringify({
              schemaVersion: "worker-transcript-v1",
              backend: "pi-workflow",
              runId: run.runId,
              finalRun,
            }),
          },
          usage: rollupUsage(children, request, output),
          children,
          outerGraphChanged: false,
          nextLoopProposal,
        };
      } finally {
        monitorController.abort();
        await monitor;
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
        maxConcurrency: Math.max(
          1,
          Math.min(
            request.limits.maxChildren,
            Number(request.metadata?.admittedChildConcurrency ?? 0),
          ),
        ),
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

function productChild(task, request, runId) {
  const status = normalizeTaskStatus(task.status);
  const usage = task.usage ?? {};
  const taskRef = String(task.taskId || task.specId || "agwab-task").slice(0, 128);
  return {
    childRef: productChildRef(task, runId, taskRef),
    role: String(task.role || task.specId || "worker").slice(0, 128),
    goal: String(task.displayName || task.specId || "AgwaB workflow task").slice(0, 8000),
    status,
    output: {
      taskRef,
      status: task.status,
      summary: safeString(task.lastMessage)?.slice(0, 2000) ?? "Task finished.",
    },
    summary: status === "completed" ? "Orchestrator child completed." : `Orchestrator child ${status}.`,
    evidence: [],
    usage: {
      steps: 1,
      modelRequests: task.status === "skipped" ? 0 : 1,
      inputBytes: 0,
      outputBytes: Buffer.byteLength(String(task.lastMessage || ""), "utf8"),
    },
    capabilities: structuredClone(request.capabilities),
  };
}

async function observeWorkflowChildren({ snapshot, request, reportChild, observed }) {
  if (typeof reportChild !== "function") return;
  const children = (snapshot?.tasks ?? []).slice(0, request.limits.maxChildren)
    .map((task) => productChild(task, request, snapshot?.runId));
  for (const child of children) {
    const signature = JSON.stringify([child.status, child.output.status, child.output.summary, child.usage]);
    if (observed.get(child.childRef) === signature) continue;
    await reportChild({
      ...child,
      checkpoint: {
        agwaRunId: String(snapshot.runId).slice(0, 128),
        taskRef: child.output.taskRef,
        status: child.status,
      },
    });
    observed.set(child.childRef, signature);
  }
}

function productChildRef(task, runId, taskRef) {
  const persisted = safeString(task.backendHandle?.sessionId) ?? safeString(task.backendFiles?.sessionId);
  if (persisted) return persisted.slice(0, 128);
  if (task.artifactGraph?.enabled !== true || !safeString(runId)) return taskRef;
  const sanitized = `pi-workflow.${runId}.${taskRef}`.replace(/[^A-Za-z0-9._-]/g, "-");
  if (sanitized.length <= MAX_SUBAGENT_SESSION_ID_LENGTH) return sanitized;
  const digest = createHash("sha256").update(sanitized).digest("hex").slice(0, 16);
  const suffix = sanitized.split(".").at(-1) || "session";
  const prefix = `piwf.${digest}`;
  const maxSuffixLength = MAX_SUBAGENT_SESSION_ID_LENGTH - prefix.length - 1;
  return `${prefix}.${suffix.slice(-Math.max(1, maxSuffixLength))}`;
}

async function monitorWorkflowChildren({ runtime, cwd, runId, request, reportChild, observed, signal, pollIntervalMs }) {
  while (!signal.aborted) {
    await delay(pollIntervalMs, signal);
    if (signal.aborted) break;
    const snapshot = await runtime.refreshRun(cwd, runId);
    await observeWorkflowChildren({ snapshot, request, reportChild, observed });
    if (TERMINAL_WORKFLOW.has(snapshot.status)) return;
  }
  throw backendError("agwab_child_monitor_stopped", "AgwaB child monitoring stopped.", "cancelled");
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
  if (["pending", "running", "launching"].includes(status)) return "running";
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
