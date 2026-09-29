import { LocalAgentHost } from './host.mjs';

process.umask(0o077);
const directory = process.argv[2];
if (!directory || !process.parentPort) throw new Error('private_desktop_transport_required');
const output = message => process.parentPort.postMessage(message);
const host = new LocalAgentHost({ directory, notify: event => output({ event }) });
let closing = false;
async function close() { if (closing) return; closing = true; await host.close(); process.exit(0); }
process.parentPort.on('message', async ({ data: request }) => {
  try {
    if (request.method === 'shutdown') return close();
    if (JSON.stringify(request).length > 150_000) throw new Error('请求内容过长。');
    const result = request.method === 'desktop.connections.configure'
      ? await host.configureConnections(request.args.connections)
      : await host.command(request.method, request.args);
    output({ id: request.id, result });
  } catch (error) { output({ id: request?.id ?? null, error: error.message }); }
});
process.parentPort.on('close', close);
process.on('SIGTERM', close); process.on('SIGINT', close);
