import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Check, CircleAlert, FileText, Hand, LoaderCircle, Maximize2, Minus, MoreHorizontal, Plus, ScanLine, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { inputSourceOptions } from "../../state/editor/workflowDraftActions.js";
import { GRAPH_NODE_WIDTH, graphNodeHeight, workflowGraphBounds, workflowGraphLayout } from "./workflowGraphLayout.js";

export const nodeIcon = (kind) => ({ Input: ArrowDownToLine, Output: ArrowUpFromLine, Skill: Sparkles, ReviewGate: ShieldCheck, Material: FileText }[kind] || Sparkles);
export const nodeKindLabel = (kind, zh) => ({ Input: zh ? "输入" : "Input", Output: zh ? "结果" : "Output", Skill: zh ? "技能" : "Skill", ReviewGate: zh ? "人工复核" : "Review", Material: zh ? "资料" : "Material" }[kind] || kind);

export function WorkflowGraphCanvas({ graph, selectedNodeId, onSelect, onMove, onBind, onArrange, onAdd, readOnly, locale, nodeStatuses = {} }) {
  const zh = locale?.startsWith("zh");
  const root = useRef(null);
  const gesture = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const previousSize = useRef(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const [preview, setPreview] = useState(null);
  const [connection, setConnection] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [notice, setNotice] = useState("");
  const [layoutVersion, setLayoutVersion] = useState(0);
  const fallback = useMemo(() => workflowGraphLayout(graph), [graph]);
  const positions = Object.fromEntries(graph.nodes.map((node) => [node.nodeId,
    preview?.nodeId === node.nodeId ? preview.position :
      Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y) ? node.position : fallback[node.nodeId]]));
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const edge = graph.edges.find((item) => item.edgeId === selectedEdge);
  const identity = graph.nodes.map((node) => node.nodeId).join(":");

  function fit() {
    if (!size.width || !size.height) return;
    const bounds = workflowGraphBounds(graph.nodes, positions);
    const scale = Math.max(.25, Math.min(1, (size.width - 112) / bounds.width, (size.height - 150) / bounds.height));
    setCamera({ scale, x: (size.width - bounds.width * scale) / 2 - bounds.x * scale,
      y: (size.height - bounds.height * scale) / 2 - bounds.y * scale - 16 });
  }
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const previous = previousSize.current;
    previousSize.current = size;
    if (!size.width || !size.height) return;
    if (selectedNodeId && positions[selectedNodeId]) {
      const position = positions[selectedNodeId];
      const scale = Math.max(.85, camera.scale);
      setCamera({ scale, x: size.width / 2 - (position.x + GRAPH_NODE_WIDTH / 2) * scale,
        y: size.height / 2 - (position.y + graphNodeHeight(nodes.get(selectedNodeId)) / 2) * scale - 16 });
    } else if (previous?.width && previous?.height) {
      setCamera((old) => ({ ...old, x: old.x + (size.width - previous.width) / 2,
        y: old.y + (size.height - previous.height) / 2 }));
    } else fit();
  }, [size.width, size.height, selectedNodeId]);
  useEffect(() => { if (!selectedNodeId) fit(); }, [identity, layoutVersion]);
  useEffect(() => {
    if (connection && !nodes.has(connection.nodeId)) setConnection(null);
    if (selectedEdge && !edge) setSelectedEdge(null);
  }, [graph]);

  function zoom(next) {
    const scale = Math.min(1.6, Math.max(.25, next));
    setCamera((old) => ({ scale, x: size.width / 2 - (size.width / 2 - old.x) * scale / old.scale,
      y: size.height / 2 - (size.height / 2 - old.y) * scale / old.scale }));
  }
  function start(event, node) {
    if (event.button !== 0 || (node && readOnly)) return;
    if (!node && event.target.closest('button, [data-node-id], [data-edge-id]')) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, nodeId: node?.nodeId,
      position: node ? positions[node.nodeId] : camera, moved: false };
  }
  function move(event) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    active.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
    if (active.nodeId) {
      const position = { x: Math.max(0, Math.round(active.position.x + dx / camera.scale)),
        y: Math.max(0, Math.round(active.position.y + dy / camera.scale)) };
      active.next = position;
      setPreview({ nodeId: active.nodeId, position });
    } else setCamera({ ...camera, x: active.position.x + dx, y: active.position.y + dy });
  }
  function end(event) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.nodeId) {
      if (active.moved && active.next) onMove(active.nodeId, active.next);
      else onSelect(active.nodeId);
    } else if (!active.moved) { setConnection(null); setSelectedEdge(null); onSelect(null); }
    gesture.current = null;
    setPreview(null);
  }
  function target(nodeId, portId) {
    if (!connection) { onSelect(nodeId); return; }
    const valid = inputSourceOptions(graph, nodeId, portId).some((option) => option.nodeId === connection.nodeId && option.portId === connection.portId);
    if (!valid) { setNotice(zh ? "不能连接这里：请选择类型相同、且不会形成循环的输入。" : "Choose a compatible input without creating a cycle."); return; }
    onBind(nodeId, portId, connection);
    setConnection(null); setNotice("");
  }
  function anchor(node, portId, output) {
    const ports = output ? node.outputPorts : node.inputPorts;
    const index = Math.max(0, ports.findIndex((port) => port.portId === portId));
    return { x: positions[node.nodeId].x + (output ? GRAPH_NODE_WIDTH : 0), y: positions[node.nodeId].y + 80 + index * 24 };
  }
  function path(from, to) {
    const bend = Math.max(60, Math.abs(to.x - from.x) * .5);
    return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  }

  return <div className="studioGraph" ref={root} role="region" aria-label={zh ? "工作流画布" : "Workflow canvas"} tabIndex={0}
    data-testid="loopops.builder.canvas" onPointerDown={(event) => start(event)} onPointerMove={move} onPointerUp={end}
    onPointerCancel={() => { gesture.current = null; setPreview(null); }}
    onKeyDown={(event) => { if (event.key === "Escape") { setConnection(null); setSelectedEdge(null); setNotice(""); } }}>
    <div className="studioGraphWorld" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
      <svg className="studioWires">
        {graph.edges.map((item) => {
          const from = nodes.get(item.sourceNodeId), to = nodes.get(item.targetNodeId);
          if (!from || !to) return null;
          const curve = path(anchor(from, item.sourcePort, true), anchor(to, item.targetPort, false));
          return <g key={item.edgeId} data-edge-id={item.edgeId} className={item.edgeId === selectedEdge ? "selected" : ""}>
            <path className="studioWire" d={curve} />
            <path className="studioWireHit" d={curve} role="button" tabIndex={0} aria-label={`${zh ? "连接" : "Connection"}: ${from.title} → ${to.title}`}
              onClick={() => { setSelectedEdge(item.edgeId); setConnection(null); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedEdge(item.edgeId); } }} />
          </g>;
        })}
      </svg>
      {graph.nodes.map((node) => {
        const Icon = nodeIcon(node.kind);
        const missing = node.inputPorts.some((port) => port.required && !node.inputBindings.some((binding) => binding.targetPort === port.portId));
        const status = nodeStatuses[node.nodeId];
        return <article key={node.nodeId} data-node-id={node.nodeId} className={`studioNode kind-${node.kind} ${selectedNodeId === node.nodeId ? "selected" : ""} ${missing ? "incomplete" : ""}`}
          style={{ left: positions[node.nodeId].x, top: positions[node.nodeId].y, width: GRAPH_NODE_WIDTH, height: graphNodeHeight(node) }}>
          <button className="studioNodeHeader" type="button" aria-label={`${zh ? "编辑步骤" : "Edit step"}: ${node.title}`}
            onPointerDown={(event) => start(event, node)} onPointerMove={move} onPointerUp={end}
            onClick={(event) => { if (event.detail === 0 || readOnly) onSelect(node.nodeId); }}
            onKeyDown={(event) => {
              if (!readOnly && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) {
                event.preventDefault(); const position = positions[node.nodeId];
                onMove(node.nodeId, { x: Math.max(0, position.x + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0)), y: Math.max(0, position.y + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0)) });
              }
            }}>
            <span className="studioNodeIcon"><Icon size={16} /></span><span><small>{nodeKindLabel(node.kind, zh)}</small><strong>{node.title}</strong></span>
            {status === "completed" ? <Check size={15} className="studioNodeDone" /> : status === "failed" ? <CircleAlert size={15} className="studioNodeFailed" aria-label={zh ? "执行失败" : "Run failed"} /> : status === "running" ? <LoaderCircle size={15} className="studioSpinner" aria-label={zh ? "正在执行" : "Running"} /> : null}
          </button>
          <div className="studioNodePorts">
            <div>{node.inputPorts.map((port) => <button type="button" key={port.portId} disabled={readOnly} className={`studioPort input ${connection ? "target" : ""}`} onClick={() => target(node.nodeId, port.portId)} aria-label={`${zh ? "连接到" : "Connect to"} ${node.title} · ${port.name}`}><i /><span>{port.name}</span></button>)}</div>
            <div>{node.outputPorts.map((port) => <button type="button" key={port.portId} disabled={readOnly} className={`studioPort output ${connection?.nodeId === node.nodeId && connection?.portId === port.portId ? "active" : ""}`} onClick={() => { setConnection({ nodeId: node.nodeId, portId: port.portId }); setSelectedEdge(null); setNotice(""); }} aria-label={`${zh ? "从" : "Connect from"} ${node.title} · ${port.name} ${zh ? "连接" : ""}`}><span>{port.name}</span><i /></button>)}</div>
          </div>
          <div className="studioNodeFoot">{missing ? <span className="studioMissing">{zh ? "待连接输入" : "Input needed"}</span> : <span>{node.kind === "Input" ? zh ? "运行时填写" : "Run input" : node.reviewPolicy.mode === "required" ? zh ? "需要人工复核" : "Human review" : node.kind === "Output" ? zh ? "工作流最终结果" : "Workflow result" : zh ? "已连接" : "Connected"}</span>}<button type="button" onClick={() => onSelect(node.nodeId)} aria-label={`${zh ? "配置" : "Configure"} ${node.title}`}><MoreHorizontal size={14} /></button></div>
        </article>;
      })}
    </div>
    {!graph.nodes.length ? <div className="studioEmpty"><ScanLine size={28} /><h2>{zh ? "从第一个步骤开始" : "Start with a step"}</h2><p>{zh ? "添加输入、技能或结果，然后连接它们。" : "Add inputs, skills and outputs, then connect them."}</p><button type="button" disabled={readOnly} onClick={onAdd}><Plus size={16} />{zh ? "添加步骤" : "Add step"}</button></div> : null}
    {(connection || notice || edge) ? <div className="studioCanvasMessage" role="status">
      <span>{notice || (edge ? `${nodes.get(edge.sourceNodeId)?.title} → ${nodes.get(edge.targetNodeId)?.title}` : zh ? "点击目标输入端口完成连接 · Esc 取消" : "Choose an input port · Esc to cancel")}</span>
      {edge && !readOnly ? <button type="button" onClick={() => { onBind(edge.targetNodeId, edge.targetPort, null); setSelectedEdge(null); }}><Trash2 size={14} />{zh ? "移除连接" : "Remove connection"}</button> : null}
      <button type="button" aria-label={zh ? "关闭连接提示" : "Dismiss connection message"} onClick={() => { setConnection(null); setSelectedEdge(null); setNotice(""); }}><X size={14} /></button>
    </div> : null}
    <div className="studioCanvasTools" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" title={zh ? "自动整理位置，不改变执行关系" : "Arrange positions without changing dependencies"} disabled={readOnly} onClick={() => { onArrange(workflowGraphLayout(graph)); setLayoutVersion((value) => value + 1); }}><ScanLine size={15} /><span>{zh ? "整理" : "Arrange"}</span></button>
      <span className="studioToolDivider" /><button type="button" aria-label={zh ? "缩小" : "Zoom out"} onClick={() => zoom(camera.scale - .1)}><Minus size={15} /></button><span className="studioZoom">{Math.round(camera.scale * 100)}%</span><button type="button" aria-label={zh ? "放大" : "Zoom in"} onClick={() => zoom(camera.scale + .1)}><Plus size={15} /></button><button type="button" aria-label={zh ? "适配视图" : "Fit view"} onClick={fit}><Maximize2 size={15} /></button>
    </div>
    <p className="studioCanvasHint"><Hand size={13} />{zh ? "拖动空白处平移 · 点击端口连接" : "Drag canvas to pan · Click ports to connect"}</p>
  </div>;
}
