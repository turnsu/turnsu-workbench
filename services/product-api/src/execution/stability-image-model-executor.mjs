import { ModelProviderError } from "./openai-compatible-model-executor.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const DEFAULT_ENDPOINT_PATH = "v2beta/stable-image/generate/core";
const ACCOUNT_PROBE_PATH = "v1/user/account";
export const STABILITY_CORE_COST_USD_MICROS = 30_000;
const IMAGE_CAPABILITIES = Object.freeze(["image_generation"]);
const OUTPUT_FORMATS = Object.freeze({
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
});
const ASPECT_RATIOS = new Set(["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"]);
const CONTENT_REJECTION_REASONS = new Set([
  "CONTENT_FILTERED", "CONTENT_REJECTED", "FILTERED", "MODERATION_REJECTED", "SAFETY",
]);

export function createStabilityImageExecutor({
  baseUrl = "https://api.stability.ai",
  apiKey,
  model = "stable-image-core",
  fetchImpl = globalThis.fetch,
  artifactWriter,
  endpointPath = DEFAULT_ENDPOINT_PATH,
  responseMediaType = "image/*",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxImagePixels = DEFAULT_MAX_IMAGE_PIXELS,
  limits = null,
} = {}) {
  const resolvedLimits = resolveLimits({ timeoutMs, maxResponseBytes, maxImagePixels, limits });
  const provider = validateConfiguration({
    baseUrl,
    apiKey,
    model,
    fetchImpl,
    artifactWriter,
    endpointPath,
    responseMediaType,
    ...resolvedLimits,
  });
  const execute = async ({ input, signal } = {}) => {
    if (signal?.aborted) throw providerError("cancelled");
    const normalized = normalizeImageInput(input);
    if (provider.maxCostUsdMicros < STABILITY_CORE_COST_USD_MICROS) {
      throw providerError("model_cost_budget_exceeded");
    }
    const form = providerRequest(normalized);
    const image = await withProviderDeadline({ signal, timeoutMs: provider.timeoutMs }, async (requestSignal) => {
      const response = await provider.fetchImpl(new URL(provider.endpointPath, provider.baseUrl), {
        method: "POST",
        body: form,
        signal: requestSignal,
        headers: {
          accept: provider.responseMediaType,
          authorization: `Bearer ${provider.apiKey}`,
        },
      });
      if (!response?.ok) throw await providerHttpError(response, provider.maxResponseBytes);
      return normalizeProviderResponse(response, normalized, provider);
    });
    if (signal?.aborted) throw providerError("cancelled");
    let artifactRef;
    try {
      artifactRef = await provider.artifactWriter(Object.freeze({
        bytes: Buffer.from(image.bytes),
        mediaType: image.mediaType,
        format: image.format,
        dimensions: Object.freeze({ ...image.dimensions }),
        seed: image.seed,
        safetyStatus: "passed",
        usage: Object.freeze({ imageCount: 1, costUsdMicros: STABILITY_CORE_COST_USD_MICROS }),
        signal,
      }));
    } catch (error) {
      if (signal?.aborted) throw providerError("cancelled");
      throw error;
    }
    const safeArtifactRef = normalizeArtifactRef(artifactRef, image.mediaType);
    return Object.freeze({
      artifactRefs: Object.freeze([safeArtifactRef]),
      seed: image.seed,
      format: image.format,
      dimensions: Object.freeze({ ...image.dimensions }),
      safetyStatus: "passed",
      usage: Object.freeze({ imageCount: 1, costUsdMicros: STABILITY_CORE_COST_USD_MICROS }),
    });
  };
  execute.probe = async ({ signal } = {}) => {
    await withProviderDeadline({ signal, timeoutMs: provider.timeoutMs }, async (requestSignal) => {
      const response = await provider.fetchImpl(new URL(ACCOUNT_PROBE_PATH, provider.baseUrl), {
        method: "GET",
        signal: requestSignal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${provider.apiKey}`,
        },
      });
      if (!response?.ok) throw await providerHttpError(response, Math.min(provider.maxResponseBytes, 64 * 1024));
      await readBoundedBytes(response, Math.min(provider.maxResponseBytes, 64 * 1024));
    });
    return Object.freeze({ available: true, configured: true, billableRequestMade: false });
  };
  execute.protocol = "stability_image_v2";
  execute.capabilities = IMAGE_CAPABILITIES;
  execute.structuredOutput = Object.freeze({ supported: false });
  return Object.freeze(execute);
}

export const createStabilityImageModelExecutor = createStabilityImageExecutor;

function resolveLimits({ timeoutMs, maxResponseBytes, maxImagePixels, limits }) {
  if (limits !== null && !isPlainObject(limits)) throw new TypeError("stability_provider_configuration_invalid");
  return {
    timeoutMs: limits?.timeoutMs ?? timeoutMs,
    maxResponseBytes: limits?.maxResponseBytes ?? limits?.maxOutputBytes ?? maxResponseBytes,
    maxImagePixels: limits?.maxImagePixels ?? maxImagePixels,
    maxCostUsdMicros: limits?.maxCostUsdMicros ?? STABILITY_CORE_COST_USD_MICROS,
  };
}

function validateConfiguration({
  baseUrl,
  apiKey,
  model,
  fetchImpl,
  artifactWriter,
  endpointPath,
  responseMediaType,
  timeoutMs,
  maxResponseBytes,
  maxImagePixels,
  maxCostUsdMicros,
}) {
  if (typeof fetchImpl !== "function" || typeof artifactWriter !== "function"
    || typeof apiKey !== "string" || apiKey.length < 1 || apiKey.length > 4096
    || !["core", "stable-image-core"].includes(model)
    || endpointPath !== DEFAULT_ENDPOINT_PATH
    || !["image/*", "application/json"].includes(responseMediaType)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 64 * 1024 * 1024
    || !Number.isInteger(maxImagePixels) || maxImagePixels < 1 || maxImagePixels > 64 * 1024 * 1024
    || !Number.isInteger(maxCostUsdMicros) || maxCostUsdMicros < 0
    || maxCostUsdMicros > 1_000_000_000_000) {
    throw new TypeError("stability_provider_configuration_invalid");
  }
  return {
    baseUrl: validateBaseUrl(baseUrl),
    apiKey,
    model,
    fetchImpl,
    artifactWriter,
    endpointPath,
    responseMediaType,
    timeoutMs,
    maxResponseBytes,
    maxImagePixels,
    maxCostUsdMicros,
  };
}

function normalizeArtifactRef(value, expectedMediaType) {
  if (!isPlainObject(value)
    || typeof value.artifactId !== "string" || value.artifactId.length < 1 || value.artifactId.length > 256
    || value.mediaType !== expectedMediaType) {
    throw providerError("artifact_write_failed");
  }
  return Object.freeze({ artifactId: value.artifactId, mediaType: value.mediaType });
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

function normalizeImageInput(input) {
  const value = isPlainObject(input?.typedInput) ? input.typedInput : input;
  if (!isPlainObject(value) || typeof value.prompt !== "string"
    || value.prompt.length < 1 || value.prompt.length > 10_000) {
    throw providerError("provider_request_invalid");
  }
  const negativePrompt = value.negativePrompt;
  const aspectRatio = value.aspectRatio;
  const seed = value.seed;
  const outputFormat = value.outputFormat ?? "png";
  if ((negativePrompt !== undefined && (typeof negativePrompt !== "string" || negativePrompt.length > 10_000))
    || (aspectRatio !== undefined && !ASPECT_RATIOS.has(aspectRatio))
    || (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0 || seed > 4_294_967_294))
    || !Object.hasOwn(OUTPUT_FORMATS, outputFormat)) {
    throw providerError("provider_request_invalid");
  }
  return { prompt: value.prompt, negativePrompt, aspectRatio, seed, outputFormat };
}

function providerRequest(input) {
  const form = new FormData();
  form.set("prompt", input.prompt);
  if (input.negativePrompt !== undefined) form.set("negative_prompt", input.negativePrompt);
  if (input.aspectRatio !== undefined) form.set("aspect_ratio", input.aspectRatio);
  if (input.seed !== undefined) form.set("seed", String(input.seed));
  form.set("output_format", input.outputFormat);
  return form;
}

async function normalizeProviderResponse(response, input, provider) {
  const responseContentType = contentType(response.headers?.get?.("content-type"));
  const body = await readBoundedBytes(response, provider.maxResponseBytes);
  let bytes;
  let seed;
  let finishReason;
  if (responseContentType === "application/json") {
    const payload = parseJson(body);
    const encoded = payload?.image ?? payload?.base64;
    finishReason = payload?.finish_reason ?? payload?.finishReason;
    seed = normalizedSeed(payload?.seed, input.seed);
    bytes = decodeBoundedBase64(encoded, provider.maxResponseBytes);
  } else {
    if (!Object.values(OUTPUT_FORMATS).includes(responseContentType)) {
      throw providerError("provider_response_invalid");
    }
    finishReason = response.headers?.get?.("finish-reason") ?? response.headers?.get?.("finish_reason");
    seed = normalizedSeed(response.headers?.get?.("seed"), input.seed);
    bytes = body;
  }
  assertAcceptedFinishReason(finishReason);
  const inspected = inspectImage(bytes, provider.maxImagePixels);
  if (inspected.format !== input.outputFormat
    || (responseContentType !== "application/json" && responseContentType !== inspected.mediaType)) {
    throw providerError("provider_response_invalid");
  }
  return { bytes, seed, ...inspected };
}

function normalizedSeed(value, requestedSeed) {
  if (value === null || value === undefined || value === "") {
    return Number.isSafeInteger(requestedSeed) ? requestedSeed : null;
  }
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4_294_967_294) {
    throw providerError("provider_response_invalid");
  }
  return parsed;
}

function assertAcceptedFinishReason(value) {
  if (value === null || value === undefined || value === "") return;
  const normalized = String(value).toUpperCase();
  if (CONTENT_REJECTION_REASONS.has(normalized) || /(CONTENT|SAFETY|MODERATION|FILTER)/.test(normalized)) {
    throw providerError("provider_content_rejected");
  }
  if (normalized !== "SUCCESS") throw providerError("provider_response_invalid");
}

function decodeBoundedBase64(value, maxBytes) {
  if (typeof value !== "string" || value.length < 1 || value.length > Math.ceil(maxBytes / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw providerError("provider_response_invalid");
  }
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const bytes = Buffer.from(padded, "base64");
  if (bytes.length > maxBytes) throw providerError("provider_response_too_large");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw providerError("provider_response_invalid");
  }
  return bytes;
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw providerError("provider_response_invalid"); }
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

async function readBoundedBytes(response, maxBytes) {
  const declared = response.headers?.get?.("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw providerError("provider_response_too_large");
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw providerError("provider_response_too_large");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel().catch(() => {});
      throw providerError("provider_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, length);
}

async function providerHttpError(response, maxResponseBytes) {
  let payload = null;
  try {
    const body = await readBoundedBytes(response, Math.min(maxResponseBytes, 64 * 1024));
    if (contentType(response.headers?.get?.("content-type")) === "application/json") payload = parseJson(body);
  } catch (error) {
    if (error instanceof ModelProviderError) return error;
  }
  const statusCode = Number(response?.status);
  const fingerprint = providerErrorFingerprint(payload);
  if (statusCode === 401) return providerError("provider_auth_failed");
  if (statusCode === 403 || /(content|safety|moderation|policy[_ -]?violation|blocked)/i.test(fingerprint)) {
    return providerError("provider_content_rejected");
  }
  if (statusCode === 429) return providerError("provider_rate_limited");
  if ([408, 504].includes(statusCode)) return providerError("provider_timeout");
  if (statusCode >= 400 && statusCode < 500) return providerError("provider_request_invalid");
  return providerError("provider_request_failed");
}

function providerErrorFingerprint(payload) {
  if (!isPlainObject(payload)) return "";
  const error = isPlainObject(payload.error) ? payload.error : payload;
  return [error.type, error.code, error.status, error.reason, payload.name]
    .filter((value) => typeof value === "string").join(" ");
}

function inspectImage(bytes, maxImagePixels) {
  let inspected;
  if (isPng(bytes)) inspected = inspectPng(bytes);
  else if (isJpeg(bytes)) inspected = inspectJpeg(bytes);
  else if (isWebp(bytes)) inspected = inspectWebp(bytes);
  else throw providerError("provider_response_invalid");
  const { width, height } = inspected.dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 16_384 || height > 16_384 || width * height > maxImagePixels) {
    throw providerError("provider_response_invalid");
  }
  return inspected;
}

function inspectPng(bytes) {
  if (bytes.length < 45) throw providerError("provider_response_invalid");
  let offset = 8;
  let dimensions = null;
  let hasImageData = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > bytes.length) throw providerError("provider_response_invalid");
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) throw providerError("provider_response_invalid");
      dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    }
    if (type === "IDAT" && length > 0) hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.length) throw providerError("provider_response_invalid");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!dimensions || !hasImageData || !ended) throw providerError("provider_response_invalid");
  return { format: "png", mediaType: "image/png", dimensions };
}

function inspectJpeg(bytes) {
  if (bytes.length < 12 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw providerError("provider_response_invalid");
  }
  let offset = 2;
  let dimensions = null;
  while (offset + 4 <= bytes.length - 2) {
    if (bytes[offset] !== 0xff) throw providerError("provider_response_invalid");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > bytes.length) throw providerError("provider_response_invalid");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw providerError("provider_response_invalid");
    if (isStartOfFrame(marker)) {
      if (length < 7) throw providerError("provider_response_invalid");
      dimensions = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  if (!dimensions) throw providerError("provider_response_invalid");
  return { format: "jpeg", mediaType: "image/jpeg", dimensions };
}

function inspectWebp(bytes) {
  if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw providerError("provider_response_invalid");
  const chunk = bytes.subarray(12, 16).toString("ascii");
  let width;
  let height;
  if (chunk === "VP8X") {
    width = 1 + readUInt24LE(bytes, 24);
    height = 1 + readUInt24LE(bytes, 27);
  } else if (chunk === "VP8 ") {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw providerError("provider_response_invalid");
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else if (chunk === "VP8L") {
    if (bytes.length < 25 || bytes[20] !== 0x2f) throw providerError("provider_response_invalid");
    width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
    height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
  } else {
    throw providerError("provider_response_invalid");
  }
  return { format: "webp", mediaType: "image/webp", dimensions: { width, height } };
}

function isPng(bytes) {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}
function isJpeg(bytes) { return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8; }
function isWebp(bytes) {
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}
function isStartOfFrame(marker) {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}
function readUInt24LE(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function contentType(value) { return String(value || "").split(";", 1)[0].trim().toLowerCase(); }
function providerError(code) { return new ModelProviderError(code); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
