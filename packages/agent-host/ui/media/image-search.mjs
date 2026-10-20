// Derived from thesysdev/open-intelligent-ui @03213439358bf3408ad61a46ec9e3230c5572e48
// Copyright (c) 2026 Thesys Inc. MIT; see LICENSE in this directory.
const cache = /* @__PURE__ */ new Map();
const HEADERS = { "User-Agent": "open-intelligent-ui (https://github.com/thesysdev/open-intelligent-ui)" };
const SKIP = /\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram/i;
const WIDTH = 960;
async function query(host, params) {
  const url = `https://${host}/w/api.php?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
  const response = await fetch(url, { redirect: "error", headers: HEADERS, signal: AbortSignal.timeout(8e3) });
  if (!response.ok) throw new Error(`${host} ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(`${host} error`);
  return (data.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}
const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
async function search(q) {
  const images = [];
  const add = (url) => {
    if (url && url.startsWith("https://") && !SKIP.test(url) && !images.includes(url)) images.push(url);
  };
  const wanted = new Set(words(q));
  const articles = await query("en.wikipedia.org", { generator: "search", gsrsearch: q, gsrlimit: "6", prop: "pageimages", piprop: "thumbnail", pithumbsize: String(WIDTH) });
  articles.filter((page) => words(page.title ?? "").some((w) => wanted.has(w))).forEach((page) => add(page.thumbnail?.source));
  const terms = q.split(/\s+/);
  const tries = [.../* @__PURE__ */ new Set([terms.join(" "), terms.slice(0, 3).join(" "), terms.slice(0, 2).join(" ")])];
  for (const t of tries) {
    if (images.length >= 3) break;
    const files = await query("commons.wikimedia.org", { generator: "search", gsrsearch: `${t} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "6", prop: "imageinfo", iiprop: "url|mime", iiurlwidth: String(WIDTH) });
    files.forEach((page) => {
      const info = page.imageinfo?.[0];
      if (info?.mime?.startsWith("image/")) add(info.thumburl ?? info.url);
    });
  }
  return images.slice(0, 4);
}
async function GET(req) {
  const q = new URL(req.url).searchParams.get("q")?.replace(/\s+/g, " ").trim();
  if (!q || q.length < 2 || q.length > 200) return Response.json({ error: { message: "q must be 2 to 200 characters" } }, { status: 400 });
  let images = cache.get(q);
  if (!images) {
    try {
      images = await search(q);
    } catch {
      return Response.json({ error: { message: "Image search unavailable" } }, { status: 502 });
    }
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(q, images);
  }
  return Response.json({ images }, { headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
}
export {
  GET
};
