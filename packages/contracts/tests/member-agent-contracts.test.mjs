import test from 'node:test';
import assert from 'node:assert/strict';
import { Check, ExecutionRequestSchema, ExecutionResultSchema, MemberAgentExecutionRequestSchema } from '../dist/index.js';
const request={schemaVersion:'workbench-execution-fabric-v1',invocationId:'invocation-1',attemptId:'attempt-1',workspaceId:'workspace-1',actor:{userId:'provider'},lineage:{productCommandId:'command-1'},controller:{kind:'member_agent_request',controllerId:'request-1',fence:1},mode:'bounded_agent',isolation:'remote',goal:'Use declared text.',input:{},resultSchema:{type:'object'},evidenceRequirements:[],metadata:{profile:'pi-declared-text-v1',requestDigest:'sha256:'+'1'.repeat(64),usageAccounting:'local_unmetered'},limits:{timeoutMs:10000,maxSteps:100,maxModelRequests:2,maxChildren:0,maxInputBytes:128000,maxOutputBytes:1000,maxOutputTokens:512,maxImageCount:0,maxCostUsdMicros:null},capabilities:{toolAllowlist:['read_input','write_result'],connectionIds:[],network:false,filesystem:'none',externalActions:false}};
test('unknown native account cost is restricted to the exact member profile; managed execution still requires a numeric cost limit',()=>{
 assert.ok(Check(ExecutionRequestSchema,request));assert.ok(Check(MemberAgentExecutionRequestSchema,request));
 for(const changed of [ {...request,controller:{...request.controller,kind:'agent_turn'}}, {...request,metadata:{...request.metadata,profile:'unrestricted-pi'}}, {...request,limits:{...request.limits,maxCostUsdMicros:1000000000000}}, {...request,capabilities:{...request.capabilities,network:true}}, {...request,limits:{...request.limits,maxModelRequests:9}}]) assert.equal(Check(ExecutionRequestSchema,changed),false);
 assert.ok(Check(ExecutionRequestSchema,{...request,controller:{...request.controller,kind:'agent_turn'},limits:{...request.limits,maxCostUsdMicros:100000}}));
});
test('unmetered result cannot look like zero cost or zero model calls',()=>{
 const result={schemaVersion:'workbench-execution-fabric-v1',invocationId:'invocation-1',attemptId:'attempt-1',status:'completed',isolation:'remote',requestedModelRevisionId:null,actualModelRevisionId:null,artifactRefs:[],summary:'Declared result',evidence:[],usageAccounting:'local_unmetered',usage:{steps:null,modelRequests:null,costUsdMicros:null,inputBytes:10,outputBytes:10,imageCount:0},startedAt:'2026-09-24T00:00:00.000Z',finishedAt:'2026-09-24T00:00:01.000Z'};
 assert.ok(Check(ExecutionResultSchema,result));assert.equal(Check(ExecutionResultSchema,{...result,usage:{...result.usage,costUsdMicros:0}}),false);
 const noLabel=structuredClone(result);delete noLabel.usageAccounting;assert.equal(Check(ExecutionResultSchema,noLabel),false);
});
