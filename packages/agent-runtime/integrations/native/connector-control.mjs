import { assertProductOrigin } from './product-tools.mjs';
const operations=new Set(['connections','authorize','authorization','cancel','check','revoke','send','poll','action','muse-create','local-result','download']);
// Only the private desktop session receives this control object. Native Agent product tools do not.
export function createConnectorControl({baseUrl,accessToken,fetch:fetcher=fetch,beforeCall=async()=>{}}) {
  const origin=assertProductOrigin(baseUrl);
  return Object.freeze({async call(operation,input={}, {signal}={}) {
    if(!operations.has(operation))throw new Error('不支持此托管接入操作。');await beforeCall();
    const response=await fetcher(`${origin}/api/workbench/v1/agent-connectors/${operation}`,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${accessToken()}`,'Content-Type':'application/json'},body:JSON.stringify(input),signal:signal||AbortSignal.timeout(90_000)});
    let size=0;const parts=[];for await(const part of response.body){if((size+=part.length)>(operation==='download'?28_000_000:2_000_000))throw new Error('连接服务返回超过读取上限。');parts.push(part);}
    let result;try{result=JSON.parse(Buffer.concat(parts).toString());}catch{throw new Error('连接服务未返回有效结果。');}
    if(!response.ok) {const error=new Error(result.error||'连接服务未完成请求。');error.status=response.status;throw error;}return result.data;
  }});
}
