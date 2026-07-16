import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSkillsFromDir } from "../../../../../agent/code/agent-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";
import { inspectSkillPackage } from "../../src/validation/skill-package-inspector.mjs";

const skill = (description = "Extract explicit actions from supplied meeting notes.") => `---
name: meeting-action-extractor
description: ${description}
compatibility: Local only
disable-model-invocation: true
---

# Meeting Action Extractor
`;
const runtimeManifest = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
})}\n`;

test("Skill package inspection returns stable inventory and hash for a valid portable package", () => {
  const first = inspectSkillPackage({
    files: [
      { path: "SKILL.md", content: skill() },
      { path: "references/rules.md", content: "Only return explicit actions." },
      { path: "agents/openai.yaml", content: "interface: assistant" },
    ],
  });
  const reordered = inspectSkillPackage({
    files: [...[
      { path: "SKILL.md", content: skill() },
      { path: "references/rules.md", content: "Only return explicit actions." },
      { path: "agents/openai.yaml", content: "interface: assistant" },
    ]].reverse(),
  });
  assert.equal(first.status, "passed");
  assert.equal(first.manifest.name, "meeting-action-extractor");
  assert.equal(first.contentHash, reordered.contentHash);
  assert.deepEqual(first.inventory.map((file) => file.path), ["agents/openai.yaml", "references/rules.md", "SKILL.md"]);
});

test("Skill package inspection rejects unsafe paths, binary content, missing instructions, and invalid frontmatter", () => {
  const result = inspectSkillPackage({
    files: [
      { path: "../SKILL.md", content: skill() },
      { path: "assets/icon.bin", content: Buffer.from([0, 1, 2]) },
      { path: "notes.md", content: "No root instructions." },
    ],
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.diagnostics.map((entry) => entry.code).sort(), [
    "binary_content_not_allowed",
    "package_path_invalid",
    "skill_file_missing",
  ]);

  const invalidFrontmatter = inspectSkillPackage({
    files: [{ path: "SKILL.md", content: "---\nname: Not Normalized\nunknown: true\n---\n" }],
  });
  assert.equal(invalidFrontmatter.status, "failed");
  assert.ok(invalidFrontmatter.diagnostics.some((entry) => entry.code === "skill_name_invalid"));
  assert.ok(invalidFrontmatter.diagnostics.some((entry) => entry.code === "skill_frontmatter_invalid"));
});

test("Skill package inspection blocks credentials and dangerous scripts while preserving a reviewable executable inventory", () => {
  const result = inspectSkillPackage({
    files: [
      { path: "SKILL.md", content: skill() },
      { path: "scripts/run.sh", content: "#!/bin/sh\ncurl https://example.invalid\nAPI_KEY=abcdefghijklmnopqrstuvwxyz012345" },
    ],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.inventory.find((entry) => entry.path === "scripts/run.sh").kind, "executable");
  assert.ok(result.diagnostics.some((entry) => entry.code === "executable_content_requires_isolation"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "dangerous_script_pattern"));
  assert.ok(result.diagnostics.some((entry) => entry.code === "secret_detected"));
});

test("Skill frontmatter validation follows PI 0.75.5 limits and boolean semantics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "looloomi-pi-skill-parity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: "name-64", skillName: "a".repeat(64), description: "valid", flag: "true", product: "passed", piWarning: null, disabled: true },
    { name: "name-65", skillName: "a".repeat(65), description: "valid", flag: "true", product: "failed", piWarning: "name exceeds 64", disabled: true },
    { name: "description-1024", skillName: "valid-name", description: "d".repeat(1024), flag: "false", product: "passed", piWarning: null, disabled: false },
    { name: "description-1025", skillName: "valid-name", description: "d".repeat(1025), flag: "false", product: "failed", piWarning: "description exceeds 1024", disabled: false },
    { name: "consecutive-hyphens", skillName: "bad--name", description: "valid", flag: "true", product: "failed", piWarning: "consecutive hyphens", disabled: true },
    { name: "quoted-boolean", skillName: "valid-name", description: "valid", flag: '"true"', product: "failed", piWarning: null, disabled: false },
  ];

  for (const item of cases) {
    const directory = join(root, item.name);
    await mkdir(directory);
    const source = `---\nname: ${item.skillName}\ndescription: ${item.description}\ndisable-model-invocation: ${item.flag}\n---\n`;
    await writeFile(join(directory, "SKILL.md"), source);

    const product = inspectSkillPackage({ files: [{ path: "SKILL.md", content: source }] });
    const pi = loadSkillsFromDir({ dir: directory, source: "path" });
    assert.equal(product.status, item.product, item.name);
    assert.equal(pi.skills[0]?.disableModelInvocation, item.disabled, item.name);
    if (item.piWarning) {
      assert.ok(pi.diagnostics.some((entry) => entry.message.includes(item.piWarning)), item.name);
    } else {
      assert.equal(pi.diagnostics.length, 0, item.name);
    }
  }
});

test("runtime manifest inspection rejects unsupported and duplicate declarations", () => {
  const script = "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n";
  const cases = [
    ["missing", null, "skill_runtime_manifest_missing"],
    ["unknown", runtimeManifest.replace('"runtime":', '"unknown":true,"runtime":'), "skill_runtime_manifest_invalid"],
    ["duplicate", runtimeManifest.replace('"entrypoint":', '"runtime":"python3.12","entrypoint":'), "skill_runtime_manifest_invalid"],
    ["network", runtimeManifest.replace('"network":false', '"network":true'), "skill_runtime_manifest_invalid"],
  ];
  for (const [name, manifest, expectedCode] of cases) {
    const result = inspectSkillPackage({
      files: [
        { path: "SKILL.md", content: skill() },
        ...(manifest ? [{ path: "skill.runtime.json", content: manifest }] : []),
        { path: "scripts/main.py", content: script },
      ],
    });
    assert.equal(result.status, "failed", name);
    assert.ok(result.diagnostics.some((entry) => entry.code === expectedCode), name);
  }
});

test("valid executable inspection retains the validated runtime manifest", () => {
  const result = inspectSkillPackage({
    files: [
      { path: "SKILL.md", content: skill() },
      { path: "skill.runtime.json", content: runtimeManifest },
      { path: "scripts/main.py", content: "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n" },
    ],
  });
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.manifest.runtime, {
    runtime: "python3.12",
    entrypoint: "scripts/main.py",
    protocol: { stdin: "json", stdout: "json" },
    permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
  });
});
