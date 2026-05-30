import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(extensionDir, "..", "..");
const projectRoot = resolve(agentRuntimeRoot, "..");
const runtimeRoot = join(projectRoot, "runtime");
const normalizedOutputPath = join(runtimeRoot, "wechat", "messages.normalized.json");
const sourceArtifactPath = "runtime/wechat/messages.normalized.json";

const TOOL_PARAMS = Type.Object({
  runID: Type.String(),
  sessionID: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  exportPath: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  contextRefs: Type.Optional(Type.Array(Type.Any())),
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

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fixturePath() {
  return join(extensionDir, "fixtures", "export.sample.json");
}

function safeInsideProject(path: string) {
  const resolved = resolve(path);
  return resolved.startsWith(resolve(projectRoot));
}

function chooseExportPath(params: any) {
  if (params.exportPath && existsSync(params.exportPath) && safeInsideProject(params.exportPath)) {
    return { path: params.exportPath, policy: "needs_confirmation", source: "user_export_file" };
  }
  return { path: fixturePath(), policy: "pass", source: "fixture_export" };
}

function extractSymbols(text: string) {
  const symbols = new Set<string>();
  for (const symbol of ["BTC", "ETH", "SOL", "USDT", "USDC"]) {
    if (new RegExp(`\\b${symbol}\\b`, "i").test(text)) symbols.add(symbol);
  }
  return [...symbols];
}

function extractContracts(text: string) {
  const evm = text.match(/\b0x[a-fA-F0-9]{40}\b/g) || [];
  const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || [];
  return [...new Set([...evm, ...sol])];
}

function normalizeExport(payload: any, source: string) {
  const sessions = new Map((payload.sessions || []).map((session: any) => [session.sessionID, session]));
  return (payload.messages || []).map((message: any, index: number) => {
    const text = String(message.text || message.content || "");
    const session = sessions.get(message.sessionID) || {};
    const messageID = String(message.messageID || message.id || `wechat-cli-${hash(`${text}:${index}`).slice(0, 12)}`);
    return {
      id: messageID,
      sourceMessageID: messageID,
      groupID: String(message.sessionID || session.sessionID || "wechat-cli-export"),
      groupName: String(message.sessionName || session.name || "WeChatCLI Export"),
      sender: String(message.sender || message.from || "unknown"),
      text,
      sentAt: String(message.sentAt || message.timestamp || now()),
      sourceDateText: String(message.sentAt || message.timestamp || ""),
      extractedSymbols: extractSymbols(text),
      extractedContracts: extractContracts(text),
      linkedTokenIDs: [],
      source,
      privacyLevel: "private",
      redactionStatus: "metadata_only",
    };
  });
}

function runArtifact(runID: string, name: string) {
  return join(runtimeRoot, "agent", "runs", String(runID).replace(/[^A-Za-z0-9_.-]/g, "_"), name);
}

export default function registerWeChatCLIExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "wechat_cli.import_export_file",
    description: "Normalize a user-provided or fixture WeChatCLI export without running live wechat-cli commands.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const selected = chooseExportPath(params || {});
      const payload = readJSON(selected.path, { messages: [] });
      const messages = normalizeExport(payload, selected.source);
      writeJSON(normalizedOutputPath, messages);
      const summary = {
        schemaVersion: "wechat-cli-import-result-v1",
        runID: params.runID,
        source: selected.source,
        policy: selected.policy,
        messageCount: messages.length,
        artifactPath: sourceArtifactPath,
        liveCommandsBlocked: true,
        migratedCapabilities: ["sessions", "history/export schema", "search text semantics", "members metadata"],
        notExecuted: ["wechat-cli init", "wechat-cli history", "wechat-cli search", "wechat-cli sessions", "wechat-cli new-messages"],
        generatedAt: now(),
      };
      writeJSON(runArtifact(params.runID, "wechat-cli-import.json"), summary);
      return {
        content: [{ type: "text", text: `WeChatCLI export normalized ${messages.length} message(s); live commands remain blocked.` }],
        details: { status: selected.policy === "pass" ? "completed" : "needs_confirmation", artifactPath: sourceArtifactPath, summary },
      };
    },
  });

  pi.registerTool({
    name: "wechat_cli.live_command",
    description: "Blocked live WeChatCLI command contract for init/history/search/sessions/new-messages.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const command = String(params.command || "wechat-cli live");
      const summary = {
        schemaVersion: "wechat-cli-live-command-policy-v1",
        runID: params.runID,
        command,
        status: "blocked",
        reason: "Live wechat-cli reads active WeChat data and is outside the current product boundary.",
        generatedAt: now(),
      };
      writeJSON(runArtifact(params.runID, "wechat-cli-live-blocked.json"), summary);
      return {
        content: [{ type: "text", text: `${command} blocked by policy.` }],
        details: { status: "blocked", artifactPath: `runtime/agent/runs/${params.runID}/wechat-cli-live-blocked.json`, summary },
      };
    },
  });
}
