import { ProductStoreError } from "../store/errors.mjs";
import { getLarkToolPolicy } from "./lark-tool-policy.mjs";

const MAX_UNTRUSTED_DEPTH = 10;
const MAX_UNTRUSTED_NODES = 5_000;
const MAX_OBJECT_KEYS = 128;
const MAX_RAW_ARRAY_ITEMS = 2_000;
const MAX_RAW_STRING_LENGTH = 96 * 1024;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const string = (maxLength, options = {}) => Object.freeze({
  type: "string",
  maxLength,
  ...(options.values ? { values: Object.freeze([...options.values]) } : {}),
  ...(options.pattern ? { pattern: options.pattern } : {}),
});
const boolean = Object.freeze({ type: "boolean" });
const integer = Object.freeze({ type: "integer" });
const nullable = (schema) => Object.freeze({ type: "nullable", schema });
const array = (items, maxItems) => Object.freeze({ type: "array", items, maxItems });
const object = (properties, {
  required = [],
  requiredAny = [],
} = {}) => Object.freeze({
  type: "object",
  properties: Object.freeze(properties),
  required: Object.freeze([...required]),
  requiredAny: Object.freeze(requiredAny.map((keys) => Object.freeze([...keys]))),
});

const identifier = string(512, { pattern: EXTERNAL_ID });
const shortText = string(4_000);
const timestamp = string(128);
const pageToken = nullable(string(1_000));
const link = string(4_000);

const timeValue = object({
  date: string(32),
  datetime: timestamp,
  timestamp: string(32),
  timezone: string(128),
});

const calendarEvent = object({
  event_id: identifier,
  organizer_calendar_id: identifier,
  summary: string(1_000),
  description: string(20_000),
  start_time: timeValue,
  end_time: timeValue,
  free_busy_status: string(64),
  self_rsvp_status: string(64),
  visibility: string(64),
  recurrence: string(2_000),
  recurring_event_id: identifier,
  app_link: link,
  meeting_url: link,
}, { required: ["event_id", "start_time", "end_time"] });

const taskItem = object({
  guid: identifier,
  summary: string(1_000),
  url: link,
  created_at: timestamp,
  due_at: timestamp,
}, { required: ["guid", "summary"] });

const sender = object({
  id: identifier,
  open_id: identifier,
  id_type: string(64),
  sender_type: string(64),
  tenant_key: identifier,
  name: string(1_000),
});

const mention = object({
  key: string(256),
  id: identifier,
  open_id: identifier,
  id_type: string(64),
  name: string(1_000),
  tenant_key: identifier,
});

const reaction = object({
  emoji_type: string(128),
  count: integer,
});

const messageItem = object({
  message_id: identifier,
  root_id: identifier,
  parent_id: identifier,
  thread_id: identifier,
  chat_id: identifier,
  chat_type: string(64),
  chat_name: string(1_000),
  msg_type: string(64),
  content: string(20_000),
  create_time: timestamp,
  update_time: timestamp,
  sender,
  mentions: array(mention, 100),
  reactions: array(reaction, 100),
  chat_partner: object({ open_id: identifier, name: string(1_000) }),
}, { required: ["message_id", "msg_type"] });

const minuteItem = object({
  token: identifier,
  display_info: string(2_000),
  meta_data: object({
    title: string(2_000),
    description: string(10_000),
    app_link: link,
    create_time: timestamp,
    duration: integer,
    owner_id: identifier,
  }),
}, { required: ["token"] });

const ACTION_OUTPUT_SCHEMAS = Object.freeze({
  "lark.calendar.agenda": array(calendarEvent, 500),
  "lark.calendar.create": object({
    event_id: identifier,
    eventId: identifier,
    summary: string(1_000),
    start: timestamp,
    end: timestamp,
  }, { requiredAny: [["event_id", "eventId"]] }),
  "lark.task.list_mine": object({
    items: array(taskItem, 2_000),
    page_token: pageToken,
    has_more: boolean,
  }, { required: ["items", "has_more"] }),
  "lark.task.create": object({
    guid: identifier,
    task_id: identifier,
    taskId: identifier,
    url: link,
  }, { requiredAny: [["guid", "task_id", "taskId"]] }),
  "lark.im.search_messages": object({
    messages: array(messageItem, 500),
    message_ids: array(identifier, 500),
    total: integer,
    has_more: boolean,
    page_token: pageToken,
    note: shortText,
    notice: shortText,
  }, {
    required: ["total", "has_more"],
    requiredAny: [["messages", "message_ids"]],
  }),
  "lark.im.send_message": object({
    message_id: identifier,
    messageId: identifier,
    chat_id: identifier,
    create_time: timestamp,
  }, { requiredAny: [["message_id", "messageId"]] }),
  "lark.docs.fetch": object({
    document: object({
      document_id: identifier,
      revision_id: integer,
      title: string(2_000),
      content: string(80_000),
    }, { required: ["content"] }),
    warning: shortText,
    warnings: array(shortText, 20),
  }, { required: ["document"] }),
  "lark.minutes.search": object({
    items: array(minuteItem, 100),
    has_more: boolean,
    page_token: pageToken,
    notice: shortText,
  }, { required: ["items", "has_more"] }),
});

const FORBIDDEN_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "oauth_token",
  "auth_token",
  "user_access_token",
  "tenant_access_token",
  "authorization",
  "password",
  "passphrase",
  "secret",
  "client_secret",
  "app_secret",
  "api_key",
  "private_key",
  "credential",
  "credentials",
  "cookie",
  "set_cookie",
  "headers",
  "request_headers",
  "response_headers",
  "provider_payload",
  "provider_response",
  "raw_payload",
  "raw_response",
]);

const FORBIDDEN_TEXT = [
  /-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----/i,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:access[_ -]?token|refresh[_ -]?token|password|passphrase|client[_ -]?secret|app[_ -]?secret|api[_ -]?key|authorization)\s*[:=]\s*\S{4,}/i,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

const HOST_PATH = [
  /(?:^|[\s"'(=])(?:file:\/\/)?\/(?:Users|home|private|var|tmp|etc|opt|root|Volumes|workspace|workspaces|mnt)(?:\/|$)/i,
  /(?:^|[\s"'(=])[A-Za-z]:\\(?:Users|Windows|Program Files|ProgramData|Temp)(?:\\|$)/i,
  /(?:^|[\s"'(=])\\\\[^\s\\]+\\[^\s\\]+/,
];

function outputError(code, message) {
  return new ProductStoreError(code, message);
}

function normalizedKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function sensitiveKey(value) {
  const key = normalizedKey(value);
  return FORBIDDEN_KEYS.has(key)
    || key.endsWith("_password")
    || key.endsWith("_passphrase")
    || key.endsWith("_credential")
    || key.endsWith("_credentials")
    || key.endsWith("_private_key")
    || key.endsWith("_api_key")
    || key.endsWith("_secret");
}

function inspectText(value) {
  if (value.length > MAX_RAW_STRING_LENGTH) {
    throw outputError(
      "lark_tool_output_limit_exceeded",
      "The Lark Tool output exceeded the product text limit.",
    );
  }
  if (FORBIDDEN_TEXT.some((pattern) => pattern.test(value))) {
    throw outputError(
      "lark_tool_output_forbidden",
      "The Lark Tool output contained credential material and was rejected.",
    );
  }
  if (HOST_PATH.some((pattern) => pattern.test(value))) {
    throw outputError(
      "lark_tool_output_forbidden",
      "The Lark Tool output contained a host path and was rejected.",
    );
  }
}

function inspectUntrusted(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_UNTRUSTED_NODES || depth > MAX_UNTRUSTED_DEPTH) {
    throw outputError(
      "lark_tool_output_limit_exceeded",
      "The Lark Tool output exceeded the product structure limit.",
    );
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output was not valid JSON data.");
    }
    return;
  }
  if (typeof value === "string") {
    inspectText(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RAW_ARRAY_ITEMS) {
      throw outputError(
        "lark_tool_output_limit_exceeded",
        "The Lark Tool output exceeded the product item limit.",
      );
    }
    if (state.seen.has(value)) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output contained a cyclic value.");
    }
    state.seen.add(value);
    for (const entry of value) inspectUntrusted(entry, state, depth + 1);
    state.seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) {
    throw outputError("lark_tool_output_invalid", "The Lark Tool output contained an unsupported value.");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) {
    throw outputError(
      "lark_tool_output_limit_exceeded",
      "The Lark Tool output exceeded the product field limit.",
    );
  }
  if (state.seen.has(value)) {
    throw outputError("lark_tool_output_invalid", "The Lark Tool output contained a cyclic value.");
  }
  state.seen.add(value);
  for (const [key, entry] of entries) {
    if (sensitiveKey(key)) {
      throw outputError(
        "lark_tool_output_forbidden",
        "The Lark Tool output contained a forbidden provider field.",
      );
    }
    inspectUntrusted(entry, state, depth + 1);
  }
  state.seen.delete(value);
}

function inspect(value) {
  inspectUntrusted(value, { nodes: 0, seen: new WeakSet() });
}

function project(schema, value) {
  if (schema.type === "nullable") {
    return value === null ? null : project(schema.schema, value);
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
    }
    if (value.length > schema.maxLength) {
      throw outputError("lark_tool_output_limit_exceeded", "The Lark Tool output exceeded the action text limit.");
    }
    if ((schema.values && !schema.values.includes(value)) || (schema.pattern && !schema.pattern.test(value))) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
    }
    return value;
  }
  if (schema.type === "integer") {
    if (!Number.isSafeInteger(value)) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
    }
    return value;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
    }
    if (value.length > schema.maxItems) {
      throw outputError("lark_tool_output_limit_exceeded", "The Lark Tool output exceeded the action item limit.");
    }
    return value.map((entry) => project(schema.items, entry));
  }
  if (!isPlainObject(value)) {
    throw outputError("lark_tool_output_invalid", "The Lark Tool output did not match its product schema.");
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output omitted a required product field.");
    }
  }
  for (const keys of schema.requiredAny) {
    if (!keys.some((key) => Object.hasOwn(value, key))) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool output omitted a required product identifier.");
    }
  }
  const result = {};
  for (const [key, childSchema] of Object.entries(schema.properties)) {
    if (Object.hasOwn(value, key)) result[key] = project(childSchema, value[key]);
  }
  return result;
}

function unwrapCliEnvelope(value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "ok")) return value;
  if (value.ok !== true || !Object.hasOwn(value, "data")) {
    throw outputError(
      "lark_tool_output_invalid",
      "The Lark CLI returned an invalid success envelope.",
    );
  }
  return value.data;
}

export function getLarkToolOutputSchema(action) {
  return ACTION_OUTPUT_SCHEMAS[action] ?? null;
}

export function sanitizeLarkActionOutput(action, value) {
  const schema = getLarkToolOutputSchema(action);
  if (!getLarkToolPolicy(action) || !schema) {
    throw outputError(
      "lark_tool_output_schema_missing",
      "No product output schema is registered for this Lark action.",
    );
  }
  inspect(value);
  return project(schema, unwrapCliEnvelope(value));
}

export function sanitizeLarkOperatorText(value, maxLength = 2_000) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw outputError("lark_effect_resolution_actor_required", "The effect note is invalid.");
  }
  inspect(value);
  return value;
}

function sanitizeExternalRef(value, policy) {
  if (
    !isPlainObject(value)
    || value.provider !== "lark"
    || value.resourceType !== policy.driver.resourceType
    || typeof value.id !== "string"
    || !EXTERNAL_ID.test(value.id)
    || (value.containerId !== undefined && (
      typeof value.containerId !== "string" || !EXTERNAL_ID.test(value.containerId)
    ))
  ) {
    throw outputError("lark_external_ref_invalid", "The Lark external reference is invalid.");
  }
  return {
    provider: "lark",
    resourceType: policy.driver.resourceType,
    id: value.id,
    ...(value.containerId ? { containerId: value.containerId } : {}),
  };
}

function sanitizeReceipt(value, policy, externalRef) {
  if (!isPlainObject(value) || typeof value.receiptId !== "string" || value.receiptId.length > 256) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool returned an invalid receipt.");
  }
  if (value.action !== undefined && value.action !== policy.action) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool receipt action did not match.");
  }
  if (value.effect !== undefined && value.effect !== policy.effect) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool receipt effect did not match.");
  }
  if (value.commandDigest !== undefined && (typeof value.commandDigest !== "string" || !DIGEST.test(value.commandDigest))) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool receipt digest was invalid.");
  }
  if (value.outputDigest !== undefined && (typeof value.outputDigest !== "string" || !DIGEST.test(value.outputDigest))) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool receipt digest was invalid.");
  }
  if (value.completedAt !== undefined && (typeof value.completedAt !== "string" || value.completedAt.length > 128)) {
    throw outputError("lark_effect_receipt_invalid", "The Lark Tool receipt timestamp was invalid.");
  }
  const receiptRef = value.externalRef === undefined
    ? externalRef
    : sanitizeExternalRef(value.externalRef, policy);
  if (externalRef && canonicalJson(receiptRef) !== canonicalJson(externalRef)) {
    throw outputError("lark_effect_receipt_conflict", "The Lark receipt did not match its external reference.");
  }
  return {
    receiptId: value.receiptId,
    action: policy.action,
    effect: policy.effect,
    ...(value.commandDigest ? { commandDigest: value.commandDigest } : {}),
    ...(value.outputDigest ? { outputDigest: value.outputDigest } : {}),
    ...(value.completedAt ? { completedAt: value.completedAt } : {}),
    ...(receiptRef ? { externalRef: receiptRef } : {}),
  };
}

export function sanitizeLarkToolResult(action, value) {
  const policy = getLarkToolPolicy(action);
  if (!policy) {
    throw outputError("lark_tool_not_allowed", "The requested Lark Tool is not registered.");
  }
  inspect(value);
  if (!isPlainObject(value) || value.action !== action || value.effect !== policy.effect) {
    throw outputError("lark_tool_output_invalid", "The Lark Tool result did not match its product contract.");
  }
  if (value.status === "confirmation_required") {
    if (policy.confirmationRequired !== true) {
      throw outputError("lark_tool_output_invalid", "The Lark Tool returned an unexpected confirmation state.");
    }
    const confirmation = value.confirmation === undefined
      ? undefined
      : project(object({
        action: string(256, { values: [action] }),
        summary: string(1_000),
      }, { required: ["action", "summary"] }), value.confirmation);
    return {
      status: "confirmation_required",
      action,
      effect: policy.effect,
      ...(confirmation ? { confirmation } : {}),
    };
  }
  if (value.status !== "succeeded") {
    throw outputError("lark_tool_output_invalid", "The Lark Tool returned an invalid status.");
  }
  const output = sanitizeLarkActionOutput(action, value.output);
  const externalRef = policy.effect === "write"
    ? sanitizeExternalRef(value.externalRef, policy)
    : undefined;
  if (policy.effect === "read" && value.externalRef !== undefined) {
    throw outputError("lark_tool_output_invalid", "A read-only Lark Tool returned an external effect reference.");
  }
  const receipt = sanitizeReceipt(value.receipt, policy, externalRef);
  return {
    status: "succeeded",
    action,
    effect: policy.effect,
    output,
    ...(externalRef ? { externalRef } : {}),
    receipt,
    ...(value.replayed === true ? { replayed: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {}),
  };
}

function canonicalJson(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
