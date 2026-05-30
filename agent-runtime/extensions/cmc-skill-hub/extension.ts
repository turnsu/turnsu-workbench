import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(extensionDir, "..", "..");
const projectRoot = resolve(agentRuntimeRoot, "..");
const runtimeRoot = join(projectRoot, "runtime");
const marketSnapshotPath = join(runtimeRoot, "market", "latest-market-snapshot.json");
const normalizedInputPath = join(runtimeRoot, "market", "cmc-skill-hub.normalized.json");

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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runArtifact(runID: string, name: string) {
  return join(runtimeRoot, "agent", "runs", String(runID).replace(/[^A-Za-z0-9_.-]/g, "_"), name);
}

function fixtureEvidence() {
  return readJSON(join(extensionDir, "fixtures", "market-evidence.sample.json"), { status: "degraded", watchlist: [] });
}

function providerEvidence() {
  if (existsSync(normalizedInputPath)) {
    return { provider: "normalizedFileProvider", evidence: readJSON(normalizedInputPath, fixtureEvidence()) };
  }
  return { provider: "fixtureProvider", evidence: fixtureEvidence() };
}

function marketSnapshotFromEvidence(evidence: any, provider: string) {
  const generatedAt = now();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const watchlist = Array.isArray(evidence.watchlist) ? evidence.watchlist : [];
  return {
    status: evidence.status === "ok" ? "enabled" : "degraded",
    sourceName: `CMC Skill Hub ${provider}`,
    generatedAt,
    expiresAt,
    freshness: provider === "fixtureProvider" ? "fixture" : "fresh",
    lastVerifiedAt: generatedAt,
    assets: watchlist.map((asset: any) => ({
      symbol: String(asset.symbol || "").toUpperCase(),
      name: String(asset.name || asset.symbol || "Unknown"),
      priceUSD: Number(asset.priceUSD || 0),
      percentChange24h: Number(asset.percentChange24h || 0),
      volume24hUSD: Number(asset.volume24hUSD || 0),
      marketCapUSD: Number(asset.marketCapUSD || 0),
      source: `cmc_skill_hub_${provider}`,
      isLive: provider !== "fixtureProvider",
    })),
    evidence: [
      evidence.market_read?.summary || "CMC Skill Hub evidence normalized locally.",
      ...(evidence.action_guidance || []),
    ],
    upstreamStatus: provider === "fixtureProvider" ? "fixture_provider" : "normalized_provider",
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
    description: "Create a request artifact for optional live CMC MCP refresh; does not call MCP unless an external connector is configured.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const status = process.env.CMC_MCP_ENABLED === "1" ? "needs_confirmation" : "blocked_missing_provider_config";
      const request = {
        schemaVersion: "cmc-mcp-refresh-request-v1",
        runID: params.runID,
        status,
        candidateSkills: ["daily_market_overview", "detect_market_regime", "build_daily_market_brief", "track_social_price_divergence"],
        reason: status === "needs_confirmation" ? "External CMC MCP connector is configured; operator confirmation required." : "CMC MCP connector is not configured in this local runtime.",
        generatedAt: now(),
      };
      writeJSON(runArtifact(params.runID, "cmc-mcp-refresh-request.json"), request);
      return {
        content: [{ type: "text", text: `CMC MCP refresh request ${status}.` }],
        details: { status, artifactPath: `runtime/agent/runs/${params.runID}/cmc-mcp-refresh-request.json`, summary: request },
      };
    },
  });
}
