import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export function compareCanonical(left, right) {
  return compareText(canonicalStringify(left), canonicalStringify(right));
}

export function sha256Canonical(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalStringify(value), "utf8")
    .digest("hex")}`;
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }

  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}
