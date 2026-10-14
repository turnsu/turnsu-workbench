import test from "node:test";
import assert from "node:assert/strict";
import { surfaceStatus, numericColumns, confirmationState } from "./surface-state.mjs";

const review = (events = [], extra = {}) => ({
  status: "idle",
  dirty: false,
  presentation: { presented_at: 100 },
  document: { tree: { type: "Layout", children: [{ type: "Action", action: "submit" }] } },
  events,
  ...extra,
});

test("confirmation changes the visible review state without inviting another submission", () => {
  assert.equal(surfaceStatus(review()).label, "等待你确认");
  for (const state of ["sent", "consumed"])
    assert.deepEqual(surfaceStatus(review([{ created_at: 101, state }])), {
      label: "确认内容已交给助手",
      tone: "success",
    });
});

test("an earlier confirmation cannot make a new presentation look confirmed", () => {
  assert.equal(
    surfaceStatus(review([{ created_at: 99, state: "consumed" }])).label,
    "等待你确认",
  );
});

test("saved edits need another confirmation and do not keep a previous success indication", () => {
  assert.deepEqual(
    surfaceStatus(
      review([{ created_at: 101, state: "sent" }], { dirty: true }),
    ),
    { label: "修改已保存，等待你确认", tone: "waiting" },
  );
});

test("pending and uncertain delivery are not presented as completed", () => {
  assert.equal(
    surfaceStatus(review([{ created_at: 101, state: "pending" }])).label,
    "已确认，等待助手接收",
  );
  assert.equal(
    surfaceStatus(review([{ created_at: 101, state: "uncertain" }])).tone,
    "warning",
  );
  assert.equal(
    surfaceStatus(review([], { status: "failed", error: "未保存" })).tone,
    "error",
  );
});

test("read-only content does not ask for a confirmation that the user cannot give", () => {
  const document = { tree: { type: "Layout", children: [{ type: "Text" }, { type: "Status" }] } };
  assert.deepEqual(surfaceStatus(review([], { document })), {
    label: "内容已展示", tone: "neutral",
  });
  assert.equal(surfaceStatus(review([], {
    document, results: [{ createdAt: 101, files: [{ path: "说明.txt" }] }],
  })).label, "成果可查看");
  assert.equal(surfaceStatus(review([], {
    document, results: [{ createdAt: 99, files: [{ path: "旧结果.txt" }] }],
  })).label, "内容已展示");
  assert.equal(surfaceStatus(review([], { document, dirty: true })).label, "修改已保存");
});

test("an unresolved submission stays blocked after edits and outranks a busy Agent", () => {
  for (const state of ["pending", "dispatching", "uncertain"]) {
    const value = review([{ created_at: 101, state }], { dirty: true, status: "running" });
    assert.equal(confirmationState(value), state);
    assert.notEqual(surfaceStatus(value).label, "助手正在处理");
  }
  assert.deepEqual(surfaceStatus(review([{ created_at: 101, state: "uncertain" }], {
    dirty: true, status: "waiting",
  })), { label: "请在对话中核对接收状态", tone: "warning" });
});

test("delivery is not business completion and partial failures retain a recovery message", () => {
  const confirmed = [{ created_at: 101, state: "consumed" }];
  assert.equal(confirmationState(review(confirmed)), "confirmed");
  assert.equal(confirmationState(review(confirmed, { dirty: true })), null);
  assert.equal(surfaceStatus(review(confirmed, { status: "running" })).label, "助手正在处理");
  assert.equal(surfaceStatus(review(confirmed, { status: "waiting" })).label, "请在对话中回应");
  assert.equal(surfaceStatus(review(confirmed, {
    status: "failed", error: "部分文件处理失败", results: [{ createdAt: 101 }],
  })).tone, "error");
  assert.equal(surfaceStatus(review(confirmed, { status: "interrupted" })).tone, "warning");
});

test("amounts align for comparison without reformatting precision or numeric-looking identifiers", () => {
  const rows = [
    { name: "样本甲", amount: "100.00 元", quantity: 1, code: "001" },
    { name: "样本乙", amount: "74.50 元", quantity: 2, code: "002" },
  ];
  const original = structuredClone(rows);
  const columns = ["name", "amount", "quantity", "code"].map((key) => ({
    key,
  }));
  assert.deepEqual([...numericColumns(rows, columns)], ["amount", "quantity"]);
  assert.deepEqual(rows, original);
});
