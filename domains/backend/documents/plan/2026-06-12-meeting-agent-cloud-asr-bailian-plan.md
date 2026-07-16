# Meeting Agent Cloud ASR Bailian Plan

- Date: 2026-06-12
- Status: implemented
- Scope: Office / Meeting capability package only

## Summary

Meeting Agent ASR now uses non-realtime cloud transcription instead of a local fixed ASR thread. User-dropped meeting audio/video is treated as a cloud transcription input, uploaded through an OSS temporary URL, then submitted to Alibaba Cloud Bailian / DashScope ASR.

The v1 path is file-based and non-realtime. It does not add live meeting WebSocket ASR, local Qwen ASR, Feishu live publish/reply, or a top-level ASR workbench surface.

Official model basis:

- Alibaba Model Studio speech recognition recommends non-realtime recording-file recognition through HTTP for completed audio/video files.
- `fun-asr` is the default meeting model because it supports speaker diarization and up to 12h / 2GB files.
- `qwen3-asr-flash-filetrans` remains an optional fallback for non-realtime file transcription and emotion-aware use cases.

## Runtime Contract

Internal tool:

- `office.cloud_asr.transcribe`

Routing:

- Audio/video meeting tasks route to `office.cloud_asr.transcribe` before `office.meeting_minutes.draft`.
- Image attachments still route to image analysis; audio/video attachments no longer trigger Kimi image analysis.
- Plain meeting minutes tasks without media continue to generate draft-only artifacts without invoking ASR.

Artifacts:

- `cloud-asr-transcript.json`
  - schema: `cloud-asr-transcript-v1`
  - contains transcript segments, speaker labels when available, model/provider metadata, attachment IDs, and redaction flags.
- `cloud-asr-summary.json`
  - schema: `cloud-asr-summary-v1`
  - contains cloud ASR status, user-visible cloud upload label, review requirement, transcript path, source pack path, and privacy flags.
- `meeting-source-pack.json`
  - schema: `meeting-source-pack-v1`
  - contains bounded transcript chunks for meeting draft consumption.

Privacy / safety:

- Raw audio/video is not copied into run artifacts.
- Raw provider request bodies, headers, API keys, OSS signatures, and unredacted provider payloads are not persisted.
- The user-visible label must remain: `云端转写 · 阿里云百炼 · OSS 临时上传`.
- ASR failure or missing config degrades to transcript review required; the Agent must not fabricate a transcript.

## Configuration

Environment variables:

- `DASHSCOPE_API_KEY` or `BAILIAN_API_KEY`
- `DASHSCOPE_BASE_URL`
- `BAILIAN_ASR_MODEL` default `fun-asr`
- `BAILIAN_ASR_FALLBACK_MODEL` default `qwen3-asr-flash-filetrans`
- `CLOUD_ASR_TIMEOUT_MS`
- `CLOUD_ASR_POLL_INTERVAL_MS`
- `CLOUD_ASR_UPLOAD_TTL_SECONDS`
- `ALIYUN_OSS_BUCKET`
- `ALIYUN_OSS_REGION`
- `ALIYUN_OSS_ENDPOINT`
- `ALIYUN_OSS_ACCESS_KEY_ID`
- `ALIYUN_OSS_ACCESS_KEY_SECRET`
- `ALIYUN_OSS_SECURITY_TOKEN`

Test-only:

- `WECHAT_AGENT_MOCK_CLOUD_ASR=1`
- `CLOUD_ASR_MOCK_TRANSCRIPT`

## Swift App Surface

Command Desk keeps the same top-level IA. ASR appears only inside Office workflow:

- Office composer can add an audio/video attachment.
- The attachment is marked `ready_for_cloud_asr`.
- Task-local result canvas can show a compact `Cloud ASR · status · segments` chip.
- Task detail sheet has an ASR tab for provider/model/status/review metadata.
- The final answer remains sourced only from `AgentFinalReadModel.finalText`.

No permanent ASR panel, local ASR controls, provider IDs, request payloads, OSS URLs, or internal tools are exposed.

## Verification

Completed on 2026-06-12:

- `node --check agent-runtime/core/providers/cloud-asr-provider.mjs`: pass.
- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- `node domains/agent/code/agent-runtime/core/run-loop/agent-runtime-core.test.mjs`: pass.
- `node domains/agent/code/agent-runtime/core/providers/runtime-tool-executor.test.mjs`: pass.
- `node domains/agent/code/agent-runtime/control-plane/smoke-test.mjs`: pass.
- `npm test`: pass with `office_meeting_cloud_asr` business QA.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass.

Remaining manual acceptance:

- Configure real DashScope + OSS credentials.
- Drag a real meeting audio/video file in Office mode.
- Confirm the task shows the cloud transcription label, transcript review metadata, and generated meeting draft without storing raw media in run artifacts.
