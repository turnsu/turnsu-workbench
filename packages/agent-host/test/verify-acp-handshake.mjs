// Actual CLI session/new + session/load. No model turn or provider acceptance claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { OhMyPiConnection, KimiConnection } from '../opencode.mjs';
const name=process.argv[2],binary=resolve(process.argv[3]);assert.ok(['omp','kimi'].includes(name));
const root=await mkdtemp(join(tmpdir(),'turnsu-acp-qa-')),cwd=join(root,'project'),native=join(root,'native');await mkdir(cwd);await mkdir(native);
const factory=name==='omp'?OhMyPiConnection:KimiConnection;
const options={cwd,binary,onEvent:()=>{},onExit:()=>{},spawnProcess:(file,args,opts)=>spawn(file,args,{...opts,env:{...opts.env,PI_CODING_AGENT_DIR:native,XDG_CONFIG_HOME:join(native,'config'),XDG_DATA_HOME:join(native,'data'),XDG_CACHE_HOME:join(native,'cache')}})};
let connection;
try { connection=new factory(options); const state=await connection.ready;assert.ok(state.sessionId);await connection.close();connection=new factory({...options,sessionId:state.sessionId});const restored=await connection.ready;assert.equal(restored.sessionId,state.sessionId);console.log(JSON.stringify({native:name,sessionCreated:true,sameSessionRestored:true,modelTurn:false,toolsCalled:false,models:state.models?.length||0})); }
finally {await connection?.close();await rm(root,{recursive:true,force:true});}
