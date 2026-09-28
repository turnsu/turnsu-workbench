import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { createNativeSkillZip } from '../src/components/library/native-skill-download.js';
const files = [
  { path: 'SKILL.md', content: Buffer.from('---\nname: team-feedback\n---\n读取 references/格式.md\n').toString('base64') },
  { path: 'references/格式.md', content: Buffer.from('保留同事的原话。\n').toString('base64') },
];
function bundle(entries = files) {
  const bytes = Buffer.from(JSON.stringify({ format: 'workbench-skill-package-v1', files: entries }));
  return { skillName: 'team-feedback', releaseId: 'release-one', versionId: 'version-one', version: '1.0.0',
    packageObjectHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, packageContentBase64: bytes.toString('base64') };
}
const archive = await createNativeSkillZip(bundle());
assert.equal(archive.filename, 'team-feedback-1.0.0.zip');
const unzipped = unzipSync(archive.bytes);
for (const file of files) assert.deepEqual(Buffer.from(unzipped[`team-feedback/${file.path}`]), Buffer.from(file.content, 'base64'));
assert.equal(JSON.parse(Buffer.from(unzipped['turnsu-release.json']).toString()).installation, 'not_performed');
await assert.rejects(createNativeSkillZip({ ...bundle(), packageObjectHash: 'sha256:wrong' }), /hash_mismatch/);
for (const path of ['../SKILL.md', '/SKILL.md', '.agents/settings.json', 'references\\escape.md', 'references/../escape.md']) {
  await assert.rejects(createNativeSkillZip(bundle([...files, { path, content: 'YQ==' }])), /path_invalid/);
}
for (const entries of [[...files, { path: 'skill.md', content: 'YQ==' }], [...files, { path: 'references', content: 'YQ==' }]]) {
  await assert.rejects(createNativeSkillZip(bundle(entries)), /path_invalid/);
}
console.log('Native skill download preserves exact files and rejects corrupt or unsafe packages.');
