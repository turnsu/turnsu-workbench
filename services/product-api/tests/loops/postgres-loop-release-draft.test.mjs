import assert from "node:assert/strict";
import test from "node:test";
import { loadLoopReleaseDraft } from "../../src/loops/postgres-loop-release-draft.mjs";

test("using a release preserves its method but resolves models anew for the consumer", async () => {
  const source = { release_id: "release-a", loop_version_id: "version-a", name: "Team method", description: "Shared method",
    graph: { nodes: [{ kind: "Input", configuration: { modelProfileId: "publisher-profile", fallbackModelProfileIds: ["publisher-fallback"], fieldIds: ["goal"] } }], edges: [] },
    input_form: { fields: [] }, output_definition: {}, resource_refs: [], definition: { goal: "Shared goal" },
    run_settings: { maxParallelism: 1, defaultTimeoutSeconds: 60, agentControllerModelProfileId: "publisher-profile", imageGenerationModelProfileId: "publisher-image", workflowFallbackAllowed: true } };
  const draft = await loadLoopReleaseDraft({ workspaceId: "workspace-a", userId: "bob", releaseId: "release-a",
    query: async (_sql, values) => { assert.deepEqual(values, ["workspace-a", "release-a"]); return { rows: [source] }; } });
  assert.deepEqual(draft.graph.nodes[0].configuration, { fieldIds: ["goal"] });
  assert.deepEqual(draft.runSettings, { maxParallelism: 1, defaultTimeoutSeconds: 60, workflowFallbackAllowed: false });
  assert.equal(draft.sourceRelease.versionId, "version-a");
  assert.equal(source.graph.nodes[0].configuration.modelProfileId, "publisher-profile");
});
test("a release outside the authorized workspace cannot become a personal copy", async () => {
  await assert.rejects(loadLoopReleaseDraft({ workspaceId: "other-workspace", userId: "bob", releaseId: "release-a",
    query: async () => ({ rows: [] }) }), { code: "release_not_available" });
});
