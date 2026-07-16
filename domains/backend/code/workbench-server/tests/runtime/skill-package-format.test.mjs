import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExecutableSkillPackage,
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  parseSkillPackage,
  SkillPackageFormatError,
} from "../../src/skills/index.mjs";

const skill = `---\nname: executable-proof\ndescription: Prove isolated execution.\ndisable-model-invocation: true\n---\n`;
const script = "import json, sys\njson.dump(json.load(sys.stdin), sys.stdout)\n";
const runtimeManifest = `${JSON.stringify({
  runtime: "python3.12",
  entrypoint: "scripts/main.py",
  protocol: { stdin: "json", stdout: "json" },
  permissions: { network: false, connections: [], externalActions: false, filesystem: "scratch-only" },
}, null, 2)}\n`;

test("V1 Skill packages have deterministic canonical bytes and content addresses", () => {
  const bytes = formatSkillPackage([
    { path: "scripts/main.py", content: script },
    { path: "skill.runtime.json", content: runtimeManifest },
    { path: "SKILL.md", content: skill },
  ]);
  const same = formatSkillPackage([
    { path: "SKILL.md", content: Buffer.from(skill) },
    { path: "skill.runtime.json", content: Buffer.from(runtimeManifest) },
    { path: "scripts/main.py", content: Buffer.from(script) },
  ]);

  assert.deepEqual(bytes, same);
  assert.equal(bytes.at(-1), 10);
  assert.match(hashSkillPackageObject(bytes), /^sha256:[a-f0-9]{64}$/);
  assert.equal(objectIdForSkillPackage(bytes), `object-${hashSkillPackageObject(bytes).slice(7)}`);

  const files = parseSkillPackage(bytes);
  assertExecutableSkillPackage(files);
  assert.deepEqual(
    new Set(files.map((file) => file.path)),
    new Set(["SKILL.md", "skill.runtime.json", "scripts/main.py"]),
  );
  assert.equal(files.find((file) => file.path === "scripts/main.py").content.toString("utf8"), script);
});

test("V1 parser rejects non-canonical, duplicate, and expanded executable packages", () => {
  const canonical = formatSkillPackage([
    { path: "SKILL.md", content: skill },
    { path: "skill.runtime.json", content: runtimeManifest },
    { path: "scripts/main.py", content: script },
  ]);
  const nonCanonical = Buffer.from(canonical.toString("utf8").trimEnd(), "utf8");
  assert.throws(
    () => parseSkillPackage(nonCanonical),
    (error) => error instanceof SkillPackageFormatError && error.code === "skill_package_not_canonical",
  );

  const duplicate = Buffer.from(`${JSON.stringify({
    format: "workbench-skill-package-v1",
    files: [
      { path: "SKILL.md", content: Buffer.from(skill).toString("base64") },
      { path: "SKILL.md", content: Buffer.from(skill).toString("base64") },
    ],
  })}\n`);
  assert.throws(
    () => parseSkillPackage(duplicate),
    (error) => error instanceof SkillPackageFormatError && error.code === "skill_package_invalid",
  );

  const expanded = parseSkillPackage(formatSkillPackage([
    { path: "SKILL.md", content: skill },
    { path: "skill.runtime.json", content: runtimeManifest },
    { path: "references/data.txt", content: "not executable" },
    { path: "scripts/main.py", content: script },
  ]));
  assert.throws(
    () => assertExecutableSkillPackage(expanded),
    (error) => error instanceof SkillPackageFormatError && error.code === "skill_package_contract_unsupported",
  );
});

test("executable package runtime manifests reject unknown, duplicate, and unsupported fields", () => {
  const cases = [
    ["missing", null, "skill_package_contract_unsupported"],
    ["unknown root field", runtimeManifest.replace('"runtime":', '"unknown": true,\n  "runtime":'), "skill_runtime_manifest_invalid"],
    ["duplicate root field", runtimeManifest.replace('"entrypoint":', '"runtime": "python3.12",\n  "entrypoint":'), "skill_runtime_manifest_invalid"],
    ["unsupported runtime", runtimeManifest.replace("python3.12", "python3.11"), "skill_runtime_manifest_invalid"],
    ["unsupported entrypoint", runtimeManifest.replace("scripts/main.py", "scripts/other.py"), "skill_runtime_manifest_invalid"],
    ["network requested", runtimeManifest.replace('"network": false', '"network": true'), "skill_runtime_manifest_invalid"],
    ["connection requested", runtimeManifest.replace('"connections": []', '"connections": ["crm"]'), "skill_runtime_manifest_invalid"],
    ["external action requested", runtimeManifest.replace('"externalActions": false', '"externalActions": true'), "skill_runtime_manifest_invalid"],
    ["non scratch filesystem", runtimeManifest.replace("scratch-only", "workspace-write"), "skill_runtime_manifest_invalid"],
  ];

  for (const [name, manifest, code] of cases) {
    const files = [
      { path: "SKILL.md", content: skill },
      ...(manifest === null ? [] : [{ path: "skill.runtime.json", content: manifest }]),
      { path: "scripts/main.py", content: script },
    ];
    assert.throws(
      () => assertExecutableSkillPackage(parseSkillPackage(formatSkillPackage(files))),
      (error) => error instanceof SkillPackageFormatError && error.code === code,
      name,
    );
  }
});
