import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler } from "../../src/web/static-handler.mjs";

test("connector downloads serve exact archive bytes, missing downloads do not return the SPA", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "turnsu-download-"));
  await mkdir(join(dir, "downloads"));
  const bytes = Buffer.from([0x50,0x4b,0x03,0x04,0x00,0xff]);
  await writeFile(join(dir, "downloads/turnsu-connector.zip"), bytes);
  await writeFile(join(dir, "index.html"), "<main>workspace</main>");
  const handler = createStaticHandler({ distDirectory: dir });
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/downloads/turnsu-connector.zip`);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await fetch(`${url}/downloads/missing.zip`)).status, 404);
  assert.equal(await (await fetch(`${url}/work`)).text(), "<main>workspace</main>");
});
