import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_MESSAGE_BYTES = 1_000_000;
export const AGENT_GATEWAY_CONTAINER_SOCKET = "/run/looloomi/gateway.sock";

export class UnixToolGatewayServer {
  constructor({ gateway, tempRoot = join(tmpdir(), "looloomi-agent-gateway") } = {}) {
    if (!gateway?.handle || typeof tempRoot !== "string" || tempRoot.length === 0) {
      throw new TypeError("unix_tool_gateway_dependencies_invalid");
    }
    this.gateway = gateway;
    this.tempRoot = tempRoot;
  }

  async open(binding) {
    if (!binding?.invocationId || !binding?.attemptId || !binding?.capabilityLeaseId) {
      throw new TypeError("unix_tool_gateway_binding_invalid");
    }
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(this.tempRoot, "endpoint-"));
    const socketPath = join(root, "gateway.sock");
    if (Buffer.byteLength(socketPath, "utf8") > 100) {
      await rm(root, { recursive: true, force: true });
      throw new TypeError("unix_tool_gateway_socket_path_too_long");
    }
    const nonce = randomBytes(32).toString("hex");
    const server = net.createServer((socket) => serveSocket(socket, {
      gateway: this.gateway,
      binding,
      nonce,
    }));
    try {
      await listen(server, socketPath);
      // The random endpoint directory is host-private and only this socket is bind-mounted.
      // The socket itself must be writable by the fixed non-root container UID.
      await chmod(socketPath, 0o666);
    } catch (error) {
      server.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    let closed = false;
    return Object.freeze({
      socketPath,
      containerSocketPath: AGENT_GATEWAY_CONTAINER_SOCKET,
      nonce,
      close: async () => {
        if (closed) return;
        closed = true;
        await closeServer(server);
        await rm(root, { recursive: true, force: true });
        this.gateway?.release?.(binding);
      },
    });
  }
}

function serveSocket(socket, { gateway, binding, nonce }) {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.byteLength > MAX_MESSAGE_BYTES) {
      socket.destroy();
      return;
    }
    while (true) {
      const newline = buffer.indexOf(10);
      if (newline < 0) break;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 1);
      chain = chain.then(() => processLine(socket, line, { gateway, binding, nonce }));
    }
  });
  socket.on("error", () => {});
}

async function processLine(socket, line, { gateway, binding, nonce }) {
  let response;
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object" || value.nonce !== nonce) throw safeError("gateway_endpoint_unauthorized");
    const { nonce: _nonce, ...message } = value;
    response = { ok: true, result: await gateway.handle(message, binding) };
  } catch (error) {
    response = {
      ok: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "gateway_request_invalid",
        message: error?.productSafe === true ? error.message : "Gateway request is invalid.",
      },
    };
  }
  const bytes = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
  if (bytes.byteLength > MAX_MESSAGE_BYTES) {
    socket.destroy();
    return;
  }
  socket.write(bytes);
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function safeError(code) {
  const error = new Error("Gateway endpoint is not authorized.");
  error.code = code;
  error.productSafe = true;
  return error;
}
