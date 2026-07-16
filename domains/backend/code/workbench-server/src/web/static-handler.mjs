import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const extension = (path) => path.slice(path.lastIndexOf("."));

export function createStaticHandler({ distDirectory } = {}) {
  if (!distDirectory) return async () => false;
  const root = resolve(distDirectory);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const requested = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const candidate = resolve(root, `.${requested === "/" ? "/index.html" : requested}`);
    const file = candidate.startsWith(`${root}${sep}`) || candidate === root ? candidate : null;
    const selected = file && existsSync(file) && statSync(file).isFile()
      ? file
      : resolve(root, "index.html");
    if (!existsSync(selected) || !statSync(selected).isFile()) return false;
    res.writeHead(200, { "content-type": mime[extension(selected)] ?? "application/octet-stream" });
    if (req.method === "HEAD") res.end();
    else createReadStream(selected).pipe(res);
    return true;
  };
}
