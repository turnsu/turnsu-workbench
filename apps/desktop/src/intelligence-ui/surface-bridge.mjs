import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "turnsu-intelligence-ui", version: "1.0.0" }, {});
const listeners = new Set();
let save = async () => {};
const applyAppearance = context => {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
};
app.onhostcontextchanged = applyAppearance;
app.ontoolresult = () => { for (const listener of listeners) listener(); };
app.onteardown = async () => { await save(); return {}; };
const connected = app.connect().then(() => applyAppearance(app.getHostContext()));
// The native session owns every operation; no second store or execution path.
export const surfaceBridge = {
  async openLink(url) {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("仅支持打开公开网页链接。");
    await connected;
    const result = await app.openLink({ url });
    if (result?.isError) throw new Error("链接未能打开，请重试。");
  },
  async invoke(method, args = {}) {
    await connected;
    const result = await app.callServerTool({ name: "turnsu_surface", arguments: { method, args } });
    if (result.isError) throw new Error(result.content?.find(c => c.type === "text")?.text || "交互未完成。");
    if (!result.structuredContent || !Object.hasOwn(result.structuredContent, "value"))
      throw new Error("宿主未返回交互结果。已保存内容仍保留，请在对话中核对。");
    return result.structuredContent.value;
  },
  listen(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  flush(callback) { save = callback; return () => { save = async () => {}; }; },
};
