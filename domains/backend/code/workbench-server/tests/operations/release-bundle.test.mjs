import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";

import { stageLocalRelease } from "../../../../operations/local/release-bundle.mjs";

test("release staging is allowlisted, refuses overwrite, and dereferences dependency links", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-release-stage-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `${root}/source`;
  const destination = `${root}/bundle`;
  await mkdir(`${source}/packages/contracts`, { recursive: true });
  await mkdir(`${source}/server/node_modules`, { recursive: true });
  await writeFile(`${source}/packages/contracts/index.mjs`, "export const ok = true;\n");
  await symlink("../../packages/contracts", `${source}/server/node_modules/contracts`);
  const staged = await stageLocalRelease({
    sourceRoot: source,
    destination,
    entries: ["server/node_modules/contracts"],
  });
  assert.equal(staged.entries, 1);
  assert.equal((await lstat(`${destination}/server/node_modules/contracts`)).isDirectory(), true);
  assert.equal((await lstat(`${destination}/server/node_modules/contracts`)).isSymbolicLink(), false);
  assert.match(await readFile(`${destination}/server/node_modules/contracts/index.mjs`, "utf8"), /ok = true/);
  await assert.rejects(
    stageLocalRelease({ sourceRoot: source, destination, entries: ["server/node_modules/contracts"] }),
    { code: "release_stage_destination_exists" },
  );
});
