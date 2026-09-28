import assert from "node:assert/strict";
import test from "node:test";

import { Check } from "../dist/index.js";
import {
  PublicSecretBindingSummarySchema,
  SecretBindingOwnerKindSchema,
  SecretBindingSchema,
  SecretBindingStateSchema,
  SecretSourceSchema,
} from "../dist/secret-bindings.js";

const pendingBinding = {
  secretBindingId: "secret-binding-1",
  workspaceId: "workspace-team",
  scopeId: "scope-alice",
  ownerKind: "connection",
  ownerId: "connection-lark",
  secretSource: "cloud_secret_store",
  storeBindingRef: "store-binding-lark-v1",
  storeBindingRevision: 1,
  credentialFingerprint:
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  status: "pending",
  createdBy: "user-alice",
  createdAt: "2026-08-05T01:00:00.000Z",
};

const activeBinding = {
  ...pendingBinding,
  status: "active",
  probedAt: "2026-08-05T01:01:00.000Z",
};

const publicActiveSummary = {
  secretBindingId: activeBinding.secretBindingId,
  workspaceId: activeBinding.workspaceId,
  scopeId: activeBinding.scopeId,
  ownerKind: activeBinding.ownerKind,
  ownerId: activeBinding.ownerId,
  secretSource: activeBinding.secretSource,
  storeBindingRevision: activeBinding.storeBindingRevision,
  status: activeBinding.status,
  createdBy: activeBinding.createdBy,
  createdAt: activeBinding.createdAt,
  probedAt: activeBinding.probedAt,
};

test("secret binding enums are closed and a binding selects exactly one source", () => {
  for (const source of ["cloud_secret_store", "desktop_keychain"]) {
    assert.equal(Check(SecretSourceSchema, source), true);
  }
  assert.equal(Check(SecretSourceSchema, "environment"), false);
  assert.equal(
    Check(SecretSourceSchema, ["cloud_secret_store", "desktop_keychain"]),
    false,
    "a binding cannot probe or select multiple stores",
  );

  for (const ownerKind of ["connection", "model_profile_revision", "automation"]) {
    assert.equal(Check(SecretBindingOwnerKindSchema, ownerKind), true);
  }
  assert.equal(
    Check(SecretBindingOwnerKindSchema, "model_profile"),
    false,
    "a mutable model profile cannot own a pinned secret binding",
  );
  for (const status of ["pending", "active", "expired", "revoked", "invalid"]) {
    assert.equal(Check(SecretBindingStateSchema, status), true);
  }
});

test("durable bindings require internal metadata and active bindings require a probe", () => {
  assert.equal(Check(SecretBindingSchema, pendingBinding), true);
  assert.equal(Check(SecretBindingSchema, activeBinding), true);

  const { probedAt: _probedAt, ...activeWithoutProbe } = activeBinding;
  assert.equal(Check(SecretBindingSchema, activeWithoutProbe), false);
  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    storeBindingRevision: 0,
  }), false);
  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    secretValue: "must-not-be-stored",
  }), false, "durable metadata cannot contain a secret value");
});

test("secret binding lifecycle timestamps are state-specific", () => {
  assert.equal(Check(SecretBindingSchema, {
    ...activeBinding,
    revokedAt: "2026-08-05T01:02:00.000Z",
  }), false, "active cannot also be revoked");

  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    status: "revoked",
  }), false, "revoked requires revokedAt");
  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    status: "revoked",
    revokedAt: "2026-08-05T01:02:00.000Z",
  }), true);

  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    status: "expired",
  }), false, "expired requires expiresAt");
  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    status: "expired",
    expiresAt: "2026-08-05T01:02:00.000Z",
  }), true);

  assert.equal(Check(SecretBindingSchema, {
    ...pendingBinding,
    probedAt: "2026-08-05T01:01:00.000Z",
  }), false, "pending cannot claim a completed probe");
});

test("public summaries expose selection metadata without internal locators or fingerprints", () => {
  assert.equal(Check(PublicSecretBindingSummarySchema, publicActiveSummary), true);

  for (const internalField of [
    ["storeBindingRef", activeBinding.storeBindingRef],
    ["credentialFingerprint", activeBinding.credentialFingerprint],
    ["secret", "must-not-leak"],
    ["secretValue", "must-not-leak"],
  ]) {
    assert.equal(Check(PublicSecretBindingSummarySchema, {
      ...publicActiveSummary,
      [internalField[0]]: internalField[1],
    }), false, `public summary rejects ${internalField[0]}`);
  }

  const { probedAt: _probedAt, ...activeWithoutProbe } = publicActiveSummary;
  assert.equal(Check(PublicSecretBindingSummarySchema, activeWithoutProbe), false);

  assert.equal(Check(PublicSecretBindingSummarySchema, {
    ...publicActiveSummary,
    revokedAt: "2026-08-05T01:02:00.000Z",
  }), false, "public state semantics match the durable record");
  const { probedAt: _publicProbe, ...publicWithoutProbe } = publicActiveSummary;
  assert.equal(Check(PublicSecretBindingSummarySchema, {
    ...publicWithoutProbe,
    status: "revoked",
  }), false, "public revoked summaries also require revokedAt");
  assert.equal(Check(PublicSecretBindingSummarySchema, {
    ...publicWithoutProbe,
    status: "expired",
  }), false, "public expired summaries also require expiresAt");
});
