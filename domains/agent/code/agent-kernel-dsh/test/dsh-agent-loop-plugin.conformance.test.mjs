import {
  createMinimalAgentKernel,
} from "../../agent-kernel/src/index.mjs";
import {
  defineAgentKernelConformance,
} from "../../agent-kernel-testkit/src/index.mjs";
import { createDshAgentLoopPlugin } from "../src/index.mjs";

defineAgentKernelConformance({
  name: "DshAgentLoopPlugin compatibility spike",
  createKernel: ({ loop, sessionPort, toolPipeline, profile }) => createMinimalAgentKernel({
    sessionPort,
    toolPipeline,
    profile,
    loop: createDshAgentLoopPlugin({
      createRuntime: async () => ({
        async ensure() {},
        run(input) { return loop.run(input); },
        async cancel(runId) { return loop.cancel(runId); },
        async compact(session) { return loop.compact(session); },
        async dispose() {},
      }),
    }),
  }),
});
