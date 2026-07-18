import { spawn } from "node:child_process";

export const LOCAL_KEYCHAIN_SERVICE = "com.looloomi.workbench.local";
export const LOCAL_SECRET_ACCOUNTS = Object.freeze({
  mongoUsername: "mongo-root-username",
  mongoPassword: "mongo-root-password",
  mongoReplicaKey: "mongo-replica-key",
  backupKey: "mongo-backup-key",
  modelApiKey: "model-api-key",
});

const MODEL_CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function modelCredentialAccount(credentialRef) {
  if (!MODEL_CREDENTIAL_REF.test(credentialRef || "")) throw new TypeError("model_credential_ref_invalid");
  return `model-credential:${credentialRef}`;
}

export async function readKeychainSecret(account, { spawnProcess = spawn } = {}) {
  validateAccount(account);
  const result = await runSecurity([
    "find-generic-password", "-w", "-s", LOCAL_KEYCHAIN_SERVICE, "-a", account,
  ], spawnProcess);
  if (result.code !== 0 || result.stdout.length < 1 || result.stdout.length > 16_384) {
    throw keychainError("keychain_secret_unavailable");
  }
  return result.stdout;
}

export async function writeKeychainSecret(account, secret, { spawnProcess = spawn } = {}) {
  validateAccount(account);
  const value = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), "utf8");
  if (value.length < 1 || value.length > 16_384) throw keychainError("keychain_secret_invalid");
  const result = await runSecurity([
    "add-generic-password", "-U", "-s", LOCAL_KEYCHAIN_SERVICE, "-a", account,
    "-w", value.toString("utf8"),
  ], spawnProcess);
  if (result.code !== 0) throw keychainError("keychain_secret_write_failed");
  return true;
}

function runSecurity(args, spawnProcess) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess("/usr/bin/security", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin" },
        windowsHide: true,
      });
    } catch { return reject(keychainError("keychain_helper_unavailable")); }
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= 16_384) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16_384) child.kill("SIGKILL");
    });
    child.once("error", () => reject(keychainError("keychain_helper_unavailable")));
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout) }));
  });
}

function validateAccount(account) {
  if (!Object.values(LOCAL_SECRET_ACCOUNTS).includes(account)
    && !/^model-credential:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(account || "")) {
    throw new TypeError("keychain_account_invalid");
  }
}

function keychainError(code) {
  const error = new Error(code);
  error.code = code;
  error.productSafe = true;
  return error;
}
