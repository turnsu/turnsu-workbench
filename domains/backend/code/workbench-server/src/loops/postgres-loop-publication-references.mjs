import { ProductStoreError } from "../store/errors.mjs";
import { requireWorkflowReferences } from "./postgres-workflow-references.mjs";

// A draft may reference private or unready material. A workspace release may
// only fix material already available to its audience; publication never grants
// access to a dependency or copies the publisher's execution credentials.
export async function requireLoopPublicationReferences({ query, workspaceId, userId, revision, plan }) {
  if (!Array.isArray(plan?.pinnedSkills) || !Array.isArray(plan?.steps)) throw coded("loop_compile_required");
  const references = await requireWorkflowReferences({ query, workspaceId, userId,
    revision: { graph: revision.graph, resourceRefs: revision.resource_refs ?? [] } });
  const pinnedSkills = [...references.skills.values()].map(({ version }) => ({ skillId: version.skillId, version: version.version }))
    .sort(compareRef);
  const planPins = [...(plan?.pinnedSkills ?? [])].sort(compareRef);
  if (JSON.stringify(pinnedSkills) !== JSON.stringify(planPins)) throw coded("loop_compile_required");
  for (const skill of references.skills.values()) {
    const sharedVersion = skill.workspaceReleaseVersionId === skill.version.skillVersionId;
    const systemVersion = skill.ownerId === "system-catalog" && skill.visibility === "workspace" && skill.lifecycle === "published";
    if (!sharedVersion && !systemVersion) throw coded("loop_dependency_not_shared");
    if (!skill.canExecute || !skill.definition) throw coded("loop_dependency_unavailable");
  }
  for (const resource of references.resources.values()) {
    if (!resource.ready) throw coded("resource_not_ready");
  }
  for (const { version } of references.skills.values()) {
    for (const dependency of version.dependencies ?? []) {
      if (!dependency.required || dependency.kind === "connection") continue;
      const pin = dependency.kind === "skill"
        ? pinnedSkills.find((ref) => ref.skillId === dependency.id)
        : references.resourceRefs.find((ref) => ref.resourceId === dependency.id);
      if (!pin || (dependency.version && dependency.version !== pin.version)) throw coded("loop_dependency_unavailable");
    }
  }
  // Connection requirement metadata must have an authoritative capability/effect
  // contract. A raw connection ID or the publisher's binding is not that contract.
  if ((plan?.steps ?? []).some((step) => step.capabilities?.connectionIds?.length)
    || [...references.skills.values()].some(({ version }) => (version.dependencies ?? []).some((dep) => dep.kind === "connection" && dep.required))) {
    throw coded("loop_connection_publication_unavailable");
  }
  const dependencies = [
    ...pinnedSkills.map((ref) => ({ kind: "skill", id: ref.skillId, version: ref.version, required: true })),
    ...references.resourceRefs.map((ref) => ({ kind: "resource", id: ref.resourceId, version: ref.version, required: true })),
  ];
  return { ...references, pinnedSkills, dependencies };
}

const compareRef = (a, b) => `${a.skillId}:${a.version}`.localeCompare(`${b.skillId}:${b.version}`, "en");
const coded = (code) => new ProductStoreError(code, code);
