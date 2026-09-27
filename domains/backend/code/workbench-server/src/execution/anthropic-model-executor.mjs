import { ModelProviderError } from "./openai-compatible-model-executor.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CHAT_CAPABILITIES = Object.freeze(["chat", "tool_calling", "structured_output", "image_input"]);

export function createAnthropicModelExecutor({
  baseUrl = "https://api.anthropic.com",
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const provider = validateConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes });
  const execute = async ({ input, signal } = {}) => {
    if (signal?.aborted) throw providerError("cancelled");
    const normalized = normalizeInput(input);
    const allowedTools = new Set(normalized.tools.map((tool) => tool.name));
    const request = providerRequest(normalized, provider.model);
    return withProviderDeadline({ signal, timeoutMs: provider.timeoutMs }, async (requestSignal) => {
      const response = await provider.fetchImpl(new URL("v1/messages", provider.baseUrl), {
        method: "POST",
        body: JSON.stringify(request),
        signal: requestSignal,
        headers: {
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": provider.apiKey,
        },
      });
      if (!response?.ok) throw await providerHttpError(response, provider.maxResponseBytes);
      return normalizeProviderResponse(
        parseProviderPayload(await readBoundedText(response, provider.maxResponseBytes)),
        allowedTools,
        { structuredOutput: normalized.responseSchema !== null },
      );
    });
  };
  execute.probe = async () => {
    try {
      const response = await withProviderDeadline({ timeoutMs: provider.timeoutMs }, (signal) => provider.fetchImpl(
        new URL(`v1/models/${encodeURIComponent(provider.model)}`, provider.baseUrl),
        {
          method: "GET",
          signal,
          headers: {
            accept: "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": provider.apiKey,
          },
        },
      ));
      return { available: response?.ok === true };
    } catch {
      return { available: false };
    }
  };
  execute.protocol = "anthropic_messages";
  execute.capabilities = CHAT_CAPABILITIES;
  execute.structuredOutput = Object.freeze({
    supported: true,
    mode: "json_schema",
    wireField: "output_config.format",
  });
  return Object.freeze(execute);
}

function validateConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes }) {
  if (typeof fetchImpl !== "function" || typeof apiKey !== "string" || apiKey.length < 1 || apiKey.length > 4096
    || typeof model !== "string" || model.length < 1 || model.length > 256
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new TypeError("model_provider_configuration_invalid");
  }
  return { baseUrl: validateBaseUrl(baseUrl), apiKey, model, fetchImpl, timeoutMs, maxResponseBytes };
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("model_provider_base_url_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError("model_provider_base_url_invalid");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url;
}

function normalizeInput(input) {
  if (!isPlainObject(input)) throw providerError("provider_request_invalid");
  const context = isPlainObject(input.context) ? input.context : input;
  const tools = context.tools ?? [];
  if (!Array.isArray(context.messages) || !Array.isArray(tools)) throw providerError("provider_request_invalid");
  const responseSchema = input.responseSchema ?? context.responseSchema ?? null;
  if (responseSchema !== null && !isPlainObject(responseSchema)) throw providerError("provider_request_invalid");
  return {
    messages: context.messages,
    tools,
    systemPrompt: context.systemPrompt,
    options: isPlainObject(input.options) ? input.options : {},
    responseSchema: responseSchema === null ? null : structuredClone(responseSchema),
  };
}

function providerRequest(input, model) {
  const system = [];
  if (typeof input.systemPrompt === "string" && input.systemPrompt.length > 0) system.push(input.systemPrompt);
  const messages = [];
  for (const message of input.messages) {
    if (message?.role === "system") {
      const text = textContent(message.content);
      if (text) system.push(text);
      continue;
    }
    messages.push(normalizeMessage(message));
  }
  const tools = input.tools.map(normalizeTool);
  return {
    model,
    max_tokens: Number.isSafeInteger(input.options.maxTokens)
      ? Math.min(32_768, Math.max(1, input.options.maxTokens))
      : 4_096,
    messages,
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: { type: "auto" } } : {}),
    ...(input.responseSchema === null ? {} : {
      output_config: { format: { type: "json_schema", schema: input.responseSchema } },
    }),
  };
}

function normalizeTool(tool) {
  const parameters = tool?.inputSchema ?? tool?.parameters;
  if (!isPlainObject(tool) || typeof tool.name !== "string" || tool.name.length < 1 || !isPlainObject(parameters)) {
    throw providerError("provider_request_invalid");
  }
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description.slice(0, 4000) : "",
    input_schema: structuredClone(parameters),
    ...(tool.strict === true ? { strict: true } : {}),
  };
}

function normalizeMessage(message) {
  if (!isPlainObject(message) || typeof message.role !== "string") throw providerError("provider_request_invalid");
  if (message.role === "user") return { role: "user", content: textBlocks(message.content) };
  if (message.role === "assistant") {
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    return {
      role: "assistant",
      content: blocks.map((item) => {
        if (item?.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
        if (item?.type === "thinking" && typeof item.thinking === "string") {
          return { type: "thinking", thinking: item.thinking };
        }
        if (item?.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string"
          && isPlainObject(item.arguments)) {
          return {
            type: "tool_use",
            id: item.id.slice(0, 256),
            name: item.name.slice(0, 256),
            input: structuredClone(item.arguments),
          };
        }
        throw providerError("provider_request_invalid");
      }),
    };
  }
  if (["tool", "toolResult"].includes(message.role)) {
    const toolUseId = message.toolCallId ?? message.tool_call_id;
    if (typeof toolUseId !== "string" || toolUseId.length === 0) throw providerError("provider_request_invalid");
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId.slice(0, 256), content: textContent(message.content) }],
    };
  }
  throw providerError("provider_request_invalid");
}

function textBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content) || content.length === 0) throw providerError("provider_request_invalid");
  return content.map((item) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      return { type: "text", text: item.text };
    }
    if (item?.type === "image") {
      const image = validImagePart(item);
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: image.mediaType,
          data: image.dataBase64,
        },
      };
    }
    throw providerError("provider_request_invalid");
  });
}

function validImagePart(item) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(item?.mediaType) ||
    typeof item?.dataBase64 !== "string" ||
    item.dataBase64.length < 1 ||
    item.dataBase64.length > 22_369_624 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)
  ) {
    throw providerError("provider_request_invalid");
  }
  return item;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
}

function normalizeProviderResponse(payload, allowedTools, { structuredOutput }) {
  if (!isPlainObject(payload) || !Array.isArray(payload.content)) throw providerError("provider_response_invalid");
  if (payload.stop_reason === "refusal") throw providerError("provider_content_rejected");
  const content = [];
  const toolCalls = [];
  for (const item of payload.content) {
    if (item?.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
      continue;
    }
    if (item?.type === "thinking" && typeof item.thinking === "string") {
      content.push({ type: "thinking", thinking: item.thinking });
      continue;
    }
    if (item?.type === "redacted_thinking") continue;
    if (item?.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string"
      && allowedTools.has(item.name) && isPlainObject(item.input)) {
      const normalized = {
        type: "toolCall",
        id: item.id.slice(0, 256),
        name: item.name,
        arguments: structuredClone(item.input),
      };
      content.push(normalized);
      toolCalls.push({ id: normalized.id, name: normalized.name, arguments: structuredClone(normalized.arguments) });
      continue;
    }
    throw providerError("provider_response_invalid");
  }
  if (content.length === 0) throw providerError("provider_response_invalid");
  return {
    content,
    toolCalls,
    ...(structuredOutput && toolCalls.length === 0 ? { structuredOutput: parseStructuredOutput(content) } : {}),
    stopReason: payload.stop_reason === "max_tokens" ? "length" : toolCalls.length > 0 ? "tool" : "stop",
    usage: {
      input: nonnegativeInteger(payload.usage?.input_tokens),
      output: nonnegativeInteger(payload.usage?.output_tokens),
      cacheRead: nonnegativeInteger(payload.usage?.cache_read_input_tokens),
      cacheWrite: nonnegativeInteger(payload.usage?.cache_creation_input_tokens),
    },
  };
}

function parseStructuredOutput(content) {
  const source = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  try { return JSON.parse(source); } catch { throw providerError("provider_response_invalid"); }
}

async function withProviderDeadline({ signal, timeoutMs }, operation) {
  if (signal?.aborted) throw providerError("cancelled");
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  const timeoutSignal = timeoutController.signal;
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await operation(requestSignal);
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    if (signal?.aborted) throw providerError("cancelled");
    if (timeoutSignal.aborted) throw providerError("provider_timeout");
    throw providerError("provider_request_failed");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readBoundedText(response, maxBytes) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw providerError("provider_response_too_large");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw providerError("provider_response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw providerError("provider_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseProviderPayload(source) {
  try { return JSON.parse(source); } catch { throw providerError("provider_response_invalid"); }
}

async function providerHttpError(response, maxResponseBytes) {
  let payload = null;
  try {
    const source = await readBoundedText(response, maxResponseBytes);
    payload = source ? JSON.parse(source) : null;
  } catch (error) {
    if (error instanceof ModelProviderError) return error;
  }
  const statusCode = Number(response?.status);
  const fingerprint = providerErrorFingerprint(payload);
  if ([401, 403].includes(statusCode)) return providerError("provider_auth_failed");
  if (statusCode === 429) return providerError("provider_rate_limited");
  if ([408, 504].includes(statusCode)) return providerError("provider_timeout");
  if (/(content|safety|moderation|policy[_ -]?violation|blocked)/i.test(fingerprint)) {
    return providerError("provider_content_rejected");
  }
  if (statusCode >= 400 && statusCode < 500) return providerError("provider_request_invalid");
  return providerError("provider_request_failed");
}

function providerErrorFingerprint(payload) {
  if (!isPlainObject(payload)) return "";
  const error = isPlainObject(payload.error) ? payload.error : payload;
  return [error.type, error.code, error.status, error.reason].filter((value) => typeof value === "string").join(" ");
}

function providerError(code) { return new ModelProviderError(code); }
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
