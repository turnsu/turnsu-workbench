import assert from "node:assert/strict";
import test from "node:test";
import { Check, SkillDefinitionSchema, SkillVersionSchema } from "@looloomi/workbench-contracts";
import { requireWorkflowReferences } from "../../src/loops/postgres-workflow-references.mjs";

const now = "2026-09-21T06:00:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
const row = {
  schema_version: "workbench-v1", workspace_id: "workspace-alpha", skill_id: "skill-alpha", skill_version_id: "skill-version-alpha",
  version: "1.0.0", owner_user_id: "alice", visibility: "private", lifecycle: "published", latest_published_version_id: "skill-version-alpha",
  published_at: now, published_by_user_id: "alice", content_hash: hash, package_hash: hash, package_object_id: "object-alpha",
  capability_id: "uploaded-skill-alpha", task_intent: "summarize", adapter_version: "1.0.0", execution_mode: "agent", executor_kind: "prompt", trust_tier: "T2",
  validation_id: "validation-alpha", validation_status: "passed", validation_completed_at: now, validation_diagnostics: [], primary_test_run_id: "test-alpha",
  upload_payload: { inspection: { manifest: { name: "notes", description: "Summarize notes" } } },
  definition: { name: "Notes", description: "Summarize notes", category: "data", inputSchema: { type: "object", properties: { notes: { type: "string" } } }, outputSchema: { type: "object", properties: { result: { type: "string" } } }, risk: { level: "low", externalAction: false, summary: "No external actions" }, dependencies: [], connectionRequirements: [] },
};
const revision = { graph: { nodes: [{ kind: "Skill", skillRef: { skillId: "skill-alpha", version: "1.0.0" } }] }, resourceRefs: [] };
const queryFor = ({ skill = row, resource = null, grants = [] } = {}) => async (sql) => {
  if (sql.includes("public.skill_versions")) return { rows: skill ? [structuredClone(skill)] : [] };
  if (sql.includes("public.workspace_resources")) return { rows: resource ? [structuredClone(resource)] : [] };
  if (sql.includes("public.object_access_grants")) return { rows: structuredClone(grants) };
  throw new Error(`Unexpected query: ${sql}`);
};
const resolve = (query, data = revision, userId = "alice") => requireWorkflowReferences({ query, revision: data, workspaceId: "workspace-alpha", userId });

test("published package references produce complete compiler and recoverable Run contracts without modifying the draft", async () => {
  const result = await resolve(queryFor());
  const skill = result.skills.get("skill-alpha:1.0.0");
  assert.equal(Check(SkillDefinitionSchema, skill.definition), true, JSON.stringify(skill.definition));
  assert.equal(Check(SkillVersionSchema, skill.version), true, JSON.stringify(skill.version));
  assert.equal(skill.version.executionRef.capabilityId, row.capability_id);
  assert.equal(skill.version.packageObjectId, row.package_object_id);
  assert.equal(row.definition.executionRef, undefined);
  assert.equal(skill.canExecute, true);
});

test("draft can retain an existing material while readiness is pending, but cannot substitute its content", async () => {
  const resource = { resource_id: "resource-alpha", resource_version: "1", label: "Notes", content_hash: hash, readiness_status: "blocked", object_state: "quarantined" };
  const data = { graph: { nodes: [] }, resourceRefs: [{ resourceId: resource.resource_id, version: "1", label: "User label" }] };
  const result = await resolve(queryFor({ resource }), data);
  assert.equal(result.resourceRefs[0].contentHash, hash);
  assert.equal(result.resources.get(resource.resource_id).ready, false);
  await assert.rejects(resolve(queryFor({ resource }), { ...data, resourceRefs: [{ ...data.resourceRefs[0], contentHash: `sha256:${"b".repeat(64)}` }] }), { code: "resource_not_ready" });
});

test("workspace visibility allows a reference to be saved but does not grant Skill execution", async () => {
  const result = await resolve(queryFor({ skill: { ...row, visibility: "workspace" } }), revision, "bob");
  assert.equal(result.skills.get("skill-alpha:1.0.0").canExecute, false);
  await assert.rejects(resolve(queryFor(), revision, "bob"), { code: "skill_version_not_found" });
});

test("explicit Skill execution grant is honored without granting access to another private Skill", async () => {
  const result = await resolve(queryFor({ grants: [{ principal_id: "bob", role: "editor", capabilities: ["object.execute"] }] }), revision, "bob");
  assert.equal(result.skills.get("skill-alpha:1.0.0").canExecute, true);
  await assert.rejects(resolve(queryFor({ grants: [] }), revision, "bob"), { code: "skill_version_not_found" });
});
