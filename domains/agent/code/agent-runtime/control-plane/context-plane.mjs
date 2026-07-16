import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { artifactPath, compactText, controlID, nowISO, redactSensitive, safeArray, stableHash } from "./schema-validator.mjs";

function parseJsonFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readableEvidenceCount(value) {
  const sections = safeArray(value);
  return sections.reduce((total, section) => total + safeArray(section?.bullets).length, 0);
}

function sourceMetadata(sourceType, payload) {
  if (!payload || typeof payload !== "object") return {};
  if (sourceType === "market_snapshot") {
    const assets = safeArray(payload.assets);
    return {
      provider: payload.provider || null,
      status: payload.status || null,
      freshness: payload.freshness || null,
      sourceName: payload.sourceName || null,
      assetCount: assets.length,
      evidenceCount: safeArray(payload.evidence).filter(Boolean).length,
      observedAt: payload.observedAt || payload.generatedAt || null,
      expiresAt: payload.expiresAt || null,
    };
  }
  if (sourceType === "cmc_normalized_evidence") {
    return {
      provider: payload.provider || null,
      skill: payload.skill || payload.skillName || null,
      status: payload.status || null,
      freshness: payload.freshness || null,
      watchlistCount: safeArray(payload.watchlist).length,
      readableEvidenceCount: readableEvidenceCount(payload.readableEvidence),
      missingInputCount: safeArray(payload.missingOrStaleInputs || payload.missing_or_stale_inputs).length,
      observedAt: payload.observedAt || payload.generatedAt || null,
    };
  }
  if (sourceType === "memory_store") {
    const items = Array.isArray(payload) ? payload : safeArray(payload.items || payload.memory);
    return { itemCount: items.length };
  }
  if (sourceType === "crystal_store") {
    const items = Array.isArray(payload) ? payload : safeArray(payload.items || payload.crystals);
    return { itemCount: items.length };
  }
  if (sourceType === "proposal_store") {
    const items = Array.isArray(payload) ? payload : safeArray(payload.items || payload.proposals);
    return { itemCount: items.length };
  }
  if (Array.isArray(payload)) return { itemCount: payload.length };
  return { keys: Object.keys(payload).slice(0, 16) };
}

function summarizeJsonPayload(payload, sourceType) {
  if (payload === null || payload === undefined) {
    return "artifact exists but preview was not parsed";
  }
  if (sourceType === "market_snapshot") {
    const assets = safeArray(payload.assets);
    const symbols = assets.map((asset) => asset?.symbol).filter(Boolean).slice(0, 8).join(", ");
    const evidenceCount = safeArray(payload.evidence).filter(Boolean).length;
    return compactText(`provider=${payload.provider || "unknown"} status=${payload.status || "unknown"} freshness=${payload.freshness || "unknown"} assets=${assets.length}${symbols ? ` symbols=${symbols}` : ""} evidence=${evidenceCount}`, 360);
  }
  if (sourceType === "cmc_normalized_evidence") {
    const watchlist = safeArray(payload.watchlist).map((item) => item?.symbol).filter(Boolean).slice(0, 8).join(", ");
    const evidenceCount = readableEvidenceCount(payload.readableEvidence);
    const missing = safeArray(payload.missingOrStaleInputs || payload.missing_or_stale_inputs).length;
    const summary = payload.market_read?.summary || payload.summary || "";
    return compactText(`skill=${payload.skill || payload.skillName || "unknown"} status=${payload.status || "unknown"} watchlist=${safeArray(payload.watchlist).length}${watchlist ? ` symbols=${watchlist}` : ""} readableEvidence=${evidenceCount} missingInputs=${missing} summary=${summary}`, 520);
  }
  if (Array.isArray(payload)) return `json array count=${payload.length}`;
  if (payload && typeof payload === "object") {
    const keys = Object.keys(payload).slice(0, 12).join(", ");
    const count = Array.isArray(payload.items) ? ` items=${payload.items.length}` : "";
    return `json object keys=${keys}${count}`;
  }
  return compactText(payload, 240);
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
  const payload = parseJsonFile(fullPath);
  return {
    sourceID: controlID("ctx-source"),
    sourceType,
    label,
    artifactPath: artifactPath(projectRoot, fullPath),
    freshness: freshnessFor(fullPath),
    trust: "local_artifact",
    metadata: sourceMetadata(sourceType, payload),
    preview: summarizeJsonPayload(payload, sourceType),
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
    chunkArtifactPath: null,
    freshness: source.freshness || "unknown",
    confidence: source.sourceType === "prompt" ? 1 : 0.72,
    sourceTrustScore: source.sourceTrustScore || null,
    metadata: source.metadata || {},
    tokenEstimate: Math.max(24, Math.ceil(String(source.preview || "").length / 4)),
    preview: compactText(source.preview, 360),
  };
}

function deriveSourceTrust(source) {
  let score = 0.5;
  const reasons = [];
  if (source.sourceType === "prompt") {
    score = 0.98;
    reasons.push("user_prompt");
  } else if (source.trust === "user_selected_reference") {
    score = 0.86;
    reasons.push("user_selected_reference");
  } else if (source.trust === "user_attachment") {
    score = 0.82;
    reasons.push("user_attachment_hash_recorded");
  } else if (source.trust === "local_artifact") {
    score = 0.72;
    reasons.push("local_runtime_artifact");
  }
  if (source.freshness === "fresh") {
    score += 0.12;
    reasons.push("fresh");
  } else if (source.freshness === "stale") {
    score -= 0.08;
    reasons.push("stale");
  } else if (source.freshness === "degraded") {
    score -= 0.18;
    reasons.push("degraded");
  }
  if (source.sourceType === "cmc_normalized_evidence" && Number(source.metadata?.readableEvidenceCount || 0) === 0) {
    score -= 0.18;
    reasons.push("cmc_readable_evidence_empty");
  }
  if (source.sourceType === "market_snapshot" && Number(source.metadata?.assetCount || 0) === 0) {
    score -= 0.14;
    reasons.push("market_assets_empty");
  }
  return {
    sourceID: source.sourceID,
    sourceType: source.sourceType,
    label: source.label,
    artifactPath: source.artifactPath,
    score: Math.max(0, Math.min(1, Number(score.toFixed(2)))),
    freshness: source.freshness || "unknown",
    trust: source.trust || "unknown",
    metadata: source.metadata || {},
    reasons,
  };
}

function queryTerms(prompt, selectedSkillIDs = [], selectedExtensionIDs = []) {
  const raw = `${prompt || ""} ${safeArray(selectedSkillIDs).join(" ")} ${safeArray(selectedExtensionIDs).join(" ")}`.toLowerCase();
  const terms = raw
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !["the", "and", "with", "this", "that", "一个", "这个", "以及", "进行"].includes(term));
  if (/btc|bitcoin|比特币/i.test(raw)) terms.push("btc", "bitcoin");
  if (/eth|ethereum|以太/i.test(raw)) terms.push("eth", "ethereum");
  if (/sol|solana/i.test(raw)) terms.push("sol", "solana");
  if (/cmc|coinmarketcap|market|行情|价格|市场|宏观|etf|thesis|相关性|跨资产/i.test(raw)) terms.push("market", "cmc", "宏观", "市场");
  return [...new Set(terms)].slice(0, 32);
}

function scoreChunk(chunk, terms) {
  const text = `${chunk.label || ""} ${chunk.sourceType || ""} ${chunk.preview || ""} ${JSON.stringify(chunk.metadata || {})}`.toLowerCase();
  const matches = terms.filter((term) => text.includes(term.toLowerCase()));
  let score = 0.1 + (chunk.sourceTrustScore || 0.5) * 0.45;
  if (chunk.freshness === "fresh") score += 0.12;
  if (chunk.freshness === "stale") score -= 0.04;
  if (chunk.freshness === "degraded") score -= 0.08;
  score += Math.min(0.3, matches.length * 0.04);
  if (["market_snapshot", "cmc_normalized_evidence"].includes(chunk.sourceType)) score += 0.08;
  if (chunk.sourceType === "prompt") score += 0.08;
  return {
    chunkID: chunk.chunkID,
    sourceID: chunk.sourceID,
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    matchedTerms: matches.slice(0, 12),
    reasons: [
      matches.length ? "query_term_match" : "background_context",
      chunk.freshness === "fresh" ? "fresh" : `freshness_${chunk.freshness || "unknown"}`,
      `trust_${chunk.sourceTrustScore ?? "unknown"}`,
    ],
  };
}

function buildMemoryCompression(sources, runID, taskID) {
  const memorySource = sources.find((source) => source.sourceType === "memory_store");
  return {
    schemaVersion: "agent-memory-compression-v1",
    runID,
    taskID,
    status: memorySource ? "available" : "missing",
    sourceID: memorySource?.sourceID || null,
    itemCount: Number(memorySource?.metadata?.itemCount || 0),
    compression: memorySource
      ? compactText(memorySource.preview, 900)
      : "No local memory store artifact was available for this run.",
    rawPrivateTranscriptIncluded: false,
    createdAt: nowISO(),
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
    ["runtime/market/cmc-skill-hub.normalized.json", "cmc_normalized_evidence", "CMC Skill Hub normalized evidence"],
    ["runtime/entities/token-entities.json", "token_entity_store", "Token entity store"],
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

  const sourceTrustReport = {
    schemaVersion: "agent-source-trust-report-v1",
    runID,
    taskID,
    sources: sources.map(deriveSourceTrust),
    missingSources,
    rawPrivateTranscriptIncluded: false,
    createdAt: nowISO(),
  };

  const sourcesWithTrust = sources.map((source) => {
    const trustRecord = sourceTrustReport.sources.find((item) => item.sourceID === source.sourceID);
    return { ...source, sourceTrustScore: trustRecord?.score || null, sourceTrustReasons: trustRecord?.reasons || [] };
  });

  const chunks = sourcesWithTrust
    .map(sourceToChunk)
    .map((chunk) => ({
      ...chunk,
      chunkArtifactPath: `runtime/agent/runs/${runID}/context-chunks/${chunk.chunkID}.json`,
    }));
  const terms = queryTerms(prompt, selectedSkillIDs, selectedExtensionIDs);
  const scoredChunks = chunks
    .map((chunk) => ({ ...scoreChunk(chunk, terms), chunk }))
    .sort((a, b) => b.score - a.score || a.chunk.sequence - b.chunk.sequence);
  const maxChunks = 12;
  const maxModelChars = 4800;
  const selectedChunkIDs = new Set(scoredChunks.slice(0, maxChunks).map((item) => item.chunkID));
  const selectedChunks = chunks.filter((chunk) => selectedChunkIDs.has(chunk.chunkID));
  const excludedChunks = chunks.filter((chunk) => !selectedChunkIDs.has(chunk.chunkID));
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
    indexArtifactPath: `runtime/agent/runs/${runID}/context-index.json`,
    retrievalResultsArtifactPath: `runtime/agent/runs/${runID}/retrieval-results.json`,
    contextPackArtifactPath: `runtime/agent/runs/${runID}/context-pack.json`,
    sourceTrustReportArtifactPath: `runtime/agent/runs/${runID}/source-trust-report.json`,
    memoryCompressionArtifactPath: `runtime/agent/runs/${runID}/memory-compression.json`,
    createdAt: nowISO(),
  };

  const retrievalResults = {
    schemaVersion: "agent-context-retrieval-results-v1",
    runID,
    taskID,
    strategy: "deterministic_prompt_term_freshness_source_trust_v1",
    queryTerms: terms,
    rankedChunks: scoredChunks.map((item, rank) => ({
      rank: rank + 1,
      chunkID: item.chunkID,
      sourceID: item.sourceID,
      score: item.score,
      selected: selectedChunkIDs.has(item.chunkID),
      matchedTerms: item.matchedTerms,
      reasons: item.reasons,
      chunkArtifactPath: item.chunk.chunkArtifactPath,
    })),
    selectedChunkIDs: selectedChunks.map((chunk) => chunk.chunkID),
    excludedChunkIDs: excludedChunks.map((chunk) => chunk.chunkID),
    createdAt: nowISO(),
  };

  const retrievalPlan = {
    schemaVersion: "agent-context-retrieval-plan-v1",
    runID,
    taskID,
    strategy: retrievalResults.strategy,
    queryTerms: terms,
    budget: {
      maxChunks,
      selectedChunks: selectedChunks.length,
      maxModelChars,
      selectedModelChars: modelContext.length,
    },
    selectedChunkIDs: selectedChunks.map((chunk) => chunk.chunkID),
    excludedChunkIDs: excludedChunks.map((chunk) => chunk.chunkID),
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

  const contextIndex = {
    schemaVersion: "agent-context-index-v1",
    runID,
    taskID,
    sessionID,
    sourceCount: sources.length,
    chunkCount: chunks.length,
    sources: sourcesWithTrust.map((source) => ({
      sourceID: source.sourceID,
      sourceType: source.sourceType,
      label: source.label,
      artifactPath: source.artifactPath,
      freshness: source.freshness,
      trust: source.trust,
      sourceTrustScore: source.sourceTrustScore,
      metadata: source.metadata || {},
    })),
    chunks: chunks.map((chunk) => ({
      chunkID: chunk.chunkID,
      sourceID: chunk.sourceID,
      sourceType: chunk.sourceType,
      label: chunk.label,
      freshness: chunk.freshness,
      confidence: chunk.confidence,
      sourceTrustScore: chunk.sourceTrustScore,
      tokenEstimate: chunk.tokenEstimate,
      chunkArtifactPath: chunk.chunkArtifactPath,
      artifactPath: chunk.artifactPath,
      preview: chunk.preview,
    })),
    rawPrivateTranscriptIncluded: false,
    fullRawContentIncluded: false,
    createdAt: nowISO(),
  };

  const contextPack = {
    schemaVersion: "agent-context-pack-v1",
    runID,
    taskID,
    sessionID,
    packID: controlID("ctx-pack"),
    strategy: retrievalResults.strategy,
    selectedChunks,
    rankedChunkRefs: retrievalResults.rankedChunks.filter((item) => item.selected),
    excludedChunkRefs: retrievalResults.rankedChunks.filter((item) => !item.selected).slice(0, 20),
    sourceTrustReportPath: `runtime/agent/runs/${runID}/source-trust-report.json`,
    modelContext,
    contextHash: stableHash({ selectedChunks, modelContext, strategy: retrievalResults.strategy }),
    rawPrivateTranscriptIncluded: false,
    fullRawContentIncluded: false,
    createdAt: nowISO(),
  };

  const memoryCompression = buildMemoryCompression(sourcesWithTrust, runID, taskID);

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

  const contextChunkArtifacts = chunks.map((chunk) => [
    `context-chunks/${chunk.chunkID}.json`,
    {
      schemaVersion: "agent-context-chunk-v1",
      runID,
      taskID,
      ...chunk,
      rawPrivateTranscriptIncluded: false,
      fullRawContentIncluded: false,
      createdAt: nowISO(),
    },
  ]);

  return {
    contextManifest,
    retrievalPlan,
    contextBundle,
    contextGate,
    contextIndex,
    retrievalResults,
    contextPack,
    sourceTrustReport,
    memoryCompression,
    contextChunkArtifacts,
  };
}
