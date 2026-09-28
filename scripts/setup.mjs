import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const packages = ['packages/contracts', 'packages/product-client', 'packages/agent-runtime', 'packages/agent-host', 'apps/desktop'];
if (process.argv.includes('--team')) packages.push('services/product-api', 'apps/team-web');
for (const path of packages) {
  for (const args of [['ci', '--no-audit', '--no-fund'], ...(['packages/contracts', 'packages/product-client'].includes(path) ? [['run', 'build']] : [])]) {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root + path, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
