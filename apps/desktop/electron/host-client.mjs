// Private request channel. An uncertain result is never retried automatically.
export class HostClient {
  constructor(child, notify = () => {}) {
    this.child = child; this.pending = new Map(); this.sequence = 0; this.closed = false;
    child.on('message', message => {
      if (message.event) { notify(message.event); return; }
      const request = this.pending.get(message.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
    });
    this.exited = new Promise(resolve => child.once('exit', () => {
      this.closed = true;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('本地服务已停止，请重新打开工作台。已保存内容仍在本机。')); }
      this.pending.clear(); notify({ type: 'disconnected' }); resolve();
    }));
  }
  request(method, args = {}, timeout = 100_000) {
    if (this.closed) return Promise.reject(new Error('本地服务已停止，请重新打开工作台。'));
    if (this.pending.size >= 128) return Promise.reject(new Error('本地操作较多，请稍后重试。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地操作尚未确认，请核对状态后再操作，不要重复发送任务。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.postMessage({ id, method, args }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('无法连接本地服务。')); }
    });
  }
  async close() {
    if (this.closed) return;
    this.child.postMessage({ method: 'shutdown' });
    let timer;
    await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => { this.child.kill(); resolve(); }, 8_000); })]);
    clearTimeout(timer);
  }
}
