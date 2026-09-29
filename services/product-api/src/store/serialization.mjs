import { createHash } from "node:crypto";

const canonicalize = (value, ancestors) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical_json_requires_finite_numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`canonical_json_unsupported_type:${typeof value}`);
  }
  if (value === undefined) return undefined;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== "object") throw new TypeError("canonical_json_unsupported_value");
  if (ancestors.has(value)) throw new TypeError("canonical_json_circular_value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((entry) => canonicalize(entry, ancestors) ?? "null")
        .join(",")}]`;
    }

    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const serialized = canonicalize(value[key], ancestors);
        return serialized === undefined
          ? []
          : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

export const canonicalJson = (value) => canonicalize(value, new WeakSet());

export const canonicalRequestHash = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

export const canonicalSkillDraftContentHash = (draft) => canonicalRequestHash({
  skillDraftId: draft.skillDraftId,
  skillId: draft.skillId,
  baseVersionId: draft.baseVersionId,
  revision: draft.revision,
  name: draft.name,
  description: draft.description,
  category: draft.category,
  inputSchema: draft.inputSchema,
  outputSchema: draft.outputSchema,
  risk: draft.risk,
  dependencies: draft.dependencies,
  connectionRequirements: draft.connectionRequirements,
  files: draft.files,
});

export const cloneValue = (value) =>
  value === undefined ? undefined : structuredClone(value);

export const withoutFields = (document, fields = []) => {
  if (document === null || document === undefined) return null;
  const omitted = new Set(["_id", ...fields]);
  return cloneValue(
    Object.fromEntries(
      Object.entries(document).filter(([key]) => !omitted.has(key)),
    ),
  );
};

export const withoutWorkflowInternals = (document) =>
  withoutFields(document, ["revisionNumber", "writeVersion"]);
export const withoutSkillInternals = (document) =>
  withoutFields(document, ["workspaceId", "ownerId", "lifecycle"]);
export const withoutRunInternals = (document) =>
  withoutFields(document, [
    "eventSequence",
    "executionPlanSnapshot",
    "executionSnapshot",
    "agentFinalReadModel",
    "skillMaterialBindings",
    "stateModelVersion",
    "stateEventSequence",
    "stateHash",
    "creationCommandId",
    "workspaceId",
    "requestedBy",
  ]);
export const withoutNodeRunInternals = (document) =>
  withoutFields(document, ["executionInput", "executionOutput"]);
export const withoutExecutionPlanInternals = (document) =>
  withoutFields(document, ["planId"]);

export const formatWorkflowEtag = ({
  workflowId,
  writeVersion,
  currentRevisionId,
}) => {
  if (!workflowId || !Number.isInteger(writeVersion) || writeVersion < 1 || !currentRevisionId) {
    throw new TypeError("workflow_etag_requires_internal_write_state");
  }
  return `"wfv1:${workflowId}:${writeVersion}:${currentRevisionId}"`;
};

export const formatSkillDraftEtag = ({ skillDraftId, revision }) => {
  if (!skillDraftId || !Number.isInteger(revision) || revision < 1) {
    throw new TypeError("skill_draft_etag_requires_revision");
  }
  return `"skd1:${skillDraftId}:${revision}"`;
};

export const requestData = (request) =>
  request && typeof request === "object" && request.data && typeof request.data === "object"
    ? request.data
    : request;
