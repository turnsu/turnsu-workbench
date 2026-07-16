const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class ContainerWorkerProtocol {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    if (!input?.on || !output?.write) throw new TypeError("container_worker_protocol_streams_required");
    this.input = input;
    this.output = output;
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.pending = new Map();
    this.started = false;
    this.closed = false;
    this.writeChain = Promise.resolve();
    this.startPromise = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    input.on("data", (chunk) => this.#accept(chunk));
    input.once("end", () => this.#close(new Error("container_worker_protocol_ended")));
    input.once("error", (error) => this.#close(error));
  }

  waitForStart() {
    return this.startPromise;
  }

  call(message) {
    if (this.closed || !this.started || !isPlainObject(message)) {
      return Promise.reject(protocolError("container_worker_rpc_invalid"));
    }
    const id = `rpc-${++this.sequence}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { kind: "rpc_response", resolve, reject }));
    this.#send({ kind: "rpc_request", id, message }).catch((error) => {
      const operation = this.pending.get(id);
      this.pending.delete(id);
      operation?.reject(error);
    });
    return result;
  }

  sendEvent(type, payload = {}) {
    return this.#send({ kind: "event", type, payload });
  }

  sendCheckpoint(state) {
    return this.#send({ kind: "checkpoint", state });
  }

  sendChild(update) {
    if (this.closed || !this.started || !isPlainObject(update)) {
      return Promise.reject(protocolError("container_worker_child_invalid"));
    }
    const id = `child-${++this.sequence}`;
    const result = new Promise((resolve, reject) => this.pending.set(id, { kind: "child_response", resolve, reject }));
    this.#send({ kind: "child_request", id, update }).catch((error) => {
      const operation = this.pending.get(id);
      this.pending.delete(id);
      operation?.reject(error);
    });
    return result;
  }

  sendResult(result) {
    return this.#send({ kind: "result", result });
  }

  dispose() {
    this.#close(protocolError("container_worker_protocol_disposed"));
    this.input.removeAllListeners("data");
    this.input.removeAllListeners("end");
    this.input.removeAllListeners("error");
    this.input.pause?.();
  }

  #accept(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (this.buffer.byteLength > MAX_FRAME_BYTES && this.buffer.indexOf(10) < 0) {
      this.#close(protocolError("container_worker_frame_too_large"));
      return;
    }
    while (!this.closed) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.byteLength < 1 || line.byteLength > MAX_FRAME_BYTES) {
        this.#close(protocolError("container_worker_frame_invalid"));
        return;
      }
      try { this.#frame(JSON.parse(line.toString("utf8"))); }
      catch (error) { this.#close(error); }
    }
  }

  #frame(frame) {
    if (!isPlainObject(frame)) throw protocolError("container_worker_frame_invalid");
    if (frame.kind === "start") {
      if (this.started || !isPlainObject(frame.payload)) throw protocolError("container_worker_start_invalid");
      this.started = true;
      this.resolveStart(structuredClone(frame.payload));
      return;
    }
    if (!["rpc_response", "child_response"].includes(frame.kind)
      || typeof frame.id !== "string" || typeof frame.ok !== "boolean") {
      throw protocolError("container_worker_response_invalid");
    }
    const operation = this.pending.get(frame.id);
    if (!operation || (operation.kind && operation.kind !== frame.kind)) {
      throw protocolError("container_worker_response_unknown");
    }
    this.pending.delete(frame.id);
    if (frame.ok) operation.resolve(structuredClone(frame.result));
    else {
      const error = new Error(String(frame.error?.message || "Gateway request failed."));
      error.code = String(frame.error?.code || "gateway_request_invalid");
      error.status = String(frame.error?.status || "failed");
      error.productSafe = true;
      operation.reject(error);
    }
  }

  #send(frame) {
    if (this.closed) return Promise.reject(protocolError("container_worker_protocol_closed"));
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (bytes.byteLength > MAX_FRAME_BYTES) return Promise.reject(protocolError("container_worker_frame_too_large"));
    this.writeChain = this.writeChain.then(() => new Promise((resolve, reject) => {
      this.output.write(bytes, (error) => error ? reject(error) : resolve());
    }));
    return this.writeChain;
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    if (!this.started) this.rejectStart(error);
    for (const operation of this.pending.values()) operation.reject(error);
    this.pending.clear();
  }
}

function protocolError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = "failed";
  error.productSafe = true;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
