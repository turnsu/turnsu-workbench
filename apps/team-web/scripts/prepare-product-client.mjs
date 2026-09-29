import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const path of ['contracts', 'product-client']) {
  const root = fileURLToPath(new URL(`../../../packages/${path}/`, import.meta.url));
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
