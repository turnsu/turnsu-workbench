export function registeredMessageFile(reference, projectPath, files = []) {
  if (typeof reference !== "string") return null;
  let path;
  try { path = decodeURIComponent(reference).replaceAll("\\", "/"); }
  catch { return null; }
  if (path.split("/").includes("..")) return null;
  const root = String(projectPath || "").replaceAll("\\", "/").replace(/\/$/, "");
  return files.find((file) => path === file.path || (root && path === root + "/" + file.path)) || null;
}

// Interpret a native attachment reference as content, not permission to read a
// path. Code examples remain literal; only current Host receipts become links.
export function remarkFileCitations({ projectPath, files = [] } = {}) {
  return (tree) => {
    function visit(node) {
      if (!node.children || node.type === "link") return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text") { visit(child); return [child]; }
        const out = [];
        let offset = 0;
        for (const match of child.value.matchAll(/:codex-file-citation\{([^{}\n]*)\}/g)) {
          const path = match[1].match(/\bpath="([^"]+)"/)?.[1];
          if (!path) continue;
          out.push({ type: "text", value: child.value.slice(offset, match.index) });
          const file = registeredMessageFile(path, projectPath, files);
          const label = path.replaceAll("\\", "/").split("/").at(-1);
          out.push(file
            ? { type: "link", url: encodeURI(file.path), children: [{ type: "text", value: label }] }
            : { type: "text", value: label + "（尚未关联到当前工作）" });
          offset = match.index + match[0].length;
        }
        return offset ? [...out, { type: "text", value: child.value.slice(offset) }] : [child];
      });
    }
    visit(tree);
  };
}
