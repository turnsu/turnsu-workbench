import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const auditScript = resolve(scriptRoot, "visual-evidence-audit.mjs");
const fixtureRoot = await mkdtemp(resolve(tmpdir(), "loopops-evidence-manifest-"));
const auditRoot = resolve(fixtureRoot, "actual");
const capturedAt = new Date().toISOString();

const loopReferences = new Map([
  ["loop-lifecycle-board", "wiki/design/skill-loop-cloud-workbench-v1/visual-directions/selected-ai-native-lifecycle-board.png"],
  ["loop-create", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/01-create-loop.png"],
  ["loop-ai-proposal-review", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/02-review-ai-proposal.png"],
  ["loop-builder-outline", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/03-builder-outline.png"],
  ["loop-builder-canvas", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/04-builder-canvas.png"],
  ["loop-run-waiting-review", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/05-run-waiting-review.png"],
  ["loop-run-completed", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/06-run-completed.png"],
  ["loop-publish-review", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/07-publish-review.png"],
  ["loop-team-library-update", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/08-team-library-update.png"],
  ["loop-overview", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/09-loop-overview.png"],
  ["loop-builder-definition", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/10-builder-definition.png"],
  ["loop-run-preflight", "wiki/design/skill-loop-cloud-workbench-v1/key-frames/11-run-preflight.png"],
]);

const requiredScreens = [
  ...[...loopReferences.keys()].map((screenId) => ({ screenId, evidenceCategory: "loop-reference" })),
  ...[
    "skills-library",
    "skill-detail",
    "skill-create",
    "skill-upload-import",
    "skill-edit-files-permissions",
    "skill-validation-test",
    "skill-versions-diff-usage",
    "skill-publish-update-impact",
  ].map((screenId) => ({ screenId, evidenceCategory: "skills" })),
  ...[
    "team-library-search",
    "team-library-skill-detail",
    "team-library-loop-detail",
    "team-library-publish-review",
    "team-library-update-impact",
  ].map((screenId) => ({ screenId, evidenceCategory: "team-library" })),
  { screenId: "global-create", evidenceCategory: "global-create" },
  { screenId: "inbox-needs-attention", evidenceCategory: "inbox" },
  ...[
    "loop-builder-outline-mobile",
    "loop-builder-canvas-mobile",
    "loop-builder-library-mobile",
  ].map((screenId) => ({ screenId, evidenceCategory: "responsive" })),
  ...[
    "loading",
    "first-use",
    "empty",
    "populated",
    "empty-search",
    "validation-error",
    "needs-setup",
    "blocked",
    "offline",
    "reconnecting",
    "permission-denied",
    "revision-conflict",
    "server-error",
    "update-available",
    "success",
    "recovery",
  ].map((state) => ({ screenId: `state-${state}`, evidenceCategory: "generic-state", objectState: state })),
];

const viewports = [
  { width: 1440, height: 1024 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

try {
  await mkdir(auditRoot, { recursive: true });

  const incompleteManifest = resolve(fixtureRoot, "incomplete-manifest.json");
  await writeManifest(incompleteManifest, { capturedAt, shots: [{}] });
  assertFailure(runAudit(incompleteManifest), "visual_manifest_screen_id_missing");

  const manifest = { capturedAt, shots: [] };
  for (const [index, descriptor] of requiredScreens.entries()) {
    const viewport = viewports[index % viewports.length];
    const actualPath = resolve(auditRoot, `${descriptor.screenId}.png`);
    await writeFile(actualPath, png(viewport.width, viewport.height, index + 1));

    const referencePath = loopReferences.get(descriptor.screenId) ?? null;
    if (referencePath) {
      const absoluteReference = resolve(fixtureRoot, referencePath);
      await mkdir(dirname(absoluteReference), { recursive: true });
      await writeFile(absoluteReference, png(viewport.width, viewport.height, index + 128));
    }

    manifest.shots.push({
      screenId: descriptor.screenId,
      evidenceCategory: descriptor.evidenceCategory,
      referencePath,
      actualPath,
      actualRoute: `/evidence/${descriptor.screenId}`,
      objectId: descriptor.evidenceCategory === "global-create" || descriptor.evidenceCategory === "inbox" ? "workspace" : `object-${index + 1}`,
      objectState: descriptor.objectState ?? "populated",
      viewport,
      locale: index % 2 === 0 ? "en" : "zh-CN",
      theme: index % 2 === 0 ? "light" : "dark",
      capturedAt,
      h1: descriptor.screenId,
      hasHorizontalOverflow: false,
      overflowDetails: [],
      interactionPreconditions: ["Fresh Product API state is loaded", `Open ${descriptor.screenId}`],
      structuralAssertions: ["Primary product surface is visible", "No page-level horizontal overflow"],
      visibleDeviations: [],
      manualVerdict: {
        status: "approved",
        reviewer: "evidence-smoke",
        reviewedAt: capturedAt,
      },
    });
  }

  const validManifest = resolve(fixtureRoot, "valid-manifest.json");
  await writeManifest(validManifest, manifest);
  const valid = runAudit(validManifest);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /v1_visual_evidence_audit=pass/);
  assert.match(valid.stdout, /v1_evidence_loop_reference_count=12/);

  await assertMutationFails(manifest, "missing-route", (copy) => delete copy.shots[0].actualRoute, "visual_manifest_actual_route_missing");
  await assertMutationFails(manifest, "missing-category", (copy) => delete copy.shots[0].evidenceCategory, "visual_manifest_category_missing");
  await assertMutationFails(manifest, "wrong-category", (copy) => copy.shots[0].evidenceCategory = "skills", "visual_manifest_screen_category_mismatch");
  await assertMutationFails(manifest, "missing-screen", (copy) => copy.shots.splice(0, 1), "visual_required_screen_missing:loop-reference:loop-lifecycle-board");
  await assertMutationFails(manifest, "static-route", (copy) => copy.shots[0].actualRoute = "/fake.html", "visual_actual_route_static_artifact");
  await assertMutationFails(manifest, "horizontal-overflow", (copy) => copy.shots[0].hasHorizontalOverflow = true, "visual_horizontal_overflow");
  await assertMutationFails(manifest, "pending-review", (copy) => copy.shots[0].manualVerdict.status = "pending", "visual_manual_approval_required");
  await assertMutationFails(manifest, "stale-capture", (copy) => copy.shots[0].capturedAt = "2020-01-01T00:00:00.000Z", "visual_capture_stale");
  await assertMutationFails(manifest, "same-path", (copy) => copy.shots[0].referencePath = copy.shots[0].actualPath, "visual_reference_equals_actual_path");

  const copiedReferenceManifest = structuredClone(manifest);
  const copiedShot = copiedReferenceManifest.shots[0];
  const originalActual = await readFile(copiedShot.actualPath);
  await writeFile(copiedShot.actualPath, await readFile(resolve(fixtureRoot, copiedShot.referencePath)));
  const copiedManifestPath = resolve(fixtureRoot, "copied-reference-manifest.json");
  await writeManifest(copiedManifestPath, copiedReferenceManifest);
  assertFailure(runAudit(copiedManifestPath), "visual_actual_matches_reference");
  await writeFile(copiedShot.actualPath, originalActual);

  process.stdout.write("evidence_manifest_smoke=pass\n");
  process.stdout.write(`evidence_manifest_required_screen_count=${requiredScreens.length}\n`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function assertMutationFails(manifest, name, mutate, expectedCode) {
  const copy = structuredClone(manifest);
  mutate(copy);
  const path = resolve(fixtureRoot, `${name}-manifest.json`);
  await writeManifest(path, copy);
  assertFailure(runAudit(path), expectedCode);
}

function assertFailure(result, expectedCode) {
  assert.notEqual(result.status, 0, `audit unexpectedly passed; expected ${expectedCode}`);
  assert.match(result.stderr, new RegExp(escapeRegex(expectedCode)), result.stderr);
}

function runAudit(manifestPath) {
  return spawnSync(
    process.execPath,
    [
      auditScript,
      "--manifest",
      manifestPath,
      "--audit-root",
      auditRoot,
      "--repository-root",
      fixtureRoot,
      "--max-age-hours",
      "24",
    ],
    { encoding: "utf8" },
  );
}

async function writeManifest(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function png(width, height, shade) {
  const row = Buffer.alloc(width + 1, shade % 256);
  row[0] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) row.copy(raw, y * row.length);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
