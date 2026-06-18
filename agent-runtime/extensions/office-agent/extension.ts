import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(extensionDir, "..", "..");
const projectRoot = resolve(agentRuntimeRoot, "..");
const runtimeRoot = join(projectRoot, "runtime");

const TOOL_PARAMS = Type.Object({
  runID: Type.String(),
  sessionID: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  contextRefs: Type.Optional(Type.Array(Type.Any())),
  contextManifestRef: Type.Optional(Type.String()),
  contextBundleRef: Type.Optional(Type.String()),
});

function now() {
  return new Date().toISOString();
}

function safeRunID(value: string) {
  return String(value || "run").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function runArtifact(runID: string, name: string) {
  return join(runtimeRoot, "agent", "runs", safeRunID(runID), name);
}

function writeJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function readJSON(path: string, fallback: any = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function redactedPreview(value: unknown, maxChars = 360) {
  const text = String(value || "")
    .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function evidenceRefs(params: any) {
  const cloudASRSummary = readJSON(runArtifact(params.runID, "cloud-asr-summary.json"), null);
  const meetingSourcePack = readJSON(runArtifact(params.runID, "meeting-source-pack.json"), null);
  return {
    contextManifestRef: params.contextManifestRef || `runtime/agent/runs/${params.runID}/context-manifest.json`,
    contextBundleRef: params.contextBundleRef || `runtime/agent/runs/${params.runID}/context-bundle.json`,
    contextRefCount: Array.isArray(params.contextRefs) ? params.contextRefs.length : 0,
    cloudASRStatus: cloudASRSummary?.cloudASRStatus || "not_requested",
    cloudASRSummaryRef: cloudASRSummary?.artifactPath || null,
    meetingSourcePackRef: meetingSourcePack?.artifactPath || null,
    asrTranscriptPath: cloudASRSummary?.transcriptPath || null,
    speakerDiarizationStatus: cloudASRSummary?.speakerDiarizationStatus || "not_requested",
    needsTranscriptReview: cloudASRSummary ? cloudASRSummary.needsTranscriptReview !== false : false,
    cloudUploadLabel: cloudASRSummary?.userVisibleLabel || null,
    rawTranscriptIncluded: false,
    rawProviderRequestIncluded: false,
    secretsIncluded: false,
  };
}

function basePolicy() {
  return {
    qaGateRequiredBeforePublish: true,
    policyGateRequiredBeforePublish: true,
    livePublishBlocked: true,
    liveReplyBlocked: true,
    destructiveActionsBlocked: true,
    productMutationsWritten: false,
  };
}

export default function registerOfficeAgentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "office.meeting_minutes.draft",
    description: "Create a bounded local meeting-minutes draft read model without publishing or sending messages.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const artifactPath = `runtime/agent/runs/${params.runID}/office-meeting-minutes-draft.json`;
      const evidence = evidenceRefs(params);
      const payload = {
        schemaVersion: "office-meeting-minutes-read-model-v1",
        runID: params.runID,
        sessionID: params.sessionID || null,
        status: evidence.cloudASRStatus === "degraded" ? "draft_only_transcript_missing_or_failed" : "draft_only",
        title: "Meeting minutes draft",
        promptPreview: redactedPreview(params.prompt),
        sections: [
          { id: "summary", title: "Summary", status: "needs_evidence_review" },
          { id: "decisions", title: "Decisions", status: "needs_evidence_review" },
          { id: "action_items", title: "Action Items", status: "needs_owner_due_date_review" },
          { id: "risks", title: "Risks / Open Questions", status: "needs_evidence_review" },
        ],
        evidence,
        cloudASR: {
          status: evidence.cloudASRStatus,
          userVisibleLabel: evidence.cloudUploadLabel,
          transcriptPath: evidence.asrTranscriptPath,
          summaryPath: evidence.cloudASRSummaryRef,
          sourcePackPath: evidence.meetingSourcePackRef,
          speakerDiarizationStatus: evidence.speakerDiarizationStatus,
          needsTranscriptReview: evidence.needsTranscriptReview,
          rawAudioStored: false,
          rawProviderRequestIncluded: false,
          secretsIncluded: false,
        },
        policy: basePolicy(),
        generatedAt: now(),
        artifactPath,
      };
      writeJSON(runArtifact(params.runID, "office-meeting-minutes-draft.json"), payload);
      return {
        content: [{ type: "text", text: "Office meeting minutes draft written as a local read model; no publish/reply action executed." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath, summary: payload },
      };
    },
  });

  pi.registerTool({
    name: "office.document.draft",
    description: "Create a private office document draft read model from bounded context.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const artifactPath = `runtime/agent/runs/${params.runID}/office-document-draft.json`;
      const prompt = String(params.prompt || "");
      const docType = /prd/i.test(prompt) ? "prd" : /tech|architecture|架构|技术/i.test(prompt) ? "technical_plan" : /ops|运营|执行/i.test(prompt) ? "ops_plan" : "general_document";
      const payload = {
        schemaVersion: "office-document-read-model-v1",
        runID: params.runID,
        sessionID: params.sessionID || null,
        status: "draft_only",
        docType,
        title: docType === "prd" ? "PRD Draft" : docType === "technical_plan" ? "Technical Plan Draft" : "Document Draft",
        promptPreview: redactedPreview(prompt),
        outline: [
          { id: "context", title: "Context", status: "draft" },
          { id: "goals", title: "Goals", status: "draft" },
          { id: "requirements", title: "Requirements", status: "draft" },
          { id: "risks", title: "Risks", status: "draft" },
          { id: "next_steps", title: "Next Steps", status: "draft" },
        ],
        evidence: evidenceRefs(params),
        policy: basePolicy(),
        generatedAt: now(),
        artifactPath,
      };
      writeJSON(runArtifact(params.runID, "office-document-draft.json"), payload);
      return {
        content: [{ type: "text", text: "Office document draft written locally; publish/overwrite remains blocked." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath, summary: payload },
      };
    },
  });

  pi.registerTool({
    name: "office.document_revision.draft",
    description: "Create a non-destructive local document revision draft read model.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const artifactPath = `runtime/agent/runs/${params.runID}/office-document-revision-draft.json`;
      const payload = {
        schemaVersion: "office-document-revision-read-model-v1",
        runID: params.runID,
        sessionID: params.sessionID || null,
        status: "draft_only",
        revisionMode: "non_destructive_overlay",
        promptPreview: redactedPreview(params.prompt),
        coverage: {
          commentAnchorsRequired: true,
          missingCommentAccessIsBlocking: true,
          directOverwriteBlocked: true,
        },
        evidence: evidenceRefs(params),
        policy: basePolicy(),
        generatedAt: now(),
        artifactPath,
      };
      writeJSON(runArtifact(params.runID, "office-document-revision-draft.json"), payload);
      return {
        content: [{ type: "text", text: "Office document revision draft written locally; destructive overwrite remains blocked." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath, summary: payload },
      };
    },
  });

  pi.registerTool({
    name: "channel.feishu.dry_run",
    description: "Write a Feishu channel dry-run read model. Does not call lark-cli, publish, reply, or notify.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const artifactPath = `runtime/agent/runs/${params.runID}/feishu-channel-dry-run.json`;
      const payload = {
        schemaVersion: "channel-feishu-dry-run-read-model-v1",
        runID: params.runID,
        sessionID: params.sessionID || null,
        status: "dry_run_only",
        promptPreview: redactedPreview(params.prompt),
        channelCapabilityMatrix: {
          readContext: "read_only_when_configured",
          writePrivateDraft: "pass",
          publishCustomerVisible: "blocked_until_QA_Policy_channel_ready",
          notifyPeople: "needs_confirmation",
          deleteOrClear: "blocked",
        },
        liveActionsExecuted: false,
        larkCliCalled: false,
        remoteHandlerCalled: false,
        evidence: evidenceRefs(params),
        policy: basePolicy(),
        generatedAt: now(),
        artifactPath,
      };
      writeJSON(runArtifact(params.runID, "feishu-channel-dry-run.json"), payload);
      return {
        content: [{ type: "text", text: "Feishu channel dry-run artifact written; no live reply, publish, notify, or lark-cli action executed." }],
        details: { status: "completed", provider: "dryRunChannelProvider", artifactPath, summary: payload },
      };
    },
  });
}
