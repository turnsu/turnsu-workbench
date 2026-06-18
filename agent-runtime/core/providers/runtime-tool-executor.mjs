import { CLOUD_ASR_TOOL_NAME, executeCloudASRTranscription } from "./cloud-asr-provider.mjs";

export const cmcRuntimeToolNames = new Set([
  "cmc.live_market_refresh",
  "cmc.daily_market_overview",
  "cmc.crypto_macro_overview",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.classify_kline_pattern_quality",
  "cmc.read_market_evidence",
  "cmc.request_mcp_refresh",
]);

export async function executeRuntimeToolViaCore(toolName, params = {}, {
  refreshCMCLive,
  piKernel,
  cmcDefaultSymbols = ["BTC", "ETH", "SOL"],
} = {}) {
  if (toolName === CLOUD_ASR_TOOL_NAME) {
    return executeCloudASRTranscription(params);
  }
  if (cmcRuntimeToolNames.has(toolName)) {
    if (typeof refreshCMCLive !== "function") throw new Error("core_provider_missing_cmc_refresh");
    const result = await refreshCMCLive({
      symbols: extractSymbolsFromPrompt(params.prompt, cmcDefaultSymbols),
      prompt: params.prompt,
      runID: params.runID,
      toolName,
      skill: cmcSkillForTool(toolName),
    });
    const skillHub = result.skillHubResult || null;
    return {
      status: result.status === "ok" ? "completed" : "degraded",
      toolName,
      outputSummary: skillHub
        ? `CMC Skill Hub skill ${skillHub.skill} ${result.status}; ${skillHub.status}${skillHub.confidence ? `/${skillHub.confidence}` : ""}; ${skillHub.summary}`
        : result.artifact
          ? `CMC provider ${result.provider} ${result.status}; ${result.assets || 0} asset(s), artifact ${result.artifact}.`
          : `CMC provider ${result.provider || "unknown"} ${result.status}; ${result.reason || "provider unavailable"}.`,
      details: {
        status: result.status,
        provider: result.provider,
        providerType: result.providerType,
        protocol: result.protocol,
        skill: result.skill || cmcSkillForTool(toolName),
        artifactPath: result.artifact,
        skillHubResult: skillHub,
        summary: result,
      },
    };
  }
  if (!piKernel || typeof piKernel.executeTool !== "function") throw new Error("core_provider_missing_pi_kernel");
  return piKernel.executeTool(toolName, params);
}

export function extractSymbolsFromPrompt(prompt, fallbackSymbols = ["BTC", "ETH", "SOL"]) {
  const matches = String(prompt || "").toUpperCase().match(/\b[A-Z0-9]{2,10}\b/g) || [];
  const excluded = new Set([
    "A", "AN", "AND", "API", "CMC", "CVD", "DATA", "ETF", "FLOW", "FOR", "FOMO",
    "MACRO", "MARKET", "MCP", "OI", "PRICE", "REVIEW", "RISK", "THE", "THESIS",
    "USD", "WITH", "BTCUSD", "ETHUSD",
  ]);
  const symbols = matches.filter((item) => !excluded.has(item)).slice(0, 10);
  return symbols.length ? symbols : fallbackSymbols;
}

export function cmcSkillForTool(toolName, fallback = "daily_market_overview") {
  switch (toolName) {
    case "cmc.crypto_macro_overview":
      return "crypto_macro_overview";
    case "cmc.detect_market_regime":
      return "detect_market_regime";
    case "cmc.track_social_price_divergence":
      return "track_social_price_divergence";
    case "cmc.classify_kline_pattern_quality":
      return "classify_kline_pattern_quality";
    case "cmc.daily_market_overview":
    case "cmc.live_market_refresh":
    case "cmc.read_market_evidence":
    case "cmc.request_mcp_refresh":
      return "daily_market_overview";
    default:
      return fallback;
  }
}
