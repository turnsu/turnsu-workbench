import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUpRight } from "lucide-react";
import { registeredMessageFile, remarkFileCitations } from "./message-files.mjs";

export function Markdown({ children, onOpenLink, onOpenFile, projectPath, files = [] }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, ...(onOpenFile ? [[remarkFileCitations, { projectPath, files }]] : [])]} components={{ img: ({ alt }) => <span>[图片：{alt || "未加载外部图片"}]</span>, a: ({ children, href }) => {
    const file = onOpenFile && registeredMessageFile(href, projectPath, files);
    if (file) return <button className="reference textLink" onClick={()=>onOpenFile(file)}>{children}<ArrowUpRight size={12}/></button>;
    return onOpenLink && /^https?:\/\//i.test(href || '') ? <button className="reference textLink" onClick={()=>onOpenLink(href)}>{children}<ArrowUpRight size={12}/></button> : <span className="reference">{children}</span>;
  } }}>{children}</ReactMarkdown>;
}
