import assert from "node:assert/strict";
import test from "node:test";

import {
  Check,
  ImportServerSkillsRequestSchema,
  ScanServerSkillsRequestSchema,
  WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS,
} from "../dist/index.js";

test("server Skill import endpoints are authenticated browser mutations with bounded selections", () => {
  assert.equal(WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS.scanServerSkills.method, "POST");
  assert.deepEqual(WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS.scanServerSkills.requiredRequestHeaders, []);
  assert.deepEqual(
    WORKBENCH_V1_SKILL_IMPORT_ENDPOINTS.importServerSkills.requiredRequestHeaders,
    ["Idempotency-Key"],
  );
  assert.equal(Check(ScanServerSkillsRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { rootPath: "/srv/skills" },
  }), true);
  assert.equal(Check(ImportServerSkillsRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: {
      rootPath: "/srv/skills",
      directories: ["lark-calendar", "lark-task"],
      attachBuiltInToolPolicy: true,
    },
  }), true);
  assert.equal(Check(ImportServerSkillsRequestSchema, {
    schemaVersion: "workbench-api-v1",
    data: { rootPath: "/srv/skills", directories: ["../escape"] },
  }), false);
});
