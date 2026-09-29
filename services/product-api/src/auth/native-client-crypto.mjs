import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/u;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const DEVICE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43,256}$/u;

const base64UrlHash = (value) => createHash("sha256").update(value).digest("base64url");

export const hashNativeToken = (value) => {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new ProductStoreError("native_token_invalid", "The native credential is invalid.");
  }
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
};

export const issueNativeSecret = () => randomBytes(32).toString("base64url");

export const verifyCodeChallenge = ({ codeVerifier, codeChallenge } = {}) => {
  if (typeof codeVerifier !== "string" || !CODE_VERIFIER_PATTERN.test(codeVerifier)
    || typeof codeChallenge !== "string" || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw new ProductStoreError("native_authorization_invalid", "The native authorization proof is invalid.");
  }
  const expected = Buffer.from(base64UrlHash(codeVerifier));
  const actual = Buffer.from(codeChallenge);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ProductStoreError("native_pkce_verification_failed", "The native authorization proof is invalid.");
  }
};

export const assertNativeDevicePublicKey = (value) => {
  if (typeof value !== "string" || !DEVICE_PUBLIC_KEY_PATTERN.test(value)) {
    throw new ProductStoreError("native_device_key_invalid", "The native device proof is invalid.");
  }
  return value;
};

export const assertNativeRedirectUri = (value, { allowedOrigins = [] } = {}) => {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new ProductStoreError("native_redirect_uri_invalid", "The native redirect URI is invalid.");
  }
  let url;
  try { url = new URL(value); }
  catch { throw new ProductStoreError("native_redirect_uri_invalid", "The native redirect URI is invalid."); }
  if (url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) {
    throw new ProductStoreError("native_redirect_uri_invalid", "The native redirect URI is invalid.");
  }
  if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new ProductStoreError("native_redirect_uri_invalid", "The native redirect URI is invalid.");
  }
  const origin = url.origin;
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!loopback && !allowedOrigins.includes(origin)) {
    throw new ProductStoreError("native_redirect_uri_invalid", "The native redirect URI is not allowed.");
  }
  return url.toString();
};
