const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CHAT_CAPABILITIES = Object.freeze(["chat", "tool_calling", "structured_output", "image_input"]);

const ERROR_DEFAULTS = Object.freeze({
  provider_auth_failed: { status: "blocked", retryable: false },
  provider_payment_required: { status: "blocked", retryable: false },
  provider_rate_limited: { status: "failed", retryable: true },
  provider_content_rejected: { status: "failed", retryable: false },
  provider_timeout: { status: "timeout", retryable: true },
  cancelled: { status: "cancelled", retryable: false },
  provider_request_invalid: { status: "failed", retryable: false },
  provider_request_failed: { status: "failed", retryable: true },
  provider_response_invalid: { status: "failed", retryable: true },
  provider_response_too_large: { status: "failed", retryable: false },
  model_cost_budget_exceeded: { status: "blocked", retryable: false },
});

export class ModelProviderError extends Error {
  constructor(code, options = {}) {
    const defaults = ERROR_DEFAULTS[code] ?? { status: "failed", retryable: false };
    super("The model provider request could not be completed.");
    this.name = "ModelProviderError";
    this.code = code;
    this.status = options.status ?? defaults.status;
    this.retryable = options.retryable ?? defaults.retryable;
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
    if (signal?.aborted) throw providerError("cancelled");
    const normalized = normalizeInput(input);
    const request = providerRequest(normalized, provider.model);
    return withProviderDeadline({ signal, timeoutMs: provider.timeoutMs }, async (requestSignal) => {
      const response = await provider.fetchImpl(new URL("chat/completions", provider.baseUrl), {
        method: "POST",
        body: JSON.stringify(request),
        signal: requestSignal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${provider.apiKey}`,
          "content-type": "application/json",
        },
      });
      if (!response?.ok) throw await providerHttpError(response, provider.maxResponseBytes);
      const payload = parseProviderPayload(await readBoundedText(response, provider.maxResponseBytes));
      return normalizeProviderResponse(payload, new Set(normalized.tools.map((tool) => tool.name)), {
        structuredOutput: normalized.responseSchema !== null,
      });
    });
  };
  execute.probe = async () => {
    try {
      const response = await withProviderDeadline({ timeoutMs: provider.timeoutMs }, (signal) => provider.fetchImpl(
        new URL("models", provider.baseUrl),
        {
          method: "GET",
          signal,
          headers: { accept: "application/json", authorization: `Bearer ${provider.apiKey}` },
        },
      ));
      return { available: response?.ok === true };
    } catch {
      return { available: false };
    }
  };
  declareDriver(execute, "openai_compatible_chat", "response_format.json_schema");
  return Object.freeze(execute);
}

function validateProviderConfiguration({ baseUrl, apiKey, model, fetchImpl, timeoutMs, maxResponseBytes }) {
  if (typeof fetchImpl !== "function" || typeof apiKey !== "string" || apiKey.length < 1 || apiKey.length > 4096
    || typeof model !== "string" || model.length < 1 || model.length > 256
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
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
  const messages = [];
  if (typeof input.systemPrompt === "string" && input.systemPrompt.length > 0) {
    messages.push({ role: "system", content: input.systemPrompt });
  }
  for (const message of input.messages) messages.push(normalizeInputMessage(message));
  const tools = input.tools.map(normalizeTool);
  return {
    model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...(input.responseSchema === null ? {} : {
      response_format: {
        type: "json_schema",
        json_schema: { name: "structured_response", strict: true, schema: input.responseSchema },
      },
    }),
    ...(Number.isSafeInteger(input.options.maxTokens)
      ? { max_tokens: Math.min(32_768, Math.max(1, input.options.maxTokens)) }
      : {}),
    stream: false,
  };
}

function normalizeTool(tool) {
  const parameters = tool?.inputSchema ?? tool?.parameters;
  if (!isPlainObject(tool) || typeof tool.name !== "string" || tool.name.length < 1 || !isPlainObject(parameters)) {
    throw providerError("provider_request_invalid");
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description.slice(0, 4000) : "",
      parameters: structuredClone(parameters),
      ...(tool.strict === true ? { strict: true } : {}),
    },
  };
}

function normalizeInputMessage(message) {
  if (!isPlainObject(message) || typeof message.role !== "string") throw providerError("provider_request_invalid");
  if (message.role === "system") {
    return { role: "system", content: textContent(message.content) };
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: normalizeUserContent(message.content),
    };
  }
  if (message.role === "assistant") {
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    const toolCalls = blocks.filter((item) => item?.type === "toolCall").map((item) => {
      if (typeof item.id !== "string" || typeof item.name !== "string" || !isPlainObject(item.arguments)) {
        throw providerError("provider_request_invalid");
      }
      return {
        id: item.id.slice(0, 256),
        type: "function",
        function: { name: item.name.slice(0, 256), arguments: JSON.stringify(item.arguments) },
      };
    });
    return {
      role: "assistant",
      content: textContent(blocks.filter((item) => item?.type !== "toolCall")),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (["tool", "toolResult"].includes(message.role)) {
    const toolCallId = message.toolCallId ?? message.tool_call_id;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) throw providerError("provider_request_invalid");
    return { role: "tool", tool_call_id: toolCallId.slice(0, 256), content: textContent(message.content) };
  }
  throw providerError("provider_request_invalid");
}

function normalizeUserContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.length === 0) {
    throw providerError("provider_request_invalid");
  }
  return content.map((item) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      return { type: "text", text: item.text };
    }
    if (item?.type === "image") {
      const image = validImagePart(item);
      return {
        type: "image_url",
        image_url: {
          url: `data:${image.mediaType};base64,${image.dataBase64}`,
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
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!isPlainObject(message)) throw providerError("provider_response_invalid");
  if (choice.finish_reason === "content_filter" || typeof message.refusal === "string") {
    throw providerError("provider_content_rejected");
  }
  const content = [];
  const toolCalls = [];
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  if (!Array.isArray(message.tool_calls ?? [])) throw providerError("provider_response_invalid");
  for (const call of message.tool_calls ?? []) {
    const name = call?.function?.name;
    if (call?.type !== "function" || typeof call.id !== "string" || !allowedTools.has(name)) {
      throw providerError("provider_response_invalid");
    }
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { throw providerError("provider_response_invalid"); }
    if (!isPlainObject(args)) throw providerError("provider_response_invalid");
    const normalized = { type: "toolCall", id: call.id.slice(0, 256), name, arguments: args };
    content.push(normalized);
    toolCalls.push({ id: normalized.id, name, arguments: structuredClone(args) });
  }
  if (content.length === 0) throw providerError("provider_response_invalid");
  return {
    content,
    toolCalls,
    ...(structuredOutput && toolCalls.length === 0 ? { structuredOutput: parseStructuredOutput(content) } : {}),
    stopReason: choice.finish_reason === "length" ? "length" : toolCalls.length > 0 ? "tool" : "stop",
    usage: {
      input: nonnegativeInteger(payload.usage?.prompt_tokens),
      output: nonnegativeInteger(payload.usage?.completion_tokens),
      cacheRead: nonnegativeInteger(payload.usage?.prompt_tokens_details?.cached_tokens),
      cacheWrite: 0,
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
  if (statusCode === 402) return providerError("provider_payment_required");
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

function declareDriver(execute, protocol, wireField) {
  execute.protocol = protocol;
  execute.capabilities = CHAT_CAPABILITIES;
  execute.structuredOutput = Object.freeze({ supported: true, mode: "json_schema", wireField });
}

function providerError(code) { return new ModelProviderError(code); }
function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
