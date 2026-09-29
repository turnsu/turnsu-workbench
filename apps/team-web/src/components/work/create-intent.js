function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().flatMap((key) => (
      value[key] === undefined ? [] : [[key, stableValue(value[key])]]
    )),
  );
}

const defaultIdFactory = (kind) => (
  `${kind}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
);

/**
 * One dialog-open interval is one creation intent. An unchanged retry keeps
 * its command identity so a response lost after commit resolves to the first
 * object. Editing after an attempt or opening a fresh dialog starts a new
 * intent and therefore a new idempotency key.
 */
export function createStableCreationIntent({ kind, idFactory = defaultIdFactory } = {}) {
  if (typeof kind !== "string" || !kind || typeof idFactory !== "function") {
    throw new TypeError("creation_intent_configuration_invalid");
  }
  let idempotencyKey = "";
  let attemptedFingerprint = null;

  const begin = () => {
    idempotencyKey = idFactory(kind);
    attemptedFingerprint = null;
    return idempotencyKey;
  };

  return Object.freeze({
    begin,
    reset() {
      idempotencyKey = "";
      attemptedFingerprint = null;
    },
    keyFor(data) {
      const fingerprint = JSON.stringify(stableValue(data));
      if (!idempotencyKey || (attemptedFingerprint !== null && attemptedFingerprint !== fingerprint)) {
        begin();
      }
      attemptedFingerprint = fingerprint;
      return idempotencyKey;
    },
  });
}

export function isCreationOutcomeUnknown(error) {
  return error?.retryable === true
    || ["workbench_unreachable", "workbench_response_invalid"].includes(error?.code);
}
