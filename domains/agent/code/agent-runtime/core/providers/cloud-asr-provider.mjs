import { createHmac, createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { runtimePaths } from "../../lib/runtime-paths.mjs";

const { agentDataRoot: runtimeRoot } = runtimePaths;

export const CLOUD_ASR_TOOL_NAME = "office.cloud_asr.transcribe";

const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "amr", "flac", "m4a", "mp3", "ogg", "opus", "pcm", "wav", "wma"]);
const VIDEO_EXTENSIONS = new Set(["avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"]);

function now() {
  return new Date().toISOString();
}

function safeSegment(value, fallback = "item") {
  const text = String(value || fallback).replace(/[^A-Za-z0-9_.-]/g, "_");
  return text || fallback;
}

function safeRunID(value) {
  return safeSegment(value, "run");
}

function runDir(runID) {
  return join(runtimeRoot, "runs", safeRunID(runID));
}

function runArtifact(runID, name) {
  return join(runDir(runID), name);
}

function artifactPath(runID, name) {
  return `runtime/agent/runs/${safeRunID(runID)}/${name}`;
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function redact(value) {
  return String(value || "")
    .replace(/(authorization|api[_-]?key|token|secret|signature|ossaccesskeyid)\s*[:=]\s*[^&\s]+/gi, "$1=[redacted]")
    .replace(/(Signature|OSSAccessKeyId|security-token)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, 800);
}

export function isAudioVideoAttachment(attachment = {}) {
  const mime = String(attachment.mimeType || "").toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  const ext = String(extname(attachment.fileName || attachment.originalPath || "") || "")
    .replace(/^\./, "")
    .toLowerCase();
  return AUDIO_EXTENSIONS.has(ext) || VIDEO_EXTENSIONS.has(ext);
}

function attachmentFilePath(attachment = {}) {
  const candidate = String(attachment.originalPath || "").trim();
  if (!candidate) return null;
  const resolved = resolve(candidate);
  const attachmentsRoot = resolve(runtimeRoot, "attachments");
  if (!resolved.startsWith(`${attachmentsRoot}/`) && resolved !== attachmentsRoot) return null;
  return resolved;
}

function fileHash(path) {
  return createHash("sha256").update(`${path}:${statSync(path).size}:${statSync(path).mtimeMs}`).digest("hex");
}

function buildConfig() {
  const region = String(process.env.ALIYUN_OSS_REGION || "cn-beijing").trim();
  const ossEndpoint = String(process.env.ALIYUN_OSS_ENDPOINT || `oss-${region}.aliyuncs.com`).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    apiKey: String(process.env.DASHSCOPE_API_KEY || process.env.BAILIAN_API_KEY || "").trim(),
    dashScopeBaseURL: String(process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, ""),
    model: String(process.env.BAILIAN_ASR_MODEL || process.env.DASHSCOPE_ASR_MODEL || "fun-asr").trim(),
    fallbackModel: String(process.env.BAILIAN_ASR_FALLBACK_MODEL || "qwen3-asr-flash-filetrans").trim(),
    ossBucket: String(process.env.ALIYUN_OSS_BUCKET || "").trim(),
    ossRegion: region,
    ossEndpoint,
    ossAccessKeyID: String(process.env.ALIYUN_OSS_ACCESS_KEY_ID || "").trim(),
    ossAccessKeySecret: String(process.env.ALIYUN_OSS_ACCESS_KEY_SECRET || "").trim(),
    ossSecurityToken: String(process.env.ALIYUN_OSS_SECURITY_TOKEN || "").trim(),
    uploadTTLSeconds: Number(process.env.CLOUD_ASR_UPLOAD_TTL_SECONDS || process.env.ASR_UPLOAD_TTL_SECONDS || "86400"),
    pollIntervalMs: Number(process.env.CLOUD_ASR_POLL_INTERVAL_MS || "2000"),
    timeoutMs: Number(process.env.CLOUD_ASR_TIMEOUT_MS || "900000"),
    mockMode: process.env.WECHAT_AGENT_MOCK_CLOUD_ASR === "1",
  };
}

function missingConfig(config) {
  const missing = [];
  if (!config.apiKey) missing.push("DASHSCOPE_API_KEY");
  if (!config.ossBucket) missing.push("ALIYUN_OSS_BUCKET");
  if (!config.ossAccessKeyID) missing.push("ALIYUN_OSS_ACCESS_KEY_ID");
  if (!config.ossAccessKeySecret) missing.push("ALIYUN_OSS_ACCESS_KEY_SECRET");
  return missing;
}

function signOSSURL({ method, bucket, endpoint, objectKey, accessKeyID, accessKeySecret, securityToken, contentType = "", expiresAt }) {
  const objectPath = objectKey.split("/").map(encodeURIComponent).join("/");
  const securityQuery = securityToken ? `security-token=${encodeURIComponent(securityToken)}` : "";
  const canonicalResource = securityQuery
    ? `/${bucket}/${objectKey}?security-token=${encodeURIComponent(securityToken)}`
    : `/${bucket}/${objectKey}`;
  const stringToSign = `${method}\n\n${contentType}\n${expiresAt}\n${canonicalResource}`;
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  const params = [
    `OSSAccessKeyId=${encodeURIComponent(accessKeyID)}`,
    `Expires=${expiresAt}`,
    `Signature=${encodeURIComponent(signature)}`,
    securityQuery,
  ].filter(Boolean).join("&");
  return `https://${bucket}.${endpoint}/${objectPath}?${params}`;
}

async function uploadAttachmentToOSS(attachment, config, { runID }) {
  const sourcePath = attachmentFilePath(attachment);
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new Error("cloud_asr_attachment_file_missing_or_outside_runtime");
  }
  const stat = statSync(sourcePath);
  const ext = String(extname(attachment.fileName || sourcePath) || ".bin").toLowerCase();
  const objectKey = [
    "agent-asr",
    safeRunID(runID),
    safeSegment(attachment.attachmentID || attachment.id || fileHash(sourcePath).slice(0, 12), "attachment"),
    `${Date.now()}-${safeSegment(attachment.fileName || `audio${ext}`, `audio${ext}`)}`,
  ].join("/");
  const expiresAt = Math.floor(Date.now() / 1000) + Math.max(60, config.uploadTTLSeconds);
  const contentType = attachment.mimeType || "application/octet-stream";
  const putURL = signOSSURL({
    method: "PUT",
    bucket: config.ossBucket,
    endpoint: config.ossEndpoint,
    objectKey,
    accessKeyID: config.ossAccessKeyID,
    accessKeySecret: config.ossAccessKeySecret,
    securityToken: config.ossSecurityToken,
    contentType,
    expiresAt,
  });
  const putResponse = await fetch(putURL, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
    },
    body: createReadStream(sourcePath),
    duplex: "half",
  });
  if (!putResponse.ok) {
    const preview = redact(await putResponse.text().catch(() => ""));
    throw new Error(`cloud_asr_oss_upload_failed:${putResponse.status}:${preview}`);
  }
  const getURL = signOSSURL({
    method: "GET",
    bucket: config.ossBucket,
    endpoint: config.ossEndpoint,
    objectKey,
    accessKeyID: config.ossAccessKeyID,
    accessKeySecret: config.ossAccessKeySecret,
    securityToken: config.ossSecurityToken,
    expiresAt,
  });
  return {
    uploadProvider: "aliyun-oss",
    bucket: config.ossBucket,
    region: config.ossRegion,
    endpoint: config.ossEndpoint,
    objectKey,
    expiresAt,
    signedURL: getURL,
  };
}

function submitPayload(model, signedURL) {
  if (/qwen3-asr-flash-filetrans/i.test(model)) {
    return {
      model,
      input: { file_url: signedURL },
      parameters: { channel_id: [0], enable_itn: true, enable_words: true },
    };
  }
  return {
    model,
    input: { file_urls: [signedURL] },
    parameters: { channel_id: [0], language_hints: ["zh", "en"] },
  };
}

async function submitDashScopeTask({ config, signedURL }) {
  const response = await fetch(`${config.dashScopeBaseURL}/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(submitPayload(config.model, signedURL)),
  });
  const body = await response.json().catch(async () => ({ message: redact(await response.text().catch(() => "")) }));
  if (!response.ok) {
    throw new Error(`cloud_asr_submit_failed:${response.status}:${redact(JSON.stringify(body))}`);
  }
  const taskID = body?.output?.task_id || body?.output?.taskId || body?.task_id;
  if (!taskID) throw new Error(`cloud_asr_submit_missing_task_id:${redact(JSON.stringify(body))}`);
  return taskID;
}

function transcriptionURLFromTask(taskPayload) {
  const output = taskPayload?.output || {};
  const resultURL = output?.result?.transcription_url || output?.result?.transcriptionUrl;
  if (resultURL) return resultURL;
  const results = Array.isArray(output?.results) ? output.results : [];
  return results.find((item) => item?.transcription_url || item?.transcriptionUrl)?.transcription_url
    || results.find((item) => item?.transcription_url || item?.transcriptionUrl)?.transcriptionUrl
    || null;
}

async function pollDashScopeTask({ config, taskID }) {
  const deadline = Date.now() + Math.max(1000, config.timeoutMs);
  let lastPayload = null;
  while (Date.now() <= deadline) {
    const response = await fetch(`${config.dashScopeBaseURL}/tasks/${encodeURIComponent(taskID)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
    });
    const payload = await response.json().catch(async () => ({ message: redact(await response.text().catch(() => "")) }));
    if (!response.ok) throw new Error(`cloud_asr_query_failed:${response.status}:${redact(JSON.stringify(payload))}`);
    lastPayload = payload;
    const status = String(payload?.output?.task_status || payload?.output?.taskStatus || "").toUpperCase();
    if (status === "SUCCEEDED") return payload;
    if (status === "FAILED" || status === "UNKNOWN") throw new Error(`cloud_asr_task_failed:${status}:${redact(JSON.stringify(payload?.output || {}))}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(250, config.pollIntervalMs)));
  }
  throw new Error(`cloud_asr_timeout:${redact(JSON.stringify(lastPayload?.output || {}))}`);
}

async function fetchTranscriptionJSON(url) {
  const response = await fetch(url);
  const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(`cloud_asr_result_download_failed:${response.status}`);
  return payload;
}

function normalizeSegments(rawResult) {
  const segments = [];
  const transcripts = Array.isArray(rawResult?.transcripts) ? rawResult.transcripts : [];
  for (const transcript of transcripts) {
    for (const sentence of Array.isArray(transcript?.sentences) ? transcript.sentences : []) {
      if (!String(sentence?.text || "").trim()) continue;
      segments.push({
        segmentID: `seg-${segments.length + 1}`,
        startMs: Number(sentence.begin_time ?? sentence.beginTime ?? 0),
        endMs: Number(sentence.end_time ?? sentence.endTime ?? 0),
        speaker: sentence.speaker_id || sentence.speaker || transcript.speaker_id || null,
        text: String(sentence.text).trim(),
        confidence: typeof sentence.confidence === "number" ? sentence.confidence : null,
      });
    }
    if (!segments.length && String(transcript?.text || "").trim()) {
      segments.push({
        segmentID: "seg-1",
        startMs: 0,
        endMs: Number(transcript.content_duration_in_milliseconds || transcript.duration || 0),
        speaker: transcript.speaker_id || null,
        text: String(transcript.text).trim(),
        confidence: null,
      });
    }
  }
  if (!segments.length && String(rawResult?.text || rawResult?.transcription || "").trim()) {
    segments.push({
      segmentID: "seg-1",
      startMs: 0,
      endMs: 0,
      speaker: null,
      text: String(rawResult.text || rawResult.transcription).trim(),
      confidence: null,
    });
  }
  return segments;
}

function boundedChunks(segments) {
  return segments.slice(0, 40).map((segment) => ({
    chunkID: segment.segmentID,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: segment.speaker || null,
    text: segment.text.slice(0, 1200),
  }));
}

function writeASRArtifacts({ runID, sessionID, attachment, status, reason = null, providerStatus = "unknown", model, uploadInfo = null, taskID = null, rawResult = null, segments = [] }) {
  const generatedAt = now();
  const text = segments.map((segment) => segment.text).filter(Boolean).join("\n");
  const transcriptPath = artifactPath(runID, "cloud-asr-transcript.json");
  const summaryPath = artifactPath(runID, "cloud-asr-summary.json");
  const sourcePackPath = artifactPath(runID, "meeting-source-pack.json");
  const transcript = {
    schemaVersion: "cloud-asr-transcript-v1",
    runID,
    sessionID: sessionID || null,
    status,
    provider: "aliyun-bailian-dashscope",
    providerStatus,
    model,
    language: "auto",
    durationMs: Number(rawResult?.properties?.original_duration_in_milliseconds || 0),
    segments,
    segmentCount: segments.length,
    textPreview: text.slice(0, 1600),
    transcriptHash: text ? createHash("sha256").update(text).digest("hex") : null,
    rawAudioStored: false,
    cloudUpload: Boolean(attachment),
    uploadProvider: attachment ? "aliyun-oss" : null,
    sourceAttachmentIDs: [attachment?.attachmentID || attachment?.id].filter(Boolean),
    sourceFileName: attachment?.fileName || null,
    sourceMimeType: attachment?.mimeType || null,
    sourceSizeBytes: attachment?.sizeBytes || null,
    upload: uploadInfo ? {
      provider: uploadInfo.uploadProvider,
      bucket: uploadInfo.bucket,
      region: uploadInfo.region,
      objectKey: uploadInfo.objectKey,
      expiresAt: uploadInfo.expiresAt,
      signedURLPersisted: false,
    } : null,
    taskID: taskID || null,
    redactionStatus: "transcript_and_metadata_only",
    rawProviderRequestIncluded: false,
    rawProviderResponseIncluded: false,
    secretsIncluded: false,
    reason,
    generatedAt,
    artifactPath: transcriptPath,
  };
  const summary = {
    schemaVersion: "cloud-asr-summary-v1",
    runID,
    sessionID: sessionID || null,
    status,
    cloudASRStatus: status,
    provider: "阿里云百炼",
    providerID: "aliyun-bailian-dashscope",
    model,
    uploadProvider: attachment ? "aliyun-oss" : null,
    cloudUpload: Boolean(attachment),
    userVisibleLabel: "云端转写 · 阿里云百炼 · OSS 临时上传",
    reason,
    speakerDiarizationStatus: model === "fun-asr" && segments.length > 0 ? "provider_supported" : "not_available_or_unparsed",
    needsTranscriptReview: status !== "completed" || segments.length === 0,
    transcriptPath,
    sourcePackPath,
    segmentCount: segments.length,
    boundedChunkCount: boundedChunks(segments).length,
    sourceAttachmentIDs: [attachment?.attachmentID || attachment?.id].filter(Boolean),
    rawAudioStored: false,
    rawProviderRequestIncluded: false,
    rawProviderResponseIncluded: false,
    secretsIncluded: false,
    generatedAt,
    artifactPath: summaryPath,
  };
  const sourcePack = {
    schemaVersion: "meeting-source-pack-v1",
    runID,
    sessionID: sessionID || null,
    status: segments.length ? "usable_transcript_chunks" : "transcript_missing_or_failed",
    transcriptPath,
    cloudASRStatus: status,
    provider: "阿里云百炼",
    model,
    cloudUpload: Boolean(attachment),
    uploadProvider: attachment ? "aliyun-oss" : null,
    chunks: boundedChunks(segments),
    sourceAttachmentIDs: [attachment?.attachmentID || attachment?.id].filter(Boolean),
    rawAudioStored: false,
    rawTranscriptIncludedInModelContext: false,
    rawProviderRequestIncluded: false,
    secretsIncluded: false,
    generatedAt,
    artifactPath: sourcePackPath,
  };
  writeJSON(runArtifact(runID, "cloud-asr-transcript.json"), transcript);
  writeJSON(runArtifact(runID, "cloud-asr-summary.json"), summary);
  writeJSON(runArtifact(runID, "meeting-source-pack.json"), sourcePack);
  return { transcript, summary, sourcePack };
}

function mockTranscriptResult() {
  const raw = String(process.env.CLOUD_ASR_MOCK_TRANSCRIPT || "").trim();
  const text = raw || "今天会议确认：先完成云端 ASR 接入，再生成会议纪要草稿；Feishu 发布保持 dry-run。";
  return {
    transcripts: [{
      text,
      sentences: [
        { begin_time: 0, end_time: 4500, text, sentence_id: 1, speaker_id: "speaker_1" },
      ],
    }],
    properties: { original_duration_in_milliseconds: 4500 },
  };
}

export async function executeCloudASRTranscription(params = {}) {
  const runID = params.runID || "run";
  const attachments = Array.isArray(params.attachments) ? params.attachments : [];
  const attachment = attachments.find(isAudioVideoAttachment) || null;
  const config = buildConfig();
  if (!attachment) {
    const artifacts = writeASRArtifacts({
      runID,
      sessionID: params.sessionID,
      attachment: null,
      status: "degraded",
      reason: "cloud_asr_no_audio_video_attachment",
      providerStatus: "not_started",
      model: config.model,
      segments: [],
    });
    return {
      status: "degraded",
      outputSummary: "Cloud ASR not started; no audio/video attachment was provided.",
      details: { status: "degraded", provider: "aliyun-bailian-dashscope", summary: artifacts.summary, artifactPath: artifacts.summary.artifactPath },
    };
  }
  try {
    if (config.mockMode) {
      const rawResult = mockTranscriptResult();
      const segments = normalizeSegments(rawResult);
      const artifacts = writeASRArtifacts({
        runID,
        sessionID: params.sessionID,
        attachment,
        status: "completed",
        reason: "mock_cloud_asr_completed",
        providerStatus: "mock",
        model: config.model,
        uploadInfo: { uploadProvider: "aliyun-oss", bucket: "mock", region: config.ossRegion, objectKey: `mock/${runID}`, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
        taskID: "mock-task",
        rawResult,
        segments,
      });
      return {
        status: "completed",
        outputSummary: `Cloud ASR mock transcription completed; ${segments.length} segment(s).`,
        details: { status: "completed", provider: "aliyun-bailian-dashscope", model: config.model, summary: artifacts.summary, artifactPath: artifacts.summary.artifactPath },
      };
    }
    const missing = missingConfig(config);
    if (missing.length) {
      const artifacts = writeASRArtifacts({
        runID,
        sessionID: params.sessionID,
        attachment,
        status: "degraded",
        reason: `missing_cloud_asr_config:${missing.join(",")}`,
        providerStatus: "missing_config",
        model: config.model,
        segments: [],
      });
      return {
        status: "degraded",
        outputSummary: `Cloud ASR provider not configured; missing ${missing.join(", ")}.`,
        details: { status: "degraded", provider: "aliyun-bailian-dashscope", model: config.model, missingEnv: missing, summary: artifacts.summary, artifactPath: artifacts.summary.artifactPath },
      };
    }
    const uploadInfo = await uploadAttachmentToOSS(attachment, config, { runID });
    const taskID = await submitDashScopeTask({ config, signedURL: uploadInfo.signedURL });
    const taskPayload = await pollDashScopeTask({ config, taskID });
    const transcriptionURL = transcriptionURLFromTask(taskPayload);
    if (!transcriptionURL) throw new Error("cloud_asr_transcription_url_missing");
    const rawResult = await fetchTranscriptionJSON(transcriptionURL);
    const segments = normalizeSegments(rawResult);
    const artifacts = writeASRArtifacts({
      runID,
      sessionID: params.sessionID,
      attachment,
      status: segments.length ? "completed" : "degraded",
      reason: segments.length ? null : "cloud_asr_empty_transcript",
      providerStatus: "succeeded",
      model: config.model,
      uploadInfo,
      taskID,
      rawResult,
      segments,
    });
    return {
      status: segments.length ? "completed" : "degraded",
      outputSummary: `Cloud ASR transcription ${segments.length ? "completed" : "returned empty transcript"}; ${segments.length} segment(s).`,
      details: { status: segments.length ? "completed" : "degraded", provider: "aliyun-bailian-dashscope", model: config.model, summary: artifacts.summary, artifactPath: artifacts.summary.artifactPath },
    };
  } catch (error) {
    const artifacts = writeASRArtifacts({
      runID,
      sessionID: params.sessionID,
      attachment,
      status: "degraded",
      reason: redact(error?.message || error),
      providerStatus: "failed",
      model: config.model,
      segments: [],
    });
    return {
      status: "degraded",
      outputSummary: `Cloud ASR failed or degraded: ${redact(error?.message || error)}`,
      details: { status: "degraded", provider: "aliyun-bailian-dashscope", model: config.model, summary: artifacts.summary, artifactPath: artifacts.summary.artifactPath },
    };
  }
}

export function cloudASRArtifactPaths(runID) {
  return {
    transcriptPath: artifactPath(runID, "cloud-asr-transcript.json"),
    summaryPath: artifactPath(runID, "cloud-asr-summary.json"),
    sourcePackPath: artifactPath(runID, "meeting-source-pack.json"),
  };
}
