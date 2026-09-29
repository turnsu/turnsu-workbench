import { createHash } from 'node:crypto';
import { DesktopCloud } from './cloud.mjs';
const fail=message=>{throw new Error(message);};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ManagedConnections {
  constructor(host) {
    this.host=host;this.db=host.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS managed_agent_connections(id TEXT PRIMARY KEY,identity TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_local_actions(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,synced INTEGER NOT NULL DEFAULT 0);
      UPDATE managed_local_actions SET status='uncertain',result='{"error":"工作台在本机操作中断开，结果尚未确认，不会自动重试。"}' WHERE status='running';`);
  }
  cloud() { this.host.cloud ||= new DesktopCloud({directory:this.host.directory,notify:this.host.notify});return this.host.cloud; }
  list() { if(!this.activeOwner || this.host.cloud?.session !== this.activeSession)return [];return this.db.prepare('SELECT metadata FROM managed_agent_connections WHERE identity=? LIMIT 12').all(this.activeOwner).map(r=>JSON.parse(r.metadata)); }
  available(agent) { return this.list().some(c=>!c.revoked && !c.needsAuthorization && c.agents.includes(agent)); }
  assertConnection(id,agent) { const row=this.db.prepare('SELECT metadata FROM managed_agent_connections WHERE id=?').get(id);if(!row)fail('请刷新托管 Agent 连接。');const value=JSON.parse(row.metadata);if(value.revoked || value.needsAuthorization || !value.agents.includes(agent))fail('此连接未授权所选 Agent，请重新连接。');return true; }
  async context() {
    const cloud=this.cloud(),identity=await cloud.identity(),viewer=await cloud.viewer();
    if (!viewer.userId || viewer.workspaceId!==identity.workspaceId || JSON.stringify(await cloud.identity())!==JSON.stringify(identity)) fail('托管接入身份已变化，请重新连接。');
    const owner=JSON.stringify({origin:identity.origin,workspaceId:identity.workspaceId,userId:viewer.userId});this.activeOwner=owner;this.activeSession=cloud.session;
    return {cloud,identity,owner};
  }
  async call(operation,input={},connectionId) {
    const {cloud,identity,owner}=await this.context();
    if(connectionId){const saved=this.db.prepare('SELECT identity FROM managed_agent_connections WHERE id=?').get(connectionId);if(!saved||saved.identity!==owner)fail('此任务的 Turnsu 服务或设备身份已变化，请先恢复原连接。');}
    return cloud.connectorCall(identity,operation,input);
  }
  async refresh() {
    const {cloud,identity,owner}=await this.context(),result=await cloud.connectorCall(identity,'connections',{});
    if(!Array.isArray(result.connections))fail('托管 Agent 列表不可用。');
    this.db.exec('BEGIN IMMEDIATE');try{
      for(const previous of this.db.prepare('SELECT id,metadata FROM managed_agent_connections WHERE identity=?').all(owner))if(!result.connections.some(c=>c.id===previous.id))this.db.prepare('UPDATE managed_agent_connections SET metadata=? WHERE id=?').run(JSON.stringify({...JSON.parse(previous.metadata),revoked:true}),previous.id);
      for(const connection of result.connections){const old=this.db.prepare('SELECT identity FROM managed_agent_connections WHERE id=?').get(connection.id);if(old&&old.identity!==owner)fail('接入服务返回了与旧身份冲突的连接。');this.db.prepare('INSERT INTO managed_agent_connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata').run(connection.id,owner,JSON.stringify(connection));}
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}this.host.changed();return result;
  }
  adapter(session) {
    this.assertConnection(session.agent_connection_id,session.agent);
    const call=(operation,input)=>this.call(operation,input,session.agent_connection_id);
    return {
      send:(taskId,prompt,files,inputId)=>call('send',{taskId,connectionId:session.agent_connection_id,agent:session.agent,prompt,files,requestId:inputId,acknowledged:true}),
      download:async(taskId,metadata)=>{const value=await call('download',{taskId,uri:metadata.managed_uri});const bytes=Buffer.from(value.base64,'base64');if(bytes.length!==value.bytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)fail('成果传输校验失败。');return bytes;},
      poll:(taskId,cursor)=>call('poll',{taskId,cursor}),
      stop:taskId=>call('action',{taskId,operation:session.agent==='muse'?'withdraw':'stop',requestId:`stop-${session.id}-${Date.now()}`}),
      approve:async(taskId,_waiting,input)=>{const fresh=await call('poll',{taskId});if(!fresh.waiting||hash(fresh.waiting)!==input?.reviewHash)fail('待批准操作已变化，请重新查看。');return call('action',{taskId,operation:'approve',input:{...input,requestId:fresh.waiting.requestId},requestId:`approve-${session.id}-${hash(input).slice(0,32)}`});},
      review:async taskId=>{const result=await call('poll',{taskId});if(!result.waiting?.operation)fail('请在原生应用查看这次批准。');return {waiting:result.waiting,operation:result.waiting.operation,options:result.waiting.options,reviewHash:hash(result.waiting)};},
    };
  }
  async localAction({sessionId,requestId,decision,acknowledged}) {
    const session=this.host.session(sessionId);if(session.agent!=='muse'||acknowledged!==true||!['allow','deny'].includes(decision))fail('请明确确认这次本机操作及结果回传。');
    const latest=await this.adapter(session).poll(session.native_id,{}),request=latest.localRequests?.find(r=>r.id===requestId);
    const saved=this.db.prepare('SELECT * FROM managed_local_actions WHERE id=?').get(requestId);
    if(saved&&saved.session_id!==sessionId)fail('本机请求不属于此任务。');
    if(!saved){
      if(!request)fail('Muse 已撤销这次本机请求。');
      this.db.prepare("INSERT INTO managed_local_actions VALUES(?,?,?,'running',NULL,0)").run(requestId,sessionId,hash(request.input));
      let status='denied',result={declined:true};
      if(decision==='allow')try{
        const args=request.input.arguments;
        result=request.input.tool==='documents'?await this.host.capabilities.call(session.project_id,sessionId,args,requestId):request.input.tool==='computer'&&this.host.computer?await this.host.computer.call(session.project_id,sessionId,args):fail('请求的本机工具不可用。');
        // Large screenshots/files remain local. Report bounded results; sharing binary outputs is separate.
        if(Buffer.byteLength(JSON.stringify(result))>400_000)result={summary:'本机操作返回内容超过同步上限，请在工作台核对本地成果。',partial:true};status='completed';
      }catch(error){status='uncertain';result={error:error.message};}
      this.db.prepare('UPDATE managed_local_actions SET status=?,result=? WHERE id=?').run(status,JSON.stringify(result),requestId);
    }else if(saved.status==='running')fail('本机请求正在执行。');
    const receipt=this.db.prepare('SELECT * FROM managed_local_actions WHERE id=?').get(requestId);
    if(!receipt.synced) {await this.call('local-result',{taskId:session.native_id,localRequestId:requestId,status:receipt.status,result:JSON.parse(receipt.result)},session.agent_connection_id);this.db.prepare('UPDATE managed_local_actions SET synced=1 WHERE id=?').run(requestId);}
    await this.host.remote.poll(sessionId);return {status:receipt.status,result:JSON.parse(receipt.result)};
  }
}
