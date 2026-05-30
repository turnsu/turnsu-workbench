#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { buildControlPlane } from "./index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../..");
const runDir = mkdtempSync(join(tmpdir(), "wechat-agent-control-plane-"));
const runID = "run-smoke-control-plane";
const taskID = "task-smoke-control-plane";

try {
  const result = buildControlPlane({
    projectRoot,
    runDir,
    runID,
    taskID,
    sessionID: "session-smoke-control-plane",
    prompt: "检查 BTC 微信与链上信号，生成可追踪情报和行动建议。",
    selectedSkillIDs: ["wechat-onchain-intelligence", "cmc-market-radar"],
    selectedExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"],
    attachments: [],
    contextRefs: [{ kind: "token", id: "BTC", title: "BTC" }],
    tools: ["wechat.read_normalized_messages", "cmc.read_market_evidence", "market.read_snapshot", "crystal.create_or_update", "proposal.create", "wechat_cli.live_command"],
    policyForTool: (toolName) => (toolName === "wechat_cli.live_command" ? "blocked" : "pass"),
    providerReadiness: [{ provider: "deepseek", role: "text", ready: false, missingEnv: ["DEEPSEEK_API_KEY"], rawSecretsReturned: false }],
    piStatus: { initialized: false },
  });

  const required = [
    result.controlPlaneManifest,
    result.taskIntent,
    result.executionProfile,
    result.contextManifest,
    result.contextBundle,
    result.retrievalPlan,
    result.contextGate,
    result.toolIntentPlan,
    result.policyDecisions,
    result.approvalDecisions,
    result.qaGate,
    result.runtimeMetrics,
    result.checkpoint,
    result.retryLedger,
  ];
  if (required.some((item) => item === null || item === undefined)) throw new Error("missing_control_plane_output");
  if (result.controlPlaneManifest.internalToolsExposed !== false) throw new Error("internal_tools_exposed");
  if (!result.policyDecisions.some((item) => item.action === "wechat_cli.live_command" && item.status === "blocked")) {
    throw new Error("blocked_policy_missing");
  }
  console.log(`control_plane_smoke=pass runDir=${runDir}`);
} finally {
  rmSync(runDir, { recursive: true, force: true });
}

