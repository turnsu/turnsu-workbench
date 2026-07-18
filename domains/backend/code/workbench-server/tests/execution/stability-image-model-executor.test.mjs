import assert from "node:assert/strict";
import test from "node:test";

import {
  createStabilityImageExecutor,
  createStabilityImageModelExecutor,
} from "../../src/execution/stability-image-model-executor.mjs";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function imageInput(overrides = {}) {
  return {
    input: {
      prompt: "A safe lighthouse on a cliff",
      negativePrompt: "watermark",
      aspectRatio: "16:9",
      seed: 7,
      outputFormat: "png",
      ...overrides,
    },
  };
}

function binaryPngResponse(headers = {}) {
  return new Response(PNG_1X1, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "finish-reason": "SUCCESS",
      seed: "7",
      ...headers,
    },
  });
}

function makeExecutor({ fetchImpl = async () => binaryPngResponse(), artifactWriter, ...options } = {}) {
  return createStabilityImageExecutor({
    apiKey: "stability-secret",
    fetchImpl,
    artifactWriter: artifactWriter ?? (async () => ({ artifactId: "artifact-1", mediaType: "image/png" })),
    ...options,
  });
}

test("Stability driver sends bounded multipart input and gives bytes only to the Artifact boundary", async () => {
  const calls = [];
  const writes = [];
  const executor = makeExecutor({
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return binaryPngResponse();
    },
    artifactWriter: async (value) => {
      writes.push(value);
      return { artifactId: "artifact-safe-1", mediaType: value.mediaType };
    },
  });

  const result = await executor(imageInput());
  assert.equal(createStabilityImageModelExecutor, createStabilityImageExecutor);
  assert.equal(executor.protocol, "stability_image_v2");
  assert.deepEqual(executor.capabilities, ["image_generation"]);
  assert.equal(executor.structuredOutput.supported, false);
  assert.deepEqual(await executor.probe(), { available: true, configured: true, billableRequestMade: false });
  assert.equal(calls[0].url, "https://api.stability.ai/v2beta/stable-image/generate/core");
  assert.equal(calls[1].url, "https://api.stability.ai/v1/user/account");
  assert.equal(calls[1].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer stability-secret");
  assert.equal(calls[0].options.headers.accept, "image/*");
  assert.equal(calls[0].options.headers["content-type"], undefined);
  assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(calls[0].options.body.get("prompt"), "A safe lighthouse on a cliff");
  assert.equal(calls[0].options.body.get("negative_prompt"), "watermark");
  assert.equal(calls[0].options.body.get("aspect_ratio"), "16:9");
  assert.equal(calls[0].options.body.get("seed"), "7");
  assert.equal(calls[0].options.body.get("output_format"), "png");

  assert.equal(writes.length, 1);
  assert.ok(Buffer.isBuffer(writes[0].bytes));
  assert.deepEqual(writes[0].bytes, PNG_1X1);
  assert.equal(writes[0].mediaType, "image/png");
  assert.deepEqual(writes[0].dimensions, { width: 1, height: 1 });
  assert.deepEqual(result, {
    artifactRefs: [{ artifactId: "artifact-safe-1", mediaType: "image/png" }],
    seed: 7,
    format: "png",
    dimensions: { width: 1, height: 1 },
    safetyStatus: "passed",
    usage: { imageCount: 1, costUsdMicros: 30_000 },
  });
  assert.equal(JSON.stringify(result).includes("base64"), false);
  assert.equal(JSON.stringify(result).includes("bytes"), false);
  assert.equal(JSON.stringify(result).includes(PNG_1X1.toString("base64")), false);
});

test("Stability driver accepts bounded JSON/base64 and still returns only Artifact references", async () => {
  const writes = [];
  const executor = makeExecutor({
    responseMediaType: "application/json",
    fetchImpl: async () => new Response(JSON.stringify({
      image: PNG_1X1.toString("base64"),
      seed: 19,
      finish_reason: "SUCCESS",
    }), { status: 200, headers: { "content-type": "application/json; type=image/png" } }),
    artifactWriter: async (value) => {
      writes.push(value);
      return { artifactId: "artifact-json-1", mediaType: value.mediaType };
    },
  });

  const result = await executor(imageInput({ seed: 19 }));
  assert.deepEqual(result.artifactRefs, [{ artifactId: "artifact-json-1", mediaType: "image/png" }]);
  assert.equal(result.seed, 19);
  assert.deepEqual(writes[0].bytes, PNG_1X1);
});

test("Stability validates response MIME, requested format, image signature, and dimensions before Artifact writes", async (t) => {
  const fixtures = [
    ["invalid MIME", new Response(PNG_1X1, {
      status: 200, headers: { "content-type": "text/plain", seed: "7" },
    }), imageInput()],
    ["MIME/signature mismatch", binaryPngResponse({ "content-type": "image/jpeg" }), imageInput()],
    ["corrupt image", new Response(Buffer.from("not-an-image"), {
      status: 200, headers: { "content-type": "image/png", seed: "7" },
    }), imageInput()],
    ["requested format mismatch", binaryPngResponse(), imageInput({ outputFormat: "webp" })],
    ["invalid dimensions", new Response((() => {
      const value = Buffer.from(PNG_1X1);
      value.writeUInt32BE(20_000, 16);
      return value;
    })(), { status: 200, headers: { "content-type": "image/png", seed: "7" } }), imageInput()],
  ];
  for (const [name, response, input] of fixtures) {
    await t.test(name, async () => {
      let writes = 0;
      const executor = makeExecutor({
        fetchImpl: async () => response,
        artifactWriter: async () => {
          writes += 1;
          return { artifactId: "must-not-write", mediaType: "image/png" };
        },
      });
      await assert.rejects(executor(input), { code: "provider_response_invalid" });
      assert.equal(writes, 0);
    });
  }
});

test("Stability keeps oversized bodies, moderation, authentication, rate limits, and invalid requests distinct", async (t) => {
  const cases = [
    ["oversized", async () => new Response("small", {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "2048", seed: "7" },
    }), "provider_response_too_large", { maxResponseBytes: 1024 }],
    ["moderation", async () => new Response(JSON.stringify({ name: "content_moderation" }), {
      status: 403, headers: { "content-type": "application/json" },
    }), "provider_content_rejected"],
    ["authentication", async () => new Response("private", { status: 401 }), "provider_auth_failed"],
    ["rate limit", async () => new Response("private", { status: 429 }), "provider_rate_limited"],
    ["invalid request", async () => new Response("private", { status: 422 }), "provider_request_invalid"],
  ];
  for (const [name, fetchImpl, code, options] of cases) {
    await t.test(name, async () => {
      let writes = 0;
      const executor = makeExecutor({
        fetchImpl,
        artifactWriter: async () => {
          writes += 1;
          return { artifactId: "must-not-write", mediaType: "image/png" };
        },
        ...options,
      });
      await assert.rejects(executor(imageInput()), (error) => (
        error.code === code
        && error.productSafe === true
        && !error.message.includes("stability-secret")
        && !error.message.includes("private")
      ));
      assert.equal(writes, 0);
    });
  }
});

test("Stability maps JSON safety outcomes and refuses invalid or oversized base64", async (t) => {
  const cases = [
    ["filtered", { image: PNG_1X1.toString("base64"), seed: 7, finish_reason: "CONTENT_FILTERED" }, "provider_content_rejected"],
    ["invalid base64", { image: "***", seed: 7, finish_reason: "SUCCESS" }, "provider_response_invalid"],
    ["oversized decoded image", { image: Buffer.alloc(2_048).toString("base64"), seed: 7, finish_reason: "SUCCESS" }, "provider_response_too_large"],
  ];
  for (const [name, payload, code] of cases) {
    await t.test(name, async () => {
      const executor = makeExecutor({
        responseMediaType: "application/json",
        maxResponseBytes: 1024,
        fetchImpl: async () => new Response(JSON.stringify(payload), {
          status: 200, headers: { "content-type": "application/json" },
        }),
      });
      await assert.rejects(executor(imageInput()), { code });
    });
  }
});

test("Stability propagates caller abort and separates it from provider timeout", async (t) => {
  const pendingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });

  await t.test("cancel", async () => {
    const executor = makeExecutor({ fetchImpl: pendingFetch });
    const controller = new AbortController();
    const pending = executor({ ...imageInput(), signal: controller.signal });
    controller.abort(new Error("private cancellation reason"));
    await assert.rejects(pending, { code: "cancelled", status: "cancelled" });
  });

  await t.test("timeout", async () => {
    const executor = makeExecutor({ fetchImpl: pendingFetch, timeoutMs: 5 });
    await assert.rejects(executor(imageInput()), { code: "provider_timeout", status: "timeout" });
  });

  await t.test("pre-aborted requests never call fetch", async () => {
    let calls = 0;
    const executor = makeExecutor({ fetchImpl: async () => { calls += 1; return binaryPngResponse(); } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(executor({ ...imageInput(), signal: controller.signal }), { code: "cancelled" });
    assert.equal(calls, 0);
  });
});

test("Stability rejects an unsafe Artifact boundary result instead of returning bytes", async () => {
  const executor = makeExecutor({ artifactWriter: async () => ({ bytes: PNG_1X1 }) });
  await assert.rejects(executor(imageInput()), { code: "artifact_write_failed" });
});

test("Stability checks the pinned Core cost budget before making a billable request", async () => {
  let calls = 0;
  const executor = makeExecutor({
    limits: { maxCostUsdMicros: 29_999 },
    fetchImpl: async () => { calls += 1; return binaryPngResponse(); },
  });
  await assert.rejects(executor(imageInput()), {
    code: "model_cost_budget_exceeded",
    status: "blocked",
  });
  assert.equal(calls, 0);
});

test("Stability readiness uses the non-billable account endpoint and maps authentication failures", async () => {
  let artifactWrites = 0;
  const executor = makeExecutor({
    fetchImpl: async (url) => {
      assert.equal(String(url), "https://api.stability.ai/v1/user/account");
      return new Response("private", { status: 401 });
    },
    artifactWriter: async () => { artifactWrites += 1; return null; },
  });
  await assert.rejects(executor.probe(), { code: "provider_auth_failed" });
  assert.equal(artifactWrites, 0);
});
