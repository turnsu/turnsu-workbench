import { ProductStoreError } from "../store/errors.mjs";
import { acceptsMaterialMediaType } from "./material-media-types.mjs";

const MAX_CONTEXT_CHARACTERS = 120_000;
const MAX_MATERIAL_COUNT = 32;
const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;

export function createSkillMaterialResolver({
  store,
  inputAttachmentService,
  textResourceService,
} = {}) {
  return async function resolveSkillMaterials({
    workspaceId,
    requestedBy,
    bindings = [],
    requirements = [],
    signal,
  } = {}) {
    if (!Array.isArray(bindings) || bindings.length > MAX_MATERIAL_COUNT) {
      throw materialError(
        "skill_material_limit_exceeded",
        "A Skill execution may use at most 32 governed materials.",
      );
    }
    const keys = new Set();
    for (const binding of bindings) {
      if (!binding?.materialKey || keys.has(binding.materialKey)) {
        throw materialError("skill_material_binding_invalid", "Each Skill material must be bound exactly once.");
      }
      keys.add(binding.materialKey);
    }
    const attachmentBindings = bindings.filter(
      (binding) => binding.source?.kind === "attachment",
    );
    const resolvedAttachments = attachmentBindings.length
      ? await inputAttachmentService?.resolveMaterialBindings?.({
        workspaceId,
        requestedBy,
        bindings: attachmentBindings,
        signal,
      })
      : [];
    if (resolvedAttachments.length !== attachmentBindings.length) {
      throw materialError("skill_material_unavailable", "One or more attachment materials are unavailable.");
    }
    const resolved = [...resolvedAttachments];
    for (const binding of bindings.filter(
      (item) => item.source?.kind === "workspace_resource",
    )) {
      if (!store?.repositories?.resources) {
        throw materialError("skill_material_unavailable", "Workspace material storage is unavailable.");
      }
      const ref = binding.source.resource;
      const resource = await store.repositories.resources.get(
        ref.resourceId,
        { workspaceId },
      );
      if (
        !resource
        || resource.version !== ref.version
        || resource.readiness?.status !== "ready"
        || !ref.contentHash
        || resource.contentHash !== ref.contentHash
      ) {
        throw materialError("skill_material_unavailable", "A workspace material is missing or stale.");
      }
      const content = await textResourceService?.readContent?.({
        workspaceId,
        requestedBy,
        resourceId: ref.resourceId,
        version: ref.version,
      });
      if (!content || !Buffer.isBuffer(content.bytes)) {
        throw materialError("skill_material_unavailable", "Workspace material storage is unavailable.");
      }
      resolved.push({
        materialKey: binding.materialKey,
        kind: "workspace_resource",
        mediaType: resource.mediaType,
        contentHash: resource.contentHash,
        bytes: Buffer.from(content.bytes),
        contextText: typeof content.contextText === "string"
          ? content.contextText.slice(0, MAX_CONTEXT_CHARACTERS)
          : null,
        resource: structuredClone(ref),
      });
    }
    if (resolved.length !== bindings.length) {
      throw materialError("skill_material_binding_invalid", "Every material binding must use a supported Product source.");
    }
    const requirementsByKey = new Map();
    for (const requirement of requirements) {
      if (
        !requirement?.materialKey
        || requirementsByKey.has(requirement.materialKey)
        || !Array.isArray(requirement.acceptedMediaTypes)
      ) {
        throw materialError(
          "skill_material_binding_invalid",
          "Skill material requirements are invalid.",
        );
      }
      requirementsByKey.set(requirement.materialKey, requirement.acceptedMediaTypes);
    }
    let totalBytes = 0;
    let totalContextCharacters = 0;
    for (const material of resolved) {
      if (!Buffer.isBuffer(material.bytes)) {
        throw materialError(
          "skill_material_unavailable",
          "A Skill material could not be loaded into the governed execution boundary.",
        );
      }
      const acceptedMediaTypes = requirementsByKey.get(material.materialKey);
      if (
        acceptedMediaTypes
        && !acceptsMaterialMediaType(acceptedMediaTypes, material.mediaType)
      ) {
        throw materialError(
          "skill_material_media_type_mismatch",
          `Material "${material.materialKey}" does not match the Skill's accepted formats.`,
        );
      }
      totalBytes += material.bytes.byteLength;
      totalContextCharacters += material.contextText?.length ?? 0;
    }
    if (
      totalBytes > MAX_MATERIAL_BYTES
      || totalContextCharacters > MAX_CONTEXT_CHARACTERS
    ) {
      throw materialError(
        "skill_material_limit_exceeded",
        "The Skill materials exceed the execution input budget.",
      );
    }
    return resolved;
  };
}

function materialError(code, message) {
  const failure = new ProductStoreError(code, message);
  failure.status = code.endsWith("_forbidden")
    ? "permission_denied"
    : "blocked";
  return failure;
}
