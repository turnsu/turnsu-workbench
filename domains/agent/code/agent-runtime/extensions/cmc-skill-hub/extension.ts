import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimePaths } from "../../lib/runtime-paths.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const { marketRoot, runsRoot } = runtimePaths;
const marketSnapshotPath = join(marketRoot, "latest-market-snapshot.json");
const normalizedInputPath = join(marketRoot, "cmc-skill-hub.normalized.json");

const TOOL_PARAMS = Type.Object({
  runID: Type.String(),
  sessionID: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  contextRefs: Type.Optional(Type.Array(Type.Any())),
  symbol: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
});

function now() {
  return new Date().toISOString();
}

function readJSON(path: string, fallback: any = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function runArtifact(runID: string, name: string) {
  return join(runsRoot, String(runID).replace(/[^A-Za-z0-9_.-]/g, "_"), name);
}

function fixtureEvidence() {
  return readJSON(join(extensionDir, "fixtures", "market-evidence.sample.json"), { status: "degraded", watchlist: [] });
}

function providerEvidence() {
  if (existsSync(normalizedInputPath)) {
    const evidence = readJSON(normalizedInputPath, fixtureEvidence());
    return {
      provider: "normalizedFileProvider",
      evidence: {
        ...evidence,
        provider: "normalizedFileProvider",
        status: "degraded",
        freshness: evidence?.freshness === "fixture" ? "fixture" : "degraded",
      },
    };
  }
  return { provider: "fixtureProvider", evidence: fixtureEvidence() };
}

function marketSnapshotFromEvidence(evidence: any, provider: string) {
  const generatedAt = evidence.generatedAt || evidence.observedAt || now();
  const expiresAt = evidence.expiresAt || new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const watchlist = Array.isArray(evidence.watchlist) ? evidence.watchlist : [];
  const liveProvider = ["cmcRestProvider", "mcpProvider"].includes(provider);
  const expiresAtMs = Date.parse(expiresAt);
  const fresh = liveProvider && Number.isFinite(expiresAtMs) && expiresAtMs >= Date.now();
  return {
    schemaVersion: "market-data-snapshot-v2",
    status: evidence.status === "ok" && fresh ? "enabled" : "degraded",
    sourceName: `CMC Skill Hub ${provider}`,
    provider,
    generatedAt,
    observedAt: evidence.observedAt || generatedAt,
    expiresAt,
    freshness: provider === "fixtureProvider" ? "fixture" : fresh ? "fresh" : "stale",
    lastVerifiedAt: generatedAt,
    assets: watchlist.map((asset: any) => ({
      symbol: String(asset.symbol || "").toUpperCase(),
      name: String(asset.name || asset.symbol || "Unknown"),
      priceUSD: Number(asset.priceUSD || 0),
      percentChange24h: Number(asset.percentChange24h || 0),
      volume24hUSD: Number(asset.volume24hUSD || 0),
      marketCapUSD: Number(asset.marketCapUSD || 0),
      source: `cmc_skill_hub_${provider}`,
      isLive: fresh,
      observedAt: asset.observedAt || evidence.observedAt || generatedAt,
    })),
    evidence: [
      evidence.market_read?.summary || "CMC Skill Hub evidence normalized locally.",
      ...(evidence.action_guidance || []),
    ],
    upstreamStatus: provider === "fixtureProvider" ? "fixture_provider" : fresh ? "normalized_provider_fresh" : "normalized_provider_stale",
  };
}

function writeCMCArtifacts(runID: string, evidence: any, provider: string, skillName: string) {
  const snapshot = marketSnapshotFromEvidence(evidence, provider);
  writeJSON(marketSnapshotPath, snapshot);
  const result = {
    schemaVersion: "cmc-skill-hub-result-v1",
    runID,
    provider,
    skillName,
    mcpSkillsAvailable: ["daily_market_overview", "detect_market_regime", "build_daily_market_brief", "track_social_price_divergence"],
    mcpProviderStatus: process.env.CMC_MCP_ENABLED === "1" ? "configured_external_connector" : "missing_config_local_provider_used",
    marketSnapshotArtifact: "runtime/market/latest-market-snapshot.json",
    evidence,
    generatedAt: now(),
  };
  writeJSON(runArtifact(runID, `cmc-${skillName}.json`), result);
  return { snapshot, result };
}

export default function registerCMCSkillHubExtension(pi: ExtensionAPI) {
  const registerDelegatedCMCTool = (name: string, skillName: string, description: string) => {
    pi.registerTool({
      name,
      description,
      parameters: TOOL_PARAMS,
      execute: async (_toolCallID: string, params: any) => {
        const request = {
          schemaVersion: "cmc-live-refresh-delegated-v1",
          runID: params.runID,
          status: "delegated_to_daemon",
          provider: "daemonProviderChain",
          skillName,
          artifactPath: `runtime/agent/runs/${params.runID}/tool-calls.json`,
          generatedAt: now(),
        };
        return {
          content: [{ type: "text", text: `${name} is delegated to the daemon CMC provider chain.` }],
          details: { status: "delegated_to_daemon", provider: "daemonProviderChain", skillName, summary: request },
        };
      },
    });
  };

  registerDelegatedCMCTool(
    "cmc.live_market_refresh",
    "daily_market_overview",
    "Refresh CMC data through the daemon provider chain: MCP HTTP, MCP bridge, CMC REST, normalized file, then fixture."
  );
  registerDelegatedCMCTool(
    "cmc.daily_market_overview",
    "daily_market_overview",
    "Run the CoinMarketCap daily market overview provider through the daemon boundary."
  );
  registerDelegatedCMCTool(
    "cmc.crypto_macro_overview",
    "crypto_macro_overview",
    "Run the CoinMarketCap crypto macro overview provider through the daemon boundary."
  );
  registerDelegatedCMCTool(
    "cmc.classify_kline_pattern_quality",
    "classify_kline_pattern_quality",
    "Classify K-line pattern quality through CMC Skill Hub bridge or safe daemon fallback."
  );

  pi.registerTool({
    name: "cmc.read_market_evidence",
    description: "Read CMC Skill Hub style market evidence through fixture or normalized-file provider.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const { provider, evidence } = providerEvidence();
      const { result } = writeCMCArtifacts(params.runID, evidence, provider, "daily_market_overview");
      return {
        content: [{ type: "text", text: `CMC market evidence loaded through ${provider}.` }],
        details: { status: "completed", provider, artifactPath: result.marketSnapshotArtifact, summary: result },
      };
    },
  });

  pi.registerTool({
    name: "cmc.detect_market_regime",
    description: "Normalize CMC market regime evidence without producing trade instructions.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const { provider, evidence } = providerEvidence();
      const regimeEvidence = {
        ...evidence,
        skill: "detect_market_regime",
        market_read: evidence.market_read || { regime: "mixed_transition", conviction: 0.5 },
      };
      const { result } = writeCMCArtifacts(params.runID, regimeEvidence, provider, "detect_market_regime");
      return {
        content: [{ type: "text", text: `CMC regime review: ${regimeEvidence.market_read?.regime || "unknown"}.` }],
        details: { status: "completed", provider, artifactPath: result.marketSnapshotArtifact, summary: result },
      };
    },
  });

  pi.registerTool({
    name: "cmc.track_social_price_divergence",
    description: "Prepare social/price divergence evidence for a symbol using local CMC-style inputs.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const { provider, evidence } = providerEvidence();
      const symbol = String(params.symbol || "BTC").toUpperCase();
      const asset = (evidence.watchlist || []).find((item: any) => String(item.symbol || "").toUpperCase() === symbol) || (evidence.watchlist || [])[0] || {};
      const divergence = {
        ...evidence,
        skill: "track_social_price_divergence",
        divergence: {
          symbol: String(asset.symbol || symbol),
          observation: "Local discussion and fixture market movement are available for research context only.",
          percentChange24h: Number(asset.percentChange24h || 0),
        },
      };
      const { result } = writeCMCArtifacts(params.runID, divergence, provider, "track_social_price_divergence");
      return {
        content: [{ type: "text", text: `CMC social/price divergence prepared for ${divergence.divergence.symbol}.` }],
        details: { status: "completed", provider, artifactPath: result.marketSnapshotArtifact, summary: result },
      };
    },
  });

  pi.registerTool({
    name: "cmc.request_mcp_refresh",
    description: "Compatibility alias for CMC MCP refresh. The daemon treats this as an automatic MCP HTTP / bridge provider refresh, not a user approval request.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const request = {
        schemaVersion: "cmc-mcp-refresh-delegated-v1",
        runID: params.runID,
        status: "delegated_to_daemon",
        candidateSkills: ["daily_market_overview", "detect_market_regime", "build_daily_market_brief", "track_social_price_divergence"],
        reason: "The daemon provider chain performs MCP HTTP, bridge, REST, normalized-file, or fixture fallback automatically.",
        generatedAt: now(),
      };
      return {
        content: [{ type: "text", text: "CMC MCP refresh delegated to daemon provider chain." }],
        details: { status: "delegated_to_daemon", provider: "daemonProviderChain", summary: request },
      };
    },
  });
}
