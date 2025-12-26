// src/components/PropertiesPanel.tsx
import React, { Fragment } from "react";
import { Footprint, FootprintShape, Parameter, StackupLayer, Point, LayerAssignment, FootprintReference, FootprintCircle, FootprintRect, FootprintLine } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import { BOARD_OUTLINE_ID, modifyExpression, calcMid } from "../utils/footprintUtils";

const PropertiesPanel = ({
  footprint,
  allFootprints,
  selectedId,
  updateShape,
  updateFootprint,
  params,
  stackup,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedId: string | null;
  updateShape: (id: string, field: string, val: any) => void;
  updateFootprint: (field: string, val: any) => void;
  params: Parameter[];
  stackup: StackupLayer[];
}) => {
  // SPECIAL CASE: Board Outline
  if (selectedId === BOARD_OUTLINE_ID && footprint.isBoard && footprint.boardOutline) {
      const points = footprint.boardOutline;
      const addMidpoint = (index: number) => {
          const p1 = points[index];
          const p2 = points[index + 1];
          if (!p1 || !p2) return;
          const newPoint: Point = {
              id: crypto.randomUUID(),
              x: calcMid(p1.x, p2.x),
              y: calcMid(p1.y, p2.y)
          };
          const newPoints = [...points];
          newPoints.splice(index + 1, 0, newPoint);
          updateFootprint("boardOutline", newPoints);
      };

      return (
          <div className="properties-panel">
            <h3>Board Outline</h3>
            <div className="prop-group">
                <label>Outline Points</label>
                <div className="points-list-container">
                    {points.map((p, idx) => (
                        <Fragment key={p.id}>
                        <div className="point-block">
                             <div className="point-header">
                                <span>Point {idx + 1}</span>
                                <button className="icon-btn danger" onClick={() => {
                                        const newPoints = points.filter((_, i) => i !== idx);
                                        updateFootprint("boardOutline", newPoints);
                                    }} disabled={points.length <= 3} title="Remove Point">×</button>
                            </div>
                            <div className="point-row full">
                                <span className="label">X</span>
                                <ExpressionEditor value={p.x} onChange={(val) => {
                                        const newPoints = [...points];
                                        newPoints[idx] = { ...p, x: val };
                                        updateFootprint("boardOutline", newPoints);
                                    }} params={params} placeholder="X" />
                            </div>
                            <div className="point-row full">
                                <span className="label">Y</span>
                                <ExpressionEditor value={p.y} onChange={(val) => {
                                        const newPoints = [...points];
                                        newPoints[idx] = { ...p, y: val };
                                        updateFootprint("boardOutline", newPoints);
                                    }} params={params} placeholder="Y" />
                            </div>
                            <div className="point-controls-toggles">
                                <label className="checkbox-label">
                                    <input type="checkbox" checked={!!p.handleIn} onChange={(e) => {
                                            const newPoints = [...points];
                                            if (e.target.checked) newPoints[idx] = { ...p, handleIn: { x: "-5", y: "0" } };
                                            else { const pt = { ...p }; delete pt.handleIn; newPoints[idx] = pt; }
                                            updateFootprint("boardOutline", newPoints);
                                        }} /> In Handle
                                </label>
                                <label className="checkbox-label">
                                    <input type="checkbox" checked={!!p.handleOut} onChange={(e) => {
                                            const newPoints = [...points];
                                            if (e.target.checked) newPoints[idx] = { ...p, handleOut: { x: "5", y: "0" } };
                                            else { const pt = { ...p }; delete pt.handleOut; newPoints[idx] = pt; }
                                            updateFootprint("boardOutline", newPoints);
                                        }} /> Out Handle
                                </label>
                            </div>
                            {p.handleIn && (
                                <div className="handle-sub-block">
                                    <div className="sub-label">Handle In (Relative)</div>
                                    <div className="handle-inputs">
                                        <div className="mini-input">
                                            <span>dX</span>
                                            <ExpressionEditor value={p.handleIn.x} onChange={(val) => {
                                                    const newPoints = [...points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.x = val;
                                                        updateFootprint("boardOutline", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor value={p.handleIn.y} onChange={(val) => {
                                                    const newPoints = [...points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.y = val;
                                                        updateFootprint("boardOutline", newPoints);
                                                    }
                                                }} params={params} />
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
                                            <ExpressionEditor value={p.handleOut.x} onChange={(val) => {
                                                    const newPoints = [...points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.x = val;
                                                        updateFootprint("boardOutline", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor value={p.handleOut.y} onChange={(val) => {
                                                    const newPoints = [...points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.y = val;
                                                        updateFootprint("boardOutline", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        {idx < points.length - 1 && (
                            <div style={{ display: "flex", justifyContent: "center", margin: "5px 0" }}>
                                <button onClick={() => addMidpoint(idx)} style={{ cursor: "pointer", padding: "4px 8px", fontSize: "0.8rem", background: "#333", border: "1px solid #555", color: "#fff", borderRadius: "4px" }} title="Insert Midpoint">+ Midpoint</button>
                            </div>
                        )}
                        </Fragment>
                    ))}
                    <button className="secondary small-btn" onClick={() => {
                            const newPoints = [...points];
                            const last = newPoints[newPoints.length - 1] || { x: "0", y: "0" };
                            newPoints.push({ id: crypto.randomUUID(), x: modifyExpression(last.x, 10), y: modifyExpression(last.y, 0), });
                            updateFootprint("boardOutline", newPoints);
                        }}>+ Add Point</button>
                </div>
            </div>
          </div>
      );
  }

  const shape = footprint.shapes.find(s => s.id === selectedId);
  if (!shape) return null;

  // NEW: Footprint Reference Properties
  if (shape.type === "footprint") {
      const refShape = shape as FootprintReference;
      const target = allFootprints.find(f => f.id === refShape.footprintId);

      return (
        <div className="properties-panel">
            <h3>Recursive Footprint</h3>
            <div className="prop-group">
                <label>Reference</label>
                <div style={{ padding: '8px', background: '#333', borderRadius: '4px', color: '#fff', fontSize: '0.9em', border: '1px solid #444' }}>
                   {target?.name || <span style={{color:'red'}}>Unknown (Deleted?)</span>}
                </div>
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

  // --- STANDARD SHAPES PROPERTIES ---
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
                        <div style={{ display: 'flex', gap: '5px' }}>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Depth</div>
                                <ExpressionEditor value={assignment.depth} onChange={(val) => {
                                        const newAssignments = { ...shape.assignedLayers };
                                        newAssignments[layer.id] = { ...assignment, depth: val };
                                        updateShape(shape.id, "assignedLayers", newAssignments);
                                    }} params={params} placeholder="Depth" />
                            </div>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.7em', color: '#888', marginBottom: '2px' }}>Radius</div>
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
                        <div className="point-block">
                            <div className="point-header">
                                <span>Point {idx + 1}</span>
                                <button className="icon-btn danger" onClick={() => {
                                        const newPoints = (shape as FootprintLine).points.filter((_, i) => i !== idx);
                                        updateShape(shape.id, "points", newPoints);
                                    }} title="Remove Point">×</button>
                            </div>
                            <div className="point-row full">
                                <span className="label">X</span>
                                <ExpressionEditor value={p.x} onChange={(val) => {
                                        const newPoints = [...(shape as FootprintLine).points];
                                        newPoints[idx] = { ...p, x: val };
                                        updateShape(shape.id, "points", newPoints);
                                    }} params={params} placeholder="X" />
                            </div>
                            <div className="point-row full">
                                <span className="label">Y</span>
                                <ExpressionEditor value={p.y} onChange={(val) => {
                                        const newPoints = [...(shape as FootprintLine).points];
                                        newPoints[idx] = { ...p, y: val };
                                        updateShape(shape.id, "points", newPoints);
                                    }} params={params} placeholder="Y" />
                            </div>
                            <div className="point-controls-toggles">
                                <label className="checkbox-label">
                                    <input type="checkbox" checked={!!p.handleIn} onChange={(e) => {
                                            const newPoints = [...(shape as FootprintLine).points];
                                            if (e.target.checked) newPoints[idx] = { ...p, handleIn: { x: "-5", y: "0" } };
                                            else { const pt = { ...p }; delete pt.handleIn; newPoints[idx] = pt; }
                                            updateShape(shape.id, "points", newPoints);
                                        }} /> In Handle
                                </label>
                                <label className="checkbox-label">
                                    <input type="checkbox" checked={!!p.handleOut} onChange={(e) => {
                                            const newPoints = [...(shape as FootprintLine).points];
                                            if (e.target.checked) newPoints[idx] = { ...p, handleOut: { x: "5", y: "0" } };
                                            else { const pt = { ...p }; delete pt.handleOut; newPoints[idx] = pt; }
                                            updateShape(shape.id, "points", newPoints);
                                        }} /> Out Handle
                                </label>
                            </div>
                            {p.handleIn && (
                                <div className="handle-sub-block">
                                    <div className="sub-label">Handle In (Relative)</div>
                                    <div className="handle-inputs">
                                        <div className="mini-input">
                                            <span>dX</span>
                                            <ExpressionEditor value={p.handleIn.x} onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.x = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor value={p.handleIn.y} onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleIn) {
                                                        newPoints[idx].handleIn!.y = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }} params={params} />
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
                                            <ExpressionEditor value={p.handleOut.x} onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.x = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                        <div className="mini-input">
                                            <span>dY</span>
                                            <ExpressionEditor value={p.handleOut.y} onChange={(val) => {
                                                    const newPoints = [...(shape as FootprintLine).points];
                                                    if (newPoints[idx].handleOut) {
                                                        newPoints[idx].handleOut!.y = val;
                                                        updateShape(shape.id, "points", newPoints);
                                                    }
                                                }} params={params} />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        {idx < (shape as FootprintLine).points.length - 1 && (
                            <div style={{ display: "flex", justifyContent: "center", margin: "5px 0" }}>
                                <button onClick={() => {
                                        const newPoints = [...(shape as FootprintLine).points];
                                        const p1 = newPoints[idx];
                                        const p2 = newPoints[idx + 1];
                                        const newPoint = { id: crypto.randomUUID(), x: calcMid(p1.x, p2.x), y: calcMid(p1.y, p2.y) };
                                        newPoints.splice(idx + 1, 0, newPoint);
                                        updateShape(shape.id, "points", newPoints);
                                    }} style={{ cursor: "pointer", padding: "4px 8px", fontSize: "0.8rem", background: "#333", border: "1px solid #555", color: "#fff", borderRadius: "4px" }} title="Insert Midpoint">+ Midpoint</button>
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

export default PropertiesPanel;