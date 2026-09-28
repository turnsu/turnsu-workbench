import { spawn } from "node:child_process";

const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function createKeychainCredentialResolver({
  service,
  spawnProcess = spawn,
  timeoutMilliseconds = 5_000,
  maxOutputBytes = 16_384,
} = {}) {
  if (!SERVICE.test(service ?? "")) throw new TypeError("model_keychain_service_invalid");
  if (typeof spawnProcess !== "function") throw new TypeError("model_keychain_spawn_invalid");
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 60_000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 65_536) {
    throw new TypeError("model_keychain_limit_invalid");
  }

  return Object.freeze({
    async resolve(credentialRef) {
      if (!CREDENTIAL_REF.test(credentialRef ?? "")) {
        throw new TypeError("model_credential_ref_invalid");
      }
      const result = await readSecuritySecret({
        service,
        account: `model-credential:${credentialRef}`,
        spawnProcess,
        timeoutMilliseconds,
        maxOutputBytes,
      });
      if (result.code !== 0 || result.overflowed) throw credentialUnavailable();
      const secret = result.stdout.toString("utf8").replace(/\r?\n$/, "");
      if (Buffer.byteLength(secret, "utf8") < 1 || Buffer.byteLength(secret, "utf8") > maxOutputBytes) {
        throw credentialUnavailable();
      }
      return secret;
    },
  });
}

function readSecuritySecret({
  service,
  account,
  spawnProcess,
  timeoutMilliseconds,
  maxOutputBytes,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(
        "/usr/bin/security",
        ["find-generic-password", "-w", "-s", service, "-a", account],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: "/usr/bin:/bin" },
          windowsHide: true,
        },
      );
    } catch {
      reject(credentialUnavailable());
      return;
    }

    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;
    let timer;
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const stopForOverflow = () => {
      overflowed = true;
      child.kill("SIGKILL");
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
      else stopForOverflow();
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) stopForOverflow();
    });
    child.once("error", () => settle(() => reject(credentialUnavailable())));
    child.once("close", (code) => settle(() => resolve({
      code,
      overflowed,
      stdout: Buffer.concat(stdout),
    })));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() => reject(credentialUnavailable()));
    }, timeoutMilliseconds);
    timer.unref?.();
  });
}

function credentialUnavailable() {
  const error = new Error("credential_unavailable");
  error.code = "credential_unavailable";
  error.productSafe = true;
  return error;
}
