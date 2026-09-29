import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManusAuth } from '../electron/manus-auth.mjs';
import { ConnectionVault } from '../electron/connection-vault.mjs';
import { normalizeAgentConnection, publicAgentConnection, serializeAgentSecret, deserializeAgentSecret } from '../host-dist/agent-connections.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'turnsu-manus-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
  // Fake OS encryptor makes persistence behavior inspectable, not an OS vault acceptance claim.
  const encryption={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async value=>Buffer.from(value).reverse(),decryptStringAsync:async value=>({result:Buffer.from(value).reverse().toString()})};
  const vault=new ConnectionVault(root,encryption,{platform:'darwin',filename:'agents.json',normalize:normalizeAgentConnection,present:publicAgentConnection,serializeSecret:serializeAgentSecret,deserializeSecret:deserializeAgentSecret});
  let browser, now=Date.now(), uncertain=false;const requests=[];
  const auth=new ManusAuth({vault,clock:()=>now,openExternal:async url=>{browser=new URL(url);},save:async p=>vault.write([...vault.profiles.filter(c=>c.id!==p.id),p]),fetch:async(url,options)=>{
    requests.push({url:String(url),options});
    if(String(url).endsWith('user.me')){assert.match(options.headers.Authorization,/^Bearer access_/);assert.equal(options.headers['x-manus-api-key'],undefined);return Response.json({ok:true,user_id:'team-customer'});}
    if(String(url).endsWith('revoke'))return new Response(null,{status:200});
    const body=JSON.parse(options.body);assert.equal(body.client_secret,undefined);
    if(uncertain)throw Error('response lost');
    return Response.json({access_token:'access_'+requests.length,refresh_token:'refresh_'+requests.length,token_type:'Bearer',expires_in:3600,scope:'create_task'});
  }});t.after(()=>auth.close());
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const input={name:'客户 Team',clientId:'team_app',redirectUri:`http://127.0.0.1:${port}/manus/callback`};
  return {vault,auth,requests,input,get browser(){return browser;},advance:()=>{now+=3600_000;},loseResponse:()=>{uncertain=true;}};
}
test('Manus Team PKCE verifies state, encrypts token pairs, refreshes once and exposes metadata only',async t=>{
  const f=await fixture(t);await f.auth.begin(f.input);
  assert.equal(f.browser.origin,'https://manus.im');assert.equal(f.browser.searchParams.get('code_challenge_method'),'S256');assert.equal(f.browser.searchParams.has('client_secret'),false);
  const callback=new URL(f.input.redirectUri);callback.searchParams.set('code','one_time_code');callback.searchParams.set('state','wrong');assert.equal((await fetch(callback)).status,400);assert.equal(f.requests.length,0);
  callback.searchParams.set('state',f.browser.searchParams.get('state'));assert.equal((await fetch(callback)).status,200);
  const profile=f.vault.profiles[0];assert.equal(profile.accountId,'team-customer');assert.equal(profile.mode,'oauth_pkce');
  const metadata=JSON.stringify(f.vault.list());assert.equal(metadata.includes('access_'),false);assert.equal(metadata.includes('refresh_'),false);
  assert.equal((await readFile(f.vault.path,'utf8')).includes('refresh_'),false);
  const original=profile.oauth.accessToken;f.advance();const [one,two]=await Promise.all([f.auth.authorize(profile),f.auth.authorize(profile)]);assert.deepEqual(one,two);assert.notEqual(one.Authorization,`Bearer ${original}`);
  assert.equal(f.requests.filter(r=>r.url.endsWith('token')).length,2);
  await f.vault.read();assert.equal(f.vault.profiles[0].oauth.refreshPending,false);assert.equal(f.vault.profiles[0].accountId,profile.accountId);
});
test('a lost single-use refresh response requires reauthorization and does not replay',async t=>{
  const f=await fixture(t);await f.auth.begin(f.input);const url=new URL(f.input.redirectUri);url.searchParams.set('state',f.browser.searchParams.get('state'));url.searchParams.set('code','code');await fetch(url);
  const profile=f.vault.profiles[0];f.advance();f.loseResponse();await assert.rejects(f.auth.authorize(profile),/response lost/);
  await f.vault.read();await assert.rejects(f.auth.authorize(profile),/重新授权/);assert.equal(f.requests.filter(r=>r.url.endsWith('token')).length,2);
});
test('authorization cancellation keeps the original account and prevents late callbacks',async t=>{
  const f=await fixture(t);await f.auth.begin(f.input);await f.auth.cancel();assert.equal(f.auth.status().status,'cancelled');assert.equal(f.requests.length,0);assert.deepEqual(f.vault.profiles,[]);
  await f.auth.begin(f.input);const url=new URL(f.input.redirectUri);url.searchParams.set('state',f.browser.searchParams.get('state'));url.searchParams.set('error','access_denied');assert.equal((await fetch(url)).status,400);assert.deepEqual(f.vault.profiles,[]);
});

test('failed account persistence revokes newly issued Team credentials',async t=>{
  const f=await fixture(t);f.auth.save=async()=>{throw Error('vault locked');};await f.auth.begin(f.input);
  const url=new URL(f.input.redirectUri);url.searchParams.set('state',f.browser.searchParams.get('state'));url.searchParams.set('code','code');
  assert.equal((await fetch(url)).status,400);assert.deepEqual(f.vault.profiles,[]);assert.match(f.auth.status().error,/vault locked/);
  assert.equal(f.requests.filter(r=>r.url.endsWith('revoke')).length,1);
});
