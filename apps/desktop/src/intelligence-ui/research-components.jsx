import React from 'react';
import { defineComponent } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { children } from './upstream/components/style';
import './research-components.css';

// These are OpenUI components, not a second renderer. Copy, comparisons and
// dates come from task evidence; presentation never infers a business result.
export const ResearchSummary = defineComponent({
  name: 'ResearchSummary',
  props: z.object({ headline: z.string(), description: z.string().optional(), eyebrow: z.string().optional() }),
  description: 'Lead with the evidenced conclusion, not another document title. Serif headline, optional explanation and amber category. No outer Card is needed inside the workbench.',
  component: ({ props }) => <header className="researchSummary">
    {props.eyebrow && <p className="researchEyebrow">{props.eyebrow}</p>}
    <h2>{props.headline}</h2>
    {props.description && <p className="researchDescription">{props.description}</p>}
  </header>,
});

export const ResearchSection = defineComponent({
  name: 'ResearchSection',
  props: z.object({ title: z.string(), children, description: z.string().optional() }),
  description: 'A compact labeled section with a thin rule, not a nested card. Group original records, adjustments or supporting evidence.',
  component: ({ props, renderNode }) => <section className="researchSection">
    <h3>{props.title}</h3>
    {props.description && <p className="researchDescription">{props.description}</p>}
    <div className="researchSectionBody">{renderNode(props.children)}</div>
  </section>,
});

export const KeyValue = defineComponent({
  name: 'KeyValue',
  props: z.object({ rows: z.array(z.object({ label: z.string(), value: z.union([z.string(), z.number()]) })) }),
  description: 'Quiet label/value rows for task facts, calculation basis and metadata. Preserve exact amounts as strings; do not repeat a table.',
  component: ({ props }) => <dl className="researchFacts">
    {props.rows.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{String(row.value)}</dd></div>)}
  </dl>,
});

export const ResearchNote = defineComponent({
  name: 'ResearchNote',
  props: z.object({ text: z.string(), label: z.string().optional() }),
  description: 'Brief caveat or definition on warm paper with an amber left rule. State missing data and limits plainly; never a success or approval indicator.',
  component: ({ props }) => <aside className="researchNote">{props.label && <strong>{props.label}</strong>}<p>{props.text}</p></aside>,
});

export const Comparison = defineComponent({
  name: 'Comparison',
  props: z.object({ leftTitle: z.string(), leftItems: z.array(z.string()), rightTitle: z.string(), rightItems: z.array(z.string()) }),
  description: 'Two balanced columns for alternatives, supporting evidence and reservations, or before/after notes. Stacks on narrow cards. No invented scores or colored verdicts.',
  component: ({ props }) => <div className="researchComparison">
    {[[props.leftTitle, props.leftItems], [props.rightTitle, props.rightItems]].map(([title, items], index) => <section key={index}>
      <h3>{title}</h3><ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </section>)}
  </div>,
});

export const Sources = defineComponent({
  name: 'Sources',
  props: z.object({ items: z.array(z.object({ label: z.string(), url: z.string().optional() })), updated: z.string().optional() }),
  description: 'Source footer with verified labels, public http(s) URLs and actual data timestamps. Never invent update times. Use TaskFiles to open project files.',
  component: ({ props }) => <footer className="researchSources">
    <span>来源</span>
    {props.items.map((item, index) => /^https?:\/\//i.test(item.url || '') ? <a key={index} href={item.url}>{item.label}</a> : <span key={index}>{item.label}</span>)}
    {props.updated && <span className="researchUpdated">{props.updated}</span>}
  </footer>,
});

export const ActionBar = defineComponent({
  name: 'ActionBar',
  props: z.object({ children, note: z.string().optional() }),
  description: 'Task actions after review content. One primary confirmation and optional secondary actions; the note explains what the action will do.',
  component: ({ props, renderNode }) => <div className="researchActionBar">
    {props.note && <p>{props.note}</p>}
    <div>{renderNode(props.children)}</div>
  </div>,
});
