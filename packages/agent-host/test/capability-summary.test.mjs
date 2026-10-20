import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAgentHost } from '../host.mjs';

test('capability status lists outcomes without loading retained document bodies',async t=>{
  const root=await mkdtemp(join(tmpdir(),'turnsu-capability-summary-')),projectPath=join(root,'project');await mkdir(projectPath);
  const host=new LocalAgentHost({directory:join(root,'state')});
  t.after(async()=>{await host.close();await rm(root,{recursive:true,force:true});});
  const project=await host.command('project.open',{path:projectPath});
  const result=JSON.stringify({path:'Outputs/report.pdf',pages:[{page:1,text:'private-document-content-'.repeat(20_000)}]});
  for(let i=0;i<20;i++)host.db.prepare("INSERT INTO capability_receipts(id,project_id,tool,status,result,created_at) VALUES(?,?,'document','completed',?,?)").run(`receipt-${i}`,project.id,result,i);
  const status=await host.command('capabilities.list',{projectId:project.id}),encoded=JSON.stringify(status);
  assert.equal(status.receipts.length,20);assert.ok(status.receipts.every(r=>r.result.path==='Outputs/report.pdf'));
  assert.equal(encoded.includes('private-document-content-'),false);assert.ok(Buffer.byteLength(encoded)<20_000);
  assert.equal(host.db.prepare('SELECT result FROM capability_receipts WHERE id=?').get('receipt-0').result,result,'the original receipt remains available for authorized replay');
});
