import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { portableLoopPackageExample } from "../../../workbench-contracts/examples/canonical-examples.mjs";

import {
  formatPortableLoopPackage,
  hashPortableLoopPackage,
  inspectPortableLoopImport,
  parsePortableLoopPackage,
  portableLoopPackageFilename,
  PortableLoopPackageError,
  projectPortableLoopPackage,
  rewritePortableLoopImportGraph,
} from "../../src/loops/portable-loop-package.mjs";

test("portable Loop package bytes are deterministic, canonical, and contract-valid", () => {
  const reordered = Object.fromEntries(Object.entries(portableLoopPackageExample).reverse());
  const left = formatPortableLoopPackage(portableLoopPackageExample);
  const right = formatPortableLoopPackage(reordered);

  assert.equal(left.equals(right), true);
  assert.equal(left.at(-1), 0x0a);
  assert.deepEqual(parsePortableLoopPackage(left), portableLoopPackageExample);
  assert.match(hashPortableLoopPackage(left), /^sha256:[a-f0-9]{64}$/);
});

test("portable Loop parser rejects non-canonical, duplicate-key, unknown, and sensitive fields", () => {
  const canonical = formatPortableLoopPackage(portableLoopPackageExample);
  const nonCanonical = Buffer.from(JSON.stringify(portableLoopPackageExample, null, 2), "utf8");
  assert.throws(
    () => parsePortableLoopPackage(nonCanonical),
    (error) => error instanceof PortableLoopPackageError && error.code === "loop_package_not_canonical",
  );

  const duplicateKey = Buffer.from('{"schemaVersion":"portable-loop-package-v1","schemaVersion":"portable-loop-package-v1"}\n');
  assert.throws(
    () => parsePortableLoopPackage(duplicateKey),
    (error) => error instanceof PortableLoopPackageError && error.code === "loop_package_invalid",
  );

  for (const [field, value] of [
    ["workspaceId", "workspace-private"],
    ["connectionId", "connection-private"],
    ["provider", "internal-provider"],
    ["secret", "must-not-leak"],
    ["runId", "run-history"],
  ]) {
    const invalid = { ...portableLoopPackageExample, [field]: value };
    assert.throws(
      () => parsePortableLoopPackage(formatUnsafe(invalid)),
      (error) => error instanceof PortableLoopPackageError && error.code === "loop_package_invalid",
      field,
    );
  }

  assert.deepEqual(parsePortableLoopPackage(canonical), portableLoopPackageExample);
});

test("portable Loop projector replaces workspace references and collects exact requirements", async () => {
  const fixture = projectorFixture();
  const projected = await projectPortableLoopPackage({
    workflow: fixture.workflow,
    revision: fixture.revision,
    resolveSkillVersion: async (query) => {
      assert.deepEqual(query, {
        workspaceId: fixture.workflow.workspaceId,
        skillId: fixture.skillVersion.skillId,
        version: fixture.skillVersion.version,
      });
      return fixture.skillVersion;
    },
    resolveMaterial: async (query) => {
      assert.deepEqual(query, {
        workspaceId: fixture.workflow.workspaceId,
        resourceId: fixture.material.resourceId,
        version: fixture.material.version,
      });
      return fixture.material;
    },
    embedMaterials: true,
  });

  const skillNode = projected.graph.nodes.find((node) => node.kind === "Skill");
  const materialNode = projected.graph.nodes.find((node) => node.kind === "Material");
  assert.equal(skillNode.skillRef, "skill:1");
  assert.deepEqual(materialNode.configuration, { materialRefs: ["material:1"] });
  assert.deepEqual(skillNode.inputBindings.find((binding) => binding.targetPort === "guidance").source, {
    kind: "material",
    materialRef: "material:1",
  });
  assert.deepEqual(projected.requirements.skills, [{
    ref: "skill:1",
    skillId: fixture.skillVersion.skillId,
    version: fixture.skillVersion.version,
    contentHash: fixture.skillVersion.contentHash,
    connectionRefs: ["connection:1"],
  }]);
  assert.deepEqual(projected.requirements.connections, [{
    ref: "connection:1",
    capabilityKey: "evidence-catalog-read",
    label: "Evidence catalog",
    required: true,
    permissionSummary: "Read approved evidence.",
  }]);
  assert.equal(projected.requirements.materials[0].contentHash, fixture.material.contentHash);
  assert.equal(projected.embeddedMaterials[0].contentHash, fixture.material.contentHash);
  assert.equal(projected.embeddedMaterials[0].byteLength, Buffer.byteLength(fixture.material.content));

  const serialized = JSON.stringify(projected).toLowerCase();
  for (const forbidden of [
    fixture.workflow.workspaceId,
    fixture.workflow.ownerId,
    fixture.workflow.workflowId,
    fixture.revision.revisionId,
    "run-private",
    "release-private",
    "installation-private",
    "binding-private",
  ]) assert.equal(serialized.includes(forbidden.toLowerCase()), false, forbidden);
  assert.equal(hashPortableLoopPackage(projected), hashPortableLoopPackage(formatPortableLoopPackage(projected)));
  assert.equal(portableLoopPackageFilename(" Weekly Research / Brief "), "weekly-research-brief.loop.json");
  assert.equal(portableLoopPackageFilename("研究简报"), "loop.loop.json");
});

test("portable Loop import resolves exact workspace dependencies and rewrites only a blocked draft", async () => {
  const fixture = projectorFixture();
  const projected = await projectFixture(fixture);
  const bytes = formatPortableLoopPackage(projected);
  const mappings = importMappings();
  const report = await inspectPortableLoopImport({
    packageBytes: bytes,
    workspaceId: fixture.workflow.workspaceId,
    mappings,
    resolveSkillVersion: async ({ skillVersionId }) => skillVersionId === fixture.skillVersion.skillVersionId ? fixture.skillVersion : null,
    resolveMaterial: async ({ resourceId }) => resourceId === fixture.material.resourceId ? fixture.material : null,
    resolveConnection: async ({ connectionId }) => connectionId === "connection-local-1" ? fixture.connection : null,
  });

  assert.equal(report.status, "ready");
  assert.deepEqual(report.requirementStates, [
    { ref: "skill:1", kind: "skill", status: "mapped" },
    { ref: "material:1", kind: "material", status: "mapped" },
    { ref: "connection:1", kind: "connection", status: "mapped" },
  ]);
  assert.deepEqual(report.diagnostics, []);

  const draft = rewritePortableLoopImportGraph({ portableLoop: report.portableLoop, resolutions: report.resolutions });
  const skillNode = draft.revision.graph.nodes.find((node) => node.kind === "Skill");
  const materialNode = draft.revision.graph.nodes.find((node) => node.kind === "Material");
  assert.deepEqual(skillNode.skillRef, { skillId: fixture.skillVersion.skillId, version: fixture.skillVersion.version });
  assert.deepEqual(materialNode.configuration, { resourceIds: [fixture.material.resourceId] });
  assert.deepEqual(skillNode.inputBindings.find((binding) => binding.targetPort === "guidance").source, {
    kind: "resource",
    resourceId: fixture.material.resourceId,
  });
  assert.deepEqual(draft.revision.resourceRefs, [{ resourceId: fixture.material.resourceId, version: fixture.material.version, label: fixture.material.label }]);
  assert.deepEqual(draft.connectionBindings, [{ requirementId: "evidence-catalog-read", connectionId: "connection-local-1" }]);
  assert.equal(draft.workflow.status, "blocked");
  assert.equal(draft.workflow.lifecycle, "draft");
  for (const forbidden of ["compile", "readiness", "run", "release", "installation", "evidence"]) {
    assert.equal(hasKey(draft, forbidden), false, forbidden);
  }
});

test("portable Loop import never silently substitutes Skill, Material, or Connection mappings", async (t) => {
  const fixture = projectorFixture();
  const projected = await projectFixture(fixture);
  const packageBytes = formatPortableLoopPackage(projected);

  const inspect = (overrides = {}) => inspectPortableLoopImport({
    packageBytes,
    workspaceId: fixture.workflow.workspaceId,
    mappings: importMappings(),
    resolveSkillVersion: async () => fixture.skillVersion,
    resolveMaterial: async () => fixture.material,
    resolveConnection: async () => fixture.connection,
    ...overrides,
  });

  for (const [label, resolver, code] of [
    ["Skill version record", async () => ({ ...fixture.skillVersion, skillVersionId: "skill-version-substitute" }), "skill_version_id_mismatch"],
    ["Skill identity", async () => ({ ...fixture.skillVersion, skillId: "skill-substitute" }), "skill_version_mismatch"],
    ["Skill version", async () => ({ ...fixture.skillVersion, version: "2.0.0" }), "skill_version_mismatch"],
    ["Skill content hash", async () => ({ ...fixture.skillVersion, contentHash: sha256("substitute") }), "skill_content_hash_mismatch"],
  ]) {
    await t.test(label, async () => {
      const report = await inspect({ resolveSkillVersion: resolver });
      assert.equal(state(report, "skill:1").status, "unavailable");
      assert.equal(report.diagnostics.some((item) => item.code === code), true);
    });
  }

  for (const [label, resolver, code] of [
    ["Material workspace", async () => ({ ...fixture.material, workspaceId: "workspace-other" }), "material_workspace_mismatch"],
    ["Material media", async () => ({ ...fixture.material, mediaType: "application/pdf" }), "material_media_type_mismatch"],
    ["Material hash", async () => ({ ...fixture.material, contentHash: sha256("substitute") }), "material_content_hash_mismatch"],
  ]) {
    await t.test(label, async () => {
      const report = await inspect({ resolveMaterial: resolver });
      assert.equal(state(report, "material:1").status, "unavailable");
      assert.equal(report.diagnostics.some((item) => item.code === code), true);
    });
  }

  for (const [label, resolver, code] of [
    ["Connection identity", async () => ({ ...fixture.connection, connectionId: "connection-substitute" }), "connection_id_mismatch"],
    ["Connection workspace", async () => ({ ...fixture.connection, workspaceId: "workspace-other" }), "connection_workspace_mismatch"],
    ["Connection capability", async () => ({ ...fixture.connection, capabilityKey: "different-capability" }), "connection_capability_mismatch"],
    ["Connection status", async () => ({ ...fixture.connection, status: "disabled" }), "connection_not_valid"],
    ["Connection validation", async () => ({ ...fixture.connection, validation: { status: "invalid" } }), "connection_not_valid"],
  ]) {
    await t.test(label, async () => {
      const report = await inspect({ resolveConnection: resolver });
      assert.equal(state(report, "connection:1").status, "unavailable");
      assert.equal(report.diagnostics.some((item) => item.code === code), true);
    });
  }
});

test("portable embedded material mapping verifies bytes and accepts transaction materialization", async () => {
  const fixture = projectorFixture();
  const projected = await projectPortableLoopPackage({
    workflow: fixture.workflow,
    revision: fixture.revision,
    resolveSkillVersion: async () => fixture.skillVersion,
    resolveMaterial: async () => fixture.material,
    embedMaterials: true,
  });
  const mappings = importMappings();
  mappings.materialMappings[0] = {
    requirementRef: "material:1",
    resolution: { kind: "embeddedMaterial", contentHash: fixture.material.contentHash },
  };
  const report = await inspectPortableLoopImport({
    packageBytes: formatPortableLoopPackage(projected),
    workspaceId: fixture.workflow.workspaceId,
    mappings,
    resolveSkillVersion: async () => fixture.skillVersion,
    resolveMaterial: async ({ embeddedMaterial }) => {
      assert.equal(embeddedMaterial.contentHash, fixture.material.contentHash);
      return fixture.material;
    },
    resolveConnection: async () => fixture.connection,
  });
  assert.equal(report.status, "ready");
  assert.equal(state(report, "material:1").status, "mapped");
  assert.equal(report.resolutions.materials[0].kind, "embeddedMaterial");
  assert.deepEqual(report.resolutions.materials[0].resourceRef, {
    resourceId: fixture.material.resourceId,
    version: fixture.material.version,
    label: fixture.material.label,
  });
});

test("portable Loop import rejects non-canonical bytes and incomplete graph resolutions", async () => {
  const fixture = projectorFixture();
  const projected = await projectFixture(fixture);
  await assert.rejects(
    inspectPortableLoopImport({
      packageBytes: Buffer.from(JSON.stringify(projected, null, 2)),
      workspaceId: fixture.workflow.workspaceId,
    }),
    (error) => error instanceof PortableLoopPackageError && error.code === "loop_package_not_canonical",
  );
  assert.throws(
    () => rewritePortableLoopImportGraph({ portableLoop: projected, resolutions: { skills: [], materials: [], connections: [] } }),
    (error) => error instanceof PortableLoopPackageError && error.code === "skill_mapping_incomplete",
  );
});

test("portable Loop domain mapping rejects mutable revisions and duplicate mappings", async () => {
  const fixture = projectorFixture();
  const mutableRevision = { ...fixture.revision };
  delete mutableRevision.revisionNumber;
  await assert.rejects(
    projectPortableLoopPackage({
      workflow: fixture.workflow,
      revision: mutableRevision,
      resolveSkillVersion: async () => fixture.skillVersion,
      resolveMaterial: async () => fixture.material,
    }),
    (error) => error instanceof PortableLoopPackageError && error.code === "workflow_revision_not_immutable",
  );

  const projected = await projectFixture(fixture);
  const mappings = importMappings();
  mappings.skillMappings.push(structuredClone(mappings.skillMappings[0]));
  const report = await inspectPortableLoopImport({
    packageBytes: formatPortableLoopPackage(projected),
    workspaceId: fixture.workflow.workspaceId,
    mappings,
    resolveSkillVersion: async () => fixture.skillVersion,
    resolveMaterial: async () => fixture.material,
    resolveConnection: async () => fixture.connection,
  });
  assert.equal(state(report, "skill:1").status, "unavailable");
  assert.equal(report.diagnostics.some((item) => item.code === "skill_mapping_duplicate"), true);
});

test("portable Loop projector does not require unused dependency resolvers", async () => {
  const fixture = projectorFixture();
  const inputNode = structuredClone(fixture.revision.graph.nodes.find((node) => node.kind === "Input"));
  const outputNode = structuredClone(fixture.revision.graph.nodes.find((node) => node.kind === "Output"));
  outputNode.inputBindings = [{
    targetPort: "content",
    source: { kind: "nodeOutput", nodeId: inputNode.nodeId, portId: "topic" },
  }];
  const revision = {
    ...fixture.revision,
    graph: {
      nodes: [inputNode, outputNode],
      edges: [{
        edgeId: "edge-input-output",
        sourceNodeId: inputNode.nodeId,
        sourcePort: "topic",
        targetNodeId: outputNode.nodeId,
        targetPort: "content",
      }],
    },
    resourceRefs: [],
  };
  const projected = await projectPortableLoopPackage({ workflow: fixture.workflow, revision });
  assert.deepEqual(projected.requirements, { skills: [], connections: [], materials: [] });
});

function formatUnsafe(value) {
  return Buffer.from(`${JSON.stringify(sortValue(value))}\n`, "utf8");
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
  );
}

function projectorFixture() {
  const workflow = {
    workflowId: "workflow-private-1",
    workspaceId: "workspace-local-1",
    ownerId: "user-private-1",
    name: "Weekly research brief",
    description: "A portable reviewed research workflow.",
  };
  const graph = structuredClone(portableLoopPackageExample.graph);
  const skillNode = graph.nodes.find((node) => node.kind === "Skill");
  const materialNode = graph.nodes.find((node) => node.kind === "Material");
  skillNode.skillRef = { skillId: "skill-research-brief", version: "1.0.0" };
  skillNode.inputBindings.find((binding) => binding.targetPort === "guidance").source = {
    kind: "resource",
    resourceId: "resource-guidance-private",
  };
  materialNode.configuration = { resourceIds: ["resource-guidance-private"] };
  const content = "# Guidance\n\nKeep the brief concise and evidence-backed.\n";
  const material = {
    resourceId: "resource-guidance-private",
    workspaceId: workflow.workspaceId,
    version: "1.0.0",
    label: "Research guidance",
    description: "Workspace-selected guidance for the brief.",
    mediaType: "text/markdown",
    content,
    contentHash: sha256(content),
    readiness: { status: "ready" },
  };
  const skillVersion = {
    skillVersionId: "skill-version-local-1",
    skillId: "skill-research-brief",
    workspaceId: workflow.workspaceId,
    version: "1.0.0",
    contentHash: sha256("skill-research-brief@1.0.0"),
    connectionRequirements: [{
      requirementId: "evidence-catalog-read",
      label: "Evidence catalog",
      required: true,
      permissionSummary: "Read approved evidence.",
    }],
  };
  const revision = {
    revisionId: "revision-private-1",
    revisionNumber: 1,
    workflowId: workflow.workflowId,
    contentHash: sha256("revision-private-1"),
    definition: structuredClone(portableLoopPackageExample.definition),
    graph,
    inputForm: structuredClone(portableLoopPackageExample.inputForm),
    outputDefinition: structuredClone(portableLoopPackageExample.outputDefinition),
    resourceRefs: [{ resourceId: material.resourceId, version: material.version, label: material.label }],
    runSettings: structuredClone(portableLoopPackageExample.executionSettings),
    compile: { status: "ready", diagnostics: [] },
  };
  const connection = {
    connectionId: "connection-local-1",
    workspaceId: workflow.workspaceId,
    capabilityKey: "evidence-catalog-read",
    status: "connected",
    validation: { status: "valid" },
  };
  return { workflow, revision, skillVersion, material, connection };
}

function projectFixture(fixture) {
  return projectPortableLoopPackage({
    workflow: fixture.workflow,
    revision: fixture.revision,
    resolveSkillVersion: async () => fixture.skillVersion,
    resolveMaterial: async () => fixture.material,
  });
}

function importMappings() {
  return {
    skillMappings: [{ requirementRef: "skill:1", skillVersionId: "skill-version-local-1" }],
    materialMappings: [{ requirementRef: "material:1", resolution: { kind: "workspaceMaterial", resourceId: "resource-guidance-private" } }],
    connectionMappings: [{ requirementRef: "connection:1", connectionId: "connection-local-1" }],
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function state(report, ref) {
  return report.requirementStates.find((item) => item.ref === ref);
}

function hasKey(value, target) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => key.toLowerCase() === target || hasKey(entry, target));
}
