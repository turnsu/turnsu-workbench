import { StringDecoder } from 'node:string_decoder';
import { connect } from 'node:net';
export function callBroker(connection, request, signal) {
  return new Promise((resolve, reject) => {
    const socket = connect(connection.path); let data = '', settled = false; const decoder = new StringDecoder('utf8');
    const done = (error, result) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(result); };
    const abort = () => done(new Error('工具调用已取消。'));
    socket.setTimeout(150_000, () => done(new Error('工具响应超时，请检查成果后恢复。')));
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', done); socket.on('connect', () => socket.write(JSON.stringify({ ...request, token: connection.token }) + '\n'));
    socket.on('data', bytes => {
      data += decoder.write(bytes); if (Buffer.byteLength(data) > 8_000_000) return done(new Error('工具结果超过上限。'));
      const end = data.indexOf('\n'); if (end >= 0) { try { const value = JSON.parse(data.slice(0, end)); done(value.error ? new Error(value.error) : null, value.result); } catch (e) { done(e); } }
    });
    socket.on('end', () => { if (!settled) done(new Error('工具连接提前结束。')); });
    if (signal?.aborted) abort();
  });
}
