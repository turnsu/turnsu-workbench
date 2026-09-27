import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
  MEETING_ACTION_EXTRACTOR_SKILL_ID,
} from "../extensions/meeting-action-extractor/binding.mjs";
import { createLegacyAgentRuntimeBundle } from "../../../../backend/code/workbench-server/src/runtime/index.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(testDirectory, "..");

test("meeting action extractor is a first-party Kernel plugin, not a Pi extension", async (context) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "looloomi-business-skill-"));
  const bundle = createLegacyAgentRuntimeBundle({
    env: {
      ...process.env,
      WORKBENCH_TEST_MODE: "1",
      WORKBENCH_TEST_BUSINESS_SKILL: "1",
      WECHAT_AGENT_TEST_MODE: "1",
      WECHAT_AGENT_RUNTIME_ROOT: runtimeRoot,
    },
  });
  context.after(async () => {
    await bundle.dispose();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });

  assert.deepEqual(await bundle.agentRuntime.probeSkill(MEETING_ACTION_EXTRACTOR_EXECUTION_REF), {
    status: "ready",
    ready: true,
    code: "first_party_meeting_ready",
  });
  const output = await bundle.agentRuntime.invokeSkillNode({
    invocationId: "business-skill-proof",
    executionRef: MEETING_ACTION_EXTRACTOR_EXECUTION_REF,
    input: {
      transcript: "Mia will send the draft on Friday. The team discussed the roadmap. TODO: Leo should confirm the launch owner.",
    },
  });
  assert.deepEqual(output, {
    actionItems: [
      { text: "Mia will send the draft on Friday." },
      { text: "TODO: Leo should confirm the launch owner." },
    ],
    summary: "2 follow-up actions found.",
  });
  assert.equal(existsSync(join(runtimeRoot, "agent", "pi-agent-home")), false,
    "the deterministic Product Skill did not create a Pi session cache");
  assert.equal(MEETING_ACTION_EXTRACTOR_SKILL_ID, "meeting-action-extractor");

  const compositionSource = readFileSync(
    resolve(agentRuntimeRoot, "../../../backend/code/workbench-server/src/runtime/legacy-pi-runtime-bundle.mjs"),
    "utf8",
  );
  assert.doesNotMatch(compositionSource, /meeting-action-extractor\/extension\.ts/);
});
