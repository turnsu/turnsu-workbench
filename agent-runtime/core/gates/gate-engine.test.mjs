import assert from "node:assert/strict";

import { createGateEngine } from "./gate-engine.mjs";

const gateEngine = createGateEngine({
  now: () => "2026-06-12T00:00:00.000Z",
  stripProcessPreamble: (text) => String(text || ""),
  internalSurfaceViolations: (text) => (/Skill:\s*cmc-skill-hub/i.test(text) ? ["raw_skill_id"] : []),
  stripInternalSurface: (text) => String(text || "").split(/\r?\n/).filter((line) => !/Skill:\s*cmc-skill-hub/i.test(line)).join("\n").trim(),
  isMarketSensitiveRun: () => false,
  skillHubReturnedTextCorpus: () => "",
  concreteMarketViolations: () => [],
  stripConcreteMarketViolationLines: (text) => text,
  degradedMarketFinalText: () => "degraded market final",
});

{
  const result = gateEngine.guardFinalOutput({
    text: "Skill: cmc-skill-hub",
    prompt: "status",
    tools: [],
    toolObservations: { cmcFreshnessGate: { allowConcretePrices: false } },
  });
  assert.equal(result.outputGuard.status, "rewritten");
  assert.equal(result.outputGuard.reason, "raw_internal_fields_removed");
  assert.match(result.text, /内部运行时字段/);
  assert.doesNotMatch(result.text, /Skill:/);
  assert.doesNotMatch(result.text, /degraded market final/);
}

{
  const policy = gateEngine.productMutationPolicyForRun({
    cmcFreshnessGate: {
      researchEvidenceStatus: "empty",
      priceSnapshotStatus: "empty",
      allowSkillHubResultDisplay: true,
    },
    outputGuard: { status: "passed" },
  });
  assert.equal(policy.status, "discarded");
  assert.equal(policy.decisionClass, "MutationCommitDecision");
  assert.equal(policy.reason, "price_snapshot_empty_or_parser_evidence_empty");
}

console.log("agent_runtime_core_gate_engine=pass");
