import { useEffect } from "react";

import { canCancelRun, isTerminalRunStatus } from "../../api/client.js";
import {
  useRunExecutionEventsQuery,
  useRunInvocationsQuery,
  useRunQuery,
  useWorkbenchMutations,
} from "../../api/queries.js";

function idempotencyKey() {
  return `cancel-loop-task-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function useLoopTaskRun(session, enabled = true) {
  const runId = session?.source?.kind === "loop_run" ? session.source.runId : "";
  const run = useRunQuery(runId, enabled);
  const detail = run.data?.data || null;
  const status = detail?.run?.status || "";
  const pollWhileRunActive = Boolean(runId) && !isTerminalRunStatus(status);
  const invocations = useRunInvocationsQuery(runId, enabled, { pollWhileRunActive });
  const executionEvents = useRunExecutionEventsQuery(
    runId,
    { after: 0, limit: 100 },
    enabled,
    { pollWhileRunActive },
  );
  const mutations = useWorkbenchMutations();

  useEffect(() => {
    if (!runId || !isTerminalRunStatus(status)) return;
    // Capture the final invocation/artifact and event written in the same
    // terminal transition before stopping background polling.
    invocations.refetch();
    executionEvents.refetch();
  }, [executionEvents.refetch, invocations.refetch, runId, status]);

  return {
    runId,
    detail,
    invocations: invocations.data?.data || [],
    executionEvents: executionEvents.data?.data || [],
    loading: Boolean(runId) && run.isLoading,
    error: run.error || null,
    detailsError: invocations.error || executionEvents.error || null,
    terminal: isTerminalRunStatus(status),
    cancelling: mutations.cancelRun.isPending,
    retry() {
      return Promise.all([run.refetch(), invocations.refetch(), executionEvents.refetch()]);
    },
    cancel(reason) {
      if (!runId || !canCancelRun(status)) return null;
      return mutations.cancelRun.mutateAsync({
        runId,
        data: { reason },
        idempotencyKey: idempotencyKey(),
      });
    },
  };
}
