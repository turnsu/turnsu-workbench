import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { strToU8, zipSync } from "fflate";

import { unpackZipBytes } from "../src/components/skills/zip-skill-package.js";

const helperSource = await readFile(
  new URL("../src/components/skills/zip-skill-package.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(helperSource, /(?:from\s+|require\()\s*["']fflate["']/);
assert.match(helperSource, /import\(\s*["']fflate["']\s*\)/);

const valid = await unpackZipBytes(zipSync({
  "calendar-skill/SKILL.md": strToU8("---\nname: calendar-skill\ndescription: Calendar helper\n---\n"),
  "calendar-skill/references/usage.md": strToU8("Use the calendar tool."),
}));
assert.deepEqual(valid.map((entry) => entry.path), ["SKILL.md", "references/usage.md"]);
assert.equal(new TextDecoder().decode(valid[0].bytes).includes("calendar-skill"), true);

await assert.rejects(
  () => unpackZipBytes(zipSync({ "../SKILL.md": strToU8("unsafe") })),
  (error) => error?.code === "zip_path_invalid",
);

await assert.rejects(
  () => unpackZipBytes(zipSync({ "SKILL.md": strToU8("one"), "references/a.md": strToU8("two") }), { maxFiles: 1 }),
  (error) => error?.code === "zip_file_limit_exceeded",
);

await assert.rejects(
  () => unpackZipBytes(zipSync({ "SKILL.md": strToU8("too much content") }), { maxTotalBytes: 4 }),
  (error) => error?.code === "zip_uncompressed_size_exceeded",
);

console.log("zip Skill package smoke passed");
