import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_VERSION = "v1";
const TOKEN_SEPARATOR = "~";

const required = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
  return value;
};

const toBuffer = (value) => Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value ?? ""));

const equal = (left, right) => {
  const leftBuffer = toBuffer(left);
  const rightBuffer = toBuffer(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const safeIdentifier = (value, code) => {
  required(value, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) throw new TypeError(code);
  return value;
};

const hash = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

/**
 * Creates verifiable browser invitation/OAuth values without persisting their
 * raw form. The secret is an injected Secret Store value in production; this
 * class deliberately has no environment-variable fallback.
 */
export class HmacIdentityTokenSigner {
  #secret;

  constructor({ secret } = {}) {
    this.#secret = toBuffer(secret);
    if (this.#secret.length < 32) throw new TypeError("identity_token_signing_secret_required");
  }

  invitationToken({ invitationId, expiresAt } = {}) {
    return this.#token({ kind: "invitation", identifier: invitationId, expiresAt });
  }

  oauthState({ transactionId, provider, expiresAt } = {}) {
    required(provider, "oauth_provider_required");
    return this.#token({ kind: `oauth:${provider}`, identifier: transactionId, expiresAt });
  }

  parseInvitationToken(token) {
    return this.#parse({ token, kind: "invitation" });
  }

  parseOAuthState(state, { provider } = {}) {
    required(provider, "oauth_provider_required");
    return this.#parse({ token: state, kind: `oauth:${provider}` });
  }

  verifyInvitationToken({ token, invitationId, expiresAt } = {}) {
    return equal(token, this.invitationToken({ invitationId, expiresAt }));
  }

  verifyOAuthState({ state, transactionId, provider, expiresAt } = {}) {
    return equal(state, this.oauthState({ transactionId, provider, expiresAt }));
  }

  tokenHash(value) {
    required(value, "identity_token_required");
    return hash(value);
  }

  oauthCodeVerifier({ transactionId } = {}) {
    return this.#derived("oauth-pkce", transactionId);
  }

  oauthNonce({ transactionId } = {}) {
    return this.#derived("oauth-nonce", transactionId);
  }

  #token({ kind, identifier, expiresAt }) {
    safeIdentifier(identifier, "identity_token_identifier_invalid");
    required(kind, "identity_token_kind_required");
    required(expiresAt, "identity_token_expiry_required");
    const signature = this.#signature({ kind, identifier, expiresAt });
    return [TOKEN_VERSION, kind, identifier, signature].join(TOKEN_SEPARATOR);
  }

  #parse({ token, kind }) {
    if (typeof token !== "string") return null;
    const parts = token.split(TOKEN_SEPARATOR);
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION || parts[1] !== kind) return null;
    try {
      return safeIdentifier(parts[2], "identity_token_identifier_invalid");
    } catch {
      return null;
    }
  }

  #signature({ kind, identifier, expiresAt }) {
    return createHmac("sha256", this.#secret)
      .update(`${TOKEN_VERSION}\u0000${kind}\u0000${identifier}\u0000${expiresAt}`)
      .digest("base64url");
  }

  #derived(purpose, identifier) {
    safeIdentifier(identifier, "oauth_transaction_id_invalid");
    return createHmac("sha256", this.#secret)
      .update(`${TOKEN_VERSION}\u0000${purpose}\u0000${identifier}`)
      .digest("base64url");
  }
}
