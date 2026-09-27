import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  assertExecutableSkillPackage,
  hashSkillPackageObject,
  objectIdForSkillPackage,
  parseSkillPackage,
  parseSkillRuntimeManifest,
  SKILL_RUNTIME_MANIFEST_PATH,
  SKILL_PACKAGE_MEDIA_TYPE,
  SkillPackageFormatError,
} from "../skills/skill-package-format.mjs";
import { inspectSkillPackage } from "../validation/skill-package-inspector.mjs";
import { parseStrictJson } from "../validation/strict-json-parser.mjs";
import {
  buildContainerIsolationArguments,
  DIGEST_PINNED_CONTAINER_IMAGE,
} from "./container-sandbox-policy.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
export const DOCKER_SKILL_OWNER_LABEL = "com.looloomi.workbench.skill-executor";
export const DOCKER_SKILL_OWNER_VALUE = "v1";
export const DOCKER_SKILL_INVOCATION_LABEL = "com.looloomi.workbench.skill-invocation";
const DOCKER_SKILL_VOLUME_SUFFIX = "-input";
const DOCKER_SKILL_STAGING_SUFFIX = "-staging";
const INVOCATION_DIRECTORY_PREFIX = "execution-";
const INVOCATION_MARKER = ".looloomi-skill-invocation.json";
const DOCKER_CONTROL_TIMEOUT_MS = 5_000;
const DOCKER_COPY_TIMEOUT_MS = 30_000;
const DEFAULT_LIMITS = Object.freeze({
  // Product policy ceilings. Each package requests a value through the
  // governed runtime manifest; older packages receive the catalog defaults.
  timeoutMs: 120_000,
  maxInputBytes: 256 * 1024,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxOutputBytes: 1024 * 1024,
  pids: 64,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 0.5,
  tmpfsBytes: 16 * 1024 * 1024,
});

export class DockerSkillExecutorError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "DockerSkillExecutorError";
    this.code = code;
    this.retryable = retryable;
    this.productSafe = true;
  }
}

export function createDockerSkillExecutor(options) {
  return new DockerSkillExecutor(options);
}

export class DockerSkillExecutor {
  #objectStore;
  #images;
  #dockerBinary;
  #dockerEnvironment;
  #spawnProcess;
  #dockerControl;
  #tempRoot;
  #limits;
  #idFactory;

  constructor({
    objectStore,
    image,
    imageDigest,
    images,
    dockerBinary = "docker",
    dockerEnvironment = defaultDockerEnvironment(),
    spawnProcess = spawn,
    dockerControl,
    tempRoot = join(tmpdir(), "looloomi-docker-skills"),
    limits = {},
    idFactory = randomUUID,
  } = {}) {
    if (!objectStore?.read) throw new TypeError("docker_skill_executor_object_store_required");
    const configuredImage = image ?? imageDigest;
    const configuredImages = normalizeRuntimeImages(images, configuredImage);
    if (configuredImages.size === 0) {
      throw new TypeError("docker_skill_executor_digest_pinned_image_required");
    }
    if (typeof dockerBinary !== "string" || dockerBinary.length === 0 || typeof spawnProcess !== "function") {
      throw new TypeError("docker_skill_executor_process_dependencies_invalid");
    }
    if (!isPlainObject(dockerEnvironment) || (dockerControl !== undefined && typeof dockerControl !== "function")) {
      throw new TypeError("docker_skill_executor_process_dependencies_invalid");
    }
    if (typeof tempRoot !== "string" || tempRoot.length === 0 || typeof idFactory !== "function") {
      throw new TypeError("docker_skill_executor_filesystem_dependencies_invalid");
    }
    this.#objectStore = objectStore;
    this.#images = configuredImages;
    this.#dockerBinary = dockerBinary;
    this.#dockerEnvironment = Object.freeze({ ...dockerEnvironment });
    this.#spawnProcess = spawnProcess;
    this.#dockerControl = dockerControl ?? ((args) => runDockerControl({
      dockerBinary: this.#dockerBinary,
      dockerEnvironment: this.#dockerEnvironment,
      spawnProcess: this.#spawnProcess,
      args,
    }));
    this.#tempRoot = tempRoot;
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
    this.#idFactory = idFactory;
  }

  async execute({
    workspaceId,
    objectId,
    objectContentHash,
    objectHash,
    expectedObjectHash,
    packageContentHash,
    packageHash,
    expectedPackageHash,
    inspection,
    inspectionSummary,
    input,
    materials = [],
    signal,
  } = {}) {
    let invocationRoot = null;
    let containerName = null;
    let stagingContainerName = null;
    let inputVolumeName = null;
    const resourceState = { mainContainer: false, stagingContainer: false, inputVolume: false };
    try {
      throwIfCancelled(signal);
      const requiredObjectHash = objectContentHash ?? objectHash ?? expectedObjectHash;
      const requiredPackageHash = packageContentHash ?? packageHash ?? expectedPackageHash;
      const requiredInspection = inspection ?? inspectionSummary;
      validateRequest({
        workspaceId,
        objectId,
        expectedObjectHash: requiredObjectHash,
        expectedPackageHash: requiredPackageHash,
        inspection: requiredInspection,
        input,
      });
      const checkedMaterials = validateMaterials(materials);
      if (checkedMaterials.length > 0 && Object.hasOwn(input, "_materials")) {
        throw new DockerSkillExecutorError(
          "skill_material_input_reserved",
          "The _materials input field is reserved by the Skill runtime.",
        );
      }

      const stored = await this.#objectStore.read({ workspaceId, objectId, signal });
      throwIfCancelled(signal);
      const { files, runtimeManifest } = verifyStoredPackage({
        stored,
        workspaceId,
        objectId,
        expectedObjectHash: requiredObjectHash,
        expectedPackageHash: requiredPackageHash,
        inspection: requiredInspection,
      });

      await mkdir(this.#tempRoot, { recursive: true, mode: 0o700 });
      invocationRoot = await mkdtemp(join(this.#tempRoot, INVOCATION_DIRECTORY_PREFIX));
      containerName = uniqueContainerName(this.#idFactory());
      stagingContainerName = `${containerName}${DOCKER_SKILL_STAGING_SUFFIX}`;
      inputVolumeName = `${containerName}${DOCKER_SKILL_VOLUME_SUFFIX}`;
      const packageRoot = await materializePackage(
        invocationRoot,
        files,
        containerName,
        inputVolumeName,
      );
      const materialInput = await materializeMaterials(invocationRoot, checkedMaterials);
      const inputBytes = encodeInput(
        materialInput
          ? { ...input, _materials: materialInput.manifest }
          : input,
        this.#limits.maxInputBytes,
      );
      throwIfCancelled(signal);

      const args = buildDockerSkillArguments({
        image: this.#images.get(runtimeManifest.runtime),
        containerName,
        inputVolumeName,
        runtimeManifest,
        limits: effectiveRuntimeLimits(this.#limits, runtimeManifest.limits),
      });
      const executionLimits = effectiveRuntimeLimits(this.#limits, runtimeManifest.limits);
      await prepareDockerSkillContainer({
        dockerControl: this.#dockerControl,
        createArgs: args,
        image: this.#images.get(runtimeManifest.runtime),
        containerName,
        stagingContainerName,
        inputVolumeName,
        packageRoot,
        materialsRoot: materialInput?.root ?? null,
        resourceState,
      });
      return await executeDockerProcess({
        dockerBinary: this.#dockerBinary,
        dockerEnvironment: this.#dockerEnvironment,
        spawnProcess: this.#spawnProcess,
        args: ["container", "start", "--attach", "--interactive", containerName],
        inputBytes,
        signal,
        limits: executionLimits,
      });
    } catch (failure) {
      if (failure instanceof DockerSkillExecutorError) throw failure;
      if (signal?.aborted) throw cancelledError();
      if (failure instanceof SkillPackageFormatError) throw blockedError();
      throw blockedError();
    } finally {
      await cleanupDockerSkillResources({
        dockerControl: this.#dockerControl,
        containerName,
        stagingContainerName,
        inputVolumeName,
        invocationRoot,
        resourceState,
      });
    }
  }

  async scavenge() {
    return scavengeDockerSkillExecutions({
      dockerControl: this.#dockerControl,
      tempRoot: this.#tempRoot,
    });
  }

  async probeRuntimes() {
    const results = [];
    for (const [runtimeId, image] of this.#images.entries()) {
      try {
        await requireDockerSuccess(this.#dockerControl, [
          "image", "inspect", "--format", "{{.Id}}", image,
        ]);
        results.push({ runtimeId, available: true, verified: true, reasonCode: "ready" });
      } catch {
        results.push({
          runtimeId,
          available: false,
          verified: true,
          reasonCode: "skill_runtime_image_unavailable",
        });
      }
    }
    return results;
  }
}

export function buildDockerSkillArguments({
  image,
  containerName,
  inputVolumeName,
  runtimeManifest,
  limits = DEFAULT_LIMITS,
} = {}) {
  if (!DIGEST_PINNED_CONTAINER_IMAGE.test(image || "")
    || !SAFE_PART.test(containerName || "")
    || !SAFE_PART.test(inputVolumeName || "")) {
    throw new TypeError("docker_skill_executor_arguments_invalid");
  }
  const checkedManifest = parseSkillRuntimeManifest(JSON.stringify(runtimeManifest));
  const checked = effectiveRuntimeLimits(
    validateLimits({ ...DEFAULT_LIMITS, ...limits }),
    checkedManifest.limits,
  );
  return [
    ...buildContainerIsolationArguments({
      operation: "create",
      containerName,
      labels: [
        `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
        `${DOCKER_SKILL_INVOCATION_LABEL}=${containerName}`,
      ],
      limits: checked,
      tmpfsBytes: checked.tmpfsBytes,
      fileSizeBytes: checked.maxOutputBytes,
      interactive: true,
    }),
    "--mount", `type=volume,src=${inputVolumeName},dst=/workspace,readonly`,
    "--workdir", "/workspace/skill",
    image,
    ...runtimeCommand(checkedManifest, "/workspace/skill"),
  ];
}

function verifyStoredPackage({ stored, workspaceId, objectId, expectedObjectHash, expectedPackageHash, inspection }) {
  if (!stored?.object || !Buffer.isBuffer(stored.bytes)
    || stored.object.workspaceId !== workspaceId
    || stored.object.objectId !== objectId
    || stored.object.state !== "promoted"
    || stored.object.mediaType !== SKILL_PACKAGE_MEDIA_TYPE) {
    throw blockedError();
  }
  const actualObjectHash = hashSkillPackageObject(stored.bytes);
  if (actualObjectHash !== expectedObjectHash
    || stored.object.contentHash !== actualObjectHash
    || objectIdForSkillPackage(actualObjectHash) !== objectId) {
    throw blockedError();
  }

  const files = assertExecutableSkillPackage(parseSkillPackage(stored.bytes));
  const currentInspection = inspectSkillPackage({ files });
  if (currentInspection.contentHash !== expectedPackageHash
    || !isSupportedExecutableInspection(currentInspection)
    || !inspectionMatches(inspection, currentInspection)) {
    throw blockedError();
  }
  const runtimeFile = files.find((file) => file.path === SKILL_RUNTIME_MANIFEST_PATH);
  return { files, runtimeManifest: parseSkillRuntimeManifest(runtimeFile.content) };
}

function isSupportedExecutableInspection(inspection) {
  const entrypoint = inspection?.manifest?.runtime?.entrypoint;
  return inspection.status === "needs_review"
    && inspection.diagnostics.length === 1
    && inspection.diagnostics[0].code === "executable_content_requires_isolation"
    && inspection.diagnostics[0].severity === "warning"
    && inspection.diagnostics[0].path === entrypoint;
}

function inspectionMatches(expected, actual) {
  if (!isPlainObject(expected)
    || expected.status !== actual.status
    || expected.contentHash !== actual.contentHash) return false;
  for (const key of ["manifest", "inventory", "diagnostics"]) {
    if (Object.hasOwn(expected, key) && JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) return false;
  }
  return true;
}

async function materializePackage(invocationRoot, files, containerName, inputVolumeName) {
  const root = join(invocationRoot, "package");
  const scripts = join(root, "scripts");
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  await writeFile(join(invocationRoot, INVOCATION_MARKER), `${JSON.stringify({
    owner: `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
    containerName,
    inputVolumeName,
  })}\n`, { flag: "wx", mode: 0o400 });
  await mkdir(root, { mode: 0o700 });
  await mkdir(scripts, { mode: 0o700 });
  await writeFile(join(root, "SKILL.md"), byPath.get("SKILL.md"), { flag: "wx", mode: 0o400 });
  await writeFile(
    join(root, SKILL_RUNTIME_MANIFEST_PATH),
    byPath.get(SKILL_RUNTIME_MANIFEST_PATH),
    { flag: "wx", mode: 0o400 },
  );
  const runtimeManifest = parseSkillRuntimeManifest(byPath.get(SKILL_RUNTIME_MANIFEST_PATH));
  const entrypointName = basename(runtimeManifest.entrypoint);
  await writeFile(
    join(scripts, entrypointName),
    byPath.get(runtimeManifest.entrypoint),
    { flag: "wx", mode: 0o400 },
  );
  await chmod(join(root, "SKILL.md"), 0o444);
  await chmod(join(root, SKILL_RUNTIME_MANIFEST_PATH), 0o444);
  await chmod(join(scripts, entrypointName), 0o444);
  await chmod(scripts, 0o555);
  await chmod(root, 0o555);
  return root;
}

function validateMaterials(materials) {
  if (!Array.isArray(materials) || materials.length > 32) {
    throw new DockerSkillExecutorError(
      "skill_material_bindings_invalid",
      "Skill materials are invalid.",
    );
  }
  const seen = new Set();
  let totalBytes = 0;
  return materials.map((material) => {
    if (
      !material
      || typeof material !== "object"
      || !SAFE_PART.test(material.materialKey || "")
      || seen.has(material.materialKey)
      || !Buffer.isBuffer(material.bytes)
      || material.bytes.byteLength < 1
      || material.bytes.byteLength > 16 * 1024 * 1024
      || !SHA256.test(material.contentHash || "")
      || typeof material.mediaType !== "string"
      || material.mediaType.length < 1
      || material.mediaType.length > 128
    ) {
      throw new DockerSkillExecutorError(
        "skill_material_bindings_invalid",
        "Skill materials are invalid.",
      );
    }
    seen.add(material.materialKey);
    totalBytes += material.bytes.byteLength;
    if (totalBytes > 64 * 1024 * 1024) {
      throw new DockerSkillExecutorError(
        "skill_material_limit_exceeded",
        "Skill materials exceed the execution limit.",
      );
    }
    return {
      materialKey: material.materialKey,
      mediaType: material.mediaType,
      contentHash: material.contentHash,
      bytes: Buffer.from(material.bytes),
    };
  });
}

async function materializeMaterials(invocationRoot, materials) {
  if (materials.length === 0) return null;
  const root = join(invocationRoot, "input");
  const filesRoot = join(root, "files");
  await mkdir(root, { mode: 0o700 });
  await mkdir(filesRoot, { mode: 0o700 });
  const manifest = [];
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    const fileName = `material-${String(index + 1).padStart(3, "0")}.bin`;
    const hostPath = join(filesRoot, fileName);
    await writeFile(hostPath, material.bytes, { flag: "wx", mode: 0o400 });
    await chmod(hostPath, 0o444);
    manifest.push({
      materialKey: material.materialKey,
      mediaType: material.mediaType,
      contentHash: material.contentHash,
      path: `/workspace/input/files/${fileName}`,
      sizeBytes: material.bytes.byteLength,
    });
  }
  await writeFile(
    join(root, "manifest.json"),
    `${JSON.stringify({ schemaVersion: "skill-material-input-v1", materials: manifest })}\n`,
    { flag: "wx", mode: 0o400 },
  );
  await chmod(join(root, "manifest.json"), 0o444);
  await chmod(filesRoot, 0o555);
  await chmod(root, 0o555);
  return { root, manifest };
}

async function prepareDockerSkillContainer({
  dockerControl,
  createArgs,
  image,
  containerName,
  stagingContainerName,
  inputVolumeName,
  packageRoot,
  materialsRoot,
  resourceState,
}) {
  if (!isManagedContainerName(containerName)
    || stagingContainerName !== `${containerName}${DOCKER_SKILL_STAGING_SUFFIX}`
    || inputVolumeName !== `${containerName}${DOCKER_SKILL_VOLUME_SUFFIX}`
    || !DIGEST_PINNED_CONTAINER_IMAGE.test(image || "")) {
    throw blockedError();
  }
  const volume = await requireDockerSuccess(dockerControl, [
    "volume", "create",
    "--label", `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
    "--label", `${DOCKER_SKILL_INVOCATION_LABEL}=${inputVolumeName}`,
    inputVolumeName,
  ]);
  if (volume.stdout.trim() !== inputVolumeName) throw cleanupError();
  resourceState.inputVolume = true;
  await inspectOwnedVolume(dockerControl, inputVolumeName);

  await requireDockerSuccess(dockerControl, [
    "container", "create",
    "--pull", "never",
    "--name", stagingContainerName,
    "--label", `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
    "--label", `${DOCKER_SKILL_INVOCATION_LABEL}=${stagingContainerName}`,
    "--mount", `type=volume,src=${inputVolumeName},dst=/workspace`,
    image,
    "true",
  ]);
  resourceState.stagingContainer = true;
  await requireDockerSuccess(dockerControl, [
    "container", "cp", `${packageRoot}/.`, `${stagingContainerName}:/workspace/skill`,
  ]);
  if (materialsRoot) {
    await requireDockerSuccess(dockerControl, [
      "container", "cp", `${materialsRoot}/.`, `${stagingContainerName}:/workspace/input`,
    ]);
  }
  await cleanupOwnedContainer({ dockerControl, containerName: stagingContainerName });
  resourceState.stagingContainer = false;
  await requireDockerSuccess(dockerControl, createArgs);
  resourceState.mainContainer = true;
  await inspectOwnedContainer(dockerControl, containerName);
}

async function executeDockerProcess({
  dockerBinary,
  dockerEnvironment,
  spawnProcess,
  args,
  inputBytes,
  signal,
  limits,
}) {
  let child;
  try {
    child = spawnProcess(dockerBinary, args, {
      env: dockerEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw blockedError();
  }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== "function") {
    child?.kill?.("SIGKILL");
    throw blockedError();
  }

  const stdout = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let totalOutputBytes = 0;
  let terminalError = null;

  const terminate = (failure) => {
    if (terminalError) return;
    terminalError = failure;
    child.stdin.destroy();
    child.kill?.("SIGKILL");
  };
  const collect = (target, limit, chunk) => {
    const bytes = Buffer.from(chunk);
    totalOutputBytes += bytes.byteLength;
    if (target === stdout) stdoutBytes += bytes.byteLength;
    else stderrBytes += bytes.byteLength;
    if ((target === stdout && stdoutBytes > limit)
      || (target !== stdout && stderrBytes > limit)
      || totalOutputBytes > limits.maxOutputBytes) {
      terminate(new DockerSkillExecutorError(
        "skill_execution_output_limit",
        "The uploaded Skill produced too much output.",
      ));
      return;
    }
    if (target === stdout) target.push(bytes);
  };
  child.stdout.on("data", (chunk) => collect(stdout, limits.maxStdoutBytes, chunk));
  child.stderr.on("data", (chunk) => collect(null, limits.maxStderrBytes, chunk));

  const timeout = setTimeout(() => terminate(new DockerSkillExecutorError(
    "skill_execution_timed_out",
    "The uploaded Skill exceeded its execution time limit.",
    { retryable: true },
  )), limits.timeoutMs);
  const onAbort = () => terminate(cancelledError());
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const outcomePromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
  });
  child.stdin.on("error", () => {});
  child.stdin.end(inputBytes);

  const outcome = await outcomePromise;
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onAbort);

  if (terminalError) throw terminalError;
  if (outcome.error || outcome.code !== 0) throw blockedError();

  const output = Buffer.concat(stdout).toString("utf8").trim();
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new DockerSkillExecutorError(
      "skill_execution_invalid_output",
      "The uploaded Skill returned an invalid result.",
    );
  }
  if (!isPlainObject(result)) {
    throw new DockerSkillExecutorError(
      "skill_execution_invalid_output",
      "The uploaded Skill returned an invalid result.",
    );
  }
  return result;
}

async function cleanupDockerSkillResources({
  dockerControl,
  containerName,
  stagingContainerName,
  inputVolumeName,
  invocationRoot,
  resourceState,
}) {
  let failed = false;
  for (const [name, created] of [
    [stagingContainerName, resourceState.stagingContainer],
    [containerName, resourceState.mainContainer],
  ]) {
    if (!name || !created) continue;
    try {
      await cleanupOwnedContainer({ dockerControl, containerName: name });
    } catch {
      failed = true;
    }
  }
  if (inputVolumeName && resourceState.inputVolume) {
    try {
      await cleanupOwnedVolume({ dockerControl, volumeName: inputVolumeName });
    } catch {
      failed = true;
    }
  }
  if (invocationRoot) {
    try {
      await cleanupSkillInvocationDirectory(invocationRoot);
    } catch {
      failed = true;
    }
  }
  if (failed) throw cleanupError();
}

export async function cleanupSkillInvocationDirectory(root, {
  chmodPath = chmod,
  removePath = rm,
  statPath = stat,
} = {}) {
  if (typeof root !== "string" || !basename(root).startsWith(INVOCATION_DIRECTORY_PREFIX)) {
    throw cleanupError();
  }
  try {
    await chmodPath(join(root, "package"), 0o700).catch(() => {});
    await chmodPath(join(root, "package", "scripts"), 0o700).catch(() => {});
    await chmodPath(join(root, "input"), 0o700).catch(() => {});
    await chmodPath(join(root, "input", "files"), 0o700).catch(() => {});
    await removePath(root, { recursive: true, force: true });
    try {
      await statPath(root);
      throw new Error("invocation_directory_still_exists");
    } catch (failure) {
      if (failure?.code !== "ENOENT") throw failure;
    }
  } catch {
    throw cleanupError();
  }
}

export async function scavengeDockerSkillExecutions({
  dockerControl,
  tempRoot = join(tmpdir(), "looloomi-docker-skills"),
  readDirectory = readdir,
  readMarker = readFile,
  cleanupDirectory = cleanupSkillInvocationDirectory,
} = {}) {
  if (typeof dockerControl !== "function" || typeof tempRoot !== "string") {
    throw new TypeError("docker_skill_scavenger_dependencies_invalid");
  }
  try {
    let entries;
    try {
      entries = await readDirectory(tempRoot, { withFileTypes: true });
    } catch (failure) {
      if (failure?.code === "ENOENT") {
        return Object.freeze({ containersRemoved: 0, volumesRemoved: 0, directoriesRemoved: 0 });
      }
      throw failure;
    }
    let containersRemoved = 0;
    let volumesRemoved = 0;
    let directoriesRemoved = 0;
    for (const entry of entries) {
      if (!entry?.isDirectory?.() || !entry.name.startsWith(INVOCATION_DIRECTORY_PREFIX)) continue;
      const root = join(tempRoot, entry.name);
      let marker;
      try {
        marker = parseStrictJson((await readMarker(join(root, INVOCATION_MARKER), "utf8")).trim());
      } catch {
        continue;
      }
      const markerKeys = isPlainObject(marker) ? Object.keys(marker).sort().join(",") : "";
      const currentMarker = markerKeys === "containerName,inputVolumeName,owner";
      const legacyMarker = markerKeys === "containerName,owner";
      if ((!currentMarker && !legacyMarker)
        || marker.owner !== `${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`
        || !isManagedContainerName(marker.containerName)
        || (currentMarker
          && marker.inputVolumeName !== `${marker.containerName}${DOCKER_SKILL_VOLUME_SUFFIX}`)) continue;
      const containerNames = currentMarker
        ? [`${marker.containerName}${DOCKER_SKILL_STAGING_SUFFIX}`, marker.containerName]
        : [marker.containerName];
      for (const containerName of containerNames) {
        const owned = await listOwnedContainers(dockerControl, containerName);
        if (owned.length === 1) {
          await cleanupOwnedContainer({ dockerControl, containerName });
          containersRemoved += 1;
        }
      }
      if (currentMarker) {
        const ownedVolumes = await listOwnedVolumes(dockerControl, marker.inputVolumeName);
        if (ownedVolumes.length === 1) {
          await cleanupOwnedVolume({ dockerControl, volumeName: marker.inputVolumeName });
          volumesRemoved += 1;
        }
      }
      await cleanupDirectory(root);
      directoriesRemoved += 1;
    }
    return Object.freeze({ containersRemoved, volumesRemoved, directoriesRemoved });
  } catch (failure) {
    if (failure instanceof DockerSkillExecutorError) throw failure;
    throw cleanupError();
  }
}

async function cleanupOwnedContainer({ dockerControl, containerName }) {
  try {
    const before = await listOwnedContainers(dockerControl, containerName);
    if (before.length === 0) return;
    if (before.length !== 1 || before[0] !== containerName) throw new Error("container_identity_invalid");

    let inspection = await inspectOwnedContainer(dockerControl, containerName);
    if (inspection.running) {
      await requireDockerSuccess(dockerControl, ["container", "kill", containerName]);
      inspection = await inspectOwnedContainer(dockerControl, containerName);
      if (inspection.running) throw new Error("container_still_running");
    }
    await requireDockerSuccess(dockerControl, ["container", "rm", "--force", containerName]);
    if ((await listOwnedContainers(dockerControl, containerName)).length !== 0) {
      throw new Error("container_still_present");
    }
  } catch (failure) {
    if (failure instanceof DockerSkillExecutorError) throw failure;
    throw cleanupError();
  }
}

async function cleanupOwnedVolume({ dockerControl, volumeName }) {
  try {
    const before = await listOwnedVolumes(dockerControl, volumeName);
    if (before.length === 0) return;
    if (before.length !== 1 || before[0] !== volumeName) throw new Error("volume_identity_invalid");
    await inspectOwnedVolume(dockerControl, volumeName);
    await requireDockerSuccess(dockerControl, ["volume", "rm", volumeName]);
    if ((await listOwnedVolumes(dockerControl, volumeName)).length !== 0) {
      throw new Error("volume_still_present");
    }
  } catch (failure) {
    if (failure instanceof DockerSkillExecutorError) throw failure;
    throw cleanupError();
  }
}

async function listOwnedContainers(dockerControl, containerName) {
  const args = [
    "container", "ls", "--all",
    "--filter", `label=${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
  ];
  if (containerName) args.push("--filter", `label=${DOCKER_SKILL_INVOCATION_LABEL}=${containerName}`);
  args.push("--format", "{{.Names}}");
  const result = await requireDockerSuccess(dockerControl, args);
  const names = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (names.some((name) => !isManagedContainerName(name))) throw new Error("container_identity_invalid");
  return names;
}

async function inspectOwnedContainer(dockerControl, containerName) {
  const result = await requireDockerSuccess(dockerControl, [
    "container", "inspect",
    "--format", "{{json .Config.Labels}} {{json .State.Running}}",
    containerName,
  ]);
  const match = result.stdout.trim().match(/^(\{.*\})\s+(true|false)$/);
  if (!match) throw new Error("container_inspection_invalid");
  const labels = parseStrictJson(match[1]);
  if (!isPlainObject(labels)
    || labels[DOCKER_SKILL_OWNER_LABEL] !== DOCKER_SKILL_OWNER_VALUE
    || labels[DOCKER_SKILL_INVOCATION_LABEL] !== containerName) {
    throw new Error("container_identity_invalid");
  }
  return { running: match[2] === "true" };
}

async function listOwnedVolumes(dockerControl, volumeName) {
  const args = [
    "volume", "ls",
    "--filter", `label=${DOCKER_SKILL_OWNER_LABEL}=${DOCKER_SKILL_OWNER_VALUE}`,
  ];
  if (volumeName) args.push("--filter", `label=${DOCKER_SKILL_INVOCATION_LABEL}=${volumeName}`);
  args.push("--format", "{{.Name}}");
  const result = await requireDockerSuccess(dockerControl, args);
  const names = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (names.some((name) => !isManagedVolumeName(name))) throw new Error("volume_identity_invalid");
  return names;
}

async function inspectOwnedVolume(dockerControl, volumeName) {
  const result = await requireDockerSuccess(dockerControl, [
    "volume", "inspect",
    "--format", "{{json .Labels}}",
    volumeName,
  ]);
  const labels = parseStrictJson(result.stdout.trim());
  if (!isPlainObject(labels)
    || labels[DOCKER_SKILL_OWNER_LABEL] !== DOCKER_SKILL_OWNER_VALUE
    || labels[DOCKER_SKILL_INVOCATION_LABEL] !== volumeName) {
    throw new Error("volume_identity_invalid");
  }
}

async function requireDockerSuccess(dockerControl, args) {
  const result = await dockerControl(args);
  if (!isPlainObject(result)
    || result.code !== 0
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string") {
    throw new Error("docker_control_failed");
  }
  return result;
}

function validateRequest({ workspaceId, objectId, expectedObjectHash, expectedPackageHash, inspection, input }) {
  if (!SAFE_PART.test(workspaceId || "")
    || !SAFE_PART.test(objectId || "")
    || !SHA256.test(expectedObjectHash || "")
    || !SHA256.test(expectedPackageHash || "")
    || !isPlainObject(inspection)
    || !isPlainObject(input)) {
    throw blockedError();
  }
}

function encodeInput(input, maxInputBytes) {
  let serialized;
  let bytes;
  try {
    serialized = JSON.stringify(input);
    if (typeof serialized !== "string" || !isPlainObject(JSON.parse(serialized))) throw new TypeError();
    bytes = Buffer.from(`${serialized}\n`, "utf8");
  } catch {
    throw blockedError();
  }
  if (bytes.byteLength > maxInputBytes) {
    throw new DockerSkillExecutorError("skill_execution_input_limit", "The uploaded Skill input is too large.");
  }
  return bytes;
}

function validateLimits(limits) {
  for (const key of [
    "timeoutMs",
    "maxInputBytes",
    "maxStdoutBytes",
    "maxStderrBytes",
    "maxOutputBytes",
    "pids",
    "memoryBytes",
    "tmpfsBytes",
  ]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) {
      throw new TypeError("docker_skill_executor_limits_invalid");
    }
  }
  if (typeof limits.cpus !== "number" || !Number.isFinite(limits.cpus) || limits.cpus <= 0) {
    throw new TypeError("docker_skill_executor_limits_invalid");
  }
  return Object.freeze({ ...limits });
}

function effectiveRuntimeLimits(policyLimits, requestedLimits) {
  const policy = validateLimits(policyLimits);
  const requestedTimeoutMs = requestedLimits.timeoutSeconds * 1_000;
  const requestedMemoryBytes = requestedLimits.memoryMiB * 1024 * 1024;
  return Object.freeze({
    ...policy,
    timeoutMs: Math.min(policy.timeoutMs, requestedTimeoutMs),
    memoryBytes: Math.min(policy.memoryBytes, requestedMemoryBytes),
  });
}

function normalizeRuntimeImages(images, legacyImage) {
  const values = images instanceof Map
    ? [...images.entries()]
    : isPlainObject(images)
      ? Object.entries(images)
      : [];
  if (legacyImage) values.push(["python3.12", legacyImage]);
  const normalized = new Map();
  for (const [runtimeId, image] of values) {
    if (!["python3.12", "nodejs20-typescript"].includes(runtimeId)
      || typeof image !== "string"
      || !DIGEST_PINNED_CONTAINER_IMAGE.test(image)) {
      continue;
    }
    normalized.set(runtimeId, image);
  }
  return normalized;
}

function runtimeCommand(manifest, skillRoot = "/skill") {
  const entrypoint = `${skillRoot}/${manifest.entrypoint}`;
  if (manifest.runtime === "python3.12") return ["python3.12", entrypoint];
  if (manifest.runtime === "nodejs20-typescript") return ["tsx", entrypoint];
  throw blockedError();
}

function uniqueContainerName(value) {
  const suffix = String(value).toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 96);
  if (!suffix) throw blockedError();
  return `looloomi-skill-${suffix}`;
}

function isManagedContainerName(value) {
  return typeof value === "string"
    && value.startsWith("looloomi-skill-")
    && SAFE_PART.test(value);
}

function isManagedVolumeName(value) {
  return typeof value === "string"
    && value.endsWith(DOCKER_SKILL_VOLUME_SUFFIX)
    && isManagedContainerName(value.slice(0, -DOCKER_SKILL_VOLUME_SUFFIX.length));
}

function defaultDockerEnvironment() {
  const environment = {};
  for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  return environment;
}

async function runDockerControl({ dockerBinary, dockerEnvironment, spawnProcess, args }) {
  let child;
  try {
    child = spawnProcess(dockerBinary, args, {
      env: dockerEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    throw new Error("docker_control_unavailable");
  }
  if (!child?.stdout || !child?.stderr || typeof child.once !== "function") {
    child?.kill?.("SIGKILL");
    throw new Error("docker_control_unavailable");
  }
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let overflow = false;
  const collect = (target, chunk) => {
    const bytes = Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > 64 * 1024) {
      overflow = true;
      child.kill?.("SIGKILL");
      return;
    }
    target.push(bytes);
  };
  child.stdout.on("data", (chunk) => collect(stdout, chunk));
  child.stderr.on("data", (chunk) => collect(stderr, chunk));
  const outcome = await new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.("SIGKILL");
      resolve({ timedOut: true });
    }, args[0] === "container" && args[1] === "cp"
      ? DOCKER_COPY_TIMEOUT_MS
      : DOCKER_CONTROL_TIMEOUT_MS);
    timer.unref?.();
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.once("error", (error) => done({ error }));
    child.once("close", (code) => done({ code }));
  });
  if (outcome.timedOut || outcome.error || overflow) throw new Error("docker_control_failed");
  return {
    code: outcome.code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

function blockedError() {
  return new DockerSkillExecutorError(
    "skill_execution_blocked",
    "This uploaded Skill is not available for isolated execution.",
    { retryable: true },
  );
}

function cancelledError() {
  return new DockerSkillExecutorError(
    "skill_execution_cancelled",
    "The uploaded Skill execution was cancelled.",
    { retryable: true },
  );
}

function cleanupError() {
  return new DockerSkillExecutorError(
    "skill_execution_cleanup_failed",
    "The isolated Skill environment could not be cleaned up safely.",
    { retryable: true },
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
