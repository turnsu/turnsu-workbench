import { openNativeProductSession } from "./session.mjs";
import { createProductPiExtension } from "./pi-extension.mjs";
import { NATIVE_PRODUCT_TOOLS } from "./product-tools.mjs";

export default function turnsuNativePi(pi) {
  let opening;
  createProductPiExtension({ tools: NATIVE_PRODUCT_TOOLS, async call(...args) {
    opening ??= openNativeProductSession(process.env.TURNSU_SESSION_FILE);
    return (await opening).product.call(...args);
  } })(pi);
  pi.on("session_shutdown", async () => { if (opening) await (await opening).release(); });
}
