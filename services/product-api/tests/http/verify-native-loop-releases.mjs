import assert from 'node:assert/strict';
import { Check, NativeLoopPackageSchema, WorkspaceAssetReleaseSchema } from '@turnsu/workbench-contracts';
import { canonicalRequestHash } from '../../src/store/serialization.mjs';
import { validatePortableRecipe } from '../../src/loops/postgres-native-loop-releases.mjs';

export async function verifyNativeLoopReleases({request,pool,restart,headers,memberHeaders,foreignHeaders,saveData}) {
  const create = await request('/loops',{method:'POST',headers:{...headers,'Idempotency-Key':'native-release-target'},
    data:{name:'Native feedback recipe',description:'Review feedback using a fixed team Skill',definition:saveData.definition}});
  assert.equal(create.status,201,JSON.stringify(create.body));
  const workflowId=create.body.data.workflow.workflowId;
  let etag=(await request(`/workflows/${workflowId}`,{headers})).headers.get('etag');
  const saved=await request(`/loops/${workflowId}/revisions`,{method:'POST',headers:{...headers,'If-Match':etag,'Idempotency-Key':'native-release-save'},
    data:{...saveData,baseRevisionId:create.body.data.revision.revisionId}});
  assert.equal(saved.status,201,JSON.stringify(saved.body));
  etag=saved.headers.get('etag');
  const revision=saved.body.data.revision;
  const trial=await request(`/workflows/${workflowId}/local-trials`,{method:'POST',headers:{...headers,'If-Match':etag,'Idempotency-Key':'native-release-trial'},
    data:{workflowRevisionId:revision.revisionId,revisionContentHash:revision.contentHash,localTrialId:'native-release-trial',agentKind:'codex',
      inputSummary:'PRIVATE_NATIVE_RELEASE_INPUT',output:'PRIVATE_NATIVE_RELEASE_OUTPUT',reviewNote:'PRIVATE_NATIVE_RELEASE_REVIEW',confirm:true,reportedCompletedAt:new Date().toISOString()}});
  assert.equal(trial.status,201,JSON.stringify(trial.body));
  const data={trialId:trial.body.data.trialId,workflowRevisionId:revision.revisionId,revisionContentHash:revision.contentHash,
    version:'1.0.0',releaseNotes:'A reusable native Agent recipe',confirm:true};
  const publish=(payload=data,key='native-release-publish',credentials=headers,match=etag)=>request(`/loops/${workflowId}/native-publish`,{
    method:'POST',headers:{...credentials,'Idempotency-Key':key,'If-Match':match},data:payload});
  assert.equal((await publish({...data,confirm:false})).status,400);
  assert.equal((await publish({...data,trialId:'unknown-private-trial'})).status,409);
  assert.equal((await publish({...data,revisionContentHash:`sha256:${'0'.repeat(64)}`})).status,412);
  assert.equal((await publish(data,'native-release-publish',memberHeaders)).status,404);
  assert.equal((await publish(data,'native-release-publish',foreignHeaders)).status,404);
  assert.equal((await publish(data,'native-release-publish',headers,'"stale"')).status,412);
  const [first,retry]=await Promise.all([publish(),publish()]);
  assert.equal(first.status,201,JSON.stringify(first.body));
  assert.deepEqual(retry.body.data,first.body.data);
  const {release,nativeLoopVersion}=first.body.data;
  assert.equal(Check(WorkspaceAssetReleaseSchema,release),true);
  assert.equal(release.executionMode,'native_agent'); assert.equal(release.cloudReady,false);
  assert.equal(nativeLoopVersion.versionId,release.versionId);
  const packagePath=`/team-library/${release.releaseId}/native-loop-package`;
  assert.equal((await request(packagePath)).status,401);
  assert.equal((await request(packagePath,{headers:foreignHeaders})).status,404);
  const downloaded=await request(packagePath,{headers:memberHeaders});
  assert.equal(downloaded.status,200,JSON.stringify(downloaded.body));
  const value=downloaded.body.data;
  assert.equal(Check(NativeLoopPackageSchema,value),true);
  assert.equal(value.contentHash,canonicalRequestHash({recipe:value.recipe,skillPins:value.skillPins}));
  assert.deepEqual(value.recipe.graph,revision.graph);
  assert.equal(value.skillPins.length,1);
  const pin=value.skillPins[0];
  assert.deepEqual(release.dependencies,[{kind:'skill',id:pin.skillId,version:pin.version,required:true}]);
  const skill=await request(`/team-library/${pin.releaseId}/native-skill-package`,{headers:memberHeaders});
  assert.equal(skill.status,200,JSON.stringify(skill.body));
  assert.equal(skill.body.data.versionId,pin.skillVersionId); assert.equal(skill.body.data.packageHash,pin.packageHash);
  const catalog=await request('/team-library?assetKind=loop',{headers:memberHeaders});
  assert.equal(catalog.status,200,JSON.stringify(catalog.body));
  assert.deepEqual(catalog.body.data.find(item=>item.releaseId===release.releaseId),release);
  for(const body of [first.body,downloaded.body,catalog.body]) {
    assert.doesNotMatch(JSON.stringify(body),/PRIVATE_NATIVE_RELEASE_INPUT|PRIVATE_NATIVE_RELEASE_OUTPUT|PRIVATE_NATIVE_RELEASE_REVIEW/);
    assert.ok(!JSON.stringify(body).includes(data.trialId),'private trial identifier is not a team publication field');
  }
  assert.equal((await request(`/workflows/${workflowId}`,{headers:memberHeaders})).status,404,'source author workspace stays private');
  const workflow=(await pool.query('SELECT status,lifecycle,visibility,latest_compile_result_id FROM workflows WHERE workflow_id=$1',[workflowId])).rows[0];
  assert.deepEqual(workflow,{status:'draft',lifecycle:'draft',visibility:'private',latest_compile_result_id:null});
  assert.equal((await pool.query('SELECT count(*)::int n FROM loop_versions WHERE workflow_id=$1',[workflowId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM workflow_runs WHERE workflow_id=$1',[workflowId])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM native_loop_versions WHERE workflow_id=$1',[workflowId])).rows[0].n,1);
  const releaseRow=(await pool.query('SELECT loop_version_id,native_loop_version_id,version_id FROM workspace_asset_releases WHERE release_id=$1',[release.releaseId])).rows[0];
  assert.equal(releaseRow.loop_version_id,null); assert.equal(releaseRow.native_loop_version_id,value.versionId); assert.equal(releaseRow.version_id,value.versionId);
  const managedCopy=await request(`/team-library/${release.releaseId}/workflows`,{method:'POST',headers:{...memberHeaders,'Idempotency-Key':'native-cannot-managed-fork'},data:{}});
  assert.equal(managedCopy.status,409,JSON.stringify(managedCopy.body));
  assert.equal(managedCopy.body.code,'native_loop_managed_execution_unavailable');
  const managedInstall=await request(`/team-library/${release.releaseId}/install`,{method:'POST',headers:{...memberHeaders,'Idempotency-Key':'native-cannot-managed-install'},data:{connectionIds:[]}});
  assert.equal(managedInstall.status,409,JSON.stringify(managedInstall.body));
  assert.equal(managedInstall.body.code,'native_loop_managed_execution_unavailable');
  await assert.rejects(pool.query('UPDATE native_loop_versions SET recipe=recipe WHERE version_id=$1',[value.versionId]),/immutable_authority_history/);
  await assert.rejects(pool.query('UPDATE native_loop_version_skill_pins SET version=version WHERE native_loop_version_id=$1',[value.versionId]),/immutable_authority_history/);
  assert.equal((await publish({...data,releaseNotes:'changed'})).status,409);
  assert.equal((await publish(data,'native-release-duplicate-version')).status,409);
  await restart();
  assert.deepEqual((await publish()).body.data,first.body.data,'lost publish response replays after restart');
  assert.deepEqual((await request(packagePath,{headers:memberHeaders})).body.data,value);
  const changed=await request(`/loops/${workflowId}/revisions`,{method:'POST',headers:{...headers,'If-Match':etag,'Idempotency-Key':'native-release-private-update'},
    data:{...saveData,baseRevisionId:revision.revisionId,definition:{...saveData.definition,context:'PRIVATE_UNPUBLISHED_RECIPE_CHANGE'}}});
  assert.equal(changed.status,201,JSON.stringify(changed.body));
  assert.deepEqual((await request(packagePath,{headers:memberHeaders})).body.data,value,'later private edits never replace the published recipe');
  assert.equal((await publish({...data,version:'2.0.0'},'native-release-stale-revision')).status,412);
  assert.deepEqual((await publish()).body.data,first.body.data);
  for(const transform of [
    recipe=>{recipe.graph.nodes.find(n=>n.kind==='Skill').reviewPolicy.mode='required';},
    recipe=>{recipe.graph.nodes.find(n=>n.kind==='Skill').configuration.modelProfileId='private-model';},
    recipe=>{recipe.graph.nodes.find(n=>n.kind==='Skill').inputBindings[0].source={kind:'literal',value:'private source'};},
    recipe=>{recipe.resourceRefs=[{resourceId:'private-resource',version:'1',contentHash:`sha256:${'0'.repeat(64)}`}];},
    recipe=>{recipe.graph.edges.push({...recipe.graph.edges[0],edgeId:'branch'});},
  ]) { const recipe=structuredClone(value.recipe);transform(recipe);assert.throws(()=>validatePortableRecipe(recipe),{code:'native_loop_recipe_unsupported'}); }
  // Even a human report cannot promote an actual saved review-gated graph to a native recipe.
  const gatedGraph=structuredClone(saveData.graph);gatedGraph.nodes.find(n=>n.kind==='Skill').reviewPolicy.mode='required';
  const gated=await request(`/loops/${workflowId}/revisions`,{method:'POST',headers:{...headers,'If-Match':changed.headers.get('etag'),'Idempotency-Key':'native-gated-save'},
    data:{...saveData,graph:gatedGraph,baseRevisionId:changed.body.data.revision.revisionId}});
  assert.equal(gated.status,201,JSON.stringify(gated.body));
  const gatedData={...data,workflowRevisionId:gated.body.data.revision.revisionId,revisionContentHash:gated.body.data.revision.contentHash,version:'2.0.0'};
  const gatedTrial=await request(`/workflows/${workflowId}/local-trials`,{method:'POST',headers:{...headers,'If-Match':gated.headers.get('etag'),'Idempotency-Key':'native-gated-trial'},
    data:{workflowRevisionId:gatedData.workflowRevisionId,revisionContentHash:gatedData.revisionContentHash,localTrialId:'gated-local-trial',agentKind:'codex',inputSummary:'',output:'Synthetic human-reviewed output',reviewNote:'Human review does not enforce review gates',confirm:true,reportedCompletedAt:new Date().toISOString()}});
  assert.equal(gatedTrial.status,201,JSON.stringify(gatedTrial.body));
  const gatedPublish=await publish({...gatedData,trialId:gatedTrial.body.data.trialId},'native-gated-publish',headers,gated.headers.get('etag'));
  assert.equal(gatedPublish.status,409,JSON.stringify(gatedPublish.body));assert.equal(gatedPublish.body.code,'native_loop_recipe_unsupported');
  return {publish,packagePath};
}
