// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import * as math from "mathjs";
import { Footprint, FootprintShape, Parameter, FootprintCircle, FootprintRect, StackupLayer } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import Footprint3DView from "./Footprint3DView";
import './FootprintEditor.css';

interface Props {
  footprint: Footprint;
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  params: Parameter[];
  stackup: StackupLayer[];
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

// Evaluate math expressions to numbers (for visualization only)
export function evaluateExpression(expression: string, params: Parameter[]): number {
  if (!expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      scope[p.key] = math.unit(p.value, p.unit);
    });
    const result = math.evaluate(expression, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0; // Return 0 on error for visualizer
  }
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

// 1. SHAPE RENDERER (SVG)
const ShapeRenderer = ({
  shape,
  isSelected,
  params,
  onShapeDown,
}: {
  shape: FootprintShape;
  isSelected: boolean;
  params: Parameter[];
  onShapeDown: (e: React.MouseEvent, id: string) => void;
}) => {
  const commonProps = {
    onMouseDown: (e: React.MouseEvent) => {
      onShapeDown(e, shape.id);
    },
    fill: isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)",
    stroke: isSelected ? "#646cff" : "#888",
    strokeWidth: isSelected ? 2 : 1,
    vectorEffect: "non-scaling-stroke",
    style: { cursor: "pointer" },
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
    return (
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        {...commonProps}
      />
    );
  }

  return null;
};

// 2. PROPERTIES PANEL
const PropertiesPanel = ({
  shape,
  updateShape,
  params,
  stackup,
}: {
  shape: FootprintShape;
  updateShape: (id: string, field: string, val: any) => void;
  params: Parameter[];
  stackup: StackupLayer[];
}) => {
  return (
    <div className="properties-panel">
      <h3>{shape.type.toUpperCase()} Properties</h3>
      
      {/* Layer Assignment Section */}
      <div className="prop-section">
        <h4>Layers</h4>
        <div className="layer-list">
          {stackup.length === 0 && <div className="empty-hint">No stackup layers defined.</div>}
          {stackup.map((layer) => {
            const isChecked = shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined;
            
            // Calculate values for display
            let depthVal = 0;
            let thicknessVal = 0;
            let percentage = 0;

            if (isChecked && layer.type === "Carved/Printed") {
                const depthExpr = shape.assignedLayers[layer.id] || "0";
                depthVal = evaluateExpression(depthExpr, params);
                thicknessVal = evaluateExpression(layer.thicknessExpression, params);
                if (thicknessVal !== 0) {
                    percentage = (depthVal / thicknessVal) * 100;
                    // Cap at 100% as requested ("up to 100%")
                    if (percentage > 100) percentage = 100;
                    if (percentage < 0) percentage = 0;
                }
            }

            return (
              <div key={layer.id} className="layer-assignment-row">
                  <input 
                    className="layer-checkbox"
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                        const newAssignments = { ...(shape.assignedLayers || {}) };
                        if (e.target.checked) {
                            newAssignments[layer.id] = "0"; // Default depth
                        } else {
                            delete newAssignments[layer.id];
                        }
                        updateShape(shape.id, "assignedLayers", newAssignments);
                    }}
                  />
                  <div 
                    className="layer-color-badge" 
                    style={{ backgroundColor: layer.color }} 
                  />
                  <span className="layer-name" title={layer.name}>{layer.name}</span>
                
                {isChecked && layer.type === "Carved/Printed" && (
                    <div className="layer-depth-wrapper">
                        <ExpressionEditor 
                            value={shape.assignedLayers[layer.id]}
                            onChange={(val) => {
                                const newAssignments = { ...shape.assignedLayers };
                                newAssignments[layer.id] = val;
                                updateShape(shape.id, "assignedLayers", newAssignments);
                            }}
                            params={params}
                            placeholder="Depth"
                        />
                        <div className="depth-result-text">
                           {/* UPDATED TEXT FORMAT */}
                           = {depthVal.toFixed(1)}mm ({percentage.toFixed(1)}% of {thicknessVal.toFixed(1)}mm layer)
                        </div>
                    </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="prop-group">
        <label>Name</label>
        <input 
            type="text" 
            value={shape.name} 
            onChange={(e) => updateShape(shape.id, "name", e.target.value)}
        />
      </div>

      <div className="prop-group">
        <label>Center X</label>
        <ExpressionEditor
          value={shape.x}
          onChange={(val) => updateShape(shape.id, "x", val)}
          params={params}
          placeholder="0"
        />
      </div>

      <div className="prop-group">
        <label>Center Y</label>
        <ExpressionEditor
          value={shape.y}
          onChange={(val) => updateShape(shape.id, "y", val)}
          params={params}
          placeholder="0"
        />
      </div>

      {shape.type === "circle" && (
        <div className="prop-group">
          <label>Diameter</label>
          <ExpressionEditor
            value={(shape as FootprintCircle).diameter}
            onChange={(val) => updateShape(shape.id, "diameter", val)}
            params={params}
            placeholder="10"
          />
        </div>
      )}

      {shape.type === "rect" && (
        <>
          <div className="prop-group">
            <label>Width</label>
            <ExpressionEditor
              value={(shape as FootprintRect).width}
              onChange={(val) => updateShape(shape.id, "width", val)}
              params={params}
              placeholder="10"
            />
          </div>
          <div className="prop-group">
            <label>Height</label>
            <ExpressionEditor
              value={(shape as FootprintRect).height}
              onChange={(val) => updateShape(shape.id, "height", val)}
              params={params}
              placeholder="10"
            />
          </div>
        </>
      )}
    </div>
  );
};

// 3. SHAPE LIST PANEL
const ShapeListPanel = ({
  shapes,
  selectedShapeId,
  onSelect,
  onDelete,
  onRename,
  stackup,
}: {
  shapes: FootprintShape[];
  selectedShapeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  stackup: StackupLayer[];
}) => {
  return (
    <div className="fp-left-panel">
      <h3 style={{ marginTop: 0 }}>Shapes</h3>
      <div className="shape-list-container">
        {shapes.map((shape) => (
          <div
            key={shape.id}
            className={`shape-item ${shape.id === selectedShapeId ? "selected" : ""}`}
            onClick={() => onSelect(shape.id)}
          >
            {/* NEW: Colored squares for assigned layers */}
            <div className="shape-layer-indicators">
              {stackup.map(layer => {
                 if (shape.assignedLayers?.[layer.id] !== undefined) {
                     return (
                         <div 
                            key={layer.id}
                            className="layer-indicator-dot"
                            style={{ backgroundColor: layer.color }}
                            title={layer.name}
                         />
                     );
                 }
                 return null;
              })}
            </div>

            <input
              type="text"
              value={shape.name}
              onChange={(e) => onRename(shape.id, e.target.value)}
              className="shape-name-edit"
            />
            <button
              className="icon-btn danger"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(shape.id);
              }}
              title="Delete"
            >
              ✕
            </button>
          </div>
        ))}
        {shapes.length === 0 && <div className="empty-state-small">No shapes added.</div>}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function FootprintEditor({ footprint, onUpdate, onClose, params, stackup }: Props) {
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  
  // Viewport state for zooming/panning
  const [viewBox, setViewBox] = useState({ x: -50, y: -50, width: 100, height: 100 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);

  // Dragging State Refs
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedShapeId = useRef<string | null>(null);

  // Sync ref with state
  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // --- RESIZE OBSERVER (Adaptive Grid/Fill) ---
  useLayoutEffect(() => {
    if (!wrapperRef.current || viewMode !== "2D") return;
    
    const updateDimensions = () => {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        if (width === 0 || height === 0) return;
            
        setViewBox(prev => {
            const currentRatio = prev.width / prev.height;
            const newRatio = width / height;
            
            const newHeight = prev.width / newRatio;
            
            // Keep center
            const centerX = prev.x + prev.width / 2;
            const centerY = prev.y + prev.height / 2;
            
            return {
                x: centerX - prev.width / 2,
                y: centerY - newHeight / 2,
                width: prev.width,
                height: newHeight
            };
        });
    };

    const observer = new ResizeObserver(() => {
        updateDimensions();
    });
    
    observer.observe(wrapperRef.current);
    updateDimensions(); 

    return () => observer.disconnect();
  }, [viewMode]);

  // --- ZOOM HANDLER ---
  useEffect(() => {
    if (viewMode !== "2D") return;
    const element = wrapperRef.current; 
    if (!element) return;

    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        
        const currentVB = viewBoxRef.current;
        const rect = element.getBoundingClientRect();
        
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const ratioX = mouseX / rect.width;
        const ratioY = mouseY / rect.height;
        
        const userX = currentVB.x + ratioX * currentVB.width;
        const userY = currentVB.y + ratioY * currentVB.height;
        
        const ZOOM_SPEED = 1.1;
        const delta = Math.sign(e.deltaY); 
        const scale = delta > 0 ? ZOOM_SPEED : 1 / ZOOM_SPEED;
        
        const newWidth = currentVB.width * scale;
        const newHeight = currentVB.height * scale;
        
        const newX = userX - ratioX * newWidth;
        const newY = userY - ratioY * newHeight;
        
        setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
        element.removeEventListener('wheel', onWheel);
    };
  }, [viewMode]);

  // --- PAN / SELECT HANDLERS ---
  
  const handleMouseDown = (e: React.MouseEvent) => {
    if (viewMode !== "2D") return;
    if (e.button !== 0) return;
    
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
    
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved.current = true;
    }
    
    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;
    
    const newX = dragStartViewBox.current.x - dx * scaleX;
    const newY = dragStartViewBox.current.y - dy * scaleY;
    
    setViewBox(prev => ({
        ...prev,
        x: newX,
        y: newY
    }));
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);

    if (!hasMoved.current) {
        if (clickedShapeId.current) {
            setSelectedShapeId(clickedShapeId.current);
        } else {
            setSelectedShapeId(null);
        }
    }
    clickedShapeId.current = null;
  };

  const handleShapeMouseDown = (e: React.MouseEvent, id: string) => {
      clickedShapeId.current = id;
  };

  // --- ACTIONS ---

  const addShape = (type: "circle" | "rect") => {
    const base = {
      id: crypto.randomUUID(),
      name: `New ${type}`,
      assignedLayers: {}, 
    };

    let newShape: FootprintShape;

    if (type === "circle") {
      newShape = { ...base, type: "circle", x: "0", y: "0", diameter: "10" };
    } else {
      newShape = { ...base, type: "rect", x: "0", y: "0", width: "10", height: "10" };
    }

    onUpdate({
        ...footprint,
        shapes: [...footprint.shapes, newShape]
    });
    setSelectedShapeId(newShape.id);
  };

  const updateShape = (shapeId: string, field: string, val: any) => {
    onUpdate({
        ...footprint,
        shapes: footprint.shapes.map((s) =>
            s.id === shapeId ? { ...s, [field]: val } : s
        ),
    });
  };

  const deleteShape = (shapeId: string) => {
     onUpdate({
        ...footprint,
        shapes: footprint.shapes.filter(s => s.id !== shapeId)
     });
     setSelectedShapeId(null);
  };

  const updateFootprintName = (name: string) => {
    onUpdate({ ...footprint, name });
  };

  const resetView = () => {
    if (!wrapperRef.current) {
        setViewBox({ x: -50, y: -50, width: 100, height: 100 });
        return;
    }
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    const ratio = height / width; 
    const newWidth = 100;
    const newHeight = newWidth * ratio;
    
    setViewBox({
        x: -newWidth / 2,
        y: -newHeight / 2,
        width: newWidth,
        height: newHeight
    });
  };

  // --- DERIVED STATE ---
  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);
  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  // --- RENDER: EDITOR VIEW ---
  return (
    <div className="footprint-editor-container">
      {/* Header Toolbar */}
      <div className="fp-toolbar">
        <button className="secondary" onClick={onClose}>
          ← Back
        </button>
        <input 
            className="toolbar-name-input"
            type="text"
            value={footprint.name}
            onChange={(e) => updateFootprintName(e.target.value)}
        />
        
        <div className="spacer" />
        
        {/* VIEW TOGGLE */}
        <div style={{ display: "flex", gap: "2px", background: "#333", padding: "2px", borderRadius: "4px", marginRight: "20px" }}>
            <button 
                className={viewMode === "2D" ? "" : "secondary"} 
                style={{ padding: "4px 12px", fontSize: "0.9em", background: viewMode === "2D" ? "#646cff" : "transparent" }}
                onClick={() => setViewMode("2D")}
            >
                2D Canvas
            </button>
            <button 
                className={viewMode === "3D" ? "" : "secondary"}
                style={{ padding: "4px 12px", fontSize: "0.9em", background: viewMode === "3D" ? "#646cff" : "transparent" }}
                onClick={() => setViewMode("3D")}
            >
                3D Preview
            </button>
        </div>

        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
      </div>

      <div className="fp-workspace">
        {/* LEFT: SHAPE LIST */}
        <ShapeListPanel
            shapes={footprint.shapes}
            selectedShapeId={selectedShapeId}
            onSelect={setSelectedShapeId}
            onDelete={deleteShape}
            onRename={(id, name) => updateShape(id, "name", name)}
            stackup={stackup}
        />

        {/* CENTER: VISUAL EDITOR */}
        <div 
            className="fp-canvas-wrapper" 
            ref={wrapperRef}
        >
          {viewMode === "2D" ? (
            <>
              <button 
                 className="canvas-home-btn" 
                 onClick={resetView}
                 title="Reset View"
              >
                 🏠
              </button>

              <svg 
                ref={svgRef}
                className="fp-canvas" 
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                onMouseDown={handleMouseDown}
              >
                <defs>
                  <pattern 
                    id="grid" 
                    width={gridSize} 
                    height={gridSize} 
                    patternUnits="userSpaceOnUse"
                  >
                    <path 
                        d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} 
                        fill="none" 
                        stroke="#333" 
                        strokeWidth="1" 
                        vectorEffect="non-scaling-stroke" 
                    />
                  </pattern>
                </defs>
                
                <rect 
                    x={viewBox.x} 
                    y={viewBox.y} 
                    width={viewBox.width} 
                    height={viewBox.height} 
                    fill="url(#grid)" 
                />
                
                <line 
                    x1={viewBox.x} y1="0" 
                    x2={viewBox.x + viewBox.width} y2="0" 
                    stroke="#444" strokeWidth="2" 
                    vectorEffect="non-scaling-stroke" 
                />
                <line 
                    x1="0" y1={viewBox.y} 
                    x2="0" y2={viewBox.y + viewBox.height} 
                    stroke="#444" strokeWidth="2" 
                    vectorEffect="non-scaling-stroke" 
                />

                {footprint.shapes.map((shape) => (
                  <ShapeRenderer
                    key={shape.id}
                    shape={shape}
                    isSelected={shape.id === selectedShapeId}
                    params={params}
                    onShapeDown={handleShapeMouseDown}
                  />
                ))}
              </svg>
              <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan</div>
            </>
          ) : (
            // 3D VIEW
            <Footprint3DView 
                footprint={footprint}
                params={params}
                stackup={stackup}
            />
          )}
        </div>

        {/* RIGHT: PROPERTIES PANEL */}
        <div className="fp-sidebar">
          {activeShape ? (
            <>
              <PropertiesPanel 
                shape={activeShape} 
                updateShape={updateShape} 
                params={params} 
                stackup={stackup}
              />
              <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                <button className="danger" style={{width: '100%'}} onClick={() => deleteShape(activeShape.id)}>
                    Delete Shape
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p>Select a shape to edit properties.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}