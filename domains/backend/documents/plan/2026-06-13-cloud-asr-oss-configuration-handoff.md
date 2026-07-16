# Cloud ASR OSS Configuration Handoff

- Date: 2026-06-14
- Status: OSS bucket created; local runtime config prefilled except private DashScope / RAM AK-SK values
- Scope: Meeting Agent cloud ASR only

## Summary

The Meeting Agent cloud ASR runtime is implemented. Alibaba Cloud OSS is now enabled and the dedicated bucket has been created. The remaining step is to fill local private credentials into `.env` and run the OSS signing consistency check.

Current local state:

- `DASHSCOPE_BASE_URL`, ASR model names, timeout, poll interval, upload TTL, OSS bucket, OSS region, and OSS endpoint are present in `.env`.
- `ALIYUN_OSS_BUCKET=meetingagent-feishu`.
- `ALIYUN_OSS_REGION=cn-beijing`.
- `ALIYUN_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com`.
- `DASHSCOPE_API_KEY`, `ALIYUN_OSS_ACCESS_KEY_ID`, and `ALIYUN_OSS_ACCESS_KEY_SECRET` are still private values that must be filled locally.
- No local `aliyun` CLI is installed.
- No local `~/.aliyun/config.json` or `~/.ossutilconfig` was found.
- `VoiceInput.app` contains DashScope realtime ASR support, but it does not contain OSS bucket or file-transcription configuration that can be reused by this project.
- `assignment agent_副本` remains a local Qwen3-ASR reference and does not provide cloud OSS configuration.

The repo now includes a local consistency check:

```bash
cd /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/agent-runtime
npm run cloud-asr:oss-check
```

The check reads `.env`, signs a PUT and GET URL using the same OSS V1 signing shape used by the runtime, uploads a small non-sensitive probe object under `agent-asr/config-check/`, downloads it back, compares content, and never prints AK/SK. Because the minimum RAM policy intentionally only grants `oss:PutObject` and `oss:GetObject`, the probe object is not deleted by the script and should be cleaned by the bucket lifecycle rule.

## Runtime Configuration Required

The current provider reads these variables from `intelligence-agent-web3/.env`:

```env
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
BAILIAN_ASR_MODEL=fun-asr
BAILIAN_ASR_FALLBACK_MODEL=qwen3-asr-flash-filetrans
CLOUD_ASR_TIMEOUT_MS=900000
CLOUD_ASR_POLL_INTERVAL_MS=2000
CLOUD_ASR_UPLOAD_TTL_SECONDS=86400
ALIYUN_OSS_BUCKET=meetingagent-feishu
ALIYUN_OSS_REGION=cn-beijing
ALIYUN_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
ALIYUN_OSS_ACCESS_KEY_ID=
ALIYUN_OSS_ACCESS_KEY_SECRET=
ALIYUN_OSS_SECURITY_TOKEN=
```

Required non-placeholder values:

- `DASHSCOPE_API_KEY`
- `ALIYUN_OSS_ACCESS_KEY_ID`
- `ALIYUN_OSS_ACCESS_KEY_SECRET`

Optional:

- `ALIYUN_OSS_SECURITY_TOKEN` only when using STS temporary credentials.
- `CLOUD_ASR_UPLOAD_TTL_SECONDS` can be reduced to `3600` or `7200` for production.

## Recommended OSS Setup

Use a private bucket in the same region configured in `.env`.

Current first pass:

- Region: `cn-beijing`
- Endpoint: `oss-cn-beijing.aliyuncs.com`
- Bucket: `meetingagent-feishu`
- Object prefix: `agent-asr/`
- Lifecycle rule: delete objects under `agent-asr/` after 1-3 days.

Minimum RAM policy for the runtime credential:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject"
      ],
      "Resource": [
        "acs:oss:*:*:meetingagent-feishu/agent-asr/*"
      ]
    }
  ]
}
```

Do not use the Alibaba Cloud root account AccessKey. Use a RAM user or STS role scoped to this bucket prefix.

## Current Code Path

Provider:

- `agent-runtime/core/providers/cloud-asr-provider.mjs`

Flow:

1. User drops meeting audio/video.
2. Runtime uploads the attachment to OSS under `agent-asr/{runID}/...`.
3. Runtime generates a signed GET URL.
4. Runtime submits that URL to DashScope ASR.
5. Runtime polls the async task.
6. Runtime downloads the transcription JSON.
7. Runtime writes:
   - `cloud-asr-transcript.json`
   - `cloud-asr-summary.json`
   - `meeting-source-pack.json`

Current signing implementation:

- Uses OSS V1 style query signing: `OSSAccessKeyId`, `Expires`, `Signature`, and optional `security-token`.
- Alibaba Cloud now recommends OSS V4 signed URLs for long-term production.
- The current V1 path matches the implemented runtime and can be used for first live validation if the bucket allows it.
- Recommended follow-up: switch signing to OSS SDK / V4 after first live validation.

Official references:

- OSS V1 signed URL: https://help.aliyun.com/zh/oss/developer-reference/ddd-signatures-to-urls
- OSS V4 signed URL: https://help.aliyun.com/zh/oss/developer-reference/add-signatures-to-urls
- Alibaba Cloud Model Studio / Bailian entry: https://help.aliyun.com/zh/model-studio/
- Bailian console: https://bailian.console.aliyun.com/

## VoiceInput.app Reference

`/Users/chenge/Desktop/VoiceInput.app` is useful as a DashScope realtime ASR product reference, but not as OSS configuration source.

Observed facts:

- Bundle ID: `com.voiceinput.app`
- Version: `1.2.4`
- Contains local `sherpa-onnx` and `onnxruntime` frameworks.
- Contains DashScope realtime endpoints:
  - `wss://dashscope.aliyuncs.com/api-ws/v1/inference/`
  - `wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference/`
- Contains realtime model names such as:
  - `fun-asr-realtime-2026-02-28`
  - `fun-asr-realtime`
  - `fun-asr-flash-8k-realtime`

This project's Meeting Agent uses non-realtime file transcription through OSS temporary upload, so it should not copy the VoiceInput realtime WebSocket path.

## Safe Completion Options

### Option A: User Provides Values

User provides these values out of band or pastes them into `.env`:

```env
DASHSCOPE_API_KEY=<redacted>
ALIYUN_OSS_BUCKET=<bucket-name>
ALIYUN_OSS_REGION=cn-beijing
ALIYUN_OSS_ENDPOINT=oss-cn-beijing.aliyuncs.com
ALIYUN_OSS_ACCESS_KEY_ID=<redacted>
ALIYUN_OSS_ACCESS_KEY_SECRET=<redacted>
ALIYUN_OSS_SECURITY_TOKEN=
```

After that, run a live validation with a short non-sensitive audio fixture.

### Option B: Codex Operates Alibaba Cloud Console

This requires explicit user approval at action time because it creates persistent cloud access credentials.

Actions:

1. Open Alibaba Cloud console in a logged-in browser.
2. Create or select a private OSS bucket.
3. Add lifecycle rule for `agent-asr/`.
4. Create a RAM user or role with the minimum OSS policy above.
5. Copy generated AK/SK into local `.env`.
6. Run live validation.

Do not proceed with this option without explicit confirmation immediately before creating RAM credentials.

## Validation Plan

Preflight:

```bash
node --check agent-runtime/bin/check-cloud-asr-oss-config.mjs
node --check agent-runtime/core/providers/cloud-asr-provider.mjs
node --check agent-runtime/bin/wechat-agent-daemon.mjs
```

OSS signing consistency after filling `.env`:

```bash
cd domains/agent/code/agent-runtime
npm run cloud-asr:oss-check
```

Expected successful output shape:

```text
cloud_asr_oss_check=start
bucket=meetingagent-feishu
region=cn-beijing
endpoint=oss-cn-beijing.aliyuncs.com
access_key_id=****...****
dashscope_api_key=configured
oss_put=pass
oss_get=pass
cleanup=not_deleted_minimal_policy_put_get_only
cloud_asr_oss_check=pass
```

Mock path:

```bash
WECHAT_AGENT_MOCK_CLOUD_ASR=1 npm test
```

Live path after real config:

1. Ensure `WECHAT_AGENT_MOCK_CLOUD_ASR` is unset.
2. Use a short non-sensitive `.m4a` or `.wav` meeting fixture.
3. Start an Office / Meeting task with the audio attachment.
4. Confirm run artifacts:
   - `cloud-asr-summary.json` has `cloudASRStatus=completed`.
   - `cloud-asr-transcript.json` has bounded segments.
   - `meeting-source-pack.json` references transcript chunks.
   - No raw audio/video, raw provider request, headers, signed OSS URL, API key, or OSS secret is persisted.

## Current Remaining Step

As of this handoff, OSS service and bucket setup are complete enough for runtime validation. Fill these private values locally:

- `DASHSCOPE_API_KEY`
- `ALIYUN_OSS_ACCESS_KEY_ID`
- `ALIYUN_OSS_ACCESS_KEY_SECRET`

Then run `npm run cloud-asr:oss-check` from `agent-runtime`. If the check passes, proceed to a live Meeting Agent ASR validation with a short non-sensitive audio fixture.
