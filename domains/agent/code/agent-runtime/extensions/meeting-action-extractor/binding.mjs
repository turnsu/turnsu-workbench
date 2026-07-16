import { Type } from "typebox";

export const MEETING_ACTION_EXTRACTOR_SKILL_ID = "meeting-action-extractor";
export const MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME = "workflow.meeting.extract_actions";

export const MEETING_ACTION_EXTRACTOR_EXECUTION_REF = Object.freeze({
  capabilityId: "meeting-action-extractor",
  taskIntent: "extract_actions",
  adapterVersion: "1",
  executionMode: "deterministic",
});

export const MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA = Type.Object(
  {
    transcript: Type.String({ minLength: 1, maxLength: 20000 }),
  },
  { additionalProperties: false },
);

export const MEETING_ACTION_ITEM_SCHEMA = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA = Type.Object(
  {
    actionItems: Type.Array(MEETING_ACTION_ITEM_SCHEMA, { maxItems: 100 }),
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);

export function registerMeetingActionExtractorExecutor(registry) {
  registry.register({
    executionRef: MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
    internalBinding: {
      skillId: MEETING_ACTION_EXTRACTOR_SKILL_ID,
      toolName: MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME,
      inputSchema: MEETING_ACTION_EXTRACTOR_INPUT_SCHEMA,
      outputSchema: MEETING_ACTION_EXTRACTOR_OUTPUT_SCHEMA,
    },
  });
  return registry;
}
