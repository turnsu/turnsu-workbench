import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "turnsu-intelligence-ui", version: "1.0.0" }, {});
const listeners = new Set();
let save = async () => {};
app.ontoolresult = () => {
  for (const listener of listeners) listener();
};
app.onteardown = async () => {
  await save();
  return {};
};
const connected = app.connect();
export const surfaceBridge = {
  async invoke(method, args = {}) {
    await connected;
    const result = await app.callServerTool({
      name: "turnsu_surface",
      arguments: { method, args },
    });
    if (result.isError)
      throw new Error(
        result.content?.find((c) => c.type === "text")?.text || "交互未完成。",
      );
    return result.structuredContent.value;
  },
  listen(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  flush(callback) {
    save = callback;
    return () => {
      save = async () => {};
    };
  },
};
