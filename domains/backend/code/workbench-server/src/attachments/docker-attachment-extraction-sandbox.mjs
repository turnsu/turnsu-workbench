import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const DIGEST_PIN = /@sha256:[a-f0-9]{64}$/;
const MANAGED_TEMP_DIRECTORY = "looloomi-attachment-extraction-v1";
const WORK_DIRECTORY_PREFIX = "workbench-attachment-";
const WORK_DIRECTORY_NAME = /^workbench-attachment-[A-Za-z0-9]{6}$/;

const workerPath = fileURLToPath(
  new URL("./attachment-extractor-worker.mjs", import.meta.url),
);

export class DockerAttachmentExtractionSandbox {
  #image;
  #dockerBinary;
  #spawnProcess;
  #tempRoot;
  #timeoutMs;

  constructor({
    image,
    dockerBinary = "docker",
    spawnProcess = spawn,
    tempRoot = tmpdir(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof image !== "string" || !DIGEST_PIN.test(image)) {
      throw new TypeError("attachment_extractor_image_must_be_digest_pinned");
    }
    if (
      typeof dockerBinary !== "string"
      || dockerBinary.length === 0
      || typeof spawnProcess !== "function"
      || typeof tempRoot !== "string"
      || tempRoot.length === 0
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < 1_000
      || timeoutMs > DEFAULT_TIMEOUT_MS
    ) {
      throw new TypeError("attachment_extractor_sandbox_dependencies_invalid");
    }
    this.#image = image;
    this.#dockerBinary = dockerBinary;
    this.#spawnProcess = spawnProcess;
    this.#tempRoot = resolve(tempRoot, MANAGED_TEMP_DIRECTORY);
    this.#timeoutMs = timeoutMs;
  }

  async initialize() {
    await prepareManagedTempRoot(this.#tempRoot);
    const entries = await readdir(this.#tempRoot, { withFileTypes: true });
    const owned = entries.filter((entry) => (
      entry.isDirectory() && WORK_DIRECTORY_NAME.test(entry.name)
    ));
    const removed = [];
    for (const entry of owned) {
      const path = join(this.#tempRoot, entry.name);
      if (await cleanupManagedWorkDirectory(path, this.#tempRoot)) removed.push(entry.name);
    }
    return { removed };
  }

  async extract({ bytes, mediaType, signal } = {}) {
    if (signal?.aborted) throw abortError();
    await prepareManagedTempRoot(this.#tempRoot);
    const root = await mkdtemp(join(this.#tempRoot, WORK_DIRECTORY_PREFIX));
    const inputDir = join(root, "input");
    const outputDir = join(root, "output");
    const inputPath = join(inputDir, "source.bin");
    const outputPath = join(outputDir, "result.json");
    try {
      await mkdir(inputDir, { mode: 0o755 });
      await mkdir(outputDir, { mode: 0o777 });
      await writeFile(inputPath, Buffer.from(bytes), { mode: 0o444 });
      await chmod(inputDir, 0o555);
      const args = [
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--user", "65532:65532",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", "256m",
        "--cpus", "1",
        "--pids-limit", "64",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--mount", `type=bind,src=${inputPath},dst=/input/source.bin,readonly`,
        "--mount", `type=bind,src=${outputDir},dst=/output`,
        "--mount", `type=bind,src=${workerPath},dst=/worker/attachment-extractor-worker.mjs,readonly`,
        this.#image,
        "node",
        "/worker/attachment-extractor-worker.mjs",
        "/input/source.bin",
        "/output/result.json",
        mediaType,
      ];
      let executionFailure = null;
      try {
        await runDocker(this.#spawnProcess, this.#dockerBinary, args, {
          signal,
          timeoutMs: this.#timeoutMs,
        });
      } catch (error) {
        executionFailure = error;
      }
      let raw;
      try {
        raw = await readFile(outputPath);
      } catch {
        throw executionFailure ?? sandboxError(
          "attachment_processing_failed",
          "Attachment extraction failed in the sandbox.",
        );
      }
      if (raw.byteLength > MAX_RESULT_BYTES) {
        throw sandboxError("attachment_limit_exceeded", "The extracted representation is too large.");
      }
      const result = JSON.parse(raw.toString("utf8"));
      if (!result?.ok) {
        const code = normalizeSandboxCode(result?.code);
        throw sandboxError(
          code,
          sandboxMessage(code),
        );
      }
      if (executionFailure) throw executionFailure;
      return {
        kind: result.kind,
        text: result.text,
        evidence: Array.isArray(result.evidence) ? result.evidence : [],
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error?.name === "AttachmentSandboxError") throw error;
      if (error?.code === "ENOENT" || error?.code === 125 || error?.code === 126 || error?.code === 127) {
        throw sandboxError(
          "attachment_processing_unavailable",
          "The attachment extraction sandbox is unavailable.",
        );
      }
      throw sandboxError(
        "attachment_processing_failed",
        "Attachment extraction failed in the sandbox.",
      );
    } finally {
      await cleanupManagedWorkDirectory(root, this.#tempRoot).catch(() => {});
    }
  }
}

async function prepareManagedTempRoot(root) {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("managed_temp_root_invalid");
    await chmod(root, 0o700);
  } catch {
    throw sandboxError(
      "attachment_processing_unavailable",
      "The attachment extraction sandbox is unavailable.",
    );
  }
}

async function cleanupManagedWorkDirectory(root, managedRoot) {
  const normalizedRoot = resolve(root);
  if (
    dirname(normalizedRoot) !== managedRoot
    || !WORK_DIRECTORY_NAME.test(basename(normalizedRoot))
  ) {
    throw sandboxError(
      "attachment_processing_unavailable",
      "The attachment extraction sandbox is unavailable.",
    );
  }
  let info;
  try {
    info = await lstat(normalizedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw sandboxError(
      "attachment_processing_unavailable",
      "The attachment extraction sandbox is unavailable.",
    );
  }
  await chmod(normalizedRoot, 0o700);
  await chmod(join(normalizedRoot, "input"), 0o700).catch(() => {});
  await chmod(join(normalizedRoot, "output"), 0o700).catch(() => {});
  await rm(normalizedRoot, { recursive: true, force: true });
  try {
    await lstat(normalizedRoot);
    throw new Error("managed_work_directory_still_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return true;
}

function runDocker(spawnProcess, binary, args, { signal, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProcess(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        DOCKER_HOST: process.env.DOCKER_HOST,
      },
    });
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectPromise(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return rejectPromise(abortError());
      if (code === 0) return resolvePromise();
      const error = sandboxError(
        code === null ? "attachment_processing_unavailable" : "attachment_processing_failed",
        code === null
          ? "The attachment extraction sandbox is unavailable."
          : "Attachment extraction failed in the sandbox.",
      );
      error.code = code === 125 ? "attachment_processing_unavailable" : error.code;
      rejectPromise(error);
    });
  });
}

function sandboxError(code, message) {
  const error = new Error(message);
  error.name = "AttachmentSandboxError";
  error.code = code;
  return error;
}

function normalizeSandboxCode(value) {
  const allowed = new Set([
    "attachment_format_unsupported",
    "attachment_ocr_required",
    "attachment_too_large",
    "attachment_limit_exceeded",
    "attachment_integrity_failed",
    "attachment_mime_mismatch",
    "attachment_macro_forbidden",
    "attachment_path_traversal",
    "attachment_malicious_package",
    "attachment_processing_unavailable",
    "attachment_processing_failed",
  ]);
  return allowed.has(value) ? value : "attachment_processing_failed";
}

function sandboxMessage(code) {
  return {
    attachment_format_unsupported: "This attachment format is not supported.",
    attachment_ocr_required: "This PDF needs OCR before it can be used.",
    attachment_too_large: "The attachment is too large to process.",
    attachment_limit_exceeded: "The attachment exceeds a processing limit.",
    attachment_integrity_failed: "The attachment failed its integrity check.",
    attachment_mime_mismatch: "The attachment content does not match its declared media type.",
    attachment_macro_forbidden: "Files containing macros are not allowed.",
    attachment_path_traversal: "The attachment package contains an unsafe path.",
    attachment_malicious_package: "The attachment package is not safe to process.",
    attachment_processing_unavailable: "The attachment extraction sandbox is unavailable.",
    attachment_processing_failed: "Attachment extraction failed in the sandbox.",
  }[normalizeSandboxCode(code)];
}

function abortError() {
  const error = new Error("The attachment extraction was cancelled.");
  error.name = "AbortError";
  error.code = "cancelled";
  return error;
}
