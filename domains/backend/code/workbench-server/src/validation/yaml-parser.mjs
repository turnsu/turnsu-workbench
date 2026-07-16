import YAML from "yaml";

export function parseYamlDocument(source) {
  if (typeof source !== "string") throw new TypeError("yaml_source_required");
  const document = YAML.parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new SyntaxError("yaml_document_invalid");
  }
  return document.toJS({ maxAliasCount: 0 });
}
