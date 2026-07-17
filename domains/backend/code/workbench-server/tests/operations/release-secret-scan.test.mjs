import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import test from "node:test";

import { scanReleaseSecrets } from "../../../../operations/local/release-secret-scan.mjs";

const COMMIT = "a".repeat(40);

test("release secret scan reports only rule IDs and paths and excludes its evidence output", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-secret-scan-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/release-evidence`, { recursive: true });
  await writeFile(`${root}/safe.mjs`, "export const endpoint = 'https://provider.example/v1';\n");
  const leakedSecret = ["mongodb://user", "actual-password@127.0.0.1:27017"].join(":");
  const ignoredSecret = ["mongodb://ignored", "secret@localhost"].join(":");
  await writeFile(`${root}/leak.env`, `MONGODB_URI=${leakedSecret}\n`);
  await writeFile(`${root}/release-evidence/secret-scan.json`, `${ignoredSecret}\n`);
  await writeFile(`${root}/large-binary`, Buffer.from([0, 1, 2, 3]));
  await truncate(`${root}/large-binary`, 26 * 1024 * 1024);

  const report = await scanReleaseSecrets({ root, sourceCommit: COMMIT });
  assert.equal(report.filesScanned, 2);
  assert.equal(report.binaryFilesSkipped, 1);
  assert.equal(report.oversizedFilesSkipped, 0);
  assert.equal(report.findings, 1);
  assert.deepEqual(report.matches, [{ path: "leak.env", rule: "mongodb_password_uri" }]);
  assert.equal(JSON.stringify(report).includes("actual-password"), false);
});
