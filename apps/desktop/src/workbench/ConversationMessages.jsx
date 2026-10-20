import React, { useState } from 'react';
import { ActivityDisclosure } from './WorkbenchControls.jsx';
import { activityPhase, activitySummary, describeActivity, toolState } from './activity-presentation.mjs';
import { ChevronDown, ChevronRight, FilePenLine, Terminal } from 'lucide-react';

function ToolActivity({ message }) {
  const item = describeActivity(message);
  const state = toolState(message);
  const receipt = message.activity;
  const content = <>{item.file ? <FilePenLine size={15}/> : <Terminal size={15}/>}<span className="activityText"><span className="activityTitle">{item.title}</span>{item.detail && <span className="activityDetail">{item.detail}</span>}</span><span className="toolState" data-state={state.status}>{state.label}</span></>;
  return <article className="message tool" data-slot="message" title={item.text}>
    {item.expandable || receipt ? <details className="toolRecord"><summary>{content}<ChevronRight size={13}/></summary><pre tabIndex={0} aria-label="完整操作记录">{item.text}</pre>{receipt?.output && <pre tabIndex={0} aria-label="工具返回内容">{receipt.output}</pre>}{receipt && <div className="toolReceipt"><span>{receipt.source}</span>{receipt.exitCode !== null && <span>退出码 {receipt.exitCode}</span>}{receipt.startedAt && receipt.endedAt && <span>{((receipt.endedAt - receipt.startedAt) / 1000).toFixed(1)} 秒</span>}</div>}</details> : <div className="activityRow">{content}</div>}
  </article>;
}

function UserMessage({ message, renderReference }) {
  const [expanded, setExpanded] = useState(false);
  const lengthy = message.text.length > 320 || message.text.split('\n').length > 7;
  return <>
    <p className={lengthy && !expanded ? 'requestExcerpt' : undefined}>{message.text}</p>
    {lengthy && <button className="requestExpand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起要求' : '展开完整要求'}<ChevronDown size={13}/></button>}
    {message.references?.map(file => renderReference(file, message))}
  </>;
}

export function ConversationMessages({ messages, agent, status, holdActivityOpen, onActivityInteract, surfaceAnchor, obscured = false, renderMarkdown, renderReference, renderActions }) {
  const nodes = [];
  const latestToolIndex = messages.findLastIndex(message => message.role === 'tool');
  const latestUserIndex = messages.findLastIndex(message => message.role === 'user');
  const latestTool = latestToolIndex > latestUserIndex ? messages[latestToolIndex]?.id : null;
  let assistantNamed = false;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'user') assistantNamed = false;
    if (message.role === 'tool') {
      const tools = [message];
      while (message.id !== surfaceAnchor && i + 1 < messages.length && messages[i + 1].role === 'tool' && tools.at(-1).id !== surfaceAnchor) tools.push(messages[++i]);
      nodes.push(<ActivityDisclosure inert={obscured} key={message.id} anchorId={tools.at(-1).id} title={activitySummary(tools)} phase={activityPhase(status, tools.some(item => item.id === latestTool), tools)} completed={tools.every(item => item.activity?.status === 'completed')} holdOpen={holdActivityOpen} onInteract={onActivityInteract}>{tools.map(item => <ToolActivity key={item.id} message={item}/>)}</ActivityDisclosure>);
      continue;
    }
    const assistantStart = message.role === 'assistant' && !assistantNamed;
    if (message.role === 'assistant') assistantNamed = true;
    nodes.push(<article inert={obscured} key={message.id} data-message-id={message.id} className={`message ${message.role}${assistantStart ? ' responseStart' : ''}`} data-slot="message" data-align={message.role === 'user' ? 'end' : 'start'}>
      {assistantStart && <div className="messageAuthor"><span>{agent}</span></div>}
      {message.role === 'user' ? <UserMessage message={message} renderReference={renderReference}/> : renderMarkdown(message.text)}
      {renderActions(message)}
    </article>);
  }
  return nodes;
}
