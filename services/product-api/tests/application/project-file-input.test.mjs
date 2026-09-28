import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProjectFile } from '../../src/work-items/project-files.mjs';
const input = overrides => ({ path: '结果/反馈.md', baseRevisionId: null, mediaType: 'text/markdown', contentBase64: Buffer.from('团队反馈').toString('base64'), ...overrides });

test('shared file intake preserves empty/binary bytes and rejects paths outside the declared area', () => {
  const bytes = Buffer.from([0, 255, 128, 1]);
  assert.deepEqual(prepareProjectFile(input({ contentBase64: bytes.toString('base64') })).bytes, bytes);
  assert.equal(prepareProjectFile(input({ contentBase64: '' })).bytes.length, 0);
  for (const path of ['../private.txt', '/etc/passwd', 'files/../../private.txt', '.env', 'files/.ssh/key', 'files\\private.txt', 'C:/private.txt', 'CON.txt', 'files/name.']) {
    assert.throws(() => prepareProjectFile(input({ path })), { code: 'project_file_path_invalid' });
  }
  for (const contentBase64 of ['a', '###=', 'YR==', 'YQ===']) assert.throws(() => prepareProjectFile(input({ contentBase64 })), { code: 'project_file_content_invalid' });
});

test('the eight MiB shared-file limit is enforced on decoded bytes', () => {
  const atLimit = Buffer.alloc(8 * 1024 * 1024, 255);
  assert.equal(prepareProjectFile(input({ contentBase64: atLimit.toString('base64') })).bytes.length, atLimit.length);
  assert.throws(() => prepareProjectFile(input({ contentBase64: Buffer.alloc(atLimit.length + 1).toString('base64') })), { code: 'project_file_content_invalid' });
});

test('deletion requires an existing revision and empty bytes, while ordinary empty files remain ordinary', () => {
  assert.equal(prepareProjectFile(input({contentBase64:''})).deleted,false);
  assert.equal(prepareProjectFile(input({deleted:true,baseRevisionId:'file-revision',contentBase64:''})).deleted,true);
  for(const value of [input({deleted:true,contentBase64:''}),input({deleted:true,baseRevisionId:'file-revision'}),input({deleted:'true'})]) {
    assert.throws(()=>prepareProjectFile(value));
  }
});
