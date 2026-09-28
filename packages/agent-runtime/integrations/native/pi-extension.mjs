import { nativeToolError } from "./product-tools.mjs";

/** Shares the exact same tool schemas and Product commands as the MCP adapter. */
export function createProductPiExtension(product) {
  return function turnsuProductExtension(pi) {
    for (const tool of product.tools) pi.registerTool({
      name: tool.name, label: tool.name.replaceAll("_", " "), description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, input, signal) {
        try { return { content: [{ type: "text", text: JSON.stringify(await product.call(tool.name, input, { signal })) }], details: {} }; }
        catch (error) { return { ...nativeToolError(error), details: {} }; }
      },
    });
  };
}
