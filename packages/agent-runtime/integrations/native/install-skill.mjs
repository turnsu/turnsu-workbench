import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ROOTS = { codex: ".agents/skills", claude: ".claude/skills", pi: ".pi/skills" };
const RECEIPT = ".turnsu-install.json";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (code) => { throw new Error(code); };

/** Explicit project-scoped file installation; never edits global Agent settings or executes code. */
export async function installNativeSkill({ product, releaseId, agent, projectDirectory, replaceReleaseId = null }) {
  if (!ROOTS[agent]) fail("native_skill_agent_invalid");
  if (!isAbsolute(projectDirectory || "")) fail("native_skill_project_absolute_path_required");
  const project = await realpath(projectDirectory);
  if (!(await lstat(project)).isDirectory()) fail("native_skill_project_directory_required");
  const response = await product.call("turnsu_skill_package", { pathParams: { releaseId } }, { signal: AbortSignal.timeout(30_000) });
  const bundle = response.data;
  const files = decodePackage(bundle, releaseId);
  const parent = await safeDirectory(project, ROOTS[agent]);
  const target = join(parent, bundle.skillName);
  const lockPath = join(parent, ".turnsu-install.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") fail("native_skill_install_busy_check_previous_process"); throw error; }
  await lock.writeFile(`${process.pid}\n`);
  let stage = null, backup = null;
  try {
    const current = await readExisting(target);
    if (current) {
      if (current.sourceOrigin !== product.origin || current.skillName !== bundle.skillName) fail("native_skill_name_conflict");
      if (current.releaseId === releaseId && current.packageObjectHash === bundle.packageObjectHash) {
        return result("already_installed", target, bundle, agent);
      }
      if (replaceReleaseId !== current.releaseId) fail("native_skill_update_requires_current_release");
    } else if (replaceReleaseId) fail("native_skill_update_target_missing");
    stage = await mkdtemp(join(project, ".turnsu-skill-stage-"));
    for (const file of files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
    }
    const receipt = { format: "turnsu-native-skill-v1", sourceOrigin: product.origin, agent,
      releaseId, versionId: bundle.versionId, version: bundle.version, skillName: bundle.skillName,
      packageObjectHash: bundle.packageObjectHash, packageHash: bundle.packageHash, contentHash: bundle.contentHash,
      files: files.map((file) => ({ path: file.path, hash: digest(file.bytes) })) };
    await writeFile(join(stage, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Check again before swapping so a local edit made during download/staging is preserved.
    const latest = await readExisting(target);
    if (JSON.stringify(latest) !== JSON.stringify(current)) fail("native_skill_install_changed_retry");
    if (current) {
      backup = join(project, `.turnsu-skill-backup-${randomUUID()}`);
      await rename(target, backup);
    }
    try { await rename(stage, target); stage = null; }
    catch (error) { if (backup) { await rename(backup, target); backup = null; } throw error; }
    if (backup) { await rm(backup, { recursive: true }); backup = null; }
    return result(current ? "updated" : "installed", target, bundle, agent);
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    // A failed restore leaves the backup intact; it must never be deleted in a finally block.
    await lock.close();
    await unlink(lockPath);
  }
}

function result(status, directory, bundle, agent) {
  return { status, directory, agent, releaseId: bundle.releaseId, version: bundle.version,
    skillName: bundle.skillName, packageObjectHash: bundle.packageObjectHash,
    compatibility: bundle.compatibility, nativeExecution: "not_verified" };
}

function decodePackage(bundle, releaseId) {
  if (!bundle || bundle.releaseId !== releaseId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.skillName)
    || bundle.skillName.length > 64 || bundle.skillName === "synced") fail("native_skill_package_invalid");
  const encoded = bundle.packageContentBase64;
  if (typeof encoded !== "string" || encoded.length > 16_777_216) fail("native_skill_package_invalid");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded || digest(bytes) !== bundle.packageObjectHash) fail("native_skill_package_hash_mismatch");
  const envelope = JSON.parse(bytes.toString("utf8"));
  if (envelope.format !== "workbench-skill-package-v1" || !Array.isArray(envelope.files)
    || !envelope.files.length || envelope.files.length > 256) fail("native_skill_package_invalid");
  const paths = new Set();
  let size = 0;
  const files = envelope.files.map((file) => {
    const path = file.path;
    if (typeof path !== "string" || path.length > 512 || path.includes("\\") || /[\x00-\x1f:]/.test(path)
      || path.split("/").some((part) => !part || part.startsWith(".") || /[. ]$/.test(part))) fail("native_skill_package_path_invalid");
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key)) fail("native_skill_package_path_conflict");
    paths.add(key);
    if (typeof file.content !== "string") fail("native_skill_package_invalid");
    const content = Buffer.from(file.content, "base64"); size += content.length;
    if (content.toString("base64") !== file.content || content.length > 1_048_576 || size > 8_388_608) fail("native_skill_package_invalid");
    return { path, bytes: content };
  });
  if (!files.some((file) => file.path === "SKILL.md")) fail("native_skill_package_invalid");
  for (const path of paths) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { if (paths.has(parts.join("/"))) fail("native_skill_package_path_conflict"); parts.pop(); }
  }
  return files;
}

async function safeDirectory(root, relative) {
  let path = root;
  for (const part of relative.split("/")) {
    path = join(path, part);
    try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("native_skill_directory_symlink_or_conflict");
  }
  return path;
}

async function readExisting(directory) {
  let stat;
  try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("native_skill_name_conflict");
  const entries = [];
  async function walk(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${relative}/`);
      else if (entry.isFile()) entries.push(relative);
      else fail("native_skill_local_changes_preserved");
    }
  }
  await walk(directory);
  let receipt;
  try { receipt = JSON.parse(await readFile(join(directory, RECEIPT), "utf8")); }
  catch { fail("native_skill_name_conflict"); }
  if (receipt.format !== "turnsu-native-skill-v1" || !Array.isArray(receipt.files)) fail("native_skill_name_conflict");
  const expected = [...receipt.files.map((file) => file.path), RECEIPT].sort();
  if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) fail("native_skill_local_changes_preserved");
  for (const file of receipt.files) {
    // Receipt paths must be the exact relative files found by walking this directory.
    if (!entries.includes(file.path) || digest(await readFile(resolve(directory, file.path))) !== file.hash) fail("native_skill_local_changes_preserved");
  }
  return receipt;
}

/** Reopening a desktop task must not silently switch it to another installed release. */
export async function verifyInstalledNativeSkill({ projectDirectory, agent, skillName, releaseId, packageObjectHash }) {
  if (!ROOTS[agent] || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName || '')) fail('native_skill_package_invalid');
  const root = await realpath(projectDirectory);
  let parent = root;
  for (const part of ROOTS[agent].split('/')) {
    parent = join(parent, part);
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('native_skill_directory_symlink_or_conflict');
  }
  const directory = join(parent, skillName), receipt = await readExisting(directory);
  if (!receipt || receipt.releaseId !== releaseId || receipt.packageObjectHash !== packageObjectHash) fail('native_skill_installed_version_changed');
  return directory;
}
