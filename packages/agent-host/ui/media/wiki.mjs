// Derived from thesysdev/open-intelligent-ui @03213439358bf3408ad61a46ec9e3230c5572e48
// Copyright (c) 2026 Thesys Inc. MIT; see LICENSE in this directory.
const cache = /* @__PURE__ */ new Map();
const HEADERS = { "User-Agent": "open-intelligent-ui (https://github.com/thesysdev/open-intelligent-ui)" };
async function get(url) {
  const response = await fetch(url, { redirect: "error", headers: HEADERS, signal: AbortSignal.timeout(8e3) });
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Wikipedia ${response.status}`);
  return response.json();
}
async function GET(req) {
  const title = new URL(req.url).searchParams.get("title")?.trim();
  if (!title || title.length > 200) return Response.json({ error: { message: "title is required" } }, { status: 400 });
  let info = cache.get(title);
  if (!info) {
    const t = encodeURIComponent(title.replace(/ /g, "_"));
    try {
      const [summary, media] = await Promise.all([
        get(`https://en.wikipedia.org/api/rest_v1/page/summary/${t}`),
        get(`https://en.wikipedia.org/api/rest_v1/page/media-list/${t}`)
      ]);
      const photos = [];
      const key = (u) => decodeURIComponent(u.split("?")[0].split("/").slice(-1)[0]).replace(/^\d+px-/, "");
      if (summary?.thumbnail?.source) photos.push(summary.thumbnail.source);
      for (const item of media?.items ?? []) {
        if (item.type !== "image" || !item.srcset?.length) continue;
        const src = item.srcset[0].src;
        if (/\.svg|icon|logo|map|flag|seal/i.test(src)) continue;
        const url = src.startsWith("//") ? `https:${src}` : src;
        if (!photos.some((p) => key(p) === key(url))) photos.push(url);
        if (photos.length >= 3) break;
      }
      info = { lat: summary?.coordinates?.lat, lng: summary?.coordinates?.lon, photos };
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(title, info);
    } catch {
      return Response.json({ error: { message: "Wikipedia unavailable" } }, { status: 502 });
    }
  }
  return Response.json(info, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
}
export {
  GET
};
