import { useCallback, useEffect, useReducer, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { workbenchApi } from "../../api/client.js";
import { workbenchKeys } from "../../api/queryKeys.js";
import {
  createRunStreamState,
  runEventReceived,
  runReadModelRefreshed,
  runStreamConnected,
  runStreamConnectionStarted,
  runStreamDisconnected,
  runStreamReducer,
  selectRunEventCursor,
  selectRunStream,
} from "./runStreamState.js";

export function useRunStream(runId) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(runStreamReducer, undefined, createRunStreamState);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const cursor = selectRunEventCursor(state, runId);
  const reconnect = useCallback(() => setConnectionAttempt((attempt) => attempt + 1), []);

  useEffect(() => {
    if (!runId) return undefined;
    dispatch(runStreamConnectionStarted(runId));
    let source;
    const handleOffline = () => dispatch(runStreamDisconnected(runId, {
      reason: "browser_offline",
      retryable: true,
    }));
    const handleOnline = () => reconnect();
    globalThis.addEventListener?.("offline", handleOffline);
    globalThis.addEventListener?.("online", handleOnline);
    source = workbenchApi.openRunEventStream(runId, {
      after: cursor,
      onOpen: () => dispatch(runStreamConnected(runId)),
      onError: () => dispatch(runStreamDisconnected(runId, {
        reason: globalThis.navigator?.onLine === false ? "browser_offline" : "run_stream_disconnected",
        retryable: true,
      })),
      onEvent: (event) => {
        dispatch(runEventReceived(event));
        const terminal = ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
        if (terminal) {
          source?.close();
          queryClient.invalidateQueries({ queryKey: workbenchKeys.runs(event.workflowId) });
        }
        if (["review.requested", "run.paused", "run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          queryClient.invalidateQueries({ queryKey: workbenchKeys.run(runId) })
            .finally(() => dispatch(runReadModelRefreshed(runId)));
        }
      },
    });
    return () => {
      globalThis.removeEventListener?.("offline", handleOffline);
      globalThis.removeEventListener?.("online", handleOnline);
      source?.close();
    };
  }, [runId, queryClient, connectionAttempt, reconnect]);

  const stream = selectRunStream(state, runId);
  return stream ? { ...stream, reconnect } : null;
}
