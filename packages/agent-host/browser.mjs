export const browserTool = {
  name: "turnsu_browser",
  description:
    "Operate the exact embedded browser page authorized by the human for this session. This is the local embedded browser, not the isolated CUA desktop. read returns text and CSS selectors; click/type/upload use an observed selector. A page navigation invalidates prior selectors; read again. upload only accepts one explicitly granted project file, which the Host revalidates. No arbitrary JS or CDP. Revocation or manual takeover stops further actions.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["read", "click", "type", "upload", "navigate"],
      },
      selector: { type: "string", maxLength: 1000 },
      text: { type: "string", maxLength: 16000 },
      url: { type: "string", maxLength: 4096 },
      path: { type: "string", maxLength: 1000 },
      revision: { type: "integer" },
    },
    required: ["operation"],
    additionalProperties: false,
  },
};
export class Browser {
  constructor(host, transport) {
    this.host = host;
    this.transport = transport;
    host.db.exec(
      "CREATE TABLE IF NOT EXISTS browser_pages(session_id TEXT PRIMARY KEY REFERENCES sessions(id),url TEXT NOT NULL)",
    );
  }
  remember(sessionId, url) {
    this.host.session(sessionId);
    if (typeof url !== "string" || url.length > 4096)
      throw new Error("页面地址无效。");
    this.host.db
      .prepare(
        "INSERT INTO browser_pages VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET url=excluded.url",
      )
      .run(sessionId, url);
    return { saved: true };
  }
  read(sessionId) {
    this.host.session(sessionId);
    const r = this.host.db
      .prepare("SELECT url FROM browser_pages WHERE session_id=?")
      .get(sessionId);
    return r ? { ...r, resident: false, grant: null, downloads: [] } : null;
  }
  tools() {
    return [browserTool];
  }
  async call(sessionId, args) {
    const session = this.host.session(sessionId);
    this.host.schedules?.assertTool(sessionId, "computer");
    if (
      !["read", "click", "type", "upload", "navigate"].includes(
        args.operation,
      ) ||
      JSON.stringify(args).length > 24000
    )
      throw new Error("浏览器操作无效。");
    let file;
    if (args.operation === "upload") {
      file = await this.host.ui.file(session.project_id, args.path);
      file.absolute = await this.host.pathInProject(
        session.project_id,
        args.path,
      );
    }
    return this.transport("browser.call", {
      sessionId,
      projectId: session.project_id,
      request: args,
      file,
    });
  }
}
