export const BUILTIN_AGENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    schemaVersion: "workbench-v1",
    definitionId: "main",
    kind: "main",
    label: "Main Agent",
    description: "Coordinates the user's work in one workspace and receives explicit module handoffs.",
    objectKinds: [],
    canHandoffToMain: false,
  }),
  Object.freeze({
    schemaVersion: "workbench-v1",
    definitionId: "skill_creator",
    kind: "module",
    label: "Skill Creator",
    description: "Creates structured Skill Draft proposals on a user-owned temporary branch.",
    objectKinds: ["skill_draft"],
    canHandoffToMain: true,
  }),
  Object.freeze({
    schemaVersion: "workbench-v1",
    definitionId: "loop_creator",
    kind: "module",
    label: "Loop Creator",
    description: "Creates structured Loop revision proposals on a user-owned temporary branch.",
    objectKinds: ["workflow"],
    canHandoffToMain: true,
  }),
]);

const byId = new Map(BUILTIN_AGENT_DEFINITIONS.map((definition) => [definition.definitionId, definition]));

export function getBuiltinAgentDefinition(definitionId) {
  const definition = byId.get(definitionId);
  return definition ? structuredClone(definition) : null;
}

export function listBuiltinAgentDefinitions() {
  return BUILTIN_AGENT_DEFINITIONS.map((definition) => structuredClone(definition));
}
