// Chromium keeps its profile databases open until the Electron process exits.
// The parent test runner owns removal, including on Windows.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { prepareChromiumEnvironment } from '../electron/chromium-environment.mjs';
const scripts = { conversation: 'conversation-ui-smoke.mjs', browser: 'embedded-browser-smoke.mjs' };
const script = scripts[process.argv[2]];
if (!script) throw Error('Choose conversation or browser');
const directory = await mkdtemp(join(tmpdir(), 'turnsu-ui-test-'));
const env = { ...process.env, TURNSU_UI_TEST_ROOT: directory };
prepareChromiumEnvironment(env);
delete env.ELECTRON_RUN_AS_NODE;
let timer;
try {
  const child = spawn(typeof electron === 'string' ? electron : process.execPath,
    [...process.argv.slice(3), resolve(dirname(fileURLToPath(import.meta.url)), '../test', script)],
    { stdio: 'inherit', env });
  timer = setTimeout(() => {
    console.error('Electron UI test exceeded 90 seconds, including cleanup.');
    child.kill('SIGKILL');
  }, 90_000);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
} finally {
  clearTimeout(timer);
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
