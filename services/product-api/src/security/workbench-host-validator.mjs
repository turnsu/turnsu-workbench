const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

function parseAuthority(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  if (/[\s,/@\\?#]/.test(value)) return null;

  let hostname;
  let port = null;
  if (value.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::([0-9]+))?$/.exec(value);
    if (!match) return null;
    hostname = match[1].toLowerCase();
    port = match[2] ?? null;
  } else {
    const match = /^([a-z0-9.-]+)(?::([0-9]+))?$/i.exec(value);
    if (!match || match[1].startsWith(".") || match[1].endsWith(".")) return null;
    hostname = match[1].toLowerCase();
    port = match[2] ?? null;
  }

  if (port !== null) {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) return null;
    port = String(portNumber);
  }
  return { hostname, port };
}

function configuredOriginHost(origin) {
  if (!origin) return null;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("workbench_origin_invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("workbench_origin_invalid");
  }
  return parsed.host;
}

function compileRules({ allowedHosts = [], origin } = {}) {
  const configured = typeof allowedHosts === "string" ? [allowedHosts] : allowedHosts;
  if (!Array.isArray(configured)) throw new TypeError("workbench_allowed_hosts_invalid");
  const originHost = configuredOriginHost(origin);
  const values = [...LOOPBACK_HOSTS, ...configured, ...(originHost ? [originHost] : [])];
  return values.map((value) => {
    const rule = parseAuthority(value);
    if (!rule) throw new TypeError("workbench_allowed_host_invalid");
    return rule;
  });
}

export function createWorkbenchHostValidator(options = {}) {
  const rules = compileRules(options);
  return (hostHeader) => {
    const candidate = parseAuthority(Array.isArray(hostHeader) ? null : hostHeader);
    const allowed = candidate && rules.some((rule) =>
      rule.hostname === candidate.hostname && (rule.port === null || rule.port === candidate.port));
    if (!allowed) {
      const error = new Error("Request Host is not allowed for this Workbench.");
      error.code = "invalid_host";
      throw error;
    }
    return hostHeader;
  };
}
