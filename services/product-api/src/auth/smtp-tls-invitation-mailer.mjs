import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

import { ProductStoreError } from "../store/errors.mjs";

const CRLF = "\r\n";

const required = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(code);
  return value;
};

const email = (value, code) => {
  const normalized = String(value ?? "").trim().normalize("NFKC").toLowerCase();
  if (normalized.length > 320 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(normalized)) {
    throw new ProductStoreError(code, "The email address is invalid.");
  }
  return normalized;
};

const header = (value, fallback) => String(value ?? fallback)
  .replace(/[\r\n]+/gu, " ")
  .replace(/[\x00-\x1f\x7f]+/gu, " ")
  .trim()
  .slice(0, 200) || fallback;

const encodedBody = (value) => Buffer.from(String(value ?? "")
  .replace(/\r?\n/gu, CRLF)
  .replace(/\x00/gu, ""), "utf8")
  .toString("base64")
  .match(/.{1,76}/gu)
  ?.join(CRLF) ?? "";

const isExpected = (response, expected) => expected.includes(response.code);

class SmtpConversation {
  #socket;
  #buffer = "";
  #responses = [];
  #waiters = [];
  #current = null;
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.once("error", (error) => this.#finish(error));
    socket.once("close", () => this.#finish(new Error("smtp_connection_closed")));
  }

  async response(expected) {
    const response = this.#responses.length > 0
      ? this.#responses.shift()
      : await new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    if (!isExpected(response, expected)) {
      throw new ProductStoreError("smtp_delivery_rejected", "The SMTP relay rejected invitation delivery.");
    }
    return response;
  }

  async command(value, expected) {
    if (/\r|\n/u.test(value)) throw new TypeError("smtp_command_injection");
    this.#socket.write(`${value}${CRLF}`);
    return this.response(expected);
  }

  replaceSocket(socket) {
    this.#socket.removeAllListeners("data");
    this.#socket.removeAllListeners("error");
    this.#socket.removeAllListeners("close");
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#receive(chunk));
    socket.once("error", (error) => this.#finish(error));
    socket.once("close", () => this.#finish(new Error("smtp_connection_closed")));
  }

  close() {
    this.#closed = true;
    this.#socket.destroy();
  }

  #receive(chunk) {
    this.#buffer += chunk;
    while (true) {
      const index = this.#buffer.indexOf(CRLF);
      if (index < 0) break;
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + CRLF.length);
      const match = /^(\d{3})([ -])(.*)$/u.exec(line);
      if (!match) {
        this.#finish(new Error("smtp_response_invalid"));
        return;
      }
      const item = { code: Number(match[1]), separator: match[2], text: match[3] };
      if (this.#current && this.#current.code !== item.code) {
        this.#finish(new Error("smtp_response_invalid"));
        return;
      }
      this.#current = this.#current ?? { code: item.code, lines: [] };
      this.#current.lines.push(item.text);
      if (item.separator === " ") {
        const complete = this.#current;
        this.#current = null;
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(complete);
        else this.#responses.push(complete);
      }
    }
  }

  #finish(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

const connectSocket = ({ host, port, mode, servername, timeoutMilliseconds }) => new Promise((resolve, reject) => {
  const options = { host, port, servername, minVersion: "TLSv1.2", rejectUnauthorized: true };
  const socket = mode === "implicit-tls"
    ? tls.connect(options)
    : net.connect({ host, port });
  const event = mode === "implicit-tls" ? "secureConnect" : "connect";
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new ProductStoreError("smtp_delivery_timeout", "The SMTP relay timed out."));
  }, timeoutMilliseconds);
  socket.once(event, () => {
    clearTimeout(timer);
    resolve(socket);
  });
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const upgradeStartTls = ({ socket, servername, timeoutMilliseconds }) => new Promise((resolve, reject) => {
  const secure = tls.connect({
    socket,
    servername,
    minVersion: "TLSv1.2",
    rejectUnauthorized: true,
  });
  const timer = setTimeout(() => {
    secure.destroy();
    reject(new ProductStoreError("smtp_delivery_timeout", "The SMTP relay timed out."));
  }, timeoutMilliseconds);
  secure.once("secureConnect", () => {
    clearTimeout(timer);
    resolve(secure);
  });
  secure.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

export const renderWorkspaceInvitationMessage = ({
  recipientEmail,
  workspaceName,
  invitationUrl,
  expiresAt,
  from,
  messageId = randomUUID(),
} = {}) => {
  const recipient = email(recipientEmail, "smtp_recipient_invalid");
  const sender = email(from, "smtp_sender_invalid");
  let parsedUrl;
  try { parsedUrl = new URL(invitationUrl); } catch { throw new ProductStoreError("smtp_invitation_url_invalid", "The invitation URL is invalid."); }
  if (parsedUrl.protocol !== "https:" || !parsedUrl.hash.startsWith("#token=")) {
    throw new ProductStoreError("smtp_invitation_url_invalid", "The invitation URL is invalid.");
  }
  const name = header(workspaceName, "your workspace");
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new ProductStoreError("smtp_invitation_expiry_invalid", "The invitation expiry is invalid.");
  // Keep the header ASCII-only. The workspace name belongs in the UTF-8 body,
  // which is base64 encoded so no SMTPUTF8/8BITMIME extension is assumed.
  const subject = "Workspace invitation";
  const text = encodedBody([
    `You have been invited to join ${name}.`,
    "",
    "Open this link to accept the invitation and continue with Google or GitHub:",
    parsedUrl.toString(),
    "",
    `This link expires at ${expiry.toISOString()}.`,
    "If you were not expecting this invitation, you can ignore this email.",
  ].join("\n"));
  return [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@looloomi.invalid>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    text,
  ].join(CRLF);
};

/**
 * SMTP transport adapter for the durable invitation outbox. Credentials are
 * supplied by the caller (normally a Secret Store adapter), never read from
 * process environment here. Both implicit TLS and STARTTLS require certificate
 * verification and TLS 1.2 or later.
 */
export class SmtpTlsInvitationMailer {
  #host;
  #port;
  #username;
  #password;
  #from;
  #mode;
  #servername;
  #timeoutMilliseconds;
  #clientName;

  constructor({
    host,
    port = 465,
    username,
    password,
    from,
    mode = "implicit-tls",
    servername = host,
    timeoutMilliseconds = 15_000,
    clientName = "looloomi.local",
  } = {}) {
    this.#host = required(host, "smtp_host_required");
    this.#username = required(username, "smtp_username_required");
    this.#password = required(password, "smtp_password_required");
    this.#from = email(from, "smtp_sender_invalid");
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError("smtp_port_invalid");
    if (mode !== "implicit-tls" && mode !== "starttls") throw new TypeError("smtp_tls_mode_invalid");
    if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 120_000) {
      throw new TypeError("smtp_timeout_invalid");
    }
    if (!/^[A-Za-z0-9.-]{1,253}$/u.test(servername)) throw new TypeError("smtp_servername_invalid");
    if (!/^[A-Za-z0-9.-]{1,253}$/u.test(clientName)) throw new TypeError("smtp_client_name_invalid");
    this.#port = port;
    this.#mode = mode;
    this.#servername = servername;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#clientName = clientName;
  }

  async sendWorkspaceInvitation({ recipientEmail, workspaceName, invitationUrl, expiresAt } = {}) {
    const messageId = randomUUID();
    const message = renderWorkspaceInvitationMessage({
      recipientEmail,
      workspaceName,
      invitationUrl,
      expiresAt,
      from: this.#from,
      messageId,
    });
    let socket;
    let conversation;
    try {
      socket = await connectSocket({
        host: this.#host,
        port: this.#port,
        mode: this.#mode,
        servername: this.#servername,
        timeoutMilliseconds: this.#timeoutMilliseconds,
      });
      conversation = new SmtpConversation(socket);
      await conversation.response([220]);
      let greeting = await conversation.command(`EHLO ${this.#clientName}`, [250]);
      if (this.#mode === "starttls") {
        if (!greeting.lines.some((line) => /^STARTTLS(?:\s|$)/iu.test(line))) {
          throw new ProductStoreError("smtp_tls_unavailable", "The SMTP relay does not support TLS.");
        }
        await conversation.command("STARTTLS", [220]);
        socket = await upgradeStartTls({ socket, servername: this.#servername, timeoutMilliseconds: this.#timeoutMilliseconds });
        conversation.replaceSocket(socket);
        greeting = await conversation.command(`EHLO ${this.#clientName}`, [250]);
      }
      if (!greeting.lines.some((line) => /^AUTH(?:\s|=)/iu.test(line))) {
        throw new ProductStoreError("smtp_auth_unavailable", "The SMTP relay does not support the required authentication.");
      }
      const credentials = Buffer.from(`\u0000${this.#username}\u0000${this.#password}`).toString("base64");
      await conversation.command(`AUTH PLAIN ${credentials}`, [235]);
      const sender = email(this.#from, "smtp_sender_invalid");
      const recipient = email(recipientEmail, "smtp_recipient_invalid");
      await conversation.command(`MAIL FROM:<${sender}>`, [250]);
      await conversation.command(`RCPT TO:<${recipient}>`, [250, 251]);
      await conversation.command("DATA", [354]);
      socket.write(`${message}${CRLF}.${CRLF}`);
      await conversation.response([250]);
      await conversation.command("QUIT", [221]);
      return { receiptId: `smtp-${messageId}` };
    } catch (error) {
      if (error instanceof ProductStoreError) throw error;
      throw new ProductStoreError("smtp_delivery_failed", "The SMTP relay could not deliver the invitation.");
    } finally {
      conversation?.close();
      socket?.destroy();
    }
  }
}
