import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requireValue } from '../connectors/store.mjs';

// Use the Product store's transaction owner; no independent database or credential pool.
export class PostgresAgentConnectorStore {
  #store;
  #sql;
  #key;
  constructor(store, encodedKey) {
    this.#store = store; this.#key = Buffer.from(encodedKey || '', 'base64');
    requireValue(this.#key.length === 32, '托管连接器需要配置 32 字节的服务端凭据加密密钥。', 503);
    this.#sql = store.bindAdapter(({ execute }) => ({ query: (uow, text, values) => execute(uow, { text, values }) }));
  }
  #tx(work) { return this.#store.withTransaction(uow => work((text, values = []) => this.#sql.query(uow, text, values))); }
  scope(identity) { requireValue(identity?.workspaceId && identity?.userId, '需要已认证的客户身份。', 401); return [identity.workspaceId, identity.userId]; }
  seal(value, aad) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv); cipher.setAAD(Buffer.from(aad)); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); }
  open(value, aad) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0,12)); cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(bytes.subarray(12,28)); return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()); }
  async connection(identity, id, lock = false) {
    return this.#tx(async q => {
      const row = (await q(`SELECT * FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND id=$3 ${lock ? 'FOR UPDATE' : ''}`, [...this.scope(identity), id])).rows[0];
      requireValue(row && !row.revoked_at, '此 Agent 连接不存在或已撤销。', 404); return row;
    });
  }
  async task(identity, id) {
    return this.#tx(async q => { const row = (await q('SELECT * FROM agent_connector_tasks WHERE workspace_id=$1 AND user_id=$2 AND id=$3', [...this.scope(identity), id])).rows[0]; requireValue(row, '此交接不属于当前客户。',404); return row; });
  }
  async event(task, key, data) {
    requireValue(typeof key === 'string' && key.length <= 200 && Buffer.byteLength(JSON.stringify(data)) <= 512_000, '交接事件超过限制。');
    await this.#tx(async q => {
      // Lock the account as well as the task so revocation fences already-received events.
      const row = (await q('SELECT t.state FROM agent_connector_tasks t JOIN agent_connector_accounts a ON a.id=t.connection_id WHERE t.id=$1 AND a.revoked_at IS NULL AND t.expires_at>now() FOR UPDATE OF a,t', [task.id])).rows[0];
      if (!row || row.state === 'revoked') return;
      await q('INSERT INTO agent_connector_events(task_id,event_key,payload) VALUES($1,$2,$3) ON CONFLICT(task_id,event_key) DO NOTHING', [task.id, key, this.seal(data, task.id)]);
    });
  }

  async accounts(identity) {
    return (await this.#tx(q => q('SELECT * FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 12', this.scope(identity)))).rows;
  }
  beginAuthorization(identity, stateHash, scopes) {
    return this.#tx(q => q("INSERT INTO agent_connector_authorizations(state_hash,workspace_id,user_id,provider,requested_scopes,expires_at) VALUES($1,$2,$3,'workbuddy',$4,now()+interval '10 minutes')", [stateHash, ...this.scope(identity), JSON.stringify(scopes)]));
  }
  async consumeAuthorization(stateHash, cancelled) {
    return (await this.#tx(q => q("UPDATE agent_connector_authorizations SET consumed_at=now(),status=$2 WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at>now() RETURNING *", [stateHash, cancelled ? 'cancelled' : 'exchanging']))).rows[0];
  }
  async authorization(identity, stateHash) {
    return (await this.#tx(q => q('SELECT status,connection_id FROM agent_connector_authorizations WHERE workspace_id=$1 AND user_id=$2 AND state_hash=$3', [...this.scope(identity), stateHash]))).rows[0] || {status:'unavailable'};
  }
  cancelAuthorization(identity, stateHash) {
    return this.#tx(q => q("UPDATE agent_connector_authorizations SET consumed_at=now(),status='cancelled' WHERE workspace_id=$1 AND user_id=$2 AND state_hash=$3 AND consumed_at IS NULL", [...this.scope(identity), stateHash]));
  }
  completeAuthorization(row, id, token, scopes, expires) {
    return this.#tx(async q => {
      const count = (await q('SELECT count(*)::int AS n FROM agent_connector_accounts WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL', [row.workspace_id,row.user_id])).rows[0].n;
      requireValue(count<12,'最多保存 12 个托管连接。');
      await q("INSERT INTO agent_connector_accounts(id,workspace_id,user_id,provider,name,credentials,scopes,native_account,expires_at) VALUES($1,$2,$3,'workbuddy','WorkBuddy',$4,$5,$6,$7)", [id,row.workspace_id,row.user_id,this.seal(token,`${row.workspace_id}:${row.user_id}:${id}`),JSON.stringify(scopes),token.open_id,expires]);
      await q("UPDATE agent_connector_authorizations SET status='connected',connection_id=$2 WHERE state_hash=$1",[row.state_hash,id]);
    });
  }
  failAuthorization(stateHash) {
    return this.#tx(q => q("UPDATE agent_connector_authorizations SET status='failed' WHERE state_hash=$1", [stateHash]));
  }
  async claimRefresh(identity,id) {
    return (await this.#tx(q => q('UPDATE agent_connector_accounts SET refresh_pending=true WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND refresh_pending=false AND revoked_at IS NULL RETURNING id',[...this.scope(identity),id]))).rows.length > 0;
  }
  async saveRefreshedCredentials(identity,id,token,scopes) {
    return (await this.#tx(q => q('UPDATE agent_connector_accounts SET credentials=$4,expires_at=$5,refresh_pending=false,scopes=$6 WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING *',[...this.scope(identity),id,this.seal(token,`${this.scope(identity).join(':')}:${id}`),new Date(Date.now()+token.expires_in*1000),JSON.stringify(scopes)]))).rows[0];
  }
  revoke(identity,id) {
    return this.#tx(async q => {
      await q('UPDATE agent_connector_accounts SET revoked_at=now(),credentials=NULL,connector_key_hash=NULL WHERE workspace_id=$1 AND user_id=$2 AND id=$3',[...this.scope(identity),id]);
      return (await q("UPDATE agent_connector_tasks SET state='revoked',waiting=NULL WHERE workspace_id=$1 AND user_id=$2 AND connection_id=$3 RETURNING id",[...this.scope(identity),id])).rows;
    });
  }
  claimMutation(identity,requestId,fingerprint) {
    const scope=this.scope(identity);
    return this.#tx(async q => {
      await q("INSERT INTO agent_connector_mutations(workspace_id,user_id,request_id,request_hash,status) VALUES($1,$2,$3,$4,'claimed') ON CONFLICT DO NOTHING",[...scope,requestId,fingerprint]);
      const row=(await q('SELECT * FROM agent_connector_mutations WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3 FOR UPDATE',[...scope,requestId])).rows[0];
      requireValue(row.request_hash===fingerprint,'请求标识对应的内容已变化。',409);
      if(row.status!=='claimed') return row;
      await q("UPDATE agent_connector_mutations SET status='sending' WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...scope,requestId]); return null;
    });
  }
  completeMutation(identity,requestId,result) {
    const scope=this.scope(identity);
    return this.#tx(q => q("UPDATE agent_connector_mutations SET status='completed',receipt=$4 WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...scope,requestId,this.seal(result,`${scope.join(':')}:${requestId}`)]));
  }
  uncertainMutation(identity,requestId) {
    return this.#tx(q => q("UPDATE agent_connector_mutations SET status='uncertain' WHERE workspace_id=$1 AND user_id=$2 AND request_id=$3",[...this.scope(identity),requestId]));
  }
  async claimFollowup(taskId,payload) {
    return (await this.#tx(q => q("UPDATE agent_connector_tasks SET state='sending',payload=$2,updated_at=now() WHERE id=$1 AND state IN ('completed','waiting','stopped') RETURNING id",[taskId,this.seal(payload,taskId)]))).rows.length>0;
  }
  createTask(identity,task,payload) {
    return this.#tx(async q => {
      const locked=(await q('SELECT revoked_at FROM agent_connector_accounts WHERE id=$1 FOR UPDATE',[task.connection_id])).rows[0]; requireValue(locked && !locked.revoked_at,'连接已撤销。',403);
      if(task.agent==='workbuddy-local') requireValue(!(await q("SELECT 1 FROM agent_connector_tasks WHERE connection_id=$1 AND state IN ('running','waiting','sending') LIMIT 1",[task.connection_id])).rows.length,'此本地助理已有任务。',409);
      const n=(await q("SELECT count(*)::int AS n FROM agent_connector_tasks WHERE workspace_id=$1 AND user_id=$2 AND state NOT IN ('completed','revoked','failed','stopped')",this.scope(identity))).rows[0].n;
      requireValue(n<20,'请先处理已有交接，最多同时保留 20 项未结束任务。',409);
      await q("INSERT INTO agent_connector_tasks(id,workspace_id,user_id,connection_id,agent,state,payload) VALUES($1,$2,$3,$4,$5,'sending',$6)",[task.id,...this.scope(identity),task.connection_id,task.agent,this.seal(payload,task.id)]);
    });
  }
  waitForPickup(taskId,payload) {
    return this.#tx(q => q("UPDATE agent_connector_tasks SET state='waiting_external',payload=$2,updated_at=now() WHERE id=$1 AND state<>'revoked'",[taskId,this.seal(payload,taskId)]));
  }
  async localAssistantBusy(accountId,taskId) {
    return (await this.#tx(q => q("SELECT id FROM agent_connector_tasks WHERE connection_id=$1 AND id<>$2 AND state IN ('running','waiting','sending') LIMIT 1",[accountId,taskId]))).rows.length>0;
  }
  setState(id,state,waiting,nativeId=null) {
    return this.#tx(q => q("UPDATE agent_connector_tasks SET state=$2,waiting=$3,native_id=COALESCE($4,native_id),updated_at=now() WHERE id=$1 AND state<>'revoked' AND expires_at>now() AND EXISTS(SELECT 1 FROM agent_connector_accounts a WHERE a.id=connection_id AND a.revoked_at IS NULL)",[id,state,waiting ? this.seal(waiting,id):null,nativeId]));
  }
  async claimCloudDispatch(id) {
    return (await this.#tx(q => q("UPDATE agent_connector_tasks SET state='dispatching',updated_at=now() WHERE id=$1 AND state='preparing' AND EXISTS(SELECT 1 FROM agent_connector_accounts a WHERE a.id=connection_id AND a.revoked_at IS NULL) RETURNING id",[id]))).rows.length>0;
  }
  dispatched(id) {
    return this.#tx(q => q("UPDATE agent_connector_tasks SET state='running',updated_at=now() WHERE id=$1 AND state='dispatching'",[id]));
  }
  async events(taskId,sequence) {
    return (await this.#tx(q => q('SELECT sequence,event_key,payload FROM agent_connector_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 50',[taskId,sequence]))).rows;
  }
  async pendingLocalRequests(taskId) {
    return (await this.#tx(q => q("SELECT id,input,status,result FROM agent_connector_local_requests WHERE task_id=$1 AND status='pending' ORDER BY created_at LIMIT 5",[taskId]))).rows;
  }
  createMuseAccount(identity,id,tokenHash) {
    return this.#tx(q => q("INSERT INTO agent_connector_accounts(id,workspace_id,user_id,provider,name,connector_key_hash,expires_at) VALUES($1,$2,$3,'muse','Muse 任务收件箱',$4,now()+interval '30 days')",[id,...this.scope(identity),tokenHash]));
  }
  async museAccount(tokenHash) {
    return (await this.#tx(q => q("SELECT * FROM agent_connector_accounts WHERE provider='muse' AND connector_key_hash=$1 AND revoked_at IS NULL AND expires_at>now()",[tokenHash]))).rows[0];
  }
  async museInbox(accountId) {
    return (await this.#tx(q => q("SELECT id,state,created_at FROM agent_connector_tasks WHERE connection_id=$1 AND state IN ('waiting_external','running','waiting') AND expires_at>now() ORDER BY created_at LIMIT 20",[accountId]))).rows;
  }
  requestLocal(taskId,requestId,value) {
    return this.#tx(async q => {
      const existing=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1',[requestId])).rows[0];
      if(existing) {requireValue(existing.task_id===taskId && JSON.stringify(this.open(existing.input,taskId))===JSON.stringify(value),'操作请求标识已被使用。',409);return;}
      const n=(await q("SELECT count(*)::int AS n FROM agent_connector_local_requests WHERE task_id=$1 AND status='pending'",[taskId])).rows[0].n; requireValue(n<5,'已有本机请求等待批准。',429);
      await q('INSERT INTO agent_connector_local_requests(id,task_id,input) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[requestId,taskId,this.seal(value,taskId)]);
      const old=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1',[requestId])).rows[0]; requireValue(old.task_id===taskId && JSON.stringify(this.open(old.input,taskId))===JSON.stringify(value),'操作请求标识已被使用。',409);
    });
  }
  async localResult(taskId,requestId) {
    const row=(await this.#tx(q => q('SELECT status,result FROM agent_connector_local_requests WHERE id=$1 AND task_id=$2',[requestId,taskId]))).rows[0]; requireValue(row,'本机请求不存在。',404);
    return {status:row.status,result:row.result ? this.open(row.result,taskId):null};
  }
  saveLocalResult(taskId,requestId,status,result) {
    return this.#tx(async q => {
      const row=(await q('SELECT * FROM agent_connector_local_requests WHERE id=$1 AND task_id=$2 FOR UPDATE',[requestId,taskId])).rows[0]; requireValue(row,'本机请求不存在。',404);
      if(row.status!=='pending') {requireValue(row.status===status && JSON.stringify(this.open(row.result,taskId))===JSON.stringify(result),'已有结果不能覆盖。',409);return;}
      await q('UPDATE agent_connector_local_requests SET status=$2,result=$3 WHERE id=$1',[row.id,status,this.seal(result,taskId)]);
    });
  }
}
