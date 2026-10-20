import React, { useEffect, useState } from 'react';
import { defineComponent, reactive, useStateField } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { FileText, Plus, ArrowUpRight } from 'lucide-react';
import { Button, Input } from '../shared/ResearchControls.jsx';
import { metricParts } from './surface-presentation.mjs';
import { numericColumns, surfaceAssets } from './surface-state.mjs';
import { useTask } from './task-context';

function ReviewTableView({ node, value, onChange, disabled }) {
  const [page, setPage] = useState(0);
  const rows = Array.isArray(value) ? value : [],
    cols = node.columns || [],
    last = Math.max(0, Math.ceil(rows.length / 40) - 1);
  const numbers = numericColumns(rows, cols);
  useEffect(() => setPage((p) => Math.min(p, last)), [last]);
  const cell = (row, column, index) => column.editable ? (
    <Input
      aria-label={`${node.label || "数据"} 第 ${page * 40 + index + 1} 行 ${column.label}`}
      disabled={disabled}
      value={row[column.key] ?? ""}
      onChange={(event) => onChange(rows.map((item, i) => i === page * 40 + index ? { ...item, [column.key]: event.target.value } : item))}
    />
  ) : String(row[column.key] ?? "");
  const listed = ["list", "diff"].includes(node.variant) && cols.length > 0;
  return (
    <section className="dataView">
      {node.label && <h2>{node.label}</h2>}
      {rows.length ? (
        <>
          {listed ? <div className={`dataRows ${node.variant === "diff" ? "comparisonRows" : ""}`} role="list" aria-label={node.label || "核对数据"}>
            {rows.slice(page * 40, (page + 1) * 40).map((row, index) => <div className="dataRow" role="listitem" key={row.id || page * 40 + index}>
              <div className="dataRowTitle"><span className="dataLabel">{cols[0].label}</span><strong>{cell(row, cols[0], index)}</strong></div>
              <dl>{cols.slice(1).map(column => <div key={column.key} className={numbers.has(column.key) ? "numeric" : undefined}><dt>{column.label}</dt><dd>{cell(row, column, index)}</dd></div>)}</dl>
            </div>)}
          </div> : <div className="tableScroll">
            <table aria-label={node.label || "核对数据"}>
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={numbers.has(c.key) ? "numeric" : undefined}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(page * 40, (page + 1) * 40).map((r, i) => (
                  <tr key={r.id || page * 40 + i}>
                    {cols.length ? (
                      cols.map((c) => (
                        <td
                          key={c.key}
                          className={numbers.has(c.key) ? "numeric" : undefined}
                        >
                          {cell(r, c, i)}
                        </td>
                      ))
                    ) : (
                      <td>
                        {typeof r === "object" ? JSON.stringify(r) : String(r)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {last > 0 && <nav aria-label="核对数据分页">
            <Button disabled={!page} onClick={() => setPage((p) => p - 1)}>
              上一页
            </Button>
            <span>
              {page + 1} / {last + 1} · {rows.length} 项
            </span>
            <Button
              disabled={page >= last}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </nav>}
        </>
      ) : (
        <p className="muted">暂无数据</p>
      )}
    </section>
  );
}

export const ReviewTable = defineComponent({
  name: 'ReviewTable',
  props: z.object({
    rows: reactive(z.array(z.record(z.string(), z.any()))),
    columns: z.array(z.object({ key: z.string(), label: z.string(), editable: z.boolean().optional() })),
    label: z.string().optional(),
    variant: z.enum(['table', 'list', 'diff']).optional(),
  }),
  description: 'Review business rows, 40 per page. Only columns marked editable can be changed; cells preserve exact source strings and row identity. Bind rows to a $variable. Use strings for exact amounts.',
  component: ({ props, statementId }) => {
    const field = useStateField(statementId || props.label || 'rows', props.rows);
    const task = useTask();
    return <ReviewTableView node={props} value={field.value} disabled={task.disabled} onChange={field.setValue}/>;
  },
});

export const Metric = defineComponent({
  name: 'Metric',
  props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]), context: z.string().optional(), change: z.string().optional(), tone: z.enum(['neutral', 'positive', 'negative']).optional() }),
  description: 'Exact business measure, small unit and source context. Include a meaningful calculation basis or comparison as context. Optional change must come from evidence, with +/- sign. Pass formatted strings to preserve monetary precision; never invent trends.',
  component: ({ props }) => {
    const description = String(props.value ?? '');
    const metric = metricParts(description);
    return <section className="statusBlock" data-metric={metric ? 'true' : undefined}>
      {props.label && <h2>{props.label}</h2>}
      <p className="statusDescription">{metric ? <>{metric.number}{metric.unit && <span className="metricUnit">{metric.unit}</span>}</> : description}</p>
      {(props.context || props.change) && <div className="metricContext">{props.change && <span className="metricChange" data-tone={props.tone || 'neutral'}>{props.change}</span>}{props.context && <span>{props.context}</span>}</div>}
    </section>;
  },
});

export const TaskFiles = defineComponent({
  name: 'TaskFiles',
  props: z.object({ label: z.string().optional(), paths: z.array(z.union([z.string(), z.object({ path: z.string() })])).nullable().optional() }),
  description: 'Verified task files. Omit paths to show attached materials and an import button; pass registered project-relative paths to open materials or published results. Unknown paths are visibly disabled.',
  component: ({ props }) => {
    const task = useTask();
    // An explicitly bound result belongs in the review. The automatic result
    // list is rendered once by the workbench, outside this editable page.
    const { bound, files } = surfaceAssets(task.state || {}, props.paths);
    if ((bound && !files.length) || task.state?.readOnly) return null;
    return <section className="assets">
      <div className="sectionTitle"><h2>{props.label || '选定材料'}</h2>
        {!bound && <Button disabled={task.disabled} onClick={() => task.act('import')}><Plus size={15}/>添加文件</Button>}
      </div>
      <ul className="materialNames">{files.map(file => <li key={file.path} className="fileReference">
        <Button aria-label={'打开文件：' + file.path.split('/').at(-1)} disabled={task.busy || (task.state?.readOnly && !task.state?.fileAccess) || file.kind === 'unregistered'} onClick={() => task.openFile(file.path)}>
          <FileText size={18}/><span><strong>{file.path.split('/').at(-1)}</strong><small>{file.kind === 'result' ? '已保存到项目' : file.kind === 'unregistered' ? '尚未登记，无法打开' : '项目材料'}{Number.isFinite(file.bytes) ? ` · ${Math.max(1, Math.ceil(file.bytes / 1024))} KB` : ''}</small></span><ArrowUpRight size={16}/>
        </Button>
      </li>)}</ul>
      {!files.length && <p className="muted">添加本次工作需要的文件，原件会保留。</p>}
    </section>;
  },
});
