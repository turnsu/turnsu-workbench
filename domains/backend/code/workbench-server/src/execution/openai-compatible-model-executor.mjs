const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ModelProviderError extends Error {
  constructor(code, { status = "blocked" } = {}) {
    super("The configured model provider is unavailable.");
    this.name = "ModelProviderError";
    this.code = code;
    this.status = status;
    this.productSafe = true;
  }
}

export function createConfiguredOpenAICompatibleModelExecutor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.WORKBENCH_MODEL_BASE_URL || "").trim();
  const apiKey = String(env.WORKBENCH_MODEL_API_KEY || "").trim();
  const model = String(env.WORKBENCH_MODEL || "").trim();
  if (!baseUrl && !apiKey && !model) return null;
  if (!baseUrl || !apiKey || !model) throw new TypeError("workbench_model_configuration_incomplete");
  return createOpenAICompatibleModelExecutor({
    baseUrl,
    apiKey,
    model,
    fetchImpl,
    timeoutMs: boundedInteger(env.WORKBENCH_MODEL_TIMEOUT_MS, 1_000, 300_000, DEFAULT_TIMEOUT_MS),
  });
}

export function createOpenAICompatibleModelExecutor({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const provider = validateProviderConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes });
  const execute = async ({ input, signal } = {}) => {
    const request = providerRequest(input, provider.model);
    const response = await providerFetch(provider, "chat/completions", {
      method: "POST",
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw providerHttpError(response.status);
    const payload = parseProviderPayload(await readBoundedText(response, provider.maxResponseBytes));
    return normalizeProviderResponse(payload, new Set(input?.context?.tools?.map((tool) => tool.name) ?? []));
  };
  execute.probe = async () => {
    try {
      const response = await providerFetch(provider, "models", { method: "GET" });
      return { available: response.ok === true };
    } catch {
      return { available: false };
    }
  };
  return Object.freeze(execute);
}

function validateProviderConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes }) {
  if (typeof fetchImpl !== "function" || typeof apiKey !== "string" || apiKey.length < 1 || apiKey.length > 4096
    || typeof model !== "string" || model.length < 1 || model.length > 256
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 16 * 1024 * 1024) {
    throw new TypeError("model_provider_configuration_invalid");
  }
  let url;
  try { url = new URL(baseUrl); } catch { throw new TypeError("model_provider_base_url_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new TypeError("model_provider_base_url_invalid");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return { baseUrl: url, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes };
}

async function providerFetch(provider, path, options) {
  const timeout = AbortSignal.timeout(provider.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    return await provider.fetchImpl(new URL(path, provider.baseUrl), {
      ...options,
      signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ModelProviderError("provider_request_failed");
  }
}

function providerRequest(input, model) {
  if (!isPlainObject(input) || !isPlainObject(input.context) || !Array.isArray(input.context.messages)
    || !Array.isArray(input.context.tools ?? [])) {
    throw new ModelProviderError("provider_request_invalid", { status: "failed" });
  }
  const messages = [];
  if (typeof input.context.systemPrompt === "string" && input.context.systemPrompt.length > 0) {
    messages.push({ role: "system", content: input.context.systemPrompt });
  }
  for (const message of input.context.messages) messages.push(normalizeInputMessage(message));
  const tools = input.context.tools.map((tool) => {
    if (!isPlainObject(tool) || typeof tool.name !== "string" || !isPlainObject(tool.parameters)) {
      throw new ModelProviderError("provider_request_invalid", { status: "failed" });
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description.slice(0, 4000) : "",
        parameters: structuredClone(tool.parameters),
      },
    };
  });
  return {
    model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(Number.isSafeInteger(input.options?.maxTokens)
      ? { max_tokens: Math.min(32_768, Math.max(1, input.options.maxTokens)) }
      : {}),
    stream: false,
  };
}

function normalizeInputMessage(message) {
  if (!isPlainObject(message) || typeof message.role !== "string") {
    throw new ModelProviderError("provider_request_invalid", { status: "failed" });
  }
  if (["user", "system"].includes(message.role)) {
    return { role: message.role, content: textContent(message.content) };
  }
  if (message.role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolCalls = blocks.filter((item) => item?.type === "toolCall").map((item) => ({
      id: String(item.id || "").slice(0, 256),
      type: "function",
      function: { name: String(item.name || "").slice(0, 256), arguments: JSON.stringify(item.arguments ?? {}) },
    }));
    return {
      role: "assistant",
      content: textContent(blocks.filter((item) => item?.type !== "toolCall")),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (["tool", "toolResult"].includes(message.role)) {
    const toolCallId = message.toolCallId ?? message.tool_call_id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      throw new ModelProviderError("provider_request_invalid", { status: "failed" });
    }
    return { role: "tool", tool_call_id: toolCallId, content: textContent(message.content) };
  }
  throw new ModelProviderError("provider_request_invalid", { status: "failed" });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
}

function normalizeProviderResponse(payload, allowedTools) {
  const message = payload?.choices?.[0]?.message;
  if (!isPlainObject(message)) throw new ModelProviderError("provider_response_invalid", { status: "failed" });
  const content = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    const name = call?.function?.name;
    if (call?.type !== "function" || typeof call.id !== "string" || !allowedTools.has(name)) {
      throw new ModelProviderError("provider_tool_call_invalid", { status: "failed" });
    }
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch {
      throw new ModelProviderError("provider_tool_call_invalid", { status: "failed" });
    }
    if (!isPlainObject(args)) throw new ModelProviderError("provider_tool_call_invalid", { status: "failed" });
    content.push({ type: "toolCall", id: call.id.slice(0, 256), name, arguments: args });
  }
  if (content.length === 0) throw new ModelProviderError("provider_response_empty", { status: "failed" });
  return {
    content,
    stopReason: payload.choices[0].finish_reason === "length" ? "length" : "stop",
    usage: {
      input: nonnegativeInteger(payload.usage?.prompt_tokens),
      output: nonnegativeInteger(payload.usage?.completion_tokens),
      cacheRead: nonnegativeInteger(payload.usage?.prompt_tokens_details?.cached_tokens),
      cacheWrite: 0,
    },
  };
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ModelProviderError("provider_response_too_large", { status: "failed" });
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new ModelProviderError("provider_response_too_large", { status: "failed" });
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
      throw new ModelProviderError("provider_response_too_large", { status: "failed" });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseProviderPayload(source) {
  try { return JSON.parse(source); } catch {
    throw new ModelProviderError("provider_response_invalid", { status: "failed" });
  }
}

function providerHttpError(statusCode) {
  return new ModelProviderError(
    [401, 403].includes(statusCode) ? "provider_authentication_failed" : "provider_http_error",
  );
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
