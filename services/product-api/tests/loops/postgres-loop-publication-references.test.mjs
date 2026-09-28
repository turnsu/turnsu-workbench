import assert from "node:assert/strict";
import test from "node:test";
import { requireLoopPublicationReferences } from "../../src/loops/postgres-loop-publication-references.mjs";

const ref = { skillId: "skill-a", version: "1.0.0" };
const hash = `sha256:${"a".repeat(64)}`;
async function resolve({ visibility = "workspace", released = visibility === "workspace", owner = "alice", grants = [], planPins = [ref], resourceStatus = "ready", dependencies = [] } = {}) {
  const query = async (sql) => {
    if (sql.includes("public.skill_versions")) return { rows: [{
      skill_id: ref.skillId, skill_version_id: "version-a", version: ref.version, content_hash: hash,
      owner_user_id: owner, visibility, lifecycle: "published", latest_published_version_id: "version-a",
      workspace_released: released,
      published_at: "2026-09-22T00:00:00Z", capability_id: "summarize", definition: { dependencies },
    }] };
    if (sql.includes("public.object_access_grants")) return { rows: grants };
    if (sql.includes("public.workspace_resources")) return { rows: [{ resource_id: "resource-a", resource_version: "1.0.0", content_hash: hash, readiness_status: resourceStatus, object_state: "promoted" }] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return requireLoopPublicationReferences({ query, workspaceId: "workspace-a", userId: "alice",
    revision: { graph: { nodes: [{ kind: "Skill", skillRef: ref }] }, resource_refs: [{ resourceId: "resource-a", version: "1.0.0", contentHash: hash }] },
    plan: { pinnedSkills: planPins, steps: [] } });
}

test("publication cannot widen a private Skill's audience, even for its owner", async () => {
  await assert.rejects(resolve({ visibility: "private" }), { code: "loop_dependency_not_shared" });
});
test("workspace visibility alone cannot substitute for an immutable shared release", async () => {
  await assert.rejects(resolve({ released: false }), { code: "loop_dependency_not_shared" });
});
test("publication may use an exact workspace release without borrowing the author's private grant", async () => {
  const result = await resolve({ owner: "bob" });
  assert.deepEqual(result.pinnedSkills, [ref]);
});
test("publication cannot substitute Skill versions for the plan that was tested", async () => {
  await assert.rejects(resolve({ planPins: [{ ...ref, version: "2.0.0" }] }), { code: "loop_compile_required" });
});
test("publication rejects material made unavailable since the test run", async () => {
  await assert.rejects(resolve({ resourceStatus: "deleted" }), { code: "resource_not_ready" });
});
test("publication does not silently drop required transitive dependencies", async () => {
  await assert.rejects(resolve({ dependencies: [{ kind: "resource", id: "private-resource", required: true }] }), { code: "loop_dependency_unavailable" });
  await assert.rejects(resolve({ dependencies: [{ kind: "connection", id: "personal-connection", required: true }] }), { code: "loop_connection_publication_unavailable" });
});
test("publication accepts an explicit collaborator execution grant", async () => {
  const result = await resolve({ owner: "bob", grants: [{ principal_id: "alice", role: "editor", capabilities: ["object.execute"] }] });
  assert.deepEqual(result.pinnedSkills, [ref]);
});
