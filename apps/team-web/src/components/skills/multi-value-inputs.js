const MAX_SCENARIO_TAGS = 12;
const MAX_SCENARIO_TAG_LENGTH = 64;

function normalizedTag(value) {
  return String(value ?? "").normalize("NFKC").trim().slice(0, MAX_SCENARIO_TAG_LENGTH);
}

export function parseScenarioTags(value) {
  const source = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,，]/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const tag = normalizedTag(item);
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length === MAX_SCENARIO_TAGS) break;
  }
  return result;
}

export function appendScenarioTags(value, additions) {
  return parseScenarioTags([
    ...parseScenarioTags(value),
    ...String(additions ?? "").split(/[,，]/),
  ]);
}

export function removeScenarioTag(value, tagToRemove) {
  const target = normalizedTag(tagToRemove).toLocaleLowerCase();
  return parseScenarioTags(value).filter((tag) => tag.toLocaleLowerCase() !== target);
}

export const SCENARIO_TAG_LIMITS = Object.freeze({
  maxItems: MAX_SCENARIO_TAGS,
  maxLength: MAX_SCENARIO_TAG_LENGTH,
});
