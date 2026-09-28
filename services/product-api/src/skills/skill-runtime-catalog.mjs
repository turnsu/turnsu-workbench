import { createHash } from "node:crypto";

import { DIGEST_PINNED_CONTAINER_IMAGE } from "../runtime/container-sandbox-policy.mjs";
import { normalizeAcceptedMaterialMediaTypes } from "../attachments/material-media-types.mjs";

const LIMITS = Object.freeze({
  timeoutSeconds: Object.freeze({ minimum: 1, maximum: 120, step: 1, default: 30 }),
  memoryMiB: Object.freeze({ minimum: 64, maximum: 512, step: 64, default: 128 }),
});

const DEFINITIONS = Object.freeze([
  Object.freeze({
    runtimeId: "python3.12",
    label: "Python",
    language: "python",
    versionLabel: "Python 3.12",
    entrypoint: "scripts/main.py",
    starterSource: [
      "import json",
      "import sys",
      "",
      "def main():",
      "    payload = json.load(sys.stdin)",
      '    print(json.dumps({"result": payload.get("input", payload)}))',
      "",
      'if __name__ == "__main__":',
      "    main()",
      "",
    ].join("\n"),
  }),
  Object.freeze({
    runtimeId: "nodejs20-typescript",
    label: "Node.js · TypeScript",
    language: "typescript",
    versionLabel: "Node.js 20 · TypeScript",
    entrypoint: "scripts/main.ts",
    starterSource: [
      'import { readFileSync } from "node:fs";',
      "",
      'const payload = JSON.parse(readFileSync(0, "utf8"));',
      "const result = payload.input ?? payload;",
      'process.stdout.write(`${JSON.stringify({ result })}\\n`);',
      "",
    ].join("\n"),
  }),
]);

const DEFINITION_BY_ID = new Map(DEFINITIONS.map((definition) => [definition.runtimeId, definition]));

export class SkillRuntimeCatalogError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SkillRuntimeCatalogError";
    this.code = code;
  }
}

export function createSkillRuntimeCatalog({
  pythonImage = "",
  nodeImage = "",
} = {}) {
  const configured = {
    "python3.12": pythonImage,
    "nodejs20-typescript": nodeImage,
  };
  return Object.freeze(DEFINITIONS.map((definition) => {
    const image = configured[definition.runtimeId];
    const ready = typeof image === "string" && DIGEST_PINNED_CONTAINER_IMAGE.test(image);
    const { starterSource: _privateStarterSource, ...publicDefinition } = definition;
    return Object.freeze({
      ...publicDefinition,
      availability: ready ? "ready" : "unavailable",
      availabilityReason: ready
        ? null
        : "This isolated runtime has not been configured by a workspace administrator.",
      isolation: "container",
      network: false,
      filesystem: "scratch-only",
      timeoutSeconds: LIMITS.timeoutSeconds,
      memoryMiB: LIMITS.memoryMiB,
    });
  }));
}

export function readySkillRuntimeImages({
  pythonImage = "",
  nodeImage = "",
} = {}) {
  const images = new Map();
  if (DIGEST_PINNED_CONTAINER_IMAGE.test(pythonImage)) images.set("python3.12", pythonImage);
  if (DIGEST_PINNED_CONTAINER_IMAGE.test(nodeImage)) images.set("nodejs20-typescript", nodeImage);
  return images;
}

function normalizedSlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "").normalize("NFC")).digest("hex").slice(0, 8);
}

function skillIdentifier(value) {
  const displayName = String(value || "").trim();
  const normalized = normalizedSlug(displayName);
  if (normalized && normalized.length <= 64) return normalized;
  const prefix = normalized.slice(0, 55).replace(/-+$/g, "") || "skill";
  return `${prefix}-${shortHash(displayName)}`;
}

function base64(content) {
  return Buffer.from(content, "utf8").toString("base64");
}

function yamlText(value) {
  return JSON.stringify(String(value || "").trim());
}

function boundedText(value, maximum) {
  const text = String(value || "").trim();
  if (text.length <= maximum) return text;
  const bounded = text.slice(0, maximum);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

function interfaceNameBase(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^[^a-zA-Z]+/, "")
    .slice(0, 64);
  return normalized || fallback;
}

function uniqueInterfaceNames(entries, fallbackPrefix) {
  const names = new Set();
  return entries.map((entry, index) => {
    const original = interfaceNameBase(entry.name, `${fallbackPrefix}_${index + 1}`);
    let name = original;
    let suffixIndex = 2;
    while (names.has(name)) {
      const suffix = `_${suffixIndex}`;
      name = `${original.slice(0, 64 - suffix.length)}${suffix}`;
      suffixIndex += 1;
    }
    names.add(name);
    return { ...entry, name };
  });
}

function yamlInterfaces(key, entries, includeRequired) {
  if (!entries.length) return "";
  return `${key}:\n${entries.map((entry) => [
    `  - name: ${entry.name}`,
    ...(entry.title ? [`    title: ${yamlText(entry.title)}`] : []),
    `    type: ${entry.type}`,
    ...(includeRequired ? [`    required: ${entry.required ? "true" : "false"}`] : []),
    ...(entry.type === "file" ? [
      `    acceptedMediaTypes: [${entry.acceptedMediaTypes.map(yamlText).join(", ")}]`,
    ] : []),
    `    description: ${yamlText(entry.description)}`,
  ].join("\n")).join("\n")}\n`;
}

function markdownList(entries, emptyLabel) {
  return entries.length
    ? entries.map((entry) => `- **${entry.title || entry.name}** (${entry.type}${"required" in entry ? entry.required ? ", required" : ", optional" : ""}${entry.type === "file" ? `; ${entry.acceptedMediaTypes.join(", ")}` : ""}): ${entry.bodyDescription ?? entry.description}`).join("\n")
    : emptyLabel;
}

export function scaffoldSkillDraftPackage({ data, runtimeCatalog = [] } = {}) {
  const displayName = String(data?.name || "").trim();
  if (!displayName) throw new SkillRuntimeCatalogError("skill_draft_scaffold_invalid", "Skill name is invalid.");
  const name = skillIdentifier(displayName);
  if (data.definitionType === "script" && !data.runtime) {
    throw new SkillRuntimeCatalogError("skill_draft_scaffold_invalid", "Script Skills require a runtime selection.");
  }
  const inputs = uniqueInterfaceNames([
    ...(data.materials || []).map((item) => ({
      name: item.identifier || item.name,
      title: String(item.name).trim(),
      type: "file",
      required: item.required,
      acceptedMediaTypes: normalizeAcceptedMaterialMediaTypes(item.acceptedMediaTypes),
      description: boundedText(item.description, 1000),
      bodyDescription: String(item.description).trim(),
    })),
    ...(data.parameters || []).map((item) => ({
      name: item.name,
      type: item.type,
      required: item.required,
      description: boundedText(item.description, 1000),
      bodyDescription: String(item.description).trim(),
    })),
  ], "input");
  const outputs = uniqueInterfaceNames((data.outputs || []).map((item) => ({
    name: item.name,
    type: item.type,
    description: boundedText(item.description, 1000),
    bodyDescription: String(item.description).trim(),
  })), "result");
  const tags = (data.tags || []).slice(0, 12);
  const metadata = tags.length ? `metadata:\n  tags: [${tags.map(yamlText).join(", ")}]\n` : "";
  const runtimeGuidance = data.definitionType === "script"
    ? `## Draft test budget\n\n- Timeout: ${data.runtime.timeoutSeconds} seconds\n- Memory: ${data.runtime.memoryMiB} MiB\n\nThese are draft test settings. The governed runtime policy remains authoritative.\n\n`
    : "";
  const smoke = [
    data.smoke?.purpose,
    data.smoke?.input,
    data.smoke?.expectedOutcome,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const skillMarkdown = `---\nname: ${name}\ndescription: ${yamlText(boundedText(data.description, 1024))}\ncompatibility: Local only\ndisable-model-invocation: ${data.definitionType === "script" ? "true" : "false"}\n${yamlInterfaces("inputs", inputs, true)}${yamlInterfaces("outputs", outputs, false)}${metadata}---\n\n# ${displayName}\n\n${String(data.description).trim()}\n\n## Required materials and parameters\n\n${markdownList(inputs, "No materials or parameters are required.")}\n\n## Generated outputs\n\n${markdownList(outputs, "No declared output.")}\n\n${runtimeGuidance}${smoke.length ? `## Smoke-test notes\n\n${smoke.join("\n\n")}\n` : ""}`;
  const files = [{ path: "SKILL.md", contentBase64: base64(skillMarkdown) }];

  if (data.definitionType === "script") {
    const selected = runtimeCatalog.find((runtime) => runtime.runtimeId === data.runtime?.runtimeId);
    const definition = DEFINITION_BY_ID.get(data.runtime?.runtimeId);
    if (!selected || !definition) {
      throw new SkillRuntimeCatalogError("skill_runtime_not_found", "The selected Skill runtime does not exist.");
    }
    const timeout = data.runtime.timeoutSeconds;
    const memory = data.runtime.memoryMiB;
    if (timeout < selected.timeoutSeconds.minimum
      || timeout > selected.timeoutSeconds.maximum
      || (timeout - selected.timeoutSeconds.minimum) % selected.timeoutSeconds.step !== 0
      || memory < selected.memoryMiB.minimum
      || memory > selected.memoryMiB.maximum
      || (memory - selected.memoryMiB.minimum) % selected.memoryMiB.step !== 0) {
      throw new SkillRuntimeCatalogError("skill_runtime_limits_invalid", "The selected runtime limits are invalid.");
    }
    files.push({
      path: "skill.runtime.json",
      contentBase64: base64(JSON.stringify({
        runtime: selected.runtimeId,
        entrypoint: selected.entrypoint,
        protocol: { stdin: "json", stdout: "json" },
        permissions: {
          network: false,
          connections: [],
          externalActions: false,
          filesystem: "scratch-only",
        },
        limits: { timeoutSeconds: timeout, memoryMiB: memory },
      }, null, 2)),
    }, {
      path: definition.entrypoint,
      contentBase64: base64(definition.starterSource),
    });
  } else if (data.runtime) {
    throw new SkillRuntimeCatalogError("skill_draft_scaffold_invalid", "Prompt Skills cannot select a script runtime.");
  }

  const sizeBytes = files.reduce((total, file) => total + Buffer.from(file.contentBase64, "base64").byteLength, 0);
  return {
    filename: `${name}-${data.definitionType}-draft`,
    sizeBytes,
    files,
  };
}
