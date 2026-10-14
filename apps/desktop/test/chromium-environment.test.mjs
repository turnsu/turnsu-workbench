import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareChromiumEnvironment} from '../electron/chromium-environment.mjs';
test('Linux launcher normalizes native filename locale without changing system settings or other platforms',()=>{
 const empty={};prepareChromiumEnvironment(empty,'linux');assert.equal(empty.LC_CTYPE,'C.UTF-8');
 const posix={LC_ALL:'POSIX'};prepareChromiumEnvironment(posix,'linux');assert.equal(posix.LC_ALL,'C.UTF-8');
 const utf={LANG:'zh_CN.UTF-8'};prepareChromiumEnvironment(utf,'linux');assert.deepEqual(utf,{LANG:'zh_CN.UTF-8'});
 const win={LANG:'C'};prepareChromiumEnvironment(win,'win32');assert.deepEqual(win,{LANG:'C'});
});
