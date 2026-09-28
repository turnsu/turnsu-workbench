import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the real query timer in its browser mode, without a DOM renderer.
globalThis.window = {};
const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
const { agentSessionRefetchInterval } = await import("../src/api/queries.js");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const states = [
  { taskStatus: "queued", activeTurnId: null },
  { taskStatus: "running", activeTurnId: "turn-1" },
  { taskStatus: "completed", activeTurnId: null },
];
let calls = 0;
const observer = new QueryObserver(client, {
  queryKey: ["private-session", "session-1"],
  queryFn: async () => ({ data: states[Math.min(calls++, states.length - 1)] }),
  refetchInterval: agentSessionRefetchInterval,
});
let unsubscribe;
let deadline;
try {
  await new Promise((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("queued session never refreshed to completion")), 4_000);
    unsubscribe = observer.subscribe((result) => {
      if (result.data?.data?.taskStatus === "completed") resolve();
    });
  });
  clearTimeout(deadline);
  assert.equal(calls, 3);
  await delay(1_100);
  assert.equal(calls, 3, "terminal session should stop polling");
  console.log("agent_session_polling_smoke:ok");
} finally {
  clearTimeout(deadline);
  unsubscribe?.();
  observer.destroy();
  client.clear();
  delete globalThis.window;
}
