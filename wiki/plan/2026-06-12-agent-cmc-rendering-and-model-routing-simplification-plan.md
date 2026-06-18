# Agent CMC Rendering and Model Routing Simplification Plan

- Date: 2026-06-12
- Status: implemented on 2026-06-12
- Scope: CMC Skill Hub result rendering, gate simplification, model routing and fallback, Command Desk model selection

## 1. Decision Summary

Two current behaviors should change.

First, CMC Skill Hub MCP returned content should be treated as provider-returned content that the App can render. The App should not use broad evidence, parser, freshness, or price gates to decide whether the returned Skill Hub summary/conclusion is allowed to appear. Gate logic should protect safety and provenance, not hide useful MCP results because `readableEvidence=[]` or `assets=[]`.

Second, model failure for market, strategy, or evidence-heavy tasks should not stop at a deterministic local conclusion. If the selected deep/pro model fails, the runtime should continue through an explicit model fallback chain, record the fallback, and only use deterministic output after all eligible models fail.

## 2. Current Problem

### 2.1 CMC Gate Is Still Too Semantic

The runtime currently separates:

- `transportStatus`
- `researchEvidenceStatus`
- `priceSnapshotStatus`
- `allowSkillHubResultDisplay`
- `allowConcretePrices`
- `productMutationPolicy`

This split was introduced to fix real bugs: fake live prices, empty parser fields, over-rewritten finals, and unsafe product mutations. The side effect is that the runtime still treats some business/parsing states as if they are hard gates.

For the product goal, this is too heavy. If CMC Skill Hub returns a summary or conclusion, the App should render it with source labeling. Parser fields are diagnostics, not permission checks.

### 2.2 Product Mutations Are Stricter Than Needed For Research Display

`productMutationPolicy.status=discarded` currently fires when structured parser evidence or price snapshot is empty. That may be reasonable for committing generated tasks/cards into persistent workbench state, but it should not influence whether the final answer or Skill Hub returned content is visible.

The new target is:

```text
Display is provider-result rendering.
Mutation commit is workspace state writing.
These must not share one broad "evidence usable" gate.
```

### 2.3 Model Fallback Is Too Abrupt

`model-route.json` already says `silentFallbackAllowed=false`, but runtime behavior still allows a deterministic local final when the model call returns no useful text.

For market and strategy tasks, that is the wrong user experience. If the user selects `deepseek-v4-pro` and it fails, the runtime should try `deepseek-v4-flash` or another eligible configured model before falling back to deterministic output. The final answer should say what happened only if fallback was used or all models failed.

## 3. Target CMC Rendering Contract

Replace broad display gates with a small render contract:

```json
{
  "schemaVersion": "cmc-render-result-v1",
  "capabilityID": "cmc-skill-hub",
  "transportStatus": "ok",
  "provider": "mcpProvider",
  "skill": "crypto_macro_overview",
  "returnedContent": {
    "summary": "...",
    "conclusion": "...",
    "marketRead": "...",
    "readableEvidence": []
  },
  "renderBlocks": [
    {
      "type": "provider_summary",
      "title": "CMC Skill Hub 返回",
      "body": "...",
      "source": "CMC Skill Hub MCP",
      "observedAt": "..."
    }
  ],
  "diagnostics": {
    "parserEvidenceStatus": "empty",
    "priceSnapshotStatus": "empty",
    "assetCount": 0,
    "emptyEvidenceReason": "parser_did_not_extract_structured_sections"
  },
  "claimPolicy": {
    "appMayAddConcretePrices": false,
    "providerReturnedNumbersMayRender": true,
    "appMayAddTradingLevels": false
  }
}
```

Meaning:

- `renderBlocks` are always eligible for UI display if they are provider-returned, redacted, and not secret/internal payload.
- `diagnostics` explain parsing gaps and missing structured price snapshot.
- `claimPolicy` controls what the App/LLM may add on top of the provider text.

## 4. Gates To Keep

Keep only engineering and safety gates:

- **Policy Gate**: trade execution, WeChat send, Feishu publish/reply, external posting, destructive actions, live document overwrite.
- **Secret/Internal Surface Guard**: secrets, headers, raw request bodies, provider internals, tool IDs, local paths, artifact schema fields.
- **Contract Validation**: malformed artifacts, invalid schema versions, missing `runID`, broken final read model.
- **Claim Provenance Guard**: App/LLM-generated prices, support/resistance, entry/exit, stop loss, take profit, or trading ranges must be source-backed. Provider-returned numbers may render with source label.
- **Mutation Commit Gate**: persistent task/card/proposal/memory/handoff writes require schema validity, idempotency, allowed action scope, and source attribution.
- **Resource Guard**: timeout, cancellation, retry budget, concurrency limits.

## 5. Gates To Downgrade

These should become metadata, not blockers:

- `freshness`
- `confidence`
- `risk`
- `readableEvidence=[]`
- `assets=[]`
- `parserEvidenceStatus=empty`
- `priceSnapshotStatus=empty`
- `sourceTrust`
- `degraded`
- `emptyEvidenceReason`

They can appear in a data note or task-local review drawer. They should not hide a CMC Skill Hub summary/conclusion or replace it with a generic template.

## 6. CMC Runtime Changes

### 6.1 Replace Display Gate With Render Extraction

Add or repurpose the current `cmc-capability-summary.json` into a render-first artifact:

- Extract displayable content from:
  - `skillHubResult.summary`
  - `skillHubResult.conclusion`
  - `skillHubResult.marketRead.summary`
  - `skillHubResult.readableEvidence`
  - normalized MCP text content
- Write `renderBlocks[]` for Swift.
- Keep parser and price gaps in `diagnostics`.

Do not require `assets.length > 0` or `readableEvidence.length > 0` before writing render blocks.

### 6.2 Claim Provenance, Not Price Display Blocking

If Skill Hub returned text contains a number, keep it:

```text
CMC Skill Hub 返回：BTC is trading near 69,000...
```

If the model adds a number that is not in returned provider text or a structured price snapshot, strip only that unsupported line or claim:

```text
支撑 67,200 / 阻力 70,500
```

Do not replace the entire answer unless stripping leaves no meaningful content.

### 6.3 Mutation Commit Decoupling

`productMutationPolicy=discarded` may still apply to generated workbench state writes, but it must not imply:

- final answer hidden;
- Skill Hub summary hidden;
- run marked as useless;
- UI result canvas blocked.

Rename or document the scope as:

```text
workspaceMutationPolicy
```

The policy only answers: "May generated product state be committed?"

## 7. Model Routing Target

### 7.1 Frontend May Expose Model Names

Because this is a local expert workbench, model names can be visible. They are not secrets. The UI should allow explicit selection:

- `自动`
- `deepseek-v4-pro`
- `deepseek-v4-flash`

Kimi should be displayed as an attachment/vision model when relevant:

- `图片理解：kimi-k2.6`

Kimi should not be offered as the main final-answer text model unless the runtime later supports it as a text final provider.

### 7.2 Route Request

Swift should send an optional model preference:

```json
{
  "modelPreference": {
    "mode": "auto|explicit",
    "textModel": "deepseek-v4-pro|deepseek-v4-flash",
    "fallbackPolicy": "continue_with_eligible_models"
  }
}
```

No model preference means `auto`.

### 7.3 Route Artifact

Upgrade `model-route.json`:

```json
{
  "schemaVersion": "agent-model-route-v3",
  "selectedTextProvider": "deepseek",
  "selectedTextModel": "deepseek-v4-pro",
  "selectionSource": "user_explicit",
  "eligibleFallbackModels": ["deepseek-v4-flash"],
  "fallbackPolicy": {
    "continueOnFailure": true,
    "silentFallbackAllowed": false,
    "deterministicOnlyAfterModelsExhausted": true
  },
  "attempts": [
    {
      "provider": "deepseek",
      "model": "deepseek-v4-pro",
      "status": "failed",
      "reason": "provider_request_failed"
    },
    {
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "status": "completed"
    }
  ],
  "finalModel": "deepseek-v4-flash",
  "fallbackUsed": true,
  "userVisibleNoteRequired": true
}
```

### 7.4 Fallback Rules

The runtime should attempt models in order.

For `auto`:

- quick classification, prompt rewrite, short follow-up: `deepseek-v4-flash`
- crypto thesis, CMC research, strategy review, long Office draft: `deepseek-v4-pro`
- image/attachment summary: `kimi-k2.6` first, then selected DeepSeek final model

For explicit `deepseek-v4-pro`:

- try `deepseek-v4-pro`
- if failed, try `deepseek-v4-flash`
- record fallback
- final text includes a small data note only if fallback was used

For explicit `deepseek-v4-flash`:

- try `deepseek-v4-flash`
- if task is high-stakes market/strategy and the runtime judges flash insufficient, it may either:
  - ask for confirmation to use pro; or
  - auto-upgrade to pro if user chose `自动`, not if explicitly chose flash

For all models failed:

- only then use deterministic local final
- final must explicitly state:

```text
模型调用失败；以下仅为本地结构化摘要，不是 LLM 研究结论。
```

## 8. Frontend UX

Add a compact model picker in Command Composer:

```text
Model: 自动
       deepseek-v4-pro
       deepseek-v4-flash
```

Rules:

- Default is `自动`.
- The selected model is visible in the composer and task detail.
- The result canvas can show a small status line:

```text
Model: deepseek-v4-flash · fallback from deepseek-v4-pro
```

Do not show provider internals, API keys, request payloads, or raw error traces in the normal workbench. Detailed model attempt diagnostics belong in task-local detail/debug.

## 9. Implementation Order

1. Backend: introduce `modelPreference` request field and `agent-model-route-v3`.
2. Backend: implement model attempt chain with `deepseek-v4-pro` and `deepseek-v4-flash`.
3. Backend: ensure deterministic final is only used after eligible models are exhausted.
4. Backend: refactor CMC summary into render-first `renderBlocks[]`.
5. Backend: narrow output guard to secret/internal-surface and unsupported generated numeric/action claims.
6. Backend: decouple mutation commit from display eligibility.
7. Swift: add model picker with `自动 / deepseek-v4-pro / deepseek-v4-flash`.
8. Swift: render CMC returned blocks directly in result canvas.
9. Swift: show parser/price diagnostics as secondary data notes, not as blocking status.

## 10. Acceptance Criteria

- CMC Skill Hub MCP returned summary/conclusion renders even when `readableEvidence=[]` and `assets=[]`.
- Provider-returned numbers are preserved with source label.
- App/LLM-generated unsupported price levels are removed claim-by-claim, not via full final rewrite.
- `productMutationPolicy=discarded` does not hide final answer or CMC render blocks.
- Explicit `deepseek-v4-pro` failure continues to `deepseek-v4-flash`.
- Explicit model fallback is recorded in `model-route.json`.
- Deterministic final appears only after all eligible model attempts fail.
- Frontend can choose `自动`, `deepseek-v4-pro`, or `deepseek-v4-flash`.
- Frontend does not expose API keys, raw provider payloads, raw internal tools, or daemon stack traces.

## 11. Non-Goals

- Do not add trading execution.
- Do not add live WeChat sending.
- Do not add Feishu live publish/reply.
- Do not expose raw MCP payloads or request bodies.
- Do not convert model selection into a provider/debug console.
- Do not remove safety gates for secrets, destructive actions, external publishing, or unsupported generated claims.

## 12. Implementation Record

Implemented on 2026-06-12.

- Backend now writes `cmc-capability-summary.json` with compatibility schema `cmc-capability-summary-v1` plus render-first fields: `renderSchemaVersion=cmc-render-result-v1`, `returnedContent`, `renderBlocks`, `diagnostics`, `claimPolicy`, and `workspaceMutationPolicy`.
- CMC Skill Hub returned summary/conclusion/marketRead/readableEvidence can render even when parser evidence and structured price snapshots are empty.
- Output guard keeps provider-returned numbers when they appear in the CMC returned-text corpus, and strips unsupported generated market-number lines claim-by-claim.
- `model-route.json` is upgraded to `agent-model-route-v3`, records `modelPreference`, fallback policy, attempts, final model, and fallback visibility.
- Runtime accepts optional request `modelPreference` and attempts `deepseek-v4-pro -> deepseek-v4-flash` for explicit pro selection before deterministic fallback.
- Command Desk composer exposes `自动`, `deepseek-v4-pro`, and `deepseek-v4-flash`; result canvas can show CMC render blocks and model fallback status without exposing provider internals.

Verification:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- `node agent-runtime/control-plane/model-route.test.mjs`: pass.
- `node agent-runtime/core/final-output/deterministic-final-copy.test.mjs`: pass.
- `node agent-runtime/control-plane/smoke-test.mjs`: pass.
- `node agent-runtime/core/gates/gate-engine.test.mjs`: pass.
- Sandboxed `npm test`: blocked by expected local MongoDB `EPERM 127.0.0.1:27017` after core/control-plane tests passed.
- Approved non-sandbox `npm test`: pass.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass.
