import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  SkillDefinitionSchema,
  WorkflowTemplateSchema,
} from "@looloomi/workbench-contracts";
import {
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
} from "../../../../../agent/code/agent-runtime/extensions/workflow-conformance/binding.mjs";
import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "../../../../../agent/code/agent-runtime/extensions/meeting-action-extractor/binding.mjs";
import { bootstrapWorkbenchCatalog } from "../../src/application/catalog-bootstrap.mjs";

const makeStore = () => {
  const skills = [];
  const templates = [];
  const skillAssets = [];
  const skillVersions = [];
  const objects = [];
  return {
    skills,
    templates,
    skillAssets,
    skillVersions,
    objects,
    async connect() {},
    repositories: {
      skills: { async upsert(skill) { skills.push(skill); return skill; } },
      templates: {
        async get(templateId, templateVersion) {
          return templates.find((entry) => entry.templateId === templateId && entry.templateVersion === templateVersion) ?? null;
        },
        async insert(template) { templates.push(template); return template; },
      },
      skillAssets: {
        async get(skillId) { return skillAssets.find((entry) => entry.skillId === skillId) ?? null; },
        async insert(skill) { skillAssets.push(skill); return skill; },
        async patch(skillId, patch) {
          const current = skillAssets.find((entry) => entry.skillId === skillId);
          Object.assign(current, patch);
          return current;
        },
      },
      skillVersions: {
        async getBySkillRef(skillId, version) {
          return skillVersions.find((entry) => entry.skillId === skillId && entry.version === version) ?? null;
        },
        async insert(version) { skillVersions.push(version); return version; },
      },
      objects: {
        async get(objectId) { return objects.find((entry) => entry.objectId === objectId) ?? null; },
        async insert(object) { objects.push(object); return object; },
      },
    },
  };
};

test("production catalog exposes a business Skill only after its server runtime probe succeeds", async () => {
  const store = makeStore();
  await bootstrapWorkbenchCatalog({ store, agentRuntime: { async probeSkill() { return { ready: true, status: "ready" }; } }, testMode: false });
  assert.equal(store.skills.length, 1);
  assert.equal(store.skills[0].skillId, MEETING_ACTION_EXTRACTOR_SKILL_ID);
  assert.equal(store.skills[0].status, "ready");
  assert.equal(store.skills[0].readiness.status, "ready");
  assert.equal(store.templates[0].availability.status, "available");
  assert.deepEqual(store.skills[0].executionRef, MEETING_ACTION_EXTRACTOR_EXECUTION_REF);
  assert.equal(Check(SkillDefinitionSchema, store.skills[0]), true);
  assert.equal(Check(WorkflowTemplateSchema, store.templates[0]), true);
  assert.notDeepEqual(store.skills[0].executionRef, WORKFLOW_CONFORMANCE_EXECUTION_REF);
  assert.equal(store.templates[0].inputForm.fields[0].fieldId, "transcript");
  const skillNode = store.templates[0].graph.nodes.find((node) => node.nodeId === "node-skill");
  assert.deepEqual(skillNode.inputPorts.map((port) => port.portId), ["transcript"]);
  assert.deepEqual(skillNode.outputPorts.map((port) => port.portId), ["actionItems", "summary"]);
  assert.equal(store.skillAssets.length, 1);
  assert.equal(store.skillVersions.length, 1);
  assert.equal(store.skillAssets[0].latestPublishedVersionId, store.skillVersions[0].skillVersionId);
  assert.equal(store.skillVersions[0].skillId, MEETING_ACTION_EXTRACTOR_SKILL_ID);
  assert.equal(store.skillVersions[0].validation.status, "passed");
  await bootstrapWorkbenchCatalog({ store, agentRuntime: { async probeSkill() { return { ready: true, status: "ready" }; } }, testMode: false });
  assert.equal(store.skillVersions.length, 1, "catalog bootstrap must not duplicate the system Skill version");

  const blockedStore = makeStore();
  await bootstrapWorkbenchCatalog({
    store: blockedStore,
    agentRuntime: { async probeSkill() { return { ready: false, status: "blocked", code: "binding_missing" }; } },
    testMode: false,
  });
  assert.equal(blockedStore.skills[0].status, "blocked");
  assert.equal(blockedStore.templates[0].availability.status, "blocked");
});

test("test mode alone installs the conformance binding and requires a successful runtime probe", async () => {
  const readyStore = makeStore();
  await bootstrapWorkbenchCatalog({
    store: readyStore,
    testMode: true,
    agentRuntime: { async probeSkill() { return { ready: true, status: "ready", code: "conformance_ready" }; } },
  });
  assert.equal(readyStore.skills[0].status, "ready");
  assert.equal(readyStore.templates[0].availability.status, "available");
  assert.equal(Check(SkillDefinitionSchema, readyStore.skills[0]), true);
  assert.equal(Check(WorkflowTemplateSchema, readyStore.templates[0]), true);
  assert.deepEqual(
    readyStore.skills[0].executionRef,
    WORKFLOW_CONFORMANCE_EXECUTION_REF,
  );

  const [inputNode, skillNode, reviewNode, outputNode] = [
    "node-input",
    "node-skill",
    "node-review",
    "node-output",
  ].map((nodeId) => readyStore.templates[0].graph.nodes.find((node) => node.nodeId === nodeId));
  assert.deepEqual(inputNode.outputPorts.map((port) => port.portId), ["text"]);
  assert.deepEqual(skillNode.inputPorts.map((port) => port.portId), ["text"]);
  assert.deepEqual(skillNode.outputPorts.map((port) => port.portId), ["echo", "charCount"]);
  assert.deepEqual(reviewNode.inputPorts.map((port) => port.portId), ["candidate"]);
  assert.deepEqual(outputNode.outputPorts.map((port) => port.portId), ["final"]);

  const blockedStore = makeStore();
  await bootstrapWorkbenchCatalog({
    store: blockedStore,
    testMode: true,
    agentRuntime: { async probeSkill() { return { ready: false, status: "blocked", code: "offline" }; } },
  });
  assert.equal(blockedStore.skills[0].status, "blocked");
  assert.equal(blockedStore.templates[0].availability.status, "blocked");
});

test("bootstrap connects before resolving repositories", async () => {
  const store = { repositories: null };
  const seeded = makeStore();
  store.connect = async () => {
    store.repositories = seeded.repositories;
  };
  await bootstrapWorkbenchCatalog({ store, testMode: false });
  assert.equal(seeded.skills.length, 1);
  assert.equal(seeded.templates.length, 1);
});
