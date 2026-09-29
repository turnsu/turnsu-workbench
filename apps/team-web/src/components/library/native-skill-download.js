import { zipSync } from "fflate";

function decode(value) {
  if (typeof value !== "string") throw new Error("native_skill_package_invalid");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

/** Preserve the exact authorized release bytes; downloading is not installation. */
export async function createNativeSkillZip(bundle) {
  if (!bundle || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.skillName) || bundle.skillName.length > 64
    || typeof bundle.packageContentBase64 !== "string" || bundle.packageContentBase64.length > 16_777_216) throw new Error("native_skill_package_invalid");
  const bytes = decode(bundle.packageContentBase64);
  const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (hash !== bundle.packageObjectHash) throw new Error("native_skill_package_hash_mismatch");
  const envelope = JSON.parse(new TextDecoder().decode(bytes));
  if (envelope.format !== "workbench-skill-package-v1" || !Array.isArray(envelope.files) || !envelope.files.length || envelope.files.length > 256) throw new Error("native_skill_package_invalid");
  const paths = new Set();
  const zipFiles = Object.create(null);
  let total = 0;
  for (const file of envelope.files) {
    if (typeof file.path !== "string" || file.path.length > 512 || /[\\\x00-\x1f:]/.test(file.path)
      || file.path.split("/").some((part) => !part || part.startsWith(".") || /[. ]$/.test(part))) throw new Error("native_skill_package_path_invalid");
    const key = file.path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("native_skill_package_path_invalid");
    paths.add(key);
    const content = decode(file.content); total += content.length;
    if (content.length > 1_048_576 || total > 8_388_608) throw new Error("native_skill_package_invalid");
    zipFiles[`${bundle.skillName}/${file.path}`] = content;
  }
  if (!envelope.files.some((file) => file.path === "SKILL.md")) throw new Error("native_skill_package_invalid");
  for (const path of paths) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { if (paths.has(parts.join("/"))) throw new Error("native_skill_package_path_invalid"); parts.pop(); }
  }
  zipFiles["turnsu-release.json"] = new TextEncoder().encode(JSON.stringify({ releaseId: bundle.releaseId,
    versionId: bundle.versionId, version: bundle.version, packageObjectHash: hash, installation: "not_performed" }, null, 2));
  return { bytes: zipSync(zipFiles), filename: `${bundle.skillName}-${String(bundle.version).replace(/[^a-zA-Z0-9.-]/g, "-")}.zip` };
}

export function saveSkillZip(archive) {
  const url = URL.createObjectURL(new Blob([archive.bytes], { type: "application/zip" }));
  const link = document.createElement("a"); link.href = url; link.download = archive.filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
