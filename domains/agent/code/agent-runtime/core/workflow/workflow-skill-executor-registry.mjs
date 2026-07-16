import { Check } from "typebox/value";

const EXECUTION_REF_FIELDS = [
  "adapterVersion",
  "capabilityId",
  "executionMode",
  "taskIntent",
];
const BINDING_FIELDS = ["inputSchema", "outputSchema", "skillId", "toolName"];
const REGISTRATION_FIELDS = ["executionRef", "internalBinding"];
const EXECUTION_MODES = new Set(["agent", "deterministic"]);

export function createWorkflowSkillExecutorRegistry(registrations = []) {
  return new WorkflowSkillExecutorRegistry(registrations);
}

export class WorkflowSkillRegistryError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkflowSkillRegistryError";
    this.code = code;
  }
}

export class WorkflowSkillExecutorRegistry {
  #bindings = new Map();

  constructor(registrations = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration) {
    assertExactObject(registration, REGISTRATION_FIELDS, "workflow_registry_invalid_registration");
    const executionRef = normalizeExecutionRef(registration.executionRef);
    const internalBinding = normalizeInternalBinding(registration.internalBinding);
    const key = executionRefKey(executionRef);
    if (this.#bindings.has(key)) {
      throw new WorkflowSkillRegistryError("workflow_registry_duplicate_execution_ref");
    }
    this.#bindings.set(key, Object.freeze({ executionRef, internalBinding }));
    return this;
  }

  resolve(executionRef) {
    return this.#bindings.get(executionRefKey(normalizeExecutionRef(executionRef))) || null;
  }

  acceptsInput(registration, input) {
    return matchesSchema(registration?.internalBinding?.inputSchema, input);
  }

  acceptsOutput(registration, output) {
    return matchesSchema(registration?.internalBinding?.outputSchema, output);
  }

  readKernelOutput(registration, kernelResult) {
    if (kernelResult?.status !== "completed") {
      throw new WorkflowSkillRegistryError("workflow_registry_kernel_execution_failed");
    }
    if (!Object.hasOwn(kernelResult?.details || {}, "workflowOutput")) {
      throw new WorkflowSkillRegistryError("workflow_registry_kernel_output_missing");
    }
    const output = kernelResult.details.workflowOutput;
    if (!this.acceptsOutput(registration, output)) {
      throw new WorkflowSkillRegistryError("workflow_registry_output_schema_mismatch");
    }
    return structuredClone(output);
  }
}

function normalizeExecutionRef(value) {
  assertExactObject(value, EXECUTION_REF_FIELDS, "workflow_registry_invalid_execution_ref");
  const capabilityId = boundedString(value.capabilityId, 128, "workflow_registry_invalid_execution_ref");
  const taskIntent = boundedString(value.taskIntent, 128, "workflow_registry_invalid_execution_ref");
  const adapterVersion = boundedString(value.adapterVersion, 64, "workflow_registry_invalid_execution_ref");
  if (!EXECUTION_MODES.has(value.executionMode)) {
    throw new WorkflowSkillRegistryError("workflow_registry_invalid_execution_ref");
  }
  return Object.freeze({
    capabilityId,
    taskIntent,
    adapterVersion,
    executionMode: value.executionMode,
  });
}

function normalizeInternalBinding(value) {
  assertExactObject(value, BINDING_FIELDS, "workflow_registry_invalid_internal_binding");
  const skillId = boundedString(value.skillId, 128, "workflow_registry_invalid_internal_binding");
  const toolName = boundedString(value.toolName, 256, "workflow_registry_invalid_internal_binding");
  if (!isPlainObject(value.inputSchema) || !isPlainObject(value.outputSchema)) {
    throw new WorkflowSkillRegistryError("workflow_registry_invalid_internal_binding");
  }
  return Object.freeze({
    skillId,
    toolName,
    inputSchema: value.inputSchema,
    outputSchema: value.outputSchema,
  });
}

function executionRefKey(value) {
  return JSON.stringify([
    value.capabilityId,
    value.taskIntent,
    value.adapterVersion,
    value.executionMode,
  ]);
}

function matchesSchema(schema, value) {
  if (!isPlainObject(schema)) {
    throw new WorkflowSkillRegistryError("workflow_registry_invalid_internal_binding");
  }
  try {
    return Check(schema, value);
  } catch {
    throw new WorkflowSkillRegistryError("workflow_registry_invalid_internal_binding");
  }
}

function boundedString(value, maxLength, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value !== value.trim()) {
    throw new WorkflowSkillRegistryError(code);
  }
  return value;
}

function assertExactObject(value, expectedFields, code) {
  if (!isPlainObject(value)) throw new WorkflowSkillRegistryError(code);
  const actualFields = Object.keys(value).sort();
  if (actualFields.length !== expectedFields.length || actualFields.some((field, index) => field !== expectedFields[index])) {
    throw new WorkflowSkillRegistryError(code);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
