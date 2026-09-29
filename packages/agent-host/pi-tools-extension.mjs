import { callBroker } from './tool-client.mjs';
export default async function turnsuTools(pi) {
  const connection = JSON.parse(process.env.TURNSU_TOOL_CONNECTION || 'null');
  if (!connection) throw new Error('Turnsu 工具连接不可用。');
  const tools = await callBroker(connection, { method: 'tools/list' });
  for (const tool of tools) pi.registerTool({ name: tool.name, label: tool.name === 'turnsu_document' ? 'Turnsu 文件工具' : 'Turnsu 电脑操作', description: tool.description, parameters: tool.inputSchema,
    async execute(id, args, signal) { const result = await callBroker(connection, { method: 'tools/call', name: tool.name, arguments: args, callId: id }, signal); return { content: Array.isArray(result.content) ? result.content : [{ type: 'text', text: JSON.stringify(result) }], details: { tool: tool.name } }; } });
}
