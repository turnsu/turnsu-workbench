import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export const secretHash = value => createHash('sha256').update(value).digest('hex');
export class ConnectorError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const requireValue = (condition, message, status) => { if (!condition) throw new ConnectorError(message, status); };

// Use the Product store's transaction owner; no independent database or credential pool.
export class ConnectorStore {
  constructor(store, encodedKey) {
    this.store = store; this.key = Buffer.from(encodedKey || '', 'base64');
    requireValue(this.key.length === 32, '托管连接器需要配置 32 字节的服务端凭据加密密钥。', 503);
    this.sql = store.bindAdapter(({ execute }) => ({ query: (uow, text, values) => execute(uow, { text, values }) }));
  }
  tx(work) { return this.store.withTransaction(uow => work((text, values = []) => this.sql.query(uow, text, values))); }
  scope(identity) { requireValue(identity?.workspaceId && identity?.userId, '需要已认证的客户身份。', 401); return [identity.workspaceId, identity.userId]; }
  seal(value, aad) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(aad)); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); }
  open(value, aad) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12)); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes.subarray(12,28)); return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()); }
  async connection(identity, id, lock = false) {
    return this.tx(async q => {
      const row = (await q(`SELECT * FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`, [...this.scope(identity), id])).rows[0];
      requireValue(row && !row.revoked_at, '此 Agent 连接不存在或已撤销。', 404); return row;
    });
  }
  async task(identity, id) {
    return this.tx(async q => { const row = (await q('SELECT * FROM agent_connector_tasks WHERE workspace_id=$1 AND user_id=$2 AND id=$3', [...this.scope(identity), id])).rows[0]; requireValue(row, '此交接不属于当前客户。',404); return row; });
  }
  async event(task, key, data) {
    requireValue(typeof key === 'string' && key.length <= 200 && Buffer.byteLength(JSON.stringify(data)) <= 512_000, '交接事件超过限制。');
    await this.tx(async q => {
      // Lock the account as well as the task so revocation fences already-received events.
      const row = (await q('SELECT t.state FROM agent_connector_tasks t JOIN agent_connector_accounts a ON a.id=t.connection_id WHERE t.id=$1 AND a.revoked_at IS NULL AND t.expires_at>now() FOR UPDATE OF a,t', [task.id])).rows[0];
      if (!row || row.state === 'revoked') return;
      await q('INSERT INTO agent_connector_events(task_id,event_key,payload) VALUES($1,$2,$3) ON CONFLICT(task_id,event_key) DO NOTHING', [task.id, key, this.seal(data, task.id)]);
    });
  }
}
