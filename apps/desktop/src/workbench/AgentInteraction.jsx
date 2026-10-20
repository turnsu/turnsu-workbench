import React, { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { invoke } from "../platform/desktop-bridge.mjs";
const command = (method, args) => invoke("local_command", { method, args });

export function Interaction({ item, sessionId, report }) {
  const [answers, setAnswers] = useState(() => Object.fromEntries(item.questions.map((q) => [q.id, q.prefill || ""]))); const [saving, setSaving] = useState(false);
  async function respond(decision, optionId) {
    setSaving(true);
    try { await command("interaction.respond", { id: item.id, sessionId, decision, optionId, answers }); }
    catch (error) { report(String(error)); }
    finally { setSaving(false); }
  }
  return <section className="interaction" aria-label={item.title}>
    <strong><ShieldCheck size={16} />{item.title}</strong>
    {item.questions.length ? item.questions.map((q) => <label key={q.id}>{q.question}
      {q.options?.length > 0 && <div className="options">{q.options.map((o) => <button key={o.label} title={o.description} onClick={() => setAnswers((a) => ({ ...a, [q.id]: q.multiSelect ? (Array.isArray(a[q.id]) && a[q.id].includes(o.label) ? a[q.id].filter((v) => v !== o.label) : [...(Array.isArray(a[q.id]) ? a[q.id] : []), o.label]) : o.label }))} aria-pressed={Array.isArray(answers[q.id]) ? answers[q.id].includes(o.label) : answers[q.id] === o.label}>{o.label}</button>)}</div>}
      {q.multiline ? <textarea value={Array.isArray(answers[q.id]) ? answers[q.id].join(", ") : answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} aria-label={q.question} /> : <input type={q.isSecret ? "password" : "text"} value={Array.isArray(answers[q.id]) ? answers[q.id].join(", ") : answers[q.id] || ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="填写回答" />}
    </label>) : item.method==='mcpServer/elicitation/request'?<><p>{item.command}</p><small>仍按当前工作已授权的范围执行。</small><details><summary>查看操作详情</summary><pre>{item.details}</pre></details></>:<pre>{item.command}</pre>}
    <div className="interactionActions">{item.acpChoices?.length > 1 ? <><button disabled={saving} onClick={() => respond('decline')}>取消</button>{item.acpChoices.map(option => <button key={option.id} className="primary" disabled={saving} onClick={() => respond('select', option.id)}>{option.label}</button>)}</> : <>{item.method.startsWith("claude/") && item.questions.length > 0 && <button disabled={saving} onClick={() => respond("decline")}>取消</button>}{item.method.startsWith("pi/") && item.questions.length > 0 && <button disabled={saving} onClick={() => respond("cancel")}>取消</button>}{item.questions.length ? <button className="primary" disabled={saving || item.questions.some((q) => Array.isArray(answers[q.id]) ? !answers[q.id].length : !answers[q.id]?.trim())} onClick={() => respond()}>提交回答</button> : <><button disabled={saving} onClick={() => respond("decline")}>拒绝</button>{item.supportsSessionApproval&&<button disabled={saving} onClick={()=>respond("accept_session")}>本次对话允许</button>}<button className="primary" disabled={saving} onClick={() => respond("accept")}>{item.method === "pi/confirm" ? "确认" : "允许一次"}</button></>}</>}</div>
  </section>;
}
