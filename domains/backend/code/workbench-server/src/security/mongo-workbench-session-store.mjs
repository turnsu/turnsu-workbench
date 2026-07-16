import { createHash, randomBytes, randomUUID } from "node:crypto";

const token = () => randomBytes(32).toString("base64url");
const nowDate = (clock) => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("workbench_session_clock_invalid");
  return date;
};

export const hashSessionToken = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

export class MongoWorkbenchSessionStore {
  #store;
  #clock;
  #ttlMilliseconds;
  #tokenFactory;
  #csrfTokenFactory;
  #idFactory;

  constructor({
    store,
    clock = () => new Date(),
    ttlMilliseconds = 8 * 60 * 60 * 1000,
    tokenFactory = token,
    csrfTokenFactory = token,
    idFactory = () => `session-${randomUUID()}`,
  } = {}) {
    if (!store?.connect) {
      throw new TypeError("mongo_workbench_session_store_required");
    }
    this.#store = store;
    this.#clock = clock;
    this.#ttlMilliseconds = ttlMilliseconds;
    this.#tokenFactory = tokenFactory;
    this.#csrfTokenFactory = csrfTokenFactory;
    this.#idFactory = idFactory;
  }

  async issue({ userId, activeWorkspaceId } = {}) {
    await this.#store.connect();
    await this.#store.authorizeWorkspace({ userId, workspaceId: activeWorkspaceId, minimumRole: "viewer" });
    const rawToken = this.#tokenFactory();
    const csrfToken = this.#csrfTokenFactory();
    const now = nowDate(this.#clock);
    const expiresAt = new Date(now.getTime() + this.#ttlMilliseconds).toISOString();
    const session = {
      schemaVersion: "workbench-v1",
      sessionId: this.#idFactory(),
      tokenHash: hashSessionToken(rawToken),
      csrfToken,
      userId,
      activeWorkspaceId,
      createdAt: now.toISOString(),
      expiresAt,
      revokedAt: null,
    };
    await this.#store.repositories.sessions.insert(session);
    return { token: rawToken, csrfToken, expiresAt, sessionId: session.sessionId, userId, activeWorkspaceId };
  }

  async get(rawToken) {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    await this.#store.connect();
    const session = await this.#store.repositories.sessions.getByTokenHash(hashSessionToken(rawToken));
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= nowDate(this.#clock).getTime()) {
      await this.#store.repositories.sessions.revoke(session.sessionId, nowDate(this.#clock).toISOString());
      return null;
    }
    try {
      await this.#store.authorizeWorkspace({
        userId: session.userId,
        workspaceId: session.activeWorkspaceId,
        minimumRole: "viewer",
      });
    } catch {
      return null;
    }
    return {
      sessionId: session.sessionId,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      userId: session.userId,
      activeWorkspaceId: session.activeWorkspaceId,
    };
  }

  async revoke(rawToken) {
    const session = await this.get(rawToken);
    if (!session) return { revoked: false };
    await this.#store.repositories.sessions.revoke(session.sessionId, nowDate(this.#clock).toISOString());
    return { revoked: true };
  }
}
