function encodeText(content) {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

function yamlText(value) {
  return JSON.stringify(String(value || "").trim());
}

export function smokeTestInputJson(value, inputSchema) {
  const text = String(value ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify(parsed, null, 2);
  } catch {}
  const parameters = Object.entries(inputSchema?.properties ?? {}).filter(([, field]) => field?.format !== "attachment");
  const key = parameters.length === 1 ? parameters[0][0] : "input";
  return JSON.stringify({ [key]: text }, null, 2);
}

export function registeredToolSkillPackage(toolPackage) {
  if (!toolPackage
    || toolPackage.registrationStatus !== "registered"
    || typeof toolPackage.skillName !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(toolPackage.skillName)
    || typeof toolPackage.description !== "string"
    || !Array.isArray(toolPackage.actions)
    || toolPackage.actions.length === 0) {
    throw new TypeError("registered_tool_package_invalid");
  }
  const actions = toolPackage.actions.map((action) => {
    if (!action
      || typeof action.actionId !== "string"
      || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(action.actionId)) {
      throw new TypeError("registered_tool_action_invalid");
    }
    return action.actionId;
  });
  if (new Set(actions).size !== actions.length) throw new TypeError("registered_tool_action_invalid");
  const description = toolPackage.description.trim().replace(/[\r\n]+/g, " ");
  const source = `---
name: ${toolPackage.skillName}
description: ${yamlText(description)}
compatibility: Local only
disable-model-invocation: false
tools:
${actions.map((actionId) => `  - action: ${actionId}`).join("\n")}
---

# ${String(toolPackage.label || toolPackage.skillName).trim()}

${description}

## Governed Tool boundary

This Skill may call only the exact Product-approved Action IDs declared above. Credentials, provider payloads, commands, and connection secrets remain owned by the Product Tool Gateway.
`;
  return [{ path: "SKILL.md", contentBase64: encodeText(source) }];
}

export function packageSize(files) {
  return (files || []).reduce((size, file) => size + Uint8Array.from(
    globalThis.atob(file.contentBase64),
    (char) => char.charCodeAt(0),
  ).byteLength, 0);
}
