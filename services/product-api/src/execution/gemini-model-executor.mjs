import { ModelProviderError } from "./openai-compatible-model-executor.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CHAT_CAPABILITIES = Object.freeze(["chat", "tool_calling", "structured_output", "image_input"]);
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY",
]);

export function createGeminiModelExecutor({
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const provider = validateConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes });
  const modelPath = encodeURIComponent(provider.model.replace(/^models\//, ""));
  const execute = async ({ input, signal } = {}) => {
    if (signal?.aborted) throw providerError("cancelled");
    const normalized = normalizeInput(input);
    const allowedTools = new Set(normalized.tools.map((tool) => tool.name));
    const request = providerRequest(normalized);
    return withProviderDeadline({ signal, timeoutMs: provider.timeoutMs }, async (requestSignal) => {
      const response = await provider.fetchImpl(
        new URL(`models/${modelPath}:generateContent`, provider.baseUrl),
        {
          method: "POST",
          body: JSON.stringify(request),
          signal: requestSignal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-goog-api-key": provider.apiKey,
          },
        },
      );
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
        new URL(`models/${modelPath}`, provider.baseUrl),
        {
          method: "GET",
          signal,
          headers: { accept: "application/json", "x-goog-api-key": provider.apiKey },
        },
      ));
      return { available: response?.ok === true };
    } catch {
      return { available: false };
    }
  };
  execute.protocol = "gemini_generate_content";
  execute.capabilities = CHAT_CAPABILITIES;
  execute.structuredOutput = Object.freeze({
    supported: true,
    mode: "json_schema",
    wireField: "generationConfig.responseJsonSchema",
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

function providerRequest(input) {
  const system = [];
  if (typeof input.systemPrompt === "string" && input.systemPrompt.length > 0) system.push(input.systemPrompt);
  const toolNames = new Map();
  const contents = [];
  for (const message of input.messages) {
    if (message?.role === "system") {
      const text = textContent(message.content);
      if (text) system.push(text);
      continue;
    }
    contents.push(normalizeMessage(message, toolNames));
  }
  const functionDeclarations = input.tools.map(normalizeTool);
  return {
    contents,
    ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
    ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
    generationConfig: {
      ...(Number.isSafeInteger(input.options.maxTokens)
        ? { maxOutputTokens: Math.min(32_768, Math.max(1, input.options.maxTokens)) }
        : {}),
      ...(input.responseSchema === null ? {} : {
        responseMimeType: "application/json",
        responseJsonSchema: input.responseSchema,
      }),
    },
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
    parameters: structuredClone(parameters),
  };
}

function normalizeMessage(message, toolNames) {
  if (!isPlainObject(message) || typeof message.role !== "string") throw providerError("provider_request_invalid");
  if (message.role === "user") return { role: "user", parts: textParts(message.content) };
  if (message.role === "assistant") {
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    return {
      role: "model",
      parts: blocks.map((item) => {
        if (item?.type === "text" && typeof item.text === "string") return { text: item.text };
        if (item?.type === "thinking" && typeof item.thinking === "string") return { text: item.thinking, thought: true };
        if (item?.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string"
          && isPlainObject(item.arguments)) {
          toolNames.set(item.id, item.name);
          return {
            functionCall: { id: item.id.slice(0, 256), name: item.name, args: structuredClone(item.arguments) },
            ...(validThoughtSignature(item.thoughtSignature)
              ? { thoughtSignature: item.thoughtSignature }
              : {}),
          };
        }
        throw providerError("provider_request_invalid");
      }),
    };
  }
  if (["tool", "toolResult"].includes(message.role)) {
    const toolCallId = message.toolCallId ?? message.tool_call_id;
    const name = toolNames.get(toolCallId) ?? message.name;
    if (typeof name !== "string" || name.length === 0) throw providerError("provider_request_invalid");
    return {
      role: "user",
      parts: [{ functionResponse: { id: toolCallId, name, response: { result: textContent(message.content) } } }],
    };
  }
  throw providerError("provider_request_invalid");
}

function textParts(content) {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content) || content.length === 0) throw providerError("provider_request_invalid");
  return content.map((item) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      return { text: item.text };
    }
    if (item?.type === "image") {
      const image = validImagePart(item);
      return {
        inlineData: {
          mimeType: image.mediaType,
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
  if (typeof payload?.promptFeedback?.blockReason === "string") throw providerError("provider_content_rejected");
  const candidate = payload?.candidates?.[0];
  if (!isPlainObject(candidate)) throw providerError("provider_response_invalid");
  if (BLOCKED_FINISH_REASONS.has(candidate.finishReason)) throw providerError("provider_content_rejected");
  if (!Array.isArray(candidate.content?.parts)) throw providerError("provider_response_invalid");
  let toolIndex = 0;
  const content = [];
  const toolCalls = [];
  for (const part of candidate.content.parts) {
    if (typeof part?.text === "string") {
      content.push(part.thought === true
        ? { type: "thinking", thinking: part.text }
        : { type: "text", text: part.text });
      continue;
    }
    const call = part?.functionCall;
    if (isPlainObject(call) && typeof call.name === "string" && allowedTools.has(call.name)
      && isPlainObject(call.args ?? {})) {
      toolIndex += 1;
      const normalized = {
        type: "toolCall",
        id: typeof call.id === "string" ? call.id.slice(0, 256) : `gemini-tool-${toolIndex}`,
        name: call.name,
        arguments: structuredClone(call.args ?? {}),
        ...(validThoughtSignature(part.thoughtSignature)
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      };
      content.push(normalized);
      toolCalls.push({
        id: normalized.id,
        name: normalized.name,
        arguments: structuredClone(normalized.arguments),
        ...(normalized.thoughtSignature
          ? { thoughtSignature: normalized.thoughtSignature }
          : {}),
      });
      continue;
    }
    throw providerError("provider_response_invalid");
  }
  if (content.length === 0) throw providerError("provider_response_invalid");
  return {
    content,
    toolCalls,
    ...(structuredOutput && toolCalls.length === 0 ? { structuredOutput: parseStructuredOutput(content) } : {}),
    stopReason: candidate.finishReason === "MAX_TOKENS" ? "length" : toolCalls.length > 0 ? "tool" : "stop",
    usage: {
      input: nonnegativeInteger(payload.usageMetadata?.promptTokenCount),
      output: nonnegativeInteger(payload.usageMetadata?.candidatesTokenCount),
      cacheRead: nonnegativeInteger(payload.usageMetadata?.cachedContentTokenCount),
      cacheWrite: 0,
    },
  };
}

function parseStructuredOutput(content) {
  const source = content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  try { return JSON.parse(source); } catch { throw providerError("provider_response_invalid"); }
}

function validThoughtSignature(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 65_536;
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
