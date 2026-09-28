import { createInterface } from "node:readline";
import { LocalAgentHost } from "./host.mjs";

process.umask(0o077);
const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const directory = process.argv[2];
if (!directory) throw new Error("local_state_directory_required");
const host = new LocalAgentHost({ directory, notify: (event) => output({ event }) });
let closing = false;
async function close() { if (closing) return; closing = true; await host.close(); process.exit(0); }
createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try {
    if (line.length > 150_000) throw new Error("请求内容过长。");
    request = JSON.parse(line);
    if (request.method === "shutdown") return close();
    const result = await host.command(request.method, request.args);
    output({ id: request.id, result });
  } catch (error) { output({ id: request?.id ?? null, error: error.message }); }
}).on("close", close);
process.on("SIGTERM", close); process.on("SIGINT", close);
