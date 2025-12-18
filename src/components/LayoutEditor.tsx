// src/components/LayoutEditor.tsx
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Footprint, FootprintInstance, Parameter, StackupLayer, FootprintShape, BoardOutline, Point } from "../types";
import { evaluateExpression } from "./FootprintEditor";
import ExpressionEditor from "./ExpressionEditor";
import Layout3DView, { Layout3DViewHandle } from "./Layout3DView"; // NEW IMPORT
import './LayoutEditor.css';

interface Props {
  layout: FootprintInstance[];
  setLayout: React.Dispatch<React.SetStateAction<FootprintInstance[]>>;
  boardOutline: BoardOutline;
  setBoardOutline: React.Dispatch<React.SetStateAction<BoardOutline>>;
  footprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

const InstanceShapeRenderer = ({ 
    shape, 
    params,
    isSelected 
}: { 
    shape: FootprintShape; 
    params: Parameter[];
    isSelected: boolean; 
}) => {
    const commonProps = {
        fill: isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)",
        stroke: isSelected ? "#646cff" : "#888",
        strokeWidth: isSelected ? 2 : 1,
        vectorEffect: "non-scaling-stroke" as const,
    };

    if (shape.type === "circle") {
        const r = evaluateExpression(shape.diameter, params) / 2;
        const cx = evaluateExpression(shape.x, params);
        const cy = evaluateExpression(shape.y, params);
        return <circle cx={cx} cy={cy} r={r} {...commonProps} />;
    }

    if (shape.type === "rect") {
        const w = evaluateExpression(shape.width, params);
        const h = evaluateExpression(shape.height, params);
        const x = evaluateExpression(shape.x, params);
        const y = evaluateExpression(shape.y, params);
        const angle = evaluateExpression(shape.angle, params);
        return (
            <rect
                x={x - w / 2}
                y={y - h / 2}
                width={w}
                height={h}
                transform={`rotate(${angle}, ${x}, ${y})`}
                {...commonProps}
            />
        );
    }
    return null;
};

/**
 * Component to edit Board Outline points
 */
const BoardOutlineProperties = ({ 
    boardOutline, 
    setBoardOutline, 
    params 
}: { 
    boardOutline: BoardOutline, 
    setBoardOutline: React.Dispatch<React.SetStateAction<BoardOutline>>,
    params: Parameter[]
}) => {
    const updatePoint = (id: string, field: "x" | "y", val: string) => {
        setBoardOutline(prev => ({
            ...prev,
            points: prev.points.map(p => p.id === id ? { ...p, [field]: val } : p)
        }));
    };

    const addPoint = () => {
        const lastPoint = boardOutline.points[boardOutline.points.length - 1];
        const newPoint: Point = {
            id: crypto.randomUUID(),
            x: lastPoint ? lastPoint.x : "0",
            y: lastPoint ? lastPoint.y : "0"
        };
        setBoardOutline(prev => ({ ...prev, points: [...prev.points, newPoint] }));
    };

    const deletePoint = (id: string) => {
        if (boardOutline.points.length <= 3) return;
        setBoardOutline(prev => ({ ...prev, points: prev.points.filter(p => p.id !== id) }));
    };

    const movePoint = (index: number, direction: -1 | 1) => {
        if (direction === -1 && index === 0) return;
        if (direction === 1 && index === boardOutline.points.length - 1) return;
        const newPoints = [...boardOutline.points];
        const target = index + direction;
        [newPoints[index], newPoints[target]] = [newPoints[target], newPoints[index]];
        setBoardOutline(prev => ({ ...prev, points: newPoints }));
    };

    return (
        <div className="properties-editor">
            <h3>Board Outline Points</h3>
            <table className="points-table">
                <thead>
                    <tr>
                        <th>X</th>
                        <th>Y</th>
                        <th style={{ width: "90px" }}>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {boardOutline.points.map((p, idx) => (
                        <tr key={p.id}>
                            <td>
                                <ExpressionEditor 
                                    value={p.x} 
                                    onChange={(v) => updatePoint(p.id, "x", v)} 
                                    params={params} 
                                />
                            </td>
                            <td>
                                <ExpressionEditor 
                                    value={p.y} 
                                    onChange={(v) => updatePoint(p.id, "y", v)} 
                                    params={params} 
                                />
                            </td>
                            <td>
                                <div className="action-buttons">
                                    <button 
                                        className="icon-btn btn-up" 
                                        onClick={() => movePoint(idx, -1)} 
                                        disabled={idx === 0}
                                    >↑</button>
                                    <button 
                                        className="icon-btn btn-down" 
                                        onClick={() => movePoint(idx, 1)} 
                                        disabled={idx === boardOutline.points.length - 1}
                                    >↓</button>
                                    <button 
                                        className="icon-btn danger" 
                                        onClick={() => deletePoint(p.id)}
                                        disabled={boardOutline.points.length <= 3}
                                    >✕</button>
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <button className="add-btn" onClick={addPoint}>+ Add Point</button>
        </div>
    );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function LayoutEditor({ layout, setLayout, boardOutline, setBoardOutline, footprints, params, stackup }: Props) {
  // SPECIAL ID: We use "BOARD_OUTLINE" as a hardcoded ID for selection
  const [selectedId, setSelectedId] = useState<string | null>("BOARD_OUTLINE");
  const [viewBox, setViewBox] = useState({ x: -100, y: -100, width: 200, height: 200 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);
  
  // NEW: Ref for 3D View to control camera
  const layout3DRef = useRef<Layout3DViewHandle>(null);

  // Dragging State Refs for Canvas Pan
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedId = useRef<string | null>(null);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // --- ACTIONS ---

  const addInstance = (footprintId: string) => {
    const fp = footprints.find(f => f.id === footprintId);
    const newInstance: FootprintInstance = {
        id: crypto.randomUUID(),
        footprintId: footprintId,
        name: fp?.name || "New Instance",
        x: "0",
        y: "0",
        angle: "0"
    };
    setLayout([...layout, newInstance]);
    setSelectedId(newInstance.id);
  };

  const deleteInstance = (id: string) => {
    setLayout(prev => prev.filter(inst => inst.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const updateInstance = (id: string, field: keyof FootprintInstance, value: string) => {
    setLayout(prev => prev.map(inst => inst.id === id ? { ...inst, [field]: value } : inst));
  };

  // --- 2D CANVAS NAVIGATION LOGIC ---
  
  useLayoutEffect(() => {
    if (!wrapperRef.current || viewMode !== "2D") return;
    const updateDimensions = () => {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        setViewBox(prev => {
            const newHeight = prev.width / (width / height);
            const centerX = prev.x + prev.width / 2;
            const centerY = prev.y + prev.height / 2;
            return { x: centerX - prev.width / 2, y: centerY - newHeight / 2, width: prev.width, height: newHeight };
        });
    };
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(wrapperRef.current);
    updateDimensions(); 
    return () => observer.disconnect();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "2D") return;
    const element = wrapperRef.current; 
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = element.getBoundingClientRect();
        const ratioX = (e.clientX - rect.left) / rect.width;
        const ratioY = (e.clientY - rect.top) / rect.height;
        const userX = viewBoxRef.current.x + ratioX * viewBoxRef.current.width;
        const userY = viewBoxRef.current.y + ratioY * viewBoxRef.current.height;
        const scale = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        const newWidth = viewBoxRef.current.width * scale;
        const newHeight = viewBoxRef.current.height * scale;
        setViewBox({ x: userX - ratioX * newWidth, y: userY - ratioY * newHeight, width: newWidth, height: newHeight });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [viewMode]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (viewMode !== "2D" || e.button !== 0) return;
    isDragging.current = true;
    hasMoved.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragStartViewBox.current = { x: viewBox.x, y: viewBox.y };
    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
  };

  const handleGlobalMouseMove = (e: MouseEvent) => {
    if (!isDragging.current || !wrapperRef.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved.current = true;
    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;
    setViewBox(prev => ({ ...prev, x: dragStartViewBox.current.x - dx * scaleX, y: dragStartViewBox.current.y - dy * scaleY }));
  };

  const handleGlobalMouseUp = () => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);
    if (!hasMoved.current) {
        setSelectedId(clickedId.current);
    }
    clickedId.current = null;
  };

  const handleHomeClick = () => {
    if (viewMode === "2D") {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        const newWidth = 200;
        const newHeight = newWidth * (height / width);
        setViewBox({ x: -newWidth / 2, y: -newHeight / 2, width: newWidth, height: newHeight });
    } else {
        layout3DRef.current?.resetCamera();
    }
  };

  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const selectedInstance = layout.find(inst => inst.id === selectedId);

  // Construct SVG polygon points string
  const boardPointsStr = boardOutline.points
    .map(p => `${evaluateExpression(p.x, params)},${evaluateExpression(p.y, params)}`)
    .join(' ');

  return (
    <div className="layout-editor-container">
      {/* 1. LEFT PANEL: FOOTPRINT INSTANCES */}
      <div className="layout-sidebar-left">
        <div className="sidebar-header-row">
            <h3>Layout Objects</h3>
        </div>

        <div className="layout-instance-list">
          {/* HARDCODED BOARD OUTLINE ITEM */}
          <div 
            className={`instance-item board-outline-item ${selectedId === 'BOARD_OUTLINE' ? 'selected' : ''}`}
            onClick={() => setSelectedId('BOARD_OUTLINE')}
          >
            <div className="instance-info">
                <strong>Board Outline</strong>
                <span className="inst-id-tag">Polygon</span>
            </div>
          </div>

          <div style={{ borderBottom: '1px solid #333', margin: '10px 0' }} />

          <div className="sidebar-header-row" style={{ marginBottom: '10px' }}>
            <span style={{ fontSize: '0.9em', color: '#888' }}>Instances</span>
            <div className="add-instance-control">
                <select 
                    defaultValue=""
                    onChange={(e) => {
                        if (e.target.value) {
                            addInstance(e.target.value);
                            e.target.value = "";
                        }
                    }}
                >
                    <option value="" disabled>+ Place...</option>
                    {footprints.map(fp => (
                        <option key={fp.id} value={fp.id}>{fp.name}</option>
                    ))}
                </select>
            </div>
          </div>

          {layout.map((inst) => {
              const fp = footprints.find(f => f.id === inst.footprintId);
              return (
                  <div 
                    key={inst.id} 
                    className={`instance-item ${inst.id === selectedId ? 'selected' : ''}`}
                    onClick={() => setSelectedId(inst.id)}
                  >
                      <div className="instance-info">
                        <input
                          type="text"
                          value={inst.name}
                          onChange={(e) => updateInstance(inst.id, "name", e.target.value)}
                          className="instance-name-edit"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="inst-id-tag">{fp?.name || 'Unknown Footprint'}</span>
                      </div>
                      <button 
                        className="icon-btn danger" 
                        onClick={(e) => { e.stopPropagation(); deleteInstance(inst.id); }}
                      >✕</button>
                  </div>
              );
          })}
          {layout.length === 0 && <p className="empty-hint">No footprints placed.</p>}
        </div>
      </div>

      {/* 2. CENTER PANEL: 2D/3D VISUALIZER */}
      <div className="layout-center">
        <div className="view-toggle-bar">
          <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>2D Layout</button>
          <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D Preview</button>
        </div>

        <div className="layout-canvas-wrapper" ref={wrapperRef}>
          <button className="canvas-home-btn" onClick={handleHomeClick} title="Reset View">🏠</button>
          
          {viewMode === "2D" ? (
            <svg className="layout-canvas" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`} onMouseDown={handleMouseDown}>
              <defs>
                <pattern id="layout-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                  <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </pattern>
              </defs>
              <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#layout-grid)" />
              <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              
              {/* Render Board Outline */}
              {/* Hit Area for easier selection (transparent stroke) */}
              <polygon 
                points={boardPointsStr}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
                onMouseDown={() => { clickedId.current = "BOARD_OUTLINE"; }}
              />
              {/* Visible Outline */}
              <polygon 
                points={boardPointsStr}
                fill="none"
                stroke={selectedId === "BOARD_OUTLINE" ? "#646cff" : "#555"}
                strokeWidth={selectedId === "BOARD_OUTLINE" ? 3 : 2}
                strokeDasharray={selectedId === "BOARD_OUTLINE" ? "0" : "5,5"}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />

              {layout.map((inst) => {
                  const fp = footprints.find(f => f.id === inst.footprintId);
                  if (!fp) return null;
                  
                  const evalX = evaluateExpression(inst.x, params);
                  const evalY = evaluateExpression(inst.y, params);
                  const evalAngle = evaluateExpression(inst.angle, params);
                  const isSelected = inst.id === selectedId;

                  return (
                      <g 
                        key={inst.id} 
                        transform={`translate(${evalX}, ${evalY}) rotate(${evalAngle})`}
                        style={{ cursor: 'pointer' }}
                        onMouseDown={() => { clickedId.current = inst.id; }}
                      >
                          {/* Invisible hit area for easier clicking if footprint is empty or thin */}
                          <circle r="5" fill="transparent" />
                          
                          {/* Render footprint shapes */}
                          <g style={{ 
                            filter: isSelected ? 'drop-shadow(0 0 2px #646cff)' : undefined
                          }}>
                            {fp.shapes.map(shape => (
                                <InstanceShapeRenderer 
                                    key={shape.id} 
                                    shape={shape} 
                                    params={params} 
                                    isSelected={isSelected} 
                                />
                            ))}
                          </g>
                      </g>
                  );
              })}
            </svg>
          ) : (
            // NEW: 3D Preview
            <Layout3DView 
                ref={layout3DRef}
                layout={layout}
                boardOutline={boardOutline}
                footprints={footprints}
                params={params}
                stackup={stackup}
            />
          )}
          {viewMode === "2D" && (
             <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan</div>
          )}
        </div>
      </div>

      {/* 3. RIGHT PANEL: PROPERTIES */}
      <div className="layout-sidebar-right">
        {selectedId === "BOARD_OUTLINE" ? (
            <BoardOutlineProperties 
                boardOutline={boardOutline} 
                setBoardOutline={setBoardOutline} 
                params={params} 
            />
        ) : selectedInstance ? (
          <div className="properties-editor">
            <h3>Footprint Properties</h3>
            <div className="prop-group">
                <label>Name</label>
                <input 
                    type="text" 
                    value={selectedInstance.name} 
                    onChange={(e) => updateInstance(selectedInstance.id, "name", e.target.value)}
                />
            </div>

            <div className="prop-group">
                <label>Footprint Type</label>
                <div className="prop-static-text">
                    {footprints.find(f => f.id === selectedInstance.footprintId)?.name || 'Unknown'}
                </div>
            </div>
            
            <div className="prop-group">
                <label>X Position</label>
                <ExpressionEditor 
                    value={selectedInstance.x}
                    onChange={(val) => updateInstance(selectedInstance.id, "x", val)}
                    params={params}
                    placeholder="0"
                />
            </div>

            <div className="prop-group">
                <label>Y Position</label>
                <ExpressionEditor 
                    value={selectedInstance.y}
                    onChange={(val) => updateInstance(selectedInstance.id, "y", val)}
                    params={params}
                    placeholder="0"
                />
            </div>

            <div className="prop-group">
                <label>Rotation (deg)</label>
                <ExpressionEditor 
                    value={selectedInstance.angle}
                    onChange={(val) => updateInstance(selectedInstance.id, "angle", val)}
                    params={params}
                    placeholder="0"
                />
            </div>

            <div style={{ marginTop: '20px', borderTop: '1px solid #333', paddingTop: '20px' }}>
                <button className="danger" style={{ width: '100%' }} onClick={() => deleteInstance(selectedInstance.id)}>
                    Remove Footprint
                </button>
            </div>
          </div>
        ) : (
          <div className="properties-placeholder">
            <p className="empty-hint">Select an object to edit.</p>
          </div>
        )}
      </div>
    </div>
  );
}