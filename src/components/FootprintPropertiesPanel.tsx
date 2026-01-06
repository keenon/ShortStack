// src/components/FootprintPropertiesPanel.tsx
// import React, { Fragment, useMemo } from "react";
import { Fragment, useMemo, useRef, useEffect } from "react";
import { Footprint, Parameter, StackupLayer, Point, LayerAssignment, FootprintReference, FootprintCircle, FootprintRect, FootprintLine, FootprintWireGuide, FootprintBoardOutline, FootprintPolygon, MeshAsset, FootprintShape, FootprintUnion, FootprintText } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import { modifyExpression, calcMid, getAvailableWireGuides, findWireGuideByPath, convertRectToPolyPoints } from "../utils/footprintUtils";

const FootprintPropertiesPanel = ({
  footprint,
  allFootprints,
  selectedId,
  selectedShapeIds,
  updateShape,
  updateMesh, // NEW
  updateFootprint,
  params,
  stackup,
  meshAssets,
  hoveredPointIndex,
  setHoveredPointIndex,
  scrollToPointIndex,
  hoveredMidpointIndex,
  setHoveredMidpointIndex,
  onDuplicate, // NEW
  onEditChild, // NEW
  onConvertShape,
  onGroup,
  onUngroup,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedId: string | null;
  selectedShapeIds: string[];
  updateShape: (id: string, field: string, val: any) => void;
  updateMesh: (id: string, field: string, val: any) => void; // NEW
  updateFootprint: (field: string, val: any) => void;
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
  hoveredPointIndex: number | null;
  setHoveredPointIndex: (index: number | null) => void;
  scrollToPointIndex: number | null;
  hoveredMidpointIndex: number | null;
  setHoveredMidpointIndex: (index: number | null) => void;
  onDuplicate: () => void; // NEW
  onEditChild: (id: string) => void; // NEW
  onConvertShape?: (oldId: string, newShape: FootprintShape) => void;
  onGroup?: () => void;
  onUngroup?: (id: string) => void;
}) => {
  
  // Get available wire guides for Snapping
  // We memoize this to prevent recalculation on every render unless footprint structure changes
  const availableGuides = useMemo(() => getAvailableWireGuides(footprint, allFootprints), [footprint, allFootprints]);

  // NEW: Refs for scrolling
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // NEW: Effect to scroll to point
  useEffect(() => {
    if (scrollToPointIndex !== null && rowRefs.current.has(scrollToPointIndex)) {
        rowRefs.current.get(scrollToPointIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [scrollToPointIndex]);

  // NEW: Helper to render the Lock Toggle
  const renderLockToggle = (targetId: string, currentLocked: boolean | undefined) => (
      <div style={{ marginBottom: '10px', padding: '8px', background: '#2a2a2a', borderRadius: '4px', border: '1px solid #444', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label className="checkbox-label" style={{color: currentLocked ? '#ff4d4d' : '#ccc', fontWeight: currentLocked ? 'bold' : 'normal'}}>
              <input 
                  type="checkbox" 
                  checked={!!currentLocked} 
                  onChange={(e) => updateShape(targetId, "locked", e.target.checked)} 
              />
              {currentLocked ? "🔒 Locked" : "🔓 Unlocked"}
          </label>
          {currentLocked && <small style={{color: '#666', fontSize:'0.8em'}}>Selection only</small>}
      </div>
  );

  if (selectedShapeIds.length > 1) {
    return (
        <div className="properties-panel">
            <h3>Multiple shapes selected</h3>
            <p>{selectedShapeIds.length} items</p>
            
            <div className="prop-group">
                <button onClick={onGroup} style={{ width: '100%', padding: '12px' }}>
                    Union
                </button>
                <p style={{fontSize: '0.85em', color:'#888', marginTop:'5px'}}>
                    Joins selected shapes together into a union group.
                </p>
            </div>
        </div>
    );
  }

  // Helper to render property editors for a Point (used in Lines and Board Outline)
  const renderPointEditor = (p: Point, idx: number, updateFn: (newP: Point) => void, removeFn: () => void, allowHandles: boolean = true) => {
      // Look up snapped guide to determine handle overrides
      const snappedGuide = findWireGuideByPath(p.snapTo, footprint, allFootprints);
      const guideHasDirection = !!snappedGuide?.handle;

      const isHovered = hoveredPointIndex === idx;

      return (
        <div 
            className="point-block" 
            key={p.id}
            ref={(el) => {
                if (el) rowRefs.current.set(idx, el);
                else rowRefs.current.delete(idx);
            }}
            onMouseEnter={() => setHoveredPointIndex(idx)}
            onMouseLeave={() => setHoveredPointIndex(null)}
            style={isHovered ? { border: '1px solid #646cff' } : {}}
        >
            <div className="point-header">
                <span>Point {idx + 1}</span>
                <button className="icon-btn danger" onClick={removeFn} title="Remove Point">×</button>
            </div>
            
            {/* SNAP TO DROPDOWN */}
            <div className="point-row full" style={{ marginBottom: '8px' }}>
                <span className="label" style={{ width: 'auto', marginRight: '5px' }}>Snap:</span>
                <select 
                    value={p.snapTo || ""} 
                    onChange={(e) => updateFn({ ...p, snapTo: e.target.value || undefined })}
                    style={{ flex: 1, background: '#333', border: '1px solid #555', color: 'white' }}
                >
                    <option value="">(None)</option>
                    {availableGuides.map(g => (
                        <option key={g.pathId} value={g.pathId}>{g.label}</option>
                    ))}
                </select>
            </div>

            {/* If Snapped, disable X/Y editing or show visual cue */}
            {p.snapTo ? (
                <div style={{ padding: '8px', background: '#333', borderRadius: '4px', fontSize: '0.9em', color: '#aaa', fontStyle: 'italic', textAlign: 'center' }}>
                    Position controlled by Wire Guide.
                </div>
            ) : (
                <>
                    <div className="point-row full">
                        <span className="label">X</span>
                        <ExpressionEditor value={p.x} onChange={(val) => updateFn({ ...p, x: val })} params={params} placeholder="X" />
                    </div>
                    <div className="point-row full">
                        <span className="label">Y</span>
                        <ExpressionEditor value={p.y} onChange={(val) => updateFn({ ...p, y: val })} params={params} placeholder="Y" />
                    </div>
                </>
            )}

            {allowHandles && (
                <>
                    <div className="point-controls-toggles">
                        <label className="checkbox-label" style={p.snapTo ? { opacity: 0.7 } : {}}>
                            <input type="checkbox" disabled={!!p.snapTo} checked={p.snapTo ? guideHasDirection : !!p.handleIn} onChange={(e) => {
                                    if (e.target.checked) updateFn({ ...p, handleIn: { x: "-5", y: "0" } });
                                    else { const { handleIn, ...rest } = p; updateFn(rest as Point); }
                                }} /> In Handle
                        </label>
                        <label className="checkbox-label" style={p.snapTo ? { opacity: 0.7 } : {}}>
                            <input type="checkbox" disabled={!!p.snapTo} checked={p.snapTo ? guideHasDirection : !!p.handleOut} onChange={(e) => {
                                    if (e.target.checked) updateFn({ ...p, handleOut: { x: "5", y: "0" } });
                                    else { const { handleIn, ...rest } = p; updateFn(rest as Point); }
                                }} /> Out Handle
                        </label>
                    </div>

                    {!p.snapTo && p.handleIn && (
                        <div className="handle-sub-block">
                             <div className="sub-label">Handle In (Relative)</div>
                             <div className="handle-inputs">
                                 <div className="mini-input"><span>dX</span><ExpressionEditor value={p.handleIn.x} onChange={(v) => updateFn({...p, handleIn: {...p.handleIn!, x:v}})} params={params}/></div>
                                 <div className="mini-input"><span>dY</span><ExpressionEditor value={p.handleIn.y} onChange={(v) => updateFn({...p, handleIn: {...p.handleIn!, y:v}})} params={params}/></div>
                             </div>
                        </div>
                    )}
                    {!p.snapTo && p.handleOut && (
                        <div className="handle-sub-block">
                             <div className="sub-label">Handle Out (Relative)</div>
                             <div className="handle-inputs">
                                 <div className="mini-input"><span>dX</span><ExpressionEditor value={p.handleOut.x} onChange={(v) => updateFn({...p, handleOut: {...p.handleOut!, x:v}})} params={params}/></div>
                                 <div className="mini-input"><span>dY</span><ExpressionEditor value={p.handleOut.y} onChange={(v) => updateFn({...p, handleOut: {...p.handleOut!, y:v}})} params={params}/></div>
                             </div>
                        </div>
                    )}
                    {p.snapTo && guideHasDirection && (
                        <div style={{ marginTop: '5px', fontSize: '0.8em', color: '#666' }}>
                           Handles are inherited from the Wire Guide.
                        </div>
                    )}
                </>
            )}
        </div>
      );
  };

  const shape = footprint.shapes.find(s => s.id === selectedId);

  // SPECIAL CASE: Board Outline
  if (shape?.type === "boardOutline") {
      const bo = shape as FootprintBoardOutline;
      const points = bo.points;
      const assignments = footprint.boardOutlineAssignments || {};

      const addMidpoint = (index: number) => {
          const p1 = points[index];
          const p2 = points[(index + 1) % points.length];
          if (!p1 || !p2) return;
          const newPoint: Point = {
              id: crypto.randomUUID(),
              x: calcMid(p1.x, p2.x),
              y: calcMid(p1.y, p2.y)
          };
          const newPoints = [...points];
          newPoints.splice(index + 1, 0, newPoint);
          updateShape(shape.id, "points", newPoints);
      };

      return (
          <div className="properties-panel">
            <h3>Board Outline Properties</h3>
            
            {/* Lock Toggle */}
            {renderLockToggle(shape.id, shape.locked)}

            {/* Exclusive Layer Selection */}
            <div className="prop-section">
                <h4>Applied Layers</h4>
                <div className="layer-list">
                    {stackup.map(layer => {
                        const assignedId = assignments[layer.id];
                        const isChecked = assignedId === shape.id;
                        
                        // Find name of outline actually using this layer
                        const otherOutline = assignedId && assignedId !== shape.id ? footprint.shapes.find(s => s.id === assignedId) : null;

                        return (
                            <div key={layer.id} className="layer-assignment-row">
                                <input 
                                    type="checkbox" 
                                    checked={isChecked} 
                                    onChange={(e) => {
                                        const newAss = { ...assignments };
                                        if (e.target.checked) {
                                            newAss[layer.id] = shape.id;
                                        } else {
                                            // Fallback to first outline if unchecking
                                            const firstOutline = footprint.shapes.find(s => s.type === "boardOutline");
                                            newAss[layer.id] = firstOutline ? firstOutline.id : "";
                                        }
                                        updateFootprint("boardOutlineAssignments", newAss);
                                    }}
                                />
                                <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                                <span className="layer-name">{layer.name}</span>
                                {!isChecked && otherOutline && (
                                    <small style={{ color: '#888', fontStyle: 'italic', marginLeft: 'auto' }}>
                                        Using: {otherOutline.name}
                                    </small>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>

            <div className="prop-group">
                <label>Name</label>
                <input type="text" value={shape.name} onChange={(e) => updateShape(shape.id, "name", e.target.value)} />
            </div>

            <div className="prop-group">
                <label>Origin X</label>
                <ExpressionEditor value={bo.x} onChange={(val) => updateShape(shape.id, "x", val)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label>Origin Y</label>
                <ExpressionEditor value={bo.y} onChange={(val) => updateShape(shape.id, "y", val)} params={params} placeholder="0" />
            </div>

            <div className="prop-group">
                <label>Outline Points</label>
                <div className="points-list-container">
                    {points.map((p, idx) => (
                        <Fragment key={p.id}>
                            {renderPointEditor(
                                p, 
                                idx, 
                                (newP) => {
                                    const newPoints = [...points];
                                    newPoints[idx] = newP;
                                    updateShape(shape.id, "points", newPoints);
                                },
                                () => {
                                    const newPoints = points.filter((_, i) => i !== idx);
                                    updateShape(shape.id, "points", newPoints);
                                }
                            )}
                            {/* Insert Midpoint Button */}
                            <div 
                                style={{ 
                                    display: "flex", 
                                    justifyContent: "center", 
                                    margin: "5px 0",
                                }}
                            >
                                <button 
                                    onClick={() => addMidpoint(idx)} 
                                    style={{ 
                                        cursor: "pointer", 
                                        padding: "4px 8px", 
                                        fontSize: "0.8rem", 
                                        background: hoveredMidpointIndex === idx ? "#3b5b9d" : "#333", 
                                        border: hoveredMidpointIndex === idx ? "1px solid #646cff" : "1px solid #555", 
                                        color: "#fff", 
                                        borderRadius: "4px",
                                        transition: 'background-color 0.2s, border-color 0.2s',
                                        boxShadow: hoveredMidpointIndex === idx ? "0 0 5px rgba(100, 108, 255, 0.5)" : "none"
                                    }} 
                                    title="Insert Midpoint"
                                    onMouseEnter={() => setHoveredMidpointIndex(idx)}
                                    onMouseLeave={() => setHoveredMidpointIndex(null)}
                                >
                                    + Midpoint
                                </button>
                            </div>
                        </Fragment>
                    ))}
                    <button className="secondary small-btn" onClick={() => {
                            const newPoints = [...points];
                            const last = newPoints[newPoints.length - 1] || { x: "0", y: "0" };
                            newPoints.push({ id: crypto.randomUUID(), x: modifyExpression(last.x, 10), y: modifyExpression(last.y, 0), });
                            updateShape(shape.id, "points", newPoints);
                        }}>+ Add Point</button>
                </div>
            </div>
          </div>
      );
  }

  // POLYGON Properties block
  if (shape?.type === "polygon") {
    const poly = shape as FootprintPolygon;
    const points = poly.points;

    const addMidpoint = (index: number) => {
        const p1 = points[index];
        const p2 = points[(index + 1) % points.length];
        if (!p1 || !p2) return;
        const newPoint: Point = {
            id: crypto.randomUUID(),
            x: calcMid(p1.x, p2.x),
            y: calcMid(p1.y, p2.y)
        };
        const newPoints = [...points];
        newPoints.splice(index + 1, 0, newPoint);
        updateShape(shape.id, "points", newPoints);
    };

    return (
        <div className="properties-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{ margin: 0 }}>POLYGON Properties</h3>
                <button onClick={onDuplicate} title="Duplicate Shape (Ctrl+D)" style={{ padding: '4px 10px', fontSize: '0.9em' }}>
                    Duplicate
                </button>
            </div>

            {/* Lock Toggle */}
            {renderLockToggle(shape.id, shape.locked)}

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
                                <input className="layer-checkbox" type="checkbox" checked={isChecked}
                                    onChange={(e) => {
                                        const newAssignments = { ...(shape.assignedLayers || {}) };
                                        if (e.target.checked) newAssignments[layer.id] = { depth: "0", endmillRadius: "0" }; 
                                        else delete newAssignments[layer.id];
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }}
                                />
                                <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                                <span className="layer-name" title={layer.name}>{layer.name}</span>
                                
                                {isChecked && layer.type === "Carved/Printed" && (
                                    <div className="layer-depth-wrapper">
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Cut Depth</div>
                                                <ExpressionEditor value={assignment.depth} onChange={(val) => {
                                                        const newAssignments = { ...shape.assignedLayers };
                                                        newAssignments[layer.id] = { ...assignment, depth: val };
                                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                                    }} params={params} placeholder="Depth" />
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Ball-nose Endmill Radius</div>
                                                <ExpressionEditor value={assignment.endmillRadius} onChange={(val) => {
                                                        const newAssignments = { ...shape.assignedLayers };
                                                        newAssignments[layer.id] = { ...assignment, endmillRadius: val };
                                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                                    }} params={params} placeholder="0" />
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
                <input type="text" value={shape.name} onChange={(e) => updateShape(shape.id, "name", e.target.value)} />
            </div>

            <div className="prop-group">
                <label>Origin X</label>
                <ExpressionEditor value={poly.x} onChange={(val) => updateShape(shape.id, "x", val)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label>Origin Y</label>
                <ExpressionEditor value={poly.y} onChange={(val) => updateShape(shape.id, "y", val)} params={params} placeholder="0" />
            </div>

            <div className="prop-group">
                <label>Polygon Points</label>
                <div className="points-list-container">
                    {points.map((p, idx) => (
                        <Fragment key={p.id}>
                            {renderPointEditor(
                                p, 
                                idx, 
                                (newP) => {
                                    const newPoints = [...points];
                                    newPoints[idx] = newP;
                                    updateShape(shape.id, "points", newPoints);
                                },
                                () => {
                                    const newPoints = points.filter((_, i) => i !== idx);
                                    updateShape(shape.id, "points", newPoints);
                                }
                            )}
                            <div style={{ display: "flex", justifyContent: "center", margin: "5px 0" }}>
                                <button 
                                    onClick={() => addMidpoint(idx)} 
                                    style={{ 
                                        cursor: "pointer", padding: "4px 8px", fontSize: "0.8rem", 
                                        background: hoveredMidpointIndex === idx ? "#3b5b9d" : "#333", 
                                        border: hoveredMidpointIndex === idx ? "1px solid #646cff" : "1px solid #555", 
                                        color: "#fff", borderRadius: "4px"
                                    }} 
                                    title="Insert Midpoint"
                                    onMouseEnter={() => setHoveredMidpointIndex(idx)}
                                    onMouseLeave={() => setHoveredMidpointIndex(null)}
                                >
                                    + Midpoint
                                </button>
                            </div>
                        </Fragment>
                    ))}
                    <button className="secondary small-btn" onClick={() => {
                            const newPoints = [...points];
                            const last = newPoints[newPoints.length - 1] || { x: "0", y: "0" };
                            newPoints.push({ id: crypto.randomUUID(), x: modifyExpression(last.x, 10), y: modifyExpression(last.y, 0), });
                            updateShape(shape.id, "points", newPoints);
                        }}>+ Add Point</button>
                </div>
            </div>
        </div>
    );
  }

  if (shape?.type === "text") {
    const txt = shape as FootprintText;
    return (
        <div className="properties-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{ margin: 0 }}>COMMENT Properties</h3>
                <button onClick={onDuplicate} style={{ padding: '4px 10px', fontSize: '0.9em' }}>Duplicate</button>
            </div>

            {/* Lock Toggle */}
            {renderLockToggle(shape.id, shape.locked)}

            <div className="prop-group">
                <label>Text Note</label>
                <textarea 
                    value={txt.text}
                    onChange={(e) => updateShape(txt.id, "text", e.target.value)}
                    rows={4}
                    style={{
                        width: "100%", background: "#111", border: "1px solid #444",
                        color: "white", padding: "8px", borderRadius: "4px",
                        fontFamily: "monospace", resize: "vertical"
                    }}
                />
            </div>

            <div className="prop-group">
                <label>X Position</label>
                <ExpressionEditor value={txt.x} onChange={(v) => updateShape(txt.id, "x", v)} params={params} />
            </div>
            <div className="prop-group">
                <label>Y Position</label>
                <ExpressionEditor value={txt.y} onChange={(v) => updateShape(txt.id, "y", v)} params={params} />
            </div>
            <div className="prop-group">
                <label>Rotation</label>
                <ExpressionEditor value={txt.angle} onChange={(v) => updateShape(txt.id, "angle", v)} params={params} />
            </div>
            <div className="prop-group">
                <label>Font Size (mm)</label>
                <ExpressionEditor value={txt.fontSize} onChange={(v) => updateShape(txt.id, "fontSize", v)} params={params} />
            </div>
            <div className="prop-group">
                <label>Alignment</label>
                <select value={txt.anchor} onChange={(e) => updateShape(txt.id, "anchor", e.target.value)}>
                    <option value="start">Left</option>
                    <option value="middle">Center</option>
                    <option value="end">Right</option>
                </select>
            </div>
        </div>
    );
}

  // CHECK FOR MESH SELECTION
  const mesh = footprint.meshes?.find(m => m.id === selectedId);
  if (mesh) {
      const asset = meshAssets.find(a => a.id === mesh.meshId);
      return (
          <div className="properties-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{ margin: 0 }}>Mesh Properties</h3>
                <button onClick={onDuplicate} title="Duplicate Mesh (Ctrl+D)" style={{ padding: '4px 10px', fontSize: '0.9em' }}>
                    Duplicate
                </button>
              </div>
              <div className="prop-group">
                  <label>Name</label>
                  <input type="text" value={mesh.name} onChange={(e) => updateMesh(mesh.id, "name", e.target.value)} />
              </div>

              <div className="prop-group">
                  <label>Format</label>
                  <div style={{ fontSize: '0.9em', color: '#888', textTransform: 'uppercase' }}>{asset?.format || "Unknown"}</div>
              </div>
              
              <div className="prop-group">
                  <label>Rendering Type</label>
                  <select 
                      value={mesh.renderingType} 
                      onChange={(e) => updateMesh(mesh.id, "renderingType", e.target.value)}
                  >
                      <option value="solid">Solid</option>
                      <option value="wireframe">Wireframe</option>
                      <option value="hidden">Hidden</option>
                  </select>
              </div>

              <div className="prop-section">
                  <h4>Position</h4>
                  <div className="prop-group">
                      <label>X (mm)</label>
                      <ExpressionEditor value={mesh.x} onChange={(val) => updateMesh(mesh.id, "x", val)} params={params} placeholder="0" />
                  </div>
                  <div className="prop-group">
                      <label>Y (mm)</label>
                      <ExpressionEditor value={mesh.y} onChange={(val) => updateMesh(mesh.id, "y", val)} params={params} placeholder="0" />
                  </div>
                  <div className="prop-group">
                      <label>Z (mm)</label>
                      <ExpressionEditor value={mesh.z} onChange={(val) => updateMesh(mesh.id, "z", val)} params={params} placeholder="0" />
                  </div>
              </div>

              <div className="prop-section">
                  <h4>Rotation (Degrees)</h4>
                  <div className="prop-group">
                      <label>X Axis</label>
                      <ExpressionEditor value={mesh.rotationX} onChange={(val) => updateMesh(mesh.id, "rotationX", val)} params={params} placeholder="0" />
                  </div>
                  <div className="prop-group">
                      <label>Y Axis</label>
                      <ExpressionEditor value={mesh.rotationY} onChange={(val) => updateMesh(mesh.id, "rotationY", val)} params={params} placeholder="0" />
                  </div>
                  <div className="prop-group">
                      <label>Z Axis</label>
                      <ExpressionEditor value={mesh.rotationZ} onChange={(val) => updateMesh(mesh.id, "rotationZ", val)} params={params} placeholder="0" />
                  </div>
              </div>
          </div>
      );
  }

  if (!shape) return null;

  // Header common to all remaining shape types
  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h3 style={{ margin: 0 }}>{shape.type.toUpperCase()} Properties</h3>
        <button onClick={onDuplicate} title="Duplicate Shape (Ctrl+D)" style={{ padding: '4px 10px', fontSize: '0.9em' }}>
            Duplicate
        </button>
    </div>
  );

  const handleConvertToPolygon = () => {
      if (shape.type !== 'rect' || !onConvertShape) return;
      
      const rect = shape as FootprintRect;
      const polyPoints = convertRectToPolyPoints(rect, params);
      
      const newPoly: FootprintPolygon = {
          id: rect.id, 
          type: "polygon",
          name: rect.name.replace("New Rect", "Converted Polygon"),
          x: "0",
          y: "0",
          assignedLayers: rect.assignedLayers,
          points: polyPoints
      };
      
      onConvertShape(rect.id, newPoly);
  };

  // NEW: Wire Guide Properties
  if (shape.type === "wireGuide") {
      const wg = shape as FootprintWireGuide;
      return (
        <div className="properties-panel">
            {header}
            {renderLockToggle(shape.id, shape.locked)}
            <div className="prop-group">
                <label>Name</label>
                <input type="text" value={wg.name} onChange={(e) => updateShape(wg.id, "name", e.target.value)} />
            </div>
            <div className="prop-group">
                <label>X Position</label>
                <ExpressionEditor value={wg.x} onChange={(v) => updateShape(wg.id, "x", v)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label>Y Position</label>
                <ExpressionEditor value={wg.y} onChange={(v) => updateShape(wg.id, "y", v)} params={params} placeholder="0" />
            </div>
            
            <div className="prop-section">
                 <h4>Flow Direction Handle</h4>
                 <div className="point-controls-toggles">
                    <label className="checkbox-label">
                        <input type="checkbox" checked={!!wg.handle} onChange={(e) => {
                             if (e.target.checked) updateShape(wg.id, "handle", { x: "5", y: "0" });
                             else updateShape(wg.id, "handle", undefined);
                        }} /> Enable Direction
                    </label>
                </div>
                {wg.handle && (
                    <div className="handle-sub-block">
                         <div className="sub-label">Flow Vector (Relative)</div>
                         <div className="handle-inputs">
                             <div className="mini-input"><span>dX</span><ExpressionEditor value={wg.handle.x} onChange={(v) => updateShape(wg.id, "handle", {...wg.handle, x:v})} params={params}/></div>
                             <div className="mini-input"><span>dY</span><ExpressionEditor value={wg.handle.y} onChange={(v) => updateShape(wg.id, "handle", {...wg.handle, y:v})} params={params}/></div>
                         </div>
                    </div>
                )}
            </div>
            <div className="prop-group">
                <small style={{color: '#888'}}>Wire guides are virtual and do not appear in exports. Snapped points will flow through this guide along the vector.</small>
            </div>
        </div>
      );
  }

  // Footprint Reference Properties
  if (shape.type === "footprint") {
      const refShape = shape as FootprintReference;
      const target = allFootprints.find(f => f.id === refShape.footprintId);

      return (
        <div className="properties-panel">
            {header}
            {renderLockToggle(shape.id, shape.locked)}
            <div className="prop-group">
                <label>Reference</label>
                <div style={{ padding: '8px', background: '#333', borderRadius: '4px', color: '#fff', fontSize: '0.9em', border: '1px solid #444', marginBottom: '10px' }}>
                   {target?.name || <span style={{color:'red'}}>Unknown (Deleted?)</span>}
                </div>
                <button 
                  style={{ width: '100%' }} 
                  onClick={() => target && onEditChild(target.id)}
                  disabled={!target}
                >
                  Edit Source Footprint
                </button>
            </div>
            <div className="prop-group">
                <label>Name (Alias)</label>
                <input type="text" value={shape.name} onChange={(e) => updateShape(shape.id, "name", e.target.value)} />
            </div>
            <div className="prop-group">
                <label>Center X</label>
                <ExpressionEditor value={refShape.x} onChange={(val) => updateShape(shape.id, "x", val)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label>Center Y</label>
                <ExpressionEditor value={refShape.y} onChange={(val) => updateShape(shape.id, "y", val)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label>Rotation (deg)</label>
                <ExpressionEditor value={refShape.angle} onChange={(val) => updateShape(shape.id, "angle", val)} params={params} placeholder="0" />
            </div>
            <div className="prop-group">
                <label style={{color: '#666', fontStyle: 'italic', fontSize: '0.85em'}}>
                    Note: Layers assigned within the referenced footprint are preserved. Recursion is visual only.
                </label>
            </div>
        </div>
      );
  }

  if (shape.type === "union") {
      const u = shape as FootprintUnion;
      return (
        <div className="properties-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <h3 style={{ margin: 0 }}>UNION Properties</h3>
                <button onClick={onDuplicate} title="Duplicate Union" style={{ padding: '4px 10px', fontSize: '0.9em' }}>Duplicate</button>
            </div>

            {renderLockToggle(shape.id, shape.locked)}

            <div className="prop-group">
                <button className="secondary" onClick={() => onUngroup && onUngroup(u.id)} style={{ width: '100%' }}>
                    Ungroup
                </button>
            </div>

            {/* Layer Assignments (Overrides) */}
            <div className="prop-section">
                <h4>Layer Overrides</h4>
                <div className="layer-list">
                    {stackup.map((layer: StackupLayer) => {
                        const isChecked = shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined;
                        const assignment = isChecked ? (shape.assignedLayers[layer.id] as LayerAssignment) : { depth: "0", endmillRadius: "0" };
                        
                        return (
                            <div key={layer.id} className="layer-assignment-row">
                                <input className="layer-checkbox" type="checkbox" checked={isChecked}
                                    onChange={(e) => {
                                        const newAssignments = { ...(shape.assignedLayers || {}) };
                                        if (e.target.checked) newAssignments[layer.id] = { depth: "0", endmillRadius: "0" }; 
                                        else delete newAssignments[layer.id];
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }}
                                />
                                <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                                <span className="layer-name">{layer.name}</span>
                                {isChecked && layer.type === "Carved/Printed" && (
                                    <div className="layer-depth-wrapper">
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Override Depth</div>
                                                <ExpressionEditor value={assignment.depth} onChange={(val) => {
                                                        const newAssignments = { ...shape.assignedLayers };
                                                        newAssignments[layer.id] = { ...assignment, depth: val };
                                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                                    }} params={params} placeholder="Depth" />
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Override Endmill Radius</div>
                                                <ExpressionEditor value={assignment.endmillRadius} onChange={(val) => {
                                                        const newAssignments = { ...shape.assignedLayers };
                                                        newAssignments[layer.id] = { ...assignment, endmillRadius: val };
                                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                                    }} params={params} placeholder="0" />
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
                <input type="text" value={u.name} onChange={(e) => updateShape(u.id, "name", e.target.value)} />
            </div>
            <div className="prop-group">
                <label>Origin X</label>
                <ExpressionEditor value={u.x} onChange={(val) => updateShape(u.id, "x", val)} params={params} />
            </div>
            <div className="prop-group">
                <label>Origin Y</label>
                <ExpressionEditor value={u.y} onChange={(val) => updateShape(u.id, "y", val)} params={params} />
            </div>
            <div className="prop-group">
                <label>Rotation</label>
                <ExpressionEditor value={u.angle} onChange={(val) => updateShape(u.id, "angle", val)} params={params} />
            </div>
            
            <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                <p style={{fontSize: '0.85em', color: '#888'}}>
                    Contains {u.shapes.length} shapes. Ungroup to edit individual children.
                </p>
            </div>
        </div>
      );
  }

  // --- STANDARD SHAPES PROPERTIES ---
  return (
    <div className="properties-panel">
      {header}
      {renderLockToggle(shape.id, shape.locked)}
      
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
                  <input className="layer-checkbox" type="checkbox" checked={isChecked}
                    onChange={(e) => {
                        const newAssignments = { ...(shape.assignedLayers || {}) };
                        if (e.target.checked) newAssignments[layer.id] = { depth: "0", endmillRadius: "0" }; 
                        else delete newAssignments[layer.id];
                        updateShape(shape.id, "assignedLayers", newAssignments);
                    }}
                  />
                  <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                  <span className="layer-name" title={layer.name}>{layer.name}</span>
                
                {isChecked && layer.type === "Carved/Printed" && (
                    <div className="layer-depth-wrapper">
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Cut Depth</div>
                                <ExpressionEditor value={assignment.depth} onChange={(val) => {
                                        const newAssignments = { ...shape.assignedLayers };
                                        newAssignments[layer.id] = { ...assignment, depth: val };
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }} params={params} placeholder="Depth" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Ball-nose Endmill Radius</div>
                                <ExpressionEditor value={assignment.endmillRadius} onChange={(val) => {
                                        const newAssignments = { ...shape.assignedLayers };
                                        newAssignments[layer.id] = { ...assignment, endmillRadius: val };
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }} params={params} placeholder="0" />
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
        <input type="text" value={shape.name} onChange={(e) => updateShape(shape.id, "name", e.target.value)} />
      </div>

      {shape.type !== "line" && (
        <>
          <div className="prop-group">
            <label>Center X</label>
            <ExpressionEditor value={(shape as FootprintCircle | FootprintRect).x} onChange={(val) => updateShape(shape.id, "x", val)} params={params} placeholder="0" />
          </div>
          <div className="prop-group">
            <label>Center Y</label>
            <ExpressionEditor value={(shape as FootprintCircle | FootprintRect).y} onChange={(val) => updateShape(shape.id, "y", val)} params={params} placeholder="0" />
          </div>
        </>
      )}

      {shape.type === "circle" && (
        <div className="prop-group">
          <label>Diameter</label>
          <ExpressionEditor value={(shape as FootprintCircle).diameter} onChange={(val) => updateShape(shape.id, "diameter", val)} params={params} placeholder="10" />
        </div>
      )}

      {shape.type === "rect" && (
        <>
          <div className="prop-group">
            <label>Width</label>
            <ExpressionEditor value={(shape as FootprintRect).width} onChange={(val) => updateShape(shape.id, "width", val)} params={params} placeholder="10" />
          </div>
          <div className="prop-group">
            <label>Height</label>
            <ExpressionEditor value={(shape as FootprintRect).height} onChange={(val) => updateShape(shape.id, "height", val)} params={params} placeholder="10" />
          </div>
          <div className="prop-group">
            <label>Angle (deg)</label>
            <ExpressionEditor value={(shape as FootprintRect).angle} onChange={(val) => updateShape(shape.id, "angle", val)} params={params} placeholder="0" />
          </div>
          <div className="prop-group">
            <label>Corner Radius</label>
            <ExpressionEditor value={(shape as FootprintRect).cornerRadius} onChange={(val) => updateShape(shape.id, "cornerRadius", val)} params={params} placeholder="0" />
          </div>

          <div style={{ marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px' }}>
              <button onClick={handleConvertToPolygon} style={{ width: '100%', backgroundColor: '#2d4b38', border: '1px solid #487e5b' }}>
                  Convert to Polygon
              </button>
              <div style={{ fontSize: '0.8em', color: '#888', marginTop: '5px' }}>
                  Bakes rotation and radius into editable points.
              </div>
          </div>
        </>
      )}

      {shape.type === "line" && (
        <>
            <div className="prop-group">
                <label>Thickness</label>
                <ExpressionEditor value={(shape as FootprintLine).thickness} onChange={(val) => updateShape(shape.id, "thickness", val)} params={params} placeholder="1" />
            </div>
            
            <div className="prop-group">
                <label>Points</label>
                <div className="points-list-container">
                    {(shape as FootprintLine).points.map((p, idx) => (
                        <Fragment key={p.id}>
                            {renderPointEditor(
                                p, 
                                idx, 
                                (newP) => {
                                    const newPoints = [...(shape as FootprintLine).points];
                                    newPoints[idx] = newP;
                                    updateShape(shape.id, "points", newPoints);
                                },
                                () => {
                                    const newPoints = (shape as FootprintLine).points.filter((_, i) => i !== idx);
                                    updateShape(shape.id, "points", newPoints);
                                }
                            )}
                            {idx < (shape as FootprintLine).points.length - 1 && (
                                <div 
                                    style={{ 
                                        display: "flex", 
                                        justifyContent: "center", 
                                        margin: "5px 0",
                                    }}
                                >
                                    <button 
                                        onClick={() => {
                                            const newPoints = [...(shape as FootprintLine).points];
                                            const p1 = newPoints[idx];
                                            const p2 = newPoints[idx + 1];
                                            const newPoint = { id: crypto.randomUUID(), x: calcMid(p1.x, p2.x), y: calcMid(p1.y, p2.y) };
                                            newPoints.splice(idx + 1, 0, newPoint);
                                            updateShape(shape.id, "points", newPoints);
                                        }} 
                                        style={{ 
                                            cursor: "pointer", 
                                            padding: "4px 8px", 
                                            fontSize: "0.8rem", 
                                            background: hoveredMidpointIndex === idx ? "#3b5b9d" : "#333", 
                                            border: hoveredMidpointIndex === idx ? "1px solid #646cff" : "1px solid #555", 
                                            color: "#fff", 
                                            borderRadius: "4px",
                                            transition: 'background-color 0.2s, border-color 0.2s',
                                            boxShadow: hoveredMidpointIndex === idx ? "0 0 5px rgba(100, 108, 255, 0.5)" : "none"
                                        }} 
                                        title="Insert Midpoint"
                                        onMouseEnter={() => setHoveredMidpointIndex(idx)}
                                        onMouseLeave={() => setHoveredMidpointIndex(null)}
                                    >
                                        + Midpoint
                                    </button>
                                </div>
                            )}
                        </Fragment>
                    ))}
                    <button className="secondary small-btn" onClick={() => {
                            const newPoints = [...(shape as FootprintLine).points];
                            const last = newPoints[newPoints.length - 1] || { x: "0", y: "0" };
                            newPoints.push({ id: crypto.randomUUID(), x: modifyExpression(last.x, 5), y: modifyExpression(last.y, 5), });
                            updateShape(shape.id, "points", newPoints);
                        }}>+ Add Point</button>
                </div>
            </div>
        </>
      )}
    </div>
  );
};

export default FootprintPropertiesPanel;