import { Check } from '../contracts/dist/index.js';
import { NATIVE_PRODUCT_TOOLS } from '../agent-runtime/integrations/native/product-tools.mjs';

const terminal = new Set(['completed','failed','cancelled','partial','effect_outcome_unknown']);
const decode = JSON.parse;
const message = error => ['review_stale','review_not_waiting','workflow_run_review_not_waiting'].includes(error.code)
  ? '这轮复核已变化，请重新查看内容后决定。'
  : ['review_feedback_target_missing','review_feedback_target_invalid'].includes(error.code) ? '这个工作流尚未配置可重做的步骤，可以结束后重新准备。'
  : error.code==='review_changes_required' ? '请说明哪里需要修改。'
  : error.code==='workflow_run_review_decision_required' ? '本次运行正在等待复核，请查看内容后选择不通过并结束。'
  : [401,403,404].includes(error.status) ? '暂时没有处理这次运行的权限，请检查团队登录。'
  : '尚未确认处理结果。请求已保存在本机，请核对上次操作。';

// Only retry receipts live locally. Product remains authoritative for every decision.
export class TeamLoopActions {
  constructor(loops) { this.loops=loops; this.db=loops.db; }
  async owned(scope, runId) {
    const current=await this.loops.scope(scope.projectId,scope.workItemId);
    const result=await this.loops.cloud.fileCall(current.identity,'turnsu_work_results',{pathParams:{workItemId:scope.workItemId}});
    const run=result.data.find(item=>item.runId===runId);
    if(!run || run.requestedByUserId!==current.actor) throw new Error('只有发起人可以处理这次运行。');
    return {...current,run};
  }
  async inspect(scope) {
    const current=await this.owned(scope,scope.runId);
    const result=await this.loops.cloud.fileCall(current.identity,'turnsu_run_details',{pathParams:{runId:scope.runId}});
    const packet=result.data.readModel?.reviewPacket;
    const attempt=packet && result.data.run.nodeRuns.find(node=>node.nodeId===packet.nodeId&&node.status==='waiting_review');
    return {status:result.data.run.status,rounds:result.data.readModel?.reviewRounds ?? [],olderRounds:result.data.readModel?.olderReviewRounds ?? 0,review:packet&&attempt?{...packet,expectedNodeRunId:attempt.nodeRunId}:null};
  }
  pending(projectId,workItemId,current) {
    return this.db.prepare("SELECT * FROM team_loop_actions WHERE project_id=? AND work_item_id=? AND actor=? AND status IN ('submitting','unknown') ORDER BY rowid DESC")
      .all(projectId,workItemId,current.actor).filter(row=>{const identity=decode(row.identity);return identity.origin===current.identity.origin&&identity.workspaceId===current.identity.workspaceId;})
      .map(row=>({id:row.id,runId:row.run_id,...decode(row.request),error:row.error}));
  }
  async submit({projectId,workItemId,runId,requestId,kind,data}) {
    if(typeof requestId!=='string'||!requestId||requestId.length>128)throw new Error('缺少本次操作标识。');
    const tool=kind==='cancel'?'turnsu_cancel_run':kind==='review'?'turnsu_review_run':null;
    const input={pathParams:{runId},data,idempotencyKey:'desktop-loop-action-'+requestId};
    if(!tool || !Check(NATIVE_PRODUCT_TOOLS.find(t=>t.name===tool).inputSchema,input)
      || (kind==='review' && (!data.expectedNodeRunId || (data.decision==='revise'&&!data.requestedChanges.some(text=>text.trim())))))throw new Error('请查看本轮复核，选择通过、说明修改意见或不通过并结束。');
    const encoded=JSON.stringify({kind,data});
    return this.loops.serialized('action:'+requestId,async()=>{
      const old=this.db.prepare('SELECT * FROM team_loop_actions WHERE id=?').get(requestId);
      if(old&&(old.project_id!==projectId||old.work_item_id!==workItemId||old.run_id!==runId||old.request!==encoded))throw new Error('同一操作不能改用其他决定。');
      const current=await this.owned({projectId,workItemId},runId);
      if(old){const saved=decode(old.identity);if(old.actor!==current.actor||saved.origin!==current.identity.origin||saved.workspaceId!==current.identity.workspaceId)throw new Error('请切回提交这次操作的团队账户。');}
      if(old?.status==='accepted')return decode(old.response);
      if(old?.status==='rejected')throw new Error(old.error);
      if(!old){
        if(this.pending(projectId,workItemId,current).some(item=>item.runId===runId))throw new Error('请先核对上次操作，避免提交不同决定。');
        if(terminal.has(current.run.status))throw new Error('这次运行已结束，请刷新成果。');
        this.db.prepare("INSERT INTO team_loop_actions(id,project_id,work_item_id,run_id,identity,actor,request,status,error) VALUES(?,?,?,?,?,?,?,'submitting','')")
          .run(requestId,projectId,workItemId,runId,JSON.stringify(current.identity),current.actor,encoded);
      }
      try{
        const result=await this.loops.cloud.fileCall(current.identity,tool,input);
        this.db.prepare("UPDATE team_loop_actions SET status='accepted',response=?,error='' WHERE id=?").run(JSON.stringify(result.data),requestId);
        return result.data;
      }catch(error){
        const definitive=!old&&error.status>=400&&error.status<500;
        this.db.prepare('UPDATE team_loop_actions SET status=?,error=? WHERE id=?').run(definitive?'rejected':'unknown',message(error),requestId);
        throw new Error(message(error));
      }
    },JSON.stringify({projectId,workItemId,runId,encoded}));
  }
  retry(id){
    const row=this.db.prepare('SELECT * FROM team_loop_actions WHERE id=?').get(id);
    if(!row)throw new Error('找不到这次处理记录。');
    return this.submit({projectId:row.project_id,workItemId:row.work_item_id,runId:row.run_id,requestId:id,...decode(row.request)});
  }
}
