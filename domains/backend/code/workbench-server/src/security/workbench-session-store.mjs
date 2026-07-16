import { randomBytes, randomUUID } from "node:crypto";

const defaultToken = () => randomBytes(32).toString("base64url");

export class WorkbenchSessionStore {
  #sessions = new Map();

  constructor({
    clock = () => new Date(),
    ttlMilliseconds = 8 * 60 * 60 * 1000,
    tokenFactory = defaultToken,
    csrfTokenFactory = defaultToken,
  } = {}) {
    this.clock = clock;
    this.ttlMilliseconds = ttlMilliseconds;
    this.tokenFactory = tokenFactory;
    this.csrfTokenFactory = csrfTokenFactory;
  }

  issue({ userId = "user-local", activeWorkspaceId = "workspace-local" } = {}) {
    const token = this.tokenFactory();
    const csrfToken = this.csrfTokenFactory();
    const expiresAt = new Date(this.#now().getTime() + this.ttlMilliseconds).toISOString();
    const sessionId = `session-${randomUUID()}`;
    this.#sessions.set(token, { sessionId, csrfToken, expiresAt, userId, activeWorkspaceId });
    return { token, sessionId, csrfToken, expiresAt, userId, activeWorkspaceId };
  }

  get(token) {
    const session = this.#sessions.get(token);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= this.#now().getTime()) {
      this.#sessions.delete(token);
      return null;
    }
    return { ...session };
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("workbench_session_clock_invalid");
    return date;
  }
}

export const parseCookies = (value = "") => Object.fromEntries(
  value.split(";").map((part) => part.trim().split(/=(.*)/s, 2)).filter(([key]) => key),
);

export const sessionCookie = (token, maxAgeSeconds) =>
  `workbench_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
