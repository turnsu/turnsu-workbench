import { randomUUID, timingSafeEqual } from "node:crypto";

import { compare, hash } from "bcryptjs";

import { ProductStoreError } from "../store/errors.mjs";
import {
  assertNativeDevicePublicKey,
  assertNativeRedirectUri,
} from "./native-client-crypto.mjs";

const DUMMY_PASSWORD_HASH = "$2b$12$yW6McEk2Trkg.gFfiQkeMuAY.FtqTkbbJ3gqHQIsLVxNlAPAmrNCS";

export const normalizeUsername = (value) => String(value ?? "").normalize("NFKC").toLowerCase();

const constantTimeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const publicUser = (user) => user ? ({
  userId: user.userId,
  username: user.username,
  role: user.role,
  disabled: user.disabled === true,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
}) : null;

const timestamp = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("auth_clock_invalid");
  return date.toISOString();
};

const oauthProvider = (value) => {
  if (value !== "google" && value !== "github") {
    throw new ProductStoreError("oauth_provider_invalid", "The OAuth provider is invalid.");
  }
  return value;
};

const safeDeliveryCode = (error) => {
  const candidate = String(error?.code ?? "");
  return /^[a-z][a-z0-9_]{0,63}$/u.test(candidate) ? candidate : "smtp_delivery_failed";
};

const providerReceiptId = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[-A-Za-z0-9._:@/]{1,256}$/u.test(value)) {
    throw new ProductStoreError("smtp_delivery_receipt_invalid", "The SMTP delivery receipt is invalid.");
  }
  return value;
};

export class AuthService {
  constructor({
    store,
    persistence = store,
    bootstrapAdminToken = "",
    workspaceId = "workspace-local",
    workspaceName = "Team workspace",
    bcryptCost = 12,
    invitationTokenSigner = null,
    invitationMailer = null,
    invitationBaseUrl = null,
    oauthProviders = {},
    nativeClientSessions = null,
    nativeRedirectOrigins = [],
    nativeAuthorizationBaseUrl = null,
    publicOrigin = null,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!persistence?.connect) throw new TypeError("auth_persistence_required");
    if (!Number.isInteger(bcryptCost) || bcryptCost < 10 || bcryptCost > 14) {
      throw new TypeError("auth_bcrypt_cost_invalid");
    }
    this.store = persistence;
    this.bootstrapAdminToken = String(bootstrapAdminToken ?? "");
    // Password enrollment is intentionally limited to bootstrap/recovery.
    this.registrationOpen = false;
    this.workspaceId = workspaceId;
    this.workspaceName = workspaceName;
    this.bcryptCost = bcryptCost;
    this.invitationTokenSigner = invitationTokenSigner;
    this.invitationMailer = invitationMailer;
    this.invitationBaseUrl = invitationBaseUrl;
    this.oauthProviders = oauthProviders && typeof oauthProviders === "object" ? oauthProviders : {};
    if (nativeClientSessions !== null && typeof nativeClientSessions !== "object") {
      throw new TypeError("native_client_sessions_invalid");
    }
    if (!Array.isArray(nativeRedirectOrigins) || nativeRedirectOrigins.some((origin) => typeof origin !== "string")) {
      throw new TypeError("native_redirect_origins_invalid");
    }
    this.nativeClientSessions = nativeClientSessions;
    this.nativeRedirectOrigins = [...new Set(nativeRedirectOrigins)];
    if (nativeAuthorizationBaseUrl !== null && (typeof nativeAuthorizationBaseUrl !== "string" || nativeAuthorizationBaseUrl.length === 0)) {
      throw new TypeError("native_authorization_base_url_invalid");
    }
    this.nativeAuthorizationBaseUrl = nativeAuthorizationBaseUrl;
    if (publicOrigin !== null && (typeof publicOrigin !== "string" || publicOrigin.length === 0)) {
      throw new TypeError("native_public_origin_invalid");
    }
    this.publicOrigin = publicOrigin;
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("auth_identity_clock_and_id_factory_required");
    }
    this.clock = clock;
    this.idFactory = idFactory;
  }

  async status({ session } = {}) {
    const bootstrapAdmin = await this.store.getBootstrapAdmin();
    const account = session?.userId
      ? await this.store.getAuthAccount(session.userId)
      : null;
    const user = account?.usernameNormalized && account.disabled !== true
      ? publicUser(account)
      : null;
    return {
      registrationOpen: this.registrationOpen,
      bootstrapRequired: !bootstrapAdmin,
      bootstrapAvailable: !bootstrapAdmin && this.bootstrapAdminToken.length > 0,
      authenticated: Boolean(user),
      ...(user ? { user, workspaceId: session.activeWorkspaceId } : {}),
    };
  }

  async ensureWorkspace() {
    if (typeof this.store.ensureWorkspace !== "function") {
      throw new ProductStoreError("workspace_bootstrap_unavailable", "Workspace bootstrap is not configured.");
    }
    return this.store.ensureWorkspace({
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
    });
  }

  async register({ username, password, bootstrapToken, idempotencyKey } = {}) {
    const usernameNormalized = normalizeUsername(username);
    const bootstrapAdmin = await this.store.getBootstrapAdmin();
    const isBootstrap = !bootstrapAdmin;
    if (isBootstrap) {
      if (!this.bootstrapAdminToken) {
        throw new ProductStoreError(
          "bootstrap_admin_unavailable",
          "Bootstrap administrator registration is not configured.",
        );
      }
      if (!constantTimeEqual(bootstrapToken, this.bootstrapAdminToken)) {
        throw new ProductStoreError(
          "bootstrap_admin_required",
          "A valid bootstrap administrator token is required.",
        );
      }
    } else {
      throw new ProductStoreError(
        "password_registration_disabled",
        "New members must activate through a workspace invitation.",
      );
    }
    const passwordHash = await hash(password, this.bcryptCost);
    const result = await this.store.registerAuthAccount({
      username,
      usernameNormalized,
      passwordHash,
      role: isBootstrap ? "admin" : "member",
      workspaceId: this.workspaceId,
      workspaceName: this.workspaceName,
      idempotencyKey,
      requestFingerprint: {
        username: usernameNormalized,
        role: isBootstrap ? "admin" : "member",
      },
    });
    return { user: publicUser(result.user), workspaceId: result.workspaceId };
  }

  async login({ username, password } = {}) {
    const account = await this.store.getAuthAccountByUsername(normalizeUsername(username));
    const valid = await compare(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!valid || !account?.usernameNormalized) {
      throw new ProductStoreError("invalid_credentials", "The username or password is invalid.");
    }
    if (account.disabled === true) {
      throw new ProductStoreError("account_disabled", "This account is disabled.");
    }
    await this.store.authorizeWorkspace({
      userId: account.userId,
      workspaceId: this.workspaceId,
      minimumRole: "viewer",
    });
    return { user: publicUser(account), workspaceId: this.workspaceId };
  }

  async listMembers({ auth } = {}) {
    const users = await this.store.listAuthMembers({
      requestedBy: auth?.userId,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
    });
    return users.map(publicUser);
  }

  async updateMember({ auth, userId, role, disabled, idempotencyKey } = {}) {
    const result = await this.store.updateAuthMember({
      requestedBy: auth?.userId,
      userId,
      role,
      disabled,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
      idempotencyKey,
    });
    return { user: publicUser(result.user), workspaceId: result.workspaceId };
  }

  async createInvitation({ auth, email, idempotencyKey } = {}) {
    this.#requireInvitationDelivery();
    const invitationId = this.#id("invitation");
    const expiresAt = this.#future(72 * 60 * 60 * 1000);
    const token = this.invitationTokenSigner.invitationToken({ invitationId, expiresAt });
    const result = await this.store.createWorkspaceInvitation({
      requestedBy: auth?.userId,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
      invitationId,
      invitedEmail: email,
      tokenHash: this.invitationTokenSigner.tokenHash(token),
      expiresAt,
      idempotencyKey,
    });
    return result;
  }

  async listInvitations({ auth } = {}) {
    return this.store.listWorkspaceInvitations({
      requestedBy: auth?.userId,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
    });
  }

  async revokeInvitation({ auth, invitationId, idempotencyKey } = {}) {
    return this.store.revokeWorkspaceInvitation({
      requestedBy: auth?.userId,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
      invitationId,
      idempotencyKey,
    });
  }

  async resendInvitation({ auth, invitationId, idempotencyKey } = {}) {
    this.#requireInvitationDelivery();
    const replacementInvitationId = this.#id("invitation");
    const expiresAt = this.#future(72 * 60 * 60 * 1000);
    const token = this.invitationTokenSigner.invitationToken({
      invitationId: replacementInvitationId,
      expiresAt,
    });
    return this.store.resendWorkspaceInvitation({
      requestedBy: auth?.userId,
      workspaceId: auth?.activeWorkspaceId ?? this.workspaceId,
      invitationId,
      replacementInvitationId,
      replacementTokenHash: this.invitationTokenSigner.tokenHash(token),
      expiresAt,
      idempotencyKey,
    });
  }

  async inspectInvitation({ token } = {}) {
    this.#requireTokenSigner();
    const invitationId = this.invitationTokenSigner.parseInvitationToken(token);
    if (!invitationId) throw new ProductStoreError("invitation_invalid", "The invitation link is invalid.");
    const invitation = await this.store.resolveWorkspaceInvitationToken({
      invitationId,
      tokenHash: this.invitationTokenSigner.tokenHash(token),
    });
    if (!this.invitationTokenSigner.verifyInvitationToken({
      token,
      invitationId,
      expiresAt: invitation.expiresAt,
    })) {
      throw new ProductStoreError("invitation_invalid", "The invitation link is invalid.");
    }
    return {
      invitationId: invitation.invitationId,
      expiresAt: invitation.expiresAt,
      providers: Object.keys(this.oauthProviders)
        .filter((provider) => provider === "google" || provider === "github")
        .sort(),
    };
  }

  async startOAuth({ provider, token, auth = null, bindExistingAccount = false } = {}) {
    this.#requireTokenSigner();
    const normalizedProvider = oauthProvider(provider);
    const client = this.#oauthClient(normalizedProvider);
    const invitation = await this.#resolveSignedInvitation(token);
    const transactionId = this.#id("oauth");
    const expiresAt = this.#future(10 * 60 * 1000);
    const state = this.invitationTokenSigner.oauthState({
      transactionId,
      provider: normalizedProvider,
      expiresAt,
    });
    const codeVerifier = this.invitationTokenSigner.oauthCodeVerifier({ transactionId });
    const nonce = this.invitationTokenSigner.oauthNonce({ transactionId });
    await this.store.createOAuthLoginTransaction({
      transactionId,
      invitationId: invitation.invitationId,
      provider: normalizedProvider,
      stateHash: this.invitationTokenSigner.tokenHash(state),
      initiatedByUserId: auth?.userId ?? null,
      bindExistingAccount: bindExistingAccount === true,
      expiresAt,
    });
    const authorizationUrl = await client.authorizationUrl({ state, codeVerifier, nonce });
    return { authorizationUrl };
  }

  async completeOAuth({ provider, state, code, auth = null } = {}) {
    this.#requireTokenSigner();
    const normalizedProvider = oauthProvider(provider);
    const client = this.#oauthClient(normalizedProvider);
    const transactionId = this.invitationTokenSigner.parseOAuthState(state, { provider: normalizedProvider });
    if (!transactionId) throw new ProductStoreError("oauth_state_invalid", "The OAuth state is invalid.");
    const stateHash = this.invitationTokenSigner.tokenHash(state);
    const transaction = await this.store.getOAuthLoginTransaction({
      transactionId,
      provider: normalizedProvider,
      stateHash,
    });
    if (!this.invitationTokenSigner.verifyOAuthState({
      state,
      transactionId,
      provider: normalizedProvider,
      expiresAt: transaction.expiresAt,
    })) {
      throw new ProductStoreError("oauth_state_invalid", "The OAuth state is invalid.");
    }
    if (transaction.initiatedByUserId && transaction.initiatedByUserId !== auth?.userId) {
      throw new ProductStoreError(
        "oauth_binding_session_required",
        "Sign in to the same account before completing this identity binding.",
      );
    }
    if (transaction.response) {
      return { user: publicUser(transaction.response.user), workspaceId: transaction.response.workspaceId };
    }
    const identity = await client.complete({
      code,
      codeVerifier: this.invitationTokenSigner.oauthCodeVerifier({ transactionId }),
      nonce: this.invitationTokenSigner.oauthNonce({ transactionId }),
    });
    if (identity?.provider !== normalizedProvider) {
      throw new ProductStoreError("oauth_provider_response_invalid", "The identity provider returned an invalid response.");
    }
    const suffix = transactionId.replace(/[^A-Za-z0-9]/gu, "").slice(-16).toLowerCase();
    const result = await this.store.activateOAuthInvitation({
      transactionId,
      provider: normalizedProvider,
      stateHash,
      providerSubject: identity.providerSubject,
      verifiedEmail: identity.verifiedEmail,
      newUserId: this.#id("user"),
      newUsername: `member-${suffix || "account"}`,
    });
    return { user: publicUser(result.user), workspaceId: result.workspaceId };
  }

  async startNativeAuthorization({ clientKind, redirectUri, codeChallenge, devicePublicKey } = {}) {
    const sessions = this.#nativeClientSessions();
    assertNativeDevicePublicKey(devicePublicKey);
    const normalizedRedirectUri = assertNativeRedirectUri(redirectUri, {
      allowedOrigins: this.nativeRedirectOrigins,
    });
    if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
      throw new ProductStoreError("native_authorization_invalid", "The native authorization proof is invalid.");
    }
    const authorizationId = this.#id("native-authorization");
    const result = await sessions.createAuthorization({
      authorizationId,
      clientKind,
      redirectUri: normalizedRedirectUri,
      codeChallenge,
      devicePublicKey,
    });
    const authorizationUrl = this.#nativeAuthorizationUrl();
    const separator = authorizationUrl.includes("?") ? "&" : "?";
    return {
      authorizationId: result.authorizationId,
      expiresAt: result.expiresAt,
      authorizationUrl: `${authorizationUrl}${separator}${new URLSearchParams({ authorizationId: result.authorizationId })}`,
    };
  }

  async approveNativeAuthorization({ authorizationId, auth } = {}) {
    const sessions = this.#nativeClientSessions();
    const userId = auth?.userId;
    const workspaceId = auth?.activeWorkspaceId ?? this.workspaceId;
    if (typeof userId !== "string" || !userId) {
      throw new ProductStoreError("session_required", "A Workbench session is required.");
    }
    const approval = await sessions.approveAuthorization({ authorizationId, userId, workspaceId });
    const redirect = new URL(approval.redirectUri);
    redirect.searchParams.set("code", approval.authorizationCode);
    redirect.searchParams.set("authorization_id", authorizationId);
    return { redirectUrl: redirect.toString() };
  }

  async completeNativeAuthorization({ authorizationId, authorizationCode, codeVerifier, devicePublicKey } = {}) {
    const result = await this.#nativeClientSessions().consumeAuthorization({
      authorizationId,
      authorizationCode,
      codeVerifier,
      devicePublicKey,
    });
    return nativeTokenSet(result);
  }

  async refreshNativeToken({ refreshToken } = {}) {
    return nativeTokenSet(await this.#nativeClientSessions().refresh({ refreshToken }));
  }

  async authenticateNativeAccessToken({ accessToken } = {}) {
    return this.#nativeClientSessions().authenticateAccessToken({ accessToken });
  }

  async listOwnNativeClientSessions({ auth } = {}) {
    if (!auth?.userId || !auth?.activeWorkspaceId) throw new ProductStoreError("session_required", "A Workbench session is required.");
    return this.#nativeClientSessions().listOwnedSessions({ userId: auth.userId, workspaceId: auth.activeWorkspaceId });
  }

  async revokeOwnNativeClientSession({ clientSessionId, auth } = {}) {
    if (!auth?.userId || !auth?.activeWorkspaceId) throw new ProductStoreError("session_required", "A Workbench session is required.");
    return this.#nativeClientSessions().revokeClientSession({ clientSessionId, userId: auth.userId, workspaceId: auth.activeWorkspaceId });
  }

  async revokeNativeClientSession({ auth } = {}) {
    const clientSessionId = auth?.clientSessionId;
    if (typeof clientSessionId !== "string" || !clientSessionId) return { revoked: false };
    return this.#nativeClientSessions().revokeClientSession({
      clientSessionId,
      userId: auth.userId,
      workspaceId: auth.activeWorkspaceId,
    });
  }

  async deliverInvitationOutbox({ limit = 10 } = {}) {
    this.#requireInvitationDelivery();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("email_outbox_limit_invalid");
    const result = { delivered: 0, failed: 0, queued: 0 };
    for (let index = 0; index < limit; index += 1) {
      const delivery = await this.store.claimNextInvitationDelivery();
      if (!delivery) break;
      const token = this.invitationTokenSigner.invitationToken({
        invitationId: delivery.invitationId,
        expiresAt: delivery.expiresAt,
      });
      try {
        const receipt = await this.invitationMailer.sendWorkspaceInvitation({
          recipientEmail: delivery.recipientEmail,
          workspaceName: delivery.workspaceName,
          expiresAt: delivery.expiresAt,
          invitationUrl: this.#invitationUrl(token),
        });
        const recorded = await this.store.recordInvitationDelivery({
          outboxId: delivery.outboxId,
          attemptNumber: delivery.attemptNumber,
          providerReceiptId: providerReceiptId(receipt?.receiptId),
        });
        if (recorded.delivered) result.delivered += 1;
      } catch (error) {
        const retryAt = delivery.attemptNumber < 3 ? this.#future(60_000 * delivery.attemptNumber) : null;
        const recorded = await this.store.recordInvitationDeliveryFailure({
          outboxId: delivery.outboxId,
          attemptNumber: delivery.attemptNumber,
          errorCode: safeDeliveryCode(error),
          retryAt,
        });
        if (recorded.retryScheduled) result.queued += 1;
        else if (recorded.recorded) result.failed += 1;
      }
    }
    return result;
  }

  #resolveSignedInvitation(token) {
    return this.inspectInvitation({ token }).then(async (summary) => {
      const invitation = await this.store.resolveWorkspaceInvitationToken({
        invitationId: summary.invitationId,
        tokenHash: this.invitationTokenSigner.tokenHash(token),
      });
      return invitation;
    });
  }

  #requireTokenSigner() {
    const requiredMethods = [
      "invitationToken",
      "oauthState",
      "tokenHash",
      "parseInvitationToken",
      "verifyInvitationToken",
      "parseOAuthState",
      "verifyOAuthState",
      "oauthCodeVerifier",
      "oauthNonce",
    ];
    if (!this.invitationTokenSigner
      || requiredMethods.some((method) => typeof this.invitationTokenSigner[method] !== "function")) {
      throw new ProductStoreError("identity_signing_unavailable", "Identity signing is not configured.");
    }
  }

  #requireInvitationDelivery() {
    this.#requireTokenSigner();
    if (!this.invitationMailer || typeof this.invitationMailer.sendWorkspaceInvitation !== "function") {
      throw new ProductStoreError("invitation_delivery_unavailable", "SMTP invitation delivery is not configured.");
    }
    if (typeof this.invitationBaseUrl !== "string" || this.invitationBaseUrl.length === 0) {
      throw new ProductStoreError("invitation_delivery_unavailable", "SMTP invitation delivery is not configured.");
    }
  }

  #oauthClient(provider) {
    const client = this.oauthProviders[provider];
    if (!client || typeof client.authorizationUrl !== "function" || typeof client.complete !== "function") {
      throw new ProductStoreError("oauth_provider_unavailable", "This OAuth provider is not configured.");
    }
    return client;
  }

  #nativeClientSessions() {
    const requiredMethods = [
      "createAuthorization",
      "approveAuthorization",
      "consumeAuthorization",
      "refresh",
      "authenticateAccessToken",
      "revokeClientSession",
    ];
    if (!this.nativeClientSessions
      || requiredMethods.some((method) => typeof this.nativeClientSessions[method] !== "function")) {
      throw new ProductStoreError("native_client_auth_unavailable", "Native client authorization is not configured.");
    }
    return this.nativeClientSessions;
  }

  #nativeAuthorizationUrl() {
    const source = this.nativeAuthorizationBaseUrl ?? "/native/authorize";
    try {
      const base = this.publicOrigin ?? "http://workbench.local";
      const value = new URL(source, base);
      if (value.origin !== new URL(base).origin) {
        throw new TypeError("native_authorization_url_cross_origin");
      }
      return value.toString();
    } catch {
      throw new ProductStoreError("native_client_auth_unavailable", "Native client authorization is not configured.");
    }
  }

  #invitationUrl(token) {
    let url;
    try {
      url = new URL(this.invitationBaseUrl);
    } catch {
      throw new ProductStoreError("invitation_delivery_unavailable", "SMTP invitation delivery is not configured.");
    }
    if (url.protocol !== "https:") {
      throw new ProductStoreError("invitation_delivery_unavailable", "Invitation delivery requires an HTTPS application URL.");
    }
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/invite`;
    url.search = "";
    url.hash = new URLSearchParams({ token }).toString();
    return url.toString();
  }

  #future(milliseconds) {
    const now = new Date(timestamp(this.clock()));
    return new Date(now.getTime() + milliseconds).toISOString();
  }

  #id(kind) {
    const value = this.idFactory(kind);
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
      throw new TypeError("auth_identity_id_factory_invalid");
    }
    return value;
  }
}

function nativeTokenSet(value) {
  return {
    accessToken: value.accessToken,
    accessTokenExpiresAt: value.accessTokenExpiresAt,
    refreshToken: value.refreshToken,
    refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    clientSessionId: value.clientSessionId,
    workspaceId: value.workspaceId,
  };
}
