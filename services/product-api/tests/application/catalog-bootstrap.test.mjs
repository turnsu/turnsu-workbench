import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  ProductObjectSchema,
  SkillSchema,
  SkillDefinitionSchema,
  SkillVersionSchema,
  WorkflowTemplateSchema,
} from "@turnsu/workbench-contracts";
import {
  WORKFLOW_CONFORMANCE_EXECUTION_REF,
} from "../../../../packages/agent-runtime/extensions/workflow-conformance/binding.mjs";
import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "../../../../packages/agent-runtime/extensions/meeting-action-extractor/binding.mjs";
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
        async get(skillVersionId, { workspaceId } = {}) {
          return skillVersions.find((entry) => (
            entry.skillVersionId === skillVersionId
            && (!workspaceId || entry.workspaceId === workspaceId)
          )) ?? null;
        },
        async getBySkillRef(skillId, version, { workspaceId } = {}) {
          return skillVersions.find((entry) => (
            entry.skillId === skillId
            && entry.version === version
            && entry.workspaceId === workspaceId
          )) ?? null;
        },
        async insert(version) {
          if (skillVersions.some((entry) => entry.skillVersionId === version.skillVersionId)) {
            throw new Error("duplicate_skill_version_id");
          }
          skillVersions.push(version);
          return version;
        },
      },
      objects: {
        async get(objectId, { workspaceId } = {}) {
          return objects.find((entry) => (
            entry.objectId === objectId
            && (!workspaceId || entry.workspaceId === workspaceId)
          )) ?? null;
        },
        async getByWorkspaceContentHash(workspaceId, contentHash) {
          return objects.find((entry) => (
            entry.workspaceId === workspaceId && entry.contentHash === contentHash
          )) ?? null;
        },
        async insert(object) {
          if (objects.some((entry) => entry.objectId === object.objectId)) {
            throw new Error("duplicate_object_id");
          }
          if (objects.some((entry) => (
            entry.workspaceId === object.workspaceId && entry.contentHash === object.contentHash
          ))) {
            throw new Error("duplicate_object_workspace_content_hash");
          }
          objects.push(object);
          return object;
        },
      },
    },
  };
};

const READY_PROBE = Object.freeze({ ready: true, status: "ready" });
const CATALOG_NOW = "2026-08-05T00:00:00.000Z";
const SYSTEM_NAME_NORMALIZED = "meeting action extractor";

async function seedLegacySystemCatalog() {
  const store = makeStore();
  await bootstrapWorkbenchCatalog({
    store,
    agentRuntime: { async probeSkill() { return READY_PROBE; } },
    testMode: false,
    clock: () => CATALOG_NOW,
  });
  Object.assign(store.skillAssets[0], {
    nameNormalized: SYSTEM_NAME_NORMALIZED,
    lifecycle: "ready",
    visibility: "private",
  });
  return store;
}

test("production catalog exposes a business Skill only after its server runtime probe succeeds", async () => {
  const store = makeStore();
  await bootstrapWorkbenchCatalog({ store, agentRuntime: { async probeSkill() { return { ready: true, status: "ready" }; } }, testMode: false });
  assert.equal(store.skills.length, 1);
  assert.equal(store.skills[0].skillId, MEETING_ACTION_EXTRACTOR_SKILL_ID);
  assert.equal("status" in store.skills[0], false);
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
  assert.equal(store.skillAssets[0].lifecycle, "published");
  assert.equal(store.skillAssets[0].visibility, "workspace");
  assert.equal("workspaceExecutable" in store.skillAssets[0], false);
  assert.equal(Check(SkillSchema, store.skillAssets[0]), true);
  assert.equal(store.skillAssets[0].latestPublishedVersionId, store.skillVersions[0].skillVersionId);
  assert.equal(store.skillVersions[0].skillId, MEETING_ACTION_EXTRACTOR_SKILL_ID);
  assert.equal(store.skillVersions[0].validation.status, "passed");
  assert.equal(Check(ProductObjectSchema, store.objects[0]), true);
  store.skillAssets[0].nameNormalized = SYSTEM_NAME_NORMALIZED;
  await bootstrapWorkbenchCatalog({ store, agentRuntime: { async probeSkill() { return { ready: true, status: "ready" }; } }, testMode: false });
  assert.equal(store.skillVersions.length, 1, "catalog bootstrap must not duplicate the system Skill version");
  assert.equal(store.skillAssets[0].nameNormalized, SYSTEM_NAME_NORMALIZED);

  const blockedStore = makeStore();
  await bootstrapWorkbenchCatalog({
    store: blockedStore,
    agentRuntime: { async probeSkill() { return { ready: false, status: "blocked", code: "binding_missing" }; } },
    testMode: false,
  });
  assert.equal("status" in blockedStore.skills[0], false);
  assert.equal(blockedStore.skills[0].readiness.status, "blocked");
  assert.equal(blockedStore.templates[0].availability.status, "blocked");
  assert.equal(blockedStore.skillAssets.length, 0);
  assert.equal(blockedStore.skillVersions.length, 0);
});

test("ready catalog probes reconcile legacy system assets to published without duplicating versions", async () => {
  const store = await seedLegacySystemCatalog();
  const versionBefore = structuredClone(store.skillVersions);
  const objectsBefore = structuredClone(store.objects);

  await bootstrapWorkbenchCatalog({
    store,
    agentRuntime: { async probeSkill() { return READY_PROBE; } },
    testMode: false,
    clock: () => CATALOG_NOW,
  });

  assert.equal(store.skillVersions.length, 1);
  assert.equal(Check(SkillVersionSchema, store.skillVersions[0]), true);
  assert.deepEqual(store.skillVersions, versionBefore);
  assert.deepEqual(store.objects, objectsBefore);
  assert.equal(store.skillAssets[0].lifecycle, "published");
  assert.equal(store.skillAssets[0].visibility, "workspace");
  assert.equal(store.skillAssets[0].nameNormalized, SYSTEM_NAME_NORMALIZED);
  assert.equal("workspaceExecutable" in store.skillAssets[0], false);
});

test("reserved system catalog assets fail closed unless current-published or exact legacy-ready", async (t) => {
  const cases = [
    ["draft", (asset) => { asset.lifecycle = "draft"; }],
    ["validating", (asset) => { asset.lifecycle = "validating"; }],
    ["tested", (asset) => { asset.lifecycle = "tested"; }],
    ["deprecated", (asset) => { asset.lifecycle = "deprecated"; }],
    ["archived", (asset) => { asset.lifecycle = "archived"; }],
    ["unknown lifecycle", (asset) => { asset.lifecycle = "unknown"; }],
    ["extra field", (asset) => { asset.unexpected = true; }],
    ["missing field", (asset) => { delete asset.currentDraftId; }],
    ["active draft", (asset) => { asset.currentDraftId = "draft-attacker"; }],
    ["legacy ready with wrong visibility", (asset) => { asset.visibility = "workspace"; }],
    ["published with wrong version pointer", (asset) => {
      asset.lifecycle = "published";
      asset.visibility = "workspace";
      asset.latestPublishedVersionId = "skill-version-attacker";
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const store = await seedLegacySystemCatalog();
      mutate(store.skillAssets[0]);
      const before = structuredClone({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      });

      await assert.rejects(
        () => bootstrapWorkbenchCatalog({
          store,
          agentRuntime: { async probeSkill() { return READY_PROBE; } },
          testMode: false,
          clock: () => CATALOG_NOW,
        }),
        /system_catalog_skill_asset_conflict/,
      );
      assert.deepEqual({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      }, before);
    });
  }
});

test("existing system catalog versions fail closed before writes unless every pinned invariant is exact", async (t) => {
  const replacedHash = `sha256:${"f".repeat(64)}`;
  const cases = [
    ["contract-invalid", (version) => { version.unexpected = true; }],
    ["validation missing", (version) => { delete version.validation; }],
    ["validation failed", (version) => { version.validation.status = "failed"; }],
    ["publisher replaced", (version) => { version.publishedBy = "user-attacker"; }],
    ["version identity replaced", (version) => { version.skillVersionId = "skill-version-replaced"; }],
    ["wrong-workspace deterministic ID collision", (version) => { version.workspaceId = "workspace-other"; }],
    ["package hash replaced", (version) => { version.packageHash = replacedHash; }],
    ["content hash replaced", (version) => { version.contentHash = replacedHash; }],
    ["execution ref replaced", (version) => { version.executionRef.capabilityId = "replaced.capability"; }],
    ["definition replaced", (version) => { version.name = "Replaced system Skill"; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const store = await seedLegacySystemCatalog();
      mutate(store.skillVersions[0]);
      const before = structuredClone({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      });

      await assert.rejects(
        () => bootstrapWorkbenchCatalog({
          store,
          agentRuntime: { async probeSkill() { return READY_PROBE; } },
          testMode: false,
          clock: () => CATALOG_NOW,
        }),
        /system_catalog_skill_version_conflict/,
      );
      assert.deepEqual({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      }, before);
    });
  }
});

test("existing system catalog versions require an exact bundled package object before writes", async (t) => {
  const replacedHash = `sha256:${"e".repeat(64)}`;
  const cases = [
    ["missing", (store) => { store.objects.length = 0; }],
    ["wrong-ID same-workspace content-hash tuple collision", (store) => { store.objects[0].objectId = "object-attacker"; }],
    ["contract-invalid", (store) => { store.objects[0].unexpected = true; }],
    ["wrong workspace", (store) => { store.objects[0].workspaceId = "workspace-other"; }],
    ["content hash replaced", (store) => { store.objects[0].contentHash = replacedHash; }],
    ["media type replaced", (store) => { store.objects[0].mediaType = "application/octet-stream"; }],
    ["size replaced", (store) => { store.objects[0].sizeBytes += 1; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const store = await seedLegacySystemCatalog();
      mutate(store);
      const before = structuredClone({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      });

      await assert.rejects(
        () => bootstrapWorkbenchCatalog({
          store,
          agentRuntime: { async probeSkill() { return READY_PROBE; } },
          testMode: false,
          clock: () => CATALOG_NOW,
        }),
        /system_catalog_skill_object_conflict/,
      );
      assert.deepEqual({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      }, before);
    });
  }
});

test("catalog bootstrap rejects missing lifecycle repository ports before publishing definitions", async (t) => {
  const cases = [
    ["skillAssets repository", (repositories) => { delete repositories.skillAssets; }],
    ["skillAssets patch", (repositories) => { delete repositories.skillAssets.patch; }],
    ["skillVersions repository", (repositories) => { delete repositories.skillVersions; }],
    ["skillVersions exact ID lookup", (repositories) => { delete repositories.skillVersions.get; }],
    ["objects repository", (repositories) => { delete repositories.objects; }],
    ["objects tuple lookup", (repositories) => { delete repositories.objects.getByWorkspaceContentHash; }],
  ];

  for (const [name, removePort] of cases) {
    await t.test(name, async () => {
      const store = makeStore();
      removePort(store.repositories);

      await assert.rejects(
        () => bootstrapWorkbenchCatalog({
          store,
          agentRuntime: { async probeSkill() { return READY_PROBE; } },
          testMode: false,
          clock: () => CATALOG_NOW,
        }),
        /system_catalog_lifecycle_repositories_unavailable/,
      );
      assert.deepEqual({
        skills: store.skills,
        templates: store.templates,
        skillAssets: store.skillAssets,
        skillVersions: store.skillVersions,
        objects: store.objects,
      }, {
        skills: [],
        templates: [],
        skillAssets: [],
        skillVersions: [],
        objects: [],
      });
    });
  }
});

test("catalog bootstrap fails closed before writes when the reserved Skill ID is user-owned", async () => {
  const store = makeStore();
  const conflictingAsset = {
    schemaVersion: "workbench-v1",
    skillId: MEETING_ACTION_EXTRACTOR_SKILL_ID,
    workspaceId: "workspace-local",
    ownerId: "user-owner",
    visibility: "private",
    lifecycle: "draft",
    currentDraftId: null,
    latestPublishedVersionId: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
  };
  store.skillAssets.push(structuredClone(conflictingAsset));

  await assert.rejects(
    () => bootstrapWorkbenchCatalog({
      store,
      agentRuntime: { async probeSkill() { return { ready: true, status: "ready" }; } },
      testMode: false,
    }),
    /system_catalog_skill_owner_conflict/,
  );
  assert.deepEqual(store.skillAssets, [conflictingAsset]);
  assert.equal(store.skillVersions.length, 0);
  assert.equal(store.objects.length, 0);
  assert.equal(store.skills.length, 0);
  assert.equal(store.templates.length, 0);
});

test("test mode alone installs the conformance binding and requires a successful runtime probe", async () => {
  const readyStore = makeStore();
  await bootstrapWorkbenchCatalog({
    store: readyStore,
    testMode: true,
    agentRuntime: { async probeSkill() { return { ready: true, status: "ready", code: "conformance_ready" }; } },
  });
  assert.equal("status" in readyStore.skills[0], false);
  assert.equal(readyStore.templates[0].availability.status, "available");
  assert.equal(readyStore.skillAssets[0].lifecycle, "published");
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
  assert.equal("status" in blockedStore.skills[0], false);
  assert.equal(blockedStore.skills[0].readiness.status, "blocked");
  assert.equal(blockedStore.templates[0].availability.status, "blocked");
  assert.equal(blockedStore.skillAssets.length, 0);
  assert.equal(blockedStore.skillVersions.length, 0);
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
