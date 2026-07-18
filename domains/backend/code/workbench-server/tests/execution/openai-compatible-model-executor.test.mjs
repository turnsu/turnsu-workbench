import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfiguredOpenAICompatibleModelExecutor,
  createOpenAICompatibleModelExecutor,
} from "../../src/execution/index.mjs";

function modelInput() {
  return {
    input: {
      context: {
        systemPrompt: "Follow the product contract.",
        messages: [{ role: "user", content: [{ type: "text", text: "Create a proposal." }] }],
        tools: [{ name: "product_tool_0", description: "Governed lookup", parameters: { type: "object", properties: {} } }],
      },
      options: { maxTokens: 50000 },
    },
  };
}

test("configured model executor stays absent unless the complete host-only configuration exists", () => {
  assert.equal(createConfiguredOpenAICompatibleModelExecutor({ env: {} }), null);
  assert.throws(
    () => createConfiguredOpenAICompatibleModelExecutor({ env: { WORKBENCH_MODEL_API_KEY: "secret" } }),
    /workbench_model_configuration_incomplete/,
  );
  assert.throws(() => createOpenAICompatibleModelExecutor({
    baseUrl: "http://provider.example/v1",
    apiKey: "secret",
    model: "model-a",
  }), /model_provider_base_url_invalid/);
});

test("OpenAI-compatible executor converts Pi context and accepts only advertised tool calls", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: "I will use the governed tool.",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "product_tool_0", arguments: "{\"query\":\"safe\"}" },
          }],
        },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 3 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const executor = createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "host-only-secret",
    model: "model-a",
    fetchImpl,
  });

  assert.deepEqual(await executor.probe(), { available: true });
  const result = await executor(modelInput());
  assert.deepEqual(result.content, [
    { type: "text", text: "I will use the governed tool." },
    { type: "toolCall", id: "call-1", name: "product_tool_0", arguments: { query: "safe" } },
  ]);
  assert.deepEqual(result.usage, { input: 20, output: 8, cacheRead: 3, cacheWrite: 0 });
  assert.equal(calls[1].url, "https://provider.example/v1/chat/completions");
  assert.equal(calls[1].options.headers.authorization, "Bearer host-only-secret");
  const request = JSON.parse(calls[1].options.body);
  assert.equal(request.model, "model-a");
  assert.equal(request.max_tokens, 32768);
  assert.equal(request.tools[0].function.name, "product_tool_0");
});

test("provider failures and unadvertised tool calls return fixed product-safe errors", async () => {
  const denied = createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret-never-returned",
    model: "model-a",
    fetchImpl: async () => new Response("provider-secret-response", { status: 401 }),
  });
  await assert.rejects(denied(modelInput()), (error) => (
    error.code === "provider_auth_failed"
      && error.productSafe === true
      && !error.message.includes("provider-secret-response")
      && !error.message.includes("secret-never-returned")
  ));

  const escalation = createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    model: "model-a",
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "call-2", type: "function", function: { name: "shell", arguments: "{}" } }] } }],
    }), { status: 200 }),
  });
  await assert.rejects(escalation(modelInput()), { code: "provider_response_invalid", status: "failed" });
});
