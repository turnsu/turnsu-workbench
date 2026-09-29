export const SUPPORTED_MATERIAL_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SUPPORTED = new Set(SUPPORTED_MATERIAL_MEDIA_TYPES);

export function normalizeAcceptedMaterialMediaTypes(value, { defaultToAll = true } = {}) {
  if (value === undefined && defaultToAll) return [...SUPPORTED_MATERIAL_MEDIA_TYPES];
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > SUPPORTED_MATERIAL_MEDIA_TYPES.length
    || value.some((mediaType) => typeof mediaType !== "string" || !SUPPORTED.has(mediaType))
    || new Set(value).size !== value.length
  ) {
    throw new TypeError("skill_material_media_types_invalid");
  }
  const selected = new Set(value);
  return SUPPORTED_MATERIAL_MEDIA_TYPES.filter((mediaType) => selected.has(mediaType));
}

export function acceptsMaterialMediaType(acceptedMediaTypes, mediaType) {
  return normalizeAcceptedMaterialMediaTypes(
    acceptedMediaTypes,
    { defaultToAll: true },
  ).includes(mediaType);
}
