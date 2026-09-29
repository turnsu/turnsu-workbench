import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
  WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
} from "./binding.mjs";

export default function registerWorkflowConformanceExtension(pi: ExtensionAPI) {
  if (process.env.TURNSU_AGENT_TEST_MODE !== "1") return;

  pi.registerTool({
    name: WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
    description: "Test-only deterministic echo used to prove the Workflow to Core to PI execution path.",
    parameters: WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
    execute: async (_toolCallId: string, params: { text: string; delayMs?: number }) => {
      if (params.delayMs) await new Promise((resolve) => setTimeout(resolve, params.delayMs));
      const workflowOutput = {
        echo: params.text,
        charCount: [...params.text].length,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(workflowOutput) }],
        details: {
          status: "completed",
          workflowOutput,
        },
      };
    },
  });
}
