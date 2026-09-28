import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConnection, publicConnection } from '../host-dist/model-connections.mjs';

async function protectedOperation(operation, timeout) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('系统密钥保护尚未响应。请完成系统授权或稍后重试；原有连接未改动。')), timeout); })]); }
  finally { clearTimeout(timer); }
}

// Only this main-process owner reads or writes persisted secrets. Renderer reads are metadata-only.
export class ConnectionVault {
  constructor(directory, encryption, { timeout = 10_000, platform = process.platform } = {}) { this.path = join(directory, 'model-connections.json'); this.encryption = encryption; this.profiles = []; this.error = null; this.timeout = timeout; this.platform = platform; this.encryptionAvailable = null; }
  async available() {
    // No synchronous Keychain calls: macOS may wait for system authorization indefinitely.
    // Linux async fallback has different guarantees; this desktop currently ships macOS/Windows only.
    if (!['darwin', 'win32'].includes(this.platform)) return (this.encryptionAvailable = false);
    return (this.encryptionAvailable = await protectedOperation(this.encryption.isAsyncEncryptionAvailable(), this.timeout));
  }
  async read() {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 500_000) throw new Error('invalid_file');
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.connections) || saved.connections.length > 12) throw new Error('invalid_schema');
      if (!await this.available()) throw new Error('locked');
      const decrypted = await protectedOperation(Promise.all(saved.connections.map(p => this.encryption.decryptStringAsync(Buffer.from(p.encryptedKey, 'base64')))), this.timeout);
      const profiles = saved.connections.map((p, index) => normalizeConnection({ ...p, apiKey: decrypted[index].result }));
      this.profiles = profiles;
      if (new Set(this.profiles.map(p => p.id)).size !== this.profiles.length) throw new Error('duplicate_profile');
      if (decrypted.some(p => p.shouldReEncrypt)) await this.write(profiles);
      this.error = null;
    } catch (error) {
      this.profiles = [];
      if (error.code !== 'ENOENT') this.error = '无法解锁已保存的模型连接。请解锁系统钥匙串后重新打开工作台；原配置文件已保留。原生 Agent 配置仍可使用。';
    }
  }
  list() { return { connections: this.profiles.map(publicConnection), encryptionAvailable: this.encryptionAvailable, error: this.error }; }
  async prepare(input) {
    if (this.error) throw new Error(this.error);
    const existing = this.profiles.find(p => p.id === input.id);
    if (input.id && !existing) throw new Error('连接已不存在，请重新读取。');
    const next = normalizeConnection({ ...input, id: existing?.id || randomUUID(), apiKey: input.apiKey || existing?.apiKey });
    if (existing && (existing.baseUrl !== next.baseUrl || existing.protocol !== next.protocol)) throw new Error('端点或协议变更需要新建连接，避免将已有会话发往其他服务。');
    const profiles = [...this.profiles.filter(p => p.id !== next.id), next];
    if (profiles.length > 12) throw new Error('最多保存 12 个模型连接，请先移除不再使用的连接。');
    if (!await this.available()) throw new Error('系统密钥保护不可用，请解锁系统后再保存。');
    return profiles;
  }
  async write(profiles) {
    if (!await this.available()) throw new Error('系统密钥保护不可用，配置未保存。');
    const encrypted = await protectedOperation(Promise.all(profiles.map(p => this.encryption.encryptStringAsync(p.apiKey))), this.timeout);
    const connections = profiles.map((p, index) => ({ ...publicConnection(p), encryptedKey: encrypted[index].toString('base64') }));
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, connections }), { mode: 0o600, flag: 'wx' });
    await rename(temp, this.path); this.profiles = profiles;
  }
}
