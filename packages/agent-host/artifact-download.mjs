import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { get } from 'node:https';

const excluded = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) excluded.addSubnet(ip,bits);
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
for (const [ip, bits] of [['2001::',32],['2001:db8::',32],['2002::',16]]) excluded.addSubnet(ip,bits,'ipv6');
export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !excluded.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}
// Never forward a provider credential to an artifact URL. Pin the validated DNS answer for this request.
export async function downloadArtifact(rawUrl, { signal, maxBytes = 32 * 1024 * 1024, redirects = 3 } = {}) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || rawUrl.length > 8192) throw new Error('成果地址必须为公开 HTTPS 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('成果地址指向本机或受限网络，已拒绝下载。');
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await new Promise((resolve, reject) => {
    const chosen = addresses[0];
    const request = get(url, { signal, agent: false, lookup: (_host, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family) }, resolve);
    request.on('error', reject);
  });
  if ([301,302,303,307,308].includes(response.statusCode)) {
    response.destroy();
    if (!response.headers.location || redirects <= 0) throw new Error('成果下载重定向次数过多。');
    return downloadArtifact(new URL(response.headers.location, url).href, { signal, maxBytes, redirects: redirects - 1 });
  }
  if (response.statusCode !== 200 || Number(response.headers['content-length'] || 0) > maxBytes) { response.destroy(); throw new Error('成果暂不可下载或超过 32 MB，请刷新任务获取最新地址。'); }
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > maxBytes) { response.destroy(); throw new Error('成果超过下载大小限制。'); } chunks.push(chunk); }
  if (!size) throw new Error('成果文件为空，未保存。');
  return Buffer.concat(chunks, size);
}
