import assert from "node:assert/strict";

import { inspectSkillPackage } from "../../../../../backend/code/workbench-server/src/validation/skill-package-inspector.mjs";
import {
  createSkillRuntimeCatalog,
  scaffoldSkillDraftPackage,
} from "../../../../../backend/code/workbench-server/src/skills/skill-runtime-catalog.mjs";
import {
  packageSize,
  registeredToolSkillPackage,
  smokeTestInputJson,
} from "../src/components/skills/draft-skill-package.js";

const feedbackSchema = { type: "object", properties: { feedback: { type: "string" } } };
assert.deepEqual(JSON.parse(smokeTestInputJson('{"feedback":"上传后没有反馈"}', feedbackSchema)), { feedback: "上传后没有反馈" });
assert.deepEqual(JSON.parse(smokeTestInputJson("上传后没有反馈", feedbackSchema)), { feedback: "上传后没有反馈" });

const definition = {
  name: "Quarterly summary",
  description: "Summarize a quarterly update.",
  category: "research",
  tags: ["summary", "internal"],
  materials: [{
    name: "source",
    description: "Quarterly source material.",
    required: true,
  }],
  parameters: [],
  outputs: [{
    name: "result",
    description: "A concise decision summary.",
    type: "json",
  }],
  smoke: {
    purpose: "Summarize one quarterly update.",
    input: "A short quarterly report.",
    expectedOutcome: "A JSON result with the key decisions.",
  },
};
const digest = (character) => `runtime.example/skill@sha256:${character.repeat(64)}`;
const runtimeCatalog = createSkillRuntimeCatalog({
  pythonImage: digest("a"),
  nodeImage: digest("b"),
});

const prompt = scaffoldSkillDraftPackage({
  data: { ...definition, definitionType: "prompt" },
  runtimeCatalog,
}).files;
assert.deepEqual(prompt.map((file) => file.path), ["SKILL.md"]);
assert.ok(packageSize(prompt) > 0);
const promptInspection = inspectSkillPackage({ files: decode(prompt) });
assert.equal(promptInspection.status, "passed");
assert.equal(promptInspection.manifest.name, "quarterly-summary");
assert.equal(promptInspection.manifest.inputs[0].name, "source");
assert.equal(promptInspection.manifest.outputs[0].name, "result");

const script = scaffoldSkillDraftPackage({
  data: {
    ...definition,
    definitionType: "script",
    runtime: { runtimeId: "python3.12", timeoutSeconds: 30, memoryMiB: 128 },
  },
  runtimeCatalog,
}).files;
assert.deepEqual(script.map((file) => file.path), ["SKILL.md", "skill.runtime.json", "scripts/main.py"]);
assert.ok(packageSize(script) > packageSize(prompt));
const scriptInspection = inspectSkillPackage({ files: decode(script) });
assert.equal(scriptInspection.status, "needs_review");
assert.equal(scriptInspection.manifest.runtime.runtime, "python3.12");
assert.ok(scriptInspection.diagnostics.some((item) => item.code === "executable_content_requires_isolation"));

const nodeScript = scaffoldSkillDraftPackage({
  data: {
    ...definition,
    definitionType: "script",
    runtime: { runtimeId: "nodejs20-typescript", timeoutSeconds: 75, memoryMiB: 384 },
  },
  runtimeCatalog,
}).files;
assert.deepEqual(nodeScript.map((file) => file.path), ["SKILL.md", "skill.runtime.json", "scripts/main.ts"]);
const nodeInspection = inspectSkillPackage({ files: decode(nodeScript) });
assert.equal(nodeInspection.status, "needs_review");
assert.equal(nodeInspection.manifest.runtime.runtime, "nodejs20-typescript");
assert.deepEqual(nodeInspection.manifest.runtime.limits, {
  timeoutSeconds: 75,
  memoryMiB: 384,
});

const registeredTool = registeredToolSkillPackage({
  toolPackageId: "registered:lark-task",
  skillName: "lark-task",
  label: "Lark Tasks",
  description: "Read assigned tasks and create governed follow-up tasks after confirmation.",
  registrationStatus: "registered",
  actions: [
    { actionId: "lark.task.create", effect: "write", confirmationRequired: true },
    { actionId: "lark.task.list_mine", effect: "read", confirmationRequired: false },
  ],
});
assert.deepEqual(registeredTool.map((file) => file.path), ["SKILL.md"]);
const toolInspection = inspectSkillPackage({ files: decode(registeredTool) });
assert.equal(toolInspection.status, "passed");
assert.equal(toolInspection.manifest.name, "lark-task");
assert.deepEqual(toolInspection.manifest.tools, [
  { action: "lark.task.create", effect: "write", confirm: true },
  { action: "lark.task.list_mine", effect: "read", confirm: false },
]);
const toolMarkdown = Buffer.from(registeredTool[0].contentBase64, "base64").toString("utf8");
assert.doesNotMatch(toolMarkdown, /\b(command|args|secret|credential)\s*:/i);
assert.throws(
  () => registeredToolSkillPackage({
    skillName: "unregistered",
    description: "Untrusted tool.",
    registrationStatus: "pending",
    actions: [{ actionId: "tool.action", effect: "read", confirmationRequired: false }],
  }),
  { message: "registered_tool_package_invalid" },
);

assert.throws(
  () => scaffoldSkillDraftPackage({
    data: {
      ...definition,
      definitionType: "script",
      runtime: { runtimeId: "unknown-runtime", timeoutSeconds: 30, memoryMiB: 128 },
    },
    runtimeCatalog,
  }),
  { message: "The selected Skill runtime does not exist." },
);
console.log("skill definition package smoke passed");

function decode(files) {
  return files.map((file) => ({
    path: file.path,
    content: Buffer.from(file.contentBase64, "base64"),
  }));
}
