import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { Manus } from '../host-dist/manus.mjs';
import { normalizeAgentConnection } from '../host-dist/agent-connections.mjs';

const invalid = message => { throw new Error(message); };
const tokenValid = value => typeof value === 'string' && value.length >= 8 && value.length <= 8192 && !/[\s\x00-\x1f]/.test(value);
export function manusRedirect(value) {
  let url; try { url = new URL(value); } catch { invalid('请填写 Team 应用中登记的本机回调地址。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.pathname !== '/manus/callback' || url.search || url.hash || url.username || url.password) invalid('回调必须是 http://127.0.0.1:端口/manus/callback，端口至少为 1024，并与 Team 应用登记值完全一致。');
  return url;
}
async function jsonResponse(response) {
  let text='';const decoder=new TextDecoder();
  for await(const chunk of response.body) {text+=decoder.decode(chunk,{stream:true});if(Buffer.byteLength(text)>100_000)invalid('Manus 授权响应超出限制。');}
  try{return JSON.parse(text+decoder.decode());}catch{invalid('Manus 授权响应无法确认，请重新授权。');}
}
function credentials(result, clock) {
  if(!tokenValid(result.access_token)||!tokenValid(result.refresh_token)||result.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(result.expires_in)||result.expires_in<60||result.expires_in>31_536_000)invalid('Manus 未返回有效的授权凭据。');
  const scopes=typeof result.scope==='string'?result.scope.split(/\s+/).filter(Boolean):[];
  if(scopes.length!==1||scopes[0]!=='create_task')invalid('请将标准 Team 应用权限设置为仅 create_task 后重新授权；未保存超出范围的凭据。');
  return {accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:clock()+result.expires_in*1000,scopes,refreshPending:false};
}
// Main-process only. Token pairs are encrypted by ConnectionVault; the renderer sees status.
export class ManusAuth {
  constructor({vault,save,openExternal,fetch:fetcher=fetch,clock=()=>Date.now(),withLock=work=>work()}) {
    this.vault=vault;this.save=save;this.openExternal=openExternal;this.fetch=fetcher;this.clock=clock;this.withLock=withLock;this.refreshing=new Map();this.state={status:'idle'};
  }
  status(){return this.state;}
  async post(path,body){const response=await this.fetch(`https://api.manus.ai/oauth/${path}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30_000)});if(path==='revoke'&&response.ok)return{};const result=await jsonResponse(response);if(!response.ok||result.error)invalid(`Manus 授权未完成（${String(result.error||response.status).slice(0,60)}），请重新授权。`);return result;}
  async begin(input){
    if(this.pending)invalid('已有 Manus 授权等待完成，请先取消或完成。');
    if(this.vault.error)invalid(this.vault.error);
    if(!await this.vault.available())invalid('请先解锁系统凭据库。');
    if(typeof input.clientId!=='string'||!/^[\w-]{1,200}$/.test(input.clientId)||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)invalid('请填写连接名称与标准 Team 应用 Client ID。');
    const previous=input.id?this.vault.profiles.find(p=>p.id===input.id):null;
    if(input.id&&(!previous||previous.mode!=='oauth_pkce'||previous.clientId!==input.clientId))invalid('请保留原 Team 应用，其他应用需要新建连接。');
    if(!previous&&this.vault.profiles.length>=12)invalid('最多保存 12 个连接。');
    const redirect=manusRedirect(input.redirectUri), verifier=randomBytes(48).toString('base64url'), state=randomBytes(32).toString('base64url');
    const pending={...input,id:previous?.id||randomUUID(),previous,state,verifier,redirectUri:redirect.href,expiresAt:this.clock()+600_000};
    const server=createServer((req,res)=>this.callback(pending,req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('Authorization failed. Return to Turnsu.');}));
    server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxConnections=8;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(redirect.port),'127.0.0.1',resolve);});
    pending.server=server;pending.timer=setTimeout(()=>this.cancel('授权已超时，请重新开始。'),600_000);pending.timer.unref();this.pending=pending;this.state={status:'waiting',name:input.name};
    const url=new URL('https://manus.im/openapi/oauth');for(const [key,value]of Object.entries({response_type:'code',client_id:input.clientId,redirect_uri:redirect.href,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value);
    try{await this.openExternal(url.href);}catch{await this.cancel('浏览器未打开，请重试授权。');invalid(this.state.error);}
    return this.status();
  }
  async callback(pending,req,res){
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method!=='GET'||url.pathname!=='/manus/callback'||req.headers.host!==new URL(pending.redirectUri).host){res.writeHead(404).end();return;}
    const state=Buffer.from(url.searchParams.get('state')||''),expected=Buffer.from(pending.state);
    if(this.pending!==pending||pending.consumed||pending.expiresAt<=this.clock()||state.length!==expected.length||!timingSafeEqual(state,expected)){res.writeHead(400).end('Invalid or expired authorization.');return;}
    pending.consumed=true;this.state={status:'exchanging',name:pending.name};
    let issued, saved=false;
    try{
      if(url.searchParams.has('error'))invalid('你取消了 Manus 授权；原连接保持不变。');
      const code=url.searchParams.get('code');if(!code||code.length>4096)invalid('Manus 没有返回有效授权码。');
      issued=await this.post('token',{grant_type:'authorization_code',code,redirect_uri:pending.redirectUri,client_id:pending.clientId,code_verifier:pending.verifier});
      const tokens=credentials(issued,this.clock);
      const profile=normalizeAgentConnection({id:pending.id,name:pending.name,provider:'manus',mode:'oauth_pkce',clientId:pending.clientId,redirectUri:pending.redirectUri,revision:randomUUID(),oauth:tokens});
      const checked=await new Manus(profile,{fetch:this.fetch}).check();
      if(this.pending!==pending)invalid('授权已取消，未保存连接。');
      if(pending.previous?.accountId&&pending.previous.accountId!==checked.identity)invalid('授权属于另一个账号，请新建连接。');
      await this.save({...profile,accountId:checked.identity});saved=true;this.state={status:'connected',id:profile.id,name:profile.name};
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"}).end('Manus 已连接。请关闭此页面，返回 Turnsu 工作台试运行。');
    }catch(error){
      let cleanup='';
      if(!saved&&tokenValid(issued?.refresh_token))try{await this.post('revoke',{token:issued.refresh_token,token_type_hint:'refresh_token',client_id:pending.clientId});}catch{cleanup=' 请在 Manus 的授权应用中撤销这次未保存的授权。';}
      this.state={status:'failed',error:error.message+cleanup};res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}).end('授权未完成。请返回 Turnsu 查看原因。');
    }
    finally{clearTimeout(pending.timer);pending.server.close();pending.server.closeIdleConnections();if(this.pending===pending)this.pending=null;}
  }
  async cancel(error='已取消授权。'){const pending=this.pending;this.pending=null;if(pending){clearTimeout(pending.timer);pending.server.close();pending.server.closeAllConnections();}this.state={status:'cancelled',error};return this.status();}
  async authorize({id,revision}){
    if(this.refreshing.has(id))return this.refreshing.get(id);
    const profile=this.vault.profiles.find(p=>p.id===id);
    if(!profile||profile.revoked||profile.mode!=='oauth_pkce'||profile.revision!==revision)invalid('Manus 授权已变化，请重新连接账号。');
    if(profile.oauth?.refreshPending)invalid('上次凭据刷新结果不确定，请重新授权；不会重放刷新请求。');
    if(profile.oauth?.expiresAt>this.clock()+60_000)return {Authorization:`Bearer ${profile.oauth.accessToken}`};
    const work=this.withLock(async()=>{
      const current=this.vault.profiles.find(p=>p.id===id);if(current!==profile||profile.revoked)invalid('Manus 连接已变化，请重试。');
      // Durably fence the single-use refresh before network I/O. On a lost response, reauthorize.
      const pending={...profile,oauth:{...profile.oauth,refreshPending:true}};
      await this.vault.write(this.vault.profiles.map(p=>p.id===id?pending:p));
      const tokens=credentials(await this.post('token',{grant_type:'refresh_token',refresh_token:profile.oauth.refreshToken,client_id:profile.clientId}),this.clock);
      const checked=await new Manus({...profile,oauth:tokens},{fetch:this.fetch}).check();if(checked.identity!==profile.accountId)invalid('刷新后的 Manus 账号身份不匹配，请重新授权。');
      await this.vault.write(this.vault.profiles.map(p=>p.id===id?{...profile,oauth:tokens}:p));
      return {Authorization:`Bearer ${tokens.accessToken}`};
    }).finally(()=>this.refreshing.delete(id));this.refreshing.set(id,work);return work;
  }
  async revoke(profile){if(profile.mode!=='oauth_pkce')return;await this.post('revoke',{token:profile.oauth?.refreshToken,token_type_hint:'refresh_token',client_id:profile.clientId});}
  async close(){await this.cancel();await Promise.allSettled(this.refreshing.values());}
}
