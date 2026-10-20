import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { library } from './upstream/library.ts';
import { runLibraryAction } from './upstream/actions.ts';
import { configureMedia } from './upstream/host-services.ts';
import { surfaceBridge } from './surface-bridge.mjs';
import { TaskContext } from './task-context';
import { rendererState, taskValues } from './task-state.mjs';
import './intelligence-page.css';

configureMedia((kind, args) => surfaceBridge.invoke('media', { kind, ...args }));

// The upstream Renderer owns evaluation and live variables; the existing
// Turnsu task owns durable drafts, human confirmation, files, and delivery.
export function IntelligencePage({ document, task, onChange, onConfirm, onError }) {
  const disabled = task.disabled;
  const fields = useRef(null);
  const latest = useRef(rendererState(document));
  const dataSignature = JSON.stringify(document.data);
  const page = useRef({ program: document.program, streaming: document.streaming, dataSignature, key: 0 });
  if (page.current.program !== document.program) {
    // A streaming revision grows the same page. A later presentation starts a
    // fresh page; saving a draft or changing theme never remounts its controls.
    if (!page.current.streaming) {
      page.current.key++;
    }
    latest.current = rendererState(document);
    page.current.program = document.program;
  }
  if (page.current.dataSignature !== dataSignature) latest.current = rendererState(document);
  page.current.dataSignature = dataSignature;
  page.current.streaming = document.streaming;
  const [errors, setErrors] = useState([]), [notice, setNotice] = useState('');
  const streaming = document.streaming === true;
  const update = useCallback(values => {
    latest.current = values;
    if (!disabled && !streaming) onChange(taskValues(document, values));
  }, [disabled, streaming, document, onChange]);
  const report = useCallback(list => setErrors(list.filter(error => error.severity !== 'warning')), []);
  const provider = useMemo(() => ({
    task_data: ({ name }) => surfaceBridge.invoke('media', { kind: 'task-data', name }),
  }), []);
  const action = useCallback(async event => {
    if (disabled || streaming) return;
    setNotice('');
    try {
      if (event.type === 'continue_conversation') {
        if (errors.length) throw new Error('页面有未解决的生成错误，请先让助手修正，再确认。');
        const invalid = [...(fields.current?.querySelectorAll('input,select,textarea') || [])].find(input => !input.checkValidity());
        if (invalid) { invalid.reportValidity(); setNotice('请先修正标出的输入，再确认。'); return; }
        const values = { ...latest.current, ...event.formState };
        onChange(taskValues(document, values));
        await onConfirm({ type: 'to-assistant', message: String(event.params?.message || event.humanFriendlyMessage || '').slice(0, 2000), ...(event.params?.context !== undefined ? { context: event.params.context } : {}) });
      } else if (event.type === 'ImportFiles' || event.type === 'ContinueTask') {
        await task.act(event.type === 'ImportFiles' ? 'import' : 'deliver');
      } else if (event.type === 'open_url') {
        await surfaceBridge.openLink(event.params.url);
      } else {
        const work = runLibraryAction(event);
        if (!work) throw new Error('当前页面动作尚未接入。');
        setNotice(await work ? '已复制' : '当前宿主未允许复制，请在页面中选择文字。');
      }
    } catch (error) { onError(error.message); }
  }, [disabled, streaming, errors, document, task, onChange, onConfirm, onError]);
  return <section className="turnsuIntelligencePage" aria-label={document.title} aria-busy={streaming || undefined} onClickCapture={event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    event.preventDefault(); event.stopPropagation();
    surfaceBridge.openLink(link.href).catch(error => onError(error.message));
  }}>
    {streaming && <p role="status">正在生成页面…</p>}
    {errors.length > 0 && <div role="alert" className="error">页面未能完整显示：{errors.map(error => error.message).join('；')}。已保存内容保留，请在原对话让助手修正。</div>}
    <fieldset ref={fields} disabled={disabled || streaming} inert={disabled || streaming ? true : undefined}>
      <TaskContext.Provider value={{ ...task, documentTitle: document.title, disabled: disabled || streaming, confirmation: errors.length ? "invalid" : task.confirmation }}>
      <Renderer key={page.current.key} response={document.program} library={library} initialState={rendererState(document)} isStreaming={streaming} onStateUpdate={update} onAction={action} onError={report} toolProvider={provider}/>
      </TaskContext.Provider>
    </fieldset>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
