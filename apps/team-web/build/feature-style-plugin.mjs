import fs from "node:fs";
import path from "node:path";

import postcss from "postcss";

const VIRTUAL_PREFIX = "virtual:feature-styles/";
const RESOLVED_PREFIX = `\0${VIRTUAL_PREFIX}`;
const FEATURE_SOURCES = Object.freeze({
  skills: ["styles.css", "styles/lifecycle.css", "styles/visual-baseline.css", "styles/selected-direction.css"],
  loops: ["styles.css", "styles/lifecycle.css", "styles/visual-baseline.css", "styles/selected-direction.css"],
  builder: ["styles.css", "styles/visual-baseline.css", "styles/selected-direction.css"],
  runs: ["styles.css", "styles/lifecycle.css", "styles/visual-baseline.css", "styles/selected-direction.css"],
  library: ["styles.css", "styles/library.css", "styles/lifecycle.css", "styles/visual-baseline.css", "styles/selected-direction.css"],
  automations: ["styles.css", "styles/automations.css"],
  work: ["styles.css", "styles/work.css"],
});

function insideKeyframes(rule) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return true;
    parent = parent.parent;
  }
  return false;
}

function scopeSelector(selector, feature) {
  const value = selector.trim();
  if (!value || /^(?::root|html\b|body\b|#root\b)/.test(value)) return null;
  // Navigation belongs to the shared shell. A visited feature must not restyle
  // it or change its layout through an old page-specific visual baseline.
  if (/(?:^|[\s>+~])\.(?:global[A-Z]|account[A-Z])/.test(value)) return null;
  if (value.startsWith(".shell")) {
    return value.replace(/^\.shell/, `.shell.feature-${feature}`);
  }
  return `.shell.feature-${feature} ${value}`;
}

const SHELL_LAYOUT_PROPERTIES = new Set([
  "display",
  "grid-template-columns",
  "grid-template-rows",
  "min-height",
  "height",
  "overflow",
]);

const TOAST_POSITION_PROPERTIES = new Set([
  "position",
  "z-index",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "max-width",
]);

function stripShellOwnedDeclarations(rule) {
  const selectors = rule.selectors.map((selector) => selector.trim());
  const propertySet = selectors.some((selector) => selector.startsWith(".shell") && !/[\s>+~]/.test(selector))
    ? SHELL_LAYOUT_PROPERTIES
    : selectors.some((selector) => selector === ".toastStack")
      ? TOAST_POSITION_PROPERTIES
      : null;
  if (!propertySet) return;
  rule.walkDecls((declaration) => {
    if (propertySet.has(declaration.prop)) declaration.remove();
  });
}

function removeEmptyContainers(root) {
  let changed = true;
  while (changed) {
    changed = false;
    root.walkAtRules((rule) => {
      if (rule.nodes && rule.nodes.length === 0) {
        rule.remove();
        changed = true;
      }
    });
  }
}

function scopedFeatureCss({ rootDirectory, feature }) {
  const sources = FEATURE_SOURCES[feature];
  if (!sources) throw new Error(`unknown_feature_style:${feature}`);
  const source = sources.map((file) => {
    const absolutePath = path.join(rootDirectory, "src", file);
    return `/* ${file} */\n${fs.readFileSync(absolutePath, "utf8")}`;
  }).join("\n");
  const root = postcss.parse(source, { from: `${feature}.feature.css` });
  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    stripShellOwnedDeclarations(rule);
    const selectors = rule.selectors
      .map((selector) => scopeSelector(selector, feature))
      .filter(Boolean);
    if (!selectors.length) {
      rule.remove();
      return;
    }
    rule.selectors = selectors;
  });
  removeEmptyContainers(root);
  return root.toString();
}

export function featureStylePlugin({ rootDirectory = process.cwd() } = {}) {
  return {
    name: "looloomi-feature-style-boundary",
    enforce: "pre",
    resolveId(id) {
      if (!id.startsWith(VIRTUAL_PREFIX) || !id.endsWith(".css")) return null;
      return `${RESOLVED_PREFIX}${id.slice(VIRTUAL_PREFIX.length)}`;
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX) || !id.endsWith(".css")) return null;
      const feature = id.slice(RESOLVED_PREFIX.length, -".css".length);
      return scopedFeatureCss({ rootDirectory, feature });
    },
  };
}
