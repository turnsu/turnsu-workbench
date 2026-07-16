import { createHash } from "node:crypto";

import {
  Check,
  PortableLoopPackageV1Schema,
} from "@looloomi/workbench-contracts";

import { parseStrictJson } from "../validation/strict-json-parser.mjs";

const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const EMBEDDED_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "application/json"]);

export const PORTABLE_LOOP_PACKAGE_MEDIA_TYPE = "application/vnd.looloomi.loop-package+json";

export class PortableLoopPackageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PortableLoopPackageError";
    this.code = code;
  }
}

export function formatPortableLoopPackage(value) {
  assertPortablePackage(value);
  return Buffer.from(`${JSON.stringify(sortValue(value))}\n`, "utf8");
}

export function parsePortableLoopPackage(value, { maxBytes = MAX_PACKAGE_BYTES } = {}) {
  const bytes = asBuffer(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("loop_package_limit_invalid");
  if (bytes.byteLength > maxBytes) {
    throw new PortableLoopPackageError("loop_package_too_large", "The Loop package exceeds the allowed size.");
  }

  let parsed;
  try {
    parsed = parseStrictJson(bytes.toString("utf8"));
  } catch {
    throw new PortableLoopPackageError("loop_package_invalid", "The Loop package could not be read.");
  }
  assertPortablePackage(parsed);
  if (!formatPortableLoopPackage(parsed).equals(bytes)) {
    throw new PortableLoopPackageError("loop_package_not_canonical", "The Loop package is not in canonical form.");
  }
  return deepFreeze(structuredClone(parsed));
}

export function hashPortableLoopPackage(value) {
  const bytes = isPlainObject(value) ? formatPortableLoopPackage(value) : asBuffer(value);
  return hashBytes(bytes);
}

export const portableLoopPackageContentHash = hashPortableLoopPackage;

export function portableLoopPackageFilename(name) {
  if (typeof name !== "string") throw new TypeError("loop_package_name_required");
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 180) || "loop";
  return `${base}.loop.json`;
}

export const formatPortableLoopPackageFilename = portableLoopPackageFilename;

export async function projectPortableLoopPackage({
  workflow,
  revision,
  resolveSkillVersion,
  resolveMaterial,
  embedMaterials = false,
} = {}) {
  requireRecord(workflow, "workflow_required");
  requireRecord(revision, "workflow_revision_required");
  if (!workflow.workflowId || revision.workflowId !== workflow.workflowId) {
    throw new PortableLoopPackageError("workflow_revision_mismatch", "The selected revision does not belong to this Loop.");
  }
  if (!revision.revisionId || !Number.isInteger(revision.revisionNumber) || revision.revisionNumber < 1 || !revision.contentHash) {
    throw new PortableLoopPackageError("workflow_revision_not_immutable", "An explicit immutable Loop revision is required.");
  }
  if (!revision.definition) {
    throw new PortableLoopPackageError("workflow_definition_required", "The selected revision does not contain a Loop definition.");
  }

  const skillKeys = [...new Set(
    revision.graph.nodes
      .filter((node) => node.kind === "Skill")
      .map((node) => skillKey(node.skillRef)),
  )].sort();
  if (skillKeys.length > 0) requireResolver(resolveSkillVersion, "skill_version_resolver_required");
  const skillRefs = ordinalRefs("skill", skillKeys);
  const resolvedSkills = new Map();
  for (const key of skillKeys) {
    const requested = parseSkillKey(key);
    const version = await resolveSkillVersion({
      workspaceId: workflow.workspaceId,
      skillId: requested.skillId,
      version: requested.version,
    });
    assertExactSkillVersion(version, { ...requested, workspaceId: workflow.workspaceId });
    resolvedSkills.set(key, version);
  }

  const connectionValues = collectConnectionRequirements(resolvedSkills.values());
  const connectionRefs = ordinalRefs("connection", [...connectionValues.keys()].sort());
  const skillRequirements = skillKeys.map((key) => {
    const version = resolvedSkills.get(key);
    return {
      ref: skillRefs.get(key),
      skillId: version.skillId,
      version: version.version,
      contentHash: version.contentHash,
      connectionRefs: [...new Set((version.connectionRequirements ?? [])
        .map((requirement) => connectionRefs.get(requirement.requirementId))
        .sort())],
    };
  });

  const resourceRefs = uniqueResourceRefs(revision.resourceRefs ?? []);
  const materialKeys = [...resourceRefs.keys()].sort();
  if (materialKeys.length > 0) requireResolver(resolveMaterial, "material_resolver_required");
  const materialRefs = ordinalRefs("material", materialKeys);
  const resolvedMaterials = new Map();
  for (const key of materialKeys) {
    const resourceRef = resourceRefs.get(key);
    const material = await resolveMaterial({
      workspaceId: workflow.workspaceId,
      resourceId: resourceRef.resourceId,
      version: resourceRef.version,
    });
    assertExactMaterial(material, { ...resourceRef, workspaceId: workflow.workspaceId });
    resolvedMaterials.set(key, material);
  }

  const materialRequirements = materialKeys.map((key) => {
    const resourceRef = resourceRefs.get(key);
    const material = resolvedMaterials.get(key);
    return {
      ref: materialRefs.get(key),
      label: resourceRef.label || material.label,
      description: material.description ?? "",
      required: true,
      acceptedMediaTypes: [material.mediaType],
      contentHash: material.contentHash,
    };
  });
  const embeddedMaterials = embedMaterials
    ? materialKeys.map((key) => embeddedMaterial(materialRefs.get(key), resolvedMaterials.get(key)))
    : [];

  const result = {
    schemaVersion: "portable-loop-package-v1",
    name: workflow.name,
    description: workflow.description,
    definition: clone(revision.definition),
    graph: projectGraph(revision.graph, skillRefs, materialRefs, resourceRefs),
    inputForm: clone(revision.inputForm),
    outputDefinition: clone(revision.outputDefinition),
    requirements: {
      skills: skillRequirements,
      connections: [...connectionValues.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([capabilityKey, requirement]) => ({
        ref: connectionRefs.get(capabilityKey),
        capabilityKey,
        label: requirement.label,
        required: requirement.required,
        permissionSummary: requirement.permissionSummary,
      })),
      materials: materialRequirements,
    },
    embeddedMaterials,
    executionSettings: clone(revision.runSettings),
  };
  assertPortablePackage(result);
  return deepFreeze(result);
}

export async function inspectPortableLoopImport({
  packageBytes,
  source,
  workspaceId,
  mappings = {},
  resolveSkillVersion,
  resolveMaterial,
  resolveConnection,
} = {}) {
  const portableLoop = canonicalPackage(packageBytes ?? source);
  if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new TypeError("workspace_id_required");

  const diagnostics = [];
  const skillIndex = mappingIndex(mappings.skillMappings, "requirementRef", "skill", portableLoop.requirements.skills, diagnostics);
  const materialIndex = mappingIndex(mappings.materialMappings, "requirementRef", "material", portableLoop.requirements.materials, diagnostics);
  const connectionIndex = mappingIndex(mappings.connectionMappings, "requirementRef", "connection", portableLoop.requirements.connections, diagnostics);
  const resolutions = { skills: [], materials: [], connections: [] };
  const requirementStates = [];

  for (const requirement of portableLoop.requirements.skills) {
    const mapping = skillIndex.values.get(requirement.ref);
    let status = skillIndex.duplicates.has(requirement.ref) ? "unavailable" : "unmapped";
    if (mapping && !skillIndex.duplicates.has(requirement.ref)) {
      status = "unavailable";
      if (typeof resolveSkillVersion !== "function") {
        diagnostic(diagnostics, "skill_version_resolver_required", `A resolver is required for ${requirement.ref}.`, `requirements.skills.${requirement.ref}`);
      } else {
        const version = await resolveOrNull(resolveSkillVersion, {
          workspaceId,
          skillVersionId: mapping.skillVersionId,
          requirement: clone(requirement),
        });
        const mismatch = skillMismatch(version, { ...requirement, workspaceId, skillVersionId: mapping.skillVersionId });
        if (!mismatch) {
          status = "mapped";
          resolutions.skills.push({ ref: requirement.ref, skillVersionId: mapping.skillVersionId, skillRef: { skillId: version.skillId, version: version.version } });
        } else {
          diagnostic(diagnostics, mismatch.code, mismatch.message, `requirements.skills.${requirement.ref}`);
        }
      }
    }
    requirementStates.push({ ref: requirement.ref, kind: "skill", status });
  }

  for (const requirement of portableLoop.requirements.materials) {
    const mapping = materialIndex.values.get(requirement.ref);
    let status = materialIndex.duplicates.has(requirement.ref) ? "unavailable" : "unmapped";
    if (mapping && !materialIndex.duplicates.has(requirement.ref)) {
      const result = await inspectMaterialMapping({ portableLoop, requirement, mapping, workspaceId, resolveMaterial });
      status = result.status;
      if (result.resolution) resolutions.materials.push(result.resolution);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
    }
    requirementStates.push({ ref: requirement.ref, kind: "material", status });
  }

  for (const requirement of portableLoop.requirements.connections) {
    const mapping = connectionIndex.values.get(requirement.ref);
    let status = connectionIndex.duplicates.has(requirement.ref) ? "unavailable" : "unmapped";
    if (mapping && !connectionIndex.duplicates.has(requirement.ref)) {
      status = "unavailable";
      if (typeof resolveConnection !== "function") {
        diagnostic(diagnostics, "connection_resolver_required", `A resolver is required for ${requirement.ref}.`, `requirements.connections.${requirement.ref}`);
      } else {
        const connection = await resolveOrNull(resolveConnection, {
          workspaceId,
          connectionId: mapping.connectionId,
          requirement: clone(requirement),
        });
        const mismatch = connectionMismatch(connection, { ...requirement, workspaceId, connectionId: mapping.connectionId });
        if (!mismatch) {
          status = "mapped";
          resolutions.connections.push({ ref: requirement.ref, requirementId: requirement.capabilityKey, connectionId: mapping.connectionId });
        } else {
          diagnostic(diagnostics, mismatch.code, mismatch.message, `requirements.connections.${requirement.ref}`);
        }
      }
    }
    requirementStates.push({ ref: requirement.ref, kind: "connection", status });
  }

  const blockingRefs = referencedPortableRefs(portableLoop);
  const needsMapping = requirementStates.some((state) => {
    const requirement = requirementFor(portableLoop, state);
    const blocking = state.kind === "skill"
      || requirement.required
      || (state.kind === "material" && blockingRefs.has(state.ref));
    return state.status !== "mapped" && blocking;
  });
  return deepFreeze({
    status: needsMapping || diagnostics.some((item) => item.severity === "error") ? "needs_mapping" : "ready",
    sourceContentHash: hashPortableLoopPackage(formatPortableLoopPackage(portableLoop)),
    portableLoop,
    requirementStates,
    diagnostics,
    resolutions,
  });
}

export const resolvePortableLoopImport = inspectPortableLoopImport;

export function rewritePortableLoopImportGraph({ portableLoop, resolutions, materialResourceRefs = {} } = {}) {
  assertPortablePackage(portableLoop);
  requireRecord(resolutions, "loop_import_resolutions_required");
  const skills = exactResolutionMap(resolutions.skills, portableLoop.requirements.skills, "skill");
  const materials = exactResolutionMap(resolutions.materials, portableLoop.requirements.materials, "material", false);
  const connections = exactResolutionMap(resolutions.connections, portableLoop.requirements.connections, "connection", false);
  for (const requirement of portableLoop.requirements.skills) {
    const resolution = skills.get(requirement.ref);
    if (resolution.skillRef?.skillId !== requirement.skillId || resolution.skillRef?.version !== requirement.version) {
      throw new PortableLoopPackageError("skill_mapping_mismatch", `Skill ${requirement.ref} does not exactly match the package requirement.`);
    }
  }
  for (const requirement of portableLoop.requirements.connections) {
    const resolution = connections.get(requirement.ref);
    if (resolution && resolution.requirementId !== requirement.capabilityKey) {
      throw new PortableLoopPackageError("connection_mapping_mismatch", `Connection ${requirement.ref} does not provide the package capability.`);
    }
  }
  const resourceRefs = new Map();
  for (const requirement of portableLoop.requirements.materials) {
    const resolution = materials.get(requirement.ref);
    const provided = materialResourceRefs instanceof Map
      ? materialResourceRefs.get(requirement.ref)
      : materialResourceRefs[requirement.ref];
    const resourceRef = resolution?.resourceRef ?? provided;
    if (referencedPortableRefs(portableLoop).has(requirement.ref) && !resourceRef) {
      throw new PortableLoopPackageError("material_mapping_incomplete", `Material ${requirement.ref} has not been materialized in this workspace.`);
    }
    if (resourceRef) resourceRefs.set(requirement.ref, clone(resourceRef));
  }

  const graph = clone(portableLoop.graph);
  for (const node of graph.nodes) {
    if (node.kind === "Skill") {
      const resolution = skills.get(node.skillRef);
      if (!resolution) throw new PortableLoopPackageError("skill_mapping_incomplete", `Skill ${node.skillRef} is not mapped.`);
      node.skillRef = clone(resolution.skillRef);
    }
    if (node.kind === "Material") {
      node.configuration = {
        resourceIds: node.configuration.materialRefs.map((ref) => requireResourceRef(resourceRefs, ref).resourceId),
      };
    }
    node.inputBindings = node.inputBindings.map((binding) => binding.source.kind === "material"
      ? { ...binding, source: { kind: "resource", resourceId: requireResourceRef(resourceRefs, binding.source.materialRef).resourceId } }
      : binding);
  }

  const resolvedResourceRefs = [...resourceRefs.values()];
  return deepFreeze({
    workflow: {
      name: portableLoop.name,
      description: portableLoop.description,
      status: "blocked",
      lifecycle: "draft",
      visibility: "private",
      archived: false,
    },
    revision: {
      definition: clone(portableLoop.definition),
      graph,
      inputForm: clone(portableLoop.inputForm),
      outputDefinition: clone(portableLoop.outputDefinition),
      resourceRefs: uniqueBy(resolvedResourceRefs, (ref) => `${ref.resourceId}\u0000${ref.version}`),
      runSettings: clone(portableLoop.executionSettings),
    },
    connectionBindings: [...connections.values()].map(({ requirementId, connectionId }) => ({ requirementId, connectionId }))
      .sort((left, right) => left.requirementId.localeCompare(right.requirementId)),
  });
}

function assertPortablePackage(value) {
  if (!Check(PortableLoopPackageV1Schema, value)) {
    throw new PortableLoopPackageError("loop_package_invalid", "The Loop package does not match the supported format.");
  }
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new PortableLoopPackageError("loop_package_invalid", "The Loop package bytes are invalid.");
}

function canonicalPackage(value) {
  if (isPlainObject(value)) return parsePortableLoopPackage(formatPortableLoopPackage(value));
  return parsePortableLoopPackage(value);
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array);
}

function requireRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(code);
}

function requireResolver(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
}

function hashBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function skillKey(skillRef) {
  if (!skillRef?.skillId || !skillRef?.version) throw new PortableLoopPackageError("skill_ref_invalid", "Every Skill node must pin an exact Skill version.");
  return `${skillRef.skillId}\u0000${skillRef.version}`;
}

function parseSkillKey(key) {
  const [skillId, version] = key.split("\u0000");
  return { skillId, version };
}

function resourceKey(resourceRef) {
  return `${resourceRef.resourceId}\u0000${resourceRef.version}`;
}

function ordinalRefs(kind, keys) {
  return new Map(keys.map((key, index) => [key, `${kind}:${index + 1}`]));
}

function uniqueResourceRefs(values) {
  const result = new Map();
  const versionsById = new Map();
  for (const value of values) {
    if (!value?.resourceId || !value?.version || !value?.label) {
      throw new PortableLoopPackageError("material_ref_invalid", "Every attached material must use an immutable resource reference.");
    }
    const priorVersion = versionsById.get(value.resourceId);
    if (priorVersion && priorVersion !== value.version) {
      throw new PortableLoopPackageError("material_ref_ambiguous", "A Loop cannot export two versions of the same material identity.");
    }
    versionsById.set(value.resourceId, value.version);
    result.set(resourceKey(value), clone(value));
  }
  return result;
}

function assertExactSkillVersion(version, expected) {
  const mismatch = skillMismatch(version, expected);
  if (mismatch) throw new PortableLoopPackageError(mismatch.code, mismatch.message);
}

function skillMismatch(version, expected) {
  if (!version) return { code: "skill_version_unavailable", message: "The exact Skill version is unavailable in this workspace." };
  if (version.workspaceId !== expected.workspaceId) return { code: "skill_workspace_mismatch", message: "The selected Skill version belongs to another workspace." };
  if (expected.skillVersionId && version.skillVersionId !== expected.skillVersionId) return { code: "skill_version_id_mismatch", message: "The resolver returned a different Skill version record than the selected mapping." };
  if (version.skillId !== expected.skillId || version.version !== expected.version) return { code: "skill_version_mismatch", message: "The selected Skill identity or version does not exactly match the package requirement." };
  if (expected.contentHash && version.contentHash !== expected.contentHash) return { code: "skill_content_hash_mismatch", message: "The selected Skill content hash does not exactly match the package requirement." };
  if (typeof version.contentHash !== "string" || !version.contentHash.startsWith("sha256:")) return { code: "skill_content_hash_invalid", message: "The selected Skill version has no immutable content hash." };
  return null;
}

function assertExactMaterial(material, expected) {
  const mismatch = materialMismatch(material, expected);
  if (mismatch) throw new PortableLoopPackageError(mismatch.code, mismatch.message);
}

function materialMismatch(material, expected) {
  if (!material) return { code: "material_unavailable", message: "The selected material is unavailable in this workspace." };
  if (material.workspaceId !== expected.workspaceId) return { code: "material_workspace_mismatch", message: "The selected material belongs to another workspace." };
  if (expected.resourceId && material.resourceId !== expected.resourceId) return { code: "material_identity_mismatch", message: "The selected material identity does not match the mapping." };
  if (expected.version && material.version !== expected.version) return { code: "material_version_mismatch", message: "The selected material version does not match the immutable reference." };
  if (expected.acceptedMediaTypes && !expected.acceptedMediaTypes.includes(material.mediaType)) return { code: "material_media_type_mismatch", message: "The selected material media type is not accepted by the package." };
  if (expected.contentHash && material.contentHash !== expected.contentHash) return { code: "material_content_hash_mismatch", message: "The selected material content hash does not match the package requirement." };
  if (material.readiness && material.readiness.status !== "ready") return { code: "material_not_ready", message: "The selected material is not ready to use." };
  return null;
}

function connectionMismatch(connection, expected) {
  if (!connection) return { code: "connection_unavailable", message: "The selected connection is unavailable in this workspace." };
  if (connection.workspaceId !== expected.workspaceId) return { code: "connection_workspace_mismatch", message: "The selected connection belongs to another workspace." };
  if (expected.connectionId && connection.connectionId !== expected.connectionId) return { code: "connection_id_mismatch", message: "The resolver returned a different connection than the selected mapping." };
  if (connection.capabilityKey !== expected.capabilityKey) return { code: "connection_capability_mismatch", message: "The selected connection does not provide the exact required capability." };
  if (connection.status !== "connected" || connection.validation?.status !== "valid") return { code: "connection_not_valid", message: "The selected connection must be connected and valid." };
  return null;
}

function collectConnectionRequirements(skillVersions) {
  const result = new Map();
  for (const version of skillVersions) {
    for (const requirement of version.connectionRequirements ?? []) {
      if (!requirement?.requirementId) throw new PortableLoopPackageError("connection_requirement_invalid", "A Skill contains an invalid connection requirement.");
      const prior = result.get(requirement.requirementId);
      if (prior && JSON.stringify(sortValue(prior)) !== JSON.stringify(sortValue(requirement))) {
        throw new PortableLoopPackageError("connection_requirement_conflict", "Skills contain conflicting requirements for the same connection capability.");
      }
      result.set(requirement.requirementId, clone(requirement));
    }
  }
  return result;
}

function projectGraph(graph, skillRefs, materialRefs, resourceRefs) {
  const projected = clone(graph);
  const resourceIdToKey = new Map([...resourceRefs.entries()].map(([key, ref]) => [ref.resourceId, key]));
  for (const node of projected.nodes) {
    if (node.kind === "Skill") node.skillRef = skillRefs.get(skillKey(node.skillRef));
    if (node.kind === "Material") {
      node.configuration = {
        materialRefs: node.configuration.resourceIds.map((resourceId) => requireMaterialLocalRef(resourceIdToKey, materialRefs, resourceId)),
      };
    }
    node.inputBindings = node.inputBindings.map((binding) => binding.source.kind === "resource"
      ? { ...binding, source: { kind: "material", materialRef: requireMaterialLocalRef(resourceIdToKey, materialRefs, binding.source.resourceId) } }
      : binding);
  }
  return projected;
}

function requireMaterialLocalRef(resourceIdToKey, materialRefs, resourceId) {
  const key = resourceIdToKey.get(resourceId);
  if (!key) throw new PortableLoopPackageError("material_ref_missing", "A graph material is not attached to the immutable revision.");
  return materialRefs.get(key);
}

function embeddedMaterial(materialRef, material) {
  if (!EMBEDDED_MEDIA_TYPES.has(material.mediaType) || typeof material.content !== "string") {
    throw new PortableLoopPackageError("material_not_embeddable", "Only resolved UTF-8 text, Markdown, or JSON materials can be embedded.");
  }
  const bytes = Buffer.from(material.content, "utf8");
  const contentHash = hashBytes(bytes);
  if (contentHash !== material.contentHash) throw new PortableLoopPackageError("material_content_hash_mismatch", "Embedded material content does not match its immutable hash.");
  return { materialRef, mediaType: material.mediaType, encoding: "utf-8", content: material.content, byteLength: bytes.byteLength, contentHash };
}

function mappingIndex(mappings = [], key, kind, requirements, diagnostics) {
  const values = new Map();
  const duplicates = new Set();
  const known = new Set(requirements.map((requirement) => requirement.ref));
  for (const mapping of mappings ?? []) {
    const ref = mapping?.[key];
    if (!known.has(ref)) {
      diagnostic(diagnostics, `${kind}_mapping_unknown`, `The mapping ${String(ref)} does not match a package requirement.`, `${kind}Mappings`);
      continue;
    }
    if (values.has(ref)) {
      duplicates.add(ref);
      diagnostic(diagnostics, `${kind}_mapping_duplicate`, `The requirement ${ref} is mapped more than once.`, `${kind}Mappings.${ref}`);
      continue;
    }
    values.set(ref, mapping);
  }
  return { values, duplicates };
}

async function inspectMaterialMapping({ portableLoop, requirement, mapping, workspaceId, resolveMaterial }) {
  if (!mapping.resolution || !["workspaceMaterial", "embeddedMaterial"].includes(mapping.resolution.kind)) {
    return unavailable("material_mapping_invalid", "The selected material mapping is invalid.", requirement.ref);
  }
  if (mapping.resolution.kind === "embeddedMaterial") {
    const embedded = portableLoop.embeddedMaterials.find((item) => item.materialRef === requirement.ref && item.contentHash === mapping.resolution.contentHash);
    if (!embedded) return unavailable("embedded_material_unavailable", "The exact embedded material hash is unavailable.", requirement.ref);
    const bytes = Buffer.from(embedded.content, "utf8");
    if (embedded.byteLength !== bytes.byteLength || embedded.contentHash !== hashBytes(bytes)) {
      return unavailable("embedded_material_hash_mismatch", "The embedded material content does not match its declared hash.", requirement.ref);
    }
    if (!requirement.acceptedMediaTypes.includes(embedded.mediaType) || (requirement.contentHash && requirement.contentHash !== embedded.contentHash)) {
      return unavailable("material_media_or_hash_mismatch", "The embedded material does not match the required media type and content hash.", requirement.ref);
    }
    let resourceRef;
    if (typeof resolveMaterial === "function") {
      const material = await resolveOrNull(resolveMaterial, { workspaceId, requirement: clone(requirement), resolution: clone(mapping.resolution), embeddedMaterial: clone(embedded) });
      if (material) {
        const mismatch = materialMismatch(material, { workspaceId, acceptedMediaTypes: requirement.acceptedMediaTypes, contentHash: requirement.contentHash ?? embedded.contentHash });
        if (mismatch) return unavailable(mismatch.code, mismatch.message, requirement.ref);
        resourceRef = toResourceRef(material);
      }
    }
    return { status: "mapped", resolution: { ref: requirement.ref, kind: "embeddedMaterial", contentHash: embedded.contentHash, embeddedMaterial: clone(embedded), ...(resourceRef ? { resourceRef } : {}) } };
  }
  if (typeof resolveMaterial !== "function") return unavailable("material_resolver_required", `A resolver is required for ${requirement.ref}.`, requirement.ref);
  const material = await resolveOrNull(resolveMaterial, { workspaceId, resourceId: mapping.resolution.resourceId, requirement: clone(requirement), resolution: clone(mapping.resolution) });
  const mismatch = materialMismatch(material, { workspaceId, resourceId: mapping.resolution.resourceId, acceptedMediaTypes: requirement.acceptedMediaTypes, contentHash: requirement.contentHash });
  if (mismatch) return unavailable(mismatch.code, mismatch.message, requirement.ref);
  return { status: "mapped", resolution: { ref: requirement.ref, kind: "workspaceMaterial", resourceRef: toResourceRef(material) } };
}

function unavailable(code, message, ref) {
  return { status: "unavailable", diagnostic: makeDiagnostic(code, message, `requirements.materials.${ref}`) };
}

async function resolveOrNull(resolver, query) {
  try {
    return await resolver(query);
  } catch {
    return null;
  }
}

function toResourceRef(material) {
  return { resourceId: material.resourceId, version: material.version, label: material.label };
}

function diagnostic(diagnostics, code, message, field) {
  diagnostics.push(makeDiagnostic(code, message, field));
}

function makeDiagnostic(code, message, field) {
  return { code, message, severity: "error", field, recoveryAction: "Choose an exact matching dependency from this workspace." };
}

function referencedPortableRefs(portableLoop) {
  const refs = new Set();
  for (const node of portableLoop.graph.nodes) {
    if (node.kind === "Skill") refs.add(node.skillRef);
    if (node.kind === "Material") node.configuration.materialRefs.forEach((ref) => refs.add(ref));
    for (const binding of node.inputBindings) if (binding.source.kind === "material") refs.add(binding.source.materialRef);
  }
  for (const skill of portableLoop.requirements.skills) skill.connectionRefs.forEach((ref) => refs.add(ref));
  return refs;
}

function requirementFor(portableLoop, state) {
  const collection = state.kind === "skill" ? "skills" : state.kind === "material" ? "materials" : "connections";
  return portableLoop.requirements[collection].find((requirement) => requirement.ref === state.ref);
}

function exactResolutionMap(values = [], requirements, kind, requireAll = true) {
  const known = new Set(requirements.map((requirement) => requirement.ref));
  const result = new Map();
  for (const value of values ?? []) {
    if (!known.has(value?.ref) || result.has(value.ref)) throw new PortableLoopPackageError(`${kind}_mapping_invalid`, `The ${kind} resolutions do not exactly match the package requirements.`);
    result.set(value.ref, value);
  }
  if (requireAll && requirements.some((requirement) => !result.has(requirement.ref))) {
    throw new PortableLoopPackageError(`${kind}_mapping_incomplete`, `Every ${kind} requirement must be resolved before creating the draft.`);
  }
  return result;
}

function requireResourceRef(resourceRefs, ref) {
  const value = resourceRefs.get(ref);
  if (!value?.resourceId || !value?.version || !value?.label) throw new PortableLoopPackageError("material_mapping_incomplete", `Material ${ref} is not mapped to an immutable resource.`);
  return value;
}

function uniqueBy(values, key) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
