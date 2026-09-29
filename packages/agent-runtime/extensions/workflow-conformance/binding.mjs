import { Type } from "typebox";

export const WORKFLOW_CONFORMANCE_SKILL_ID = "workflow-conformance";
export const WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME = "workflow.conformance.echo";

export const WORKFLOW_CONFORMANCE_EXECUTION_REF = Object.freeze({
  capabilityId: "workflow-conformance",
  taskIntent: "echo",
  adapterVersion: "1",
  executionMode: "deterministic",
});

export const WORKFLOW_CONFORMANCE_INPUT_SCHEMA = Type.Object(
  {
    text: Type.String({ maxLength: 10000 }),
    delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
  },
  { additionalProperties: false },
);

export const WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA = Type.Object(
  {
    echo: Type.String({ maxLength: 10000 }),
    charCount: Type.Integer({ minimum: 0, maximum: 10000 }),
  },
  { additionalProperties: false },
);

export function registerWorkflowConformanceExecutor(registry, { env = process.env } = {}) {
  if (String(env.TURNSU_AGENT_TEST_MODE || "") !== "1") {
    throw new Error("workflow_conformance_test_mode_required");
  }
  registry.register({
    executionRef: WORKFLOW_CONFORMANCE_EXECUTION_REF,
    internalBinding: {
      skillId: WORKFLOW_CONFORMANCE_SKILL_ID,
      toolName: WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
      inputSchema: WORKFLOW_CONFORMANCE_INPUT_SCHEMA,
      outputSchema: WORKFLOW_CONFORMANCE_OUTPUT_SCHEMA,
    },
  });
  return registry;
}
