import { LocalAgentHost } from './host.mjs';
import { normalizeAgentConnection } from './agent-connections.mjs';
import { Manus } from './manus.mjs';
import { Computer } from './computer.mjs';
import { randomUUID } from 'node:crypto';

process.umask(0o077);
const directory = process.argv[2];
if (!directory || !process.parentPort) throw new Error('private_desktop_transport_required');
const output = message => process.parentPort.postMessage(message);
const host = new LocalAgentHost({ directory, notify: event => output({ event }) });
const desktopRequests = new Map();
host.computer = new Computer(host, (method, args = {}) => new Promise((resolve, reject) => {
  const id = randomUUID(), timer = setTimeout(() => { desktopRequests.delete(id); reject(new Error('电脑运行时响应未确认，请检查当前应用后恢复。')); }, 90_000);
  desktopRequests.set(id, { resolve, reject, timer }); output({ computerRequest: { id, method, args } });
}));
host.remote.manusFactory = profile => new Manus(profile, { authorize: args => new Promise((resolve, reject) => {
  const id = randomUUID(), timer = setTimeout(() => { desktopRequests.delete(id); reject(new Error('Manus 凭据刷新尚未确认，请重新连接。')); }, 70_000);
  desktopRequests.set(id, { resolve, reject, timer }); output({ credentialRequest: { id, args } });
}) });
let closing = false;
async function close() { if (closing) return; closing = true; await host.close(); process.exit(0); }
process.parentPort.on('message', async ({ data: request }) => {
  if (request.computerReply || request.credentialReply) {
    const reply = request.computerReply || request.credentialReply, pending = desktopRequests.get(reply.id); if (!pending) return;
    desktopRequests.delete(reply.id); clearTimeout(pending.timer); reply.error ? pending.reject(new Error(reply.error)) : pending.resolve(reply.result); return;
  }
  try {
    if (request.method === 'shutdown') return close();
    if (JSON.stringify(request).length > 150_000) throw new Error('请求内容过长。');
    if (request.method === 'desktop.scheduler.start') { host.schedules.start(); output({ id: request.id, result: { started: true } }); return; }
    if (request.method === 'desktop.managed.authorization') { output({ id: request.id, result: { url: host.remote.managed.authorization?.url || null } }); return; }
    if (request.method === 'desktop.agents.configure') { output({ id: request.id, result: host.remote.configure(request.args.connections) }); return; }
    if (request.method === 'desktop.agents.verify') { output({ id: request.id, result: await host.remote.verifyProfile(normalizeAgentConnection(request.args.connection)) }); return; }
    const result = request.method === 'desktop.connections.configure'
      ? await host.configureConnections(request.args.connections)
      : await host.command(request.method, request.args);
    output({ id: request.id, result });
  } catch (error) { output({ id: request?.id ?? null, error: error.message }); }
});
process.parentPort.on('close', close);
process.on('SIGTERM', close); process.on('SIGINT', close);
