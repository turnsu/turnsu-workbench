import { z } from "zod";
import { migrateLegacySurface, legacyMigrationSchema, validateDraft } from './legacy.mjs';
export { fields, validateDraft } from './legacy.mjs';
export const uiLibraryResource = 'turnsu://ui/library';
const short = z.string().max(240);
const surfaceLimit = 120_000, migratedSurfaceLimit = surfaceLimit * 4;
const openuiStateKey = z.string().min(1).max(128).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
const openuiSurfaceSchema = z.object({
  format: z.literal('openui'), title: short,
  program: z.string().min(1).max(96_000),
  data: z.record(openuiStateKey, z.unknown()).default({}),
  streaming: z.boolean().optional(),
}).strict();
export const surfaceSchema = openuiSurfaceSchema;
const storedSurfaceSchema = openuiSurfaceSchema.extend({
  // Historical forms can expand when their read-only constraints and OpenUI
  // program are both retained. New Agent pages keep the smaller public limit.
  program: z.string().min(1).max(migratedSurfaceLimit), migration: legacyMigrationSchema,
});
function safeOpenUIState(input) {
  let count = 0;
  function check(value, depth = 0) {
    if (++count > 12000 || depth > 16) throw new Error('页面变量超过保存上限。');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object') throw new Error('页面变量必须为有限 JSON 值。');
    for (const [name, item] of Object.entries(value)) {
      if (!Array.isArray(value)) openuiStateKey.parse(name);
      check(item, depth + 1);
    }
  }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('页面变量必须为对象。');
  if (JSON.stringify(input).length > 120_000) throw new Error('页面变量超过保存上限。');
  check(input);
  return input;
}

export function validateSurface(value, { stored = false } = {}) {
  const migrated = stored && value?.migration;
  const limit = migrated ? migratedSurfaceLimit : surfaceLimit;
  if (JSON.stringify(value).length > limit) throw new Error(`交互内容超过 ${limit} 字符上限，请分页提供。`);
  // Cached Agents can finish their in-flight task, but the advertised schema
  // and every saved/rendered page use OpenUI. No old renderer remains.
  if (value?.format !== 'openui') return migrateLegacySurface(value);
  const parsed = (migrated ? storedSurfaceSchema : openuiSurfaceSchema).parse(value);
  safeOpenUIState(parsed.data);
  return parsed;
}
export function validateSurfaceDraft(document, input) {
  return document.migration
    ? validateDraft(document.migration.fields, input, document.data)
    : safeOpenUIState(input);
}
export const initialSurface = () => ({ format: 'openui', title: '任务内容', program: 'root = Col([])', data: {} });
export const uiTool = {
  name: "turnsu_ui",
  _meta: { ui: { resourceUri: "ui://turnsu/intelligence.html" } },
  description:
    'Present a task-specific working page INLINE in the current conversation. Primary format: document={format:"openui",title,program,data:{"$quantity":2},streaming?:boolean}. program uses OpenUI Lang and the copied open-intelligent-ui library: layouts, inputs, tables, charts, images, maps, SVG, sandboxed HtmlView, local @functions, $variables and @Set. Syntax example: root = Col([Input($quantity,"数量","number"),Text("当前数量：" + $quantity),Button("确认并继续",@ToAssistant("按确认数量继续",{quantity:$quantity}))])\n$quantity = 2. Use the actual task sources and user-defined calculation basis; examples are not business data. Use ResearchSummary for the evidence-based conclusion, Metric with context, ResearchSection for evidence and ActionBar for confirmation. The host displays document.title, so do not repeat it inside the page. Read turnsu://ui/library for exact signatures; do not invent components. Read files with authorized tools, then put verified rows in document.data and bind them directly (for example $rows). Query("task_data",{name:"orders"},{value:[]}) only reads the existing document.data.orders key; it cannot read a file path. TaskFiles only opens paths already registered in read.assets or read.results. @Set is local UI state, never a business write. @ToAssistant fixes a real human confirmation and returns to the original Agent. The host owns conversation and execution; no second chat or model gateway. Inputs and confirmation are persisted with the task. present uses the current revision; wait reads the actual human event, pending is not approval. A saved present result is not proof of rendering. Actual files still require document tools and verified publication.',

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
