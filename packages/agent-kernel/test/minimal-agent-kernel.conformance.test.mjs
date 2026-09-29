import { createMinimalAgentKernel } from "../src/index.mjs";
import { defineAgentKernelConformance } from "../../agent-testkit/src/index.mjs";

defineAgentKernelConformance({
  name: "MinimalAgentKernel",
  createKernel: (options) => createMinimalAgentKernel(options),
});
