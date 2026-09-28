import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnthropicModelExecutor,
  createGeminiModelExecutor,
  createOpenAICompatibleModelExecutor,
} from "../../src/execution/index.mjs";

function modelInput({ responseSchema } = {}) {
  return {
    input: {
      context: {
        systemPrompt: "Use governed tools only.",
        messages: [{ role: "user", content: [{ type: "text", text: "Find it" }] }],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
      },
      options: { maxTokens: 300 },
      ...(responseSchema ? { responseSchema } : {}),
    },
  };
}

test("Anthropic driver declares Messages capabilities, uses native tools, and normalizes usage", async () => {
  const calls = [];
  const executor = createAnthropicModelExecutor({
    apiKey: "anthropic-secret",
    model: "claude-test",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        content: [
          { type: "text", text: "Checking" },
          { type: "tool_use", id: "tool-1", name: "lookup", input: { query: "safe" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 },
      }), { status: 200 });
    },
  });
  const result = await executor(modelInput());
  assert.equal(executor.protocol, "anthropic_messages");
  assert.deepEqual(executor.capabilities, ["chat", "tool_calling", "structured_output", "image_input"]);
  assert.equal(executor.structuredOutput.wireField, "output_config.format");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].options.headers["x-api-key"], "anthropic-secret");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "claude-test");
  assert.equal(body.tools[0].input_schema.type, "object");
  assert.deepEqual(result.content[1], {
    type: "toolCall", id: "tool-1", name: "lookup", arguments: { query: "safe" },
  });
  assert.deepEqual(result.toolCalls, [{ id: "tool-1", name: "lookup", arguments: { query: "safe" } }]);
  assert.deepEqual(result.usage, { input: 9, output: 4, cacheRead: 2, cacheWrite: 0 });
});

test("Gemini driver declares generateContent capabilities, uses native tools, and normalizes usage", async () => {
  const calls = [];
  const executor = createGeminiModelExecutor({
    apiKey: "gemini-secret",
    model: "gemini-test",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        candidates: [{
          content: {
            parts: [
              { text: "Checking" },
              {
                functionCall: { name: "lookup", args: { query: "safe" } },
                thoughtSignature: "opaque-thought-signature",
              },
            ],
          },
          finishReason: "STOP",
        }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, cachedContentTokenCount: 1 },
      }), { status: 200 });
    },
  });
  const result = await executor(modelInput());
  assert.equal(executor.protocol, "gemini_generate_content");
  assert.deepEqual(executor.capabilities, ["chat", "tool_calling", "structured_output", "image_input"]);
  assert.equal(executor.structuredOutput.wireField, "generationConfig.responseJsonSchema");
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.equal(calls[0].options.headers["x-goog-api-key"], "gemini-secret");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.systemInstruction.parts[0].text, "Use governed tools only.");
  assert.equal(body.tools[0].functionDeclarations[0].name, "lookup");
  assert.deepEqual(result.content[1], {
    type: "toolCall",
    id: "gemini-tool-1",
    name: "lookup",
    arguments: { query: "safe" },
    thoughtSignature: "opaque-thought-signature",
  });
  assert.deepEqual(result.toolCalls, [{
    id: "gemini-tool-1",
    name: "lookup",
    arguments: { query: "safe" },
    thoughtSignature: "opaque-thought-signature",
  }]);
  assert.deepEqual(result.usage, { input: 8, output: 3, cacheRead: 1, cacheWrite: 0 });
});

test("Chat drivers preserve assistant string history and Gemini tool thought signatures", async () => {
  const captured = {};
  const historyInput = {
    input: {
      context: {
        messages: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: "Follow up" },
        ],
        tools: [],
      },
    },
  };
  const openai = createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    model: "openai-history",
    fetchImpl: async (_url, options) => {
      captured.openai = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      }), { status: 200 });
    },
  });
  const anthropic = createAnthropicModelExecutor({
    apiKey: "secret",
    model: "anthropic-history",
    fetchImpl: async (_url, options) => {
      captured.anthropic = JSON.parse(options.body);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }), { status: 200 });
    },
  });
  const geminiBodies = [];
  const gemini = createGeminiModelExecutor({
    apiKey: "secret",
    model: "gemini-history",
    fetchImpl: async (_url, options) => {
      geminiBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      }), { status: 200 });
    },
  });
  await Promise.all([openai(historyInput), anthropic(historyInput), gemini(historyInput)]);
  assert.equal(captured.openai.messages[1].content, "Earlier answer");
  assert.deepEqual(captured.anthropic.messages[1].content, [{
    type: "text",
    text: "Earlier answer",
  }]);
  assert.deepEqual(geminiBodies[0].contents[1].parts, [{ text: "Earlier answer" }]);

  await gemini({
    input: {
      context: {
        messages: [
          { role: "user", content: "Use the tool" },
          {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "call-1",
              name: "lookup",
              arguments: { query: "safe" },
              thoughtSignature: "opaque-thought-signature",
            }],
          },
          { role: "tool", toolCallId: "call-1", content: "{\"ok\":true}" },
        ],
        tools: [{
          name: "lookup",
          parameters: { type: "object", properties: {} },
        }],
      },
    },
  });
  assert.equal(
    geminiBodies[1].contents[1].parts[0].thoughtSignature,
    "opaque-thought-signature",
  );
});

test("vision-capable chat drivers translate governed image parts into provider-native request shapes", async () => {
  const imageMessage = {
    input: {
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            { type: "image", mediaType: "image/png", dataBase64: "aW1hZ2U=" },
          ],
        }],
        tools: [],
      },
      options: { maxTokens: 100 },
    },
  };
  const captured = {};
  const openai = createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    model: "vision-openai",
    fetchImpl: async (_url, options) => {
      captured.openai = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200 });
    },
  });
  const anthropic = createAnthropicModelExecutor({
    apiKey: "secret",
    model: "vision-anthropic",
    fetchImpl: async (_url, options) => {
      captured.anthropic = JSON.parse(options.body);
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200 });
    },
  });
  const gemini = createGeminiModelExecutor({
    apiKey: "secret",
    model: "vision-gemini",
    fetchImpl: async (_url, options) => {
      captured.gemini = JSON.parse(options.body);
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200 });
    },
  });

  await Promise.all([
    openai(imageMessage),
    anthropic(imageMessage),
    gemini(imageMessage),
  ]);

  assert.deepEqual(captured.openai.messages[0].content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,aW1hZ2U=" },
  });
  assert.deepEqual(captured.anthropic.messages[0].content[1], {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "aW1hZ2U=",
    },
  });
  assert.deepEqual(captured.gemini.contents[0].parts[1], {
    inlineData: {
      mimeType: "image/png",
      data: "aW1hZ2U=",
    },
  });
});

test("Chat drivers translate JSON Schema constraints and normalize structured output", async (t) => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const cases = [
    {
      name: "OpenAI-compatible",
      create: (capture) => createOpenAICompatibleModelExecutor({
        baseUrl: "https://provider.example/v1", apiKey: "secret", model: "model-a",
        fetchImpl: async (_url, options) => {
          capture.push(JSON.parse(options.body));
          return new Response(JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "{\"answer\":\"ok\"}" } }],
            usage: { prompt_tokens: 4, completion_tokens: 2 },
          }), { status: 200 });
        },
      }),
      schemaAt: (body) => body.response_format.json_schema.schema,
    },
    {
      name: "Anthropic",
      create: (capture) => createAnthropicModelExecutor({
        apiKey: "secret", model: "claude-test",
        fetchImpl: async (_url, options) => {
          capture.push(JSON.parse(options.body));
          return new Response(JSON.stringify({
            content: [{ type: "text", text: "{\"answer\":\"ok\"}" }],
            stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 2 },
          }), { status: 200 });
        },
      }),
      schemaAt: (body) => body.output_config.format.schema,
    },
    {
      name: "Gemini",
      create: (capture) => createGeminiModelExecutor({
        apiKey: "secret", model: "gemini-test",
        fetchImpl: async (_url, options) => {
          capture.push(JSON.parse(options.body));
          return new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "{\"answer\":\"ok\"}" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
          }), { status: 200 });
        },
      }),
      schemaAt: (body) => body.generationConfig.responseJsonSchema,
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const capture = [];
      const result = await fixture.create(capture)(modelInput({ responseSchema: schema }));
      assert.deepEqual(fixture.schemaAt(capture[0]), schema);
      assert.deepEqual(result.structuredOutput, { answer: "ok" });
    });
  }
});

test("Chat provider errors keep auth, rate, content, timeout, cancel, request, response, and size distinct", async (t) => {
  const create = (fetchImpl, options = {}) => createOpenAICompatibleModelExecutor({
    baseUrl: "https://provider.example/v1",
    apiKey: "secret-never-returned",
    model: "model-a",
    fetchImpl,
    ...options,
  });
  const cases = [
    ["auth", async () => new Response("private", { status: 401 }), "provider_auth_failed"],
    ["rate", async () => new Response("private", { status: 429 }), "provider_rate_limited"],
    ["content", async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "content_filter", message: { content: "" } }],
    }), { status: 200 }), "provider_content_rejected"],
    ["request", async () => new Response("private", { status: 400 }), "provider_request_invalid"],
    ["response", async () => new Response("not-json", { status: 200 }), "provider_response_invalid"],
    ["size", async () => new Response("small", {
      status: 200, headers: { "content-length": "2048" },
    }), "provider_response_too_large", { maxResponseBytes: 1024 }],
  ];
  for (const [name, fetchImpl, code, options] of cases) {
    await t.test(name, async () => {
      await assert.rejects(create(fetchImpl, options)(modelInput()), (error) => (
        error.code === code
        && error.productSafe === true
        && !error.message.includes("secret-never-returned")
        && !error.message.includes("private")
      ));
    });
  }

  await t.test("timeout", async () => {
    const executor = create((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }), { timeoutMs: 5 });
    await assert.rejects(executor(modelInput()), { code: "provider_timeout", status: "timeout" });
  });

  await t.test("cancel", async () => {
    let called = false;
    const executor = create(async () => { called = true; return new Response("never"); });
    const controller = new AbortController();
    controller.abort(new Error("private caller reason"));
    await assert.rejects(executor({ ...modelInput(), signal: controller.signal }), {
      code: "cancelled", status: "cancelled",
    });
    assert.equal(called, false);
  });
});

test("Gemini safety blocks and unadvertised tool calls are normalized without provider payload leakage", async () => {
  const blocked = createGeminiModelExecutor({
    apiKey: "secret",
    model: "gemini-test",
    fetchImpl: async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }),
  });
  await assert.rejects(blocked(modelInput()), { code: "provider_content_rejected" });

  const invalidTool = createGeminiModelExecutor({
    apiKey: "secret",
    model: "gemini-test",
    fetchImpl: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "shell", args: {} } }] }, finishReason: "STOP" }],
    }), { status: 200 }),
  });
  await assert.rejects(invalidTool(modelInput()), { code: "provider_response_invalid" });
});
