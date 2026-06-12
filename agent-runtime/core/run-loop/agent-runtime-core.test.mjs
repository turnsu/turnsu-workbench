import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAgentRuntimeCore } from "./agent-runtime-core.mjs";
import { cmcToolSelectionDiagnostic, inferTools } from "../router/tool-router.mjs";

const capabilityCatalog = JSON.parse(
  readFileSync(new URL("../../runtime/capability-catalog.json", import.meta.url), "utf8"),
);

const core = createAgentRuntimeCore({
  capabilityCatalog,
  router: { inferTools, cmcToolSelectionDiagnostic },
  gateEngine: {},
  piKernel: {},
  finalOutput: {},
  artifacts: {},
});

function toolsFor(request) {
  return core.planTools({ projectToolNames: [], ...request });
}

{
  const plan = toolsFor({
    prompt: "Run a company deep dive and earnings review.",
    selectedCapabilityIDs: ["markets-research"],
  });
  assert.equal(plan.compatibilityMode, "capability_catalog_v1");
  assert.deepEqual(plan.resolvedCapabilityIDs, ["markets-research"]);
  assert.equal(plan.unknownCapabilityIDs.length, 0);
  assert.ok(plan.legacySelectedSkillIDs.includes("equity-company-deep-dive"));
  assert.ok(plan.legacySelectedExtensionIDs.includes("markets-research"));
  assert.ok(plan.tools.includes("markets.equity_dispatcher.plan"));
  assert.ok(plan.tools.includes("markets.equity_research.draft"));
  assert.ok(plan.tools.includes("markets.provider.drillr_deferred"));
  assert.ok(!plan.tools.includes("wechat.read_normalized_messages"));
  assert.ok(!plan.tools.includes("proposal.create"));
}

{
  const plan = toolsFor({
    prompt: "把这份会议材料整理成纪要和文档草稿。",
    selectedCapabilityIDs: ["office-meeting-agent"],
  });
  assert.deepEqual(plan.resolvedCapabilityIDs, ["office-meeting-agent"]);
  assert.ok(plan.legacySelectedSkillIDs.includes("meeting-minutes"));
  assert.ok(plan.legacySelectedExtensionIDs.includes("office-meeting-agent"));
  assert.ok(plan.tools.includes("office.meeting_minutes.draft"));
  assert.ok(plan.tools.includes("office.document.draft"));
  assert.ok(plan.tools.includes("office.document_revision.draft"));
  assert.ok(plan.tools.includes("channel.feishu.dry_run"));
}

{
  const plan = toolsFor({
    prompt: "复核 BTC 宏观 thesis，覆盖 ETF、跨资产相关性和反证。",
    selectedCapabilityIDs: ["cmc-skill-hub"],
  });
  assert.deepEqual(plan.resolvedCapabilityIDs, ["cmc-skill-hub"]);
  assert.ok(plan.legacySelectedSkillIDs.includes("cmc-market-radar"));
  assert.ok(plan.legacySelectedExtensionIDs.includes("cmc-skill-hub"));
  assert.ok(plan.tools.includes("cmc.crypto_macro_overview"));
  assert.ok(plan.tools.includes("market.read_snapshot"));
  assert.equal(plan.diagnostics.promptIntent, "macro_thesis");
  assert.equal(plan.diagnostics.preferredTool, "cmc.crypto_macro_overview");
  assert.ok(!plan.tools.includes("cmc.track_social_price_divergence"));
}

{
  const plan = toolsFor({
    prompt: "Unknown capability should be diagnosable.",
    selectedCapabilityIDs: ["not-a-real-capability"],
  });
  assert.equal(plan.compatibilityMode, "capability_catalog_v1");
  assert.deepEqual(plan.resolvedCapabilityIDs, []);
  assert.deepEqual(plan.unknownCapabilityIDs, ["not-a-real-capability"]);
}

console.log("agent_runtime_core_route_plan=pass");
