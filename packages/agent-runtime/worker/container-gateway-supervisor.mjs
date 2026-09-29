import { createHash, randomUUID } from "node:crypto";
import { mkdir, rmdir, unlink } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
// macOS has a much lower Unix-domain socket pathname limit than a normal file
// path. Leave margin for platform-specific terminators rather than allowing a
// long test or workspace directory to turn a valid Product Gateway into EINVAL.
const MAX_SOCKET_PATH_BYTES = 96;

export async function startContainerGatewaySupervisor({ payload, rpc, socketRoot = "/tmp" } = {}) {
  if (!payload?.invocationId || !payload?.attemptId || typeof rpc?.call !== "function") {
    throw new TypeError("container_gateway_supervisor_dependencies_invalid");
  }
  const socket = await prepareSocketPath({ payload, socketRoot });
  const socketPath = socket.path;
  await unlink(socketPath).catch(() => {});
  const toolMap = Object.fromEntries(payload.capabilities.toolAllowlist.map((toolId, index) => [`product_tool_${index}`, toolId]));
  const usage = { steps: 0, modelRequests: 0 };
  const childBindings = new Map();
  const childUsage = new Map();
  const childWaiters = new Map();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      if (buffer.byteLength > MAX_FRAME_BYTES && buffer.indexOf(10) < 0) return socket.destroy();
      while (!socket.destroyed) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.byteLength < 1 || line.byteLength > MAX_FRAME_BYTES) return socket.destroy();
        let frame;
        try { frame = JSON.parse(line.toString("utf8")); } catch { return socket.destroy(); }
        void handleFrame(frame).then(
          (result) => writeFrame(socket, { id: frame.id, ok: true, result }),
          (error) => writeFrame(socket, {
            id: typeof frame?.id === "string" ? frame.id : "invalid",
            ok: false,
            error: {
              code: typeof error?.code === "string" ? error.code : "gateway_request_invalid",
              status: typeof error?.status === "string" ? error.status : "failed",
              message: error?.productSafe === true ? error.message : "Gateway request is invalid.",
            },
          }),
        ).catch(() => socket.destroy());
      }
    });
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => sockets.delete(socket));
  });
  const handleFrame = async (frame) => {
    if (!isPlainObject(frame) || typeof frame.id !== "string" || frame.id.length < 1 || frame.id.length > 128
      || !["model", "tool"].includes(frame.operation) || !isPlainObject(frame.input)
      || (frame.childRef !== undefined && !validChildRef(frame.childRef))) {
      throw protocolError();
    }
    const binding = payload.mode === "agent_orchestrator"
      ? await waitForChildBinding(frame.childRef)
      : parentBinding(payload);
    if (usage.steps >= payload.limits.maxSteps) {
      throw protocolError("gateway_step_budget_exceeded", "permission_denied");
    }
    usage.steps += 1;
    const governedUsage = usageForChild(frame.childRef);
    governedUsage.steps += 1;
    if (frame.operation === "model") {
      if (usage.modelRequests >= payload.limits.maxModelRequests) {
        throw protocolError("gateway_model_budget_exceeded", "permission_denied");
      }
      usage.modelRequests += 1;
      governedUsage.modelRequests += 1;
      return rpc.call(gatewayMessage(binding, "model", { input: structuredClone(frame.input) }));
    }
    const toolId = toolMap[frame.toolAlias];
    if (!toolId) throw protocolError("gateway_tool_forbidden", "permission_denied");
    return rpc.call(gatewayMessage(binding, "tool", { toolId, input: structuredClone(frame.input) }));
  };
  const waitForChildBinding = (childRef) => {
    if (!validChildRef(childRef)) return Promise.reject(protocolError("orchestrator_child_ref_missing"));
    const existing = childBindings.get(childRef);
    if (existing) return Promise.resolve(existing);
    let waiter = childWaiters.get(childRef);
    if (waiter) return waiter.promise;
    let resolveWaiter;
    let rejectWaiter;
    const timer = setTimeout(() => {
      childWaiters.delete(childRef);
      rejectWaiter(protocolError("orchestrator_child_binding_unavailable", "blocked"));
    }, Math.min(payload.limits.timeoutMs, 5_000));
    const promise = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    waiter = { promise, resolve: resolveWaiter, reject: rejectWaiter, timer };
    childWaiters.set(childRef, waiter);
    return promise;
  };
  const usageForChild = (childRef) => {
    const key = validChildRef(childRef) ? childRef : "parent";
    let value = childUsage.get(key);
    if (!value) {
      value = { steps: 0, modelRequests: 0 };
      childUsage.set(key, value);
    }
    return value;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
    await socket.dispose();
    throw error;
  }
  const previous = new Map();
  setEnvironment(previous, "LOOLOOMI_AGENT_SUPERVISOR_SOCKET", socketPath);
  setEnvironment(previous, "LOOLOOMI_PRODUCT_TOOL_MAP", JSON.stringify(toolMap));
  setEnvironment(previous, "LOOLOOMI_GATEWAY_MAX_MODEL_REQUESTS", String(payload.limits.maxModelRequests));
  return Object.freeze({
    socketPath,
    toolAliases: Object.keys(toolMap),
    usage,
    registerChild(childRef, binding) {
      if (!validChildRef(childRef) || !validBinding(binding)) throw protocolError("orchestrator_child_binding_invalid");
      const normalized = Object.freeze({
        invocationId: binding.invocationId,
        attemptId: binding.attemptId,
        capabilityLeaseId: binding.capabilityLeaseId,
      });
      const existing = childBindings.get(childRef);
      if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
        throw protocolError("orchestrator_child_binding_changed");
      }
      childBindings.set(childRef, normalized);
      const waiter = childWaiters.get(childRef);
      if (waiter) {
        clearTimeout(waiter.timer);
        childWaiters.delete(childRef);
        waiter.resolve(normalized);
      }
      return normalized;
    },
    usageForChild(childRef) {
      return structuredClone(usageForChild(childRef));
    },
    async close() {
      for (const waiter of childWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(protocolError("orchestrator_child_binding_unavailable", "blocked"));
      }
      childWaiters.clear();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await unlink(socketPath).catch(() => {});
      await socket.dispose();
      restoreEnvironment(previous);
    },
  });
}

async function prepareSocketPath({ payload, socketRoot }) {
  const filename = `looloomi-agent-supervisor-${process.pid}.sock`;
  const preferred = join(socketRoot, filename);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_SOCKET_PATH_BYTES) {
    await mkdir(socketRoot, { recursive: true, mode: 0o700 });
    return Object.freeze({ path: preferred, async dispose() {} });
  }
  const entropy = `${payload.invocationId}\u0000${payload.attemptId}\u0000${process.pid}\u0000${randomUUID()}`;
  const suffix = createHash("sha256").update(entropy).digest("hex").slice(0, 20);
  const fallbackRoot = join("/tmp", `looloomi-gw-${suffix}`);
  const path = join(fallbackRoot, filename);
  await mkdir(fallbackRoot, { recursive: true, mode: 0o700 });
  if (Buffer.byteLength(path, "utf8") > MAX_SOCKET_PATH_BYTES) {
    await rmdir(fallbackRoot).catch(() => {});
    throw new Error("container_gateway_socket_path_too_long");
  }
  return Object.freeze({
    path,
    async dispose() { await rmdir(fallbackRoot).catch(() => {}); },
  });
}

function gatewayMessage(binding, operation, fields) {
  return {
    operation,
    invocationId: binding.invocationId,
    attemptId: binding.attemptId,
    capabilityLeaseId: binding.capabilityLeaseId,
    ...fields,
  };
}

function parentBinding(payload) {
  return {
    invocationId: payload.invocationId,
    attemptId: payload.attemptId,
    capabilityLeaseId: payload.gateway.capabilityLeaseId,
  };
}

function writeFrame(socket, frame) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (bytes.byteLength > MAX_FRAME_BYTES) return reject(protocolError());
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

function setEnvironment(previous, key, value) {
  previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  process.env[key] = value;
}

function restoreEnvironment(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function protocolError(code = "gateway_request_invalid", status = "failed") {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.productSafe = true;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validChildRef(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validBinding(value) {
  return isPlainObject(value) && [value.invocationId, value.attemptId, value.capabilityLeaseId]
    .every((item) => typeof item === "string" && item.length > 0);
}
