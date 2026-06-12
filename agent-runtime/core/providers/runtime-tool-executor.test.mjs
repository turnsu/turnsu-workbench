import assert from "node:assert/strict";

import { cmcSkillForTool, executeRuntimeToolViaCore, extractSymbolsFromPrompt } from "./runtime-tool-executor.mjs";

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
    piKernel: {
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
    piKernel: {
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

console.log("agent_runtime_core_provider_executor=pass");
