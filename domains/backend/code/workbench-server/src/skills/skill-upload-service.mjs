import { createHash, randomUUID } from "node:crypto";

import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import {
  hashPortableLoopPackage,
  parsePortableLoopPackage,
  PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
} from "../loops/portable-loop-package.mjs";
import {
  assertExecutableSkillPackage,
  formatSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  parseSkillPackage,
  SKILL_PACKAGE_MEDIA_TYPE,
  SKILL_RUNTIME_MANIFEST_PATH,
} from "./skill-package-format.mjs";

const MAX_PUBLIC_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 12 * 1024 * 1024;
const RESUMABLE_CHUNK_BYTES = 512 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function createSkillUploadService(options) {
  return new SkillUploadService(options);
}

export class SkillUploadService {
  #store;
  #objectStore;
  #clock;
  #idFactory;
  #repositorySource;

  constructor({
    store,
    objectStore,
    repositorySource = null,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (
      !store?.connect
      || !store?.authorizeWorkspace
      || !store?.runIdempotentMutation
      || !store?.runIdempotentExternalMutation
      || !store?.withTransaction
    ) {
      throw new TypeError("skill_upload_store_required");
    }
    if (!objectStore?.put || !objectStore?.promote || !objectStore?.stat || !objectStore?.read) {
      throw new TypeError("skill_upload_object_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("skill_upload_dependencies_invalid");
    }
    this.#store = store;
    this.#objectStore = objectStore;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#repositorySource = repositorySource;
  }

  async createUpload({
    workspaceId,
    requestedBy,
    idempotencyKey,
    filename,
    sizeBytes,
    mediaType,
    assetKind = "skill",
    ingestMethod = "files",
    idempotencyContext = null,
    uploadId = null,
  }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    assertText(filename, "upload_filename_required");
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_PACKAGE_BYTES) {
      throw error("upload_size_invalid", "The upload size is invalid.");
    }
    assertText(mediaType, "upload_media_type_required");
    if (!['skill', 'loop'].includes(assetKind)) {
      throw error("upload_asset_kind_invalid", "The upload type is unsupported.");
    }
    if (assetKind === "loop" && ingestMethod !== "resumable") {
      throw error("upload_ingest_method_invalid", "Loop packages use the resumable upload method.");
    }
    if (!["files", "resumable", "repository"].includes(ingestMethod)) {
      throw error("upload_ingest_method_invalid", "The upload method is unsupported.");
    }
    const totalChunks = ingestMethod === "resumable"
      ? Math.max(1, Math.ceil(sizeBytes / RESUMABLE_CHUNK_BYTES))
      : 0;
    return this.#store.runIdempotentMutation({
      scope: "create-skill-upload",
      key: idempotencyKey,
      workspaceId,
      effectivePrincipalId: requestedBy,
      request: { requestedBy, filename, sizeBytes, mediaType, assetKind, ingestMethod, idempotencyContext },
    }, async (session) => {
      const now = timestamp(this.#clock);
      const upload = {
        schemaVersion: "workbench-v1",
        uploadId: uploadId || this.#idFactory("upload"),
        assetKind,
        workspaceId,
        requestedBy,
        state: "selecting",
        objectId: null,
        filename,
        sizeBytes,
        mediaType,
        ingestMethod,
        transfer: {
          chunkSizeBytes: ingestMethod === "resumable" ? RESUMABLE_CHUNK_BYTES : 0,
          totalChunks,
          receivedChunks: [],
          receivedBytes: 0,
          complete: false,
        },
        findings: [],
        createdAt: now,
        updatedAt: now,
      };
      const inserted = await this.#store.repositories.uploads.insert(upload, { session });
      return publicUpload(inserted);
    });
  }

  async uploadChunk({ workspaceId, requestedBy, uploadId, idempotencyKey, chunkIndex, content }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if (upload.state !== "selecting" || upload.ingestMethod !== "resumable") {
      throw error("upload_state_invalid", "This upload is not waiting for resumable package data.");
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.transfer.totalChunks) {
      throw error("upload_chunk_invalid", "The upload chunk number is invalid.");
    }
    const bytes = Buffer.from(content);
    const expected = expectedChunkBytes(upload, chunkIndex);
    if (bytes.byteLength !== expected) {
      throw error("upload_chunk_size_invalid", "The upload chunk size does not match this upload session.");
    }
    return this.#store.runIdempotentMutation({
      scope: `upload-skill-chunk:${uploadId}:${chunkIndex}`,
      key: idempotencyKey,
      workspaceId,
      effectivePrincipalId: requestedBy,
      request: { requestedBy, uploadId, chunkIndex, sizeBytes: bytes.byteLength },
    }, async (session) => {
      const current = await this.#readUpload({ workspaceId, requestedBy, uploadId, session });
      const transfer = await this.#objectStore.writeUploadChunk({
        workspaceId,
        uploadId,
        chunkIndex,
        totalChunks: current.transfer.totalChunks,
        expectedSizeBytes: current.sizeBytes,
        bytes,
      });
      const next = await this.#store.repositories.uploads.patch(uploadId, {
        transfer: {
          ...current.transfer,
          receivedChunks: transfer.receivedChunkIndexes,
          receivedBytes: transfer.receivedBytes,
          complete: transfer.complete,
        },
        updatedAt: timestamp(this.#clock),
      }, { workspaceId, session });
      return publicUpload(next);
    });
  }

  async completeUpload({ workspaceId, requestedBy, uploadId, idempotencyKey }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if (upload.state !== "selecting" || upload.ingestMethod !== "resumable") {
      throw error("upload_state_invalid", "This upload cannot be completed from resumable data.");
    }
    const assembled = await this.#objectStore.assembleUpload({
      workspaceId,
      uploadId,
    });
    if ((upload.assetKind ?? "skill") === "loop") {
      const result = await this.#completePortableLoopUpload({
        workspaceId,
        requestedBy,
        upload,
        idempotencyKey,
        bytes: assembled.bytes,
      });
      await this.#objectStore.cleanupUpload?.({ workspaceId, uploadId }).catch(() => {});
      return result;
    }
    let files;
    try {
      files = parseSkillPackage(assembled.bytes);
    } catch {
      throw error("upload_package_invalid", "The uploaded package could not be read.");
    }
    const result = await this.inspectUpload({
      workspaceId,
      requestedBy,
      uploadId,
      idempotencyKey,
      files,
    });
    await this.#objectStore.cleanupUpload?.({ workspaceId, uploadId }).catch(() => {});
    return result;
  }

  async importRepository({
    workspaceId,
    requestedBy,
    idempotencyKey,
    repositoryUrl,
    ref,
    skillDirectory,
  }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    if (!this.#repositorySource?.readSkillFiles) {
      throw error("repository_import_unavailable", "Repository import is not configured for this Workbench.");
    }
    return this.#store.runIdempotentExternalMutation({
      scope: "import-skill-repository",
      key: idempotencyKey,
      request: { requestedBy, repositoryUrl, ref, skillDirectory },
      workspaceId,
      effectivePrincipalId: requestedBy,
      operationIdKind: "upload",
      recover: async (uploadId) => {
        const upload = await this.#store.repositories.uploads.get(uploadId, { workspaceId });
        return upload && upload.requestedBy === requestedBy && upload.state !== "selecting"
          ? publicUpload(upload)
          : null;
      },
    }, async (uploadId) => {
      const imported = await this.#repositorySource.readSkillFiles({ repositoryUrl, ref, skillDirectory });
      const packageBytes = formatSkillPackage(imported.files);
      const upload = await this.createUpload({
        workspaceId,
        requestedBy,
        idempotencyKey: `${idempotencyKey}:session`,
        filename: imported.filename,
        sizeBytes: packageBytes.byteLength,
        mediaType: SKILL_PACKAGE_MEDIA_TYPE,
        ingestMethod: "repository",
        idempotencyContext: { repositoryUrl, ref, skillDirectory },
        uploadId,
      });
      const current = await this.getUpload({ workspaceId, requestedBy, uploadId: upload.uploadId });
      if (current.state !== "selecting") return current;
      return this.inspectUpload({
        workspaceId,
        requestedBy,
        uploadId: upload.uploadId,
        idempotencyKey: `${idempotencyKey}:inspection`,
        files: imported.files,
      });
    });
  }

  async getUpload({ workspaceId, requestedBy, uploadId }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    return publicUpload(upload);
  }

  async resolvePortableLoopUpload({ workspaceId, requestedBy, uploadId }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if (
      (upload.assetKind ?? "skill") !== "loop"
      || upload.state !== "ready_draft"
      || !upload.objectId
    ) {
      throw error("loop_upload_not_ready", "Finish checking the Loop package before importing it.");
    }
    const stored = await this.#objectStore.read({ workspaceId, objectId: upload.objectId });
    if (
      stored.object.state !== "quarantined"
      || stored.object.mediaType !== PORTABLE_LOOP_PACKAGE_MEDIA_TYPE
    ) {
      throw error("loop_upload_not_ready", "The Loop package is no longer available for import.");
    }
    let portableLoop;
    try {
      portableLoop = parsePortableLoopPackage(stored.bytes);
    } catch {
      throw error("loop_package_invalid", "The Loop package could not be read.");
    }
    const contentHash = hashPortableLoopPackage(stored.bytes);
    if (contentHash !== stored.object.contentHash) {
      throw error("loop_package_integrity_failed", "The Loop package failed an integrity check.");
    }
    return { uploadId, contentHash, portableLoop };
  }

  async getDraftPackage({ workspaceId, requestedBy, skillId, draftId }) {
    await this.#authorize(workspaceId, requestedBy, "viewer");
    const { skill, draft } = await this.#store.getSkillDraft({ skillId, draftId, workspaceId });
    if (skill.ownerId !== requestedBy) {
      throw error("skill_owner_required", "Only the private Skill owner can access this draft.");
    }
    if (skill.currentDraftId !== draftId) {
      throw error("skill_draft_stale", "Only the current Skill draft can be edited.");
    }
    const packageFile = draft.files?.find((file) => file?.objectId && file?.contentHash);
    if (!packageFile) {
      throw error("skill_package_unavailable", "This Skill draft does not have an editable package.");
    }
    const resolved = await this.#readPromotedPackage({
      workspaceId,
      objectId: packageFile.objectId,
      expectedContentHash: packageFile.contentHash,
    });
    return {
      skillId,
      skillDraftId: draftId,
      revision: draft.revision,
      files: resolved.files
        .map(productFile)
        .sort((left, right) => (left.kind === right.kind ? left.path.localeCompare(right.path) : left.kind === "instructions" ? -1 : 1)),
    };
  }

  async resolvePromotedPackage({ workspaceId, requestedBy, uploadId }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if (upload.state !== "promoted" || !upload.objectId) {
      throw error("skill_package_not_promoted", "Promote this Skill package before using it in a draft.");
    }
    const resolved = await this.#readPromotedPackage({ workspaceId, objectId: upload.objectId });
    return {
      uploadId,
      objectId: resolved.object.objectId,
      contentHash: resolved.object.contentHash,
      mediaType: resolved.object.mediaType,
      sizeBytes: resolved.object.sizeBytes,
    };
  }

  async inspectUpload({ workspaceId, requestedBy, uploadId, idempotencyKey, files }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if ((upload.assetKind ?? "skill") !== "skill") {
      throw error("upload_asset_kind_invalid", "This upload is not a Skill package.");
    }
    if (upload.state !== "selecting") {
      throw error("upload_state_invalid", "This upload is no longer waiting for package files.");
    }
    const inspection = inspectSkillPackage({ files });
    const packageBytes = formatSkillPackage(files);
    const objectHash = hashSkillPackageObject(packageBytes);
    const objectId = objectIdForSkillPackage(objectHash);
    const object = await this.#objectStore.put({
      workspaceId,
      objectId,
      bytes: packageBytes,
      contentHash: objectHash,
      mediaType: SKILL_PACKAGE_MEDIA_TYPE,
      metadata: { filename: upload.filename, source: "skill-upload" },
      state: "quarantined",
    });

    try {
      return await this.#store.runIdempotentMutation({
        scope: `inspect-skill-upload:${uploadId}`,
        key: idempotencyKey,
        workspaceId,
        effectivePrincipalId: requestedBy,
        request: { requestedBy, uploadId, packageContentHash: inspection.contentHash, objectContentHash: object.contentHash },
      }, async (session) => {
        const current = await this.#readUpload({ workspaceId, requestedBy, uploadId, session });
        if (current.state !== "selecting") {
          throw error("upload_state_invalid", "This upload is no longer waiting for package files.");
        }
        const existingObject = await this.#store.repositories.objects.get(objectId, { workspaceId, session });
        if (!existingObject) {
          await this.#store.repositories.objects.insert({
            schemaVersion: "workbench-v1",
            objectId,
            workspaceId,
            contentHash: object.contentHash,
            sizeBytes: object.sizeBytes,
            mediaType: object.mediaType,
            createdAt: object.createdAt,
          }, { session });
        }
        const state = inspection.status === "passed"
          ? "ready_draft"
          : inspection.status === "needs_review"
            ? "needs_decision"
            : "failed";
        const next = await this.#store.repositories.uploads.patch(uploadId, {
          objectId,
          state,
          findings: inspection.diagnostics.map(toFinding),
          inspection: internalInspection(inspection),
          transfer: {
            ...(current.transfer ?? upload.transfer),
            receivedBytes: upload.ingestMethod === "resumable" ? upload.sizeBytes : packageBytes.byteLength,
            complete: true,
          },
          updatedAt: timestamp(this.#clock),
        }, { workspaceId, session });
        return publicUpload(next);
      });
    } catch (failure) {
      if (!object.existed) {
        await this.#objectStore.deleteQuarantine?.({ workspaceId, objectId }).catch(() => {});
      }
      throw failure;
    }
  }

  async promoteUpload({
    workspaceId,
    requestedBy,
    uploadId,
    idempotencyKey,
    permissionAcknowledged = false,
  }) {
    await this.#authorize(workspaceId, requestedBy, "member");
    const upload = await this.#readUpload({ workspaceId, requestedBy, uploadId });
    if ((upload.assetKind ?? "skill") !== "skill") {
      throw error("upload_asset_kind_invalid", "Loop packages are committed through Loop import review.");
    }
    assertPromotable(upload, permissionAcknowledged);
    if (!upload.objectId) {
      throw error("upload_promotion_blocked", "Resolve package validation before promoting this upload.");
    }
    const object = await this.#objectStore.promote({ workspaceId, objectId: upload.objectId });
    return this.#store.runIdempotentMutation({
      scope: `promote-skill-upload:${uploadId}`,
      key: idempotencyKey,
      workspaceId,
      effectivePrincipalId: requestedBy,
      request: { requestedBy, uploadId, objectContentHash: object.contentHash, permissionAcknowledged },
    }, async (session) => {
      const current = await this.#readUpload({ workspaceId, requestedBy, uploadId, session });
      if (current.state === "promoted") return publicUpload(current);
      assertPromotable(current, permissionAcknowledged);
      if (current.objectId !== upload.objectId) {
        throw error("upload_promotion_blocked", "Resolve package validation before promoting this upload.");
      }
      const next = await this.#store.repositories.uploads.patch(uploadId, {
        state: "promoted",
        updatedAt: timestamp(this.#clock),
      }, { workspaceId, session });
      return publicUpload(next);
    });
  }

  async #authorize(workspaceId, userId, minimumRole) {
    assertText(workspaceId, "workspace_id_required");
    assertText(userId, "user_id_required");
    await this.#store.connect();
    return this.#store.authorizeWorkspace({ userId, workspaceId, minimumRole });
  }

  async #readUpload({ workspaceId, requestedBy, uploadId, session = undefined }) {
    assertText(uploadId, "upload_id_required");
    assertText(requestedBy, "user_id_required");
    const upload = await this.#store.repositories.uploads.get(uploadId, { workspaceId, session });
    if (!upload || upload.requestedBy !== requestedBy) {
      throw error("upload_not_found", "The upload was not found.");
    }
    return upload;
  }

  async #readPromotedPackage({ workspaceId, objectId, expectedContentHash = null }) {
    const stored = await this.#objectStore.read({ workspaceId, objectId });
    if (
      stored.object.state !== "promoted"
      || stored.object.mediaType !== SKILL_PACKAGE_MEDIA_TYPE
      || (expectedContentHash && stored.object.contentHash !== expectedContentHash)
    ) {
      throw error("skill_package_unavailable", "The promoted Skill package is unavailable.");
    }
    let files;
    try {
      files = assertExecutableSkillPackage(parseSkillPackage(stored.bytes));
      for (const file of files) {
        if (file.content.byteLength > MAX_PUBLIC_FILE_BYTES) {
          throw error("skill_package_unavailable", "A Skill package file is too large to edit.");
        }
        UTF8.decode(file.content);
      }
    } catch (failure) {
      if (failure instanceof ProductStoreError) throw failure;
      throw error("skill_package_unavailable", "The Skill package cannot be opened as editable text.");
    }
    return { object: stored.object, files };
  }

  async #completePortableLoopUpload({ workspaceId, requestedBy, upload, idempotencyKey, bytes }) {
    if (upload.mediaType !== PORTABLE_LOOP_PACKAGE_MEDIA_TYPE) {
      throw error("loop_package_invalid", "Choose a supported Loop package file.");
    }
    try {
      parsePortableLoopPackage(bytes);
    } catch {
      throw error("loop_package_invalid", "The Loop package could not be read.");
    }
    const contentHash = hashPortableLoopPackage(bytes);
    const objectId = workspaceObjectId(workspaceId, contentHash);
    const object = await this.#objectStore.put({
      workspaceId,
      objectId,
      bytes,
      contentHash,
      mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      metadata: { filename: upload.filename, source: "loop-upload" },
      state: "quarantined",
    });
    try {
      return await this.#store.runIdempotentMutation({
        scope: `complete-loop-upload:${upload.uploadId}`,
        key: idempotencyKey,
        workspaceId,
        effectivePrincipalId: requestedBy,
        request: { requestedBy, uploadId: upload.uploadId, contentHash },
      }, async (session) => {
        const current = await this.#readUpload({
          workspaceId,
          requestedBy,
          uploadId: upload.uploadId,
          session,
        });
        if (current.state !== "selecting" || (current.assetKind ?? "skill") !== "loop") {
          throw error("upload_state_invalid", "This Loop upload is no longer waiting for package data.");
        }
        const existingObject = await this.#store.repositories.objects.get(objectId, { workspaceId, session });
        if (!existingObject) {
          await this.#store.repositories.objects.insert({
            schemaVersion: "workbench-v1",
            objectId,
            workspaceId,
            contentHash: object.contentHash,
            sizeBytes: object.sizeBytes,
            mediaType: object.mediaType,
            createdAt: object.createdAt,
          }, { session });
        }
        const next = await this.#store.repositories.uploads.patch(upload.uploadId, {
          objectId,
          state: "ready_draft",
          findings: [],
          transfer: {
            ...current.transfer,
            receivedBytes: current.sizeBytes,
            complete: true,
          },
          updatedAt: timestamp(this.#clock),
        }, { workspaceId, session });
        return publicUpload(next);
      });
    } catch (failure) {
      if (!object.existed) {
        await this.#objectStore.deleteQuarantine?.({ workspaceId, objectId }).catch(() => {});
      }
      throw failure;
    }
  }
}

function productFile(file) {
  return {
    path: file.path,
    kind: file.path === "SKILL.md"
      ? "instructions"
      : file.path === SKILL_RUNTIME_MANIFEST_PATH
        ? "runtime_manifest"
        : "executable",
    sizeBytes: file.content.byteLength,
    content: UTF8.decode(file.content),
  };
}

function assertPromotable(upload, permissionAcknowledged) {
  if (upload?.state === "needs_decision" && permissionAcknowledged !== true) {
    throw error(
      "upload_review_acknowledgement_required",
      "Review the executable content and confirm the isolated permission boundary before continuing.",
    );
  }
  if (!upload || !["ready_draft", "needs_decision"].includes(upload.state)) {
    throw error("upload_promotion_blocked", "Resolve package validation before promoting this upload.");
  }
}

function toFinding(diagnostic) {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
  };
}

function publicUpload(value) {
  return {
    schemaVersion: value.schemaVersion,
    uploadId: value.uploadId,
    assetKind: value.assetKind ?? "skill",
    state: value.state,
    filename: value.filename,
    sizeBytes: value.sizeBytes,
    mediaType: value.mediaType,
    ingestMethod: value.ingestMethod ?? "files",
    transfer: {
      chunkSizeBytes: value.transfer?.chunkSizeBytes ?? 0,
      totalChunks: value.transfer?.totalChunks ?? 0,
      receivedChunks: [...(value.transfer?.receivedChunks ?? [])],
      receivedBytes: value.transfer?.receivedBytes ?? 0,
      complete: value.transfer?.complete === true,
    },
    findings: structuredClone(value.findings ?? []),
    ...(value.inspection ? { inspection: publicInspection(value.inspection) } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function workspaceObjectId(workspaceId, contentHash) {
  const address = createHash("sha256").update(`${workspaceId}\0${contentHash}`).digest("hex");
  return `object-${address}`;
}

function publicInspection(inspection) {
  return {
    status: inspection.status,
    manifest: inspection.manifest,
    inventory: inspection.inventory,
    diagnostics: inspection.diagnostics.map(toFinding),
  };
}

function internalInspection(inspection) {
  return {
    ...publicInspection(inspection),
    contentHash: inspection.contentHash,
  };
}

function expectedChunkBytes(upload, chunkIndex) {
  if (chunkIndex < upload.transfer.totalChunks - 1) return upload.transfer.chunkSizeBytes;
  return upload.sizeBytes - (upload.transfer.chunkSizeBytes * (upload.transfer.totalChunks - 1));
}

function timestamp(value) {
  const next = value();
  return next instanceof Date ? next.toISOString() : String(next);
}

function assertText(value, code) {
  if (typeof value !== "string" || value.length === 0) throw error(code, code);
}

function error(code, message) {
  return new ProductStoreError(code, message);
}
