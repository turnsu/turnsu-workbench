// Product-owned interface copy belongs in i18n. Object names, descriptions,
// node labels, and actor names are user/server data and must never be silently
// rewritten into demo fixtures or translated without a localized source field.

export function productTitle(entity) {
  return String(entity?.title || entity?.name || "");
}

export function productDescription(entity) {
  return String(entity?.description || entity?.releaseNotes || "");
}

export function productNodeTitle(node) {
  return String(node?.title || "");
}

export function productNodePurpose(node) {
  return String(node?.subtitle || node?.purpose || "");
}

export function productFieldLabel(label) {
  return String(label || "");
}

export function productActorName(value) {
  return String(value || "").trim();
}
