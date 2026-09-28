import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { ProductPostgresStore } from "../../src/store/postgres/index.mjs";

const integrationEnabled = process.env.WORKBENCH_POSTGRES_INTEGRATION === "1";
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const now = () => new Date();

test("PostgreSQL invitation activation keeps token secrets out of durable records and atomically creates one personal scope", {
  skip: integrationEnabled ? false : "set WORKBENCH_POSTGRES_INTEGRATION=1 explicitly",
}, async (t) => {
  const connectionString = requiredEnvironment("WORKBENCH_POSTGRES_URL");
  assert.match(decodeURIComponent(new URL(connectionString).pathname.slice(1)), /_test$/);
  const pool = new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5_000 });
  const ids = new Map();
  const idFactory = (kind) => {
    const sequence = (ids.get(kind) ?? 0) + 1;
    ids.set(kind, sequence);
    return `${kind}-${sequence}`;
  };
  const store = new ProductPostgresStore({ pool });
  const auth = store.createAuthPersistence({ clock: now, idFactory });
  t.after(async () => {
    await store.close();
    await pool.end();
  });
  await store.runMigrations();
  await auth.ensureWorkspace({
    workspaceId: "invite-workspace",
    workspaceName: "Invitation workspace",
  });

  const owner = await auth.registerAuthAccount({
    username: "owner",
    usernameNormalized: "owner",
    passwordHash: "$2b$12$yW6McEk2Trkg.gFfiQkeMuAY.FtqTkbbJ3gqHQIsLVxNlAPAmrNCS",
    role: "admin",
    workspaceId: "invite-workspace",
    workspaceName: "Invitation workspace",
    idempotencyKey: "register-owner",
    requestFingerprint: { username: "owner", role: "admin" },
  });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  const rawInvitationToken = "raw-invitation-token-must-not-persist";
  const invitation = await auth.createWorkspaceInvitation({
    requestedBy: owner.user.userId,
    workspaceId: owner.workspaceId,
    invitationId: "invitation-member",
    invitedEmail: "Member@Example.Test",
    tokenHash: hash(rawInvitationToken),
    expiresAt,
    idempotencyKey: "create-invitation-member",
  });
  assert.equal(invitation.invitation.status, "pending");
  const rawRecords = await pool.query(`
    SELECT invitation.token_hash, invitation.payload, outbox.payload
      FROM public.workspace_invitations invitation
      JOIN public.email_outbox outbox ON outbox.invitation_id = invitation.invitation_id
     WHERE invitation.invitation_id = 'invitation-member'
  `);
  assert.equal(rawRecords.rowCount, 1);
  assert.equal(rawRecords.rows[0].token_hash, hash(rawInvitationToken));
  assert.equal(JSON.stringify(rawRecords.rows[0]).includes(rawInvitationToken), false);

  let delivery = await auth.claimNextInvitationDelivery();
  assert.equal(delivery.invitationId, "invitation-member");
  assert.equal("token" in delivery, false);
  const failedAttempt = delivery.attemptNumber;
  assert.deepEqual(await auth.recordInvitationDeliveryFailure({ outboxId: delivery.outboxId,
    attemptNumber: failedAttempt, errorCode: "smtp_unavailable", retryAt: new Date().toISOString() }),
  { recorded: true, retryScheduled: true });
  const failureReceipt = (await pool.query("SELECT payload->>'code' AS code FROM email_delivery_receipts WHERE outbox_id=$1 AND status='failed'", [delivery.outboxId])).rows[0];
  assert.equal(failureReceipt.code, "smtp_unavailable");
  delivery = await auth.claimNextInvitationDelivery();
  assert.equal(delivery.attemptNumber, failedAttempt + 1);
  assert.deepEqual(await auth.recordInvitationDelivery({ outboxId: delivery.outboxId, attemptNumber: failedAttempt }), { delivered: false });
  assert.equal((await auth.recordInvitationDelivery({
    outboxId: delivery.outboxId,
    attemptNumber: delivery.attemptNumber,
    providerReceiptId: "smtp-receipt-1",
  })).delivered, true);

  const state = "signed-oauth-state-not-persisted";
  await auth.createOAuthLoginTransaction({
    transactionId: "oauth-member",
    invitationId: "invitation-member",
    provider: "google",
    stateHash: hash(state),
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  });
  const activation = await auth.activateOAuthInvitation({
    transactionId: "oauth-member",
    provider: "google",
    stateHash: hash(state),
    providerSubject: "google-subject-member",
    verifiedEmail: "member@example.test",
    newUserId: "user-member",
    newUsername: "member-activate",
  });
  assert.equal(activation.workspaceId, "invite-workspace");
  assert.equal(activation.user.username, "member-activate");
  assert.equal((await auth.activateOAuthInvitation({
    transactionId: "oauth-member",
    provider: "google",
    stateHash: hash(state),
    providerSubject: "ignored-on-replay",
    verifiedEmail: "ignored@example.test",
    newUserId: "user-ignored",
    newUsername: "member-ignored",
  })).user.userId, "user-member");

  const activated = await pool.query(`
    SELECT invitation.status AS invitation_status, invitation.accepted_by_user_id,
           identity.verified_email_normalized, member.membership_id, member.payload AS membership_payload,
           principal.payload AS principal_payload, scope.payload AS scope_payload,
           policy.observation_tier, user_account.password_hash
      FROM public.workspace_invitations invitation
      JOIN public.external_identities identity
        ON identity.provider = 'google' AND identity.provider_subject = 'google-subject-member'
      JOIN public.product_users user_account ON user_account.user_id = identity.user_id
      JOIN public.workspace_memberships member
        ON member.workspace_id = invitation.workspace_id AND member.user_id = identity.user_id
      JOIN public.workspace_principals principal
        ON principal.workspace_id = member.workspace_id AND principal.membership_id = member.membership_id
      JOIN public.product_scopes scope
        ON scope.workspace_id = member.workspace_id AND scope.owner_user_id = member.user_id
      JOIN public.scope_policy_revisions policy
        ON policy.workspace_id = scope.workspace_id AND policy.scope_id = scope.scope_id
       AND policy.policy_revision_id = scope.current_policy_revision_id
     WHERE invitation.invitation_id = 'invitation-member'
  `);
  assert.equal(activated.rowCount, 1);
  const row = activated.rows[0];
  assert.equal(row.invitation_status, "accepted");
  assert.equal(row.accepted_by_user_id, "user-member");
  assert.equal(row.verified_email_normalized, "member@example.test");
  assert.equal(row.password_hash, null);
  assert.equal(row.observation_tier, "workspace_readable");
  assert.deepEqual(row.membership_payload.membership_activation, {
    invitation_id: "invitation-member",
    membership_id: row.membership_id,
    actor_user_id: "user-member",
    authorizer_user_id: owner.user.userId,
  });
  assert.deepEqual(row.principal_payload.membership_activation, row.membership_payload.membership_activation);
  assert.deepEqual(row.scope_payload.membership_activation, row.membership_payload.membership_activation);

  const secondExpiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
  await auth.createWorkspaceInvitation({
    requestedBy: owner.user.userId,
    workspaceId: owner.workspaceId,
    invitationId: "invitation-mismatch",
    invitedEmail: "other@example.test",
    tokenHash: hash("other-token"),
    expiresAt: secondExpiry,
    idempotencyKey: "create-invitation-mismatch",
  });
  await auth.createOAuthLoginTransaction({
    transactionId: "oauth-mismatch",
    invitationId: "invitation-mismatch",
    provider: "github",
    stateHash: hash("state-mismatch"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  });
  await assert.rejects(
    () => auth.activateOAuthInvitation({
      transactionId: "oauth-mismatch",
      provider: "github",
      stateHash: hash("state-mismatch"),
      providerSubject: "github-subject-member",
      verifiedEmail: "wrong@example.test",
      newUserId: "user-wrong",
      newUsername: "member-wrong",
    }),
    { code: "invitation_email_mismatch" },
  );

  await auth.createWorkspaceInvitation({
    requestedBy: owner.user.userId,
    workspaceId: owner.workspaceId,
    invitationId: "invitation-existing-account",
    invitedEmail: "member@example.test",
    tokenHash: hash("existing-account-token"),
    expiresAt: secondExpiry,
    idempotencyKey: "create-invitation-existing-account",
  });
  await auth.createOAuthLoginTransaction({
    transactionId: "oauth-existing-account",
    invitationId: "invitation-existing-account",
    provider: "google",
    stateHash: hash("state-existing-account"),
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  });
  await assert.rejects(
    () => auth.activateOAuthInvitation({
      transactionId: "oauth-existing-account",
      provider: "google",
      stateHash: hash("state-existing-account"),
      providerSubject: "google-subject-member",
      verifiedEmail: "member@example.test",
      newUserId: "user-shadow",
      newUsername: "member-shadow",
    }),
    { code: "oauth_identity_binding_required" },
  );
});

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  return value;
}
