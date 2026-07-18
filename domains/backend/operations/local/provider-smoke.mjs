import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import {
  computeCandidateDigest,
  expectedProviderSmokeRequestDigest,
  stabilityCoreBillingEvidence,
} from "./release-evidence.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked"]);
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RAW_BASE64 = /(?:data:[^;,]+;base64,|[A-Za-z0-9+/]{512,}={0,2})/;

export async function runProductProviderSmoke({
  bundleRoot,
  sourceCommit,
  kind,
  profileId,
  confirmBillable = false,
  env,
  clock = () => new Date().toISOString(),
  timeoutMs = 300_000,
  startServer = null,
} = {}) {
  validateInput({ bundleRoot, sourceCommit, kind, profileId, confirmBillable, env, timeoutMs });
  if (kind === "stability" && confirmBillable !== true) throw smokeError("stability_billable_confirmation_required");
  const candidateDigest = await computeCandidateDigest(bundleRoot);
  const launch = startServer ?? await candidateServerLauncher(bundleRoot);
  let running;
  try {
    running = await launch({
      port: 0,
      env,
      distDirectory: resolve(bundleRoot, "missing-static-for-provider-smoke"),
      testIdentityResolver: (req) => ({
        userId: String(req.headers["x-workbench-test-user"] || ""),
        workspaceId: String(req.headers["x-workbench-test-workspace"] || ""),
      }),
    });
    const address = running.server.address();
    if (!address || typeof address === "string") throw smokeError("provider_smoke_server_unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}/api/workbench/v1`;
    const primary = await createSession(baseUrl, { userId: "provider-smoke-user", workspaceId: "workspace-local" });
    const capability = kind === "chat" ? "chat" : "image_generation";
    const catalog = await primary.request(`/model-profiles?capabilities=${capability}`);
    const profile = Array.isArray(catalog) ? catalog.find((item) => item.profileId === profileId) : null;
    if (!profile || profile.selectable !== true || !["ready", "degraded"].includes(profile.readiness)) {
      throw smokeError("provider_smoke_profile_unavailable");
    }
    if (kind === "stability" && !validStabilityCoreReleaseProfile(profile)) {
      throw smokeError("stability_smoke_profile_policy_invalid");
    }
    const modelProfileRevisionId = profile.currentRevisionId;
    const agentSession = await primary.request("/agent-sessions", {
      method: "POST",
      data: { definitionId: "main", lastUsedModelProfileId: profile.profileId },
    });
    const turnRequest = kind === "chat" ? {
      kind: "agent_message",
      modelProfileRevisionId,
      input: { message: "Reply with a short acknowledgement for the looloomi release smoke." },
    } : {
      kind: "model_task",
      modelProfileRevisionId,
      input: {
        task: "image_generation",
        prompt: "A simple blue circle centered on a plain white background.",
        aspectRatio: "1:1",
        outputFormat: "png",
      },
    };
    const requestDigest = digest(turnRequest);
    if (requestDigest !== expectedProviderSmokeRequestDigest(capability, modelProfileRevisionId)) {
      throw smokeError("provider_smoke_request_fixture_invalid");
    }
    let turn = await primary.request(`/agent-sessions/${encodeURIComponent(agentSession.sessionId)}/turns`, {
      method: "POST",
      data: turnRequest,
    });
    turn = await pollTurn(primary, agentSession.sessionId, turn.turnId, { timeoutMs });
    assertSuccessfulPinnedTurn(turn, { modelProfileRevisionId, kind });
    const observed = [profile, agentSession, turn];
    const baseEvidence = {
      schemaVersion: "looloomi-provider-smoke-v1",
      producer: "looloomi-provider-smoke-v1",
      sourceCommit,
      candidateDigest,
      capability,
      status: "passed",
      executedAt: clock(),
      profileRevisionId: modelProfileRevisionId,
      protocol: protocolForProvider(profile.currentRevision?.providerDisplay?.key),
      requestDigest,
      responseDigest: digest(turn.result),
      attempts: turn.result?.invocationIds?.length ?? turn.invocationIds?.length ?? 0,
      fallback: turn.actualModelRevisionId !== turn.requestedModelRevisionId,
    };
    if (kind === "chat") {
      assertNoRawPayload(observed);
      return Object.freeze({
        ...baseEvidence,
        assertions: {
          productPath: true,
          requestedActualMatch: true,
          rawProviderPayloadAbsent: true,
          secretLeakScanPassed: true,
        },
      });
    }

    const artifactRef = turn.artifactRefs?.[0] ?? turn.result?.artifactRefs?.[0] ?? turn.result?.result?.artifactRefs?.[0];
    if (!artifactRef?.artifactId) throw smokeError("stability_smoke_artifact_missing");
    const metadata = await primary.request(`/artifacts/${encodeURIComponent(artifactRef.artifactId)}`);
    const content = await primary.requestBinary(`/artifacts/${encodeURIComponent(artifactRef.artifactId)}/content`);
    const artifactDigest = `sha256:${createHash("sha256").update(content.bytes).digest("hex")}`;
    const responseMediaType = String(content.mediaType || "").split(";", 1)[0].trim().toLowerCase();
    if (metadata.contentHash !== artifactDigest || metadata.byteLength !== content.bytes.length
      || !["image/png", "image/jpeg", "image/webp"].includes(metadata.mediaType)
      || metadata.mediaType !== responseMediaType || metadata.mediaType !== artifactRef.mediaType
      || !validArtifactDimensions(metadata.dimensions)) {
      throw smokeError("stability_smoke_artifact_validation_failed");
    }
    const unauthorized = await createSession(baseUrl, {
      userId: "provider-smoke-other-user",
      workspaceId: "provider-smoke-other-workspace",
    });
    const crossWorkspaceStatus = await unauthorized.requestStatus(
      `/artifacts/${encodeURIComponent(artifactRef.artifactId)}`,
    );
    if (![403, 404].includes(crossWorkspaceStatus)) throw smokeError("stability_smoke_cross_workspace_leak");
    assertNoRawPayload([...observed, metadata]);
    return Object.freeze({
      ...baseEvidence,
      billableConfirmed: true,
      artifactId: artifactRef.artifactId,
      artifactDigest,
      artifactMediaType: metadata.mediaType,
      artifactDimensions: metadata.dimensions,
      billing: stabilityCoreBillingEvidence(),
      assertions: {
        productPath: true,
        requestedActualMatch: true,
        rawProviderPayloadAbsent: true,
        secretLeakScanPassed: true,
        noPiSession: turn.kind === "model_task",
        authorizedRetrieval: true,
        crossWorkspaceDenied: true,
        artifactHashVerified: true,
      },
    });
  } finally {
    await running?.close?.();
  }
}

function validArtifactDimensions(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Number.isSafeInteger(value.width) && value.width >= 1 && value.width <= 32_768
    && Number.isSafeInteger(value.height) && value.height >= 1 && value.height <= 32_768;
}

function validStabilityCoreReleaseProfile(profile) {
  const support = profile?.currentRevision?.parameterSupport;
  const limits = profile?.currentRevision?.limits;
  return profile?.currentRevision?.providerDisplay?.key === "stability"
    && support?.kind === "image_generation"
    && Array.isArray(support.aspectRatios) && support.aspectRatios.includes("1:1")
    && Array.isArray(support.outputFormats) && support.outputFormats.includes("png")
    && limits?.kind === "image_generation"
    && limits.maxImageCount === 1
    && limits.maxCostUsdMicros === 30_000
    && Number.isSafeInteger(limits.maxOutputBytes) && limits.maxOutputBytes >= 1;
}

async function candidateServerLauncher(bundleRoot) {
  const node = join(bundleRoot, ".tooling/node/bin/node");
  const source = `
    import { resolve } from "node:path";
    import { pathToFileURL } from "node:url";
    const moduleUrl = pathToFileURL(resolve("domains/backend/code/workbench-server/src/server.mjs")).href;
    const { startWorkbenchServer } = await import(moduleUrl);
    if (typeof startWorkbenchServer !== "function") throw new Error("provider_smoke_runner_unavailable");
    const running = await startWorkbenchServer({
      port: 0,
      env: process.env,
      distDirectory: resolve("missing-static-for-provider-smoke"),
      testIdentityResolver: (req) => ({
        userId: String(req.headers["x-workbench-test-user"] || ""),
        workspaceId: String(req.headers["x-workbench-test-workspace"] || ""),
      }),
    });
    const address = running.server.address();
    if (!address || typeof address === "string") throw new Error("provider_smoke_server_unavailable");
    process.stdout.write(\`LOOLOOMI_PROVIDER_SMOKE_PORT=\${address.port}\\n\`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await running.close(); process.exitCode = 0; }
      catch { process.exitCode = 1; }
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  `;
  return ({ env }) => launchCandidateProcess({ node, bundleRoot, env, source });
}

function launchCandidateProcess({ node, bundleRoot, env, source }) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    let child;
    try {
      child = spawn(node, ["--input-type=module", "--eval", source], {
        cwd: bundleRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      rejectLaunch(smokeError("provider_smoke_runner_unavailable"));
      return;
    }
    let settled = false;
    let closed = false;
    let stdoutBuffer = "";
    let outputBytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
    const finishError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectLaunch(smokeError("provider_smoke_server_unavailable"));
    };
    const exited = new Promise((resolveExit) => child.once("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      if (!settled) finishError();
      resolveExit(code);
    }));
    child.once("error", finishError);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) {
        child.kill("SIGKILL");
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^LOOLOOMI_PROVIDER_SMOKE_PORT=([0-9]{1,5})$/.exec(line.trim());
        const port = Number(match?.[1]);
        if (!match || !Number.isInteger(port) || port < 1 || port > 65_535 || settled) continue;
        settled = true;
        clearTimeout(timeout);
        resolveLaunch({
          server: { address: () => ({ port, address: "127.0.0.1", family: "IPv4" }) },
          async close() {
            if (closed) return;
            child.kill("SIGTERM");
            const closeTimeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
            await exited;
            clearTimeout(closeTimeout);
          },
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) child.kill("SIGKILL");
    });
  });
}

async function createSession(baseUrl, identity) {
  const headers = {
    "x-workbench-test-user": identity.userId,
    "x-workbench-test-workspace": identity.workspaceId,
  };
  const response = await fetch(`${baseUrl}/workspace`, { headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data?.session?.csrfToken) throw smokeError("provider_smoke_session_failed");
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie.startsWith("workbench_session=")) throw smokeError("provider_smoke_session_failed");
  const common = {
    accept: "application/json",
    cookie,
    "x-workbench-csrf": payload.data.session.csrfToken,
  };
  return Object.freeze({
    request: (path, options) => productRequest(baseUrl, path, common, options),
    requestBinary: (path) => productBinary(baseUrl, path, common),
    requestStatus: (path) => productStatus(baseUrl, path, common),
  });
}

async function productRequest(baseUrl, path, common, { method = "GET", data } = {}) {
  const mutation = method !== "GET";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...common,
      ...(mutation ? {
        "content-type": "application/json",
        "idempotency-key": `provider-smoke-${randomUUID()}`,
      } : {}),
    },
    ...(mutation ? { body: JSON.stringify({ schemaVersion: "workbench-api-v1", data }) } : {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !("data" in payload)) throw smokeError("provider_smoke_product_request_failed");
  return payload.data;
}

async function productBinary(baseUrl, path, common) {
  const response = await fetch(`${baseUrl}${path}`, { headers: common });
  if (!response.ok) throw smokeError("provider_smoke_artifact_read_failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1 || bytes.length > 100_000_000) throw smokeError("provider_smoke_artifact_invalid");
  return { bytes, mediaType: response.headers.get("content-type") };
}

async function productStatus(baseUrl, path, common) {
  const response = await fetch(`${baseUrl}${path}`, { headers: common });
  await response.body?.cancel?.().catch(() => {});
  return response.status;
}

async function pollTurn(client, sessionId, turnId, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  do {
    const turn = await client.request(
      `/agent-sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
    );
    if (TERMINAL.has(turn.status)) return turn;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  } while (Date.now() < deadline);
  throw smokeError("provider_smoke_timeout");
}

function assertSuccessfulPinnedTurn(turn, { modelProfileRevisionId, kind }) {
  if (turn?.status !== "completed" || turn.kind !== (kind === "chat" ? "agent_message" : "model_task")
    || turn.requestedModelRevisionId !== modelProfileRevisionId
    || turn.actualModelRevisionId !== modelProfileRevisionId || !turn.result) {
    throw smokeError("provider_smoke_turn_failed");
  }
}

function assertNoRawPayload(values) {
  const source = JSON.stringify(values);
  if (/authorization|api[_-]?key|credential|providerPayload|provider_payload/i.test(source)
    || RAW_BASE64.test(source)) throw smokeError("provider_smoke_sensitive_payload_detected");
}

function validateInput({ bundleRoot, sourceCommit, kind, profileId, confirmBillable, env, timeoutMs }) {
  if (typeof bundleRoot !== "string" || !isAbsolute(bundleRoot)
    || !SOURCE_COMMIT.test(sourceCommit || "") || !["chat", "stability"].includes(kind)
    || !SAFE_ID.test(profileId || "") || typeof confirmBillable !== "boolean"
    || !env || typeof env !== "object" || Array.isArray(env)
    || !String(env.WORKBENCH_MONGODB_DB || "").endsWith("_test")
    || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new TypeError("provider_smoke_input_invalid");
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function protocolForProvider(provider) {
  const protocol = {
    deepseek: "openai_compatible_chat",
    openai: "openai_compatible_chat",
    custom: "openai_compatible_chat",
    anthropic: "anthropic_messages",
    gemini: "gemini_generate_content",
    stability: "stability_image_v2",
  }[provider];
  if (!protocol) throw smokeError("provider_smoke_protocol_unavailable");
  return protocol;
}

function smokeError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
