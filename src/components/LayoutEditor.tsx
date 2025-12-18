// src/components/LayoutEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Footprint, FootprintInstance, Parameter, StackupLayer, FootprintShape } from "../types";
import { evaluateExpression } from "./FootprintEditor";
import ExpressionEditor from "./ExpressionEditor";
import './LayoutEditor.css';

interface Props {
  layout: FootprintInstance[];
  setLayout: React.Dispatch<React.SetStateAction<FootprintInstance[]>>;
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
    isSelected // NEW: Prop to handle selection appearance
}: { 
    shape: FootprintShape; 
    params: Parameter[];
    isSelected: boolean; // NEW: Type for selection prop
}) => {
    const commonProps = {
        // UPDATED: Fill and stroke now reflect selection state, matching FootprintEditor
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

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function LayoutEditor({ layout, setLayout, footprints, params, stackup }: Props) {
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState({ x: -100, y: -100, width: 200, height: 200 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);

  // Dragging State Refs for Canvas Pan
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedInstanceId = useRef<string | null>(null);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // --- ACTIONS ---

  const addInstance = (footprintId: string) => {
    const newInstance: FootprintInstance = {
        id: crypto.randomUUID(),
        footprintId: footprintId,
        x: "0",
        y: "0",
        angle: "0"
    };
    setLayout([...layout, newInstance]);
    setSelectedInstanceId(newInstance.id);
  };

  const deleteInstance = (id: string) => {
    setLayout(prev => prev.filter(inst => inst.id !== id));
    if (selectedInstanceId === id) setSelectedInstanceId(null);
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
        setSelectedInstanceId(clickedInstanceId.current);
    }
    clickedInstanceId.current = null;
  };

  const resetView = () => {
    if (!wrapperRef.current) return;
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    const newWidth = 200;
    const newHeight = newWidth * (height / width);
    setViewBox({ x: -newWidth / 2, y: -newHeight / 2, width: newWidth, height: newHeight });
  };

  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const selectedInstance = layout.find(inst => inst.id === selectedInstanceId);

  return (
    <div className="layout-editor-container">
      {/* 1. LEFT PANEL: FOOTPRINT INSTANCES */}
      <div className="layout-sidebar-left">
        <div className="sidebar-header-row">
            <h3>Footprints</h3>
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
                    <option value="" disabled>+ Add Instance...</option>
                    {footprints.map(fp => (
                        <option key={fp.id} value={fp.id}>{fp.name}</option>
                    ))}
                </select>
            </div>
        </div>

        <div className="layout-instance-list">
          {layout.map((inst) => {
              const fp = footprints.find(f => f.id === inst.footprintId);
              return (
                  <div 
                    key={inst.id} 
                    className={`instance-item ${inst.id === selectedInstanceId ? 'selected' : ''}`}
                    onClick={() => setSelectedInstanceId(inst.id)}
                  >
                      <div className="instance-info">
                        <span className="fp-name">{fp?.name || 'Unknown Footprint'}</span>
                        <span className="inst-id-tag">{inst.id.slice(0, 4)}</span>
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
          <button className="canvas-home-btn" onClick={resetView} title="Reset View">🏠</button>
          
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
              
              {layout.map((inst) => {
                  const fp = footprints.find(f => f.id === inst.footprintId);
                  if (!fp) return null;
                  
                  const evalX = evaluateExpression(inst.x, params);
                  const evalY = evaluateExpression(inst.y, params);
                  const evalAngle = evaluateExpression(inst.angle, params);
                  const isSelected = inst.id === selectedInstanceId;

                  return (
                      <g 
                        key={inst.id} 
                        transform={`translate(${evalX}, ${evalY}) rotate(${evalAngle})`}
                        style={{ cursor: 'pointer' }}
                        // UPDATED: Removed stopPropagation so the SVG's handleMouseDown also triggers,
                        // allowing the global mouseup listener to finish the selection click.
                        onMouseDown={() => { clickedInstanceId.current = inst.id; }}
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
                                    isSelected={isSelected} // NEW: Passing selection state
                                />
                            ))}
                          </g>
                      </g>
                  );
              })}
            </svg>
          ) : (
            <div className="layout-3d-placeholder">
              <p>3D World Preview coming soon...</p>
            </div>
          )}
          <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan</div>
        </div>
      </div>

      {/* 3. RIGHT PANEL: PROPERTIES */}
      <div className="layout-sidebar-right">
        <h3>Properties</h3>
        {selectedInstance ? (
          <div className="properties-editor">
            <div className="prop-group">
                <label>Footprint</label>
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
            <p className="empty-hint">Select a footprint to edit.</p>
          </div>
        )}
      </div>
    </div>
  );
}