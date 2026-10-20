"use client";

import { defineComponent } from "@openuidev/react-lang";
import { ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import { lookupMedia } from "../host-services";
import { Glyph } from "./glyph";
import { color, cx, fg, radius, radiusSchema, webUrl } from "./style";

const ICON_SIZE = { sm: 14, md: 18, lg: 24, xl: 32 } as const;

export const Icon = defineComponent({
  name: "Icon",
  props: z.object({
    name: z.string(),
    size: z.enum(["sm", "md", "lg", "xl"]).optional(),
    color: color.optional(),
  }),
  description: 'Lucide icon by name, e.g. "map-pin".',
  component: ({ props }) => (
    <span className="iui-icon" style={{ color: fg(props.color) }}>
      <Glyph name={props.name} size={ICON_SIZE[props.size ?? "md"] ?? 18} />
    </span>
  ),
});

// Image search
const searches = new Map<string, Promise<string[]>>();

// Turnsu adaptation: the same lookup runs through the current task's MCP bridge.
// No relative Next.js API, replacement model, or extra web server is required.
function searchImages(query: string): Promise<string[]> {
  let request = searches.get(query);
  if (!request) {
    request = lookupMedia("images", { query }).then((result) => {
      const images = Array.isArray(result.images) ? result.images.filter((value): value is string => typeof value === "string" && !!webUrl(value)) : [];
      if (!images.length) searches.delete(query);
      return images;
    }).catch(error => { searches.delete(query); throw error; });
    if (searches.size > 200) searches.delete(searches.keys().next().value!);
    searches.set(query, request);
  }
  return request;
}

/** Search results for `query`, or undefined while waiting. The query settles first: it may still be streaming. */
function useImageSearch(query: string | null): { images?: string[]; error?: string } {
  const [result, setResult] = useState<{ query: string; images?: string[]; error?: string } | null>(null);
  useEffect(() => {
    if (!query) return;
    let active = true;
    const timer = setTimeout(() => {
      searchImages(query).then((images) => {
        if (active) setResult({ query, images });
      }).catch(error => { if (active) setResult({ query, images: [], error: error.message }); });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  return query && result?.query === query ? result : {};
}

type PhotoProps = { query: string; src?: string | null; aspectRatio?: number | null; radius?: unknown; fit?: string | null };

/** Supplied photos stay exact; only SearchImage performs public image lookup. */
function Photo(props: PhotoProps) {
  const alt = typeof props.query === "string" ? props.query.trim() : "";
  const src = webUrl(props.src);
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string | null>(null);
  const supplied = props.src !== undefined && props.src !== null;
  const needSearch = !supplied && alt.length > 2;
  const found = useImageSearch(needSearch ? alt : null);
  const current = [src, ...(found.images ?? [])].find((url): url is string => !!url && !failed.includes(url));
  const settled = !current && (!needSearch || found.images !== undefined);
  const ratio = typeof props.aspectRatio === "number" && props.aspectRatio > 0.2 && props.aspectRatio < 5 ? props.aspectRatio : 1.5;
  return (
    <div
      className={cx("iui-image", props.fit === "contain" && "is-contain", loaded === current && "is-loaded")}
      style={{ aspectRatio: ratio, borderRadius: radius(props.radius ?? "lg") }}
      role={current ? undefined : "img"}
      aria-label={current ? undefined : alt}
    >
      {current ? (
        <img
          key={current}
          src={current}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(current)}
          onError={() => setFailed((list) => [...list, current])}
        />
      ) : settled ? (
        <span className="iui-image-unavailable" role="status"><ImageIcon aria-hidden className="iui-image-empty" strokeWidth={1.5} />{supplied ? '该图片未能加载，链接可能失效或超出宿主允许的图片来源。' : found.error || "未找到匹配的公开图片"}</span>
      ) : null}
    </div>
  );
}

const fit = z.enum(["cover", "contain"]).optional();

export const SearchImage = defineComponent({
  name: "SearchImage",
  props: z.object({ query: z.string(), aspectRatio: z.number().optional(), radius: radiusSchema.optional(), fit }),
  description:
    'A real photo the app finds for query; it needs no URL and no tool. Name the exact thing in 2 to 4 words: "Belém Tower Lisbon", "iPhone 17", "pastel de nata". Use one for every place, dish, product or thing with a look.',
  component: ({ props }) => <Photo {...props} />,
});

export const Image = defineComponent({
  name: "Image",
  props: z.object({ src: z.string(), alt: z.string(), aspectRatio: z.number().optional(), radius: radiusSchema.optional(), fit }),
  description: "Exact photo from a URL the user or a tool gave. A failed or host-blocked URL shows its limitation and is never replaced by a similar image.",
  component: ({ props }) => <Photo query={props.alt} src={props.src} aspectRatio={props.aspectRatio} radius={props.radius} fit={props.fit} />,
});
