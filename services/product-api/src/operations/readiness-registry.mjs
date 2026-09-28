export class ReadinessRegistry {
  #probes = new Map();
  #timeoutMs;

  constructor({ timeoutMs = 3000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new TypeError("readiness_timeout_invalid");
    }
    this.#timeoutMs = timeoutMs;
  }

  register(name, probe, { required = true } = {}) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name || "") || typeof probe !== "function" || typeof required !== "boolean") {
      throw new TypeError("readiness_probe_invalid");
    }
    if (this.#probes.has(name)) throw new TypeError("readiness_probe_duplicate");
    this.#probes.set(name, { probe, required });
    return () => this.#probes.delete(name);
  }

  async check() {
    const checks = await Promise.all([...this.#probes.entries()].map(async ([name, registration]) => {
      try {
        const result = await withTimeout(Promise.resolve().then(registration.probe), this.#timeoutMs);
        const ok = result === true || result?.ok === true || result?.available === true;
        return { name, status: ok ? "ok" : registration.required ? "failed" : "optional", required: registration.required };
      } catch {
        return { name, status: registration.required ? "failed" : "optional", required: registration.required };
      }
    }));
    return {
      ready: checks.every((item) => !item.required || item.status === "ok"),
      checks: checks.map(({ name, status }) => ({ name, status })),
    };
  }
}

function withTimeout(operation, timeoutMs) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("readiness_probe_timeout")), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
