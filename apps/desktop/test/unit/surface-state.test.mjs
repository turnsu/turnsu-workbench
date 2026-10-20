import test from "node:test";
import assert from "node:assert/strict";
import { surfaceStatus, numericColumns, confirmationState, surfaceAssets, registeredSurfaceFile } from "../../src/intelligence-ui/surface-state.mjs";

const review = (events = [], extra = {}) => ({
  status: "idle",
  dirty: false,
  presentation: { presented_at: 100 },
  document: { format: "openui", program: 'root = Col([Button("确认", @ToAssistant("继续"))])' },
  events,
  ...extra,
});

test("bound result files use registered receipts instead of input materials or Agent metadata", () => {
  const state = {
    assets: [{ path: "Imported/原件.csv", bytes: 45 }],
    results: [{ files: [{ path: "结果.csv", bytes: 123, sha256: "verified" }] }],
  };
  assert.deepEqual(surfaceAssets(state, ["结果.csv", { path: "结果.csv", bytes: 999 }, "尚未生成.txt"]), {
    bound: true,
    files: [
      { path: "结果.csv", bytes: 123, sha256: "verified", kind: "result" },
      { path: "尚未生成.txt", kind: "unregistered" },
    ],
  });
  for (const value of [undefined, []])
    assert.deepEqual(surfaceAssets(state, value), {
      bound: false, files: [{ path: "Imported/原件.csv", bytes: 45, kind: "material" }],
    });
  assert.equal(registeredSurfaceFile(state, "../其他项目/隐私.txt"), null);
  assert.equal(registeredSurfaceFile(state, "/tmp/unregistered.txt"), null);
  assert.equal(registeredSurfaceFile(state, { path: "结果.csv" }), null);
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
  const document = { format: "openui", program: 'root = Col([Text("核对完成")])' };
  assert.deepEqual(surfaceStatus(review([], { document })), {
    label: "", tone: "neutral",
  });
  assert.equal(surfaceStatus(review([], {
    document, results: [{ createdAt: 101, files: [{ path: "说明.txt" }] }],
  })).label, "成果可查看");
  assert.equal(surfaceStatus(review([], {
    document, results: [{ createdAt: 99, files: [{ path: "旧结果.txt" }] }],
  })).label, "");
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

test("an ended Agent keeps confirmation distinct from a returned result", () => {
  const value = review([{ id: "confirmed-review", created_at: 101, state: "consumed" }], {
    continuation: { requestId: "confirmed-review" },
  });
  assert.equal(confirmationState(value), "confirmed");
  assert.deepEqual(surfaceStatus(value), {
    label: "本轮已结束，尚未返回文件成果；确认内容已保留", tone: "warning",
  });
  assert.equal(surfaceStatus({ ...value, status: "running" }).label, "助手正在处理");
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
import { canRebaseSurfaceEdits } from '../../src/intelligence-ui/surface-state.mjs';

test('a new presentation anchor can accept an edit when the question and source value are unchanged', () => {
  const previous = { sessionId: 'a', revision: 2, document: { title: '核对用途', format: 'openui', program: 'root = Input($note,"报告用途")', data: { note: '', total: 174.5 } } };
  const next = structuredClone(previous); next.revision = 3;
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), true);
  next.document.data.total = 175;
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), false, 'a changed total can change the meaning of an answer and requires review');
  next.document.data.total = 174.5;
  next.document.data.note = '财务审核';
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), false, 'a remote edit to the same field must never be silently overwritten');
  next.document.data.note = ''; next.document.program = 'root = Input($note,"发送给谁")';
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), false, 'matching bindings are insufficient when the question changes');
  next.document.program = previous.document.program; next.readOnly = true;
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), false);
  next.readOnly = false; next.sessionId = 'b';
  assert.equal(canRebaseSurfaceEdits(previous, next, { note: '周会' }), false);
});
