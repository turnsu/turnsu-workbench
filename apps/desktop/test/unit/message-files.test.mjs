import test from "node:test";
import assert from "node:assert/strict";
import { registeredMessageFile, remarkFileCitations } from "../../src/features/files/message-files.mjs";

test("file links only resolve registered project files across path formats", () => {
  const file = { path: "Outputs/订单 核对.csv", bytes: 42 };
  for (const [root, reference] of [
    ["/tmp/项目", "/tmp/项目/Outputs/订单 核对.csv"],
    ["C:\\工作", "C:\\工作\\Outputs\\订单 核对.csv"],
    ["/tmp/项目", encodeURI(file.path)],
  ]) assert.deepEqual(registeredMessageFile(reference, root, [file]), file);
  for (const reference of ["../Outputs/订单 核对.csv", "/other/Outputs/订单 核对.csv", "https://example.com/result.csv", "%ZZ"])
    assert.equal(registeredMessageFile(reference, "/tmp/项目", [file]), null);
});

test("native file citations become receipt-backed links while code and unknown paths stay non-executable", () => {
  const citation = ':codex-file-citation{path="/tmp/项目/结果.csv" artifact_kind="workbook" purpose="output"}';
  const tree = { type: "root", children: [
    { type: "paragraph", children: [{ type: "text", value: "已完成 " + citation + "。" }] },
    { type: "code", value: citation },
    { type: "paragraph", children: [{ type: "inlineCode", value: citation }] },
  ] };
  remarkFileCitations({ projectPath: "/tmp/项目", files: [{ path: "结果.csv" }] })(tree);
  assert.equal(tree.children[0].children[1].url, encodeURI("结果.csv"));
  assert.equal(tree.children[0].children[1].children[0].value, "结果.csv");
  assert.equal(tree.children[1].value, citation);
  assert.equal(tree.children[2].children[0].value, citation);
  const unknown = { type: "root", children: [{ type: "text", value: citation }] };
  remarkFileCitations({ files: [] })(unknown);
  assert.equal(unknown.children.some((node) => node.type === "link"), false);
  assert.match(unknown.children.map((node) => node.value).join(""), /尚未关联到当前工作/);
});
