import { ProductStoreError } from "../store/errors.mjs";
import { readPinnedSkillVersion } from "../skills/postgres-published-skill-reader.mjs";
import { ObjectAccessPolicy } from "../authorization/object-access-policy.mjs";

// Read exact immutable versions inside the caller's Product transaction.
// An uploaded Draft is not an execution contract: its approved binding is.
export async function requireWorkflowReferences({ query, workspaceId, userId, revision }) {
  const skills = new Map();
  const versionsBySkill = new Map();
  for (const node of revision.graph?.nodes ?? []) {
    if (node.kind !== "Skill") continue;
    const ref = node.skillRef;
    const key = `${ref?.skillId}:${ref?.version}`;
    if (skills.has(key)) continue;
    // The immutable publication tables pin one version per Skill in a Loop.
    if (versionsBySkill.has(ref?.skillId) && versionsBySkill.get(ref.skillId) !== ref.version) {
      throw coded("workflow_skill_version_conflict");
    }
    const skill = await readPinnedSkillVersion({ query, workspaceId, ref });
    if (!skill) throw coded("skill_version_not_found");
    const grants = skill.ownerId === userId ? [] : (await query(`
      SELECT principal_id, role, capabilities FROM public.object_access_grants
      WHERE workspace_id = $1 AND object_kind = 'skill' AND object_id = $2
        AND principal_id = $3 AND principal_kind = 'user' AND status = 'active'
      FOR SHARE`, [workspaceId, ref.skillId, userId])).rows;
    const policyInput = {
      principal: { principalId: userId, kind: "user", workspaceId, workspaceRole: "member",
        capabilities: skill.ownerId === userId ? ["object.execute"] : grants.flatMap((grant) => grant.capabilities ?? []) },
      target: { objectKind: "skill", objectId: ref.skillId, workspaceId, ownerPrincipalId: skill.ownerId,
        visibility: skill.visibility, lifecycle: skill.lifecycle, latestPublishedVersionId: skill.latestPublishedVersionId,
        requestedSkillVersionId: skill.version.skillVersionId,
        workspaceReleaseVersionId: skill.workspaceReleaseVersionId,
        grants: grants.map((grant) => ({ principalId: grant.principal_id, role: grant.role })) },
    };
    const policy = new ObjectAccessPolicy();
    if (!policy.evaluate({ ...policyInput, operation: "read" }).allowed) throw coded("skill_version_not_found");
    skill.canExecute = policy.evaluate({ ...policyInput, operation: "execute" }).allowed;
    skills.set(key, skill);
    versionsBySkill.set(ref.skillId, ref.version);
  }
  const resources = new Map();
  const resourceRefs = [];
  for (const ref of revision.resourceRefs ?? []) {
    if (resources.has(ref.resourceId)) throw coded("workflow_resource_reference_conflict");
    const row = (await query(`SELECT resource.*, object.state AS object_state
      FROM public.workspace_resources resource
      JOIN public.product_objects object ON object.workspace_id = resource.workspace_id
        AND object.object_id = resource.object_id AND object.content_hash = resource.content_hash
      WHERE resource.workspace_id = $1 AND resource.resource_id = $2 AND resource.resource_version = $3
      FOR SHARE OF resource, object`, [workspaceId, ref.resourceId, ref.version])).rows[0];
    if (!row || (ref.contentHash && ref.contentHash !== row.content_hash)) throw coded("resource_not_ready");
    const pinned = { resourceId: row.resource_id, version: row.resource_version,
      label: row.label, contentHash: row.content_hash };
    resources.set(ref.resourceId, { ...pinned, ready: row.readiness_status === "ready" && row.object_state === "promoted" });
    resourceRefs.push(pinned);
  }
  return { skills, resources, resourceRefs };
}

function coded(code) { return new ProductStoreError(code, code); }
