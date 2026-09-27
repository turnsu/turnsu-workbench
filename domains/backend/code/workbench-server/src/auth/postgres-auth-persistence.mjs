import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";

const roleRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

const required = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new ProductStoreError(code, code);
  return value;
};

const timestamp = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_auth_clock_invalid");
  return date.toISOString();
};

const accountFromRow = (row) => row ? ({
  userId: row.user_id,
  displayName: row.display_name,
  username: row.username,
  usernameNormalized: row.username_normalized,
  passwordHash: row.password_hash,
  role: row.account_role,
  disabled: row.disabled === true,
  bootstrapAdminClaim: row.bootstrap_admin_claim === true,
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
}) : null;

const publicAccount = (account) => account ? ({
  userId: account.userId,
  displayName: account.displayName,
  username: account.username,
  usernameNormalized: account.usernameNormalized,
  role: account.role,
  disabled: account.disabled === true,
  bootstrapAdminClaim: account.bootstrapAdminClaim === true,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
}) : null;

const receiptScope = (kind, identity) => {
  const value = String(identity);
  const suffix = /^[A-Za-z0-9:_-]{1,200}$/u.test(value)
    ? value
    : `sha256-${createHash("sha256").update(value).digest("hex")}`;
  return `${kind}:${suffix}`;
};

const normalizedEmail = (value) => {
  if (typeof value !== "string") throw new ProductStoreError("invitation_email_invalid", "A valid invitation email is required.");
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new ProductStoreError("invitation_email_invalid", "A valid invitation email is required.");
  }
  return email;
};

const tokenHash = (value, code = "identity_token_hash_invalid") => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ProductStoreError(code, code);
  }
  return value;
};

const invitationFromRow = (row) => row ? ({
  invitationId: row.invitation_id,
  workspaceId: row.workspace_id,
  email: row.invited_email_normalized,
  role: row.membership_role,
  status: row.status,
  expiresAt: timestamp(row.expires_at),
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
  ...(row.delivery_status ? { deliveryStatus: row.delivery_status } : {}),
}) : null;

const privateInvitationFromRow = (row) => row ? ({
  ...invitationFromRow(row),
  tokenHash: row.token_hash,
  createdByUserId: row.created_by_user_id,
  authorizerMembershipId: row.authorizer_membership_id,
  acceptedByUserId: row.accepted_by_user_id ?? null,
}) : null;

const oauthTransactionFromRow = (row) => row ? ({
  transactionId: row.oauth_transaction_id,
  invitationId: row.invitation_id,
  provider: row.provider,
  stateHash: row.state_hash,
  initiatedByUserId: row.initiated_by_user_id ?? null,
  bindExistingAccount: row.bind_existing_account === true,
  createdAt: timestamp(row.created_at),
  expiresAt: timestamp(row.expires_at),
  completedAt: row.completed_at ? timestamp(row.completed_at) : null,
  completedUserId: row.completed_user_id ?? null,
  response: row.response ?? null,
}) : null;

/**
 * Product-owned PostgreSQL authentication port. It deliberately has named
 * account and membership operations instead of exposing user/session tables
 * as an ersatz repository layer.
 */
export class PostgresAuthPersistence {
  #store;
  #sql;
  #clock;
  #idFactory;

  constructor({
    store,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.connect || !store?.withTransaction || !store?.bindAdapter) {
      throw new TypeError("postgres_auth_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_auth_clock_and_id_factory_required");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async connect() {
    await this.#store.connect();
    return this;
  }

  // Startup only establishes the tenant container. It does not manufacture a
  // member, a personal Scope, or a catalog grant before a real principal has
  // registered through the governed Auth flow.
  async ensureWorkspace({ workspaceId = "workspace-local", workspaceName = "Team workspace" } = {}) {
    required(workspaceId, "workspace_id_required");
    required(workspaceName, "workspace_name_required");
    await this.connect();
    const now = this.#now();
    return this.#transaction(async (query) => {
      await query(`
        INSERT INTO public.product_workspaces (
          workspace_id, schema_version, name, created_by, created_at, updated_at, payload
        ) VALUES ($1, 'workbench-v1', $2, 'system-bootstrap', $3::timestamptz, $3::timestamptz, '{}'::jsonb)
        ON CONFLICT (workspace_id) DO NOTHING
      `, [workspaceId, workspaceName, now]);
      const row = (await query(`
        SELECT workspace_id, schema_version, name, created_by, created_at, updated_at
          FROM public.product_workspaces WHERE workspace_id = $1
      `, [workspaceId])).rows[0];
      if (!row) throw new ProductStoreError("workspace_bootstrap_failed", "The workspace could not be initialized.");
      return {
        schemaVersion: row.schema_version,
        workspaceId: row.workspace_id,
        name: row.name,
        createdBy: row.created_by,
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      };
    });
  }

  async getBootstrapAdmin() {
    return this.#readAccount(`WHERE bootstrap_admin_claim = true`);
  }

  async getAuthAccount(userId) {
    required(userId, "user_id_required");
    return this.#readAccount(`WHERE user_id = $1`, [userId]);
  }

  async getAuthAccountByUsername(usernameNormalized) {
    required(usernameNormalized, "username_required");
    return this.#readAccount(`WHERE username_normalized = $1`, [usernameNormalized]);
  }

  async authorizeWorkspace({ userId, workspaceId, minimumRole = "viewer" } = {}) {
    required(userId, "user_id_required");
    required(workspaceId, "workspace_id_required");
    if (!Object.hasOwn(roleRank, minimumRole)) {
      throw new ProductStoreError("workspace_role_invalid", "The required workspace role is invalid.");
    }
    await this.connect();
    return this.#transaction(async (query) => {
      const row = (await query(`
        SELECT membership.membership_id, membership.workspace_id, membership.user_id,
               membership.role, membership.status, membership.revision,
               membership.created_at, membership.updated_at
          FROM public.workspace_memberships membership
          JOIN public.product_users user_account ON user_account.user_id = membership.user_id
         WHERE membership.workspace_id = $1
           AND membership.user_id = $2
           AND membership.status = 'active'
           AND user_account.disabled = false
      `, [workspaceId, userId])).rows[0];
      if (!row) throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
      if ((roleRank[row.role] ?? -1) < roleRank[minimumRole]) {
        throw new ProductStoreError("workspace_role_forbidden", "Your workspace role cannot perform this action.");
      }
      return {
        membershipId: row.membership_id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        role: row.role,
        status: row.status,
        revision: Number(row.revision),
        createdAt: timestamp(row.created_at),
        updatedAt: timestamp(row.updated_at),
      };
    });
  }

  async registerAuthAccount({
    username,
    usernameNormalized,
    passwordHash,
    role,
    workspaceId = "workspace-local",
    workspaceName = "Team workspace",
    idempotencyKey,
    requestFingerprint,
  } = {}) {
    required(username, "username_required");
    required(usernameNormalized, "username_required");
    required(passwordHash, "password_hash_required");
    required(workspaceId, "workspace_id_required");
    required(idempotencyKey, "idempotency_key_required");
    if (!['admin', 'member'].includes(role)) {
      throw new ProductStoreError("auth_role_invalid", "The account role is invalid.");
    }
    if (!requestFingerprint || typeof requestFingerprint !== "object" || Array.isArray(requestFingerprint)) {
      throw new ProductStoreError("idempotency_request_body_required", "The request body is required.");
    }
    await this.connect();
    const operationScope = receiptScope("register", usernameNormalized);
    const requestHash = canonicalRequestHash(requestFingerprint);
    return this.#transaction(async (query) => {
      const receipt = (await query(`
        INSERT INTO public.auth_idempotency_receipts (
          operation_scope, idempotency_key, request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)
        ON CONFLICT (operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [operationScope, idempotencyKey, requestHash, this.#now()])).rows[0];
      if (receipt.request_hash !== requestHash) {
        throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
      }
      if (receipt.response !== null) return receipt.response;

      const existingUsername = (await query(`
        SELECT user_id FROM public.product_users WHERE username_normalized = $1 FOR UPDATE
      `, [usernameNormalized])).rows[0];
      if (existingUsername) {
        throw new ProductStoreError("username_unavailable", "That username is unavailable.");
      }
      if (role === "admin") {
        const bootstrap = (await query(`
          SELECT user_id FROM public.product_users WHERE bootstrap_admin_claim = true FOR UPDATE
        `)).rows[0];
        if (bootstrap) {
          throw new ProductStoreError("bootstrap_admin_already_claimed", "The bootstrap administrator has already been claimed.");
        }
      }

      const now = this.#now();
      const user = {
        userId: this.#idFactory("user"), displayName: username, username, usernameNormalized,
        passwordHash, role, disabled: false, bootstrapAdminClaim: role === "admin",
        createdAt: now, updatedAt: now,
      };
      await query(`
        INSERT INTO public.product_users (
          user_id, schema_version, display_name, username, username_normalized,
          password_hash, account_role, disabled, bootstrap_admin_claim, created_at, updated_at, payload
        ) VALUES ($1, 'workbench-v1', $2, $3, $4, $5, $6, false, $7, $8::timestamptz, $8::timestamptz, '{}'::jsonb)
      `, [user.userId, user.displayName, user.username, user.usernameNormalized, user.passwordHash,
        user.role, user.bootstrapAdminClaim, now]);
      await query(`
        INSERT INTO public.product_workspaces (
          workspace_id, schema_version, name, created_by, created_at, updated_at, payload
        ) VALUES ($1, 'workbench-v1', $2, $3, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
        ON CONFLICT (workspace_id) DO NOTHING
      `, [workspaceId, workspaceName, user.userId, now]);
      const claimedWorkspace = (await query(`
        UPDATE public.product_workspaces
           SET name = $2, created_by = $3, updated_at = $4::timestamptz,
               payload = payload || jsonb_build_object('bootstrapClaimedAt', $4::timestamptz)
         WHERE workspace_id = $1
           AND created_by IN ('system-bootstrap', $3)
         RETURNING workspace_id
      `, [workspaceId, workspaceName, user.userId, now])).rows[0];
      if (!claimedWorkspace) {
        throw new ProductStoreError(
          "workspace_bootstrap_owner_conflict",
          "The workspace bootstrap owner could not be established.",
        );
      }
      const membershipId = `membership-${workspaceId}-${user.userId}`;
      await query(`
        INSERT INTO public.workspace_memberships (
          membership_id, workspace_id, user_id, schema_version, role, status, revision,
          created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', $4, 'active', 1, $5::timestamptz, $5::timestamptz, '{}'::jsonb)
      `, [membershipId, workspaceId, user.userId, role === "admin" ? "owner" : "member", now]);
      await query(`
        INSERT INTO public.workspace_principals (
          workspace_id, principal_id, principal_kind, user_id, membership_id,
          status, revision, created_at, updated_at, revoked_at, payload
        ) VALUES ($1, $2, 'user', $2, $3, 'active', 1, $4::timestamptz, $4::timestamptz, NULL, '{}'::jsonb)
      `, [workspaceId, user.userId, membershipId, now]);
      // Every activated member needs an owned personal authority scope.  The
      // first owner uses the one-time workspace seed; later members use the
      // separately governed membership-activation aggregate.
      await this.#ensurePersonalScope({ query, workspaceId, userId: user.userId, now });
      const response = { user: publicAccount(user), workspaceId };
      await query(`
        UPDATE public.auth_idempotency_receipts
           SET response = $3::jsonb, completed_at = $4::timestamptz
         WHERE operation_scope = $1 AND idempotency_key = $2
      `, [operationScope, idempotencyKey, JSON.stringify(response), now]);
      return response;
    });
  }

  async listAuthMembers({ requestedBy, workspaceId = "workspace-local" } = {}) {
    required(requestedBy, "user_id_required");
    await this.#assertAdminOwner({ requestedBy, workspaceId });
    return this.#transaction(async (query) => (await query(`
      SELECT user_id, display_name, username, username_normalized, password_hash,
             account_role, disabled, bootstrap_admin_claim, created_at, updated_at
        FROM public.product_users
       WHERE username_normalized IS NOT NULL
       ORDER BY created_at ASC, user_id ASC
    `)).rows.map(accountFromRow));
  }

  async updateAuthMember({
    requestedBy,
    userId,
    role,
    disabled,
    workspaceId = "workspace-local",
    idempotencyKey,
  } = {}) {
    required(requestedBy, "user_id_required");
    required(userId, "user_id_required");
    required(idempotencyKey, "idempotency_key_required");
    if (role !== undefined && !["admin", "member"].includes(role)) {
      throw new ProductStoreError("auth_role_invalid", "The account role is invalid.");
    }
    if (role === undefined && disabled === undefined) {
      throw new ProductStoreError("member_update_required", "A member change is required.");
    }
    await this.connect();
    const operationScope = receiptScope("member-update", `${workspaceId}:${userId}`);
    const requestHash = canonicalRequestHash({ role, disabled });
    return this.#transaction(async (query) => {
      const receipt = (await query(`
        INSERT INTO public.auth_idempotency_receipts (
          operation_scope, idempotency_key, request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)
        ON CONFLICT (operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [operationScope, idempotencyKey, requestHash, this.#now()])).rows[0];
      if (receipt.request_hash !== requestHash) {
        throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
      }
      if (receipt.response !== null) return receipt.response;
      await this.#assertAdminOwner({ requestedBy, workspaceId, query });
      const row = (await query(`
        SELECT user_id, display_name, username, username_normalized, password_hash,
               account_role, disabled, bootstrap_admin_claim, created_at, updated_at
          FROM public.product_users
         WHERE user_id = $1
         FOR UPDATE
      `, [userId])).rows[0];
      const target = accountFromRow(row);
      if (!target?.usernameNormalized) {
        throw new ProductStoreError("member_not_found", "The member was not found.");
      }
      const removesEnabledAdmin = target.role === "admin" && target.disabled !== true
        && (role === "member" || disabled === true);
      if (removesEnabledAdmin) {
        const count = (await query(`
          SELECT count(*)::int AS count
            FROM public.product_users
           WHERE account_role = 'admin' AND disabled = false
        `)).rows[0];
        if (Number(count?.count ?? 0) <= 1) {
          throw new ProductStoreError("last_admin_required", "At least one enabled administrator is required.");
        }
      }
      const now = this.#now();
      const nextRole = role ?? target.role;
      const nextDisabled = disabled ?? target.disabled;
      const updated = accountFromRow((await query(`
        UPDATE public.product_users
           SET account_role = $2, disabled = $3, updated_at = $4::timestamptz
         WHERE user_id = $1
         RETURNING user_id, display_name, username, username_normalized, password_hash,
                   account_role, disabled, bootstrap_admin_claim, created_at, updated_at
      `, [userId, nextRole, nextDisabled, now])).rows[0]);
      if (role !== undefined) {
        await query(`
          UPDATE public.workspace_memberships
             SET role = $3, revision = revision + 1, updated_at = $4::timestamptz
           WHERE workspace_id = $1 AND user_id = $2
        `, [workspaceId, userId, role === "admin" ? "owner" : "member", now]);
      }
      if (disabled === true) {
        await query(`
          UPDATE public.workbench_browser_sessions
             SET revoked_at = $2::timestamptz
           WHERE user_id = $1 AND revoked_at IS NULL
        `, [userId, now]);
      }
      const response = { user: publicAccount(updated), workspaceId };
      await query(`
        UPDATE public.auth_idempotency_receipts
           SET response = $3::jsonb, completed_at = $4::timestamptz
         WHERE operation_scope = $1 AND idempotency_key = $2
      `, [operationScope, idempotencyKey, JSON.stringify(response), now]);
      return response;
    });
  }

  async createWorkspaceInvitation({
    requestedBy,
    workspaceId = "workspace-local",
    invitationId,
    invitedEmail,
    tokenHash: invitationTokenHash,
    expiresAt,
    idempotencyKey,
  } = {}) {
    required(requestedBy, "user_id_required");
    required(workspaceId, "workspace_id_required");
    required(invitationId, "invitation_id_required");
    required(idempotencyKey, "idempotency_key_required");
    const email = normalizedEmail(invitedEmail);
    tokenHash(invitationTokenHash, "invitation_token_hash_invalid");
    const expiry = timestamp(expiresAt);
    const now = this.#now();
    if (new Date(expiry).getTime() <= new Date(now).getTime()) {
      throw new ProductStoreError("invitation_expiry_invalid", "The invitation expiry must be in the future.");
    }
    await this.connect();
    const operationScope = receiptScope("invitation-create", `${workspaceId}:${email}`);
    const requestHash = canonicalRequestHash({ invitedEmail: email, role: "member" });
    return this.#transaction(async (query) => {
      const receipt = (await query(`
        INSERT INTO public.auth_idempotency_receipts (
          operation_scope, idempotency_key, request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)
        ON CONFLICT (operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [operationScope, idempotencyKey, requestHash, now])).rows[0];
      if (receipt.request_hash !== requestHash) {
        throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
      }
      if (receipt.response !== null) return receipt.response;
      const authorizer = await this.#assertAdminOwner({ requestedBy, workspaceId, query });
      await query(`
        UPDATE public.workspace_invitations
           SET status = 'expired', updated_at = $2::timestamptz
         WHERE workspace_id = $1 AND status = 'pending' AND expires_at <= $2::timestamptz
      `, [workspaceId, now]);
      const pending = (await query(`
        SELECT invitation_id FROM public.workspace_invitations
         WHERE workspace_id = $1 AND invited_email_normalized = $2 AND status = 'pending'
         FOR UPDATE
      `, [workspaceId, email])).rows[0];
      if (pending) {
        throw new ProductStoreError("invitation_already_pending", "An active invitation already exists for this email.");
      }
      await query(`
        INSERT INTO public.workspace_invitations (
          invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
          created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at, payload
        ) VALUES ($1, $2, $3, 'member', 'pending', $4, $5, $6,
          $7::timestamptz, $7::timestamptz, $8::timestamptz,
          jsonb_build_object('delivery', 'smtp_outbox'))
      `, [invitationId, workspaceId, email, invitationTokenHash, requestedBy, authorizer.membershipId, now, expiry]);
      await query(`
        INSERT INTO public.email_outbox (
          outbox_id, invitation_id, recipient_email_normalized, delivery_kind, status, attempt_count,
          available_at, lease_expires_at, delivered_at, last_error_code, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workspace_invitation', 'queued', 0,
          $4::timestamptz, NULL, NULL, NULL, $4::timestamptz, $4::timestamptz,
          jsonb_build_object('template', 'workspace_invitation'))
      `, [this.#idFactory("email-outbox"), invitationId, email, now]);
      const response = {
        invitation: {
          invitationId,
          workspaceId,
          email,
          role: "member",
          status: "pending",
          expiresAt: expiry,
          createdAt: now,
          updatedAt: now,
          deliveryStatus: "queued",
        },
      };
      await query(`
        UPDATE public.auth_idempotency_receipts
           SET response = $3::jsonb, completed_at = $4::timestamptz
         WHERE operation_scope = $1 AND idempotency_key = $2
      `, [operationScope, idempotencyKey, JSON.stringify(response), now]);
      return response;
    });
  }

  async listWorkspaceInvitations({ requestedBy, workspaceId = "workspace-local" } = {}) {
    required(requestedBy, "user_id_required");
    required(workspaceId, "workspace_id_required");
    await this.connect();
    return this.#transaction(async (query) => {
      await this.#assertAdminOwner({ requestedBy, workspaceId, query });
      const rows = (await query(`
        SELECT invitation.invitation_id, invitation.workspace_id, invitation.invited_email_normalized,
               invitation.membership_role, invitation.status, invitation.token_hash,
               invitation.created_by_user_id, invitation.authorizer_membership_id,
               invitation.created_at, invitation.updated_at, invitation.expires_at,
               invitation.accepted_by_user_id,
               latest_outbox.status AS delivery_status
          FROM public.workspace_invitations invitation
          LEFT JOIN LATERAL (
            SELECT status
              FROM public.email_outbox
             WHERE invitation_id = invitation.invitation_id
             ORDER BY created_at DESC, outbox_id DESC
             LIMIT 1
          ) latest_outbox ON true
         WHERE invitation.workspace_id = $1
         ORDER BY invitation.created_at DESC, invitation.invitation_id DESC
      `, [workspaceId])).rows;
      return rows.map(invitationFromRow);
    });
  }

  async revokeWorkspaceInvitation({
    requestedBy,
    workspaceId = "workspace-local",
    invitationId,
    idempotencyKey,
  } = {}) {
    required(requestedBy, "user_id_required");
    required(workspaceId, "workspace_id_required");
    required(invitationId, "invitation_id_required");
    required(idempotencyKey, "idempotency_key_required");
    await this.connect();
    const now = this.#now();
    const operationScope = receiptScope("invitation-revoke", `${workspaceId}:${invitationId}`);
    const requestHash = canonicalRequestHash({ invitationId });
    return this.#transaction(async (query) => {
      const receipt = (await query(`
        INSERT INTO public.auth_idempotency_receipts (
          operation_scope, idempotency_key, request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)
        ON CONFLICT (operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [operationScope, idempotencyKey, requestHash, now])).rows[0];
      if (receipt.request_hash !== requestHash) {
        throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
      }
      if (receipt.response !== null) return receipt.response;
      await this.#assertAdminOwner({ requestedBy, workspaceId, query });
      const invitation = (await query(`
        SELECT invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
               created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at,
               accepted_by_user_id
          FROM public.workspace_invitations
         WHERE invitation_id = $1 AND workspace_id = $2
         FOR UPDATE
      `, [invitationId, workspaceId])).rows[0];
      if (!invitation) throw new ProductStoreError("invitation_not_found", "The invitation was not found.");
      if (invitation.status !== "pending") {
        throw new ProductStoreError("invitation_not_revocable", "Only a pending invitation can be revoked.");
      }
      const updated = (await query(`
        UPDATE public.workspace_invitations
           SET status = 'revoked', revoked_by_user_id = $3, revoked_at = $4::timestamptz,
               updated_at = $4::timestamptz
         WHERE invitation_id = $1 AND workspace_id = $2
         RETURNING invitation_id, workspace_id, invited_email_normalized, membership_role, status,
                   token_hash, created_by_user_id, authorizer_membership_id,
                   created_at, updated_at, expires_at, accepted_by_user_id
      `, [invitationId, workspaceId, requestedBy, now])).rows[0];
      await query(`
        UPDATE public.email_outbox
           SET status = 'failed', lease_expires_at = NULL, last_error_code = 'invitation_revoked',
               updated_at = $2::timestamptz
         WHERE invitation_id = $1 AND status IN ('queued', 'leased')
      `, [invitationId, now]);
      const response = { invitation: invitationFromRow(updated) };
      await query(`
        UPDATE public.auth_idempotency_receipts
           SET response = $3::jsonb, completed_at = $4::timestamptz
         WHERE operation_scope = $1 AND idempotency_key = $2
      `, [operationScope, idempotencyKey, JSON.stringify(response), now]);
      return response;
    });
  }

  async resendWorkspaceInvitation({
    requestedBy,
    workspaceId = "workspace-local",
    invitationId,
    replacementInvitationId,
    replacementTokenHash,
    expiresAt,
    idempotencyKey,
  } = {}) {
    required(requestedBy, "user_id_required");
    required(workspaceId, "workspace_id_required");
    required(invitationId, "invitation_id_required");
    required(replacementInvitationId, "invitation_id_required");
    required(idempotencyKey, "idempotency_key_required");
    tokenHash(replacementTokenHash, "invitation_token_hash_invalid");
    const expiry = timestamp(expiresAt);
    const now = this.#now();
    if (new Date(expiry).getTime() <= new Date(now).getTime()) {
      throw new ProductStoreError("invitation_expiry_invalid", "The invitation expiry must be in the future.");
    }
    await this.connect();
    const operationScope = receiptScope("invitation-resend", `${workspaceId}:${invitationId}`);
    const requestHash = canonicalRequestHash({ invitationId, action: "resend" });
    return this.#transaction(async (query) => {
      const receipt = (await query(`
        INSERT INTO public.auth_idempotency_receipts (
          operation_scope, idempotency_key, request_hash, response, created_at, completed_at
        ) VALUES ($1, $2, $3, NULL, $4::timestamptz, NULL)
        ON CONFLICT (operation_scope, idempotency_key)
        DO UPDATE SET operation_scope = EXCLUDED.operation_scope
        RETURNING request_hash, response
      `, [operationScope, idempotencyKey, requestHash, now])).rows[0];
      if (receipt.request_hash !== requestHash) {
        throw new ProductStoreError("idempotency_key_reused", "The idempotency key was already used with a different request body.");
      }
      if (receipt.response !== null) return receipt.response;
      const authorizer = await this.#assertAdminOwner({ requestedBy, workspaceId, query });
      const invitation = (await query(`
        SELECT invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
               created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at,
               accepted_by_user_id
          FROM public.workspace_invitations
         WHERE invitation_id = $1 AND workspace_id = $2
         FOR UPDATE
      `, [invitationId, workspaceId])).rows[0];
      if (!invitation) throw new ProductStoreError("invitation_not_found", "The invitation was not found.");
      if (invitation.status !== "pending") {
        throw new ProductStoreError("invitation_not_resendable", "Only a pending invitation can be resent.");
      }
      await query(`
        UPDATE public.workspace_invitations
           SET status = 'revoked', revoked_by_user_id = $3, revoked_at = $4::timestamptz,
               updated_at = $4::timestamptz
         WHERE invitation_id = $1 AND workspace_id = $2
      `, [invitationId, workspaceId, requestedBy, now]);
      await query(`
        UPDATE public.email_outbox
           SET status = 'failed', lease_expires_at = NULL, last_error_code = 'invitation_replaced',
               updated_at = $2::timestamptz
         WHERE invitation_id = $1 AND status IN ('queued', 'leased')
      `, [invitationId, now]);
      await query(`
        INSERT INTO public.workspace_invitations (
          invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
          created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at, payload
        ) VALUES ($1, $2, $3, 'member', 'pending', $4, $5, $6,
          $7::timestamptz, $7::timestamptz, $8::timestamptz,
          jsonb_build_object('delivery', 'smtp_outbox', 'replaces', $9))
      `, [replacementInvitationId, workspaceId, invitation.invited_email_normalized,
        replacementTokenHash, requestedBy, authorizer.membershipId, now, expiry, invitationId]);
      await query(`
        INSERT INTO public.email_outbox (
          outbox_id, invitation_id, recipient_email_normalized, delivery_kind, status, attempt_count,
          available_at, lease_expires_at, delivered_at, last_error_code, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workspace_invitation', 'queued', 0,
          $4::timestamptz, NULL, NULL, NULL, $4::timestamptz, $4::timestamptz,
          jsonb_build_object('template', 'workspace_invitation', 'replaces', $5))
      `, [this.#idFactory("email-outbox"), replacementInvitationId, invitation.invited_email_normalized, now, invitationId]);
      const response = {
        invitation: {
          invitationId: replacementInvitationId,
          workspaceId,
          email: invitation.invited_email_normalized,
          role: "member",
          status: "pending",
          expiresAt: expiry,
          createdAt: now,
          updatedAt: now,
          deliveryStatus: "queued",
        },
      };
      await query(`
        UPDATE public.auth_idempotency_receipts
           SET response = $3::jsonb, completed_at = $4::timestamptz
         WHERE operation_scope = $1 AND idempotency_key = $2
      `, [operationScope, idempotencyKey, JSON.stringify(response), now]);
      return response;
    });
  }

  async resolveWorkspaceInvitationToken({ invitationId, tokenHash: invitationTokenHash } = {}) {
    required(invitationId, "invitation_id_required");
    tokenHash(invitationTokenHash, "invitation_token_hash_invalid");
    await this.connect();
    const invitation = await this.#transaction(async (query) => privateInvitationFromRow((await query(`
      SELECT invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
             created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at,
             accepted_by_user_id
        FROM public.workspace_invitations
       WHERE invitation_id = $1 AND token_hash = $2
       FOR SHARE
    `, [invitationId, invitationTokenHash])).rows[0]));
    if (!invitation) throw new ProductStoreError("invitation_invalid", "The invitation link is invalid.");
    if (invitation.status === "revoked") throw new ProductStoreError("invitation_revoked", "The invitation has been revoked.");
    if (invitation.status === "accepted") throw new ProductStoreError("invitation_already_accepted", "The invitation has already been accepted.");
    if (invitation.status === "expired" || new Date(invitation.expiresAt).getTime() <= new Date(this.#now()).getTime()) {
      throw new ProductStoreError("invitation_expired", "The invitation has expired.");
    }
    return invitation;
  }

  async createOAuthLoginTransaction({
    transactionId,
    invitationId,
    provider,
    stateHash,
    initiatedByUserId = null,
    bindExistingAccount = false,
    expiresAt,
  } = {}) {
    required(transactionId, "oauth_transaction_id_required");
    required(invitationId, "invitation_id_required");
    if (!["google", "github"].includes(provider)) throw new ProductStoreError("oauth_provider_invalid", "The OAuth provider is invalid.");
    tokenHash(stateHash, "oauth_state_hash_invalid");
    const expiry = timestamp(expiresAt);
    const now = this.#now();
    if (new Date(expiry).getTime() <= new Date(now).getTime()) {
      throw new ProductStoreError("oauth_state_expired", "The OAuth state has expired.");
    }
    await this.connect();
    return this.#transaction(async (query) => {
      const invitation = (await query(`
        SELECT invitation_id, status, expires_at
          FROM public.workspace_invitations
         WHERE invitation_id = $1
         FOR SHARE
      `, [invitationId])).rows[0];
      if (!invitation || invitation.status !== "pending") {
        throw new ProductStoreError("invitation_invalid", "The invitation link is invalid.");
      }
      if (new Date(invitation.expires_at).getTime() <= new Date(now).getTime()) {
        throw new ProductStoreError("invitation_expired", "The invitation has expired.");
      }
      if (initiatedByUserId) {
        const account = (await query(`
          SELECT user_id FROM public.product_users
           WHERE user_id = $1 AND disabled = false
           FOR SHARE
        `, [initiatedByUserId])).rows[0];
        if (!account) throw new ProductStoreError("account_disabled", "This account is disabled.");
      }
      await query(`
        INSERT INTO public.oauth_login_transactions (
          oauth_transaction_id, invitation_id, provider, state_hash, initiated_by_user_id,
          bind_existing_account, created_at, expires_at, completed_at, completed_user_id, response, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz,
          NULL, NULL, NULL, '{}'::jsonb)
      `, [transactionId, invitationId, provider, stateHash, initiatedByUserId, bindExistingAccount === true, now, expiry]);
      return {
        transactionId,
        invitationId,
        provider,
        stateHash,
        initiatedByUserId,
        bindExistingAccount: bindExistingAccount === true,
        createdAt: now,
        expiresAt: expiry,
        completedAt: null,
        completedUserId: null,
        response: null,
      };
    });
  }

  async getOAuthLoginTransaction({ transactionId, provider, stateHash } = {}) {
    required(transactionId, "oauth_transaction_id_required");
    if (!["google", "github"].includes(provider)) throw new ProductStoreError("oauth_provider_invalid", "The OAuth provider is invalid.");
    tokenHash(stateHash, "oauth_state_hash_invalid");
    await this.connect();
    const transaction = await this.#transaction(async (query) => oauthTransactionFromRow((await query(`
      SELECT oauth_transaction_id, invitation_id, provider, state_hash, initiated_by_user_id,
             bind_existing_account, created_at, expires_at, completed_at, completed_user_id, response
        FROM public.oauth_login_transactions
       WHERE oauth_transaction_id = $1 AND provider = $2 AND state_hash = $3
       FOR SHARE
    `, [transactionId, provider, stateHash])).rows[0]));
    if (!transaction) throw new ProductStoreError("oauth_state_invalid", "The OAuth state is invalid.");
    if (!transaction.response && new Date(transaction.expiresAt).getTime() <= new Date(this.#now()).getTime()) {
      throw new ProductStoreError("oauth_state_expired", "The OAuth state has expired.");
    }
    return transaction;
  }

  async activateOAuthInvitation({
    transactionId,
    provider,
    stateHash,
    providerSubject,
    verifiedEmail,
    newUserId,
    newUsername,
  } = {}) {
    required(transactionId, "oauth_transaction_id_required");
    if (!["google", "github"].includes(provider)) throw new ProductStoreError("oauth_provider_invalid", "The OAuth provider is invalid.");
    tokenHash(stateHash, "oauth_state_hash_invalid");
    required(providerSubject, "oauth_provider_subject_required");
    const email = normalizedEmail(verifiedEmail);
    const now = this.#now();
    await this.connect();
    return this.#transaction(async (query) => {
      const transaction = (await query(`
        SELECT oauth_transaction_id, invitation_id, provider, state_hash, initiated_by_user_id,
               bind_existing_account, created_at, expires_at, completed_at, completed_user_id, response
          FROM public.oauth_login_transactions
         WHERE oauth_transaction_id = $1 AND provider = $2 AND state_hash = $3
         FOR UPDATE
      `, [transactionId, provider, stateHash])).rows[0];
      if (!transaction) throw new ProductStoreError("oauth_state_invalid", "The OAuth state is invalid.");
      if (transaction.response !== null) return transaction.response;
      if (new Date(transaction.expires_at).getTime() <= new Date(now).getTime()) {
        throw new ProductStoreError("oauth_state_expired", "The OAuth state has expired.");
      }
      const invitation = (await query(`
        SELECT invitation_id, workspace_id, invited_email_normalized, membership_role, status, token_hash,
               created_by_user_id, authorizer_membership_id, created_at, updated_at, expires_at,
               accepted_by_user_id
          FROM public.workspace_invitations
         WHERE invitation_id = $1
         FOR UPDATE
      `, [transaction.invitation_id])).rows[0];
      if (!invitation || invitation.status !== "pending") {
        throw new ProductStoreError("invitation_invalid", "The invitation link is invalid.");
      }
      if (new Date(invitation.expires_at).getTime() <= new Date(now).getTime()) {
        throw new ProductStoreError("invitation_expired", "The invitation has expired.");
      }
      if (invitation.invited_email_normalized !== email) {
        throw new ProductStoreError("invitation_email_mismatch", "The verified identity email does not match this invitation.");
      }

      const identity = (await query(`
        SELECT provider, provider_subject, user_id, verified_email_normalized
          FROM public.external_identities
         WHERE provider = $1 AND provider_subject = $2
         FOR UPDATE
      `, [provider, providerSubject])).rows[0];
      let user;
      if (identity) {
        if (transaction.initiated_by_user_id !== identity.user_id) {
          throw new ProductStoreError(
            "oauth_identity_binding_required",
            "Sign in to the existing account and explicitly bind this identity before accepting the invitation.",
          );
        }
        user = accountFromRow((await query(`
          SELECT user_id, display_name, username, username_normalized, password_hash,
                 account_role, disabled, bootstrap_admin_claim, created_at, updated_at
            FROM public.product_users
           WHERE user_id = $1
           FOR UPDATE
        `, [identity.user_id])).rows[0]);
        if (!user || user.disabled === true) {
          throw new ProductStoreError("account_disabled", "This account is disabled.");
        }
        await query(`
          UPDATE public.external_identities
             SET verified_email_normalized = $3, verified_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE provider = $1 AND provider_subject = $2
        `, [provider, providerSubject, email, now]);
      } else if (transaction.initiated_by_user_id) {
        if (transaction.bind_existing_account !== true) {
          throw new ProductStoreError(
            "oauth_explicit_binding_required",
            "Explicitly confirm identity binding after signing in to an existing account.",
          );
        }
        user = accountFromRow((await query(`
          SELECT user_id, display_name, username, username_normalized, password_hash,
                 account_role, disabled, bootstrap_admin_claim, created_at, updated_at
            FROM public.product_users
           WHERE user_id = $1
           FOR UPDATE
        `, [transaction.initiated_by_user_id])).rows[0]);
        if (!user || user.disabled === true) {
          throw new ProductStoreError("account_disabled", "This account is disabled.");
        }
        const providerBinding = (await query(`
          SELECT provider_subject FROM public.external_identities
           WHERE user_id = $1 AND provider = $2
           FOR UPDATE
        `, [user.userId, provider])).rows[0];
        if (providerBinding) {
          throw new ProductStoreError("oauth_provider_already_bound", "This account already has a different identity for that provider.");
        }
        await query(`
          INSERT INTO public.external_identities (
            provider, provider_subject, user_id, verified_email_normalized, verified_at,
            created_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz,
            jsonb_build_object('binding', 'explicit_existing_account'))
        `, [provider, providerSubject, user.userId, email, now]);
      } else {
        required(newUserId, "oauth_new_user_id_required");
        required(newUsername, "oauth_new_username_required");
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/u.test(newUsername)) {
          throw new ProductStoreError("oauth_new_username_invalid", "The generated account identity is invalid.");
        }
        const usernameNormalized = newUsername.toLowerCase();
        const existingUsername = (await query(`
          SELECT user_id FROM public.product_users WHERE username_normalized = $1 FOR UPDATE
        `, [usernameNormalized])).rows[0];
        if (existingUsername) {
          throw new ProductStoreError("oauth_new_username_unavailable", "The generated account identity is unavailable.");
        }
        user = {
          userId: newUserId,
          displayName: "Member",
          username: newUsername,
          usernameNormalized,
          passwordHash: null,
          role: "member",
          disabled: false,
          bootstrapAdminClaim: false,
          createdAt: now,
          updatedAt: now,
        };
        await query(`
          INSERT INTO public.product_users (
            user_id, schema_version, display_name, username, username_normalized,
            password_hash, account_role, disabled, bootstrap_admin_claim, created_at, updated_at, payload
          ) VALUES ($1, 'workbench-v1', $2, $3, $4, NULL, 'member', false, false,
            $5::timestamptz, $5::timestamptz, jsonb_build_object('account_source', 'oauth'))
        `, [user.userId, user.displayName, user.username, user.usernameNormalized, now]);
        await query(`
          INSERT INTO public.external_identities (
            provider, provider_subject, user_id, verified_email_normalized, verified_at,
            created_at, updated_at, payload
          ) VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $5::timestamptz,
            jsonb_build_object('binding', 'invitation_activation'))
        `, [provider, providerSubject, user.userId, email, now]);
      }

      const existingMembership = (await query(`
        SELECT membership_id, status
          FROM public.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2
         FOR UPDATE
      `, [invitation.workspace_id, user.userId])).rows[0];
      if (existingMembership) {
        throw new ProductStoreError("workspace_membership_exists", "This account already belongs to the workspace.");
      }
      const membershipId = this.#idFactory("membership");
      const activation = {
        invitation_id: invitation.invitation_id,
        membership_id: membershipId,
        actor_user_id: user.userId,
        authorizer_user_id: invitation.created_by_user_id,
      };
      const activationPayload = JSON.stringify({ membership_activation: activation });
      await query(`
        UPDATE public.workspace_invitations
           SET status = 'accepted', accepted_by_user_id = $2, accepted_at = $3::timestamptz,
               updated_at = $3::timestamptz
         WHERE invitation_id = $1
      `, [invitation.invitation_id, user.userId, now]);
      await query(`
        INSERT INTO public.workspace_memberships (
          membership_id, workspace_id, user_id, schema_version, role, status, revision,
          created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-v1', 'member', 'active', 1,
          $4::timestamptz, $4::timestamptz, $5::jsonb)
      `, [membershipId, invitation.workspace_id, user.userId, now, activationPayload]);
      await query(`
        INSERT INTO public.workspace_principals (
          workspace_id, principal_id, principal_kind, user_id, membership_id,
          status, revision, created_at, updated_at, revoked_at, payload
        ) VALUES ($1, $2, 'user', $2, $3, 'active', 1,
          $4::timestamptz, $4::timestamptz, NULL, $5::jsonb)
      `, [invitation.workspace_id, user.userId, membershipId, now, activationPayload]);
      await this.#ensurePersonalScope({
        query,
        workspaceId: invitation.workspace_id,
        userId: user.userId,
        now,
        membershipActivation: activation,
      });
      const response = { user: publicAccount(user), workspaceId: invitation.workspace_id };
      await query(`
        UPDATE public.oauth_login_transactions
           SET completed_at = $2::timestamptz, completed_user_id = $3, response = $4::jsonb
         WHERE oauth_transaction_id = $1
      `, [transactionId, now, user.userId, JSON.stringify(response)]);
      return response;
    });
  }

  async claimNextInvitationDelivery({ leaseMilliseconds = 60_000 } = {}) {
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 15 * 60 * 1_000) {
      throw new TypeError("email_outbox_lease_invalid");
    }
    await this.connect();
    const now = this.#now();
    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString();
    return this.#transaction(async (query) => {
      await query(`
        UPDATE public.workspace_invitations
           SET status = 'expired', updated_at = $1::timestamptz
         WHERE status = 'pending' AND expires_at <= $1::timestamptz
      `, [now]);
      await query(`
        UPDATE public.email_outbox outbox
           SET status = 'failed', lease_expires_at = NULL, last_error_code = 'invitation_expired',
               updated_at = $1::timestamptz
          FROM public.workspace_invitations invitation
         WHERE outbox.invitation_id = invitation.invitation_id
           AND invitation.status = 'expired'
           AND outbox.status IN ('queued', 'leased')
      `, [now]);
      const row = (await query(`
        SELECT outbox.outbox_id, outbox.attempt_count, outbox.recipient_email_normalized,
               invitation.invitation_id, invitation.workspace_id, invitation.expires_at,
               workspace.name AS workspace_name
          FROM public.email_outbox outbox
          JOIN public.workspace_invitations invitation ON invitation.invitation_id = outbox.invitation_id
          JOIN public.product_workspaces workspace ON workspace.workspace_id = invitation.workspace_id
         WHERE invitation.status = 'pending'
           AND invitation.expires_at > $1::timestamptz
           AND (
             (outbox.status = 'queued' AND outbox.available_at <= $1::timestamptz)
             OR (outbox.status = 'leased' AND outbox.lease_expires_at <= $1::timestamptz)
           )
         ORDER BY outbox.available_at ASC, outbox.created_at ASC, outbox.outbox_id ASC
         FOR UPDATE OF outbox SKIP LOCKED
         LIMIT 1
      `, [now])).rows[0];
      if (!row) return null;
      const attemptNumber = Number(row.attempt_count) + 1;
      await query(`
        UPDATE public.email_outbox
           SET status = 'leased', attempt_count = $2, lease_expires_at = $3::timestamptz,
               last_error_code = NULL, updated_at = $4::timestamptz
         WHERE outbox_id = $1
      `, [row.outbox_id, attemptNumber, leaseExpiresAt, now]);
      return {
        outboxId: row.outbox_id,
        attemptNumber,
        invitationId: row.invitation_id,
        workspaceId: row.workspace_id,
        recipientEmail: row.recipient_email_normalized,
        workspaceName: row.workspace_name,
        expiresAt: timestamp(row.expires_at),
      };
    });
  }

  async recordInvitationDelivery({ outboxId, attemptNumber, providerReceiptId = null } = {}) {
    required(outboxId, "email_outbox_id_required");
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new TypeError("email_outbox_attempt_invalid");
    if (providerReceiptId !== null && (typeof providerReceiptId !== "string" || !/^[-A-Za-z0-9._:@/]{1,256}$/u.test(providerReceiptId))) {
      throw new TypeError("email_provider_receipt_invalid");
    }
    await this.connect();
    const now = this.#now();
    return this.#transaction(async (query) => {
      const outbox = (await query(`
        SELECT outbox_id, status, attempt_count
          FROM public.email_outbox
         WHERE outbox_id = $1
         FOR UPDATE
      `, [outboxId])).rows[0];
      if (!outbox || outbox.status !== "leased" || Number(outbox.attempt_count) !== attemptNumber) return { delivered: false };
      await query(`
        UPDATE public.email_outbox
           SET status = 'delivered', lease_expires_at = NULL, delivered_at = $2::timestamptz,
               updated_at = $2::timestamptz
         WHERE outbox_id = $1
      `, [outboxId, now]);
      await query(`
        INSERT INTO public.email_delivery_receipts (
          delivery_receipt_id, outbox_id, attempt_number, status, provider_receipt_id, occurred_at, payload
        ) VALUES ($1, $2, $3, 'delivered', $4, $5::timestamptz, '{}'::jsonb)
      `, [this.#idFactory("email-receipt"), outboxId, attemptNumber, providerReceiptId, now]);
      return { delivered: true };
    });
  }

  async recordInvitationDeliveryFailure({
    outboxId,
    attemptNumber,
    errorCode,
    retryAt = null,
  } = {}) {
    required(outboxId, "email_outbox_id_required");
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new TypeError("email_outbox_attempt_invalid");
    if (typeof errorCode !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(errorCode)) {
      throw new TypeError("email_delivery_error_code_invalid");
    }
    const retryTimestamp = retryAt === null ? null : timestamp(retryAt);
    await this.connect();
    const now = this.#now();
    return this.#transaction(async (query) => {
      const outbox = (await query(`
        SELECT outbox_id, status, attempt_count
          FROM public.email_outbox
         WHERE outbox_id = $1
         FOR UPDATE
      `, [outboxId])).rows[0];
      if (!outbox || outbox.status !== "leased" || Number(outbox.attempt_count) !== attemptNumber) return { recorded: false };
      await query(`
        UPDATE public.email_outbox
           SET status = $2, available_at = COALESCE($3::timestamptz, available_at), lease_expires_at = NULL,
               last_error_code = $4, updated_at = $5::timestamptz
         WHERE outbox_id = $1
      `, [outboxId, retryTimestamp ? "queued" : "failed", retryTimestamp, errorCode, now]);
      await query(`
        INSERT INTO public.email_delivery_receipts (
          delivery_receipt_id, outbox_id, attempt_number, status, provider_receipt_id, occurred_at, payload
        ) VALUES ($1, $2, $3, 'failed', NULL, $4::timestamptz, jsonb_build_object('code', $5::text))
      `, [this.#idFactory("email-receipt"), outboxId, attemptNumber, now, errorCode]);
      return { recorded: true, retryScheduled: retryTimestamp !== null };
    });
  }

  async #readAccount(where, values = []) {
    await this.connect();
    return this.#transaction(async (query) => accountFromRow((await query(`
      SELECT user_id, display_name, username, username_normalized, password_hash,
             account_role, disabled, bootstrap_admin_claim, created_at, updated_at
        FROM public.product_users
        ${where}
       ORDER BY created_at ASC, user_id ASC
       LIMIT 1
    `, values)).rows[0]));
  }

  async #assertAdminOwner({ requestedBy, workspaceId, query = null }) {
    if (!query) {
      await this.connect();
      return this.#transaction((transactionQuery) => this.#assertAdminOwner({
        requestedBy, workspaceId, query: transactionQuery,
      }));
    }
    const row = (await query(`
      SELECT user_account.account_role, user_account.disabled, membership.membership_id,
             membership.role, membership.status
        FROM public.product_users user_account
        JOIN public.workspace_memberships membership ON membership.user_id = user_account.user_id
       WHERE user_account.user_id = $1 AND membership.workspace_id = $2
       FOR UPDATE OF user_account, membership
    `, [requestedBy, workspaceId])).rows[0];
    if (row?.account_role !== "admin" || row.disabled === true) {
      throw new ProductStoreError("member_admin_required", "Administrator access is required.");
    }
    if (row.status !== "active") {
      throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
    }
    if ((roleRank[row.role] ?? -1) < roleRank.owner) {
      throw new ProductStoreError("workspace_role_forbidden", "Your workspace role cannot perform this action.");
    }
    return { membershipId: row.membership_id };
  }

  async #ensurePersonalScope({ query, workspaceId, userId, now, membershipActivation = null }) {
    await query("SELECT workspace_id FROM public.product_workspaces WHERE workspace_id = $1 FOR UPDATE", [workspaceId]);
    const existing = (await query(
      `SELECT scope_id FROM public.product_scopes
        WHERE workspace_id = $1 AND scope_kind = 'personal'
          AND owner_user_id = $2 AND status = 'active'
        LIMIT 1 FOR SHARE`,
      [workspaceId, userId],
    )).rows[0];
    if (existing) return;
    const seeded = (await query(
      `SELECT scope_id FROM public.product_scopes
        WHERE workspace_id = $1 AND creation_mode = 'workspace_initial_seed'
        LIMIT 1 FOR SHARE`,
      [workspaceId],
    )).rows[0];
    const creationMode = seeded ? "membership_activation" : "workspace_initial_seed";
    if (creationMode === "membership_activation" && (!membershipActivation
      || typeof membershipActivation !== "object" || Array.isArray(membershipActivation))) {
      throw new ProductStoreError(
        "membership_activation_lineage_required",
        "A membership activation invitation lineage is required.",
      );
    }
    // Scope/grant authority triggers compare timestamps to PostgreSQL's own
    // `clock_timestamp()`. Use that transaction-local source rather than a
    // process clock that can be milliseconds ahead of the database.
    const databaseNow = timestamp((await query("SELECT clock_timestamp() AS now")).rows[0]?.now ?? now);
    const scopeId = this.#idFactory("scope-personal");
    const policyRevisionId = this.#idFactory("scope-policy");
    const grantId = this.#idFactory("scope-grant");
    const policyHash = canonicalRequestHash({
      schemaVersion: "workbench-v1",
      kind: creationMode,
      workspaceId,
      scopeId,
      userId,
      permissionMode: "interactive",
    });
    await query("SET CONSTRAINTS ALL DEFERRED");
    const aggregatePayload = JSON.stringify(creationMode === "membership_activation"
      ? { membership_activation: membershipActivation }
      : { bootstrap: creationMode });
    await query(`
      INSERT INTO public.product_scopes (
        workspace_id, scope_id, schema_version, scope_kind, owner_user_id, owner_principal_id,
        current_policy_revision_id, created_by_principal_id, created_by_principal_kind,
        creation_mode, created_at, updated_at, payload
      ) VALUES ($1, $2, 'workbench-v1', 'personal', $3, $3, $4, $3, 'user',
        $5, $6::timestamptz, $6::timestamptz, $7::jsonb)
    `, [workspaceId, scopeId, userId, policyRevisionId, creationMode, databaseNow, aggregatePayload]);
    await query(`
      INSERT INTO public.scope_policy_revisions (
        workspace_id, scope_id, policy_revision_id, revision, observation_tier, permission_mode,
        auto_approved_effect_classes, auto_approved_action_ids, policy_content_hash,
        created_by_principal_id, created_by_principal_kind, created_at, payload
      ) VALUES ($1, $2, $3, 1, 'workspace_readable', 'interactive', ARRAY[]::text[], ARRAY[]::text[],
        $4, $5, 'user', $6::timestamptz, $7::jsonb)
    `, [workspaceId, scopeId, policyRevisionId, policyHash, userId, databaseNow, aggregatePayload]);
    await query(`
      INSERT INTO public.scope_principal_grants (
        workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind,
        capabilities, can_approve, granted_by_principal_id, granted_by_principal_kind,
        issuance_kind, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'user', 'operation', ARRAY['object.execute']::text[], true,
        $4, 'user', 'scope_creation', $5::timestamptz, $5::timestamptz,
        $6::jsonb)
    `, [workspaceId, scopeId, grantId, userId, databaseNow, aggregatePayload]);
  }

  #now() { return timestamp(this.#clock()); }

  #transaction(work) {
    return this.#store.withTransaction((uow) => work((text, values) => this.#sql.query(uow, text, values)));
  }
}
