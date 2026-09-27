import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { HmacIdentityTokenSigner } from "./hmac-identity-token-signer.mjs";
import { GitHubOAuthClient, GoogleOAuthClient } from "./oauth-provider-client.mjs";
import { SmtpTlsInvitationMailer } from "./smtp-tls-invitation-mailer.mjs";

const API_PREFIX = "/api/workbench/v1/auth/oauth";

/**
 * Builds the production invitation identity ports from non-secret environment
 * metadata and injected Secret Store references. Secret values are never read
 * from environment variables and are never returned from this composition.
 */
export async function createInvitationIdentityComposition({
  env = process.env,
  readSecret = readSecretFile,
  fetchImpl = globalThis.fetch,
  clock = () => new Date(),
} = {}) {
  if (typeof readSecret !== "function") throw new TypeError("identity_secret_reader_required");
  const publicOrigin = optionalOrigin(env.WORKBENCH_PUBLIC_ORIGIN);
  const enabled = boolean(env.WORKBENCH_IDENTITY_ENABLED, false);
  if (!enabled) {
    return Object.freeze({
      publicOrigin: publicOrigin?.origin ?? null,
      invitationTokenSigner: null,
      invitationMailer: null,
      invitationBaseUrl: null,
      oauthProviders: Object.freeze({}),
    });
  }
  if (!publicOrigin || publicOrigin.protocol !== "https:") {
    throw new TypeError("identity_public_https_origin_required");
  }

  // Validate the complete non-secret deployment contract before touching any
  // mounted secret. A partially configured deployment must fail at startup,
  // rather than exposing only one of the two promised OAuth choices.
  const smtpHost = required(env.WORKBENCH_SMTP_HOST, "smtp_host_required");
  const smtpPort = integer(env.WORKBENCH_SMTP_PORT, 465, 1, 65_535, "smtp_port_invalid");
  const smtpUsername = required(env.WORKBENCH_SMTP_USERNAME, "smtp_username_required");
  const smtpFrom = required(env.WORKBENCH_SMTP_FROM, "smtp_sender_required");
  const smtpMode = optional(env.WORKBENCH_SMTP_TLS_MODE) ?? "implicit-tls";
  if (!new Set(["implicit-tls", "starttls"]).has(smtpMode)) {
    throw new TypeError("smtp_tls_mode_invalid");
  }
  const smtpServername = optional(env.WORKBENCH_SMTP_SERVERNAME) ?? smtpHost;
  const smtpClientName = optional(env.WORKBENCH_SMTP_CLIENT_NAME) ?? publicOrigin.hostname;
  const smtpTimeoutMilliseconds = integer(
    env.WORKBENCH_SMTP_TIMEOUT_MS,
    15_000,
    1_000,
    120_000,
    "smtp_timeout_invalid",
  );
  const googleClientId = required(
    env.WORKBENCH_GOOGLE_OAUTH_CLIENT_ID,
    "google_oauth_client_id_required",
  );
  const githubClientId = required(
    env.WORKBENCH_GITHUB_OAUTH_CLIENT_ID,
    "github_oauth_client_id_required",
  );
  const signingSecretReference = required(
    env.WORKBENCH_IDENTITY_SIGNING_SECRET_FILE,
    "identity_signing_secret_file_required",
  );
  const smtpPasswordReference = required(
    env.WORKBENCH_SMTP_PASSWORD_FILE,
    "smtp_password_file_required",
  );
  const googleSecretReference = required(
    env.WORKBENCH_GOOGLE_OAUTH_CLIENT_SECRET_FILE,
    "google_oauth_client_secret_file_required",
  );
  const githubSecretReference = required(
    env.WORKBENCH_GITHUB_OAUTH_CLIENT_SECRET_FILE,
    "github_oauth_client_secret_file_required",
  );
  const [signingSecret, smtpPassword, googleSecret, githubSecret] = await Promise.all([
    secret(readSecret, signingSecretReference),
    secret(readSecret, smtpPasswordReference),
    secret(readSecret, googleSecretReference),
    secret(readSecret, githubSecretReference),
  ]);

  const invitationTokenSigner = new HmacIdentityTokenSigner({ secret: signingSecret });
  const invitationMailer = new SmtpTlsInvitationMailer({
    host: smtpHost,
    port: smtpPort,
    username: smtpUsername,
    password: smtpPassword,
    from: smtpFrom,
    mode: smtpMode,
    servername: smtpServername,
    clientName: smtpClientName,
    timeoutMilliseconds: smtpTimeoutMilliseconds,
  });
  const callback = (provider) => new URL(`${API_PREFIX}/${provider}/callback`, publicOrigin).toString();
  const oauthProviders = Object.freeze({
    google: new GoogleOAuthClient({
      clientId: googleClientId,
      clientSecret: googleSecret,
      redirectUri: callback("google"),
      fetchImpl,
      clock,
    }),
    github: new GitHubOAuthClient({
      clientId: githubClientId,
      clientSecret: githubSecret,
      redirectUri: callback("github"),
      fetchImpl,
    }),
  });

  return Object.freeze({
    publicOrigin: publicOrigin.origin,
    invitationTokenSigner,
    invitationMailer,
    invitationBaseUrl: publicOrigin.origin,
    oauthProviders,
  });
}

export async function readSecretFile(reference) {
  const path = required(reference, "identity_secret_file_required");
  if (!isAbsolute(path)) throw new TypeError("identity_secret_file_absolute_path_required");
  const info = await stat(path);
  if (!info.isFile()) throw new TypeError("identity_secret_file_invalid");
  return readFile(path, "utf8");
}

function optionalOrigin(value) {
  const source = optional(value);
  if (!source) return null;
  let url;
  try { url = new URL(source); }
  catch { throw new TypeError("workbench_public_origin_invalid"); }
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("workbench_public_origin_invalid");
  }
  return url;
}

async function secret(readSecret, reference) {
  const value = await readSecret(reference);
  const normalized = Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value ?? "").trim();
  if (normalized.length < 1 || normalized.length > 16_384) throw new TypeError("identity_secret_invalid");
  return normalized;
}

function boolean(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true"].includes(normalized)) return true;
  if (["0", "false"].includes(normalized)) return false;
  throw new TypeError("identity_enabled_invalid");
}

function integer(value, fallback, minimum, maximum, code) {
  const normalized = optional(value);
  const result = normalized === null ? fallback : Number(normalized);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError(code);
  return result;
}

function optional(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value).trim();
}

function required(value, code) {
  const result = optional(value);
  if (!result) throw new TypeError(code);
  return result;
}
