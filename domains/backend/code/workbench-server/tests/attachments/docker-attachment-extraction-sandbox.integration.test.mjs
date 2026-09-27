import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DockerAttachmentExtractionSandbox } from "../../src/attachments/docker-attachment-extraction-sandbox.mjs";

const executeFile = promisify(execFile);
const ENABLED = process.env.WORKBENCH_ATTACHMENT_DOCKER_INTEGRATION === "1";
const IMAGE = process.env.WORKBENCH_ATTACHMENT_EXTRACTOR_IMAGE ?? "";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MANAGED_DIRECTORY = "looloomi-attachment-extraction-v1";

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(value);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function workbook(sheetCount) {
  return storedZip([
    ["xl/workbook.xml", "<workbook/>"],
    ...Array.from({ length: sheetCount }, (_, index) => [
      `xl/worksheets/sheet${index + 1}.xml`,
      "<worksheet><sheetData><row r=\"1\"><c><v>1</v></c></row></sheetData></worksheet>",
    ]),
  ]);
}

test("real Docker attachment sandbox is isolated and fails closed", {
  skip: !ENABLED,
  timeout: 90_000,
}, async (t) => {
  assert.match(IMAGE, /@sha256:[a-f0-9]{64}$/, "WORKBENCH_ATTACHMENT_EXTRACTOR_IMAGE must be digest pinned");
  await executeFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000 });
  await executeFile("docker", ["image", "inspect", IMAGE], { timeout: 5_000 });
  const dockerBinary = (await executeFile("which", ["docker"], { timeout: 5_000 })).stdout.trim();

  const root = await mkdtemp(join(tmpdir(), "looloomi-attachment-docker-integration-"));
  const wrapperPath = join(root, "docker-inspect-wrapper.mjs");
  const proofPath = join(root, "container-inspect.json");
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const docker = ${JSON.stringify(dockerBinary)};
const proof = ${JSON.stringify(proofPath)};
const args = process.argv.slice(2);
if (args[0] !== "run") process.exit(64);
const create = spawnSync(docker, ["create", ...args.slice(1).filter((value) => value !== "--rm")], { encoding: "utf8" });
if (create.status !== 0) {
  process.stderr.write(create.stderr || "docker create failed");
  process.exit(create.status ?? 125);
}
const containerId = create.stdout.trim();
try {
  const inspect = spawnSync(docker, ["inspect", containerId], { encoding: "utf8" });
  if (inspect.status !== 0) process.exit(inspect.status ?? 125);
  writeFileSync(proof, inspect.stdout, { mode: 0o600 });
  const start = spawnSync(docker, ["start", "--attach", containerId], { encoding: "utf8" });
  if (start.stdout) process.stdout.write(start.stdout);
  if (start.stderr) process.stderr.write(start.stderr);
  process.exitCode = start.status ?? 1;
} finally {
  spawnSync(docker, ["rm", "--force", containerId], { stdio: "ignore" });
}
`;
  await writeFile(wrapperPath, wrapper, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));

  const sandbox = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    dockerBinary: wrapperPath,
    tempRoot: root,
  });
  const extracted = await sandbox.extract({
    bytes: Buffer.from("production sandbox proof"),
    mediaType: "text/plain",
  });
  assert.equal(extracted.text, "production sandbox proof");

  const [inspection] = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(inspection.Config.User, "65532:65532");
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal(inspection.HostConfig.Memory, 256 * 1024 * 1024);
  assert.equal(inspection.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(inspection.HostConfig.PidsLimit, 64);
  assert.match(inspection.HostConfig.Tmpfs["/tmp"], /noexec/);
  assert.match(inspection.HostConfig.Tmpfs["/tmp"], /nosuid/);
  assert.match(inspection.HostConfig.Tmpfs["/tmp"], /nodev/);
  for (const destination of ["/input/source.bin", "/worker/attachment-extractor-worker.mjs"]) {
    assert.equal(inspection.Mounts.find((mount) => mount.Destination === destination)?.RW, false);
  }
  assert.equal(inspection.Mounts.find((mount) => mount.Destination === "/output")?.RW, true);

  await assert.rejects(
    sandbox.extract({ bytes: workbook(65), mediaType: XLSX }),
    (error) => error?.code === "attachment_limit_exceeded",
  );
  const unavailable = new DockerAttachmentExtractionSandbox({
    image: IMAGE,
    dockerBinary: join(root, "missing-docker"),
    tempRoot: root,
  });
  await assert.rejects(
    unavailable.extract({ bytes: Buffer.from("must not parse on host"), mediaType: "text/plain" }),
    (error) => error?.code === "attachment_processing_unavailable",
  );
  assert.deepEqual(await readdir(join(root, MANAGED_DIRECTORY)), []);
});
