import assert from "node:assert/strict";

import {
  buildDegradedMarketFinalText,
  buildDeterministicAssistantText,
  isMarketSensitiveRun,
  shouldIncludeSafetyBoundary,
} from "./deterministic-final-copy.mjs";

function deps(overrides = {}) {
  return {
    cmcFreshnessGate: () => ({
      provider: "mcpProvider",
      freshness: "fresh",
      allowConcretePrices: false,
      allowResearchConclusion: false,
      researchEvidenceStatus: "empty",
      priceSnapshotStatus: "empty",
      reason: "degraded_empty_evidence",
    }),
    buildCMCCapabilitySummary: () => ({
      mountStatus: "mounted",
      transportStatus: "ok",
      allowSkillHubResultDisplay: false,
      skillHubDisplayStatus: "missing",
      displayableResultText: null,
      parserEvidenceStatus: "missing",
      allowSkillHubReturnedPrices: false,
      priceSnapshotStatus: "empty",
      allowConcretePrices: false,
    }),
    displayGateReason: (reason) => reason || "gate blocked",
    displayProvider: (provider) => provider === "mcpProvider" ? "CoinMarketCap MCP" : "市场数据源",
    displayFreshness: (freshness) => freshness === "fresh" ? "最新" : "缺失",
    redact: (value) => String(value || ""),
    publicSkillHubSummary: (value) => String(value || ""),
    cmcCapabilitySummaryLine: () => "CMC Skill Hub 能力包：已挂载，transport ok，结果可展示，价格为空。",
    ...overrides,
  };
}

{
  const text = buildDeterministicAssistantText({
    prompt: "Analyze MSFT earnings and sector read-through",
    tools: ["markets.equity_research.draft"],
    policies: [],
    attachments: [],
    toolObservations: {
      marketsResearch: {
        summary: { providerDeferredReason: "drillr provider deferred" },
        gate: {
          promptFrameworkStatus: "usable",
          researchEvidenceStatus: "empty_provider_evidence",
          priceSnapshotStatus: "provider_deferred",
        },
      },
    },
  }, deps());
  assert.match(text, /Markets Research 能力包/);
  assert.match(text, /未接入股票 provider evidence/);
  assert.doesNotMatch(text, /\b(?:BUY|HOLD|SELL)\b/i);
  assert.doesNotMatch(text, /markets\.equity/i);
}

{
  const text = buildDeterministicAssistantText({
    prompt: "帮我复核 BTC thesis",
    tools: ["cmc.crypto_macro_overview"],
    policies: [],
    attachments: [],
    toolObservations: {
      cmcFreshnessGate: {
        provider: "mcpProvider",
        freshness: "fresh",
        allowConcretePrices: false,
        researchEvidenceStatus: "empty",
        priceSnapshotStatus: "empty",
      },
      cmcSkillHub: {
        observations: [{
          status: "ok",
          confidence: "medium",
          summary: "BTC is trading near 69,000 while ETF flow remains mixed.",
        }],
      },
    },
  }, deps({
    buildCMCCapabilitySummary: () => ({
      mountStatus: "mounted",
      transportStatus: "ok",
      allowSkillHubResultDisplay: true,
      skillHubDisplayStatus: "usable",
      displayableResultText: "BTC is trading near 69,000 while ETF flow remains mixed.",
      parserEvidenceStatus: "empty",
      allowSkillHubReturnedPrices: true,
      priceSnapshotStatus: "empty",
      allowConcretePrices: false,
    }),
  }));
  assert.match(text, /Skill Hub 返回/);
  assert.match(text, /69,000/);
  assert.match(text, /未获得 App 可引用价格快照/);
  assert.doesNotMatch(text, /## 安全边界/);
}

{
  const quietText = buildDeterministicAssistantText({
    prompt: "复核 BTC thesis",
    tools: ["cmc.crypto_macro_overview"],
    policies: [],
    attachments: [],
    toolObservations: null,
  }, deps());
  assert.doesNotMatch(quietText, /## 安全边界/);

  const highImpactText = buildDeterministicAssistantText({
    prompt: "复核后发送微信",
    tools: ["cmc.crypto_macro_overview", "wechat_cli.live_command"],
    policies: [{ action: "send_message", status: "blocked" }],
    attachments: [],
    toolObservations: null,
  }, deps());
  assert.match(highImpactText, /## 安全边界/);
  assert.match(highImpactText, /send_message/);
}

{
  const text = buildDegradedMarketFinalText({
    prompt: "BTC price levels",
    tools: ["cmc.crypto_macro_overview"],
    toolObservations: {
      cmcFreshnessGate: {
        provider: "mcpProvider",
        freshness: "fresh",
        allowConcretePrices: false,
        researchEvidenceStatus: "empty",
        priceSnapshotStatus: "empty",
        reason: "degraded_empty_evidence",
      },
    },
  }, deps({
    buildCMCCapabilitySummary: () => ({
      allowSkillHubResultDisplay: true,
      displayableResultText: "BTC is trading near 69,000.",
      allowSkillHubReturnedPrices: true,
      parserEvidenceStatus: "empty",
    }),
  }));
  assert.match(text, /Skill Hub 返回/);
  assert.match(text, /69,000/);
  assert.match(text, /不新增关键价位/);
}

assert.equal(isMarketSensitiveRun("MSFT earnings thesis", []), true);
assert.equal(shouldIncludeSafetyBoundary("写会议纪要", [], []), false);
assert.equal(shouldIncludeSafetyBoundary("发布到飞书", [], []), true);

console.log("agent_runtime_core_deterministic_final_copy=pass");
