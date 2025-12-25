// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useMemo } from "react";
import { Footprint, FootprintShape, Parameter, FootprintCircle, FootprintRect, FootprintLine, StackupLayer, Point, LayerAssignment } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import Unified3DView, { Unified3DViewHandle, RenderItem } from "./Unified3DView";
import Viewer2D, { Viewer2DItem, evaluateExpression, modifyExpression } from "./Viewer2D";
import './FootprintEditor.css';

// Re-export helpers for 3D views that depend on them
export { evaluateExpression, modifyExpression } from "./Viewer2D";

interface Props {
  footprint: Footprint;
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  params: Parameter[];
  stackup: StackupLayer[];
}

// ... (Sub-components PropertiesPanel, LayerVisibilityPanel, ShapeListPanel remain unchanged) ...
// (I will retain them exactly as in the original file, just updating imports and main component logic)

// ------------------------------------------------------------------
// SUB-COMPONENTS (Keep original implementations)
// ------------------------------------------------------------------

// 1. PROPERTIES PANEL (Unchanged)
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
            const assignment = isChecked ? (shape.assignedLayers[layer.id] as LayerAssignment) : { depth: "0", endmillRadius: "0" };
            
            return (
              <div key={layer.id} className="layer-assignment-row">
                  <input 
                    className="layer-checkbox"
                    type="checkbox"
                    checked={isChecked}
                    onChange={(e) => {
                        const newAssignments = { ...(shape.assignedLayers || {}) };
                        if (e.target.checked) {
                            newAssignments[layer.id] = { depth: "0", endmillRadius: "0" }; 
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
                        <div style={{ display: 'flex', gap: '5px' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Depth</div>
                                <ExpressionEditor 
                                    value={assignment.depth}
                                    onChange={(val) => {
                                        const newAssignments = { ...shape.assignedLayers };
                                        newAssignments[layer.id] = { ...assignment, depth: val };
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }}
                                    params={params}
                                    placeholder="Depth"
                                />
                            </div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Radius</div>
                                <ExpressionEditor 
                                    value={assignment.endmillRadius}
                                    onChange={(val) => {
                                        const newAssignments = { ...shape.assignedLayers };
                                        newAssignments[layer.id] = { ...assignment, endmillRadius: val };
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }}
                                    params={params}
                                    placeholder="0"
                                />
                            </div>
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

      {shape.type !== "line" && (
        <>
          <div className="prop-group">
            <label>Center X</label>
            <ExpressionEditor
              value={(shape as FootprintCircle | FootprintRect).x}
              onChange={(val) => updateShape(shape.id, "x", val)}
              params={params}
              placeholder="0"
            />
          </div>

          <div className="prop-group">
            <label>Center Y</label>
            <ExpressionEditor
              value={(shape as FootprintCircle | FootprintRect).y}
              onChange={(val) => updateShape(shape.id, "y", val)}
              params={params}
              placeholder="0"
            />
          </div>
        </>
      )}

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
          <div className="prop-group">
            <label>Angle (deg)</label>
            <ExpressionEditor
              value={(shape as FootprintRect).angle}
              onChange={(val) => updateShape(shape.id, "angle", val)}
              params={params}
              placeholder="0"
            />
          </div>
          <div className="prop-group">
            <label>Corner Radius</label>
            <ExpressionEditor
              value={(shape as FootprintRect).cornerRadius}
              onChange={(val) => updateShape(shape.id, "cornerRadius", val)}
              params={params}
              placeholder="0"
            />
          </div>
        </>
      )}

      {shape.type === "line" && (
        <>
            <div className="prop-group">
                <label>Thickness</label>
                <ExpressionEditor
                    value={(shape as FootprintLine).thickness}
                    onChange={(val) => updateShape(shape.id, "thickness", val)}
                    params={params}
                    placeholder="1"
                />
            </div>
            
            <div className="prop-group">
                <label>Points</label>
                <div className="points-list-container">
                    {(shape as FootprintLine).points.map((p, idx) => (
                        <div key={p.id} className="point-block">
                            <div className="point-header">
                                <span>Point {idx + 1}</span>
                                <button 
                                    className="icon-btn danger" 
                                    onClick={() => {
                                        const newPoints = (shape as FootprintLine).points.filter((_, i) => i !== idx);
                                        updateShape(shape.id, "points", newPoints);
                                    }}
                                    title="Remove Point"
                                >×</button>
                            </div>
                            
                            <div className="point-row full">
                                <span className="label">X</span>
                                <ExpressionEditor 
                                    value={p.x}
                                    onChange={(val) => {
                                        const newPoints = [...(shape as FootprintLine).points];
                                        newPoints[idx] = { ...p, x: val };
                                        updateShape(shape.id, "points", newPoints);
                                    }}
                                    params={params}
                                    placeholder="X"
                                />
                            </div>
                            <div className="point-row full">
                                <span className="label">Y</span>
                                <ExpressionEditor 
                                    value={p.y}
                                    onChange={(val) => {
                                        const newPoints = [...(shape as FootprintLine).points];
                                        newPoints[idx] = { ...p, y: val };
                                        updateShape(shape.id, "points", newPoints);
                                    }}
                                    params={params}
                                    placeholder="Y"
                                />
                            </div>

                            <div className="point-controls-toggles">
                                <label className="checkbox-label">
                                    <input 
                                        type="checkbox" 
                                        checked={!!p.handleIn}
                                        onChange={(e) => {
                                            const newPoints = [...(shape as FootprintLine).points];
                                            if (e.target.checked) {
                                                newPoints[idx] = { ...p, handleIn: { x: "-5", y: "0" } };
                                            } else {
                                                const pt = { ...p };
                                                delete pt.handleIn;
                                                newPoints[idx] = pt;
                                            }
                                            updateShape(shape.id, "points", newPoints);
                                        }}
                                    /> In Handle
                                </label>
                                <label className="checkbox-label">
                                    <input 
                                        type="checkbox" 
                                        checked={!!p.handleOut}
                                        onChange={(e) => {
                                            const newPoints = [...(shape as FootprintLine).points];
                                            if (e.target.checked) {
                                                newPoints[idx] = { ...p, handleOut: { x: "5", y: "0" } };
                                            } else {
                                                const pt = { ...p };
                                                delete pt.handleOut;
                                                newPoints[idx] = pt;
                                            }
                                            updateShape(shape.id, "points", newPoints);
                                        }}
                                    /> Out Handle
                                </label>
                            </div>

                            {p.handleIn && (
                                <div className="handle-sub-block">
                                    <div className="sub-label">Handle In (Relative)</div>
                                    <div className="handle-inputs">
                                        <div className="mini-input">
                                            <span>dX</span>
                                            <ExpressionEditor 
                                                value={p.handleIn.x}
                                                onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.x = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }}
                                                params={params}
                                            />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor 
                                                value={p.handleIn.y}
                                                onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.y = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }}
                                                params={params}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}

                            {p.handleOut && (
                                <div className="handle-sub-block">
                                    <div className="sub-label">Handle Out (Relative)</div>
                                    <div className="handle-inputs">
                                        <div className="mini-input">
                                            <span>dX</span>
                                            <ExpressionEditor 
                                                value={p.handleOut.x}
                                                onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.x = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }}
                                                params={params}
                                            />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor 
                                                value={p.handleOut.y}
                                                onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.y = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }}
                                                params={params}
                                            />
                                        </div>
                                    </div>
                                </div>
                            )}

                        </div>
                    ))}
                    <button 
                        className="secondary small-btn" 
                        onClick={() => {
                            const newPoints = [...(shape as FootprintLine).points];
                            const last = newPoints[newPoints.length - 1] || { x: "0", y: "0" };
                            newPoints.push({
                                id: crypto.randomUUID(),
                                x: modifyExpression(last.x, 5),
                                y: modifyExpression(last.y, 5),
                            });
                            updateShape(shape.id, "points", newPoints);
                        }}
                    >
                        + Add Point
                    </button>
                </div>
            </div>
        </>
      )}
    </div>
  );
};

// 2. LAYER VISIBILITY PANEL (Unchanged)
const LayerVisibilityPanel = ({
  stackup,
  visibility,
  onToggle,
}: {
  stackup: StackupLayer[];
  visibility: Record<string, boolean>;
  onToggle: (id: string) => void;
}) => {
  return (
    <div className="fp-left-subpanel">
      <h3 style={{ marginTop: 0 }}>Layers</h3>
      <div className="layer-list-scroll">
        <div className={`layer-vis-item ${visibility["unassigned"] === false ? "is-hidden" : ""}`}>
            <div className="layer-vis-info">
                <div 
                    className="layer-color-square unassigned"
                    title="Unassigned"
                />
                <span className="layer-vis-name">Unassigned</span>
            </div>
            <button 
                className={`vis-toggle-btn ${visibility["unassigned"] !== false ? "visible" : "hidden"}`}
                onClick={() => onToggle("unassigned")}
            >
                {visibility["unassigned"] !== false ? "Hide" : "Show"}
            </button>
        </div>

        {stackup.map((layer) => (
             <div key={layer.id} className={`layer-vis-item ${visibility[layer.id] === false ? "is-hidden" : ""}`}>
                <div className="layer-vis-info">
                    <div 
                        className="layer-color-square"
                        style={{ backgroundColor: layer.color }}
                    />
                    <span className="layer-vis-name" title={layer.name}>{layer.name}</span>
                </div>
                <button 
                    className={`vis-toggle-btn ${visibility[layer.id] !== false ? "visible" : "hidden"}`}
                    onClick={() => onToggle(layer.id)}
                >
                    {visibility[layer.id] !== false ? "Hide" : "Show"}
                </button>
             </div>
        ))}
        {stackup.length === 0 && <div className="empty-state-small">No stackup layers.</div>}
      </div>
    </div>
  );
};

// 3. SHAPE LIST PANEL (Unchanged)
const ShapeListPanel = ({
  shapes,
  selectedShapeId,
  onSelect,
  onDelete,
  onRename,
  onMove,
  stackup,
  isShapeVisible,
}: {
  shapes: FootprintShape[];
  selectedShapeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  stackup: StackupLayer[];
  isShapeVisible: (shape: FootprintShape) => boolean;
}) => {
  return (
    <div className="fp-left-subpanel">
      <h3 style={{ marginTop: 0 }}>Shapes</h3>
      <div className="shape-list-container">
        {shapes.map((shape, index) => {
          const visible = isShapeVisible(shape);
          return (
          <div
            key={shape.id}
            className={`shape-item ${shape.id === selectedShapeId ? "selected" : ""} ${!visible ? "is-hidden" : ""}`}
            onClick={() => onSelect(shape.id)}
          >
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
            
            <div className="shape-actions" style={{ display: 'flex', gap: '2px' }}>
                <button 
                    className="icon-btn btn-up" 
                    onClick={(e) => { e.stopPropagation(); onMove(index, -1); }}
                    disabled={index === 0}
                    style={{ width: '24px', height: '24px', fontSize: '0.9em' }}
                    title="Move Up"
                >↑</button>
                <button 
                    className="icon-btn btn-down" 
                    onClick={(e) => { e.stopPropagation(); onMove(index, 1); }}
                    disabled={index === shapes.length - 1}
                    style={{ width: '24px', height: '24px', fontSize: '0.9em' }}
                    title="Move Down"
                >↓</button>
                <button
                  className="icon-btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(shape.id);
                  }}
                  style={{ width: '24px', height: '24px', fontSize: '0.9em' }}
                  title="Delete"
                >
                  ✕
                </button>
            </div>
          </div>
        )})}
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
  
  const footprintRef = useRef(footprint);
  useEffect(() => {
    footprintRef.current = footprint;
  }, [footprint]);

  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  const [viewBox, setViewBox] = useState({ x: -50, y: -50, width: 100, height: 100 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  const wrapperRef = useRef<HTMLDivElement>(null);

  // PERFORMANCE: Debounced State for 3D View
  const [deferredFootprint, setDeferredFootprint] = useState(footprint);

  useEffect(() => {
    if (viewMode === "2D") return;
    const timer = setTimeout(() => {
        setDeferredFootprint(footprint);
    }, 600);
    return () => clearTimeout(timer);
  }, [footprint, viewMode]);

  useEffect(() => {
      if (viewMode === "3D") {
          setDeferredFootprint(footprint);
      }
  }, [viewMode]); 

  const footprint3DRef = useRef<Unified3DViewHandle>(null);

  // Shape Dragging State Refs
  const isShapeDragging = useRef(false);
  const shapeDragStartPos = useRef({ x: 0, y: 0 });
  const shapeDragStartData = useRef<FootprintShape | null>(null);
  
  const dragTargetRef = useRef<{ 
      id: string; 
      pointIdx?: number; 
      handleType?: 'in' | 'out'; 
  } | null>(null);

  // --- SHAPE DRAG HANDLERS (Unchanged logic) ---
  const handleItemMouseDown = (e: React.MouseEvent, item: Viewer2DItem, subId?: string | number, handleType?: 'in' | 'out') => {
      if (viewMode !== "2D") return;
      if (item.type !== "shape") return;

      setSelectedShapeId(item.id);
      
      const shape = footprint.shapes.find(s => s.id === item.id);
      if (!shape) return;

      isShapeDragging.current = true;
      dragTargetRef.current = { 
          id: item.id, 
          pointIdx: typeof subId === 'number' ? subId : undefined, 
          handleType: handleType
      };

      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      shapeDragStartData.current = JSON.parse(JSON.stringify(shape));

      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleShapeMouseMove = (e: MouseEvent) => {
      if (!isShapeDragging.current || !wrapperRef.current || !dragTargetRef.current || !shapeDragStartData.current) return;

      const rect = wrapperRef.current.getBoundingClientRect();
      const scaleX = viewBox.width / rect.width;
      const scaleY = viewBox.height / rect.height;

      const dxPx = e.clientX - shapeDragStartPos.current.x;
      const dyPx = e.clientY - shapeDragStartPos.current.y;

      const dxWorld = dxPx * scaleX;
      // In Y-up mode, moving mouse down (dyPx > 0) means moving "down" in world Y (negative direction)
      const dyWorld = -dyPx * scaleY;

      const currentFP = footprintRef.current;
      const { id, pointIdx, handleType } = dragTargetRef.current;
      const startShape = shapeDragStartData.current;

      const updatedShapes = currentFP.shapes.map(s => {
          if (s.id === id) {
              if (s.type === "line" && startShape.type === "line") {
                  const newPoints = [...startShape.points];
                  
                  if (handleType && pointIdx !== undefined) {
                      const p = newPoints[pointIdx];
                      if (handleType === 'in' && p.handleIn) {
                          newPoints[pointIdx] = {
                              ...p,
                              handleIn: {
                                  x: modifyExpression(p.handleIn.x, dxWorld),
                                  y: modifyExpression(p.handleIn.y, dyWorld)
                              }
                          };
                      } else if (handleType === 'out' && p.handleOut) {
                          newPoints[pointIdx] = {
                              ...p,
                              handleOut: {
                                  x: modifyExpression(p.handleOut.x, dxWorld),
                                  y: modifyExpression(p.handleOut.y, dyWorld)
                              }
                          };
                      }
                  } else if (pointIdx !== undefined) {
                      const p = newPoints[pointIdx];
                      newPoints[pointIdx] = {
                          ...p,
                          x: modifyExpression(p.x, dxWorld),
                          y: modifyExpression(p.y, dyWorld)
                      };
                  } else {
                      const allMoved = newPoints.map(p => ({
                          ...p,
                          x: modifyExpression(p.x, dxWorld),
                          y: modifyExpression(p.y, dyWorld)
                      }));
                      return { ...s, points: allMoved };
                  }
                  return { ...s, points: newPoints };
              } 
              
              if (pointIdx === undefined && !handleType) {
                   if (startShape.type === "circle" || startShape.type === "rect") {
                      return { 
                          ...s, 
                          x: modifyExpression(startShape.x, dxWorld), 
                          y: modifyExpression(startShape.y, dyWorld) 
                      };
                  }
              }
          }
          return s;
      });

      onUpdate({ ...currentFP, shapes: updatedShapes });
  };

  const handleShapeMouseUp = (e: MouseEvent) => {
      isShapeDragging.current = false;
      dragTargetRef.current = null;
      shapeDragStartData.current = null;
      window.removeEventListener('mousemove', handleShapeMouseMove);
      window.removeEventListener('mouseup', handleShapeMouseUp);
  };

  // --- ACTIONS (Unchanged) ---
  const addShape = (type: "circle" | "rect" | "line") => {
    const base = {
      id: crypto.randomUUID(),
      name: `New ${type}`,
      assignedLayers: {}, 
    };

    let newShape: FootprintShape;

    if (type === "circle") {
      newShape = { ...base, type: "circle", x: "0", y: "0", diameter: "10" };
    } else if (type === "rect") {
      newShape = { ...base, type: "rect", x: "0", y: "0", width: "10", height: "10", angle: "0", cornerRadius: "0" };
    } else {
      newShape = { 
          ...base, 
          type: "line", 
          thickness: "1", 
          x: "0",
          y: "0",
          points: [
              { id: crypto.randomUUID(), x: "0", y: "0" },
              { id: crypto.randomUUID(), x: "10", y: "10" }
          ]
      };
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

  const moveShape = (index: number, direction: -1 | 1) => {
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === footprint.shapes.length - 1) return;

    const newShapes = [...footprint.shapes];
    const targetIndex = index + direction;
    [newShapes[index], newShapes[targetIndex]] = [newShapes[targetIndex], newShapes[index]];
    onUpdate({ ...footprint, shapes: newShapes });
  };

  const updateFootprintName = (name: string) => {
    onUpdate({ ...footprint, name });
  };

  const toggleLayerVisibility = (id: string) => {
    setLayerVisibility(prev => ({
        ...prev,
        [id]: prev[id] === undefined ? false : !prev[id]
    }));
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

  const handleHomeClick = () => {
    if (viewMode === "2D") {
        resetView();
    } else {
        footprint3DRef.current?.resetCamera();
    }
  };

  // --- PREPARE ITEMS FOR VIEWER2D ---
  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);

  const isShapeVisible = (shape: FootprintShape) => {
      const assignedIds = Object.keys(shape.assignedLayers || {});
      if (assignedIds.length === 0) {
          return layerVisibility["unassigned"] !== false;
      }
      const allAssignedLayersHidden = assignedIds.every(id => layerVisibility[id] === false);
      return !allAssignedLayersHidden;
  };

  const viewerItems: Viewer2DItem[] = [...footprint.shapes].reverse().map(shape => ({
      type: "shape",
      id: shape.id,
      data: shape,
      selected: shape.id === selectedShapeId,
      visible: isShapeVisible(shape)
  }));

  // --- PREPARE ITEMS FOR 3D VIEW ---
  // We use the DEFERRED footprint to avoid stutter during drag
  // Reverse shapes because Painter's algo (Viewer2D) draws Last on Top.
  // CSG Order (Union/Subtraction) is usually handled by layer logic, 
  // but if we want consistent ordering, we pass them as is or reversed.
  // Footprint3DView processed `orderedShapes` as `[...footprint.shapes].reverse()`.
  const renderItems: RenderItem[] = useMemo(() => 
    [...deferredFootprint.shapes].reverse().map(s => ({
        type: 'shape' as const,
        data: s
    }))
  , [deferredFootprint.shapes]);

  return (
    <div className="footprint-editor-container">
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
        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
        <button onClick={() => addShape("line")}>+ Line</button>
      </div>

      <div className="fp-workspace">
        <div className="fp-left-panel">
            <LayerVisibilityPanel 
                stackup={stackup}
                visibility={layerVisibility}
                onToggle={toggleLayerVisibility}
            />
            <ShapeListPanel
                shapes={footprint.shapes}
                selectedShapeId={selectedShapeId}
                onSelect={setSelectedShapeId}
                onDelete={deleteShape}
                onRename={(id, name) => updateShape(id, "name", name)}
                onMove={moveShape}
                stackup={stackup}
                isShapeVisible={isShapeVisible}
            />
        </div>

        <div className="fp-center-column">
            <div className="view-toggle-bar">
                <button 
                    className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`}
                    onClick={() => setViewMode("2D")}
                >
                    2D Canvas
                </button>
                <button 
                    className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`}
                    onClick={() => setViewMode("3D")}
                >
                    3D Preview
                </button>
            </div>

            <div 
                className="fp-canvas-wrapper" 
                ref={wrapperRef}
            >
                <button 
                    className="canvas-home-btn" 
                    onClick={handleHomeClick}
                    title="Reset View"
                >
                    🏠
                </button>

            <div style={{ display: viewMode === "2D" ? 'contents' : 'none' }}>
                <Viewer2D 
                    items={viewerItems}
                    params={params}
                    stackup={stackup}
                    viewBox={viewBox}
                    setViewBox={setViewBox}
                    onItemDown={handleItemMouseDown}
                    wrapperRef={wrapperRef}
                />
                <div className="canvas-hint">Scroll to Zoom | Drag to Pan | Drag Handles</div>
            </div>
            
            <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
                <Unified3DView 
                    ref={footprint3DRef}
                    items={renderItems}
                    params={params}
                    stackup={stackup}
                    visibleLayers={layerVisibility}
                    is3DActive={viewMode === "3D"} 
                />
            </div>
            </div>
        </div>

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