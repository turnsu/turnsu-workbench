import { createServer } from "node:http";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createNativeAuthorizationProductClient } from "@looloomi/product-client/auth";
import { assertProductOrigin } from "./product-tools.mjs";
import { writeNativeProfile } from "./session.mjs";

export async function loginNativeProduct({ baseUrl, sessionPath, onAuthorization, fetch, timeoutMs = 300_000, signal, callbackMessage = "授权已接收，请回到终端查看连接结果。" }) {
  signal?.throwIfAborted();
  const origin = assertProductOrigin(baseUrl);
  try { await access(sessionPath); throw new Error("native_session_exists_choose_a_new_profile"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const client = createNativeAuthorizationProductClient({ baseUrl: origin, fetch });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const devicePublicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const callbackPath = `/turnsu/${randomBytes(24).toString("base64url")}`;
  let authorization;
  let complete, fail;
  const callback = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  callback.catch(() => {});
  let consumed = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || consumed || url.pathname !== callbackPath || !authorization
      || url.searchParams.get("authorization_id") !== authorization.authorizationId
      || !/^[A-Za-z0-9_-]{32,512}$/u.test(url.searchParams.get("code") || "")) {
      response.writeHead(400, { "Cache-Control": "no-store" }); response.end("Invalid authorization callback."); return;
    }
    consumed = true;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end(callbackMessage);
    complete(url.searchParams.get("code"));
  });
  const timer = setTimeout(() => fail(new Error("native_authorization_timed_out")), timeoutMs);
  const cancelled = () => fail(new Error("native_authorization_cancelled"));
  signal?.addEventListener("abort", cancelled, { once: true });
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}${callbackPath}`;
    signal?.throwIfAborted();
    authorization = (await client.call("startNativeAuthorization", { body: { schemaVersion: "workbench-api-v1", data: { clientKind: "desktop", redirectUri, codeChallenge: challenge, devicePublicKey } }, signal: requestSignal() })).body.data;
    if (new URL(authorization.authorizationUrl).origin !== origin) throw new Error("native_authorization_origin_mismatch");
    await onAuthorization(authorization.authorizationUrl);
    const authorizationCode = await callback;
    signal?.throwIfAborted();
    const tokens = (await client.call("completeNativeAuthorization", { body: { schemaVersion: "workbench-api-v1", data: { authorizationId: authorization.authorizationId, authorizationCode, codeVerifier: verifier, devicePublicKey } }, signal: requestSignal() })).body.data;
    signal?.throwIfAborted();
    await writeNativeProfile(sessionPath, { baseUrl: origin, tokens }, { create: true });
    return { workspaceId: tokens.workspaceId, clientSessionId: tokens.clientSessionId };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancelled); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
