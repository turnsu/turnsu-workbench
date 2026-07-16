import { Type } from "typebox";

export const UPLOADED_SKILL_INTERNAL_TOOL_NAME = "workflow.uploaded_skill.execute";

export const UPLOADED_SKILL_EXECUTION_REF_SCHEMA = Type.Object(
  {
    capabilityId: Type.String({ pattern: "^uploaded-[a-f0-9]{48}$" }),
    taskIntent: Type.Literal("execute"),
    adapterVersion: Type.Literal("1"),
    executionMode: Type.Literal("deterministic"),
  },
  { additionalProperties: false },
);

export const UPLOADED_SKILL_TOOL_INPUT_SCHEMA = Type.Object(
  {
    workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    executionRef: UPLOADED_SKILL_EXECUTION_REF_SCHEMA,
    input: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);

let installedExecutionPort = null;

export function installUploadedSkillExecutionPort(port) {
  if (typeof port?.executePublished !== "function") {
    throw new TypeError("uploaded_skill_execution_port_invalid");
  }
  installedExecutionPort = port;
  return () => {
    if (installedExecutionPort === port) installedExecutionPort = null;
  };
}

export function getUploadedSkillExecutionPort() {
  if (!installedExecutionPort) {
    const error = new Error("uploaded_skill_execution_port_unavailable");
    error.code = "uploaded_skill_execution_port_unavailable";
    throw error;
  }
  return installedExecutionPort;
}

export function isUploadedExecutionRef(value) {
  const fields = ["capabilityId", "taskIntent", "adapterVersion", "executionMode"];
  return Boolean(
    value
    && typeof value === "object"
    && /^uploaded-[a-f0-9]{48}$/.test(value.capabilityId || "")
    && value.taskIntent === "execute"
    && value.adapterVersion === "1"
    && value.executionMode === "deterministic"
    && Object.keys(value).every((key) => fields.includes(key)),
  );
}
