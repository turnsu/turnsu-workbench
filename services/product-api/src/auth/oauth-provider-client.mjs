import {
  createPublicKey,
  createVerify,
  timingSafeEqual,
} from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";

const required = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
  return value;
};

const normaliseEmail = (value) => {
  if (typeof value !== "string") throw new ProductStoreError("oauth_email_unverified", "The identity provider did not verify an email address.");
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ProductStoreError("oauth_email_unverified", "The identity provider did not verify an email address.");
  }
  return email;
};

const code = (value, fallback) => {
  const candidate = String(value?.code ?? "");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(candidate) ? candidate : fallback;
};

const providerFailure = (fallback, message) => (error) => {
  if (error instanceof ProductStoreError) throw error;
  throw new ProductStoreError(code(error, fallback), message);
};

const constantTimeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const sha256Base64Url = async (value) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
};

async function requestJson(fetchImpl, url, options, failureCode) {
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    return providerFailure("oauth_provider_unavailable", "The identity provider is unavailable.")(error);
  }
  if (!response?.ok) {
    throw new ProductStoreError(failureCode, "The identity provider rejected the request.");
  }
  try {
    return await response.json();
  } catch (error) {
    return providerFailure("oauth_provider_response_invalid", "The identity provider returned an invalid response.")(error);
  }
}

const parseJwt = (token) => {
  if (typeof token !== "string") throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  try {
    return {
      signed: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    };
  } catch {
    throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  }
};

const googleAudienceMatches = (audience, clientId, azp) => (
  audience === clientId
  || (Array.isArray(audience) && audience.length === 1 && audience[0] === clientId && azp === clientId)
);

export async function verifyGoogleIdentityToken({
  token,
  clientId,
  nonce,
  fetchImpl = globalThis.fetch,
  jwksUrl = GOOGLE_JWKS_URL,
  clock = () => new Date(),
} = {}) {
  required(clientId, "google_oauth_client_id_required");
  required(nonce, "oauth_nonce_required");
  if (typeof fetchImpl !== "function") throw new TypeError("oauth_fetch_required");
  const parsed = parseJwt(token);
  if (parsed.header?.alg !== "RS256" || typeof parsed.header?.kid !== "string") {
    throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  }
  const jwks = await requestJson(fetchImpl, jwksUrl, { headers: { Accept: "application/json" } }, "oauth_provider_response_invalid");
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((candidate) => candidate?.kid === parsed.header.kid && candidate?.kty === "RSA")
    : null;
  if (!jwk || (jwk.use !== undefined && jwk.use !== "sig") || (jwk.alg !== undefined && jwk.alg !== "RS256")) {
    throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  }
  let verified = false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(parsed.signed);
    verifier.end();
    verified = verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), parsed.signature);
  } catch {
    verified = false;
  }
  if (!verified) throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");

  const now = Math.floor(new Date(clock()).getTime() / 1000);
  const payload = parsed.payload;
  if (!GOOGLE_ISSUERS.has(payload?.iss)
    || !googleAudienceMatches(payload?.aud, clientId, payload?.azp)
    || !Number.isFinite(payload?.exp) || payload.exp <= now
    || !Number.isFinite(payload?.iat) || payload.iat > now + 300
    || !constantTimeEqual(payload?.nonce, nonce)
    || payload?.email_verified !== true
    || typeof payload?.sub !== "string" || payload.sub.length === 0) {
    throw new ProductStoreError("oauth_identity_token_invalid", "The identity provider returned an invalid identity token.");
  }
  return Object.freeze({
    provider: "google",
    providerSubject: payload.sub,
    verifiedEmail: normaliseEmail(payload.email),
  });
}

export class GoogleOAuthClient {
  #clientId;
  #clientSecret;
  #redirectUri;
  #fetch;
  #jwksUrl;
  #clock;

  constructor({ clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch, jwksUrl = GOOGLE_JWKS_URL, clock = () => new Date() } = {}) {
    this.#clientId = required(clientId, "google_oauth_client_id_required");
    this.#clientSecret = required(clientSecret, "google_oauth_client_secret_required");
    this.#redirectUri = required(redirectUri, "google_oauth_redirect_uri_required");
    if (typeof fetchImpl !== "function") throw new TypeError("oauth_fetch_required");
    this.#fetch = fetchImpl;
    this.#jwksUrl = jwksUrl;
    this.#clock = clock;
  }

  async authorizationUrl({ state, codeVerifier, nonce } = {}) {
    required(state, "oauth_state_required");
    required(codeVerifier, "oauth_code_verifier_required");
    required(nonce, "oauth_nonce_required");
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      scope: "openid email",
      state,
      nonce,
      code_challenge: await sha256Base64Url(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async complete({ code: authorizationCode, codeVerifier, nonce } = {}) {
    required(authorizationCode, "oauth_authorization_code_required");
    required(codeVerifier, "oauth_code_verifier_required");
    required(nonce, "oauth_nonce_required");
    const response = await requestJson(this.#fetch, GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        code: authorizationCode,
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        redirect_uri: this.#redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }),
    }, "oauth_provider_rejected");
    return verifyGoogleIdentityToken({
      token: response?.id_token,
      clientId: this.#clientId,
      nonce,
      fetchImpl: this.#fetch,
      jwksUrl: this.#jwksUrl,
      clock: this.#clock,
    });
  }
}

export class GitHubOAuthClient {
  #clientId;
  #clientSecret;
  #redirectUri;
  #fetch;

  constructor({ clientId, clientSecret, redirectUri, fetchImpl = globalThis.fetch } = {}) {
    this.#clientId = required(clientId, "github_oauth_client_id_required");
    this.#clientSecret = required(clientSecret, "github_oauth_client_secret_required");
    this.#redirectUri = required(redirectUri, "github_oauth_redirect_uri_required");
    if (typeof fetchImpl !== "function") throw new TypeError("oauth_fetch_required");
    this.#fetch = fetchImpl;
  }

  async authorizationUrl({ state, codeVerifier } = {}) {
    required(state, "oauth_state_required");
    required(codeVerifier, "oauth_code_verifier_required");
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: this.#clientId,
      redirect_uri: this.#redirectUri,
      scope: "user:email",
      state,
      code_challenge: await sha256Base64Url(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async complete({ code: authorizationCode, codeVerifier } = {}) {
    required(authorizationCode, "oauth_authorization_code_required");
    required(codeVerifier, "oauth_code_verifier_required");
    const token = await requestJson(this.#fetch, GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code: authorizationCode,
        redirect_uri: this.#redirectUri,
        code_verifier: codeVerifier,
      }),
    }, "oauth_provider_rejected");
    if (typeof token?.access_token !== "string" || token.access_token.length === 0) {
      throw new ProductStoreError("oauth_provider_response_invalid", "The identity provider returned an invalid response.");
    }
    const headers = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const [profile, emails] = await Promise.all([
      requestJson(this.#fetch, GITHUB_USER_URL, { headers }, "oauth_provider_rejected"),
      requestJson(this.#fetch, GITHUB_EMAILS_URL, { headers }, "oauth_provider_rejected"),
    ]);
    if ((typeof profile?.id !== "number" && typeof profile?.id !== "string") || String(profile.id).length === 0) {
      throw new ProductStoreError("oauth_provider_response_invalid", "The identity provider returned an invalid response.");
    }
    const verified = Array.isArray(emails)
      ? emails.find((entry) => entry?.verified === true && entry?.primary === true)
        ?? emails.find((entry) => entry?.verified === true)
      : null;
    return Object.freeze({
      provider: "github",
      providerSubject: String(profile.id),
      verifiedEmail: normaliseEmail(verified?.email),
    });
  }
}
