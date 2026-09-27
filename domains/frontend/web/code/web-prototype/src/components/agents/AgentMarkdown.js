import { createElement, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeUrl(value) {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function externalLink({ href, children, title }) {
  return href
    ? createElement("a", { href, title, target: href.startsWith("#") ? undefined : "_blank", rel: "noopener noreferrer nofollow" }, children)
    : createElement("span", null, children);
}

// Model output is untrusted. Render text as React nodes, never raw HTML;
// remote images remain explicit links rather than background network loads.
export function AgentMarkdown({ content, locale = "zh" }) {
  const components = useMemo(() => ({
    a: externalLink,
    img: ({ src, alt }) => externalLink({ href: src, children: alt || (locale === "zh" ? "图片链接" : "Image link") }),
    h1: ({ children }) => createElement("h2", null, children),
    h2: ({ children }) => createElement("h3", null, children),
    h3: ({ children }) => createElement("h4", null, children),
    table: ({ children }) => createElement("div", {
      className: "agentMarkdownTable", tabIndex: 0, role: "region",
      "aria-label": locale === "zh" ? "结果表格" : "Result table",
    }, createElement("table", null, children)),
    pre: ({ children }) => createElement("pre", { tabIndex: 0 }, children),
  }), [locale]);
  return createElement("div", { className: "agentMarkdown" },
    createElement(Markdown, { remarkPlugins: [remarkGfm], skipHtml: true, urlTransform: safeUrl, components }, String(content || "")));
}
