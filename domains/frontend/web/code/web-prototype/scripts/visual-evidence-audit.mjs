import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(scriptPath), "..");
const defaultRepositoryRoot = resolve(webRoot, "../../../../..");
const defaultAuditRoot = resolve(webRoot, "../product-design-audit-web");

const LOOP_REFERENCE_SCREENS = new Map([
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

const REQUIRED_SCREEN_GROUPS = new Map([
  ["loop-reference", [...LOOP_REFERENCE_SCREENS.keys()]],
  [
    "skills",
    [
      "skills-library",
      "skill-detail",
      "skill-create",
      "skill-upload-import",
      "skill-edit-files-permissions",
      "skill-validation-test",
      "skill-versions-diff-usage",
      "skill-publish-update-impact",
    ],
  ],
  [
    "team-library",
    [
      "team-library-search",
      "team-library-skill-detail",
      "team-library-loop-detail",
      "team-library-publish-review",
      "team-library-update-impact",
    ],
  ],
  ["global-create", ["global-create"]],
  ["inbox", ["inbox-needs-attention"]],
  [
    "responsive",
    ["loop-builder-outline-mobile", "loop-builder-canvas-mobile", "loop-builder-library-mobile"],
  ],
  [
    "generic-state",
    [
      "state-loading",
      "state-first-use",
      "state-empty",
      "state-populated",
      "state-empty-search",
      "state-validation-error",
      "state-needs-setup",
      "state-blocked",
      "state-offline",
      "state-reconnecting",
      "state-permission-denied",
      "state-revision-conflict",
      "state-server-error",
      "state-update-available",
      "state-success",
      "state-recovery",
    ],
  ],
]);

const SCREEN_CATEGORY_BY_ID = new Map(
  [...REQUIRED_SCREEN_GROUPS].flatMap(([category, screenIds]) => screenIds.map((screenId) => [screenId, category])),
);

const REQUIRED_VIEWPORTS = [
  { width: 1440, height: 1024 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

export async function auditEvidenceManifest({
  manifestPath,
  auditRoot,
  repositoryRoot,
  maxAgeHours = 72,
  now = new Date(),
}) {
  const errors = [];
  const resolvedManifestPath = resolve(manifestPath);
  const resolvedAuditRoot = resolve(auditRoot);
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const manifest = await readJson(resolvedManifestPath, errors);
  if (!manifest) return report(errors, 0, new Map());

  if (Object.hasOwn(manifest, "schemaVersion")) {
    check(manifest.schemaVersion === 2, errors, "visual_manifest_schema_version_invalid");
  }
  if (Object.hasOwn(manifest, "captureStatus")) {
    check(manifest.captureStatus === "complete", errors, `visual_manifest_capture_incomplete:${manifest.captureStatus ?? "missing"}`);
  }
  check(Array.isArray(manifest.shots), errors, "visual_manifest_shots_missing");
  const manifestCapturedAt = parseTimestamp(manifest.capturedAt);
  check(manifestCapturedAt !== null, errors, "visual_manifest_timestamp_invalid");
  if (!Array.isArray(manifest.shots)) return report(errors, 0, new Map());

  const nowTime = now.getTime();
  const maxAgeMs = Number(maxAgeHours) * 60 * 60 * 1000;
  check(Number.isFinite(maxAgeMs) && maxAgeMs > 0, errors, "visual_max_age_invalid");

  const screenIds = new Set();
  const actualPaths = new Set();
  const actualHashes = new Map();
  const coverage = new Map([...REQUIRED_SCREEN_GROUPS.keys()].map((category) => [category, 0]));
  const viewportKeys = new Set();
  const locales = new Set();
  const themes = new Set();
  let approvedCount = 0;

  for (const [index, shot] of manifest.shots.entries()) {
    const label = isNonEmptyString(shot?.screenId) ? shot.screenId : `shot-${index + 1}`;
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) {
      errors.push(`visual_manifest_shot_invalid:${label}`);
      continue;
    }

    validateRequiredString(shot.screenId, errors, "visual_manifest_screen_id_missing", label);
    validateRequiredString(shot.evidenceCategory, errors, "visual_manifest_category_missing", label);
    validateRequiredString(shot.actualPath, errors, "visual_manifest_actual_path_missing", label);
    validateRequiredString(shot.actualRoute, errors, "visual_manifest_actual_route_missing", label);
    validateRequiredString(shot.objectId, errors, "visual_manifest_object_id_missing", label);
    validateRequiredString(shot.objectState, errors, "visual_manifest_object_state_missing", label);
    validateRequiredString(shot.locale, errors, "visual_manifest_locale_missing", label);
    validateRequiredString(shot.theme, errors, "visual_manifest_theme_missing", label);
    validateRequiredString(shot.capturedAt, errors, "visual_manifest_capture_timestamp_missing", label);
    validateRequiredString(shot.h1, errors, "visual_manifest_heading_missing", label);
    check(Object.hasOwn(shot, "referencePath"), errors, `visual_manifest_reference_path_missing:${label}`);
    check(shot.hasHorizontalOverflow === false, errors, `visual_horizontal_overflow:${label}`);
    check(Array.isArray(shot.overflowDetails) && shot.overflowDetails.length === 0, errors, `visual_overflow_details:${label}`);
    validateStringArray(shot.interactionPreconditions, errors, "visual_manifest_preconditions_invalid", label, true);
    validateStringArray(shot.structuralAssertions, errors, "visual_manifest_structural_assertions_invalid", label, true);
    validateStringArray(shot.visibleDeviations, errors, "visual_manifest_visible_deviations_invalid", label, false);

    if (isNonEmptyString(shot.screenId)) {
      check(!screenIds.has(shot.screenId), errors, `visual_manifest_screen_id_duplicate:${shot.screenId}`);
      screenIds.add(shot.screenId);
      const expectedCategory = SCREEN_CATEGORY_BY_ID.get(shot.screenId);
      if (expectedCategory) {
        check(shot.evidenceCategory === expectedCategory, errors, `visual_manifest_screen_category_mismatch:${label}:${expectedCategory}`);
      }
      if (shot.screenId.startsWith("state-")) {
        check(shot.objectState === shot.screenId.slice("state-".length), errors, `visual_manifest_generic_state_mismatch:${label}`);
      }
    }

    if (isNonEmptyString(shot.evidenceCategory)) {
      check(REQUIRED_SCREEN_GROUPS.has(shot.evidenceCategory), errors, `visual_manifest_category_invalid:${label}`);
      if (REQUIRED_SCREEN_GROUPS.has(shot.evidenceCategory)) {
        coverage.set(shot.evidenceCategory, (coverage.get(shot.evidenceCategory) ?? 0) + 1);
      }
    }

    validateRoute(shot.actualRoute, errors, label);
    validateViewport(shot.viewport, errors, label, viewportKeys);
    validateLocaleAndTheme(shot.locale, shot.theme, errors, label, locales, themes);
    validateManualVerdict(shot.manualVerdict, shot.capturedAt, nowTime, errors, label, () => approvedCount += 1);

    const captureTime = parseTimestamp(shot.capturedAt);
    if (captureTime !== null && Number.isFinite(maxAgeMs)) {
      check(captureTime <= nowTime + 5 * 60 * 1000, errors, `visual_capture_timestamp_in_future:${label}`);
      check(nowTime - captureTime <= maxAgeMs, errors, `visual_capture_stale:${label}`);
      if (manifestCapturedAt !== null) {
        check(Math.abs(manifestCapturedAt - captureTime) <= 24 * 60 * 60 * 1000, errors, `visual_capture_outside_manifest_window:${label}`);
      }
    }

    let actual = null;
    if (isNonEmptyString(shot.actualPath)) {
      actual = resolveEvidencePath(shot.actualPath, resolvedRepositoryRoot);
      check(isWithin(actual, resolvedAuditRoot), errors, `visual_actual_outside_audit_root:${label}`);
      check(!actualPaths.has(actual), errors, `visual_actual_path_duplicate:${label}`);
      actualPaths.add(actual);
      const actualPng = await inspectPng(actual, errors, `visual_actual`, label);
      if (actualPng) {
        if (isViewport(shot.viewport)) {
          check(actualPng.width === shot.viewport.width && actualPng.height === shot.viewport.height, errors, `visual_actual_viewport_mismatch:${label}`);
        }
        if (captureTime !== null) {
          check(Math.abs(actualPng.modifiedAt - captureTime) <= 10 * 60 * 1000, errors, `visual_actual_mtime_mismatch:${label}`);
          check(nowTime - actualPng.modifiedAt <= maxAgeMs, errors, `visual_actual_file_stale:${label}`);
        }
        const duplicateScreen = actualHashes.get(actualPng.hash);
        check(!duplicateScreen, errors, `visual_actual_content_duplicate:${label}:${duplicateScreen ?? ""}`);
        actualHashes.set(actualPng.hash, label);
      }
    }

    const expectedReference = LOOP_REFERENCE_SCREENS.get(shot.screenId);
    if (expectedReference) {
      check(shot.evidenceCategory === "loop-reference", errors, `visual_loop_reference_category_invalid:${label}`);
      check(isNonEmptyString(shot.referencePath), errors, `visual_loop_reference_missing:${label}`);
      if (isNonEmptyString(shot.referencePath)) {
        const reference = resolveEvidencePath(shot.referencePath, resolvedRepositoryRoot);
        const expected = resolve(resolvedRepositoryRoot, expectedReference);
        check(reference === expected, errors, `visual_loop_reference_path_invalid:${label}`);
      }
    } else if (shot.referencePath !== null && !isNonEmptyString(shot.referencePath)) {
      errors.push(`visual_manifest_reference_path_invalid:${label}`);
    }

    if (isNonEmptyString(shot.referencePath)) {
      const reference = resolveEvidencePath(shot.referencePath, resolvedRepositoryRoot);
      check(isWithin(reference, resolvedRepositoryRoot), errors, `visual_reference_outside_repository:${label}`);
      if (actual) check(reference !== actual, errors, `visual_reference_equals_actual_path:${label}`);
      const referencePng = await inspectPng(reference, errors, "visual_reference", label);
      if (referencePng && actual) {
        const actualHash = [...actualHashes.entries()].find(([, screen]) => screen === label)?.[0];
        if (actualHash) check(referencePng.hash !== actualHash, errors, `visual_actual_matches_reference:${label}`);
      }
    }
  }

  for (const [category, requiredScreenIds] of REQUIRED_SCREEN_GROUPS) {
    for (const screenId of requiredScreenIds) {
      check(screenIds.has(screenId), errors, `visual_required_screen_missing:${category}:${screenId}`);
    }
  }

  for (const [screenId, referencePath] of LOOP_REFERENCE_SCREENS) {
    await inspectPng(resolve(resolvedRepositoryRoot, referencePath), errors, "visual_reference_authority", screenId);
  }

  for (const viewport of REQUIRED_VIEWPORTS) {
    check(viewportKeys.has(viewportKey(viewport)), errors, `visual_viewport_coverage_missing:${viewport.width}x${viewport.height}`);
  }
  for (const locale of ["en", "zh"]) check(locales.has(locale), errors, `visual_locale_coverage_missing:${locale}`);
  for (const theme of ["light", "dark"]) check(themes.has(theme), errors, `visual_theme_coverage_missing:${theme}`);

  return report(errors, manifest.shots.length, coverage, approvedCount);
}

function validateRoute(value, errors, label) {
  if (!isNonEmptyString(value)) return;
  check(value.startsWith("/"), errors, `visual_actual_route_not_relative:${label}`);
  check(!/\.(?:html?|png|jpe?g|webp)(?:[?#]|$)/i.test(value), errors, `visual_actual_route_static_artifact:${label}`);
  check(!value.startsWith("//"), errors, `visual_actual_route_external:${label}`);
}

function validateViewport(value, errors, label, viewportKeys) {
  if (!isViewport(value)) {
    errors.push(`visual_manifest_viewport_invalid:${label}`);
    return;
  }
  viewportKeys.add(viewportKey(value));
}

function validateLocaleAndTheme(locale, theme, errors, label, locales, themes) {
  if (isNonEmptyString(locale)) {
    const normalized = locale.toLowerCase().startsWith("zh") ? "zh" : locale.toLowerCase().startsWith("en") ? "en" : null;
    check(normalized !== null, errors, `visual_manifest_locale_invalid:${label}`);
    if (normalized) locales.add(normalized);
  }
  if (isNonEmptyString(theme)) {
    check(theme === "light" || theme === "dark", errors, `visual_manifest_theme_invalid:${label}`);
    if (theme === "light" || theme === "dark") themes.add(theme);
  }
}

function validateManualVerdict(value, capturedAt, nowTime, errors, label, markApproved) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`visual_manifest_manual_verdict_invalid:${label}`);
    return;
  }
  const allowed = new Set(["pending", "approved", "rejected"]);
  check(allowed.has(value.status), errors, `visual_manifest_manual_verdict_status_invalid:${label}`);
  if (value.status !== "approved") {
    errors.push(`visual_manual_approval_required:${label}:${value.status ?? "missing"}`);
    return;
  }
  validateRequiredString(value.reviewer, errors, "visual_manual_reviewer_missing", label);
  const reviewedAt = parseTimestamp(value.reviewedAt);
  check(reviewedAt !== null, errors, `visual_manual_review_timestamp_invalid:${label}`);
  const captureTime = parseTimestamp(capturedAt);
  if (reviewedAt !== null) {
    check(reviewedAt <= nowTime + 5 * 60 * 1000, errors, `visual_manual_review_timestamp_in_future:${label}`);
    if (captureTime !== null) check(reviewedAt >= captureTime, errors, `visual_manual_review_predates_capture:${label}`);
  }
  markApproved();
}

function validateStringArray(value, errors, code, label, requireItems) {
  const valid = Array.isArray(value) && value.every(isNonEmptyString) && (!requireItems || value.length > 0);
  check(valid, errors, `${code}:${label}`);
}

function validateRequiredString(value, errors, code, label) {
  check(isNonEmptyString(value), errors, `${code}:${label}`);
}

async function inspectPng(path, errors, prefix, label) {
  try {
    const file = await stat(path);
    check(file.isFile() && file.size > 24, errors, `${prefix}_missing_or_empty:${label}`);
    if (!file.isFile() || file.size <= 24) return null;
    const bytes = await readFile(path);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    check(bytes.subarray(0, 8).equals(signature), errors, `${prefix}_png_signature_invalid:${label}`);
    if (!bytes.subarray(0, 8).equals(signature) || bytes.length < 24) return null;
    check(bytes.subarray(12, 16).toString("ascii") === "IHDR", errors, `${prefix}_png_ihdr_invalid:${label}`);
    check(bytes.subarray(-8, -4).toString("ascii") === "IEND", errors, `${prefix}_png_iend_invalid:${label}`);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    check(width > 0 && height > 0, errors, `${prefix}_png_dimensions_invalid:${label}`);
    return {
      width,
      height,
      modifiedAt: file.mtimeMs,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    errors.push(`${prefix}_missing_or_unreadable:${label}:${error.code ?? "unknown"}`);
    return null;
  }
}

async function readJson(path, errors) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    errors.push(`visual_manifest_unreadable:${error.code ?? error.name ?? "unknown"}`);
    return null;
  }
}

function resolveEvidencePath(value, repositoryRoot) {
  return isAbsolute(value) ? resolve(value) : resolve(repositoryRoot, value);
}

function isWithin(path, root) {
  const candidate = relative(root, path);
  return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
}

function isViewport(value) {
  return value && Number.isInteger(value.width) && value.width > 0 && Number.isInteger(value.height) && value.height > 0;
}

function viewportKey(value) {
  return `${value.width}x${value.height}`;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseTimestamp(value) {
  if (!isNonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function check(condition, errors, code) {
  if (!condition) errors.push(code);
}

function report(errors, shotCount, coverage, approvedCount = 0) {
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    shotCount,
    approvedCount,
    coverage: Object.fromEntries(coverage),
  };
}

function parseCliArgs(argv) {
  const options = {
    manifestPath: resolve(defaultAuditRoot, "screenshot-manifest.json"),
    auditRoot: defaultAuditRoot,
    repositoryRoot: defaultRepositoryRoot,
    maxAgeHours: 72,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--manifest" && value) options.manifestPath = value;
    else if (flag === "--audit-root" && value) options.auditRoot = value;
    else if (flag === "--repository-root" && value) options.repositoryRoot = value;
    else if (flag === "--max-age-hours" && value) options.maxAgeHours = Number(value);
    else throw new Error(`visual_audit_argument_invalid:${flag}`);
    index += 1;
  }
  return options;
}

async function main() {
  try {
    const result = await auditEvidenceManifest(parseCliArgs(process.argv.slice(2)));
    if (!result.ok) {
      for (const error of result.errors) process.stderr.write(`visual_evidence_error=${error}\n`);
      process.stderr.write(`v1_visual_evidence_audit=fail\n`);
      process.stderr.write(`v1_visual_evidence_error_count=${result.errors.length}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write("v1_visual_evidence_audit=pass\n");
    process.stdout.write(`v1_current_capture_count=${result.shotCount}\n`);
    process.stdout.write(`v1_manual_approved_count=${result.approvedCount}\n`);
    for (const [category, count] of Object.entries(result.coverage)) {
      process.stdout.write(`v1_evidence_${category.replaceAll("-", "_")}_count=${count}\n`);
    }
  } catch (error) {
    process.stderr.write(`visual_evidence_error=${error.message}\n`);
    process.stderr.write("v1_visual_evidence_audit=fail\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) await main();
