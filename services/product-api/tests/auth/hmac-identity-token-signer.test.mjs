import assert from "node:assert/strict";
import test from "node:test";

import { HmacIdentityTokenSigner } from "../../src/auth/hmac-identity-token-signer.mjs";

const signer = () => new HmacIdentityTokenSigner({ secret: "0123456789abcdef0123456789abcdef" });

test("identity signer keeps invitation and OAuth raw values reconstructible but not interchangeable", () => {
  const value = signer();
  const expiresAt = "2026-08-12T00:00:00.000Z";
  const invitation = value.invitationToken({ invitationId: "invitation-a", expiresAt });
  const state = value.oauthState({ transactionId: "oauth-a", provider: "google", expiresAt });

  assert.equal(value.parseInvitationToken(invitation), "invitation-a");
  assert.equal(value.parseOAuthState(state, { provider: "google" }), "oauth-a");
  assert.equal(value.parseOAuthState(state, { provider: "github" }), null);
  assert.equal(value.verifyInvitationToken({ token: invitation, invitationId: "invitation-a", expiresAt }), true);
  assert.equal(value.verifyInvitationToken({ token: invitation, invitationId: "invitation-b", expiresAt }), false);
  assert.equal(value.verifyOAuthState({ state, transactionId: "oauth-a", provider: "google", expiresAt }), true);
  assert.equal(value.verifyOAuthState({ state, transactionId: "oauth-a", provider: "google", expiresAt: "2026-08-13T00:00:00.000Z" }), false);
  assert.match(value.tokenHash(invitation), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(value.oauthCodeVerifier({ transactionId: "oauth-a" }), value.oauthNonce({ transactionId: "oauth-a" }));
});

test("identity signer refuses insufficient signing material", () => {
  assert.throws(
    () => new HmacIdentityTokenSigner({ secret: "short" }),
    /identity_token_signing_secret_required/,
  );
});
