import { parseYamlDocument } from "./yaml-parser.mjs";

export function parseStrictJson(source) {
  if (typeof source !== "string") throw new TypeError("json_source_required");
  let value;
  try {
    value = JSON.parse(source);
    // JSON.parse accepts duplicate object keys. The YAML parser decodes the same
    // JSON grammar while rejecting duplicate keys, including escaped key aliases.
    parseYamlDocument(source);
  } catch {
    throw new SyntaxError("strict_json_invalid");
  }
  return value;
}
