import net from "node:net";

import {
  createFauxCore,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";

const PROVIDER = "looloomi-gateway";
const MODEL_ID = "product-controlled-model";
const EMPTY_USAGE = Object.freeze({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export default function productGatewayExtension(pi) {
  const client = new SupervisorClient(process.env.LOOLOOMI_AGENT_SUPERVISOR_SOCKET);
  const toolMap = parseToolMap(process.env.LOOLOOMI_PRODUCT_TOOL_MAP);
  const childRef = workflowChildRef(process.argv);
  const maxModelRequests = boundedInteger(process.env.LOOLOOMI_GATEWAY_MAX_MODEL_REQUESTS, 1, 1024, 16);
  const maxToolResultChars = boundedInteger(
    process.env.LOOLOOMI_PRODUCT_TOOL_RESULT_MAX_CHARS,
    1_024,
    4_000_000,
    320_000,
  );
  const faux = createFauxCore({
    api: PROVIDER,
    provider: PROVIDER,
    models: [{ id: MODEL_ID, name: "Product controlled model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 16_384 }],
    tokensPerSecond: 0,
  });
  faux.setResponses(Array.from({ length: maxModelRequests }, () => async (context, options) => {
    const result = await client.call({
      operation: "model",
      ...(childRef ? { childRef } : {}),
      input: {
        model: { provider: PROVIDER, id: MODEL_ID },
        context: gatewayContext(context),
        options: {
          ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
          ...(Number.isSafeInteger(options?.maxTokens) ? { maxTokens: options.maxTokens } : {}),
        },
      },
    });
    return normalizeModelResult(result, toolMap);
  }));
  pi.registerProvider(PROVIDER, {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "stdio-gateway-transport",
    api: PROVIDER,
    streamSimple: faux.streamSimple,
    models: [{
      id: MODEL_ID,
      name: "Product controlled model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  });
  for (const [alias, toolId] of Object.entries(toolMap)) {
    pi.registerTool({
      name: alias,
      label: toolId,
      description: `Execute governed product tool ${toolId}.`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (_toolCallId, params) => {
        const result = boundedToolResult(await client.call({
          operation: "tool",
          ...(childRef ? { childRef } : {}),
          toolAlias: alias,
          input: structuredClone(params),
        }), maxToolResultChars);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { status: "completed" } };
      },
    });
  }
  pi.on("agent_end", () => client.close());
}

class SupervisorClient {
  constructor(socketPath) {
    if (typeof socketPath !== "string" || socketPath.length === 0) throw new Error("agent_supervisor_socket_missing");
    this.socket = net.createConnection(socketPath);
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = "";
    this.ready = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("data", (chunk) => this.accept(chunk));
    this.socket.once("close", () => this.fail(new Error("agent_supervisor_closed")));
  }

  async call(message) {
    await this.ready;
    const id = `extension-rpc-${++this.sequence}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.write(`${JSON.stringify({ id, ...message })}\n`);
    return result;
  }

  accept(chunk) {
    this.buffer += chunk.toString("utf8");
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const source = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let frame;
      try { frame = JSON.parse(source); } catch { return this.fail(new Error("agent_supervisor_protocol_invalid")); }
      const pending = this.pending.get(frame.id);
      if (!pending) return this.fail(new Error("agent_supervisor_response_unknown"));
      this.pending.delete(frame.id);
      if (frame.ok) pending.resolve(frame.result);
      else {
        const error = new Error(String(frame.error?.message || "Gateway request failed."));
        error.code = String(frame.error?.code || "gateway_request_invalid");
        error.status = String(frame.error?.status || "failed");
        error.productSafe = true;
        pending.reject(error);
      }
    }
  }

  close() { this.socket.end(); }

  fail(error) {
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
    this.socket.destroy();
  }
}

function normalizeModelResult(result, toolMap) {
  const source = typeof result === "string"
    ? { content: [{ type: "text", text: result }], stopReason: "stop" }
    : typeof result?.text === "string"
      ? { content: [{ type: "text", text: result.text }], stopReason: "stop" }
      : result;
  if (!isPlainObject(source) || !Array.isArray(source.content)) throw new Error("agent_gateway_model_result_invalid");
  const content = source.content.map((item) => normalizeContent(item, toolMap));
  const message = fauxAssistantMessage(content, { stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : source.stopReason === "length" ? "length" : "stop" });
  message.usage = normalizeUsage(source.usage);
  return message;
}

function normalizeContent(item, toolMap) {
  if (item?.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
  if (item?.type === "thinking" && typeof item.thinking === "string") return { type: "thinking", thinking: item.thinking };
  if (item?.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string" && isPlainObject(item.arguments)) {
    const alias = Object.hasOwn(toolMap, item.name)
      ? item.name
      : Object.entries(toolMap).find(([, toolId]) => toolId === item.name)?.[0];
    if (alias) return { type: "toolCall", id: item.id, name: alias, arguments: structuredClone(item.arguments) };
  }
  throw new Error("agent_gateway_model_content_invalid");
}

function gatewayContext(context) {
  return {
    ...(typeof context?.systemPrompt === "string" ? { systemPrompt: context.systemPrompt } : {}),
    messages: structuredClone(context?.messages ?? []),
    tools: (context?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) })),
  };
}

function normalizeUsage(value) {
  if (!isPlainObject(value)) return structuredClone(EMPTY_USAGE);
  const input = nonnegative(value.input);
  const output = nonnegative(value.output);
  const cacheRead = nonnegative(value.cacheRead);
  const cacheWrite = nonnegative(value.cacheWrite);
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: structuredClone(EMPTY_USAGE.cost) };
}

function parseToolMap(source) {
  try {
    const value = JSON.parse(source || "{}");
    if (!isPlainObject(value) || Object.entries(value).some(([alias, toolId]) => !/^product_tool_\d+$/.test(alias) || typeof toolId !== "string")) throw new Error();
    return value;
  } catch {
    throw new Error("product_tool_map_invalid");
  }
}

export function workflowChildRef(argv) {
  const index = argv.indexOf("--session-id");
  const sessionId = index >= 0 ? argv[index + 1] : undefined;
  return typeof sessionId === "string"
    && (sessionId.startsWith("pi-workflow.") || sessionId.startsWith("piwf."))
    && sessionId.length <= 128
    ? sessionId
    : undefined;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function boundedToolResult(value, maximum) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= maximum) return value;
  return {
    truncated: true,
    originalChars: text.length,
    preview: text.slice(0, Math.max(0, maximum - 256)),
  };
}

function nonnegative(value) { return Number.isFinite(value) && value >= 0 ? value : 0; }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
