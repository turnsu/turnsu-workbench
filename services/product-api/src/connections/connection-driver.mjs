export class ConnectionDriverRegistry {
  #drivers = [];

  register({ driverKey, backend = "production", matches, driver } = {}) {
    if (
      typeof driverKey !== "string" ||
      !driverKey ||
      !["production", "test"].includes(backend) ||
      typeof matches !== "function" ||
      !driver ||
      typeof driver.probe !== "function"
    ) {
      throw new TypeError("connection_driver_registration_invalid");
    }
    if (this.#drivers.some((entry) => entry.driverKey === driverKey)) {
      throw new TypeError("connection_driver_duplicate");
    }
    this.#drivers.push(Object.freeze({ driverKey, backend, matches, driver }));
    return this;
  }

  resolve(capabilityKey) {
    return this.#drivers.find((entry) => entry.matches(capabilityKey)) ?? null;
  }

  async describe(capabilityKey) {
    const registration = this.resolve(capabilityKey);
    if (!registration) {
      return Object.freeze({
        registered: false,
        backend: null,
        bindingAvailable: false,
        probeAvailable: false,
      });
    }
    const readiness = typeof registration.driver.readiness === "function"
      ? await registration.driver.readiness()
      : {};
    return Object.freeze({
      registered: true,
      backend: registration.backend,
      bindingAvailable: readiness?.bindingAvailable === true,
      probeAvailable: readiness?.probeAvailable === true,
    });
  }
}

export function createFakeConnectionDriver({
  credentialState = "bound",
  runtimeBinding = { profile: "test-profile" },
  probeResult = {
    ok: true,
    principal: "test-principal",
    scopes: [],
    effects: [],
    expiresAt: null,
  },
} = {}) {
  let currentCredentialState = credentialState;
  let bindingRevision = credentialState === "bound" ? 1 : 0;
  const bindingFingerprint = () => `sha256:${bindingRevision.toString(16).padStart(64, "0")}`;
  return Object.freeze({
    async readiness() {
      return { bindingAvailable: true, probeAvailable: true };
    },
    async credentialState() {
      return currentCredentialState;
    },
    async bindSecretRef({ secretRef }) {
      if (typeof secretRef !== "string" || !secretRef) {
        return { ok: false, code: "connection_secret_ref_invalid" };
      }
      currentCredentialState = "bound";
      bindingRevision += 1;
      return {
        ok: true,
        credentialState: "bound",
        credentialBindingFingerprint: bindingFingerprint(),
      };
    },
    async probe() {
      return structuredClone(probeResult);
    },
    async validate({ probe }) {
      return structuredClone(probe);
    },
    async resolveRuntimeBinding({ expectedCredentialBindingFingerprint } = {}) {
      if (currentCredentialState !== "bound") {
        return { ok: false, code: "connection_credential_unbound" };
      }
      return expectedCredentialBindingFingerprint === bindingFingerprint()
        ? {
            ok: true,
            binding: structuredClone(runtimeBinding),
            credentialBindingFingerprint: bindingFingerprint(),
          }
        : { ok: false, code: "connection_credential_binding_mismatch" };
    },
    async refresh() {
      return structuredClone(probeResult);
    },
    async revoke() {
      currentCredentialState = "unbound";
      return { revoked: true };
    },
  });
}

export class LarkConnectionDriver {
  #credentialBindingResolver;
  #probeAccount;
  #revokeBinding;
  #bindCredentialReference;

  constructor({
    credentialBindingResolver,
    bindCredentialReference = null,
    probeAccount = null,
    revokeBinding = null,
  } = {}) {
    if (typeof credentialBindingResolver !== "function") {
      throw new TypeError("lark_connection_credential_resolver_required");
    }
    this.#credentialBindingResolver = credentialBindingResolver;
    this.#bindCredentialReference = bindCredentialReference;
    this.#probeAccount = probeAccount;
    this.#revokeBinding = revokeBinding;
  }

  async readiness() {
    return {
      bindingAvailable: typeof this.#bindCredentialReference === "function",
      probeAvailable: typeof this.#probeAccount === "function",
    };
  }

  async credentialState(context) {
    const binding = await this.#credentialBindingResolver(context);
    if (binding?.state === "bound" && !bindingMatchesExpectedFingerprint(binding, context)) {
      return "unbound";
    }
    return binding?.state === "bound"
      ? "bound"
      : binding?.state === "expired"
        ? "expired"
        : "unbound";
  }

  async bindSecretRef(context) {
    if (typeof this.#bindCredentialReference !== "function") {
      return {
        ok: false,
        code: "connection_credential_binding_unavailable",
        message: "A governed Secret Store binding service is not configured.",
      };
    }
    const result = await this.#bindCredentialReference(context);
    const secretBinding = opaqueBinding(result);
    return result?.ok === true
      && /^sha256:[a-f0-9]{16,64}$/.test(result?.credentialBindingFingerprint)
      ? {
          ok: true,
          credentialState: "bound",
          credentialBindingFingerprint: result.credentialBindingFingerprint,
          ...(secretBinding ? { secretBinding } : {}),
        }
      : {
          ok: false,
          code: result?.code ?? "connection_credential_binding_failed",
          message: result?.message ?? "The credential reference could not be bound.",
        };
  }

  async probe(context) {
    const binding = await this.#credentialBindingResolver(context);
    if (!binding || binding.state !== "bound" || !bindingMatchesExpectedFingerprint(binding, context)) {
      return {
        ok: false,
        code: binding?.state === "bound"
          ? "connection_credential_binding_mismatch"
          : binding?.state === "expired"
          ? "connection_credential_expired"
          : "connection_credential_unbound",
        message: binding?.state === "expired"
          ? "The Lark credential binding expired."
          : "Bind a governed Lark credential before validating.",
      };
    }
    if (typeof this.#probeAccount !== "function") {
      return {
        ok: false,
        code: "connection_probe_unavailable",
        message: "A real Lark account probe is not configured.",
      };
    }
    const result = await this.#probeAccount({ ...context, binding });
    if (result?.ok !== true) {
      return {
        ok: false,
        code: result?.code ?? "connection_probe_failed",
        message: result?.message ?? "The Lark account probe failed.",
      };
    }
    return {
      ok: true,
      principal: String(result.principal ?? "").slice(0, 200),
      scopes: normalizeStrings(result.scopes),
      effects: normalizeStrings(result.effects),
      expiresAt: typeof result.expiresAt === "string" ? result.expiresAt : null,
    };
  }

  async validate({ probe }) {
    if (
      probe?.ok !== true
      || typeof probe.principal !== "string"
      || probe.principal.length === 0
      || !Array.isArray(probe.scopes)
      || !Array.isArray(probe.effects)
    ) {
      return {
        ok: false,
        code: "connection_scope_validation_failed",
        message: "The Lark connection did not return a verifiable principal and permission set.",
      };
    }
    return probe;
  }

  refresh(context) {
    return this.probe(context);
  }

  async resolveRuntimeBinding(context) {
    const binding = await this.#credentialBindingResolver(context);
    if (!binding || binding.state !== "bound") {
      return {
        ok: false,
        code: binding?.state === "expired"
          ? "connection_credential_expired"
          : "connection_credential_unbound",
      };
    }
    if (typeof binding.profile !== "string" || binding.profile.length === 0) {
      return {
        ok: false,
        code: "connection_runtime_binding_unavailable",
      };
    }
    const credentialBindingFingerprint = binding.credentialBindingFingerprint
      ?? binding.bindingFingerprint;
    if (
      typeof context.expectedCredentialBindingFingerprint !== "string"
      || credentialBindingFingerprint !== context.expectedCredentialBindingFingerprint
    ) {
      return {
        ok: false,
        code: "connection_credential_binding_mismatch",
      };
    }
    return {
      ok: true,
      binding: {
        profile: binding.profile,
      },
      credentialBindingFingerprint,
    };
  }

  async revoke(context) {
    if (typeof this.#revokeBinding !== "function") return { revoked: false };
    return this.#revokeBinding(context);
  }
}

function bindingMatchesExpectedFingerprint(binding, context) {
  const expected = context?.expectedCredentialBindingFingerprint;
  const actual = binding?.credentialBindingFingerprint ?? binding?.bindingFingerprint;
  return typeof expected !== "string" || expected.length === 0 || actual === expected;
}

function opaqueBinding(result) {
  const binding = result?.secretBinding ?? result?.binding;
  if (
    binding?.secretSource !== "cloud_secret_store"
    || typeof binding?.storeBindingRef !== "string" || binding.storeBindingRef.length === 0
    || !Number.isInteger(binding?.storeBindingRevision) || binding.storeBindingRevision < 1
    || !/^sha256:[a-f0-9]{16,64}$/.test(binding?.credentialBindingFingerprint ?? result?.credentialBindingFingerprint ?? "")
  ) return null;
  return {
    secretSource: binding.secretSource,
    storeBindingRef: binding.storeBindingRef,
    storeBindingRevision: binding.storeBindingRevision,
    credentialBindingFingerprint: binding.credentialBindingFingerprint ?? result.credentialBindingFingerprint,
    ...(typeof binding.expiresAt === "string" ? { expiresAt: binding.expiresAt } : {}),
  };
}

function normalizeStrings(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === "string" && item.length > 0)
      .map((item) => item.slice(0, 200)),
  )].sort();
}
