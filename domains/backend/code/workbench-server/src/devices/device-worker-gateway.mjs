import { WebSocketServer } from "ws";

const DEFAULT_PATH = "/internal/workbench/v1/device-worker";
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,512})$/;

/**
 * HTTP upgrade boundary for an outbound Desktop worker.
 *
 * This is deliberately an internal endpoint, not a public Product API. The
 * upgrade authenticates the normal short-lived native bearer token, then asks
 * the PostgreSQL Device owner to bind the socket to the exact registered
 * Device/session. Browser cookies, caller supplied workspace IDs, and generic
 * Worker HTTP commands are never accepted here.
 */
export class DeviceWorkerGateway {
  #authService;
  #deviceLifecycle;
  #registry;
  #path;
  #webSocketServer;
  #server = null;
  #upgradeListener;

  constructor({ authService, deviceLifecycle, registry, path = DEFAULT_PATH } = {}) {
    if (!authService || typeof authService.authenticateNativeAccessToken !== "function"
      || !deviceLifecycle || typeof deviceLifecycle.authenticateWorkerConnection !== "function"
      || !registry || typeof registry.accept !== "function"
      || typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("device_worker_gateway_dependencies_invalid");
    }
    this.#authService = authService;
    this.#deviceLifecycle = deviceLifecycle;
    this.#registry = registry;
    this.#path = path;
    this.#webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });
    this.#upgradeListener = (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head);
    };
  }

  attach(server) {
    if (!server || typeof server.on !== "function") throw new TypeError("device_worker_gateway_server_required");
    if (this.#server && this.#server !== server) throw new TypeError("device_worker_gateway_already_attached");
    if (!this.#server) {
      this.#server = server;
      server.on("upgrade", this.#upgradeListener);
    }
    return this;
  }

  close() {
    if (this.#server) this.#server.off?.("upgrade", this.#upgradeListener);
    this.#server = null;
    this.#webSocketServer.clients.forEach((socket) => socket.terminate());
    this.#webSocketServer.close();
  }

  async #handleUpgrade(request, socket, head) {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      if (url.pathname !== this.#path) {
        rejectUpgrade(socket, 404, "route_not_found");
        return;
      }
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId || [...url.searchParams.keys()].some((key) => key !== "deviceId")) {
        rejectUpgrade(socket, 400, "device_id_required");
        return;
      }
      const token = nativeBearer(request.headers.authorization);
      if (!token) {
        rejectUpgrade(socket, 401, "native_access_token_invalid");
        return;
      }
      // Native shells should not be hosted from browser origins. A native
      // connection carries no Origin; if a client sends one, it is rejected.
      if (request.headers.origin) {
        rejectUpgrade(socket, 403, "origin_forbidden");
        return;
      }
      const session = await this.#authService.authenticateNativeAccessToken({ accessToken: token });
      if (!session || session.clientKind !== "desktop" || !session.clientSessionId || !session.devicePublicKey) {
        rejectUpgrade(socket, 401, "native_access_token_invalid");
        return;
      }
      const binding = await this.#deviceLifecycle.authenticateWorkerConnection({
        deviceId,
        context: session,
      });
      this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const connection = this.#registry.accept({
          binding,
          send: (message) => {
            if (webSocket.readyState === webSocket.OPEN) webSocket.send(JSON.stringify(message));
          },
          terminate: () => {
            if (webSocket.readyState === webSocket.OPEN || webSocket.readyState === webSocket.CLOSING) {
              webSocket.close(4003, "device_connection_closed");
            }
          },
        });
        webSocket.on("message", (data, isBinary) => {
          if (isBinary) {
            connection.close("device_binary_message_forbidden");
            return;
          }
          connection.receive(data);
        });
        webSocket.once("close", () => connection.close("device_transport_disconnected"));
        webSocket.once("error", () => connection.close("device_transport_disconnected"));
      });
    } catch {
      rejectUpgrade(socket, 401, "native_access_token_invalid");
    }
  }
}

function nativeBearer(value) {
  if (typeof value !== "string") return null;
  return BEARER.exec(value)?.[1] ?? null;
}

function rejectUpgrade(socket, status, code) {
  if (!socket || socket.destroyed) return;
  const body = JSON.stringify({ code });
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n`
      + "Content-Type: application/json; charset=utf-8\r\n"
      + "Cache-Control: no-store\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + "Connection: close\r\n\r\n"
      + body,
  );
  socket.destroy();
}

function statusText(status) {
  return ({ 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" })[status] ?? "Bad Request";
}
