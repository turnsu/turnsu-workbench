import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { installNativeSkill, verifyInstalledNativeSkill } from '../integrations/native/install-skill.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const source = '---\nname: team-feedback\ndescription: Summarize feedback and retain evidence.\n---\nUse references/guide.md.\n';
function bundle(version = '1.0.0', files = [{path:'SKILL.md',text:source},{path:'references/guide.md',text:`Method ${version}: preserve exact evidence.`}]) {
  const bytes = Buffer.from(JSON.stringify({format:'workbench-skill-package-v1',files:files.map(f=>({path:f.path,content:Buffer.from(f.text).toString('base64')}))}));
  return {releaseId:`release-${version}`, versionId:`version-${version}`, version, skillName:'team-feedback',
    packageObjectHash:hash(bytes), packageHash:hash(bytes),contentHash:hash(bytes), compatibility:null, packageContentBase64:bytes.toString('base64')};
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'turnsu-install-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let value = bundle();
  return {root,set:value_=>{value=value_;}, product:{origin:'http://127.0.0.1:8798',call:async(name,input)=>{
    assert.equal(name,'turnsu_skill_package');assert.equal(input.pathParams.releaseId,value.releaseId);return {data:value};
  }}};
}

test('exact instruction package installs for each native client, retains references and is idempotent',async t=>{
  const f=await fixture(t);
  for(const agent of ['codex','claude','pi']) {
    const args={product:f.product,projectDirectory:f.root,releaseId:'release-1.0.0',agent};
    const installed=await installNativeSkill(args);
    assert.equal(installed.status,'installed');assert.equal(installed.nativeExecution,'not_verified');
    assert.equal(await readFile(join(installed.directory,'SKILL.md'),'utf8'),source);
    assert.equal(await readFile(join(installed.directory,'references/guide.md'),'utf8'),'Method 1.0.0: preserve exact evidence.');
    assert.equal((await installNativeSkill(args)).status,'already_installed');
    const loaded=loadSkillsFromDir({dir:installed.directory,source:'project'});
    assert.equal(loaded.skills[0].name,'team-feedback');assert.equal(loaded.skills[0].description,'Summarize feedback and retain evidence.');
  }
});

test('updates require the current release, preserve modified content and keep fixed versions until requested',async t=>{
  const f=await fixture(t);const args={product:f.product,projectDirectory:f.root,agent:'codex',releaseId:'release-1.0.0'};
  const installed=await installNativeSkill(args);
  f.set(bundle('2.0.0'));
  await assert.rejects(installNativeSkill({...args,releaseId:'release-2.0.0'}),/update_requires_current_release/);
  assert.match(await readFile(join(installed.directory,'references/guide.md'),'utf8'),/1\.0\.0/);
  const updated=await installNativeSkill({...args,releaseId:'release-2.0.0',replaceReleaseId:'release-1.0.0'});
  assert.equal(updated.status,'updated');assert.match(await readFile(join(installed.directory,'references/guide.md'),'utf8'),/2\.0\.0/);
  await assert.rejects(verifyInstalledNativeSkill({projectDirectory:f.root,...installed}),/installed_version_changed/);
  assert.equal(await verifyInstalledNativeSkill({projectDirectory:f.root,...updated}),updated.directory);
  await writeFile(join(installed.directory,'SKILL.md'),'My local edits');
  f.set(bundle('3.0.0'));
  await assert.rejects(installNativeSkill({...args,releaseId:'release-3.0.0',replaceReleaseId:'release-2.0.0'}),/local_changes_preserved/);
  assert.equal(await readFile(join(installed.directory,'SKILL.md'),'utf8'),'My local edits');
  assert.equal((await readdir(f.root)).some(name=>name.startsWith('.turnsu-skill-')),false);
});

test('foreign same-name skills, symlinked roots and symlinked content cannot be overwritten',async t=>{
  const f=await fixture(t);const args={product:f.product,projectDirectory:f.root,agent:'codex',releaseId:'release-1.0.0'};
  await mkdir(join(f.root,'outside'));
  await symlink(join(f.root,'outside'),join(f.root,'.agents'));
  await assert.rejects(installNativeSkill(args),/directory_symlink_or_conflict/);
  await rm(join(f.root,'.agents'));
  await mkdir(join(f.root,'.agents/skills/team-feedback'),{recursive:true});
  await writeFile(join(f.root,'.agents/skills/team-feedback/SKILL.md'),'existing unrelated skill');
  await assert.rejects(installNativeSkill(args),/name_conflict/);
  assert.equal(await readFile(join(f.root,'.agents/skills/team-feedback/SKILL.md'),'utf8'),'existing unrelated skill');
});

test('download corruption and unsafe paths leave the project untouched',async t=>{
  const f=await fixture(t);const args={product:f.product,projectDirectory:f.root,agent:'pi',releaseId:'release-1.0.0'};
  f.set({...bundle(),packageObjectHash:`sha256:${'0'.repeat(64)}`});
  await assert.rejects(installNativeSkill(args),/hash_mismatch/);
  for(const path of ['../outside','/absolute','.claude-plugin/plugin.json','references/../../outside','x\\y','C:/x']) {
    f.set(bundle('1.0.0',[{path:'SKILL.md',text:source},{path,text:'bad'}]));
    await assert.rejects(installNativeSkill(args),/package_path_invalid/);
  }
  f.set(bundle('1.0.0',[{path:'SKILL.md',text:source},{path:'skill.md',text:'collision'}]));
  await assert.rejects(installNativeSkill(args),/package_path_conflict/);
  assert.deepEqual(await readdir(f.root),[]);
});
