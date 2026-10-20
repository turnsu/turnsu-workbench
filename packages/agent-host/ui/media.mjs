import { GET as wiki } from './media/wiki.mjs';
import { GET as images } from './media/image-search.mjs';
import { GET as route } from './media/street-route.mjs';

// The upstream read-only providers, kept local to the existing task service.
// Query values never choose a host, URL, file path, or executable.
export async function lookupPublicMedia({ kind, query, coords }) {
  if (!['images', 'wiki', 'route'].includes(kind)) throw new Error('未注册的公开资料查询。');
  if (kind !== 'route' && (typeof query !== 'string' || query.trim().length < 2 || query.length > 200)) throw new Error('图片或地点名称须为 2–200 字。');
  if (kind === 'route' && (typeof coords !== 'string' || coords.length > 1600)) throw new Error('路线坐标无效。');
  const input = new URL('https://turnsu.invalid/lookup');
  input.searchParams.set(kind === 'route' ? 'coords' : kind === 'wiki' ? 'title' : 'q', kind === 'route' ? coords : query.trim());
  const response = await ({ images, wiki, route })[kind](new Request(input));
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || '公开图片或路线服务暂不可用。');
  if (JSON.stringify(value).length > 150_000) throw new Error('公开资料结果过长，请缩小查询范围。');
  return value;
}
