import { createMinimalAgentKernel } from "../src/index.mjs";
import { defineAgentKernelConformance } from "../../agent-kernel-testkit/src/index.mjs";

defineAgentKernelConformance({
  name: "MinimalAgentKernel",
  createKernel: (options) => createMinimalAgentKernel(options),
});
