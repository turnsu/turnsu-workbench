// Read compatibility for saved pages and already-running pre-OpenUI Agents.
// This compiles data to the sole OpenUI renderer; it does not render another UI.
import { z } from "zod";
const key = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/)
  .refine((v) => !["constructor", "prototype"].includes(v));
const short = z.string().max(240);
export const legacyNode = z
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
      .array(z.lazy(() => legacyNode))
      .max(32)
      .optional(),
  })
  .strict();
const legacySurfaceSchema = z
  .object({
    title: short,
    tree: legacyNode,
    data: z.record(key, z.unknown()).default({}),
  })
  .strict();
export function validateLegacySurface(value) {
  const stack = [[value?.tree, 1]];
  let total = 0;
  while (stack.length) {
    const [n, depth] = stack.pop();
    if (!n || typeof n !== "object" || ++total > 64 || depth > 6)
      throw new Error("组件超过组合上限。");
    if (Array.isArray(n.children))
      for (const c of n.children) stack.push([c, depth + 1]);
  }
  const parsed = legacySurfaceSchema.parse(value),
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
    definitions = Array.isArray(tree) ? tree : fields(tree);
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

export const legacyMigrationSchema = z.object({
  version: z.literal(1),
  bindings: z.record(z.string().regex(/^\$v\d+$/), key),
  fields: z.array(legacyNode).max(64),
}).strict();

export function migrateLegacySurface(value) {
  const doc = validateLegacySurface(value);
  const bindings = {}, variables = new Map(), definitions = fields(doc.tree);
  const q = value => JSON.stringify(value);
  const variable = name => {
    if (!variables.has(name)) {
      const id = '$v' + variables.size;
      variables.set(name, id); bindings[id] = name;
    }
    return variables.get(name);
  };
  function compile(n) {
    const bound = n.binding ? variable(n.binding) : null;
    const label = q(n.label || n.binding || '');
    const body = n.text != null ? q(n.text) : (bound ? `"" + ${bound}` : q(''));
    switch (n.type) {
      case 'Layout': {
        const children = (n.children || []).map(compile).join(',');
        const layout = n.variant === 'grid'
          ? `Grid([${children}],${Math.min(4, n.children?.length || 1)},${n.children?.every(c => c.type === 'Status') ? 130 : 240},4)`
          : `Col([${children}],4)`;
        return n.label ? `Col([Label(${label}),${layout}],3)` : layout;
      }
      case 'Text': return n.label ? `Col([Label(${label}),Text(${body})],2)` : `Text(${body})`;
      case 'Status': return `Metric(${label},${body})`;
      case 'Field':
        if (n.variant === 'boolean') return `Checkbox(${bound},${label})`;
        if (n.variant === 'select') return `Select(${bound},${q(n.options || [])},${label},"请选择")`;
        if (n.variant === 'multiline') return `TextArea(${bound},${label},null,4)`;
        return `Input(${bound},${label})`;
      case 'DataView': return `ReviewTable(${bound},${q(n.columns || [])},${q(n.label || '数据')},${q(n.variant || 'table')})`;
      case 'Assets': return `TaskFiles(${q(n.label || '')},${bound || 'null'})`;
      case 'Action': return `Button(${q(n.label || (n.action === 'import' ? '添加文件' : n.action === 'deliver' ? '继续处理' : '确认并继续'))},${n.action === 'import' ? '@ImportFiles()' : n.action === 'deliver' ? '@ContinueTask()' : '@ToAssistant("按确认内容继续")'})`;
    }
  }
  const program = 'root = ' + compile(doc.tree);
  const defaults = [...variables].map(([name, id]) => {
    const field = definitions.find(f => f.binding === name);
    const fallback = field?.type === 'DataView' ? [] : field?.variant === 'boolean' ? false : '';
    return id + ' = ' + q(fallback);
  });
  return { format: 'openui', title: doc.title, program: [program, ...defaults].join('\n'), data: doc.data,
    migration: { version: 1, bindings, fields: definitions } };
}
