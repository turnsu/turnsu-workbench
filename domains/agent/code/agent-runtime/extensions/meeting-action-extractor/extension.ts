import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
  MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME,
} from "./binding.mjs";

const ACTION_PATTERN = /\b(action|todo|to-do|follow[- ]?up|will|should|need to)\b/i;

function extractActionItems(transcript: string) {
  const candidates = transcript
    .split(/(?:\r?\n|(?<=[.!?])\s+)/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && ACTION_PATTERN.test(value));
  const unique = [...new Set(candidates)].slice(0, 100);
  return unique.map((text) => ({ text }));
}

export default function registerMeetingActionExtractorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME,
    description: "Extracts explicit follow-up actions from meeting notes without external access.",
    parameters: MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
    execute: async (_toolCallId: string, params: { transcript: string }) => {
      const actionItems = extractActionItems(params.transcript);
      const workflowOutput = {
        actionItems,
        summary: actionItems.length === 0
          ? "No explicit follow-up actions were found."
          : `${actionItems.length} follow-up action${actionItems.length === 1 ? "" : "s"} found.`,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(workflowOutput) }],
        details: { status: "completed", workflowOutput },
      };
    },
  });
}
