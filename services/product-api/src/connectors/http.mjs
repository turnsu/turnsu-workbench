import { readSecretFile } from '../auth/invitation-identity-composition.mjs';
import { ManagedAgentConnectors } from './service.mjs';
import { ConnectorError, requireValue } from './store.mjs';

const prefix='/api/workbench/v1/agent-connectors';
const send=(res,status,data)=>{ const body=JSON.stringify(data); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Length':Buffer.byteLength(body),'X-Content-Type-Options':'nosniff'});res.end(body); };
async function body(req) {
  requireValue(req.headers['content-type']?.split(';')[0]==='application/json','需要 JSON 请求。',415);
  requireValue(Number(req.headers['content-length']||0)<=48_000_000,'选定材料超过大小限制。',413);
  const parts=[];let size=0; req.setTimeout(30_000,()=>req.destroy());
  for await(const part of req) { requireValue((size+=part.length)<=48_000_000,'请求过大。',413);parts.push(part); }
  let value;try{value=JSON.parse(Buffer.concat(parts).toString());}catch{throw new ConnectorError('JSON 请求无效。');}
  requireValue(value && typeof value==='object' && !Array.isArray(value),'请求无效。');return value;
}
export function createManagedConnectorHttp({ createPersistence,authService,env,origin,fetch }) {
  const ready = (async () => {
    if (!createPersistence || (!env.TURNSU_CONNECTOR_SECRET_KEY && !env.TURNSU_CONNECTOR_SECRET_KEY_FILE)) return null;
    const configuration={...env};
    for(const name of ['TURNSU_CONNECTOR_SECRET_KEY','TURNSU_WORKBUDDY_CLIENT_SECRET']) {
      if(env[name+'_FILE']) { const secret=(await readSecretFile(env[name+'_FILE'])).trim(); requireValue(secret.length>0 && secret.length<=16_384,'连接器密钥文件无效。',503); configuration[name]=secret; }
      else if(env.WORKBENCH_LOCAL_PRODUCTION==='1' && env[name]) throw new ConnectorError('生产连接器密钥必须从 Secret Store 挂载文件读取。',503);
    }
    return new ManagedAgentConnectors({persistence:createPersistence(configuration.TURNSU_CONNECTOR_SECRET_KEY),env:configuration,origin,fetch});
  })();
  ready.catch(()=>{});
  let receiving=0;
  const handler=async(req,res)=>{
    const url=new URL(req.url,origin || 'http://localhost');if(!url.pathname.startsWith(prefix+'/'))return false;
    let counted=false;
    try{
      const service=await ready;
      requireValue(service,'Turnsu 托管接入尚未启用；请由服务管理员配置接入应用。',503);
      if(url.pathname===prefix+'/callback/workbuddy') {
        requireValue(req.method==='GET','不支持此请求方法。',405);
        const result=await service.callback({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error')});
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});res.end(`<meta charset="utf-8"><title>Turnsu Agent 授权</title><h1>${result.cancelled?'授权已取消':'授权完成'}</h1><p>请回到 Turnsu 工作台刷新连接状态。</p>`);return true;
      }
      requireValue(req.method==='POST','不支持此请求方法。',405);
      requireValue(!req.headers.origin || req.headers.origin===new URL(origin).origin,'请求来源不可用。',403);
      requireValue(typeof req.headers.authorization==='string' && req.headers.authorization.startsWith('Bearer '),'需要专用连接凭据。',401);
      requireValue(receiving<2,'接入服务正在同步材料，请稍后重试。',429);receiving++;counted=true;
      const token=req.headers.authorization.slice(7), operation=url.pathname.slice(prefix.length+1);
      let identity;
      if(!operation.startsWith('muse/')) { identity=await authService.authenticateNativeAccessToken({accessToken:token}); requireValue(identity?.clientKind==='desktop' && identity.devicePublicKey,'需要授权的桌面设备连接。',403); }
      const input=await body(req);let result;
      if(operation.startsWith('muse/')) result=await service.muse(token,operation.slice(5),input);
      else switch(operation) {
        case 'connections':result=await service.connections(identity);break;
        case 'authorize':result=await service.authorize(identity,input);break;
        case 'authorization':result=await service.db.authorization(identity,input.authorizationId);break;
        case 'cancel':await service.db.cancelAuthorization(identity,input.authorizationId);result={cancelled:true};break;
        case 'check':result=await service.check(identity,input);break;
        case 'revoke':result=await service.revoke(identity,input);break;
        case 'send':result=await service.send(identity,input);break;
        case 'poll':result=await service.poll(identity,input);break;
        case 'download':result=await service.download(identity,input);break;
        case 'action':result=await service.action(identity,input);break;
        case 'muse-create':result=await service.createMuse(identity,input);break;
        case 'local-result':result=await service.localResult(identity,input);break;
        default:throw new ConnectorError('未知连接器操作。',404);
      }
      send(res,200,{data:result});
    }catch(error){if(!res.headersSent)send(res,error instanceof ConnectorError?error.status:503,{error:error instanceof ConnectorError?error.message:'连接服务暂不可用。请核对原生任务后重试，避免重复执行。'});else res.destroy();}
    finally{if(counted)receiving--;}
    return true;
  };
  handler.close=async()=>{const service=await ready.catch(()=>null);await service?.close();};return handler;
}
