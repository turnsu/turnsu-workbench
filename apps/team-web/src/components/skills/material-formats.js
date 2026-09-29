const FORMAT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "markdown",
    labels: Object.freeze({ zh: "Markdown", en: "Markdown" }),
    mediaTypes: Object.freeze(["text/markdown"]),
    extensions: Object.freeze([".md"]),
  }),
  Object.freeze({
    id: "text",
    labels: Object.freeze({ zh: "TXT", en: "TXT" }),
    mediaTypes: Object.freeze(["text/plain"]),
    extensions: Object.freeze([".txt"]),
  }),
  Object.freeze({
    id: "csv",
    labels: Object.freeze({ zh: "CSV", en: "CSV" }),
    mediaTypes: Object.freeze(["text/csv"]),
    extensions: Object.freeze([".csv"]),
  }),
  Object.freeze({
    id: "pdf",
    labels: Object.freeze({ zh: "PDF", en: "PDF" }),
    mediaTypes: Object.freeze(["application/pdf"]),
    extensions: Object.freeze([".pdf"]),
  }),
  Object.freeze({
    id: "word",
    labels: Object.freeze({ zh: "Word (.docx)", en: "Word (.docx)" }),
    mediaTypes: Object.freeze([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]),
    extensions: Object.freeze([".docx"]),
  }),
  Object.freeze({
    id: "excel",
    labels: Object.freeze({ zh: "Excel (.xlsx)", en: "Excel (.xlsx)" }),
    mediaTypes: Object.freeze([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]),
    extensions: Object.freeze([".xlsx"]),
  }),
  Object.freeze({
    id: "image",
    labels: Object.freeze({ zh: "图片", en: "Images" }),
    mediaTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
    extensions: Object.freeze([".png", ".jpg", ".jpeg", ".webp"]),
  }),
]);

const MEDIA_TYPE_BY_EXTENSION = Object.freeze(Object.fromEntries(
  FORMAT_DEFINITIONS.flatMap((format) => format.extensions.map((extension) => [
    extension.slice(1),
    format.mediaTypes.length === 1
      ? format.mediaTypes[0]
      : extension === ".png"
        ? "image/png"
        : extension === ".webp"
          ? "image/webp"
          : "image/jpeg",
  ])),
));

const EXTENSIONS_BY_MEDIA_TYPE = Object.freeze({
  "text/markdown": Object.freeze([".md"]),
  "text/plain": Object.freeze([".txt"]),
  "text/csv": Object.freeze([".csv"]),
  "application/pdf": Object.freeze([".pdf"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze([".docx"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": Object.freeze([".xlsx"]),
  "image/png": Object.freeze([".png"]),
  "image/jpeg": Object.freeze([".jpg", ".jpeg"]),
  "image/webp": Object.freeze([".webp"]),
});

const MEDIA_TYPE_LABELS = Object.freeze({
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
});

export const SUPPORTED_MATERIAL_MEDIA_TYPES = Object.freeze([
  ...new Set(FORMAT_DEFINITIONS.flatMap((format) => format.mediaTypes)),
]);

export function materialFormatOptions(locale = "en") {
  const language = String(locale).toLowerCase().startsWith("zh") ? "zh" : "en";
  return FORMAT_DEFINITIONS.map((format) => ({
    id: format.id,
    label: format.labels[language],
    mediaTypes: [...format.mediaTypes],
  }));
}

export function normalizeMaterialMediaTypes(value, { defaultToAll = false } = {}) {
  const accepted = new Set(
    Array.isArray(value)
      ? value.filter((mediaType) => SUPPORTED_MATERIAL_MEDIA_TYPES.includes(mediaType))
      : [],
  );
  if (accepted.size === 0 && defaultToAll) {
    return [...SUPPORTED_MATERIAL_MEDIA_TYPES];
  }
  return SUPPORTED_MATERIAL_MEDIA_TYPES.filter((mediaType) => accepted.has(mediaType));
}

export function materialMediaTypeForFile(file) {
  const declared = String(file?.type || "").toLowerCase();
  if (SUPPORTED_MATERIAL_MEDIA_TYPES.includes(declared)) return declared;
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase() || "";
  return MEDIA_TYPE_BY_EXTENSION[extension] || "";
}

export function acceptsMaterialMediaType(acceptedMediaTypes, mediaType) {
  const accepted = normalizeMaterialMediaTypes(acceptedMediaTypes, { defaultToAll: true });
  return accepted.includes(String(mediaType || "").toLowerCase());
}

export function materialAcceptAttribute(acceptedMediaTypes) {
  const accepted = new Set(normalizeMaterialMediaTypes(
    acceptedMediaTypes,
    { defaultToAll: true },
  ));
  return SUPPORTED_MATERIAL_MEDIA_TYPES
    .filter((mediaType) => accepted.has(mediaType))
    .flatMap((mediaType) => EXTENSIONS_BY_MEDIA_TYPE[mediaType] || [])
    .join(",");
}

export function materialFormatSummary(acceptedMediaTypes, locale = "en") {
  const accepted = new Set(normalizeMaterialMediaTypes(
    acceptedMediaTypes,
    { defaultToAll: true },
  ));
  return materialFormatOptions(locale).flatMap((format) => {
    const selected = format.mediaTypes.filter((mediaType) => accepted.has(mediaType));
    if (selected.length === 0) return [];
    if (selected.length === format.mediaTypes.length) return [format.label];
    return selected.map((mediaType) => MEDIA_TYPE_LABELS[mediaType] || format.label);
  }).join(" / ");
}

export function toggleMaterialFormat(acceptedMediaTypes, formatId) {
  const format = FORMAT_DEFINITIONS.find((item) => item.id === formatId);
  if (!format) return normalizeMaterialMediaTypes(acceptedMediaTypes);
  const selected = new Set(normalizeMaterialMediaTypes(acceptedMediaTypes));
  const active = format.mediaTypes.every((mediaType) => selected.has(mediaType));
  for (const mediaType of format.mediaTypes) {
    if (active) selected.delete(mediaType);
    else selected.add(mediaType);
  }
  return SUPPORTED_MATERIAL_MEDIA_TYPES.filter((mediaType) => selected.has(mediaType));
}
