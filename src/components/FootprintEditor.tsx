// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import * as math from "mathjs";
import { Footprint, FootprintShape, Parameter, FootprintCircle, FootprintRect, FootprintLine, StackupLayer, Point, LayerAssignment, FootprintReference } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import './FootprintEditor.css';

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // NEW: Need full list for recursion lookups
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  params: Parameter[];
  stackup: StackupLayer[];
}

const BOARD_OUTLINE_ID = "BOARD_OUTLINE";

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
export function evaluateExpression(expression: string | LayerAssignment | undefined | null, params: Parameter[]): number {
  if (!expression) return 0;

  let exprStr = "";
  if (typeof expression === 'object') {
      if ('depth' in expression) {
          exprStr = expression.depth;
      } else {
          return 0; 
      }
  } else {
      exprStr = String(expression);
  }

  if (!exprStr || !exprStr.trim()) return 0;
  
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      // Treat parameters as pure numbers in mm
      const val = p.unit === "in" ? p.value * 25.4 : p.value;
      scope[p.key] = val;
    });
    const result = math.evaluate(exprStr, scope);
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

// Helper for Midpoint calculation
const isNumeric = (str: string) => {
    const s = str.trim();
    if (s === "") return false;
    return !isNaN(Number(s));
};

const calcMid = (v1: string, v2: string) => {
    if (isNumeric(v1) && isNumeric(v2)) {
        return parseFloat(((Number(v1) + Number(v2)) / 2).toFixed(4)).toString();
    }
    return `(${v1} + ${v2}) / 2`;
};

// ------------------------------------------------------------------
// RECURSIVE CHECKER
// ------------------------------------------------------------------

export function isFootprintOptionValid(
    currentFootprintId: string, 
    candidateFootprint: Footprint, 
    allFootprints: Footprint[]
): boolean {
    if (candidateFootprint.id === currentFootprintId) return false; // Direct recursion
    if (candidateFootprint.isBoard) return false; // Cannot add standalone boards

    // Check for circular dependency: candidate -> ... -> current
    const visited = new Set<string>();
    const stack = [candidateFootprint];

    while(stack.length > 0) {
        const fp = stack.pop()!;
        if (fp.id === currentFootprintId) return false; // Found a path back to current
        
        if (visited.has(fp.id)) continue;
        visited.add(fp.id);

        // Find children of fp
        fp.shapes.forEach(s => {
            if (s.type === "footprint") {
                const childId = (s as FootprintReference).footprintId;
                const childFp = allFootprints.find(f => f.id === childId);
                if (childFp) stack.push(childFp);
            }
        });
    }

    return true;
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

// RECURSIVE SHAPE RENDERER
// Handles recursion for 2D View. 
// Note: We use SVG transforms for recursion to simplify matrix math for lines/curves.
const RecursiveShapeRenderer = ({
  shape,
  allFootprints,
  params,
  stackup,
  isSelected,
  isParentSelected,
  onMouseDown,
  onHandleDown,
}: {
  shape: FootprintShape;
  allFootprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
  isSelected: boolean;
  isParentSelected: boolean;
  onMouseDown: (e: React.MouseEvent, id: string, pointIndex?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => void;
}) => {
  // If this is a reference to another footprint, we render that footprint's shapes inside a group
  if (shape.type === "footprint") {
      const ref = shape as FootprintReference;
      const targetFp = allFootprints.find(f => f.id === ref.footprintId);

      const x = evaluateExpression(ref.x, params);
      const y = evaluateExpression(ref.y, params);
      const angle = evaluateExpression(ref.angle, params);

      // Styles for the container of the footprint ref
      // If the reference itself is selected, we might show a bounding box or highlight
      const containerStyle: React.CSSProperties = {
          cursor: "pointer",
          opacity: isSelected ? 1 : (isParentSelected ? 1 : 0.9)
      };

      if (!targetFp) {
          // Error state: Missing reference
          return (
              <g 
                transform={`translate(${x}, ${-y}) rotate(${-angle})`}
                onMouseDown={(e) => onMouseDown(e, shape.id)}
                style={containerStyle}
              >
                  <rect x="-5" y="-5" width="10" height="10" stroke="red" fill="none" vectorEffect="non-scaling-stroke"/>
                  <line x1="-5" y1="-5" x2="5" y2="5" stroke="red" vectorEffect="non-scaling-stroke"/>
                  <line x1="-5" y1="5" x2="5" y2="-5" stroke="red" vectorEffect="non-scaling-stroke"/>
              </g>
          );
      }

      return (
          <g 
            transform={`translate(${x}, ${-y}) rotate(${-angle})`}
            onMouseDown={(e) => {
                // Select THIS reference shape, not the children inside
                onMouseDown(e, shape.id);
            }}
            style={containerStyle}
          >
              {/* Optional: Selection Indicator for the Group */}
              {isSelected && <circle cx={0} cy={0} r={2} fill="#646cff" vectorEffect="non-scaling-stroke"/>}
              
              {/* Render Children */}
              {/* Reverse to maintain Top-First visual order (SVG draws painter's algo, last is top) */}
              {[...targetFp.shapes].reverse().map(child => (
                  <RecursiveShapeRenderer
                    key={`${shape.id}-${child.id}`}
                    shape={child}
                    allFootprints={allFootprints}
                    params={params}
                    stackup={stackup}
                    isSelected={false} // Children inside a ref are not individually selectable in this editor
                    isParentSelected={isSelected} // Pass down selection state for visualization cues if needed
                    onMouseDown={(e) => {
                         // Propagate up as click on the Reference
                         onMouseDown(e, shape.id);
                    }}
                    onHandleDown={() => {}} // Handles inside child footprints are not editable here
                  />
              ))}
              
              {targetFp.shapes.length === 0 && (
                   <circle cx={0} cy={0} r={5} stroke="#666" strokeDasharray="2,2" fill="none" vectorEffect="non-scaling-stroke" />
              )}
          </g>
      );
  }

  // --- PRIMITIVE SHAPES ---
  
  // Default styles (unassigned)
  let fill = isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)";
  let stroke = isSelected ? "#646cff" : "#888";
  let strokeWidth = isSelected ? 2 : 1;
  const vectorEffect = "non-scaling-stroke";

  // Calculate Color based on highest layer
  const assigned = shape.assignedLayers || {};
  const highestLayer = stackup.find(l => assigned[l.id] !== undefined);

  if (highestLayer) {
      stroke = highestLayer.color;
      strokeWidth = isSelected ? 3 : 2;

      if (highestLayer.type === "Cut") {
          fill = "black";
      } else {
          const rawAssignment = assigned[highestLayer.id];
          const depthExpression = (typeof rawAssignment === 'string') ? rawAssignment : rawAssignment.depth;
          
          const depthVal = evaluateExpression(depthExpression, params);
          const thickVal = evaluateExpression(highestLayer.thicknessExpression, params);
          const ratio = (thickVal > 0.0001) ? (depthVal / thickVal) : 0;
          
          fill = interpolateColor(highestLayer.color, ratio);
      }
  }

  // If inside a selected parent footprint, highlight slightly
  if (isParentSelected && !isSelected) {
      stroke = "#aaa";
  }

  const commonProps = {
    onMouseDown: (e: React.MouseEvent) => {
      onMouseDown(e, shape.id);
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

      let d = "";
      if (pts.length > 0) {
          d = `M ${pts[0].x} ${-pts[0].y}`;
          for (let i = 0; i < pts.length - 1; i++) {
              const curr = pts[i];
              const next = pts[i+1];
              const cp1x = curr.x + (curr.hOut?.x || 0);
              const cp1y = -(curr.y + (curr.hOut?.y || 0));
              const cp2x = next.x + (next.hIn?.x || 0);
              const cp2y = -(next.y + (next.hIn?.y || 0));
              d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${-next.y}`;
          }
      }

      // Render Handles only if strictly selected (not just parent selected)
      const handles = isSelected ? pts.map((pt, idx) => {
          const elements = [];
          
          // Anchor Point
          elements.push(
              <circle 
                  key={`anchor-${idx}`}
                  cx={pt.x} cy={-pt.y} r={3/strokeWidth}
                  fill="#fff" stroke="#646cff" strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  onMouseDown={(e) => {
                      e.stopPropagation();
                      onMouseDown(e, shape.id, idx);
                  }}
              />
          );

          if (pt.hIn) {
              const hx = pt.x + pt.hIn.x;
              const hy = -(pt.y + pt.hIn.y);
              elements.push(
                  <line key={`line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`handle-in-${idx}`} cx={hx} cy={hy} r={2.5/strokeWidth} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'in'); }} />
              );
          }
          if (pt.hOut) {
              const hx = pt.x + pt.hOut.x;
              const hy = -(pt.y + pt.hOut.y);
              elements.push(
                  <line key={`line-out-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`handle-out-${idx}`} cx={hx} cy={hy} r={2.5/strokeWidth} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'out'); }} />
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

// NEW: Board Outline Renderer (Closed Loop)
const BoardOutlineRenderer = ({
  points,
  isSelected,
  params,
  onMouseDown,
  onHandleDown,
}: {
  points: Point[];
  isSelected: boolean;
  params: Parameter[];
  onMouseDown: (e: React.MouseEvent, id: string, idx?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, idx: number, type: 'in' | 'out') => void;
}) => {
    const stroke = isSelected ? "#646cff" : "#555";
    const strokeWidth = isSelected ? 3 : 2;
    const strokeDasharray = isSelected ? "0" : "5,5";

    const pts = points.map(p => ({
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

    let d = "";
    if (pts.length > 0) {
        d = `M ${pts[0].x} ${-pts[0].y}`;
        for (let i = 0; i < pts.length; i++) {
            const curr = pts[i];
            const next = pts[(i + 1) % pts.length];
            const cp1x = curr.x + (curr.hOut?.x || 0);
            const cp1y = -(curr.y + (curr.hOut?.y || 0));
            const cp2x = next.x + (next.hIn?.x || 0);
            const cp2y = -(next.y + (next.hIn?.y || 0));
            d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${-next.y}`;
        }
        d += " Z";
    }

    const handles = isSelected ? pts.map((pt, idx) => {
        const elements = [];
        elements.push(
            <circle key={`bo-anchor-${idx}`} cx={pt.x} cy={-pt.y} r={3/strokeWidth} fill="#fff" stroke="#646cff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, BOARD_OUTLINE_ID, idx); }} />
        );
        if (pt.hIn) {
            const hx = pt.x + pt.hIn.x;
            const hy = -(pt.y + pt.hIn.y);
            elements.push(
                <line key={`bo-line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                <circle key={`bo-handle-in-${idx}`} cx={hx} cy={hy} r={2.5/strokeWidth} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                    onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, BOARD_OUTLINE_ID, idx, 'in'); }} />
            );
        }
        if (pt.hOut) {
            const hx = pt.x + pt.hOut.x;
            const hy = -(pt.y + pt.hOut.y);
            elements.push(
                <line key={`bo-line-out-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                <circle key={`bo-handle-out-${idx}`} cx={hx} cy={hy} r={2.5/strokeWidth} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                    onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, BOARD_OUTLINE_ID, idx, 'out'); }} />
            );
        }
        return elements;
    }) : null;

    return (
        <g>
            <path d={d} fill="none" stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" style={{ cursor: "pointer" }}
                onMouseDown={(e) => onMouseDown(e, BOARD_OUTLINE_ID)} />
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={strokeDasharray} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            {handles}
        </g>
    );
};

// 2. PROPERTIES PANEL
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

// 3. LAYER VISIBILITY PANEL
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
                <div className="layer-color-square unassigned" title="Unassigned" />
                <span className="layer-vis-name">Unassigned</span>
            </div>
            <button className={`vis-toggle-btn ${visibility["unassigned"] !== false ? "visible" : "hidden"}`} onClick={() => onToggle("unassigned")}>
                {visibility["unassigned"] !== false ? "Hide" : "Show"}
            </button>
        </div>
        {stackup.map((layer) => (
             <div key={layer.id} className={`layer-vis-item ${visibility[layer.id] === false ? "is-hidden" : ""}`}>
                <div className="layer-vis-info">
                    <div className="layer-color-square" style={{ backgroundColor: layer.color }} />
                    <span className="layer-vis-name" title={layer.name}>{layer.name}</span>
                </div>
                <button className={`vis-toggle-btn ${visibility[layer.id] !== false ? "visible" : "hidden"}`} onClick={() => onToggle(layer.id)}>
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
  footprint,
  allFootprints,
  selectedShapeId,
  onSelect,
  onDelete,
  onRename,
  onMove,
  updateFootprint,
  stackup,
  isShapeVisible,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedShapeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  updateFootprint: (field: string, val: any) => void;
  stackup: StackupLayer[];
  isShapeVisible: (shape: FootprintShape) => boolean;
}) => {
  
  const handleBoardToggle = (checked: boolean) => {
      updateFootprint("isBoard", checked);
      if (checked && (!footprint.boardOutline || footprint.boardOutline.length === 0)) {
          const defaultOutline = [
             { id: crypto.randomUUID(), x: "-10", y: "-10" },
             { id: crypto.randomUUID(), x: "10", y: "-10" },
             { id: crypto.randomUUID(), x: "10", y: "10" },
             { id: crypto.randomUUID(), x: "-10", y: "10" },
          ];
          updateFootprint("boardOutline", defaultOutline);
      }
  };

  return (
    <div className="fp-left-subpanel">
      <h3 style={{ marginTop: 0 }}>Objects</h3>
      
      <div style={{ marginBottom: "10px", paddingBottom: "10px", borderBottom: "1px solid #333" }}>
          <label className="checkbox-label" style={{ fontWeight: "bold", color: "#fff" }}>
              <input type="checkbox" checked={!!footprint.isBoard} onChange={(e) => handleBoardToggle(e.target.checked)} />
              Standalone Board
          </label>
      </div>

      <div className="shape-list-container">
        {footprint.isBoard && (
            <div className={`shape-item ${selectedShapeId === BOARD_OUTLINE_ID ? "selected" : ""}`} onClick={() => onSelect(BOARD_OUTLINE_ID)}>
                <span className="shape-name-edit" style={{ fontWeight: 'bold' }}>Board Outline</span>
            </div>
        )}

        {footprint.shapes.map((shape, index) => {
          const visible = isShapeVisible(shape);
          
          let hasError = false;
          if (shape.type === "footprint") {
              const refId = (shape as FootprintReference).footprintId;
              const target = allFootprints.find(f => f.id === refId);
              if (!target) hasError = true;
              else if (!isFootprintOptionValid(footprint.id, target, allFootprints) && target.id !== refId) {
                  if (target.isBoard) hasError = true;
              }
          }

          return (
          <div key={shape.id}
            className={`shape-item ${shape.id === selectedShapeId ? "selected" : ""} ${!visible ? "is-hidden" : ""} ${hasError ? "error-item" : ""}`}
            onClick={() => onSelect(shape.id)}
            style={hasError ? { border: '1px solid red' } : {}}
          >
            <div className="shape-layer-indicators">
              {shape.type !== "footprint" && stackup.map(layer => {
                 if (shape.assignedLayers?.[layer.id] !== undefined) {
                     return <div key={layer.id} className="layer-indicator-dot" style={{ backgroundColor: layer.color }} title={layer.name} />;
                 }
                 return null;
              })}
              {shape.type === "footprint" && <div className="layer-indicator-dot" style={{ backgroundColor: "#888", borderRadius: '50%' }} title="Recursive Footprint" />}
            </div>

            <input type="text" value={shape.name} onChange={(e) => onRename(shape.id, e.target.value)} className="shape-name-edit" />
            {hasError && <span style={{color:'red', marginRight:'5px'}} title="Invalid Reference">⚠</span>}

            <div className="shape-actions" style={{ display: 'flex', gap: '2px' }}>
                <button className="icon-btn btn-up" onClick={(e) => { e.stopPropagation(); onMove(index, -1); }} disabled={index === 0} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Move Up">↑</button>
                <button className="icon-btn btn-down" onClick={(e) => { e.stopPropagation(); onMove(index, 1); }} disabled={index === footprint.shapes.length - 1} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Move Down">↓</button>
                <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(shape.id); }} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Delete">✕</button>
            </div>
          </div>
        )})}
        {footprint.shapes.length === 0 && !footprint.isBoard && <div className="empty-state-small">No shapes added.</div>}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function FootprintEditor({ footprint, allFootprints, onUpdate, onClose, params, stackup }: Props) {
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
  
  const footprintRef = useRef(footprint);
  useEffect(() => {
    footprintRef.current = footprint;
  }, [footprint]);

  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  const [viewBox, setViewBox] = useState({ x: -50, y: -50, width: 100, height: 100 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  const [deferredFootprint, setDeferredFootprint] = useState(footprint);

  useEffect(() => {
    if (viewMode === "2D") return;
    const timer = setTimeout(() => { setDeferredFootprint(footprint); }, 600);
    return () => clearTimeout(timer);
  }, [footprint, viewMode]);

  useEffect(() => { if (viewMode === "3D") { setDeferredFootprint(footprint); } }, [viewMode]);

  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);
  const footprint3DRef = useRef<Footprint3DViewHandle>(null);

  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedShapeId = useRef<string | null>(null);

  const isShapeDragging = useRef(false);
  const shapeDragStartPos = useRef({ x: 0, y: 0 });
  const shapeDragStartData = useRef<any>(null);
  const dragTargetRef = useRef<{ id: string; pointIdx?: number; handleType?: 'in' | 'out'; } | null>(null);

  useEffect(() => { viewBoxRef.current = viewBox; }, [viewBox]);

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
            const centerX = prev.x + prev.width / 2;
            const centerY = prev.y + prev.height / 2;
            return { x: centerX - prev.width / 2, y: centerY - newHeight / 2, width: prev.width, height: newHeight };
        });
    };
    const observer = new ResizeObserver(() => { updateDimensions(); });
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
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const ratioX = mouseX / rect.width;
        const ratioY = mouseY / rect.height;
        const userX = viewBoxRef.current.x + ratioX * viewBoxRef.current.width;
        const userY = viewBoxRef.current.y + ratioY * viewBoxRef.current.height;
        const ZOOM_SPEED = 1.1;
        const delta = Math.sign(e.deltaY); 
        const scale = delta > 0 ? ZOOM_SPEED : 1 / ZOOM_SPEED;
        const newWidth = viewBoxRef.current.width * scale;
        const newHeight = viewBoxRef.current.height * scale;
        const newX = userX - ratioX * newWidth;
        const newY = userY - ratioY * newHeight;
        setViewBox({ x: newX, y: newY, width: newWidth, height: newHeight });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => { element.removeEventListener('wheel', onWheel); };
  }, [viewMode]);

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
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved.current = true;
    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;
    const newX = dragStartViewBox.current.x - dx * scaleX;
    const newY = dragStartViewBox.current.y - dy * scaleY;
    setViewBox(prev => ({ ...prev, x: newX, y: newY }));
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);
    if (!hasMoved.current) {
        if (clickedShapeId.current) setSelectedShapeId(clickedShapeId.current);
        else setSelectedShapeId(null);
    }
    clickedShapeId.current = null;
  };

  const handleShapeMouseDown = (e: React.MouseEvent, id: string, pointIndex?: number) => {
      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;
      setSelectedShapeId(id);
      
      if (id === BOARD_OUTLINE_ID) {
          if (!footprint.boardOutline) return;
          isShapeDragging.current = true;
          dragTargetRef.current = { id, pointIdx: pointIndex }; 
          shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
          shapeDragStartData.current = JSON.parse(JSON.stringify(footprint.boardOutline));
      } else {
          const shape = footprint.shapes.find(s => s.id === id);
          if (!shape) return;
          isShapeDragging.current = true;
          dragTargetRef.current = { id, pointIdx: pointIndex };
          shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
          shapeDragStartData.current = JSON.parse(JSON.stringify(shape));
      }
      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleHandleMouseDown = (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => {
      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;
      setSelectedShapeId(id);

      if (id === BOARD_OUTLINE_ID) {
           if (!footprint.boardOutline) return;
           isShapeDragging.current = true;
           dragTargetRef.current = { id, pointIdx: pointIndex, handleType: type };
           shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
           shapeDragStartData.current = JSON.parse(JSON.stringify(footprint.boardOutline));
      } else {
          const shape = footprint.shapes.find(s => s.id === id);
          if (!shape) return;
          isShapeDragging.current = true;
          dragTargetRef.current = { id, pointIdx: pointIndex, handleType: type };
          shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
          shapeDragStartData.current = JSON.parse(JSON.stringify(shape));
      }
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
      const dyWorld = -dyPx * scaleY;
      const currentFP = footprintRef.current;
      const { id, pointIdx, handleType } = dragTargetRef.current;
      
      if (id === BOARD_OUTLINE_ID) {
          const startPoints = shapeDragStartData.current as Point[];
          const newPoints = [...startPoints];
          if (handleType && pointIdx !== undefined) {
               const p = newPoints[pointIdx];
               if (handleType === 'in' && p.handleIn) {
                   newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorld) } };
               } else if (handleType === 'out' && p.handleOut) {
                   newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorld) } };
               }
          } else if (pointIdx !== undefined) {
               const p = newPoints[pointIdx];
               newPoints[pointIdx] = { ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) };
          } else {
               for(let i=0; i<newPoints.length; i++) {
                   newPoints[i] = { ...newPoints[i], x: modifyExpression(newPoints[i].x, dxWorld), y: modifyExpression(newPoints[i].y, dyWorld) };
               }
          }
          onUpdate({ ...currentFP, boardOutline: newPoints });
      } else {
          const startShape = shapeDragStartData.current as FootprintShape;
          const updatedShapes = currentFP.shapes.map(s => {
              if (s.id === id) {
                  if (s.type === "line" && startShape.type === "line") {
                      const newPoints = [...startShape.points];
                      if (handleType && pointIdx !== undefined) {
                          const p = newPoints[pointIdx];
                          if (handleType === 'in' && p.handleIn) {
                              newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorld) } };
                          } else if (handleType === 'out' && p.handleOut) {
                              newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorld) } };
                          }
                      } else if (pointIdx !== undefined) {
                          const p = newPoints[pointIdx];
                          newPoints[pointIdx] = { ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) };
                      } else {
                          const allMoved = newPoints.map(p => ({ ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) }));
                          return { ...s, points: allMoved };
                      }
                      return { ...s, points: newPoints };
                  } 
                  if ((s.type === "circle" || s.type === "rect" || s.type === "footprint") && (startShape.type === "circle" || startShape.type === "rect" || startShape.type === "footprint")) {
                      return { ...s, x: modifyExpression(startShape.x, dxWorld), y: modifyExpression(startShape.y, dyWorld) };
                  }
              }
              return s;
          });
          onUpdate({ ...currentFP, shapes: updatedShapes });
      }
  };

  const handleShapeMouseUp = (e: MouseEvent) => {
      isShapeDragging.current = false;
      dragTargetRef.current = null;
      shapeDragStartData.current = null;
      window.removeEventListener('mousemove', handleShapeMouseMove);
      window.removeEventListener('mouseup', handleShapeMouseUp);
  };

  // --- ACTIONS ---
  const addShape = (type: "circle" | "rect" | "line" | "footprint", footprintId?: string) => {
    const base = { id: crypto.randomUUID(), name: `New ${type}`, assignedLayers: {}, };
    let newShape: FootprintShape;

    if (type === "footprint" && footprintId) {
         // Create Recursive Reference
         const targetFp = allFootprints.find(f => f.id === footprintId);
         newShape = {
             ...base,
             type: "footprint",
             x: "0", y: "0", angle: "0",
             footprintId,
             name: targetFp?.name || "Ref"
         } as FootprintReference;
    } else if (type === "circle") {
      newShape = { ...base, type: "circle", x: "0", y: "0", diameter: "10" };
    } else if (type === "rect") {
      newShape = { ...base, type: "rect", x: "0", y: "0", width: "10", height: "10", angle: "0", cornerRadius: "0" };
    } else {
      newShape = { ...base, type: "line", thickness: "1", x: "0", y: "0", points: [{ id: crypto.randomUUID(), x: "0", y: "0" }, { id: crypto.randomUUID(), x: "10", y: "10" }] };
    }
    onUpdate({ ...footprint, shapes: [...footprint.shapes, newShape] });
    setSelectedShapeId(newShape.id);
  };

  const updateShape = (shapeId: string, field: string, val: any) => {
    onUpdate({ ...footprint, shapes: footprint.shapes.map((s) => s.id === shapeId ? { ...s, [field]: val } : s), });
  };
  const updateFootprintField = (field: string, val: any) => { onUpdate({ ...footprint, [field]: val }); };
  const deleteShape = (shapeId: string) => { onUpdate({ ...footprint, shapes: footprint.shapes.filter(s => s.id !== shapeId) }); setSelectedShapeId(null); };
  const moveShape = (index: number, direction: -1 | 1) => {
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === footprint.shapes.length - 1) return;
    const newShapes = [...footprint.shapes];
    [newShapes[index], newShapes[index + direction]] = [newShapes[index + direction], newShapes[index]];
    onUpdate({ ...footprint, shapes: newShapes });
  };
  const updateFootprintName = (name: string) => { onUpdate({ ...footprint, name }); };
  const toggleLayerVisibility = (id: string) => { setLayerVisibility(prev => ({ ...prev, [id]: prev[id] === undefined ? false : !prev[id] })); };
  const handleHomeClick = () => {
    if (viewMode === "2D") {
        if (!wrapperRef.current) { setViewBox({ x: -50, y: -50, width: 100, height: 100 }); return; }
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        const ratio = height / width; 
        const newWidth = 100;
        setViewBox({ x: -newWidth / 2, y: -(newWidth * ratio) / 2, width: newWidth, height: newWidth * ratio });
    } else {
        footprint3DRef.current?.resetCamera();
    }
  };

  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);
  const isBoardSelected = selectedShapeId === BOARD_OUTLINE_ID;
  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const isShapeVisible = (shape: FootprintShape) => {
      // Recursive footprints are visible if not explicitly hidden (no layer assignment usually, but could implement)
      if (shape.type === "footprint") return true; 

      const assignedIds = Object.keys(shape.assignedLayers || {});
      if (assignedIds.length === 0) return layerVisibility["unassigned"] !== false;
      return !assignedIds.every(id => layerVisibility[id] === false);
  };

  return (
    <div className="footprint-editor-container">
      <div className="fp-toolbar">
        <button className="secondary" onClick={onClose}>← Back</button>
        <input className="toolbar-name-input" type="text" value={footprint.name} onChange={(e) => updateFootprintName(e.target.value)} />
        <div className="spacer" />
        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
        <button onClick={() => addShape("line")}>+ Line</button>
        
        {/* Footprint Dropdown */}
        <div style={{ marginLeft: '10px', display: 'flex', alignItems: 'center' }}>
            <select 
                style={{ width: '150px', background: '#333', color: '#fff', border: '1px solid #555' }}
                value=""
                onChange={(e) => {
                    if (e.target.value) {
                        addShape("footprint", e.target.value);
                    }
                }}
            >
                <option value="" disabled>+ Footprint</option>
                {allFootprints.map(fp => {
                    // Filter logic:
                    // 1. Cannot add self
                    // 2. Cannot add boards
                    // 3. Cannot add cycle
                    const isValid = isFootprintOptionValid(footprint.id, fp, allFootprints);
                    return (
                        <option key={fp.id} value={fp.id} disabled={!isValid}>
                            {fp.name} {!isValid ? "(Invalid)" : ""}
                        </option>
                    );
                })}
            </select>
        </div>
      </div>

      <div className="fp-workspace">
        <div className="fp-left-panel">
            <LayerVisibilityPanel stackup={stackup} visibility={layerVisibility} onToggle={toggleLayerVisibility} />
            <ShapeListPanel
                footprint={footprint}
                allFootprints={allFootprints}
                selectedShapeId={selectedShapeId}
                onSelect={setSelectedShapeId}
                onDelete={deleteShape}
                onRename={(id, name) => updateShape(id, "name", name)}
                onMove={moveShape}
                updateFootprint={updateFootprintField}
                stackup={stackup}
                isShapeVisible={isShapeVisible}
            />
        </div>

        <div className="fp-center-column">
            <div className="view-toggle-bar">
                <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>2D Canvas</button>
                <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D Preview</button>
            </div>

            <div className="fp-canvas-wrapper" ref={wrapperRef}>
                <button className="canvas-home-btn" onClick={handleHomeClick} title="Reset View">🏠</button>

            <div style={{ display: viewMode === "2D" ? 'contents' : 'none' }}>
                <svg 
                    ref={svgRef}
                    className="fp-canvas" 
                    viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                    onMouseDown={handleMouseDown}
                >
                    <defs>
                    <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                        <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    </pattern>
                    </defs>
                    <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#grid)" />
                    <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    
                    {footprint.isBoard && footprint.boardOutline && (
                        <BoardOutlineRenderer
                            points={footprint.boardOutline}
                            isSelected={selectedShapeId === BOARD_OUTLINE_ID}
                            params={params}
                            onMouseDown={handleShapeMouseDown}
                            onHandleDown={handleHandleMouseDown}
                        />
                    )}

                    {/* Shapes Rendered Reversed (Bottom to Top visual order) */}
                    {[...footprint.shapes].reverse().map((shape) => {
                        if (!isShapeVisible(shape)) return null;
                        
                        // Use Recursive Renderer
                        return (
                            <RecursiveShapeRenderer
                                key={shape.id}
                                shape={shape}
                                allFootprints={allFootprints}
                                params={params}
                                stackup={stackup}
                                isSelected={shape.id === selectedShapeId}
                                isParentSelected={false}
                                onMouseDown={handleShapeMouseDown}
                                onHandleDown={handleHandleMouseDown}
                            />
                        );
                    })}
                </svg>
                <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan | Drag Handles</div>
            </div>
            
            <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
                <Footprint3DView 
                    ref={footprint3DRef}
                    footprint={deferredFootprint}
                    allFootprints={allFootprints} // Pass full list for recursion
                    params={params}
                    stackup={stackup}
                    visibleLayers={layerVisibility} 
                    is3DActive={viewMode === "3D"} 
                />
            </div>
            </div>
        </div>

        <div className="fp-sidebar">
          {activeShape || isBoardSelected ? (
            <>
              <PropertiesPanel 
                footprint={footprint}
                allFootprints={allFootprints}
                selectedId={selectedShapeId}
                updateShape={updateShape} 
                updateFootprint={updateFootprintField}
                params={params} 
                stackup={stackup}
              />
              {activeShape && (
                <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                    <button className="danger" style={{width: '100%'}} onClick={() => deleteShape(activeShape.id)}>
                        Delete Shape
                    </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <p>Select a shape or board outline to edit properties.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}