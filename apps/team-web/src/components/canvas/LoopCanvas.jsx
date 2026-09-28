import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus, Trash2, X } from "lucide-react";
import { IconButton } from "../../design-system/index.jsx";
import { StatusPill } from "../shared/StatusPill.jsx";
import { countFlowGramLinks, createFlowGramDocument, getFlowGramStatus } from "./flowgramAdapter.js";

const NODE_WIDTH = 140;
const NODE_HEIGHT = 268;
const CANVAS_PADDING = 60;

function firstValue(value = []) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function flowLabel(inputs = [], outputs = [], t) {
  return t("builder.resourceFlow", {
    input: firstValue(inputs) || "-",
    output: firstValue(outputs) || "-",
  });
}

function defaultPosition(node, index, skillIndex = 0) {
  const type = String(node?.type || "").toLowerCase();

  if (type === "input" || type === "start") return { x: 16 + Math.min(index, 4) * 164, y: 382 };
  if (type === "output" || type === "result") return { x: 672, y: 82 };
  if (type.includes("review") || type.includes("gate")) return { x: 508, y: 82 };
  if (type === "skill" || type === "transform" || type === "material") {
    return { x: 16 + (skillIndex % 4) * 164, y: 82 + Math.floor(skillIndex / 4) * 300 };
  }

  return { x: 16 + (index % 5) * 164, y: 82 + Math.floor(index / 5) * 300 };
}

function lanePosition(index) {
  return {
    x: 16 + (index % 5) * 164,
    y: 82 + Math.floor(index / 5) * 300,
  };
}

function laneScore(node) {
  const type = String(node?.type || "").toLowerCase();
  if (type === "input" || type === "start") return 0;
  if (type === "skill" || type === "transform" || type === "material") return 1;
  if (type.includes("review") || type.includes("gate")) return 2;
  if (type === "output" || type === "result") return 3;
  return 1;
}

function clampPosition(position, width, height) {
  return {
    x: Math.max(24, Math.min(position.x, width - NODE_WIDTH - 24)),
    y: Math.max(24, Math.min(position.y, height - NODE_HEIGHT - 24)),
  };
}

function edgePath(from, to) {
  const startX = from.position.x + NODE_WIDTH;
  const startY = from.position.y + NODE_HEIGHT / 2;
  const endX = to.position.x;
  const endY = to.position.y + NODE_HEIGHT / 2;
  const turn = Math.max(96, Math.abs(endX - startX) * 0.5);

  if (endX <= startX) {
    const loopX = Math.max(startX, endX) + 120;
    return `M ${startX} ${startY} C ${loopX} ${startY}, ${loopX} ${endY}, ${endX} ${endY}`;
  }

  return `M ${startX} ${startY} C ${startX + turn} ${startY}, ${endX - turn} ${endY}, ${endX} ${endY}`;
}

function temporaryEdgePath(from, point) {
  const startX = from.position.x + NODE_WIDTH;
  const startY = from.position.y + NODE_HEIGHT / 2;
  const turn = Math.max(80, Math.abs(point.x - startX) * 0.45);
  return `M ${startX} ${startY} C ${startX + turn} ${startY}, ${point.x - turn} ${point.y}, ${point.x} ${point.y}`;
}

function resourceFromDrag(event) {
  const raw = event.dataTransfer.getData("application/x-loopops-resource");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasLoopResource(event) {
  const types = Array.from(event.dataTransfer?.types || []);
  return types.includes("application/x-loopops-resource") || types.includes("text/plain");
}

function nodeTypeLabel(type, t) {
  const key = String(type || "").toLowerCase().replace(/\s+/g, "-");
  return t(`nodeType.${key}`);
}

function nodeNeedsConnectionSetup(node) {
  const type = String(node?.type || "").toLowerCase();
  if (!["skill", "transform", "material"].includes(type)) return false;
  return !firstValue(node?.inputs) || !firstValue(node?.outputs);
}

export function LoopCanvas({
  t = (key) => key,
  nodes,
  edges,
  selectedNodeId,
  paletteItems,
  connectionStartNodeId,
  onNodeSelect,
  onNodeMove,
  onConnect,
  onConnectionStart,
  onConnectionCancel,
  onDropResource,
  onDeleteNode,
  onViewportChange,
  readOnly = false,
}) {
  const canvasRef = useRef(null);
  const [dragState, setDragState] = useState(null);
  const [dragPreview, setDragPreview] = useState(null);
  const [isDropActive, setIsDropActive] = useState(false);
  const [scale, setScale] = useState(1);
  const [connectStart, setConnectStart] = useState("");
  const [connectPointer, setConnectPointer] = useState(null);
  const [connectionError, setConnectionError] = useState(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [flowgramStatus, setFlowgramStatus] = useState({ status: "checking" });

  useEffect(() => {
    let mounted = true;
    getFlowGramStatus().then((status) => {
      if (mounted) setFlowgramStatus(status);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const graphNodes = useMemo(() => {
    const positions = nodes.map((node) => node.position ? `${Math.round(node.position.x)}:${Math.round(node.position.y)}` : "unset");
    const needsInitialLayout = new Set(positions).size !== positions.length;
    const laneOrder = new Map(
      [...nodes]
        .map((node, index) => ({ node, index }))
        .sort((left, right) => laneScore(left.node) - laneScore(right.node) || left.index - right.index)
        .map((item, index) => [item.node.id, index]),
    );
    let skillIndex = 0;
    return nodes.map((node, index) => {
      const nodeSkillIndex = skillIndex;
      if (["skill", "transform", "material"].includes(String(node.type || "").toLowerCase())) skillIndex += 1;
      return {
        ...node,
        position: dragPreview?.nodeId === node.id
          ? dragPreview.position
          : needsInitialLayout ? lanePosition(laneOrder.get(node.id) ?? index) : node.position || defaultPosition(node, index, nodeSkillIndex),
      };
    });
  }, [nodes, dragPreview]);
  const graphNodeById = useMemo(() => new Map(graphNodes.map((node) => [node.id, node])), [graphNodes]);
  const graphEdges = edges.filter((edge) => graphNodeById.has(edge.from) && graphNodeById.has(edge.to));
  const flowgramDocument = useMemo(
    () => createFlowGramDocument({ nodes: graphNodes, edges: graphEdges }),
    [graphNodes, graphEdges],
  );
  const canvasWidth = Math.max(872, ...graphNodes.map((node) => node.position.x + NODE_WIDTH + CANVAS_PADDING));
  const canvasHeight = Math.max(690, ...graphNodes.map((node) => node.position.y + NODE_HEIGHT + CANVAS_PADDING));
  const activeConnectionId = connectStart || connectionStartNodeId;
  const activeConnectionNode = activeConnectionId ? graphNodeById.get(activeConnectionId) : null;
  const minimapWidth = 132;
  const minimapHeight = 82;
  const miniScaleX = minimapWidth / canvasWidth;
  const miniScaleY = minimapHeight / canvasHeight;

  useEffect(() => {
    if (!selectedNodeId || !canvasRef.current) return;
    const selectedNode = graphNodeById.get(selectedNodeId);
    if (!selectedNode) return;
    const viewport = canvasRef.current;
    const targetLeft = Math.max(0, selectedNode.position.x * scale - viewport.clientWidth / 2 + (NODE_WIDTH * scale) / 2);
    const targetTop = Math.max(0, selectedNode.position.y * scale - viewport.clientHeight / 2 + (NODE_HEIGHT * scale) / 2);
    viewport.scrollTo({ left: targetLeft, top: targetTop, behavior: "smooth" });
  }, [selectedNodeId, graphNodeById, scale]);

  useEffect(() => {
    updateViewport();
  }, [canvasWidth, canvasHeight, scale]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || typeof window === "undefined") return undefined;

    const fitMobileViewport = () => {
      if (!window.matchMedia("(max-width: 820px)").matches) return;
      const availableWidth = Math.max(280, element.clientWidth - 24);
      const nextScale = Math.min(0.72, Math.max(0.65, availableWidth / canvasWidth));
      setScale(nextScale);
      element.scrollTo({ top: 0, left: 0, behavior: "auto" });
    };

    fitMobileViewport();
    const observer = new ResizeObserver(fitMobileViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasWidth]);

  function updateViewport() {
    const element = canvasRef.current;
    if (!element) return;
    setViewport({
      left: element.scrollLeft / scale,
      top: element.scrollTop / scale,
      width: element.clientWidth / scale,
      height: element.clientHeight / scale,
    });
  }

  function setZoom(nextScale) {
    const bounded = Math.min(1.35, Math.max(0.65, nextScale));
    setScale(bounded);
    onViewportChange?.({ scale: bounded });
  }

  function fitView() {
    const element = canvasRef.current;
    if (element) {
      const widthScale = Math.max(0.65, (element.clientWidth - 24) / canvasWidth);
      const heightScale = Math.max(0.65, (element.clientHeight - 24) / canvasHeight);
      setZoom(Math.min(1, widthScale, heightScale));
      element.scrollTo({ top: 0, left: 0, behavior: "smooth" });
      setTimeout(updateViewport, 220);
    }
  }

  function scrollCanvasTo(position, behavior = "smooth") {
    if (!canvasRef.current) return;
    canvasRef.current.scrollTo({
      left: Math.max(0, position.x * scale - canvasRef.current.clientWidth / 2),
      top: Math.max(0, position.y * scale - canvasRef.current.clientHeight / 2),
      behavior,
    });
    setTimeout(updateViewport, 220);
  }

  function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    setIsDropActive(false);
    const payload = resourceFromDrag(event);
    if (!payload || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const position = clampPosition(
      {
        x: (event.clientX - rect.left + canvasRef.current.scrollLeft) / scale - NODE_WIDTH / 2,
        y: (event.clientY - rect.top + canvasRef.current.scrollTop) / scale - NODE_HEIGHT / 2,
      },
      canvasWidth,
      canvasHeight,
    );
    onDropResource(payload, position);
  }

  function beginNodeDrag(event, node) {
    if (readOnly) {
      onNodeSelect(node.id);
      return;
    }
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragState({
      nodeId: node.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: node.position,
    });
    onNodeSelect(node.id);
  }

  function moveNodeDrag(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const next = clampPosition(
      {
        x: dragState.base.x + (event.clientX - dragState.startX) / scale,
        y: dragState.base.y + (event.clientY - dragState.startY) / scale,
      },
      canvasWidth,
      canvasHeight,
    );
    setDragPreview({ nodeId: dragState.nodeId, position: next });
  }

  function endNodeDrag(event) {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const finalPosition = dragPreview?.nodeId === dragState.nodeId ? dragPreview.position : dragState.base;
    onNodeMove(dragState.nodeId, finalPosition);
    setDragState(null);
    setDragPreview(null);
  }

  function startConnection(nodeId) {
    if (readOnly) return;
    setConnectStart(nodeId);
    setConnectionError(null);
    onConnectionStart?.(nodeId);
    onNodeSelect(nodeId);
  }

  function cancelConnection() {
    setConnectStart("");
    setConnectPointer(null);
    setConnectionError(null);
    onConnectionCancel?.();
  }

  function completeConnection(nodeId) {
    if (readOnly) {
      onNodeSelect(nodeId);
      return;
    }
    const fromNodeId = connectStart || connectionStartNodeId;
    if (!fromNodeId) {
      onNodeSelect(nodeId);
      return;
    }
    if (fromNodeId === nodeId) {
      setConnectionError({ nodeId, message: t("builder.selfConnectionInline") });
      onConnect(fromNodeId, nodeId);
      setConnectStart("");
      setConnectPointer(null);
      return;
    }
    onConnect(fromNodeId, nodeId);
    setConnectStart("");
    setConnectPointer(null);
    setConnectionError(null);
  }

  function handleCanvasKeyDown(event) {
    if (event.key === "Escape" && activeConnectionId) {
      event.preventDefault();
      cancelConnection();
      return;
    }
    if (!readOnly && (event.key === "Delete" || event.key === "Backspace") && selectedNodeId) {
      event.preventDefault();
      onDeleteNode(selectedNodeId);
    }
  }

  function updateConnectionPointer(event) {
    if (!activeConnectionId || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setConnectPointer({
      x: (event.clientX - rect.left + canvasRef.current.scrollLeft) / scale,
      y: (event.clientY - rect.top + canvasRef.current.scrollTop) / scale,
    });
  }

  function handleMinimapPointer(event) {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvasWidth;
    const y = ((event.clientY - rect.top) / rect.height) * canvasHeight;
    scrollCanvasTo({ x, y }, "auto");
  }

  return (
    <section
      className={`loopCanvas ${isDropActive ? "dropActive" : ""}`}
      data-testid="loopops.builder.canvas"
      data-flowgram-adapter={flowgramStatus.status}
      data-flowgram-node-count={flowgramDocument.nodes.length}
      data-flowgram-edge-count={countFlowGramLinks(flowgramDocument)}
      data-palette-count={paletteItems.length}
      tabIndex={0}
      aria-label={t("builder.canvasAria")}
      onKeyDown={handleCanvasKeyDown}
    >
      <header className="canvasCommandBar">
        <div className="canvasCommandGroup">
          <span>{t("builder.canvasLabel")}</span>
          <StatusPill tone="info">{t("builder.nodes", { count: graphNodes.length })}</StatusPill>
          <StatusPill>{t("builder.edges", { count: graphEdges.length })}</StatusPill>
        </div>
        <div className="canvasCommandGroup">
          <IconButton label={t("builder.zoomOut")} icon={<Minus size={15} />} onClick={() => setZoom(scale - 0.1)} />
          <span className="zoomValue">{Math.round(scale * 100)}%</span>
          <IconButton label={t("builder.zoomIn")} icon={<Plus size={15} />} onClick={() => setZoom(scale + 0.1)} />
          <IconButton
            label={t("builder.fitView")}
            icon={<Maximize2 size={15} />}
            onClick={fitView}
            data-testid="loopops.builder.canvas.fit"
          />
        </div>
      </header>

      <div
        className="canvasViewport"
        ref={canvasRef}
        data-drop-active={isDropActive ? "true" : "false"}
        onScroll={updateViewport}
        onPointerMove={updateConnectionPointer}
        onDragEnter={(event) => {
          if (!hasLoopResource(event)) return;
          event.preventDefault();
          setIsDropActive(true);
        }}
        onDragOver={(event) => {
          if (!hasLoopResource(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setIsDropActive(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          setIsDropActive(false);
        }}
        onDrop={handleDrop}
      >
        <div className="canvasDropHint" data-testid="loopops.builder.canvas-drop-hint">
          {isDropActive ? t("builder.dropToAddNode") : t("builder.canvasDropHint")}
        </div>
        {activeConnectionId ? (
          <div className="canvasConnectionBanner" data-testid="loopops.builder.connection-banner">
            <span>{t("builder.connectionHint")}</span>
            <button type="button" onClick={cancelConnection} data-testid="loopops.builder.connection.cancel">
              <X size={14} /> {t("actions.cancel")}
            </button>
          </div>
        ) : null}
        <div
          className="canvasStage"
          style={{ width: canvasWidth, height: canvasHeight, transform: `scale(${scale})` }}
          data-testid="loopops.builder.canvas-dropzone"
        >
          <svg className="edgeLayer" width={canvasWidth} height={canvasHeight} aria-hidden="true">
            {graphEdges.map((edge) => {
              const from = graphNodeById.get(edge.from);
              const to = graphNodeById.get(edge.to);
              return <path key={edge.id} className="workflowEdge" d={edgePath(from, to)} />;
            })}
            {activeConnectionNode && connectPointer ? (
              <path className="workflowEdge temporary" d={temporaryEdgePath(activeConnectionNode, connectPointer)} data-testid="loopops.builder.connection.temp-line" />
            ) : null}
          </svg>

          {graphNodes.map((node, index) => (
            <article
              className={`canvasNode nodeType-${String(node.type || "step").toLowerCase().replace(/\s+/g, "-")} ${selectedNodeId === node.id ? "selected" : ""}`}
              key={node.id}
              style={{ transform: `translate(${node.position.x}px, ${node.position.y}px)` }}
              data-testid={`loopops.builder.node.${node.id}`}
              data-node-id={node.id}
              data-node-type={String(node.type || "step").toLowerCase()}
              data-selected={selectedNodeId === node.id ? "true" : undefined}
            >
              {!readOnly ? (
                <>
                  <button
                    type="button"
                    className={`nodePort nodePortIn ${activeConnectionId ? "ready" : ""}`}
                    aria-label={t("builder.connectInto", { title: node.title })}
                    title={t("builder.connectInto", { title: node.title })}
                    onClick={() => completeConnection(node.id)}
                    data-testid={`loopops.builder.node.${node.id}.input`}
                  />
                  <button
                    type="button"
                    className={`nodePort nodePortOut ${activeConnectionId === node.id ? "active" : ""}`}
                    aria-label={t("builder.connectFrom", { title: node.title })}
                    title={t("builder.connectFromHint")}
                    onClick={() => startConnection(node.id)}
                    data-testid={`loopops.builder.node.${node.id}.output`}
                  />
                </>
              ) : null}
              <div
                className="canvasNodeDrag"
                onPointerDown={(event) => beginNodeDrag(event, node)}
                onPointerMove={moveNodeDrag}
                onPointerUp={endNodeDrag}
                data-testid={`loopops.builder.node.${node.id}.drag`}
              >
                <span className="nodeIndex">{index + 1}</span>
                <div className="nodeTitleBlock">
                  <small>{nodeTypeLabel(node.type, t)}</small>
                  <strong>{node.title}</strong>
                </div>
                {!readOnly ? (
                  <IconButton
                    label={t("builder.deleteNodeLabel", { title: node.title })}
                    icon={<Trash2 size={14} />}
                    data-testid={`loopops.builder.node.${node.id}.delete`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteNode(node.id);
                    }}
                  />
                ) : null}
              </div>
              <button type="button" className="nodeBody" onClick={() => onNodeSelect(node.id)}>
                <span className="nodePurpose">{node.subtitle}</span>
                <span className="nodeFlowSection"><small>{t("builder.inputs")}</small><b>{firstValue(node.inputs) || "-"}</b></span>
                <span className="nodeFlowSection"><small>{t("builder.outputs")}</small><b>{firstValue(node.outputs) || "-"}</b></span>
                <StatusPill tone={nodeNeedsConnectionSetup(node) || node.reviewPolicyMode === "required" ? "warning" : "success"}>
                  {t(
                    nodeNeedsConnectionSetup(node)
                      ? "builder.needsSetup"
                      : node.reviewPolicyMode === "required"
                        ? "builder.reviewRequired"
                        : "builder.noReviewRequired",
                  )}
                </StatusPill>
              </button>
              {connectionError?.nodeId === node.id ? (
                <span className="nodeInlineError" data-testid="loopops.builder.connection.inline-error">
                  {connectionError.message}
                </span>
              ) : null}
            </article>
          ))}
        </div>
      </div>

      <button
        type="button"
        className="canvasMiniMap"
        aria-label={t("builder.minimapLabel")}
        title={t("builder.minimapLabel")}
        onClick={handleMinimapPointer}
        data-testid="loopops.builder.minimap"
      >
        <svg width={minimapWidth} height={minimapHeight} viewBox={`0 0 ${minimapWidth} ${minimapHeight}`} aria-hidden="true">
          {graphEdges.map((edge) => {
            const from = graphNodeById.get(edge.from);
            const to = graphNodeById.get(edge.to);
            if (!from || !to) return null;
            return (
              <line
                key={edge.id}
                className="miniEdge"
                x1={(from.position.x + NODE_WIDTH) * miniScaleX}
                y1={(from.position.y + NODE_HEIGHT / 2) * miniScaleY}
                x2={to.position.x * miniScaleX}
                y2={(to.position.y + NODE_HEIGHT / 2) * miniScaleY}
              />
            );
          })}
          {graphNodes.map((node) => (
            <rect
              key={node.id}
              className={`miniNode ${selectedNodeId === node.id ? "active" : ""}`}
              x={node.position.x * miniScaleX}
              y={node.position.y * miniScaleY}
              width={Math.max(12, NODE_WIDTH * miniScaleX)}
              height={Math.max(8, NODE_HEIGHT * miniScaleY)}
              rx="2"
            />
          ))}
          <rect
            className="miniViewport"
            x={Math.max(0, viewport.left * miniScaleX)}
            y={Math.max(0, viewport.top * miniScaleY)}
            width={Math.min(minimapWidth, Math.max(10, viewport.width * miniScaleX))}
            height={Math.min(minimapHeight, Math.max(8, viewport.height * miniScaleY))}
            rx="2"
          />
        </svg>
      </button>
    </section>
  );
}
