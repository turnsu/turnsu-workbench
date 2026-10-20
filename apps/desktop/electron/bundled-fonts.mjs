import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Public, immutable packaged fonts only. A sandboxed App has an opaque origin;
// anonymous CORS here must never be inherited by IPC, project files or credentials.
export async function bundledFontResponse(request, root) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.protocol !== 'turnsu-ui:' || url.hostname !== 'app' || url.search || url.hash ||
      !/^\/fonts\/(?:noto-sans-sc-\d{3}-[A-Z0-9]{8}\.woff2|(?:inter-[456]00|ibm-plex-mono-400)-[A-Z0-9]{8}\.ttf)$/.test(url.pathname)) return new Response('Not found', { status: 404 });
  try {
    const data = await readFile(resolve(root, 'dist', '.' + url.pathname));
    return new Response(data, { headers: {
      'Content-Type': url.pathname.endsWith('.ttf') ? 'font/ttf' : 'font/woff2',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}
