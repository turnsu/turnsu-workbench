import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// A growing file must not defeat the admission size check or consume unbounded memory.
export async function readBoundedFile(path, maxBytes) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error('材料不是普通文件或超过读取上限。');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('材料在读取期间发生变化，请重新选择。');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

export function dockerBind(source, destination, readOnly = false) {
  const field = value => `"${value.replaceAll('"', '""')}"`;
  return ['type=bind', field(`src=${source}`), field(`dst=${destination}`), ...(readOnly ? ['readonly'] : [])].join(',');
}
