import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertNativeRedirectUri,
  verifyCodeChallenge,
} from "../../src/auth/native-client-crypto.mjs";

const verifier = "A".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");

test("native client PKCE accepts only the exact verifier and challenge", () => {
  assert.doesNotThrow(() => verifyCodeChallenge({ codeVerifier: verifier, codeChallenge: challenge }));
  assert.throws(
    () => verifyCodeChallenge({ codeVerifier: `${verifier.slice(0, -1)}B`, codeChallenge: challenge }),
    { code: "native_pkce_verification_failed" },
  );
});

test("native redirects are constrained to loopback or explicit origins", () => {
  assert.equal(
    assertNativeRedirectUri("http://127.0.0.1:41853/callback"),
    "http://127.0.0.1:41853/callback",
  );
  assert.equal(
    assertNativeRedirectUri("https://app.example.test/native/callback", {
      allowedOrigins: ["https://app.example.test"],
    }),
    "https://app.example.test/native/callback",
  );
  assert.throws(
    () => assertNativeRedirectUri("https://attacker.example.test/callback"),
    { code: "native_redirect_uri_invalid" },
  );
  assert.throws(
    () => assertNativeRedirectUri("https://attacker.example.test/callback", {
      allowedOrigins: ["https://app.example.test"],
    }),
    { code: "native_redirect_uri_invalid" },
  );
});
