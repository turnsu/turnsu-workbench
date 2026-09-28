import assert from "node:assert/strict";
import test from "node:test";

import { AuthService } from "../../src/auth/auth-service.mjs";

class AuthStore {
  constructor() {
    this.accounts = [];
    this.registrations = [];
  }

  async connect() {}
  async getBootstrapAdmin() {
    return this.accounts.find((account) => account.bootstrapAdminClaim) ?? null;
  }
  async getAuthAccount(userId) {
    return this.accounts.find((account) => account.userId === userId) ?? null;
  }
  async getAuthAccountByUsername(usernameNormalized) {
    return this.accounts.find((account) => account.usernameNormalized === usernameNormalized) ?? null;
  }
  async registerAuthAccount(input) {
    this.registrations.push(input);
    if (this.accounts.some((account) => account.usernameNormalized === input.usernameNormalized)) {
      const error = new Error("username unavailable");
      error.code = "username_unavailable";
      throw error;
    }
    const now = "2026-07-24T00:00:00.000Z";
    const user = {
      userId: `user-${this.accounts.length + 1}`,
      username: input.username,
      usernameNormalized: input.usernameNormalized,
      passwordHash: input.passwordHash,
      role: input.role,
      disabled: false,
      ...(input.role === "admin" ? { bootstrapAdminClaim: true } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.push(user);
    return { user, workspaceId: input.workspaceId };
  }
  async authorizeWorkspace() {}
  async listAuthMembers() { return this.accounts; }
  async updateAuthMember({ userId, role, disabled, workspaceId }) {
    const user = this.accounts.find((account) => account.userId === userId);
    Object.assign(user, role === undefined ? {} : { role }, disabled === undefined ? {} : { disabled });
    return { user, workspaceId };
  }
}

test("the first registration requires the configured bootstrap token and becomes the sole initial admin", async () => {
  const store = new AuthStore();
  const service = new AuthService({
    store,
    bootstrapAdminToken: "bootstrap-secret",
    registrationOpen: false,
    bcryptCost: 10,
  });

  await assert.rejects(
    () => service.register({
      username: "Owner",
      password: "password-123",
      bootstrapToken: "wrong",
      idempotencyKey: "idem-1",
    }),
    { code: "bootstrap_admin_required" },
  );
  const result = await service.register({
    username: "Owner",
    password: "password-123",
    bootstrapToken: "bootstrap-secret",
    idempotencyKey: "idem-2",
  });
  assert.equal(result.user.role, "admin");
  assert.equal(result.user.username, "Owner");
  assert.equal("passwordHash" in result.user, false);
  assert.equal(store.accounts[0].usernameNormalized, "owner");
  assert.deepEqual(store.registrations[0].requestFingerprint, {
    username: "owner",
    role: "admin",
  });
  assert.equal(JSON.stringify(store.registrations[0].requestFingerprint).includes("password-123"), false);
  assert.equal(JSON.stringify(store.registrations[0].requestFingerprint).includes("bootstrap-secret"), false);

  await assert.rejects(
    () => service.register({
      username: "Member",
      password: "password-456",
      idempotencyKey: "idem-3",
    }),
    { code: "password_registration_disabled" },
  );
});

test("legacy registration-open configuration cannot bypass invitation-only member activation", async () => {
  const store = new AuthStore();
  const service = new AuthService({
    store,
    bootstrapAdminToken: "bootstrap-secret",
    registrationOpen: true,
    bcryptCost: 10,
  });
  await service.register({
    username: "Owner",
    password: "password-123",
    bootstrapToken: "bootstrap-secret",
    idempotencyKey: "idem-owner",
  });
  await assert.rejects(
    () => service.register({
      username: "Member",
      password: "password-456",
      idempotencyKey: "idem-member",
    }),
    { code: "password_registration_disabled" },
  );
});

test("login is case-normalized, never returns password material, and rejects disabled accounts", async () => {
  const store = new AuthStore();
  const service = new AuthService({
    store,
    bootstrapAdminToken: "bootstrap-secret",
    registrationOpen: true,
    bcryptCost: 10,
  });
  await service.register({
    username: "Owner.Local",
    password: "password-123",
    bootstrapToken: "bootstrap-secret",
    idempotencyKey: "idem-1",
  });
  const login = await service.login({ username: "OWNER.LOCAL", password: "password-123" });
  assert.equal(login.user.username, "Owner.Local");
  assert.equal("passwordHash" in login.user, false);

  await assert.rejects(
    () => service.login({ username: "OWNER.LOCAL", password: "wrong-password" }),
    { code: "invalid_credentials" },
  );
  store.accounts[0].disabled = true;
  await assert.rejects(
    () => service.login({ username: "owner.local", password: "password-123" }),
    { code: "account_disabled" },
  );
});
