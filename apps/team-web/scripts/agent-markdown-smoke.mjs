import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown } from "../src/components/agents/AgentMarkdown.js";

const render = (content) => renderToStaticMarkup(createElement(AgentMarkdown, { content }));
const checklist = render('# 试用清单\n\n1. **明确目标**：写下预期。\n2. 检查 `result`。\n\n| 检查 | 结果 |\n| --- | --- |\n| 保存 | 通过 |\n\n```js\nconst value = "<script>";\n```');
assert.match(checklist, /<h2>试用清单<\/h2>/u);
assert.match(checklist, /<ol>/u);
assert.match(checklist, /<strong>明确目标<\/strong>/u);
assert.match(checklist, /<table>/u);
assert.match(checklist, /&lt;script&gt;/u);
assert.match(render(`首段。\n\n${"后续内容".repeat(150)}最终结论。`), /最终结论。/u);

const untrusted = render('<script>alert(1)</script>\n\n<img src="https://example.test/tracker" onerror="alert(1)">\n\n[不安全](javascript:alert%281%29) [正常](https://example.test/result) ![远程图](https://example.test/pixel)');
assert.doesNotMatch(untrusted, /<script|<img|onerror=|javascript:/u);
assert.match(untrusted, /href="https:\/\/example.test\/result"/u);
assert.match(untrusted, /rel="noopener noreferrer nofollow"/u);
assert.match(untrusted, />远程图<\/a>/u);
console.log('agent_markdown_smoke:ok');
