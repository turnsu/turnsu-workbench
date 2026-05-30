import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactPath, compactText, controlID, nowISO, redactSensitive, safeArray, stableHash } from "./schema-validator.mjs";

function summarizeJsonFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const payload = JSON.parse(raw);
    if (Array.isArray(payload)) return `json array count=${payload.length}`;
    if (payload && typeof payload === "object") {
      const keys = Object.keys(payload).slice(0, 12).join(", ");
      const count = Array.isArray(payload.items) ? ` items=${payload.items.length}` : "";
      return `json object keys=${keys}${count}`;
    }
    return compactText(payload, 240);
  } catch {
    return "artifact exists but preview was not parsed";
  }
}

function freshnessFor(path) {
  try {
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (ageMs <= 6 * 60 * 60 * 1000) return "fresh";
    if (ageMs <= 48 * 60 * 60 * 1000) return "stale";
    return "degraded";
  } catch {
    return "missing";
  }
}

function runtimeSource(projectRoot, relativePath, sourceType, label) {
  const fullPath = join(projectRoot, relativePath);
  if (!existsSync(fullPath)) {
    return {
      missing: true,
      sourceType,
      label,
      artifactPath: relativePath,
      reason: "artifact_missing",
    };
  }
  return {
    sourceID: controlID("ctx-source"),
    sourceType,
    label,
    artifactPath: artifactPath(projectRoot, fullPath),
    freshness: freshnessFor(fullPath),
    trust: "local_artifact",
    preview: summarizeJsonFile(fullPath),
  };
}

function sourceToChunk(source, sequence) {
  return {
    chunkID: controlID("ctx-chunk"),
    sequence,
    sourceID: source.sourceID,
    sourceType: source.sourceType,
    label: source.label,
    artifactPath: source.artifactPath,
    freshness: source.freshness || "unknown",
    confidence: source.sourceType === "prompt" ? 1 : 0.72,
    tokenEstimate: Math.max(24, Math.ceil(String(source.preview || "").length / 4)),
    preview: compactText(source.preview, 360),
  };
}

export function createContextPlane({ projectRoot, runID, taskID, sessionID, prompt, contextRefs = [], attachments = [], selectedSkillIDs = [], selectedExtensionIDs = [] }) {
  const missingSources = [];
  const sources = [];

  sources.push({
    sourceID: controlID("ctx-source"),
    sourceType: "prompt",
    label: "User prompt",
    artifactPath: null,
    freshness: "fresh",
    trust: "user_input",
    preview: compactText(redactSensitive(prompt), 600),
  });

  for (const [index, ref] of safeArray(contextRefs).entries()) {
    sources.push({
      sourceID: controlID("ctx-source"),
      sourceType: `context_ref:${ref.kind || ref.type || "runtime_object"}`,
      label: ref.title || ref.id || `Context ref ${index + 1}`,
      artifactPath: ref.artifactPath || null,
      freshness: ref.freshness || "unknown",
      trust: "user_selected_reference",
      preview: compactText(redactSensitive(JSON.stringify(ref)), 360),
    });
  }

  for (const [index, attachment] of safeArray(attachments).entries()) {
    sources.push({
      sourceID: controlID("ctx-source"),
      sourceType: "attachment",
      label: attachment.fileName || attachment.attachmentID || `Attachment ${index + 1}`,
      artifactPath: attachment.artifactPath || null,
      freshness: "fresh",
      trust: "user_attachment",
      preview: `attachment hash=${attachment.sha256 || "unknown"} mime=${attachment.mimeType || "unknown"} size=${attachment.sizeBytes || "unknown"}`,
    });
  }

  const expectedArtifacts = [
    ["runtime/wechat/messages.normalized.json", "wechat_normalized_messages", "Normalized WeChat messages"],
    ["runtime/market/latest-market-snapshot.json", "market_snapshot", "Latest market snapshot"],
    ["runtime/crystals/crystals.json", "crystal_store", "Crystal store"],
    ["runtime/proposals/proposals.json", "proposal_store", "Proposal store"],
    ["runtime/memory/memory.json", "memory_store", "Memory store"],
    ["runtime/handoffs/index.json", "handoff_index", "Handoff index"],
  ];

  for (const [path, sourceType, label] of expectedArtifacts) {
    const source = runtimeSource(projectRoot, path, sourceType, label);
    if (source.missing) missingSources.push(source);
    else sources.push(source);
  }

  const chunks = sources.map(sourceToChunk);
  const maxChunks = 12;
  const maxModelChars = 4800;
  const selectedChunks = chunks.slice(0, maxChunks);
  const modelContext = selectedChunks
    .map((chunk) => `[${chunk.sequence}] ${chunk.label}: ${chunk.preview}`)
    .join("\n")
    .slice(0, maxModelChars);
  const status = missingSources.length > 0 ? "degraded" : "pass";

  const contextManifest = {
    schemaVersion: "agent-context-manifest-v1",
    runID,
    taskID,
    sessionID,
    selectedSkills: safeArray(selectedSkillIDs),
    selectedExtensions: safeArray(selectedExtensionIDs),
    sources,
    chunks,
    sourceCount: sources.length,
    chunkCount: chunks.length,
    missingSources,
    rawPrivateTranscriptIncluded: false,
    fullRawContentIncluded: false,
    createdAt: nowISO(),
  };

  const retrievalPlan = {
    schemaVersion: "agent-context-retrieval-plan-v1",
    runID,
    taskID,
    strategy: "selected_refs_plus_runtime_artifact_summary_mvp",
    budget: {
      maxChunks,
      selectedChunks: selectedChunks.length,
      maxModelChars,
      selectedModelChars: modelContext.length,
    },
    selectedChunkIDs: selectedChunks.map((chunk) => chunk.chunkID),
    excludedChunkIDs: chunks.slice(maxChunks).map((chunk) => chunk.chunkID),
    missingSourceCount: missingSources.length,
    createdAt: nowISO(),
  };

  const contextBundle = {
    schemaVersion: "agent-context-bundle-v1",
    runID,
    taskID,
    sessionID,
    bundleID: controlID("ctx-bundle"),
    includedSources: sources.map((source) => source.sourceID),
    includedChunks: selectedChunks,
    modelContext,
    contextHash: stableHash({ selectedChunks, modelContext }),
    budget: retrievalPlan.budget,
    rawPrivateTranscriptIncluded: false,
    fullRawContentIncluded: false,
    createdAt: nowISO(),
  };

  const contextGate = {
    schemaVersion: "agent-context-gate-v1",
    runID,
    taskID,
    status,
    reason: status === "pass" ? "Context bundle assembled from prompt, selected refs, and local artifact summaries." : "Context bundle assembled with missing optional runtime sources.",
    missingSourceCount: missingSources.length,
    staleChunkCount: selectedChunks.filter((chunk) => chunk.freshness === "stale" || chunk.freshness === "degraded").length,
    privacy: {
      rawPrivateTranscriptIncluded: false,
      fullRawContentIncluded: false,
      secretMaterialIncluded: false,
    },
    createdAt: nowISO(),
  };

  return { contextManifest, retrievalPlan, contextBundle, contextGate };
}

