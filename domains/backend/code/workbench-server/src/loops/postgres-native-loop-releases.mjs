import { Check, PublishNativeLoopDataSchema, NativeLoopRecipeSchema } from "@looloomi/workbench-contracts";
import { canonicalRequestHash, formatWorkflowEtag } from "../store/serialization.mjs";
import { ProductStoreError } from "../store/errors.mjs";

const execution = Object.freeze({ executionMode: "native_agent", executionSemantics: "agent_guided_recipe", cloudReady: false });
const fail = code => { throw new ProductStoreError(code, code); };
const iso = value => new Date(value).toISOString();

export async function publishNativeLoop(owner, { workflowId, workspaceId, userId, idempotencyKey, ifMatch, request, readSkillPackage }) {
  const data = request?.data;
  if (!Check(PublishNativeLoopDataSchema, data) || !data.version.trim() || !idempotencyKey || !ifMatch) fail("native_loop_publish_invalid");
  if (typeof readSkillPackage !== "function") fail("native_loop_unavailable");
  const requestHash = canonicalRequestHash({ workflowId, ifMatch, request });
  const operationScope = `publish-native-loop:${workflowId}`;
  return owner.store.withTransaction(async uow => {
    const query = (text, values) => owner.sql.query(uow, text, values);
    await authorize(query, workspaceId, userId);
    const workflow = (await query(`SELECT * FROM public.workflows WHERE workspace_id=$1 AND workflow_id=$2 FOR UPDATE`, [workspaceId, workflowId])).rows[0];
    if (!workflow || workflow.owner_user_id !== userId) fail("workflow_not_found");
    const prior = (await query(`SELECT request_hash,response FROM public.product_idempotency_receipts
      WHERE workspace_id=$1 AND effective_principal_id=$2 AND operation_scope=$3 AND idempotency_key=$4 FOR UPDATE`, [workspaceId,userId,operationScope,idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) fail("idempotency_key_reused");
      if (!prior.response) fail("idempotency_record_incomplete");
      return structuredClone(prior.response);
    }
    if (workflow.visibility !== "private" || workflow.archived) fail("native_loop_private_required");
    const etag = formatWorkflowEtag({ workflowId, currentRevisionId:workflow.current_revision_id, writeVersion:Number(workflow.write_version) });
    if (ifMatch !== etag || workflow.current_revision_id !== data.workflowRevisionId) fail("workflow_revision_conflict");
    const revision = (await query(`SELECT * FROM public.workflow_revisions WHERE workspace_id=$1 AND workflow_id=$2 AND revision_id=$3 FOR SHARE`, [workspaceId,workflowId,data.workflowRevisionId])).rows[0];
    if (!revision || revision.content_hash !== data.revisionContentHash) fail("workflow_revision_conflict");
    const trial = (await query(`SELECT trial_id FROM public.local_loop_trial_receipts
      WHERE workspace_id=$1 AND trial_id=$2 AND workflow_id=$3 AND workflow_revision_id=$4 AND revision_content_hash=$5
        AND reviewed_by=$6 AND provenance='member_attested_local' AND review_state='human_reviewed' AND visibility='private' FOR SHARE`,
    [workspaceId,data.trialId,workflowId,data.workflowRevisionId,data.revisionContentHash,userId])).rows[0];
    if (!trial) fail("native_loop_trial_required");
    if ((await query(`SELECT 1 FROM public.native_loop_versions WHERE workspace_id=$1 AND workflow_id=$2 AND version=$3`, [workspaceId,workflowId,data.version])).rowCount) fail("native_loop_version_exists");
    const recipe = { name:workflow.name, description:workflow.description, definition:revision.definition, graph:revision.graph,
      inputForm:revision.input_form, outputDefinition:revision.output_definition, resourceRefs:revision.resource_refs, runSettings:revision.run_settings };
    const refs = validatePortableRecipe(recipe);
    const skillPins = [];
    for (const ref of refs) {
      const row = (await query(`SELECT release.release_id,release.source_workspace_id,version.skill_id,version.skill_version_id,
          version.version,version.content_hash,version.package_hash,version.package_object_hash
        FROM public.workspace_asset_releases release JOIN public.skill_versions version
          ON version.workspace_id=release.source_workspace_id AND version.skill_id=release.skill_id
          AND version.skill_version_id=release.skill_version_id AND version.content_hash=release.content_hash
        WHERE release.source_workspace_id=$1 AND release.visibility='workspace' AND release.asset_kind='skill'
          AND version.skill_id=$2 AND version.version=$3 ORDER BY release.release_id LIMIT 1 FOR SHARE OF release,version`,
      [workspaceId,ref.skillId,ref.version])).rows[0];
      if (!row) fail("native_loop_skill_unavailable");
      const pin = pinView(row);
      await verifyPackage(pin, await readSkillPackage({workspaceId,userId,releaseId:pin.releaseId}));
      skillPins.push(pin);
    }
    const contentHash = canonicalRequestHash({recipe,skillPins});
    const dependencies = skillPins.map(pin => ({kind:"skill",id:pin.skillId,version:pin.version,required:true}));
    const versionId = owner.idFactory("native-loop-version"), releaseId = owner.idFactory("release"), now = iso(owner.clock());
    await query(`INSERT INTO public.product_idempotency_receipts
      (workspace_id,effective_principal_id,operation_scope,idempotency_key,request_hash,response,created_at,completed_at)
      VALUES ($1,$2,$3,$4,$5,NULL,$6::timestamptz,NULL)`, [workspaceId,userId,operationScope,idempotencyKey,requestHash,now]);
    await query(`INSERT INTO public.native_loop_versions
      (workspace_id,version_id,workflow_id,workflow_revision_id,revision_content_hash,trial_id,version,recipe,content_hash,released_by,released_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::timestamptz)`,
    [workspaceId,versionId,workflowId,data.workflowRevisionId,data.revisionContentHash,data.trialId,data.version,JSON.stringify(recipe),contentHash,userId,now]);
    for (const pin of skillPins) await query(`INSERT INTO public.native_loop_version_skill_pins
      (workspace_id,native_loop_version_id,source_workspace_id,release_id,skill_id,skill_version_id,version,content_hash,package_hash,package_object_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [workspaceId,versionId,pin.sourceWorkspaceId,pin.releaseId,pin.skillId,pin.skillVersionId,pin.version,pin.contentHash,pin.packageHash,pin.packageObjectHash]);
    await query(`INSERT INTO public.workspace_asset_releases
      (source_workspace_id,release_id,schema_version,asset_kind,loop_workflow_id,native_loop_version_id,version,content_hash,
       visibility,domain,starting_point,release_notes,dependencies,published_by,published_at,payload)
      VALUES ($1,$2,'workbench-v1','loop',$3,$4,$5,$6,'workspace','product',false,$7,$10::jsonb,$8,$9::timestamptz,'{}'::jsonb)`,
    [workspaceId,releaseId,workflowId,versionId,data.version,contentHash,data.releaseNotes,userId,now,JSON.stringify(dependencies)]);
    const release = { schemaVersion:"workbench-v1",releaseId,sourceWorkspaceId:workspaceId,assetKind:"loop",assetId:workflowId,
      versionId,version:data.version,contentHash,visibility:"workspace",domain:"product",startingPoint:false,releaseNotes:data.releaseNotes,
      dependencies,publishedBy:userId,publishedAt:now,...execution,
      loopSummary:{name:recipe.name,description:recipe.description,goal:recipe.definition.goal,expectedResult:recipe.definition.expectedResult} };
    const response = { release,nativeLoopVersion:{versionId,workflowId,version:data.version,contentHash,...execution} };
    await query(`UPDATE public.product_idempotency_receipts SET response=$6::jsonb,completed_at=$7::timestamptz
      WHERE workspace_id=$1 AND effective_principal_id=$2 AND operation_scope=$3 AND idempotency_key=$4 AND request_hash=$5`,
    [workspaceId,userId,operationScope,idempotencyKey,requestHash,JSON.stringify(response),now]);
    return response;
  });
}

export async function getNativeLoopPackage(owner, {workspaceId,userId,releaseId,readSkillPackage}) {
  if (typeof readSkillPackage !== "function") fail("native_loop_unavailable");
  return owner.store.withTransaction(async uow => {
    const query = (text,values) => owner.sql.query(uow,text,values);
    await authorize(query,workspaceId,userId);
    const row = (await query(`SELECT release.release_id,version.version_id,version.version,version.content_hash,version.recipe
      FROM public.workspace_asset_releases release JOIN public.native_loop_versions version
        ON version.workspace_id=release.source_workspace_id AND version.version_id=release.native_loop_version_id
        AND version.workflow_id=release.loop_workflow_id AND version.content_hash=release.content_hash
      WHERE release.source_workspace_id=$1 AND release.release_id=$2 AND release.visibility='workspace' AND release.asset_kind='loop'
      FOR SHARE OF release,version`, [workspaceId,releaseId])).rows[0];
    if (!row) fail("release_not_available");
    const skillPins = (await query(`SELECT * FROM public.native_loop_version_skill_pins
      WHERE workspace_id=$1 AND native_loop_version_id=$2 ORDER BY skill_id FOR SHARE`, [workspaceId,row.version_id])).rows.map(pinView);
    validatePortableRecipe(row.recipe);
    if (canonicalRequestHash({recipe:row.recipe,skillPins}) !== row.content_hash) fail("native_loop_package_substituted");
    for (const pin of skillPins) await verifyPackage(pin,await readSkillPackage({workspaceId,userId,releaseId:pin.releaseId}));
    return {releaseId,sourceWorkspaceId:workspaceId,versionId:row.version_id,version:row.version,contentHash:row.content_hash,
      ...execution,recipe:structuredClone(row.recipe),skillPins};
  });
}

async function authorize(query,workspaceId,userId) {
  const member = (await query(`SELECT member.role FROM public.workspace_memberships member JOIN public.product_users account ON account.user_id=member.user_id
    WHERE member.workspace_id=$1 AND member.user_id=$2 AND member.status='active' AND account.disabled=false FOR SHARE OF member,account`,[workspaceId,userId])).rows[0];
  if (!member || !["owner","admin","member"].includes(member.role)) fail("workspace_access_forbidden");
}
function pinView(row) { return {skillId:row.skill_id,skillVersionId:row.skill_version_id,version:row.version,contentHash:row.content_hash,
  releaseId:row.release_id,sourceWorkspaceId:row.source_workspace_id,packageHash:row.package_hash,packageObjectHash:row.package_object_hash}; }
function verifyPackage(pin,value) {
  if (value.releaseId!==pin.releaseId || value.versionId!==pin.skillVersionId || value.contentHash!==pin.contentHash
    || value.packageHash!==pin.packageHash || value.packageObjectHash!==pin.packageObjectHash) fail("native_loop_package_substituted");
}

export function validatePortableRecipe(recipe) {
  if (!Check(NativeLoopRecipeSchema,recipe) || recipe.resourceRefs.length || recipe.runSettings.maxParallelism!==1
    || recipe.runSettings.workflowFallbackAllowed!==false
    || Object.keys(recipe.runSettings).some(key=>!["maxParallelism","defaultTimeoutSeconds","workflowFallbackAllowed"].includes(key))) fail("native_loop_recipe_unsupported");
  const {nodes,edges}=recipe.graph;
  const byId=new Map(nodes.map(n=>[n.nodeId,n])), inputs=nodes.filter(n=>n.kind==='Input'), outputs=nodes.filter(n=>n.kind==='Output');
  if (byId.size!==nodes.length || inputs.length!==1 || outputs.length!==1 || !nodes.some(n=>n.kind==='Skill') || nodes.length>22) fail("native_loop_recipe_unsupported");
  for (const node of nodes) {
    if (!["Input","Skill","Output"].includes(node.kind) || node.condition || node.reviewPolicy.mode!=="none"
      || node.retryPolicy.maxAttempts!==1 || (node.kind==='Skill' && Object.keys(node.configuration).length)
      || node.inputBindings.some(binding=>!["runInput","nodeOutput"].includes(binding.source.kind))) fail("native_loop_recipe_unsupported");
    const incoming=edges.filter(e=>e.targetNodeId===node.nodeId), outgoing=edges.filter(e=>e.sourceNodeId===node.nodeId);
    if (incoming.length!==(node.kind==='Input'?0:1) || outgoing.length!==(node.kind==='Output'?0:1)) fail("native_loop_recipe_unsupported");
    for (const edge of outgoing) {
      const target=byId.get(edge.targetNodeId);
      if (!node.outputPorts.some(p=>p.portId===edge.sourcePort) || !target?.inputPorts.some(p=>p.portId===edge.targetPort)
        || !target.inputBindings.some(b=>b.targetPort===edge.targetPort && b.source.kind==='nodeOutput' && b.source.nodeId===node.nodeId && b.source.portId===edge.sourcePort)) fail("native_loop_recipe_unsupported");
    }
    for(const binding of node.inputBindings) {
      if(!node.inputPorts.some(p=>p.portId===binding.targetPort)) fail("native_loop_recipe_unsupported");
      if(binding.source.kind==='runInput' && !recipe.inputForm.fields.some(f=>f.fieldId===binding.source.inputKey)) fail("native_loop_recipe_unsupported");
      if(binding.source.kind==='nodeOutput' && !incoming.some(e=>e.sourceNodeId===binding.source.nodeId && e.sourcePort===binding.source.portId && e.targetPort===binding.targetPort)) fail("native_loop_recipe_unsupported");
    }
  }
  const seen=new Set(); let current=inputs[0];
  while(current && !seen.has(current.nodeId)) { seen.add(current.nodeId); current=byId.get(edges.find(e=>e.sourceNodeId===current.nodeId)?.targetNodeId); }
  if(current || seen.size!==nodes.length || recipe.outputDefinition.primary.nodeId!==outputs[0].nodeId) fail("native_loop_recipe_unsupported");
  const refs=new Map();
  for(const node of nodes.filter(n=>n.kind==='Skill')) { const prior=refs.get(node.skillRef.skillId); if(prior && prior.version!==node.skillRef.version) fail("native_loop_recipe_unsupported"); refs.set(node.skillRef.skillId,node.skillRef); }
  return [...refs.values()].sort((a,b)=>a.skillId<b.skillId?-1:a.skillId>b.skillId?1:0);
}
