// Compile the existing company PNG into OS icon containers; no new artwork is introduced.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconset = resolve(root, '../../../../../.build/turnsu.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
  const target = resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
  execFileSync('sips', ['-z', String(size * scale), String(size * scale), resolve(root, 'resources/icon.png'), '--out', target], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', resolve(root, 'resources/icon.icns')]);
const png = await readFile(resolve(iconset, 'icon_256x256.png'));
const header = Buffer.alloc(22); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12); header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
await writeFile(resolve(root, 'resources/icon.ico'), Buffer.concat([header, png]));
