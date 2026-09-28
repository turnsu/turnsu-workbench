export const ZIP_SKILL_PACKAGE_LIMITS = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024,
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxDepth: 12,
  maxPathLength: 320,
  maxCompressionRatio: 1000,
});

export class ZipSkillPackageError extends Error {
  constructor(code) {
    super(code);
    this.name = "ZipSkillPackageError";
    this.code = code;
  }
}

let fflateModulePromise;

async function loadFflate() {
  try {
    fflateModulePromise ||= import("fflate");
    return await fflateModulePromise;
  } catch {
    // A transient chunk or filesystem failure should remain retryable.
    fflateModulePromise = undefined;
    throw new ZipSkillPackageError("zip_unpack_failed");
  }
}

export async function unpackZipSkillPackage(file, suppliedLimits = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw new ZipSkillPackageError("zip_file_required");
  const limits = { ...ZIP_SKILL_PACKAGE_LIMITS, ...suppliedLimits };
  const archiveBytes = Number(file.size);
  if (!Number.isFinite(archiveBytes) || archiveBytes <= 0 || archiveBytes > limits.maxArchiveBytes) {
    throw new ZipSkillPackageError("zip_archive_size_invalid");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.byteLength !== archiveBytes) throw new ZipSkillPackageError("zip_archive_size_invalid");
  const files = await unpackZipBytes(data, limits);
  return {
    filename: String(file.name || "skill-package.zip"),
    files: files.map(({ path, bytes }) => ({ path, contentBase64: encodeBytes(bytes), sizeBytes: bytes.byteLength })),
    sizeBytes: files.reduce((total, fileEntry) => total + fileEntry.bytes.byteLength, 0),
  };
}

export async function unpackZipBytes(data, suppliedLimits = {}) {
  const limits = { ...ZIP_SKILL_PACKAGE_LIMITS, ...suppliedLimits };
  if (!(data instanceof Uint8Array) || data.byteLength <= 0 || data.byteLength > limits.maxArchiveBytes) {
    throw new ZipSkillPackageError("zip_archive_size_invalid");
  }
  const { AsyncUnzipInflate, Unzip } = await loadFflate();

  return new Promise((resolve, reject) => {
    const entries = new Map();
    const streams = new Set();
    let fileCount = 0;
    let totalBytes = 0;
    let activeStreams = 0;
    let archiveParsed = false;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      for (const stream of streams) stream.terminate?.();
      reject(error instanceof ZipSkillPackageError ? error : new ZipSkillPackageError("zip_unpack_failed"));
    }

    function finishIfReady() {
      if (settled || !archiveParsed || activeStreams !== 0) return;
      try {
        settled = true;
        resolve(normalizeArchiveRoot([...entries.values()]));
      } catch (error) {
        settled = false;
        fail(error);
      }
    }

    const unzip = new Unzip((stream) => {
      if (settled) return;
      let path;
      try {
        path = validateZipEntryPath(stream.name, limits);
      } catch (error) {
        fail(error);
        return;
      }
      if (!path) return;
      fileCount += 1;
      if (fileCount > limits.maxFiles || entries.has(path)) {
        fail(new ZipSkillPackageError(fileCount > limits.maxFiles ? "zip_file_limit_exceeded" : "zip_duplicate_path"));
        return;
      }
      const expectedSize = Number(stream.originalSize);
      const compressedSize = Number(stream.size);
      if (Number.isFinite(expectedSize) && (expectedSize < 0 || expectedSize > limits.maxFileBytes || totalBytes + expectedSize > limits.maxTotalBytes)) {
        fail(new ZipSkillPackageError("zip_uncompressed_size_exceeded"));
        return;
      }
      if (Number.isFinite(expectedSize) && Number.isFinite(compressedSize) && compressedSize > 0 && expectedSize / compressedSize > limits.maxCompressionRatio) {
        fail(new ZipSkillPackageError("zip_compression_ratio_exceeded"));
        return;
      }

      const chunks = [];
      let fileBytes = 0;
      activeStreams += 1;
      streams.add(stream);
      stream.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        fileBytes += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (fileBytes > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) {
          fail(new ZipSkillPackageError("zip_uncompressed_size_exceeded"));
          return;
        }
        chunks.push(chunk.slice());
        if (!final) return;
        streams.delete(stream);
        activeStreams -= 1;
        if (Number.isFinite(expectedSize) && expectedSize !== fileBytes) {
          fail(new ZipSkillPackageError("zip_size_mismatch"));
          return;
        }
        entries.set(path, { path, bytes: concatChunks(chunks, fileBytes) });
        finishIfReady();
      };
      try {
        stream.start();
      } catch (error) {
        fail(error);
      }
    });
    unzip.register(AsyncUnzipInflate);
    try {
      unzip.push(data, true);
      archiveParsed = true;
      finishIfReady();
    } catch (error) {
      fail(error);
    }
  });
}

function validateZipEntryPath(value, limits) {
  const path = String(value || "");
  if (!path || /[\\\u0000-\u001f\u007f]/.test(path) || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new ZipSkillPackageError("zip_path_invalid");
  }
  if (path.endsWith("/")) return null;
  if (path.length > limits.maxPathLength) throw new ZipSkillPackageError("zip_path_invalid");
  const parts = path.split("/");
  if (parts.length > limits.maxDepth || parts.some((part) => !part || part === "." || part === "..")) {
    throw new ZipSkillPackageError("zip_path_invalid");
  }
  return parts.join("/");
}

function normalizeArchiveRoot(entries) {
  if (!entries.length) throw new ZipSkillPackageError("zip_empty");
  const rootNames = new Set(entries.map(({ path }) => path.split("/", 1)[0]));
  const stripRoot = rootNames.size === 1 && entries.every(({ path }) => path.includes("/"));
  const normalized = new Map();
  for (const entry of entries) {
    const path = stripRoot ? entry.path.slice(entry.path.indexOf("/") + 1) : entry.path;
    if (!path || normalized.has(path)) throw new ZipSkillPackageError("zip_duplicate_path");
    normalized.set(path, { ...entry, path });
  }
  return [...normalized.values()];
}

function concatChunks(chunks, size) {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function encodeBytes(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}
