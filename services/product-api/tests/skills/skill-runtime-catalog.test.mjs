import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillRuntimeCatalog,
  scaffoldSkillDraftPackage,
} from "../../src/skills/skill-runtime-catalog.mjs";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const digest = (character) => `runtime.example/skill@sha256:${character.repeat(64)}`;
const catalog = createSkillRuntimeCatalog({
  pythonImage: digest("a"),
  nodeImage: digest("b"),
});
const base = {
  name: "Governed scaffold",
  description: "Generate a package from the Product-owned runtime catalog.",
  category: "automation",
  tags: ["governed"],
  materials: [],
  parameters: [],
  outputs: [{ name: "result", description: "Generated result", type: "json" }],
  smoke: { purpose: "Return a result.", input: "hello", expectedOutcome: "" },
};
const decode = (files) => files.map((file) => ({
  path: file.path,
  content: Buffer.from(file.contentBase64, "base64"),
}));
const inspectScaffold = (scaffold) => inspectSkillPackage({ files: decode(scaffold.files) });

test("Product runtime catalog scaffolds Python and Node packages without browser-owned runtime mappings", () => {
  const python = scaffoldSkillDraftPackage({
    data: {
      ...base,
      definitionType: "script",
      runtime: { runtimeId: "python3.12", timeoutSeconds: 45, memoryMiB: 256 },
    },
    runtimeCatalog: catalog,
  });
  const node = scaffoldSkillDraftPackage({
    data: {
      ...base,
      definitionType: "script",
      runtime: { runtimeId: "nodejs20-typescript", timeoutSeconds: 75, memoryMiB: 384 },
    },
    runtimeCatalog: catalog,
  });

  assert.deepEqual(python.files.map((file) => file.path), [
    "SKILL.md",
    "skill.runtime.json",
    "scripts/main.py",
  ]);
  assert.deepEqual(node.files.map((file) => file.path), [
    "SKILL.md",
    "skill.runtime.json",
    "scripts/main.ts",
  ]);
  assert.equal(inspectScaffold(python).manifest.runtime.runtime, "python3.12");
  const nodeInspection = inspectScaffold(node);
  assert.equal(nodeInspection.manifest.runtime.runtime, "nodejs20-typescript");
  assert.deepEqual(nodeInspection.manifest.runtime.limits, {
    timeoutSeconds: 75,
    memoryMiB: 384,
  });
});

test("Product scaffold generates stable valid identifiers for Chinese and long display names", () => {
  const chinese = scaffoldSkillDraftPackage({
    data: { ...base, name: "会议纪要总结", definitionType: "prompt" },
    runtimeCatalog: catalog,
  });
  const longPrefix = "a".repeat(199);
  const longA = scaffoldSkillDraftPackage({
    data: { ...base, name: `${longPrefix}甲`, definitionType: "prompt" },
    runtimeCatalog: catalog,
  });
  const longB = scaffoldSkillDraftPackage({
    data: { ...base, name: `${longPrefix}乙`, definitionType: "prompt" },
    runtimeCatalog: catalog,
  });

  for (const scaffold of [chinese, longA, longB]) {
    const inspection = inspectScaffold(scaffold);
    assert.equal(inspection.status, "passed");
    assert.match(inspection.manifest.name, /^[a-z0-9-]{1,64}$/);
  }
  assert.match(inspectScaffold(chinese).manifest.name, /^skill-[a-f0-9]{8}$/);
  assert.notEqual(inspectScaffold(longA).manifest.name, inspectScaffold(longB).manifest.name);
  assert.match(
    Buffer.from(chinese.files[0].contentBase64, "base64").toString("utf8"),
    /# 会议纪要总结/,
  );
});

test("Product scaffold bounds frontmatter descriptions and deduplicates normalized interface names", () => {
  const description = "d".repeat(2000);
  const materialDescription = "m".repeat(1001);
  const scaffold = scaffoldSkillDraftPackage({
    data: {
      ...base,
      name: "Description boundaries",
      description,
      materials: [
        { name: "source!", description: materialDescription, required: true },
        { name: "source?", description: "Second source", required: false },
      ],
      definitionType: "prompt",
    },
    runtimeCatalog: catalog,
  });
  const inspection = inspectScaffold(scaffold);
  const source = Buffer.from(scaffold.files[0].contentBase64, "base64").toString("utf8");

  assert.equal(inspection.status, "passed");
  assert.equal(inspection.manifest.description.length, 1024);
  assert.deepEqual(inspection.manifest.inputs.map((entry) => entry.name), ["source_", "source__2"]);
  assert.equal(inspection.manifest.inputs[0].description.length, 1000);
  assert.match(source, new RegExp(`\\n${description}\\n`));
  assert.match(source, new RegExp(materialDescription));
});

test("Product scaffold preserves a human material label and a machine-readable media contract", () => {
  const scaffold = scaffoldSkillDraftPackage({
    data: {
      ...base,
      materials: [{
        name: "访谈记录",
        identifier: "interview_notes",
        description: "用于提取关键结论。",
        required: true,
        acceptedMediaTypes: [
          "text/markdown",
          "text/plain",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
      }],
      definitionType: "prompt",
    },
    runtimeCatalog: catalog,
  });
  const inspection = inspectScaffold(scaffold);

  assert.equal(inspection.status, "passed");
  assert.deepEqual(inspection.manifest.inputs[0], {
    name: "interview_notes",
    title: "访谈记录",
    type: "file",
    required: true,
    description: "用于提取关键结论。",
    acceptedMediaTypes: [
      "text/plain",
      "text/markdown",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  });
});

test("Product runtime scaffold allows an unavailable runtime Draft but rejects unknown runtimes and invalid limits", () => {
  assert.throws(() => scaffoldSkillDraftPackage({
    data: {
      ...base,
      definitionType: "script",
      runtime: { runtimeId: "future-runtime", timeoutSeconds: 30, memoryMiB: 128 },
    },
    runtimeCatalog: catalog,
  }), (error) => error?.code === "skill_runtime_not_found");

  const unavailable = createSkillRuntimeCatalog();
  const unavailableDraft = scaffoldSkillDraftPackage({
    data: {
      ...base,
      definitionType: "script",
      runtime: { runtimeId: "python3.12", timeoutSeconds: 30, memoryMiB: 128 },
    },
    runtimeCatalog: unavailable,
  });
  // A Script Draft may be created while its runtime is unavailable, but the
  // executable payload still requires the normal isolated-validation review.
  assert.equal(inspectScaffold(unavailableDraft).status, "needs_review");

  assert.throws(() => scaffoldSkillDraftPackage({
    data: {
      ...base,
      definitionType: "script",
      runtime: { runtimeId: "python3.12", timeoutSeconds: 30, memoryMiB: 96 },
    },
    runtimeCatalog: catalog,
  }), (error) => error?.code === "skill_runtime_limits_invalid");
});
