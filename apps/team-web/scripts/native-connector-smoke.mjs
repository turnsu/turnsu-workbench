import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadExtensions } from "../../../packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
const execute = promisify(execFile);
const zip = new Uint8Array(await readFile(new URL("../dist/downloads/turnsu-connector.zip", import.meta.url)));
const manifest = JSON.parse(await readFile(new URL("../dist/downloads/turnsu-connector.json", import.meta.url)));
assert.equal(createHash("sha256").update(zip).digest("hex"), manifest.sha256);
const entries = unzipSync(zip);
const expected = ["README.txt", "SHA256SUMS.json", "THIRD_PARTY_NOTICES.txt", "pi-entry.mjs", "turnsu.mjs"];
assert.deepEqual(Object.keys(entries).sort(), expected.map((name) => `turnsu-connector/${name}`).sort());
const sums = JSON.parse(strFromU8(entries["turnsu-connector/SHA256SUMS.json"]));
const directory = await mkdtemp(join(tmpdir(), "turnsu-portable-smoke-"));
try {
  for (const name of expected) {
    const data = entries[`turnsu-connector/${name}`];
    if (name !== "SHA256SUMS.json") assert.equal(createHash("sha256").update(data).digest("hex"), sums[name]);
    await writeFile(join(directory, name), data);
  }
  const { stdout } = await execute(process.execPath, [join(directory, "turnsu.mjs"), "help"], { cwd: directory, env: {} });
  assert.match(stdout, /Turnsu 连接器/);
  const loaded = await loadExtensions([join(directory, "pi-entry.mjs")], directory);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const tools = loaded.extensions[0].tools;
  assert.ok(tools.has("turnsu_work_results"));
  assert.ok(tools.has("turnsu_submit_update"));
  console.log("Portable CLI runs without source dependencies; Pi loads the bundled Product extension; archive checksums match.");
} finally { await rm(directory, { recursive: true, force: true }); }
