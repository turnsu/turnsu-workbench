import assert from "node:assert/strict";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";
import { PostgresCompatibilityCatalogReadModel } from "../../src/store/postgres/postgres-compatibility-catalog-read-model.mjs";

function storeWith(steps) {
  const pending = [...steps];
  return {
    async connect() {},
    bindAdapter(factory) { return factory({ execute: async (_uow, { text, values }) => {
      const step = pending.shift();
      assert.ok(step, `unexpected query: ${text}`);
      assert.match(text, step.match);
      assert.deepEqual(values, step.values);
      return { rows: step.rows };
    } }); },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
    assertDrained() { assert.equal(pending.length, 0); },
  };
}

const skillPayload = {
  display: { defaultLocale: "en", localized: { en: { name: "Catalog skill", description: "A governed catalog skill." } } },
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  risk: { level: "low", externalAction: false, summary: "No external actions." },
  dependencies: [], setupChecks: [],
  executionRef: { capabilityId: "catalog", taskIntent: "summarize", adapterVersion: "1", executionMode: "deterministic" },
  usageCount: 0, readiness: { status: "ready", diagnostics: [] },
};
const skillRow = {
  schema_version: "workbench-v1", skill_id: "skill-catalog", version: "1", name: "Catalog skill",
  description: "A governed catalog skill.", category: "productivity", status: "ready",
  created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z", payload: skillPayload,
};
const templateRow = {
  schema_version: "workbench-v1", template_id: "template-catalog", template_version: "1", name: "Catalog Loop",
  description: "A catalog template.", category: "productivity",
  display: { defaultLocale: "en", localized: { en: { name: "Catalog Loop", description: "A catalog template." } } },
  input_form: { fields: [] }, graph: { nodes: [], edges: [] }, included_skills: [],
  expected_outputs: [{ nodeId: "output", portId: "result", label: "Result", mediaType: "text/plain" }],
  review_policy: { required: false, gateNodeIds: [] }, availability_status: "available", availability_diagnostics: [],
  created_at: "2026-08-10T00:00:00.000Z", updated_at: "2026-08-10T00:00:00.000Z",
};

test("PostgreSQL compatibility catalog owns legacy Skill and Template reads without repositories", async () => {
  const store = storeWith([
    { match: /FROM public\.legacy_skill_definitions[\s\S]*category = \$2/, values: ["workspace-alpha", null, 100], rows: [skillRow] },
    { match: /FROM public\.legacy_skill_definitions[\s\S]*skill_id = \$2/, values: ["workspace-alpha", "skill-catalog"], rows: [skillRow] },
    { match: /FROM public\.templates[\s\S]*category = \$1/, values: [null, 100], rows: [templateRow] },
    { match: /FROM public\.templates[\s\S]*template_id = \$1/, values: ["template-catalog"], rows: [templateRow] },
  ]);
  const readModel = new PostgresCompatibilityCatalogReadModel({ store });
  assert.equal((await readModel.listSkills({ workspaceId: "workspace-alpha" }))[0].skillId, "skill-catalog");
  assert.equal((await readModel.getSkill({ workspaceId: "workspace-alpha", skillId: "skill-catalog" })).executionRef.executionMode, "deterministic");
  assert.equal((await readModel.listTemplates())[0].templateId, "template-catalog");
  assert.equal((await readModel.getTemplate({ templateId: "template-catalog" })).availability.status, "available");
  store.assertDrained();
});

test("Application routes legacy public catalog reads through the injected PostgreSQL owner", async () => {
  const calls = [];
  const application = createWorkbenchApplication({
    store: { async connect() {} }, runner: {}, agentRuntime: {},
    compatibilityCatalogReadModel: {
      async listSkills(input) { calls.push(["skills", input]); return [skillView()]; },
      async getSkill(input) { calls.push(["skill", input]); return skillView(); },
      async listTemplates(input) { calls.push(["templates", input]); return [templateView()]; },
      async getTemplate(input) { calls.push(["template", input]); return templateView(); },
    },
  });
  const auth = { userId: "alice", workspaceId: "workspace-alpha" };
  assert.equal((await application.listSkills({ auth })).data[0].skillId, "skill-catalog");
  assert.equal((await application.getSkill({ skillId: "skill-catalog", auth })).skillId, "skill-catalog");
  assert.equal((await application.listTemplates({ auth })).data[0].templateId, "template-catalog");
  assert.equal((await application.getTemplate({ templateId: "template-catalog", auth })).templateId, "template-catalog");
  assert.deepEqual(calls, [
    ["skills", { workspaceId: "workspace-alpha", query: {} }],
    ["skill", { workspaceId: "workspace-alpha", skillId: "skill-catalog" }],
    ["templates", { query: {} }],
    ["template", { templateId: "template-catalog" }],
  ]);
});

function skillView() {
  return { schemaVersion: "workbench-v1", skillId: "skill-catalog", version: "1", name: "Catalog skill", description: "A governed catalog skill.", category: "productivity", ...structuredClone(skillPayload), createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
}
function templateView() {
  return { schemaVersion: "workbench-v1", templateId: "template-catalog", templateVersion: "1", name: "Catalog Loop", description: "A catalog template.", category: "productivity", display: structuredClone(templateRow.display), inputForm: structuredClone(templateRow.input_form), graph: structuredClone(templateRow.graph), includedSkills: [], expectedOutputs: structuredClone(templateRow.expected_outputs), reviewPolicy: structuredClone(templateRow.review_policy), availability: { status: "available", diagnostics: [] }, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
}
