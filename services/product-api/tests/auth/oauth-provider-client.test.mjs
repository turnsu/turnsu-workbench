import assert from "node:assert/strict";
import {
  createSign,
  generateKeyPairSync,
} from "node:crypto";
import test from "node:test";

import {
  GitHubOAuthClient,
  GoogleOAuthClient,
} from "../../src/auth/oauth-provider-client.mjs";

const jsonResponse = (value, { ok = true } = {}) => ({ ok, json: async () => value });

const signedGoogleToken = ({ privateKey, payload }) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
};

test("Google OAuth verifies issuer, audience, nonce, PKCE exchange and verified email", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  const nonce = "nonce-0123456789";
  const token = signedGoogleToken({
    privateKey,
    payload: {
      iss: "https://accounts.google.com",
      aud: "google-client-id",
      sub: "google-subject-1",
      nonce,
      email: "Member@Example.Test",
      email_verified: true,
      iat: 1_785_110_000,
      exp: 1_785_114_000,
    },
  });
  const requests = [];
  const client = new GoogleOAuthClient({
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
    redirectUri: "https://app.example.test/api/workbench/v1/auth/oauth/google/callback",
    clock: () => new Date("2026-07-27T00:00:00.000Z"),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).includes("oauth2.googleapis.com/token")) return jsonResponse({ id_token: token });
      return jsonResponse({ keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "RS256" }] });
    },
  });
  const authorizationUrl = new URL(await client.authorizationUrl({
    state: "state-0123456789",
    codeVerifier: "verifier-0123456789-verifier-0123456789-verifier",
    nonce,
  }));
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("nonce"), nonce);

  const result = await client.complete({
    code: "authorization-code",
    codeVerifier: "verifier-0123456789-verifier-0123456789-verifier",
    nonce,
  });
  assert.deepEqual(result, {
    provider: "google",
    providerSubject: "google-subject-1",
    verifiedEmail: "member@example.test",
  });
  assert.equal(requests.some((request) => String(request.url).includes("oauth2.googleapis.com/token")), true);
  assert.equal(JSON.stringify(result).includes("google-client-secret"), false);
});

test("GitHub OAuth derives identity only from subject and a verified email, never username", async () => {
  const calls = [];
  const client = new GitHubOAuthClient({
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
    redirectUri: "https://app.example.test/api/workbench/v1/auth/oauth/github/callback",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("access_token")) return jsonResponse({ access_token: "github-access-token" });
      if (String(url).endsWith("/user")) return jsonResponse({ id: 42, login: "public-username-must-not-be-used" });
      return jsonResponse([
        { email: "unverified@example.test", verified: false, primary: true },
        { email: "Verified@Example.Test", verified: true, primary: true },
      ]);
    },
  });

  const result = await client.complete({ code: "authorization-code", codeVerifier: "pkce-verifier" });
  assert.deepEqual(result, {
    provider: "github",
    providerSubject: "42",
    verifiedEmail: "verified@example.test",
  });
  assert.equal(JSON.stringify(result).includes("public-username"), false);
  assert.equal(calls.some(({ options }) => options.headers?.Authorization === "Bearer github-access-token"), true);
});

test("GitHub OAuth fails closed when a verified email is unavailable", async () => {
  const client = new GitHubOAuthClient({
    clientId: "github-client-id",
    clientSecret: "github-client-secret",
    redirectUri: "https://app.example.test/callback",
    fetchImpl: async (url) => {
      if (String(url).includes("access_token")) return jsonResponse({ access_token: "github-access-token" });
      if (String(url).endsWith("/user")) return jsonResponse({ id: 42 });
      return jsonResponse([{ email: "unverified@example.test", verified: false, primary: true }]);
    },
  });
  await assert.rejects(
    () => client.complete({ code: "authorization-code", codeVerifier: "pkce-verifier" }),
    { code: "oauth_email_unverified" },
  );
});
