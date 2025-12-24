// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import * as math from "mathjs";
import { Footprint, FootprintShape, Parameter, FootprintCircle, FootprintRect, FootprintLine, StackupLayer, Point } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
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

export function modifyExpression(expression: string, delta: number): string {
  if (delta === 0) return expression;
  
  let trimmed = expression ? expression.trim() : "0";
  if (trimmed === "") trimmed = "0";

  // Check for simple number (integer or float)
  if (/^[-+]?[0-9]*\.?[0-9]+$/.test(trimmed)) {
      const val = parseFloat(trimmed);
      if (!isNaN(val)) {
          return parseFloat((val + delta).toFixed(4)).toString();
      }
  }

  // Check for ends with "+ number"
  const plusMatch = trimmed.match(/^(.*)\+\s*([0-9]*\.?[0-9]+)$/);
  if (plusMatch) {
      const prefix = plusMatch[1];
      const numStr = plusMatch[2];
      const val = parseFloat(numStr);
      if (!isNaN(val)) {
          const newVal = val + delta;
          if (newVal >= 0) {
              return `${prefix}+ ${parseFloat(newVal.toFixed(4))}`;
          } else {
              return `${prefix}- ${parseFloat(Math.abs(newVal).toFixed(4))}`;
          }
      }
  }

  // Check for ends with "- number"
  const minusMatch = trimmed.match(/^(.*)\-\s*([0-9]*\.?[0-9]+)$/);
  if (minusMatch) {
      const prefix = minusMatch[1];
      const numStr = minusMatch[2];
      const val = parseFloat(numStr);
      if (!isNaN(val)) {
          // Expression: prefix - val
          // New: prefix - val + delta  => prefix - (val - delta)
          const newVal = val - delta;
          if (newVal >= 0) {
               return `${prefix}- ${parseFloat(newVal.toFixed(4))}`;
          } else {
               // val - delta is negative (e.g. 5 - 10 = -5).
               // prefix - (-5) => prefix + 5
               return `${prefix}+ ${parseFloat(Math.abs(newVal).toFixed(4))}`;
          }
      }
  }

  // Fallback: Append + delta
  const absDelta = Math.abs(delta);
  const fmtDelta = parseFloat(absDelta.toFixed(4));
  if (delta >= 0) {
      return `${trimmed} + ${fmtDelta}`;
  } else {
      return `${trimmed} - ${fmtDelta}`;
  }
}

// Evaluate math expressions to numbers (for visualization only)
export function evaluateExpression(expression: string, params: Parameter[]): number {
  if (!expression || !expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      // Treat parameters as pure numbers in mm to allow mixed arithmetic (e.g. "Width + 5")
      const val = p.unit === "in" ? p.value * 25.4 : p.value;
      scope[p.key] = val;
    });
    const result = math.evaluate(expression, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0; // Return 0 on error for visualizer
  }
}

function interpolateColor(hex: string, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  // If full depth, plain black
  if (r === 1) return "black";
  // If 0 depth, pure layer color
  if (r === 0) return hex;

  let c = hex.trim();
  if (c.startsWith("#")) c = c.substring(1);
  if (c.length === 3) c = c.split("").map(char => char + char).join("");
  // Fallback
  if (c.length !== 6) return "black";

  const num = parseInt(c, 16);
  const red = (num >> 16) & 0xff;
  const green = (num >> 8) & 0xff;
  const blue = num & 0xff;

  // Mix with black (0,0,0) -> target = color * (1-r)
  const f = 1 - r;
  return `rgb(${Math.round(red * f)}, ${Math.round(green * f)}, ${Math.round(blue * f)})`;
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

// 1. SHAPE RENDERER (SVG)
const ShapeRenderer = ({
  shape,
  isSelected,
  params,
  stackup,
  onShapeDown,
  onHandleDown,
}: {
  shape: FootprintShape;
  isSelected: boolean;
  params: Parameter[];
  stackup: StackupLayer[];
  onShapeDown: (e: React.MouseEvent, id: string, pointIndex?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => void;
}) => {
  // Default styles (unassigned)
  let fill = isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)";
  let stroke = isSelected ? "#646cff" : "#888";
  let strokeWidth = isSelected ? 2 : 1;
  const vectorEffect = "non-scaling-stroke";

  // Calculate Color based on highest layer
  const assigned = shape.assignedLayers || {};
  // Find highest layer (first in stackup list) that is assigned
  const highestLayer = stackup.find(l => assigned[l.id] !== undefined);

  if (highestLayer) {
      stroke = highestLayer.color;
      // Make selection bolder since we use layer color for stroke
      strokeWidth = isSelected ? 3 : 2;

      if (highestLayer.type === "Cut") {
          // Cut Layer: Solid black with outline in layer color
          fill = "black";
      } else {
          // Carved/Printed Layer: Outline in layer color, center fades to black based on depth
          const depthVal = evaluateExpression(assigned[highestLayer.id], params);
          const thickVal = evaluateExpression(highestLayer.thicknessExpression, params);
          // Avoid divide by zero
          const ratio = (thickVal > 0.0001) ? (depthVal / thickVal) : 0;
          
          fill = interpolateColor(highestLayer.color, ratio);
      }
  }

  const commonProps = {
    onMouseDown: (e: React.MouseEvent) => {
      onShapeDown(e, shape.id);
    },
    fill,
    stroke,
    strokeWidth,
    vectorEffect,
    style: { cursor: "pointer" },
  };

  if (shape.type === "circle") {
    const r = evaluateExpression(shape.diameter, params) / 2;
    const cx = evaluateExpression(shape.x, params);
    const cy = evaluateExpression(shape.y, params);
    return <circle cx={cx} cy={-cy} r={r} {...commonProps} />;
  }

  if (shape.type === "rect") {
    const w = evaluateExpression(shape.width, params);
    const h = evaluateExpression(shape.height, params);
    const x = evaluateExpression(shape.x, params);
    const y = evaluateExpression(shape.y, params);
    const angle = evaluateExpression(shape.angle, params);
    const rawCr = evaluateExpression((shape as FootprintRect).cornerRadius, params);
    const cr = Math.max(0, Math.min(rawCr, Math.min(w, h) / 2));
    
    return (
      <rect
        x={x - w / 2}
        y={-y - h / 2}
        width={w}
        height={h}
        rx={cr}
        ry={cr}
        transform={`rotate(${-angle}, ${x}, ${-y})`}
        {...commonProps}
      />
    );
  }

  if (shape.type === "line") {
      const thickness = evaluateExpression(shape.thickness, params);
      
      // Pre-evaluate all points
      const pts = shape.points.map(p => ({
          x: evaluateExpression(p.x, params),
          y: evaluateExpression(p.y, params),
          hIn: p.handleIn ? { 
              x: evaluateExpression(p.handleIn.x, params), 
              y: evaluateExpression(p.handleIn.y, params) 
          } : null,
          hOut: p.handleOut ? { 
              x: evaluateExpression(p.handleOut.x, params), 
              y: evaluateExpression(p.handleOut.y, params) 
          } : null
      }));

      // Construct SVG Path 'd'
      let d = "";
      if (pts.length > 0) {
          d = `M ${pts[0].x} ${-pts[0].y}`;
          
          for (let i = 0; i < pts.length - 1; i++) {
              const curr = pts[i];
              const next = pts[i+1];
              
              // Handle Out for current point (Control Point 1)
              // If no handle, use current point
              const cp1x = curr.x + (curr.hOut?.x || 0);
              const cp1y = -(curr.y + (curr.hOut?.y || 0));

              // Handle In for next point (Control Point 2)
              // If no handle, use next point
              const cp2x = next.x + (next.hIn?.x || 0);
              const cp2y = -(next.y + (next.hIn?.y || 0));
              
              const endX = next.x;
              const endY = -next.y;

              d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
          }
      }

      // Render Handles only if selected
      const handles = isSelected ? pts.map((pt, idx) => {
          const elements = [];
          
          // Anchor Point
          elements.push(
              <circle 
                  key={`anchor-${idx}`}
                  cx={pt.x} cy={-pt.y} r={3/strokeWidth} // Scale radius slightly with zoom 
                  fill="#fff" stroke="#646cff" strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  onMouseDown={(e) => {
                      e.stopPropagation();
                      onShapeDown(e, shape.id, idx);
                  }}
              />
          );

          // Handle In
          if (pt.hIn) {
              const hx = pt.x + pt.hIn.x;
              const hy = -(pt.y + pt.hIn.y);
              elements.push(
                  <line 
                      key={`line-in-${idx}`}
                      x1={pt.x} y1={-pt.y} x2={hx} y2={hy}
                      stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke"
                  />,
                  <circle 
                      key={`handle-in-${idx}`}
                      cx={hx} cy={hy} r={2.5/strokeWidth}
                      fill="#646cff"
                      vectorEffect="non-scaling-stroke"
                      style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onHandleDown(e, shape.id, idx, 'in');
                      }}
                  />
              );
          }

          // Handle Out
          if (pt.hOut) {
              const hx = pt.x + pt.hOut.x;
              const hy = -(pt.y + pt.hOut.y);
              elements.push(
                  <line 
                      key={`line-out-${idx}`}
                      x1={pt.x} y1={-pt.y} x2={hx} y2={hy}
                      stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke"
                  />,
                  <circle 
                      key={`handle-out-${idx}`}
                      cx={hx} cy={hy} r={2.5/strokeWidth}
                      fill="#646cff"
                      vectorEffect="non-scaling-stroke"
                      style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        onHandleDown(e, shape.id, idx, 'out');
                      }}
                  />
              );
          }
          return elements;
      }) : null;

      return (
          <g>
            <path 
                d={d} 
                {...commonProps} 
                fill="none" 
                strokeWidth={thickness} 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                vectorEffect={undefined} 
                style={{ ...commonProps.style, opacity: isSelected ? 1 : 0.8 }}
            />
            {handles}
          </g>
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
                                                    // Ensure object exists
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
                            // Add new point slightly offset from last one
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

// 3. LAYER VISIBILITY PANEL (NEW)
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
        {/* Unassigned Layer */}
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

        {/* Stackup Layers */}
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

// 4. SHAPE LIST PANEL
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
            {/* Colored squares for assigned layers */}
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
  
  // Keep a ref to the latest footprint to access it inside event listeners without staleness
  const footprintRef = useRef(footprint);
  useEffect(() => {
    footprintRef.current = footprint;
  }, [footprint]);

  // Layer Visibility State: undefined/true = visible, false = hidden
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  // Viewport state for zooming/panning
  const [viewBox, setViewBox] = useState({ x: -50, y: -50, width: 100, height: 100 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);
  
  // Ref for 3D View to control camera
  const footprint3DRef = useRef<Footprint3DViewHandle>(null);

  // Dragging State Refs (Canvas Pan)
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedShapeId = useRef<string | null>(null);

  // Shape Dragging State Refs (Moving Components)
  const isShapeDragging = useRef(false);
  const shapeDragStartPos = useRef({ x: 0, y: 0 });
  // Store the FULL shape object state at start of drag
  const shapeDragStartData = useRef<FootprintShape | null>(null);
  
  // Drag Target Info
  const dragTargetRef = useRef<{ 
      id: string; 
      pointIdx?: number; 
      handleType?: 'in' | 'out'; 
  } | null>(null);


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

  // --- PAN HANDLERS ---
  
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

  // --- SHAPE DRAG HANDLERS ---

  const handleShapeMouseDown = (e: React.MouseEvent, id: string, pointIndex?: number) => {
      // Stop propagation to prevent Panning from starting
      e.stopPropagation(); 
      e.preventDefault();

      if (viewMode !== "2D") return;

      // Select the shape
      setSelectedShapeId(id);
      
      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;

      // Initialize Drag State
      isShapeDragging.current = true;
      dragTargetRef.current = { id, pointIdx: pointIndex }; // type undefined = entire shape/anchor

      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      
      // Deep clone to store initial state
      shapeDragStartData.current = JSON.parse(JSON.stringify(shape));

      // Attach Global Listeners for Dragging
      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleHandleMouseDown = (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => {
      e.stopPropagation();
      e.preventDefault();
      
      if (viewMode !== "2D") return;

      setSelectedShapeId(id);
      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;

      isShapeDragging.current = true;
      dragTargetRef.current = { id, pointIdx: pointIndex, handleType: type };
      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      shapeDragStartData.current = JSON.parse(JSON.stringify(shape));

      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleShapeMouseMove = (e: MouseEvent) => {
      if (!isShapeDragging.current || !wrapperRef.current || !dragTargetRef.current || !shapeDragStartData.current) return;

      const rect = wrapperRef.current.getBoundingClientRect();
      const scaleX = viewBoxRef.current.width / rect.width;
      const scaleY = viewBoxRef.current.height / rect.height;

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
                      // Dragging a Control Handle (Relative update)
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
                      // Dragging a specific Point (Line vertex)
                      const p = newPoints[pointIdx];
                      newPoints[pointIdx] = {
                          ...p,
                          x: modifyExpression(p.x, dxWorld),
                          y: modifyExpression(p.y, dyWorld)
                      };
                  } else {
                      // Dragging entire Line shape (all points)
                      const allMoved = newPoints.map(p => ({
                          ...p,
                          x: modifyExpression(p.x, dxWorld),
                          y: modifyExpression(p.y, dyWorld)
                      }));
                      return { ...s, points: allMoved };
                  }

                  return { ...s, points: newPoints };
              } 
              
              // Standard Shapes (Circle/Rect)
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

  // --- ACTIONS ---

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
      // Line: default 2 points
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
    
    // Swap
    [newShapes[index], newShapes[targetIndex]] = [newShapes[targetIndex], newShapes[index]];
    
    onUpdate({ ...footprint, shapes: newShapes });
  };

  const updateFootprintName = (name: string) => {
    onUpdate({ ...footprint, name });
  };

  const toggleLayerVisibility = (id: string) => {
    setLayerVisibility(prev => ({
        ...prev,
        [id]: prev[id] === undefined ? false : !prev[id] // toggle between true/undefined (visible) and false (hidden)
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

  // --- DERIVED STATE ---
  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);
  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  // VISIBILITY CHECK FOR 2D
  const isShapeVisible = (shape: FootprintShape) => {
      const assignedIds = Object.keys(shape.assignedLayers || {});
      
      if (assignedIds.length === 0) {
          // If assigned to no layers, use "unassigned" visibility
          return layerVisibility["unassigned"] !== false;
      }
      
      // If assigned to layers, visible if NOT ALL of them are hidden.
      const allAssignedLayersHidden = assignedIds.every(id => layerVisibility[id] === false);
      return !allAssignedLayersHidden;
  };

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
        
        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
        <button onClick={() => addShape("line")}>+ Line</button>
      </div>

      <div className="fp-workspace">
        {/* LEFT: LAYERS AND SHAPES */}
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

        {/* CENTER: VISUAL EDITOR with Toggle Bar */}
        <div className="fp-center-column">
            {/* VIEW TOGGLE */}
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
                {/* Home Button handles both views now */}
                <button 
                    className="canvas-home-btn" 
                    onClick={handleHomeClick}
                    title="Reset View"
                >
                    🏠
                </button>

            {/* 2D View Container - Persist when hidden */}
            <div style={{ display: viewMode === "2D" ? 'contents' : 'none' }}>
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

                    {[...footprint.shapes].reverse().map((shape) => {
                        if (!isShapeVisible(shape)) return null;
                        return (
                            <ShapeRenderer
                                key={shape.id}
                                shape={shape}
                                isSelected={shape.id === selectedShapeId}
                                params={params}
                                stackup={stackup}
                                onShapeDown={handleShapeMouseDown}
                                onHandleDown={handleHandleMouseDown}
                            />
                        );
                    })}
                </svg>
                <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan | Drag Handles</div>
            </div>
            
            {/* 3D VIEW - Persist when hidden */}
            <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
                <Footprint3DView 
                    ref={footprint3DRef}
                    footprint={footprint}
                    params={params}
                    stackup={stackup}
                    visibleLayers={layerVisibility} // Pass visibility
                />
            </div>
            </div>
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