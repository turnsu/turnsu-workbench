import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isolatedRuntimeRoot = mkdtempSync(join(tmpdir(), "looloomi-provider-unit-"));
process.env.WECHAT_AGENT_TEST_MODE = "1";
process.env.WECHAT_AGENT_RUNTIME_ROOT = isolatedRuntimeRoot;
process.on("exit", () => rmSync(isolatedRuntimeRoot, { recursive: true, force: true }));

const {
  cmcSkillForTool,
  executeRuntimeToolViaCore,
  extractSymbolsFromPrompt,
} = await import("./runtime-tool-executor.mjs");

assert.deepEqual(extractSymbolsFromPrompt("Review BTC, ETH and ETF flow", ["SOL"]), ["BTC", "ETH"]);
assert.deepEqual(extractSymbolsFromPrompt("Review market", ["BTC", "ETH", "SOL"]), ["BTC", "ETH", "SOL"]);
assert.equal(cmcSkillForTool("cmc.crypto_macro_overview"), "crypto_macro_overview");
assert.equal(cmcSkillForTool("cmc.track_social_price_divergence"), "track_social_price_divergence");

{
  const calls = [];
  const result = await executeRuntimeToolViaCore("cmc.crypto_macro_overview", {
    prompt: "Review BTC macro thesis",
    runID: "run-provider-test",
  }, {
    cmcDefaultSymbols: ["ETH"],
    refreshCMCLive: async (params) => {
      calls.push(params);
      return {
        status: "ok",
        provider: "mcpProvider",
        providerType: "mcpHttpProvider",
        protocol: "mcp_http",
        skill: params.skill,
        artifact: "runtime/market/latest-market-snapshot.json",
        assets: 1,
        skillHubResult: {
          skill: params.skill,
          status: "ok",
          confidence: "high",
          summary: "BTC macro result",
        },
      };
    },
    runtimeKernel: {
      executeTool: async () => {
        throw new Error("pi_should_not_handle_cmc_tool");
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].symbols, ["BTC"]);
  assert.equal(calls[0].skill, "crypto_macro_overview");
  assert.equal(result.status, "completed");
  assert.equal(result.details.provider, "mcpProvider");
  assert.equal(result.details.skillHubResult.summary, "BTC macro result");
}

{
  const result = await executeRuntimeToolViaCore("office.document.draft", {
    prompt: "draft",
  }, {
    refreshCMCLive: async () => {
      throw new Error("cmc_should_not_handle_office_tool");
    },
    runtimeKernel: {
      executeTool: async (toolName, params) => ({
        status: "completed",
        toolName,
        outputSummary: params.prompt,
        details: { source: "pi" },
      }),
    },
  });
  assert.equal(result.toolName, "office.document.draft");
  assert.equal(result.details.source, "pi");
}

{
  const runID = "run-provider-cloud-asr-test";
  const attachmentID = "attachment-cloud-asr-test";
  const runtimeRoot = resolve(isolatedRuntimeRoot, "agent");
  const attachmentDir = resolve(runtimeRoot, "attachments", attachmentID);
  const runDir = resolve(runtimeRoot, "runs", runID);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(attachmentDir, { recursive: true });
  const sourcePath = resolve(attachmentDir, "original.m4a");
  writeFileSync(sourcePath, "mock audio bytes");
  const previousMock = process.env.WECHAT_AGENT_MOCK_CLOUD_ASR;
  process.env.WECHAT_AGENT_MOCK_CLOUD_ASR = "1";
  try {
    const result = await executeRuntimeToolViaCore("office.cloud_asr.transcribe", {
      prompt: "转写会议录音并生成纪要",
      runID,
      sessionID: "session-provider-test",
      attachments: [{
        attachmentID,
        fileName: "meeting.m4a",
        originalPath: sourcePath,
        artifactPath: `runtime/agent/attachments/${attachmentID}/original.m4a`,
        mimeType: "audio/mp4",
        sha256: "mock",
        sizeBytes: 16,
        status: "ready_for_cloud_asr",
      }],
    }, {
      refreshCMCLive: async () => {
        throw new Error("cmc_should_not_handle_cloud_asr_tool");
      },
      runtimeKernel: {
        executeTool: async () => {
          throw new Error("pi_should_not_handle_cloud_asr_tool");
        },
      },
    });
    assert.equal(result.status, "completed");
    const summaryPath = resolve(runDir, "cloud-asr-summary.json");
    const transcriptPath = resolve(runDir, "cloud-asr-transcript.json");
    assert.ok(existsSync(summaryPath));
    assert.ok(existsSync(transcriptPath));
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
    assert.equal(summary.schemaVersion, "cloud-asr-summary-v1");
    assert.equal(summary.cloudUpload, true);
    assert.equal(summary.rawProviderRequestIncluded, false);
    assert.equal(summary.secretsIncluded, false);
    assert.equal(transcript.rawAudioStored, false);
    assert.ok(transcript.segments.length >= 1);
  } finally {
    if (previousMock === undefined) {
      delete process.env.WECHAT_AGENT_MOCK_CLOUD_ASR;
    } else {
      process.env.WECHAT_AGENT_MOCK_CLOUD_ASR = previousMock;
    }
    rmSync(runDir, { recursive: true, force: true });
    rmSync(attachmentDir, { recursive: true, force: true });
  }
}

console.log("agent_runtime_core_provider_executor=pass");
