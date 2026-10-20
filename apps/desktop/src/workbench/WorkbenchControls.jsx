import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ResearchControls.jsx';
import { ChevronDown, CircleAlert, LoaderCircle, Pause, X } from 'lucide-react';

// Disclosure behavior originated in Onevra (MIT; licenses/onevra.txt).
// Rendering uses React and Base UI; no Go or WebAssembly renderer is embedded.
export const ToolbarButton = React.forwardRef(function ToolbarButton({ className = '', children, ...props }, ref) {
  return <Button type="button" ref={ref} className={`toolbarButton ${className}`} {...props}>{children}</Button>;
});

export function Composer({ children }) {
  return <div className="composer workbenchComposer">{children}</div>;
}

export function ComposerAction({ busy, pending, children, ...props }) {
  return <Button type="button" className={`send composerAction ${busy ? 'isStop' : ''}`} {...props}>
    <span>{busy ? '停止' : pending ? '准备中' : '发送'}</span>{children}
  </Button>;
}

export function AttachmentChip({ name, title, detail, icon, onOpen, onRemove, disabled }) {
  return <span className="materialChip workbenchAttachment">
    <Button type="button" className="materialOpen" title={title || name} onClick={onOpen}>
      <span className="materialIcon">{icon}</span><span>{name}</span>{detail && <small>{detail}</small>}
    </Button>
    {onRemove && <Button type="button" className="attachmentRemove" aria-label={`移除材料 ${name}`} disabled={disabled} onClick={onRemove}><X size={12}/></Button>}
  </span>;
}

// Follow Onevra's live/settled disclosure policy. A user's choice, selection or
// focus always wins over an incoming stream update. This never folds prose.
export function ActivityDisclosure({ title, phase = 'settled', completed = false, holdOpen = false, onInteract, anchorId, inert, children }) {
  const element = useRef(null);
  const [choice, setChoice] = useState(null);
  const [automatic, setAutomatic] = useState(phase !== 'settled');
  useEffect(() => {
    const root = element.current;
    const sync = () => {
      if (choice !== null) return;
      if (phase !== 'settled') { setAutomatic(true); return; }
      const selection = root?.ownerDocument.getSelection();
      const selected = selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(root);
      if (!holdOpen && !root?.contains(root.ownerDocument.activeElement) && !selected) setAutomatic(false);
    };
    const afterFocus = () => queueMicrotask(sync);
    sync();
    root?.addEventListener('focusout', afterFocus);
    root?.ownerDocument.addEventListener('selectionchange', sync);
    return () => {
      root?.removeEventListener('focusout', afterFocus);
      root?.ownerDocument.removeEventListener('selectionchange', sync);
    };
  }, [phase, holdOpen, choice]);
  const open = choice ?? automatic;
  const live = ['starting', 'running', 'stopping'].includes(phase);
  const issue = ['failed', 'interrupted'].includes(phase);
  const state = { starting: '正在连接', running: '正在处理', waiting: '等待回应', stopping: '正在停止', failed: '需要处理', interrupted: '已中断' }[phase];
  return <details inert={inert} data-message-id={anchorId} ref={element} className="toolActivityGroup workbenchActivity" open={open} data-phase={phase} onPointerDownCapture={onInteract}>
    <summary title={title} onClick={event => { event.preventDefault(); onInteract?.(); setChoice(!open); }}>
      {live ? <LoaderCircle size={13} className="spin"/> : issue ? <CircleAlert size={13}/> : phase === 'waiting' ? <Pause size={13}/> : <span className="activityDot" data-completed={completed || undefined} aria-hidden="true"/>}
      <span className="activitySummary">{title}</span>{state && <span className="activityPhase">{state}</span>}<ChevronDown size={13}/>
    </summary>
    <div className="toolActivityList">{children}</div>
  </details>;
}
