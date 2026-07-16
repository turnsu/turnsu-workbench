import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{16,64}$/;
const STORE_FORMAT = "workbench-object-store-v1";
const UPLOAD_STORE_FORMAT = "workbench-resumable-upload-v1";
const UPLOAD_STAGING_DIRECTORY = ".uploads";
const MAX_UPLOAD_CHUNKS = 10_000;

export class ObjectStoreError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class FilesystemObjectStore {
  #rootDir;
  #maxObjectBytes;
  #now;

  constructor({ rootDir, maxObjectBytes = 64 * 1024 * 1024, now = () => new Date().toISOString() } = {}) {
    if (typeof rootDir !== "string" || rootDir.length === 0) {
      throw new ObjectStoreError("object_store_root_required", "An object store root is required.");
    }
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
      throw new ObjectStoreError("object_store_limit_invalid", "The object size limit is invalid.");
    }
    this.#rootDir = resolve(rootDir);
    this.#maxObjectBytes = maxObjectBytes;
    this.#now = now;
  }

  async initialize() {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 });
    const root = await lstat(this.#rootDir);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new ObjectStoreError("object_store_root_invalid", "The object store root is invalid.");
    }
    this.#rootDir = await realpath(this.#rootDir);
    return this;
  }

  async put({ workspaceId, objectId, bytes, contentHash = null, mediaType, metadata = {}, state = "quarantined", signal } = {}) {
    throwIfAborted(signal);
    validateAddress(workspaceId, objectId);
    validateMediaType(mediaType);
    validateState(state);
    validateMetadata(metadata);

    const location = await this.#location(workspaceId, objectId);
    const current = await readRecord(location);
    if (current) {
      const received = await digestBytes(bytes, this.#maxObjectBytes, signal);
      validateExpectedHash(contentHash, received.hash);
      if (current.contentHash !== received.hash || current.sizeBytes !== received.sizeBytes) {
        throw new ObjectStoreError("object_id_conflict", "This object identifier already refers to different content.");
      }
      return publicObject(current, { existed: true });
    }

    await mkdir(location.workspaceDir, { recursive: true, mode: 0o700 });
    await assertOwnedDirectory(this.#rootDir, location.workspaceDir);
    const temporary = `${location.bytesPath}.${randomUUID()}.tmp`;
    const received = await writeAndDigest(temporary, bytes, this.#maxObjectBytes, signal);
    try {
      validateExpectedHash(contentHash, received.hash);
      const record = {
        storeFormat: STORE_FORMAT,
        objectId,
        workspaceId,
        contentHash: received.hash,
        sizeBytes: received.sizeBytes,
        mediaType,
        metadata: structuredClone(metadata),
        state,
        createdAt: this.#now(),
        updatedAt: this.#now(),
      };
      try {
        await link(temporary, location.bytesPath);
        await rm(temporary, { force: true });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = await readRecord(location);
        if (raced?.contentHash === received.hash && raced.sizeBytes === received.sizeBytes) {
          return publicObject(raced, { existed: true });
        }
        throw new ObjectStoreError("object_id_conflict", "This object identifier already refers to different content.");
      }
      await atomicWriteJson(location.recordPath, record);
      return publicObject(record, { existed: false });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError("object_store_write_failed", "The object could not be stored.", { retryable: true });
    }
  }

  async stat({ workspaceId, objectId } = {}) {
    validateAddress(workspaceId, objectId);
    const record = await readRecord(await this.#location(workspaceId, objectId));
    if (!record) throw new ObjectStoreError("object_not_found", "The requested object was not found.");
    return publicObject(record);
  }

  async read({ workspaceId, objectId, signal } = {}) {
    throwIfAborted(signal);
    validateAddress(workspaceId, objectId);
    const location = await this.#location(workspaceId, objectId);
    const record = await readRecord(location);
    if (!record) throw new ObjectStoreError("object_not_found", "The requested object was not found.");
    const data = await readFile(location.bytesPath);
    throwIfAborted(signal);
    const contentHash = hashBuffer(data);
    if (contentHash !== record.contentHash || data.byteLength !== record.sizeBytes) {
      throw new ObjectStoreError("object_integrity_failed", "The stored object failed an integrity check.");
    }
    return { object: publicObject(record), bytes: data };
  }

  async list({ workspaceId, state = null } = {}) {
    validatePart(workspaceId, "workspace identifier");
    if (state !== null) validateState(state);
    const workspaceDir = await this.#workspaceDir(workspaceId);
    let entries = [];
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw new ObjectStoreError("object_store_read_failed", "Objects could not be listed.", { retryable: true });
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await readRecordPath(join(workspaceDir, entry.name));
      if (record && (state === null || record.state === state)) records.push(publicObject(record));
    }
    return records.sort((left, right) => left.objectId.localeCompare(right.objectId));
  }

  async promote({ workspaceId, objectId } = {}) {
    validateAddress(workspaceId, objectId);
    const location = await this.#location(workspaceId, objectId);
    const record = await readRecord(location);
    if (!record) throw new ObjectStoreError("object_not_found", "The requested object was not found.");
    if (record.state === "promoted") return publicObject(record);
    if (record.state !== "quarantined") {
      throw new ObjectStoreError("object_state_invalid", "Only quarantined objects can be promoted.");
    }
    const next = { ...record, state: "promoted", updatedAt: this.#now() };
    await atomicWriteJson(location.recordPath, next);
    return publicObject(next);
  }

  async deleteQuarantine({ workspaceId, objectId } = {}) {
    validateAddress(workspaceId, objectId);
    const location = await this.#location(workspaceId, objectId);
    const record = await readRecord(location);
    if (!record) return { deleted: false };
    if (record.state !== "quarantined") {
      throw new ObjectStoreError("quarantine_delete_forbidden", "Only quarantined objects can be deleted here.");
    }
    await rm(location.bytesPath, { force: true });
    await rm(location.recordPath, { force: true });
    return { deleted: true };
  }

  async writeUploadChunk({
    workspaceId,
    uploadId,
    chunkIndex,
    totalChunks,
    expectedSizeBytes,
    bytes,
    signal,
  } = {}) {
    throwIfAborted(signal);
    validateUploadAddress(workspaceId, uploadId);
    validateUploadDeclaration(totalChunks, expectedSizeBytes, this.#maxObjectBytes);
    validateChunkIndex(chunkIndex, totalChunks);

    const location = this.#uploadLocation(workspaceId, uploadId);
    try {
      await this.#ensureUploadDirectory(location);
      const proposed = {
        storeFormat: UPLOAD_STORE_FORMAT,
        workspaceId,
        uploadId,
        totalChunks,
        expectedSizeBytes,
        createdAt: this.#now(),
      };
      const created = await atomicCreateJson(location.manifestPath, proposed);
      const manifest = created ? proposed : await readUploadManifest(location);
      assertUploadDeclaration(manifest, { workspaceId, uploadId, totalChunks, expectedSizeBytes });

      const data = await collectBytes(bytes, this.#maxObjectBytes, signal, {
        code: "upload_chunk_too_large",
        message: "The upload chunk exceeds the allowed size.",
      });
      if (data.byteLength > expectedSizeBytes) {
        throw new ObjectStoreError("upload_size_exceeded", "The upload exceeds its declared total size.");
      }

      const chunkPath = join(location.uploadDir, `${chunkIndex}.part`);
      const temporary = `${chunkPath}.${randomUUID()}.tmp`;
      let existed = false;
      try {
        await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
        try {
          await link(temporary, chunkPath);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          existed = true;
          const current = await readUploadChunkFile(chunkPath);
          if (!current.equals(data)) {
            throw new ObjectStoreError(
              "upload_chunk_conflict",
              "This chunk index already contains different bytes.",
            );
          }
        }
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }

      const status = await buildUploadStatus(location, manifest);
      if (status.receivedBytes > expectedSizeBytes) {
        if (!existed) await rm(chunkPath, { force: true });
        throw new ObjectStoreError("upload_size_exceeded", "The upload exceeds its declared total size.");
      }
      return { ...status, existed };
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError("upload_staging_write_failed", "The upload chunk could not be staged.", {
        retryable: true,
      });
    }
  }

  async getUploadStatus({ workspaceId, uploadId } = {}) {
    validateUploadAddress(workspaceId, uploadId);
    const location = this.#uploadLocation(workspaceId, uploadId);
    try {
      if (!await this.#assertUploadDirectory(location)) {
        throw new ObjectStoreError("upload_not_found", "The requested upload was not found.");
      }
      const manifest = await readUploadManifest(location);
      if (!manifest) throw new ObjectStoreError("upload_not_found", "The requested upload was not found.");
      assertUploadDeclaration(manifest, { workspaceId, uploadId });
      return buildUploadStatus(location, manifest);
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      throw new ObjectStoreError("upload_staging_read_failed", "The upload status could not be read.", {
        retryable: true,
      });
    }
  }

  async assembleUpload({ workspaceId, uploadId, signal } = {}) {
    throwIfAborted(signal);
    const status = await this.getUploadStatus({ workspaceId, uploadId });
    if (status.receivedChunkIndexes.length !== status.totalChunks) {
      throw new ObjectStoreError("upload_incomplete", "All upload chunks are required before assembly.");
    }

    const location = this.#uploadLocation(workspaceId, uploadId);
    const chunks = [];
    let sizeBytes = 0;
    for (let index = 0; index < status.totalChunks; index += 1) {
      throwIfAborted(signal);
      const chunk = await readUploadChunkFile(join(location.uploadDir, `${index}.part`));
      chunks.push(chunk);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > this.#maxObjectBytes) {
        throw new ObjectStoreError("upload_size_exceeded", "The upload exceeds the allowed size.");
      }
    }
    if (sizeBytes !== status.expectedSizeBytes) {
      throw new ObjectStoreError("upload_size_mismatch", "The upload size does not match its declaration.");
    }
    return { upload: status, bytes: Buffer.concat(chunks, sizeBytes) };
  }

  async cleanupUpload({ workspaceId, uploadId } = {}) {
    validateUploadAddress(workspaceId, uploadId);
    const location = this.#uploadLocation(workspaceId, uploadId);
    try {
      if (!await this.#assertUploadDirectory(location)) return { deleted: false };
      await rm(location.uploadDir, { recursive: true, force: false });
      return { deleted: true };
    } catch (error) {
      if (error instanceof ObjectStoreError) throw error;
      if (error?.code === "ENOENT") return { deleted: false };
      throw new ObjectStoreError("upload_staging_cleanup_failed", "The upload staging data could not be removed.", {
        retryable: true,
      });
    }
  }

  async #location(workspaceId, objectId) {
    const workspaceDir = await this.#workspaceDir(workspaceId);
    return {
      workspaceDir,
      bytesPath: join(workspaceDir, `${objectId}.bin`),
      recordPath: join(workspaceDir, `${objectId}.json`),
    };
  }

  async #workspaceDir(workspaceId) {
    validatePart(workspaceId, "workspace identifier");
    const workspaceDir = join(this.#rootDir, workspaceId);
    if (!workspaceDir.startsWith(`${this.#rootDir}/`)) {
      throw new ObjectStoreError("object_store_path_invalid", "The object address is invalid.");
    }
    return workspaceDir;
  }

  #uploadLocation(workspaceId, uploadId) {
    const stagingRoot = join(this.#rootDir, UPLOAD_STAGING_DIRECTORY);
    const workspaceDir = join(stagingRoot, workspaceId);
    const uploadDir = join(workspaceDir, uploadId);
    if (!uploadDir.startsWith(`${stagingRoot}/`)) {
      throw new ObjectStoreError("object_store_path_invalid", "The upload address is invalid.");
    }
    return {
      stagingRoot,
      workspaceDir,
      uploadDir,
      manifestPath: join(uploadDir, "manifest.json"),
    };
  }

  async #ensureUploadDirectory(location) {
    await assertPlainDirectory(this.#rootDir, this.#rootDir);
    await ensurePlainDirectory(this.#rootDir, location.stagingRoot);
    await ensurePlainDirectory(this.#rootDir, location.workspaceDir);
    await ensurePlainDirectory(this.#rootDir, location.uploadDir);
  }

  async #assertUploadDirectory(location) {
    await assertPlainDirectory(this.#rootDir, this.#rootDir);
    for (const directory of [location.stagingRoot, location.workspaceDir, location.uploadDir]) {
      try {
        await assertPlainDirectory(this.#rootDir, directory);
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }
}

export async function createFilesystemObjectStore(options) {
  return new FilesystemObjectStore(options).initialize();
}

function validateAddress(workspaceId, objectId) {
  validatePart(workspaceId, "workspace identifier");
  validatePart(objectId, "object identifier");
}

function validateUploadAddress(workspaceId, uploadId) {
  validatePart(workspaceId, "workspace identifier");
  validatePart(uploadId, "upload identifier");
}

function validateUploadDeclaration(totalChunks, expectedSizeBytes, maxObjectBytes) {
  if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_UPLOAD_CHUNKS) {
    throw new ObjectStoreError("upload_declaration_invalid", "The declared chunk count is invalid.");
  }
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 0 || expectedSizeBytes > maxObjectBytes) {
    throw new ObjectStoreError("upload_declaration_invalid", "The declared upload size is invalid.");
  }
}

function validateChunkIndex(chunkIndex, totalChunks) {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new ObjectStoreError("upload_chunk_index_invalid", "The upload chunk index is invalid.");
  }
}

function validatePart(value, label) {
  if (typeof value !== "string" || !SAFE_PART.test(value)) {
    throw new ObjectStoreError("object_store_address_invalid", `The ${label} is invalid.`);
  }
}

function validateMediaType(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 128 || /[\r\n]/.test(value)) {
    throw new ObjectStoreError("object_media_type_invalid", "The object media type is invalid.");
  }
}

function validateState(value) {
  if (value !== "quarantined" && value !== "promoted") {
    throw new ObjectStoreError("object_state_invalid", "The object state is invalid.");
  }
}

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ObjectStoreError("object_metadata_invalid", "The object metadata is invalid.");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || typeof value !== "string" || value.length > 1000) {
      throw new ObjectStoreError("object_metadata_invalid", "The object metadata is invalid.");
    }
  }
}

function validateExpectedHash(expected, actual) {
  if (expected === null || expected === undefined) return;
  if (typeof expected !== "string" || !SHA256.test(expected) || expected !== actual) {
    throw new ObjectStoreError("object_hash_mismatch", "The object content hash did not match the uploaded content.");
  }
}

async function assertOwnedDirectory(rootDir, target) {
  const actual = await realpath(target);
  if (actual !== rootDir && !actual.startsWith(`${rootDir}/`)) {
    throw new ObjectStoreError("object_store_path_invalid", "The object address is invalid.");
  }
  const info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ObjectStoreError("object_store_path_invalid", "The object address is invalid.");
  }
}

async function ensurePlainDirectory(rootDir, target) {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertPlainDirectory(rootDir, target);
}

async function assertPlainDirectory(rootDir, target) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new ObjectStoreError("object_store_path_invalid", "The upload staging path is invalid.");
  }
  const actual = await realpath(target);
  if (actual !== target || (actual !== rootDir && !actual.startsWith(`${rootDir}/`))) {
    throw new ObjectStoreError("object_store_path_invalid", "The upload staging path is invalid.");
  }
}

async function readRecord(location) {
  return readRecordPath(location.recordPath);
}

async function readRecordPath(recordPath) {
  try {
    const info = await lstat(recordPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ObjectStoreError("object_store_read_failed", "The stored object could not be read.");
    }
    const raw = await readFile(recordPath, "utf8");
    const record = JSON.parse(raw);
    if (!isRecord(record)) return null;
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ObjectStoreError("object_store_read_failed", "The stored object could not be read.", { retryable: true });
  }
}

function isRecord(value) {
  return value
    && value.storeFormat === STORE_FORMAT
    && typeof value.workspaceId === "string"
    && typeof value.objectId === "string"
    && SHA256.test(value.contentHash)
    && Number.isSafeInteger(value.sizeBytes)
    && typeof value.mediaType === "string"
    && (value.state === "quarantined" || value.state === "promoted")
    && value.metadata
    && typeof value.metadata === "object";
}

async function readUploadManifest(location) {
  try {
    const info = await lstat(location.manifestPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
    const manifest = JSON.parse(await readFile(location.manifestPath, "utf8"));
    if (!isUploadManifest(manifest)) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
    return manifest;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
  }
}

function isUploadManifest(value) {
  return value
    && value.storeFormat === UPLOAD_STORE_FORMAT
    && typeof value.workspaceId === "string"
    && SAFE_PART.test(value.workspaceId)
    && typeof value.uploadId === "string"
    && SAFE_PART.test(value.uploadId)
    && Number.isSafeInteger(value.totalChunks)
    && value.totalChunks >= 1
    && value.totalChunks <= MAX_UPLOAD_CHUNKS
    && Number.isSafeInteger(value.expectedSizeBytes)
    && value.expectedSizeBytes >= 0
    && typeof value.createdAt === "string";
}

function assertUploadDeclaration(manifest, expected) {
  if (!manifest) {
    throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && manifest[key] !== value) {
      throw new ObjectStoreError("upload_declaration_conflict", "The upload declaration cannot be changed.");
    }
  }
}

async function buildUploadStatus(location, manifest) {
  const entries = await readdir(location.uploadDir, { withFileTypes: true });
  const receivedChunkIndexes = [];
  let receivedBytes = 0;
  for (const entry of entries) {
    const match = /^(0|[1-9][0-9]*)\.part$/.exec(entry.name);
    if (!match) continue;
    const chunkIndex = Number(match[1]);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex >= manifest.totalChunks || !entry.isFile() || entry.isSymbolicLink()) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
    const info = await lstat(join(location.uploadDir, entry.name));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
    receivedChunkIndexes.push(chunkIndex);
    receivedBytes += info.size;
    if (!Number.isSafeInteger(receivedBytes)) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
  }
  receivedChunkIndexes.sort((left, right) => left - right);
  return {
    workspaceId: manifest.workspaceId,
    uploadId: manifest.uploadId,
    totalChunks: manifest.totalChunks,
    expectedSizeBytes: manifest.expectedSizeBytes,
    receivedChunkIndexes,
    receivedBytes,
    complete: receivedChunkIndexes.length === manifest.totalChunks
      && receivedBytes === manifest.expectedSizeBytes,
  };
}

async function readUploadChunkFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
    }
    return await readFile(path);
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError("upload_staging_invalid", "The upload staging data is invalid.");
  }
}

async function atomicWriteJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function atomicCreateJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function digestBytes(bytes, limit, signal) {
  let sizeBytes = 0;
  const digest = createHash("sha256");
  for await (const chunk of iterableBytes(bytes)) {
    throwIfAborted(signal);
    const data = toBuffer(chunk);
    sizeBytes += data.byteLength;
    if (sizeBytes > limit) throw new ObjectStoreError("object_too_large", "The object exceeds the allowed size.");
    digest.update(data);
  }
  return { sizeBytes, hash: `sha256:${digest.digest("hex")}` };
}

async function writeAndDigest(path, bytes, limit, signal) {
  let sizeBytes = 0;
  const digest = createHash("sha256");
  const chunks = [];
  for await (const chunk of iterableBytes(bytes)) {
    throwIfAborted(signal);
    const data = toBuffer(chunk);
    sizeBytes += data.byteLength;
    if (sizeBytes > limit) throw new ObjectStoreError("object_too_large", "The object exceeds the allowed size.");
    digest.update(data);
    chunks.push(data);
  }
  await writeFile(path, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
  return { sizeBytes, hash: `sha256:${digest.digest("hex")}` };
}

async function collectBytes(bytes, limit, signal, { code, message }) {
  let sizeBytes = 0;
  const chunks = [];
  for await (const chunk of iterableBytes(bytes)) {
    throwIfAborted(signal);
    const data = toBuffer(chunk);
    sizeBytes += data.byteLength;
    if (sizeBytes > limit) throw new ObjectStoreError(code, message);
    chunks.push(data);
  }
  return Buffer.concat(chunks, sizeBytes);
}

async function* iterableBytes(bytes) {
  if (Buffer.isBuffer(bytes) || bytes instanceof Uint8Array || typeof bytes === "string") {
    yield bytes;
    return;
  }
  if (bytes && typeof bytes[Symbol.asyncIterator] === "function") {
    yield* bytes;
    return;
  }
  if (bytes && typeof bytes[Symbol.iterator] === "function") {
    yield* bytes;
    return;
  }
  throw new ObjectStoreError("object_bytes_required", "Object bytes are required.");
}

function toBuffer(value) {
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new ObjectStoreError("object_bytes_invalid", "Object bytes are invalid.");
}

function hashBuffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function publicObject(record, { existed = false } = {}) {
  return {
    objectId: record.objectId,
    workspaceId: record.workspaceId,
    contentHash: record.contentHash,
    sizeBytes: record.sizeBytes,
    mediaType: record.mediaType,
    metadata: structuredClone(record.metadata),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    existed,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ObjectStoreError("object_store_aborted", "The object operation was cancelled.", { retryable: true });
  }
}
