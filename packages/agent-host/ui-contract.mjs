import { z } from "zod";
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((v) => !["constructor", "prototype"].includes(v));
const short = z.string().max(240);
const node = z
  .object({
    id: key,
    type: z.enum([
      "Layout",
      "Text",
      "Field",
      "DataView",
      "Assets",
      "Status",
      "Action",
    ]),
    label: short.optional(),
    binding: key.optional(),
    text: z.string().max(4000).optional(),
    variant: z
      .enum([
        "stack",
        "grid",
        "text",
        "multiline",
        "decimal",
        "integer",
        "select",
        "boolean",
        "table",
        "list",
        "diff",
      ])
      .optional(),
    options: z.array(short).max(100).optional(),
    columns: z
      .array(
        z
          .object({ key, label: short, editable: z.boolean().optional() })
          .strict(),
      )
      .max(12)
      .optional(),
    action: z.enum(["import", "submit", "deliver"]).optional(),
    children: z
      .array(z.lazy(() => node))
      .max(32)
      .optional(),
  })
  .strict();
export const surfaceSchema = z
  .object({
    title: short,
    tree: node,
    data: z.record(key, z.unknown()).default({}),
  })
  .strict();
export function validateSurface(value) {
  if (JSON.stringify(value).length > 120_000)
    throw new Error("交互内容超过 120 KiB 上限，请分页提供。");
  const stack = [[value?.tree, 1]];
  let total = 0;
  while (stack.length) {
    const [n, depth] = stack.pop();
    if (!n || typeof n !== "object" || ++total > 64 || depth > 6)
      throw new Error("组件超过组合上限。");
    if (Array.isArray(n.children))
      for (const c of n.children) stack.push([c, depth + 1]);
  }
  const parsed = surfaceSchema.parse(value),
    ids = new Set();
  let count = 0;
  function check(n, depth) {
    if (++count > 64 || depth > 6 || ids.has(n.id))
      throw new Error("组件重复或超过组合上限。");
    ids.add(n.id);
    if (n.children && n.type !== "Layout")
      throw new Error("只有 Layout 可容纳子组件。");
    if (["Field", "DataView"].includes(n.type) && !n.binding)
      throw new Error("数据组件必须声明绑定字段。");
    if (n.type === "Action" && !n.action)
      throw new Error("动作必须使用注册操作。");
    for (const c of n.children || []) check(c, depth + 1);
  }
  check(parsed.tree, 1);
  return parsed;
}
export function fields(tree) {
  const result = [];
  function visit(n) {
    if (["Field", "DataView"].includes(n.type)) result.push(n);
    for (const c of n.children || []) visit(c);
  }
  visit(tree);
  return result;
}
export function validateDraft(tree, input, data = {}) {
  const output = {},
    definitions = fields(tree);
  for (const [name, value] of Object.entries(input)) {
    const field = definitions.find((f) => f.binding === name);
    if (!field) throw new Error("未知的可编辑字段。");
    if (field.type === "DataView") {
      const old = data[name];
      if (
        !Array.isArray(old) ||
        !Array.isArray(value) ||
        old.length !== value.length ||
        old.length > 500
      )
        throw new Error("表格结构已变化，请重新读取。");
      const editable = new Set(
        (field.columns || []).filter((c) => c.editable).map((c) => c.key),
      );
      for (let i = 0; i < old.length; i++) {
        if (
          !old[i] ||
          typeof old[i] !== "object" ||
          !value[i] ||
          typeof value[i] !== "object" ||
          Array.isArray(value[i]) ||
          JSON.stringify(Object.keys(value[i]).sort()) !==
            JSON.stringify(Object.keys(old[i]).sort())
        )
          throw new Error("不能改变表格行结构。");
        for (const k of Object.keys(old[i]))
          if (
            JSON.stringify(old[i][k]) !== JSON.stringify(value[i][k]) &&
            (!editable.has(k) ||
              typeof value[i][k] !== "string" ||
              value[i][k].length > 4000)
          )
            throw new Error("只能修改已声明的可编辑单元格。");
      }
    } else if (field.variant === "boolean") {
      if (typeof value !== "boolean") throw new Error("勾选值无效。");
    } else {
      if (typeof value !== "string" || value.length > 16000)
        throw new Error("字段值无效或过长。");
      if (
        field.variant === "select" &&
        value &&
        !field.options?.includes(value)
      )
        throw new Error("选项不在允许范围。");
      if (
        value &&
        ["integer", "decimal"].includes(field.variant) &&
        !(field.variant === "integer" ? /^-?\d+$/ : /^-?\d+(\.\d+)?$/).test(
          value,
        )
      )
        throw new Error("请输入有效数字。");
    }
    output[name] = value;
  }
  return output;
}
export const initialSurface = () =>
  validateSurface({
    title: "任务内容",
    data: {},
    tree: { id: "task", type: "Layout", children: [] },
  });
export const uiTool = {
  name: "turnsu_ui",
  _meta: { ui: { resourceUri: "ui://turnsu/intelligence.html" } },
  description:
    "Present task-specific interactive content INLINE IN THE CONVERSATION only when it helps the user review data or answer a question. The user can expand the same content. Do not ask the user to open an Intelligence UI page, repeat their task in another form, or understand component/field/protocol names. Use concise business titles and button labels. Seven atoms: Layout(children,variant stack/grid), Text(text), Field(binding,variant text/multiline/decimal/integer/select/boolean,options), DataView(binding,columns[{key,label}],variant table/list/diff), Assets, Status, Action(action import/submit/deliver). document MUST be {title, tree: rootNode, data: bindingValues}. Stable id per node using letters, digits, underscores or hyphens. No code or permissions. present requires revision from read. After presenting input call wait to receive the human event; pending is not approval. publish verifies project result paths and returns durable artifact receipts. Never report a proposed result as saved.",
  inputSchema: z.toJSONSchema(
    z
      .object({
        operation: z.enum(["read", "present", "wait", "publish"]),
        revision: z.number().int().optional(),
        document: surfaceSchema.optional(),
        paths: z.array(z.string()).max(20).optional(),
        summary: z.string().max(4000).optional(),
      })
      .strict(),
  ),
};
