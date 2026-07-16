import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildCapabilityLoopReadModel,
  classifyCapabilityLoop,
  publicCapabilityPackagesForLoop,
  writeCapabilityLoopReadModels,
} from "./capability-loop-read-model.mjs";

assert.equal(classifyCapabilityLoop({
  prompt: "Run NVDA earnings review",
  tools: [],
  selectedCapabilityIDs: ["markets-research"],
}), "markets_research_loop");

assert.equal(classifyCapabilityLoop({
  prompt: "整理会议纪要",
  tools: [],
  selectedCapabilityIDs: ["office-meeting-agent"],
}), "office_work_loop");

{
  const packages = publicCapabilityPackagesForLoop({
    loopType: "markets_research_loop",
    tools: [],
    selectedCapabilityIDs: ["markets-research"],
  });
  assert.deepEqual(packages.map((item) => item.packageID), ["markets-research"]);
}

{
  const model = buildCapabilityLoopReadModel({
    runID: "run-test",
    taskID: "task-test",
    sessionID: "session-test",
    prompt: "Analyze NVDA earnings",
    tools: ["markets.equity_research.draft"],
    selectedCapabilityIDs: ["markets-research"],
    finalReadModel: { status: "completed", artifactPath: "runtime/agent/runs/run-test/agent-final-read-model.json" },
  });
  assert.equal(model.schemaVersion, "agent-capability-loop-read-model-v1");
  assert.equal(model.loopType, "markets_research_loop");
  assert.equal(model.capabilityPackages[0]?.packageID, "markets-research");
  assert.ok(model.followUpSuggestions.some((item) => item.suggestionID === "markets-review-task"));
}

{
  const runDir = mkdtempSync(join(tmpdir(), "capability-loop-core-"));
  const events = [];
  const ledger = [];
  const result = writeCapabilityLoopReadModels(runDir, {
    runID: "run-core",
    taskID: "task-core",
    sessionID: "session-core",
    prompt: "BTC market loop",
    tools: ["cmc.crypto_macro_overview"],
    selectedCapabilityIDs: ["cmc-skill-hub"],
    selectedSkillIDs: [],
    selectedExtensionIDs: [],
    finalReadModel: {
      status: "completed",
      finalText: "## 结论\nCore loop test",
      artifactPath: "runtime/agent/runs/run-core/agent-final-read-model.json",
    },
    projectRoot: runDir,
    agentRuntimeRoot: runDir,
    writeJSON: (path, value) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    appendEvent: (_runDir, event) => events.push(event),
    appendInvocationLedger: (_runDir, event) => ledger.push(event),
  });
  assert.equal(result.capabilityLoop.loopType, "crypto_market_loop");
  assert.equal(result.memoryReadModel.coreContract.schemaVersion, "core-memory-contract-summary-v1");
  assert.equal(result.subagentCoordination.coreContract.schemaVersion, "core-subagent-contract-summary-v1");
  assert.ok(events.some((event) => event.type === "capability.loop_read_model.created"));
  assert.ok(ledger.some((event) => event.type === "capability_loop_recorded"));
  const memory = JSON.parse(readFileSync(join(runDir, "memory-read-model.json"), "utf8"));
  assert.equal(memory.coreContract.owner, "Agent Runtime Core");
}

console.log("agent_runtime_core_capability_loop=pass");
