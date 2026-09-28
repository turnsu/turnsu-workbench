import assert from "node:assert/strict";
import test from "node:test";

import {
  createInvitationIdentityComposition,
  readSecretFile,
} from "../../src/auth/invitation-identity-composition.mjs";

const enabledEnvironment = Object.freeze({
  WORKBENCH_IDENTITY_ENABLED: "true",
  WORKBENCH_PUBLIC_ORIGIN: "https://app.example.test",
  WORKBENCH_IDENTITY_SIGNING_SECRET_FILE: "/run/secrets/identity-signing",
  WORKBENCH_SMTP_HOST: "smtp.example.test",
  WORKBENCH_SMTP_PORT: "465",
  WORKBENCH_SMTP_USERNAME: "smtp-user",
  WORKBENCH_SMTP_PASSWORD_FILE: "/run/secrets/smtp-password",
  WORKBENCH_SMTP_FROM: "workspace@example.test",
  WORKBENCH_SMTP_TLS_MODE: "implicit-tls",
  WORKBENCH_GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  WORKBENCH_GOOGLE_OAUTH_CLIENT_SECRET_FILE: "/run/secrets/google-oauth",
  WORKBENCH_GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  WORKBENCH_GITHUB_OAUTH_CLIENT_SECRET_FILE: "/run/secrets/github-oauth",
});

const secretValues = Object.freeze({
  "/run/secrets/identity-signing": "identity-signing-secret-with-at-least-32-bytes",
  "/run/secrets/smtp-password": "smtp-password",
  "/run/secrets/google-oauth": "google-client-secret",
  "/run/secrets/github-oauth": "github-client-secret",
});

test("disabled identity composition preserves a string public origin and touches no secret", async () => {
  let reads = 0;
  const composition = await createInvitationIdentityComposition({
    env: {
      WORKBENCH_IDENTITY_ENABLED: "false",
      WORKBENCH_PUBLIC_ORIGIN: "https://app.example.test",
    },
    readSecret: async () => { reads += 1; },
  });

  assert.equal(composition.publicOrigin, "https://app.example.test");
  assert.equal(composition.invitationTokenSigner, null);
  assert.equal(composition.invitationMailer, null);
  assert.equal(composition.invitationBaseUrl, null);
  assert.deepEqual(composition.oauthProviders, {});
  assert.equal(reads, 0);
});

test("production composition wires SMTP plus Google and GitHub OAuth from secret references", async () => {
  const reads = [];
  let fetches = 0;
  const composition = await createInvitationIdentityComposition({
    env: enabledEnvironment,
    readSecret: async (reference) => {
      reads.push(reference);
      return secretValues[reference];
    },
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("authorization URL generation must not call a provider");
    },
  });

  assert.equal(composition.publicOrigin, "https://app.example.test");
  assert.equal(composition.invitationBaseUrl, "https://app.example.test");
  assert.equal(typeof composition.invitationMailer.sendWorkspaceInvitation, "function");
  assert.deepEqual(Object.keys(composition.oauthProviders).sort(), ["github", "google"]);
  assert.deepEqual(reads.sort(), Object.keys(secretValues).sort());

  const expiresAt = "2026-08-12T12:00:00.000Z";
  const invitation = composition.invitationTokenSigner.invitationToken({
    invitationId: "invitation-1",
    expiresAt,
  });
  assert.equal(composition.invitationTokenSigner.verifyInvitationToken({
    token: invitation,
    invitationId: "invitation-1",
    expiresAt,
  }), true);

  const oauthInput = {
    state: "state-1",
    codeVerifier: "pkce-verifier-with-sufficient-entropy-0123456789",
    nonce: "nonce-1",
  };
  const google = new URL(await composition.oauthProviders.google.authorizationUrl(oauthInput));
  const github = new URL(await composition.oauthProviders.github.authorizationUrl(oauthInput));
  assert.equal(google.searchParams.get("client_id"), "google-client-id");
  assert.equal(
    google.searchParams.get("redirect_uri"),
    "https://app.example.test/api/workbench/v1/auth/oauth/google/callback",
  );
  assert.equal(google.searchParams.get("code_challenge_method"), "S256");
  assert.equal(google.searchParams.get("nonce"), "nonce-1");
  assert.equal(github.searchParams.get("client_id"), "github-client-id");
  assert.equal(
    github.searchParams.get("redirect_uri"),
    "https://app.example.test/api/workbench/v1/auth/oauth/github/callback",
  );
  assert.equal(github.searchParams.get("code_challenge_method"), "S256");
  assert.equal(fetches, 0);

  const exposed = JSON.stringify(composition);
  for (const value of Object.values(secretValues)) assert.doesNotMatch(exposed, new RegExp(value));
});

test("enabled identity fails closed before reading secrets when deployment metadata is incomplete", async () => {
  let reads = 0;
  await assert.rejects(
    () => createInvitationIdentityComposition({
      env: { ...enabledEnvironment, WORKBENCH_PUBLIC_ORIGIN: "http://app.example.test" },
      readSecret: async () => { reads += 1; },
    }),
    { message: "identity_public_https_origin_required" },
  );
  await assert.rejects(
    () => createInvitationIdentityComposition({
      env: { ...enabledEnvironment, WORKBENCH_GITHUB_OAUTH_CLIENT_ID: "" },
      readSecret: async () => { reads += 1; },
    }),
    { message: "github_oauth_client_id_required" },
  );
  assert.equal(reads, 0);
});

test("default secret-file reader rejects relative paths", async () => {
  await assert.rejects(
    () => readSecretFile("relative/identity-secret"),
    { message: "identity_secret_file_absolute_path_required" },
  );
});
