import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  getUploadedSkillExecutionPort,
  UPLOADED_SKILL_INTERNAL_TOOL_NAME,
  UPLOADED_SKILL_TOOL_INPUT_SCHEMA,
} from "./binding.mjs";

type UploadedSkillToolParams = {
  workspaceId: string;
  executionRef: {
    capabilityId: string;
    taskIntent: "execute";
    adapterVersion: "1";
    executionMode: "deterministic";
  };
  input: Record<string, unknown>;
};

export default function registerUploadedSkillExecutorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: UPLOADED_SKILL_INTERNAL_TOOL_NAME,
    description: "Executes one validated workspace Skill package through the isolated runtime.",
    parameters: UPLOADED_SKILL_TOOL_INPUT_SCHEMA,
    execute: async (
      _toolCallId: string,
      params: UploadedSkillToolParams,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      _context?: unknown,
    ) => {
      const workflowOutput = await getUploadedSkillExecutionPort().executePublished({
        workspaceId: params.workspaceId,
        executionRef: params.executionRef,
        input: params.input,
        signal,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(workflowOutput) }],
        details: { status: "completed", workflowOutput },
      };
    },
  });
}
