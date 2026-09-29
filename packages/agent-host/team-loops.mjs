import { TeamLoopActions } from './team-loop-actions.mjs';
import { randomUUID } from 'node:crypto';
import { Check } from '../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../agent-runtime/integrations/native/product-tools.mjs';
const validId = id => typeof id === 'string' && id.trim() && id.length <= 128;
const parse = value => value ? JSON.parse(value) : null;
const inputText = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写工作流需要的资料。');
  const text = JSON.stringify(value); if (text.length > 200000) throw new Error('本次资料过长，请缩小内容后重试。'); return text;
};
function explain(error) {
  if ([401,403,404].includes(error.status) || /sync_|native_session_/.test(error.message || '')) return '暂时无法访问团队工作或工作流，请检查登录和参与权限。';
  if (error.status === 400 || error.code === 'native_product_tool_input_invalid') return '本次资料不符合工作流要求，请检查必填内容和格式。';
  return '团队服务暂时不可用。提交记录已保存在本机，请重试核对结果。';
}

// Local preparation/retry receipts only; Product owns authorization, compilation and actual Run state.
export class TeamLoops {
  constructor({ db, cloud, work, notify = () => {} }) { Object.assign(this, { db, cloud, work, notify }); this.running = new Map(); this.actions = new TeamLoopActions(this); }
  async scope(projectId, workItemId, write = false) {
    let context;
    try { context = await this.work.context(projectId, workItemId); } catch(e) { throw new Error(explain(e)); }
    const member = context.workItem.members.find(m => m.userId === context.viewerUserId);
    if (write && (member?.accessGrant.status !== 'active' || !['owner','contribute'].includes(member.accessGrant.access) || ['completed','cancelled'].includes(context.workItem.status))) throw new Error('这项工作目前不能开始新的共享运行，请检查状态和参与权限。');
    return { context, identity: await this.cloud.identity(), actor: context.viewerUserId };
  }
  async bound(row, write = false) {
    const current = await this.scope(row.project_id, row.work_item_id, write), old = parse(row.identity);
    if (current.actor !== row.actor || current.identity.origin !== old.origin || current.identity.workspaceId !== old.workspaceId) throw new Error('请切回准备这次工作流的团队账户，避免使用另一成员的执行配置。');
    return current;
  }
  view(row) { return { id: row.id, releaseId: row.release_id, prepared: parse(row.prepared), inputs: parse(row.inputs), error: row.error }; }
  async catalog(projectId, workItemId, cursor) {
    const { identity } = await this.scope(projectId, workItemId);
    const result = await this.cloud.fileCall(identity, 'turnsu_methods', { query: { assetKind: 'loop', limit: 100, ...(cursor ? { cursor } : {}) } });
    return { items: result.data.filter(item => item.executionMode !== 'native_agent'), page: result.page };
  }
  async state(projectId, workItemId) {
    const { identity, actor } = await this.scope(projectId, workItemId);
    const runs = await this.cloud.fileCall(identity, 'turnsu_work_results', { pathParams: { workItemId } });
    const rows = this.db.prepare('SELECT * FROM team_loop_preparations WHERE project_id=? AND work_item_id=? AND actor=? ORDER BY rowid DESC').all(projectId,workItemId,actor)
      .filter(row => { const saved = parse(row.identity); return saved.origin === identity.origin && saved.workspaceId === identity.workspaceId; });
    return { viewerUserId: actor, actions: this.actions.pending(projectId,workItemId,{identity,actor}), runs: runs.data, drafts: rows.filter(row => !this.db.prepare("SELECT 1 FROM team_loop_requests WHERE preparation_id=? AND status='accepted'").get(row.id)).map(row => ({ ...this.view(row),
      attempts: this.db.prepare("SELECT id,status,error,request FROM team_loop_requests WHERE preparation_id=? AND status<>'accepted' ORDER BY rowid DESC").all(row.id).map(({request,...attempt})=>({...attempt,inputs:parse(request).inputs})) })) };
  }
  preparation(id) { const row = this.db.prepare('SELECT * FROM team_loop_preparations WHERE id=?').get(id); if (!row) throw new Error('找不到这份工作流准备记录。'); return row; }
  async serialized(key, fn, fingerprint = key) { const active = this.running.get(key); if (active) { if (active.fingerprint !== fingerprint) throw new Error('同一请求不能用于不同工作流。'); return active.promise; } const promise = fn().finally(() => this.running.delete(key)); this.running.set(key,{promise,fingerprint}); return promise; }
  async prepare({ projectId, workItemId, releaseId, requestId }) {
    if (![projectId,workItemId,releaseId,requestId].every(validId)) throw new Error('请选择有效的团队工作流。');
    const existing = this.db.prepare('SELECT * FROM team_loop_preparations WHERE id=?').get(requestId);
    if (existing && (existing.project_id !== projectId || existing.work_item_id !== workItemId || existing.release_id !== releaseId)) throw new Error('同一请求不能用于不同工作流。');
    return this.serialized('prepare:'+requestId, async () => {
      let row = this.db.prepare('SELECT * FROM team_loop_preparations WHERE id=?').get(requestId);
      const scope = row ? await this.bound(row,true) : await this.scope(projectId,workItemId,true);
      if (!row) {
        this.db.prepare("INSERT INTO team_loop_preparations(id,project_id,work_item_id,release_id,identity,actor,inputs,error) VALUES(?,?,?,?,?,?,'{}','')").run(requestId,projectId,workItemId,releaseId,JSON.stringify(scope.identity),scope.actor);
        row = this.preparation(requestId);
      }
      if (!row.prepared) {
        try {
          const value = await this.cloud.fileCall(scope.identity,'turnsu_prepare_loop',{pathParams:{releaseId}, data:{}, idempotencyKey:'desktop-loop-copy-'+requestId});
          if (value.data.workflow.sourceRelease?.releaseId !== releaseId) throw new Error('release_mismatch');
          this.db.prepare("UPDATE team_loop_preparations SET prepared=?,error='' WHERE id=?").run(JSON.stringify(value.data),requestId);
        } catch(e) { const error=explain(e); this.db.prepare('UPDATE team_loop_preparations SET error=? WHERE id=?').run(error,requestId); throw new Error(error); }
      }
      return this.view(this.preparation(requestId));
    }, JSON.stringify({projectId,workItemId,releaseId,requestId}));
  }
  draft(id, inputs) { this.preparation(id); this.db.prepare('UPDATE team_loop_preparations SET inputs=? WHERE id=?').run(inputText(inputs),id); return {saved:true}; }
  async run({ preparationId, inputs, requestId }) {
    if (!validId(requestId)) throw new Error('缺少本次运行请求。');
    const row=this.preparation(preparationId), data=parse(row.prepared); if(!data) throw new Error('请先完成工作流准备。');
    const scope=await this.bound(row,true), input=JSON.parse(inputText(inputs));
    const payload={workflowId:data.workflow.workflowId,workflowRevisionId:data.revision.revisionId,inputs:input,resourceRefs:data.revision.resourceRefs,materialBindings:[],shareFinalOutput:true};
    const args={pathParams:{workItemId:row.work_item_id},data:payload,idempotencyKey:'desktop-loop-run-'+requestId};
    if(!Check(NATIVE_PRODUCT_TOOLS.find(t=>t.name==='turnsu_run_loop').inputSchema,args)) throw new Error('本次资料不符合工作流要求。');
    const old=this.db.prepare('SELECT * FROM team_loop_requests WHERE id=?').get(requestId), encoded=JSON.stringify(payload);
    if(old && (old.preparation_id!==preparationId || old.request!==encoded)) throw new Error('同一运行请求不能改用其他资料。');
    if(!old) {
      if(this.db.prepare("SELECT 1 FROM team_loop_requests WHERE preparation_id=? AND status IN ('submitting','unknown')").get(preparationId)) throw new Error('上次提交尚未确认，请先重试核对，避免重复运行。');
      this.db.prepare("INSERT INTO team_loop_requests(id,preparation_id,request,status,error) VALUES(?,?,?,'preparing','')").run(requestId,preparationId,encoded);
      this.draft(preparationId,input);
    }
    return this.serialized('run:'+requestId,()=>this.dispatch(requestId,scope));
  }
  async retry(id) {
    const request=this.db.prepare('SELECT * FROM team_loop_requests WHERE id=?').get(id); if(!request) throw new Error('找不到这次提交。');
    const scope=await this.bound(this.preparation(request.preparation_id),true);
    return this.serialized('run:'+id,()=>this.dispatch(id,scope));
  }
  async dispatch(id,scope) {
    const item=this.db.prepare('SELECT * FROM team_loop_requests WHERE id=?').get(id), row=this.preparation(item.preparation_id), payload=parse(item.request);
    if(item.status==='accepted') return parse(item.response);
    const uncertain=['submitting','unknown'].includes(item.status); let submitted=uncertain;
    try {
      if(!uncertain) {
        const result=await this.cloud.fileCall(scope.identity,'turnsu_compile_loop',{pathParams:{workflowId:payload.workflowId},data:{workflowRevisionId:payload.workflowRevisionId},idempotencyKey:'desktop-loop-check-'+randomUUID()});
        if(result.data.status!=='ready') {
          const warning=result.data.warnings?.find(w=>w.severity==='error')?.message;
          const message=/model|模型/i.test(warning || '') ? '当前账户的模型配置尚未就绪，请补齐可用模型后重试。' : '工作流需要的技能、资料或执行环境尚未就绪，请先检查团队配置。';
          this.db.prepare("UPDATE team_loop_requests SET status='blocked',error=? WHERE id=?").run(message,id); return {blocked:true,message};
        }
      }
      this.db.prepare("UPDATE team_loop_requests SET status='submitting',error='' WHERE id=?").run(id); submitted=true;
      const result=await this.cloud.fileCall(scope.identity,'turnsu_run_loop',{pathParams:{workItemId:row.work_item_id},data:payload,idempotencyKey:'desktop-loop-run-'+id});
      this.db.prepare("UPDATE team_loop_requests SET status='accepted',response=?,error='' WHERE id=?").run(JSON.stringify(result.data),id);
      this.notify({type:'changed'}); return result.data;
    } catch(e) {
      const definitive=!uncertain && e.status>=400 && e.status<500;
      this.db.prepare('UPDATE team_loop_requests SET status=?,error=? WHERE id=?').run(submitted&&!definitive?'unknown':'blocked',explain(e),id);
      throw new Error(explain(e));
    }
  }
  async close() { await Promise.allSettled([...this.running.values()].map(value => value.promise)); }
}
