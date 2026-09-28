import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("cloud Product composition never imports or infers a macOS Keychain model resolver", async () => {
  const source = await readFile(new URL("../../src/server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /keychain-credential-resolver/);
  assert.doesNotMatch(source, /WORKBENCH_MODEL_KEYCHAIN_SERVICE/);
  assert.match(source, /const productCredentialResolver = credentialResolver \?\? null/);
});

test("production server composition owns invitation, SMTP and OAuth ports explicitly", async () => {
  const source = await readFile(new URL("../../src/production-composition.mjs", import.meta.url), "utf8");
  assert.match(source, /createInvitationIdentityComposition/);
  assert.match(source, /invitationTokenSigner: identity\.invitationTokenSigner/);
  assert.match(source, /invitationMailer: identity\.invitationMailer/);
  assert.match(source, /oauthProviders: identity\.oauthProviders/);
  assert.doesNotMatch(source, /WORKBENCH_(?:SMTP_PASSWORD|GOOGLE_OAUTH_CLIENT_SECRET|GITHUB_OAUTH_CLIENT_SECRET)\b/);
});
