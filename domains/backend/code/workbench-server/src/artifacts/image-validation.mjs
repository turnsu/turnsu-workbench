const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export class ArtifactImageValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ArtifactImageValidationError";
    this.code = code;
  }
}

export function validateImageBytes(bytes, mediaType, {
  maxWidth = 16_384,
  maxHeight = 16_384,
  maxPixels = 64 * 1024 * 1024,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    throw invalid("artifact_image_bytes_invalid");
  }
  if (!MEDIA_TYPES.has(mediaType)) throw invalid("artifact_media_type_unsupported");
  const dimensions = mediaType === "image/png"
    ? pngDimensions(bytes)
    : mediaType === "image/jpeg"
      ? jpegDimensions(bytes)
      : webpDimensions(bytes);
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1
    || width > maxWidth || height > maxHeight
    || width * height > maxPixels) {
    throw invalid("artifact_image_dimensions_invalid");
  }
  return Object.freeze({ width, height });
}

function pngDimensions(bytes) {
  if (bytes.byteLength < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalid("artifact_image_signature_invalid");
  }
  let offset = 8;
  let dimensions = null;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + length;
    if (!Number.isSafeInteger(next) || next > bytes.byteLength) throw invalid("artifact_image_invalid");
    if (offset === 8 && (type !== "IHDR" || length !== 13)) throw invalid("artifact_image_invalid");
    if (type === "IHDR") {
      if (dimensions) throw invalid("artifact_image_invalid");
      dimensions = { width: bytes.readUInt32BE(offset + 8), height: bytes.readUInt32BE(offset + 12) };
    }
    if (type === "IEND") {
      if (length !== 0 || next !== bytes.byteLength) throw invalid("artifact_image_invalid");
      sawEnd = true;
      break;
    }
    offset = next;
  }
  if (!dimensions || !sawEnd) throw invalid("artifact_image_invalid");
  return dimensions;
}

function jpegDimensions(bytes) {
  if (bytes.byteLength < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw invalid("artifact_image_signature_invalid");
  }
  let offset = 2;
  let dimensions = null;
  while (offset < bytes.byteLength - 2) {
    if (bytes[offset] !== 0xff) throw invalid("artifact_image_invalid");
    while (offset < bytes.byteLength - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength - 2) throw invalid("artifact_image_invalid");
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x00 || marker === 0xd8) throw invalid("artifact_image_invalid");
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) throw invalid("artifact_image_invalid");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) throw invalid("artifact_image_invalid");
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 8) throw invalid("artifact_image_invalid");
      dimensions = {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
      break;
    }
    if (marker === 0xda) break;
    offset += length;
  }
  if (!dimensions) throw invalid("artifact_image_invalid");
  return dimensions;
}

function webpDimensions(bytes) {
  if (bytes.byteLength < 26
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP"
    || bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    throw invalid("artifact_image_signature_invalid");
  }
  const type = bytes.toString("ascii", 12, 16);
  const chunkLength = bytes.readUInt32LE(16);
  if (20 + chunkLength + (chunkLength % 2) > bytes.byteLength) throw invalid("artifact_image_invalid");
  if (type === "VP8X") {
    if (chunkLength !== 10) throw invalid("artifact_image_invalid");
    return {
      width: readUInt24LE(bytes, 24) + 1,
      height: readUInt24LE(bytes, 27) + 1,
    };
  }
  if (type === "VP8 ") {
    if (chunkLength < 10 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw invalid("artifact_image_invalid");
    }
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (type === "VP8L") {
    if (chunkLength < 5 || bytes[20] !== 0x2f) throw invalid("artifact_image_invalid");
    const packed = bytes.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  throw invalid("artifact_image_invalid");
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function invalid(code) {
  return new ArtifactImageValidationError(code, "The image content is invalid.");
}
