// src/components/FootprintRenderers.tsx
import React from "react";
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintRect, FootprintWireGuide, FootprintBoardOutline, FootprintLine, FootprintUnion, FootprintText } from "../types";
import { evaluateExpression, resolvePoint } from "../utils/footprintUtils";

// Helper for Cubic Bezier evaluation at t (1D)
function bezier1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const mt = 1 - t;
    return (mt * mt * mt * p0) + (3 * mt * mt * t * p1) + (3 * mt * t * t * p2) + (t * t * t * p3);
}

// NEW: Helper to convert Hex to RGBA
function hexToRgba(hex: string, alpha: number): string {
    let c = hex.trim();
    if (c.startsWith('#')) c = c.substring(1);
    if (c.length === 3) c = c.split('').map(char => char + char).join('');
    const num = parseInt(c, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// NEW: Generate outline path for thick lines to allow transparent fill
function generateLineOutlinePath(pts: {x: number, y: number, hIn?: {x:number, y:number}, hOut?: {x:number, y:number}}[], thickness: number): string {
    if (pts.length < 2) return "";

    const halfThick = thickness / 2;
    const pathPoints: {x: number, y: number}[] = [];

    // 1. Discretize Centerline
    for (let i = 0; i < pts.length - 1; i++) {
        const curr = pts[i];
        const next = pts[i+1];
        const p1x = curr.x;
        const p1y = -curr.y;
        const p2x = next.x;
        const p2y = -next.y;

        if (curr.hOut || next.hIn) {
            const cp1x = curr.x + (curr.hOut?.x || 0);
            const cp1y = -(curr.y + (curr.hOut?.y || 0));
            const cp2x = next.x + (next.hIn?.x || 0);
            const cp2y = -(next.y + (next.hIn?.y || 0));

            const divisions = 16;
            for(let j=0; j<divisions; j++) {
                const t = j/divisions;
                pathPoints.push({
                    x: bezier1D(p1x, cp1x, cp2x, p2x, t),
                    y: bezier1D(p1y, cp1y, cp2y, p2y, t)
                });
            }
        } else {
            pathPoints.push({ x: p1x, y: p1y });
        }
        if (i === pts.length - 2) pathPoints.push({ x: p2x, y: p2y });
    }

    if (pathPoints.length < 2) return "";

    // 2. Calculate Offsets
    const leftPts: {x: number, y: number}[] = [];
    const rightPts: {x: number, y: number}[] = [];

    for (let i = 0; i < pathPoints.length; i++) {
        const p = pathPoints[i];
        let dx, dy;
        if (i === 0) {
            dx = pathPoints[i+1].x - p.x;
            dy = pathPoints[i+1].y - p.y;
        } else if (i === pathPoints.length - 1) {
            dx = p.x - pathPoints[i-1].x;
            dy = p.y - pathPoints[i-1].y;
        } else {
            const dx1 = p.x - pathPoints[i-1].x;
            const dy1 = p.y - pathPoints[i-1].y;
            const dx2 = pathPoints[i+1].x - p.x;
            const dy2 = pathPoints[i+1].y - p.y;
            dx = dx1 + dx2; dy = dy1 + dy2;
        }
        const len = Math.sqrt(dx*dx + dy*dy);
        const nx = -dy / len;
        const ny = dx / len;
        leftPts.push({ x: p.x + nx * halfThick, y: p.y + ny * halfThick });
        rightPts.push({ x: p.x - nx * halfThick, y: p.y - ny * halfThick });
    }

    // 3. Construct Path String
    let d = `M ${leftPts[0].x} ${leftPts[0].y}`;
    for(let i=1; i<leftPts.length; i++) d += ` L ${leftPts[i].x} ${leftPts[i].y}`;
    // Sweep-flag 0 to ensure outward convex caps
    d += ` A ${halfThick} ${halfThick} 0 0 0 ${rightPts[rightPts.length-1].x} ${rightPts[rightPts.length-1].y}`;
    for(let i=rightPts.length-2; i>=0; i--) d += ` L ${rightPts[i].x} ${rightPts[i].y}`;
    d += ` A ${halfThick} ${halfThick} 0 0 0 ${leftPts[0].x} ${leftPts[0].y}`;
    return d + " Z";
}

// RECURSIVE SHAPE RENDERER
export const RecursiveShapeRenderer = ({
  shape,
  allFootprints,
  params,
  stackup,
  isSelected,
  isParentSelected,
  onMouseDown,
  onHandleDown,
  onDoubleClick, // NEW
  handleRadius,
  rootFootprint, // NEW: Context for point resolution
  layerVisibility,
  hoveredPointIndex, // NEW
  setHoveredPointIndex, // NEW
  hoveredMidpointIndex, // NEW
  setHoveredMidpointIndex, // NEW
  onAddMidpoint, // NEW
  onlyHandles = false, // IMPROVEMENT: New prop to render only interactive handles
  strokeScale = 1, // NEW: Current view zoom scale for SVG filters
  overrideStyle = null, // NEW: Internal prop to force styling on union children
}: {
  shape: FootprintShape;
  allFootprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
  isSelected: boolean;
  isParentSelected: boolean;
  onMouseDown: (e: React.MouseEvent, id: string, pointIndex?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => void;
  onDoubleClick?: (e: React.MouseEvent, id: string) => void; // NEW
  handleRadius: number;
  rootFootprint: Footprint; // NEW
  layerVisibility: Record<string, boolean>;
  hoveredPointIndex?: number | null;
  setHoveredPointIndex?: (index: number | null) => void;
  hoveredMidpointIndex?: number | null;
  setHoveredMidpointIndex?: (index: number | null) => void;
  onAddMidpoint?: (shapeId: string, index: number) => void;
  onlyHandles?: boolean;
  strokeScale?: number;
  overrideStyle?: { fill?: string, stroke?: string, strokeWidth?: number } | null;
}) => {
  // --- BOARD OUTLINE RENDERER ---
  if (shape.type === "boardOutline") {
      return (
          <BoardOutlineRenderer 
              shape={shape as FootprintBoardOutline}
              isSelected={isSelected}
              params={params}
              onMouseDown={onMouseDown}
              onHandleDown={onHandleDown}
              handleRadius={handleRadius}
              rootFootprint={rootFootprint}
              allFootprints={allFootprints}
              hoveredPointIndex={hoveredPointIndex}
              setHoveredPointIndex={setHoveredPointIndex}
              hoveredMidpointIndex={hoveredMidpointIndex}
              setHoveredMidpointIndex={setHoveredMidpointIndex}
              onAddMidpoint={onAddMidpoint}
              onlyHandles={onlyHandles}
          />
      );
  }

  // --- WIRE GUIDE RENDERER (Virtual Shape) ---
  if (shape.type === "wireGuide") {
    const wg = shape as FootprintWireGuide;
    const x = evaluateExpression(wg.x, params);
    const y = evaluateExpression(wg.y, params);

    // Aesthetic: Subtle gray normally, bright purple when selected
    const stroke = isSelected ? "#646cff" : "#666";
    const opacity = isSelected ? 1 : 0.6;
    const crossSize = handleRadius * 1.5;

    const elements = [];
    
    // Main marker: Minimalist crosshair
    elements.push(
      <g key="marker" style={{ cursor: "pointer", opacity }} onMouseDown={(e) => onMouseDown(e, shape.id)}>
        <line x1={x - crossSize} y1={-y} x2={x + crossSize} y2={-y} stroke={stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={x} y1={-(y - crossSize)} x2={x} y2={-(y + crossSize)} stroke={stroke} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <circle cx={x} cy={-y} r={handleRadius * 0.3} fill={stroke} vectorEffect="non-scaling-stroke" />
        {/* Transparent hit area */}
        <circle cx={x} cy={-y} r={handleRadius * 2} fill="transparent" stroke="none" />
      </g>
    );

    // Direction arrow: Illustrates flow even when wire is not attached
    if (wg.handle) {
        const hx = x + evaluateExpression(wg.handle.x, params);
        const hy = -(y + evaluateExpression(wg.handle.y, params));
        
        // Arrowhead math
        const dx = hx - x;
        const dy = hy - (-y);
        const angle = Math.atan2(dy, dx);
        const arrowLen = handleRadius * 1.5;
        const a1x = hx - arrowLen * Math.cos(angle - Math.PI / 6);
        const a1y = hy - arrowLen * Math.sin(angle - Math.PI / 6);
        const a2x = hx - arrowLen * Math.cos(angle + Math.PI / 6);
        const a2y = hy - arrowLen * Math.sin(angle + Math.PI / 6);

        const arrowColor = isSelected ? "#00ffff" : "#00aaaa";

        elements.push(
            <g key="direction" style={{ pointerEvents: 'auto' }}>
                {/* 1. Transparent HIT TARGET - Always active to allow selection/dragging via arrow */}
                <line 
                    x1={x} y1={-y} x2={hx} y2={hy} 
                    stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" 
                    style={{ cursor: isSelected ? 'crosshair' : 'pointer' }}
                    onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, 0, 'out'); }} 
                />

                {/* 2. Visual Dashed Line */}
                <line 
                    x1={x} y1={-y} x2={hx} y2={hy} 
                    stroke={arrowColor} strokeWidth={1} strokeDasharray="3,2" vectorEffect="non-scaling-stroke" 
                    style={{ pointerEvents: 'none' }}
                />
                
                {/* 3. Arrow Head */}
                <path d={`M ${hx} ${hy} L ${a1x} ${a1y} L ${a2x} ${a2y} Z`} fill={arrowColor} stroke="none" vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />
                
                {/* 4. Interactive Handle Dot */}
                {isSelected && (
                    <circle cx={hx} cy={hy} r={handleRadius * 0.8} fill={arrowColor} stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" style={{ cursor: 'crosshair' }}
                        onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, 0, 'out'); }} />
                )}
            </g>
        );
    }

    return <g>{elements}</g>;
  }

  // If this is a reference to another footprint, we render that footprint's shapes inside a group
  if (shape.type === "footprint") {
      // If we are only rendering handles for the top layer, references don't have sub-handles in this mode
      if (onlyHandles) return null;

      const ref = shape as FootprintReference;
      const targetFp = allFootprints.find(f => f.id === ref.footprintId);

      const x = evaluateExpression(ref.x, params);
      const y = evaluateExpression(ref.y, params);
      const angle = evaluateExpression(ref.angle, params);

      // Styles for the container of the footprint ref
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
            onDoubleClick={(e) => onDoubleClick && onDoubleClick(e, shape.id)}
            style={containerStyle}
          >
              {/* Optional: Selection Indicator for the Group */}
              {isSelected && <circle cx={0} cy={0} r={handleRadius} fill="#646cff" vectorEffect="non-scaling-stroke"/>}
              
              {/* Render Children */}
              {/* Reverse to maintain Top-First visual order (SVG draws painter's algo, last is top) */}
              {[...targetFp.shapes].reverse()
                .filter(child => child.type !== "boardOutline") // Ensure child board outlines are ignored
                .map(child => (
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
                    handleRadius={handleRadius}
                    rootFootprint={rootFootprint}
                    layerVisibility={layerVisibility}
                    strokeScale={strokeScale}
                  />
              ))}
              
              {targetFp.shapes.length === 0 && (
                   <circle cx={0} cy={0} r={5} stroke="#666" strokeDasharray="2,2" fill="none" vectorEffect="non-scaling-stroke" />
              )}
          </g>
      );
  }

  if (shape.type === "union") {
      const u = shape as FootprintUnion;
      const x = evaluateExpression(u.x, params);
      const y = evaluateExpression(u.y, params);
      const angle = evaluateExpression(u.angle, params);

      // Determine Colors for the Union silhouette
      let strokeColor = isSelected ? "#646cff" : "#888";
      const assigned = u.assignedLayers || {};
      const highestLayer = stackup.find(l => assigned[l.id] !== undefined && layerVisibility[l.id] !== false);
      if (highestLayer) { strokeColor = highestLayer.color; }

      const filterId = `union-filter-${u.id}`;
      // Calculate dilate radius: visually ~1.5px
      const dilateRadius = strokeScale * 1.5 * (isSelected ? 2 : 1);
      let defaultFill = isSelected ? "rgb(100, 108, 255)" : "rgb(255, 255, 255)";

      return (
          <g 
            transform={`translate(${x}, ${-y}) rotate(${-angle})`}
            onMouseDown={(e) => onMouseDown(e, shape.id)}
            style={{ cursor: "pointer", opacity: isSelected ? 1 : 0.9 }}
          >
              {/* defs for boolean visual union effect */}
              <defs>
                  <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
                      <feMorphology operator="dilate" radius={dilateRadius} in="SourceAlpha" result="dilated"/>
                      <feComposite operator="out" in="dilated" in2="SourceAlpha" result="outline"/>
                      <feFlood floodColor={strokeColor} floodOpacity="1" result="flood"/>
                      <feComposite operator="in" in="flood" in2="outline" result="coloredOutline"/>
                  </filter>
              </defs>

              {isSelected && !onlyHandles && (
                  <circle cx={0} cy={0} r={handleRadius} fill="#646cff" vectorEffect="non-scaling-stroke"/>
              )}
              
              {!onlyHandles && (
                  <>
                      {/* 1. FILL PASS: Opaque group with overall opacity for single background */}
                      <g opacity={highestLayer ? (isSelected ? 0.3 : 0.2) : 0.05}>
                          {[...u.shapes].reverse().map((child, idx) => (
                              <RecursiveShapeRenderer
                                key={`fill-${shape.id}-${child.id}-${idx}`}
                                shape={child}
                                allFootprints={allFootprints}
                                params={params}
                                stackup={stackup}
                                isSelected={false}
                                isParentSelected={isSelected}
                                onMouseDown={() => {}} 
                                onHandleDown={() => {}} 
                                handleRadius={handleRadius}
                                rootFootprint={u as unknown as Footprint}
                                layerVisibility={layerVisibility}
                                onlyHandles={false}
                                strokeScale={strokeScale}
                                overrideStyle={{ fill: highestLayer ? highestLayer.color : defaultFill, stroke: "none" }}
                              />
                          ))}
                      </g>
                      {/* 2. OUTLINE PASS: Apply silhouette filter for merged outline */}
                      <g filter={`url(#${filterId})`}>
                          {[...u.shapes].reverse().map((child, idx) => (
                              <RecursiveShapeRenderer
                                key={`outline-${shape.id}-${child.id}-${idx}`}
                                shape={child}
                                allFootprints={allFootprints}
                                params={params}
                                stackup={stackup}
                                isSelected={false}
                                isParentSelected={isSelected}
                                onMouseDown={() => {}} 
                                onHandleDown={() => {}} 
                                handleRadius={handleRadius}
                                rootFootprint={u as unknown as Footprint}
                                layerVisibility={layerVisibility}
                                onlyHandles={false}
                                strokeScale={strokeScale}
                                overrideStyle={{ fill: "black", stroke: "none" }}
                              />
                          ))}
                      </g>
                  </>
              )}
          </g>
      );
  }

  // --- PRIMITIVE SHAPES ---

  // If onlyHandles is true and we aren't a Line or Polygon, there is nothing to draw in this pass
  if (onlyHandles && shape.type !== "line" && shape.type !== "polygon") return null;
  
  // Default styles (unassigned)
  let fill = isSelected ? "rgba(100, 108, 255, 0.1)" : "rgba(255, 255, 255, 0.05)";
  let stroke = isSelected ? "#646cff" : "#888";
  let strokeWidth = isSelected ? 2 : 1;
  const vectorEffect = "non-scaling-stroke";

  // Calculate Color based on highest VISIBLE layer
  const assigned = shape.assignedLayers || {};
  const highestLayer = stackup.find(l => assigned[l.id] !== undefined && layerVisibility[l.id] !== false);

  if (highestLayer) {
      stroke = highestLayer.color;
      strokeWidth = isSelected ? 2 : 1;

      // UPDATED: Standardized transparent fill using hexToRgba
      fill = hexToRgba(highestLayer.color, 0.2);
  }

  // Apply override from Union parent
  if (overrideStyle) {
      if (overrideStyle.fill) fill = overrideStyle.fill;
      if (overrideStyle.stroke) stroke = overrideStyle.stroke;
      strokeWidth = 0;
  }

  // If inside a selected parent footprint, highlight slightly
  if (isParentSelected && !isSelected && !overrideStyle) {
      stroke = "#aaa";
  }

  const commonProps = {
    onMouseDown: (e: React.MouseEvent) => {
      if (!overrideStyle) onMouseDown(e, shape.id);
    },
    fill,
    stroke,
    strokeWidth,
    vectorEffect,
    style: { cursor: overrideStyle ? "inherit" : "pointer" },
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

  if (shape.type === "polygon") {
      const originX = evaluateExpression(shape.x, params);
      const originY = evaluateExpression(shape.y, params);
      const pts = shape.points.map(p => {
          const resolved = resolvePoint(p, rootFootprint, allFootprints, params);
          return {
              x: originX + resolved.x,
              y: originY + resolved.y,
              hIn: resolved.handleIn,
              hOut: resolved.handleOut,
              isSnapped: !!p.snapTo
          };
      });

      let d = "";
      const midPoints = [];

      if (pts.length > 0) {
          d = `M ${pts[0].x} ${-pts[0].y}`;
          for (let i = 0; i < pts.length; i++) {
              const curr = pts[i];
              const next = pts[(i + 1) % pts.length];
              const cp1x = curr.x + (curr.hOut?.x || 0);
              const cp1y = -(curr.y + (curr.hOut?.y || 0));
              const cp2x = next.x + (next.hIn?.x || 0);
              const cp2y = -(next.y + (next.hIn?.y || 0));
              
              if (curr.hOut || next.hIn) {
                  const midX = bezier1D(curr.x, curr.x + (curr.hOut?.x || 0), next.x + (next.hIn?.x || 0), next.x, 0.5);
                  const midY = bezier1D(curr.y, curr.y + (curr.hOut?.y || 0), next.y + (next.hIn?.y || 0), next.y, 0.5);
                  midPoints.push({ index: i, x: midX, y: -midY });
              } else {
                  midPoints.push({ index: i, x: (curr.x + next.x) / 2, y: -(curr.y + next.y) / 2 });
              }

              d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${-next.y}`;
          }
          d += " Z";
      }

      const handles = (isSelected && !overrideStyle) ? pts.map((pt, idx) => {
          const elements = [];
          const isHovered = hoveredPointIndex === idx;
          const anchorColor = pt.isSnapped ? "#00ff00" : (isHovered ? "#ffaa00" : "#fff");
          const anchorRadius = isHovered ? handleRadius * 1.3 : handleRadius;

          elements.push(
              <circle key={`poly-anchor-${idx}`} cx={pt.x} cy={-pt.y} 
                  r={anchorRadius} 
                  fill={anchorColor} stroke="#646cff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                  onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, shape.id, idx); }}
                  onMouseEnter={() => setHoveredPointIndex && setHoveredPointIndex(idx)}
                  onMouseLeave={() => setHoveredPointIndex && setHoveredPointIndex(null)}
              />
          );
          if (pt.hIn) {
              const hx = pt.x + pt.hIn.x;
              const hy = -(pt.y + pt.hIn.y);
              elements.push(
                  <line key={`poly-line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`poly-handle-in-${idx}`} cx={hx} cy={hy} r={handleRadius * 0.8} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'in'); }} />
              );
          }
          if (pt.hOut) {
              const hx = pt.x + pt.hOut.x;
              const hy = -(pt.y + pt.hOut.y);
              elements.push(
                  <line key={`poly-line-out-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`poly-handle-out-${idx}`} cx={hx} cy={hy} r={handleRadius * 0.8} fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'out'); }} />
              );
          }
          return elements;
      }) : null;

      const midButtons = (isSelected && !overrideStyle) ? midPoints.map(m => {
          const isHovered = hoveredMidpointIndex === m.index;
          const bgFill = isHovered ? "#ffaa00" : "#333";
          const strokeColor = isHovered ? "#fff" : "#666";
          const plusColor = isHovered ? "#000" : "white";
          const r = handleRadius * (isHovered ? 1.0 : 0.8);

          return (
              <g key={`mid-${m.index}`} style={{ cursor: "pointer" }}
                  onClick={(e) => { e.stopPropagation(); onAddMidpoint && onAddMidpoint(shape.id, m.index); }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onMouseEnter={() => setHoveredMidpointIndex && setHoveredMidpointIndex(m.index)}
                  onMouseLeave={() => setHoveredMidpointIndex && setHoveredMidpointIndex(null)}
              >
                  <circle cx={m.x} cy={m.y} r={r} fill={bgFill} stroke={strokeColor} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <line x1={m.x - r * 0.5} y1={m.y} x2={m.x + r * 0.5} y2={m.y} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                  <line x1={m.x} y1={m.y - r * 0.5} x2={m.x} y2={m.y + r * 0.5} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </g>
          );
      }) : null;

      if (onlyHandles) {
          return <g>{handles}{midButtons}</g>;
      }

      return (
          <g>
              <path d={d} {...commonProps} />
              {handles}
              {midButtons}
          </g>
      );
  }

  if (shape.type === "line") {
      const thickness = evaluateExpression((shape as FootprintLine).thickness, params);
      
        const pts = shape.points.map(p => {
            const resolved = resolvePoint(p, rootFootprint, allFootprints, params);
            return {
                x: resolved.x,
                y: resolved.y,
                hIn: resolved.handleIn,
                hOut: resolved.handleOut,
                isSnapped: !!p.snapTo
            };
        });

        // 1. Generate Centerline for calculation
        const midPoints = [];
        
        if (pts.length > 0) {
            for (let i = 0; i < pts.length - 1; i++) {
                const curr = pts[i];
                const next = pts[i+1];
                if (curr.hOut || next.hIn) {
                    const midX = bezier1D(curr.x, curr.x + (curr.hOut?.x || 0), next.x + (next.hIn?.x || 0), next.x, 0.5);
                    const midY = bezier1D(curr.y, curr.y + (curr.hOut?.y || 0), next.y + (next.hIn?.y || 0), next.y, 0.5);
                    midPoints.push({ index: i, x: midX, y: -midY });
                } else {
                    midPoints.push({ index: i, x: (curr.x + next.x) / 2, y: -(curr.y + next.y) / 2 });
                }
            }
        }

        // 2. Generate Outline Path for Visuals
        const outlineD = generateLineOutlinePath(pts, thickness);

      const handles = (isSelected && !overrideStyle) ? pts.map((pt, idx) => {
          const elements = [];
          const isHovered = hoveredPointIndex === idx;
          const anchorFill = pt.isSnapped ? "#00ff00" : (isHovered ? "#ffaa00" : "#fff");
          const anchorRadius = isHovered ? handleRadius * 1.3 : handleRadius;

          elements.push(
              <circle 
                  key={`anchor-${idx}`}
                  cx={pt.x} cy={-pt.y} 
                  r={anchorRadius} 
                  fill={anchorFill} stroke="#646cff" strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  onMouseDown={(e) => {
                      e.stopPropagation();
                      onMouseDown(e, shape.id, idx);
                  }}
                  onMouseEnter={() => setHoveredPointIndex && setHoveredPointIndex(idx)}
                  onMouseLeave={() => setHoveredPointIndex && setHoveredPointIndex(null)}
              />
          );

          if (pt.hIn) {
              const hx = pt.x + pt.hIn.x;
              const hy = -(pt.y + pt.hIn.y);
              elements.push(
                  <line key={`line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`handle-in-${idx}`} cx={hx} cy={hy} 
                      r={handleRadius * 0.8} 
                      fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'in'); }} />
              );
          }
          if (pt.hOut) {
              const hx = pt.x + pt.hOut.x;
              const hy = -(pt.y + pt.hOut.y);
              elements.push(
                  <line key={`line-out-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                  <circle key={`handle-out-${idx}`} cx={hx} cy={hy} 
                      r={handleRadius * 0.8} 
                      fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                      onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'out'); }} />
              );
          }
          return elements;
      }) : null;

      const midButtons = (isSelected && !overrideStyle) ? midPoints.map(m => {
          const isHovered = hoveredMidpointIndex === m.index;
          const bgFill = isHovered ? "#ffaa00" : "#333";
          const strokeColor = isHovered ? "#fff" : "#666";
          const plusColor = isHovered ? "#000" : "white";
          const r = handleRadius * (isHovered ? 1.0 : 0.8);

          return (
            <g 
                key={`mid-${m.index}`} 
                style={{ cursor: "pointer" }}
                onClick={(e) => { e.stopPropagation(); onAddMidpoint && onAddMidpoint(shape.id, m.index); }}
                onMouseDown={(e) => e.stopPropagation()} 
                onMouseEnter={() => setHoveredMidpointIndex && setHoveredMidpointIndex(m.index)}
                onMouseLeave={() => setHoveredMidpointIndex && setHoveredMidpointIndex(null)}
            >
                <circle cx={m.x} cy={m.y} r={r} fill={bgFill} stroke={strokeColor} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <line x1={m.x - r * 0.5} y1={m.y} x2={m.x + r * 0.5} y2={m.y} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <line x1={m.x} y1={m.y - r * 0.5} x2={m.x} y2={m.y + r * 0.5} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
          );
      }) : null;

      if (onlyHandles) {
          return <g>{handles}{midButtons}</g>;
      }

      return (
          <g>
            {/* UPDATED: Render the line as a shape outline rather than a thick stroke to allow transparent fill */}
            <path 
                d={outlineD} 
                {...commonProps} 
                vectorEffect="non-scaling-stroke"
                style={{ ...commonProps.style, opacity: isSelected ? 1 : 0.8 }}
            />
            {handles}
            {midButtons}
          </g>
      );
  }

  if (shape.type === "text") {
    const txt = shape as FootprintText;
    const x = evaluateExpression(txt.x, params);
    const y = evaluateExpression(txt.y, params);
    const angle = evaluateExpression(txt.angle, params);
    const fontSize = evaluateExpression(txt.fontSize, params);
    const lines = (txt.text || "").split('\n');
    
    // Use selection color if selected, otherwise default to a comment-grey
    let fill = isSelected ? "#646cff" : "#aaa";
    if (overrideStyle?.fill) fill = overrideStyle.fill;

    return (
        <text
            transform={`translate(${x}, ${-y}) rotate(${-angle})`}
            fontSize={fontSize}
            textAnchor={txt.anchor || "start"}
            fill={fill}
            style={{ 
                cursor: "pointer", 
                userSelect: "none", 
                fontFamily: "monospace",
                pointerEvents: "auto" 
            }}
            onMouseDown={(e) => onMouseDown(e, shape.id)}
            onDoubleClick={(e) => onDoubleClick && onDoubleClick(e, shape.id)}
        >
            {lines.map((line, i) => (
                <tspan key={i} x="0" y={i * fontSize * 1.2} >
                    {/* If a line is empty, render a space so the tspan maintains height */}
                    {line || " "}
                </tspan>
            ))}
        </text>
    );
  }

  return null;
};

// BOARD OUTLINE RENDERER
export const BoardOutlineRenderer = ({
  shape,
  isSelected,
  params,
  onMouseDown,
  onHandleDown,
  handleRadius,
  rootFootprint,
  allFootprints,
  hoveredPointIndex,
  setHoveredPointIndex,
  hoveredMidpointIndex,
  setHoveredMidpointIndex,
  onAddMidpoint,
  onlyHandles = false,
}: {
  shape: FootprintBoardOutline;
  isSelected: boolean;
  params: Parameter[];
  onMouseDown: (e: React.MouseEvent, id: string, idx?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, idx: number, type: 'in' | 'out') => void;
  handleRadius: number;
  rootFootprint: Footprint;
  allFootprints: Footprint[];
  hoveredPointIndex?: number | null;
  setHoveredPointIndex?: (index: number | null) => void;
  hoveredMidpointIndex?: number | null;
  setHoveredMidpointIndex?: (index: number | null) => void;
  onAddMidpoint?: (shapeId: string, index: number) => void;
  onlyHandles?: boolean;
}) => {
    const points = shape.points;
    const stroke = isSelected ? "#646cff" : "#555";
    // UPDATED: Thinner outlines (1px/2px)
    const strokeWidth = isSelected ? 2 : 1; 
    const strokeDasharray = isSelected ? "0" : "5,5";

    const originX = evaluateExpression(shape.x, params);
    const originY = evaluateExpression(shape.y, params);

    const pts = points.map(p => {
        const resolved = resolvePoint(p, rootFootprint, allFootprints, params);
        return {
            x: originX + resolved.x,
            y: originY + resolved.y,
            hIn: resolved.handleIn,
            hOut: resolved.handleOut,
            isSnapped: !!p.snapTo
        };
    });

    let d = "";
    const midPoints = [];

    if (pts.length > 0) {
        d = `M ${pts[0].x} ${-pts[0].y}`;
        for (let i = 0; i < pts.length; i++) {
            const curr = pts[i];
            const next = pts[(i + 1) % pts.length];
            const cp1x = curr.x + (curr.hOut?.x || 0);
            const cp1y = -(curr.y + (curr.hOut?.y || 0));
            const cp2x = next.x + (next.hIn?.x || 0);
            const cp2y = -(next.y + (next.hIn?.y || 0));
            
            if (curr.hOut || next.hIn) {
                const midX = bezier1D(curr.x, curr.x + (curr.hOut?.x || 0), next.x + (next.hIn?.x || 0), next.x, 0.5);
                const midY = bezier1D(curr.y, curr.y + (curr.hOut?.y || 0), next.y + (next.hIn?.y || 0), next.y, 0.5);
                midPoints.push({ index: i, x: midX, y: -midY });
            } else {
                midPoints.push({ index: i, x: (curr.x + next.x) / 2, y: -(curr.y + next.y) / 2 });
            }

            d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${-next.y}`;
        }
        d += " Z";
    }

    const handles = isSelected ? pts.map((pt, idx) => {
        const elements = [];
        const isHovered = hoveredPointIndex === idx;
        const anchorColor = pt.isSnapped ? "#00ff00" : (isHovered ? "#ffaa00" : "#fff");
        const anchorRadius = isHovered ? handleRadius * 1.3 : handleRadius;

        elements.push(
            <circle key={`bo-anchor-${idx}`} cx={pt.x} cy={-pt.y} 
                r={anchorRadius} 
                fill={anchorColor} stroke="#646cff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, shape.id, idx); }}
                onMouseEnter={() => setHoveredPointIndex && setHoveredPointIndex(idx)}
                onMouseLeave={() => setHoveredPointIndex && setHoveredPointIndex(null)}
            />
        );
        if (pt.hIn) {
            const hx = pt.x + pt.hIn.x;
            const hy = -(pt.y + pt.hIn.y);
            elements.push(
                <line key={`bo-line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                <circle key={`bo-handle-in-${idx}`} cx={hx} cy={hy} 
                    r={handleRadius * 0.8}
                    fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                    onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'in'); }} />
            );
        }
        if (pt.hOut) {
            const hx = pt.x + pt.hOut.x;
            const hy = -(pt.y + pt.hOut.y);
            elements.push(
                <line key={`bo-line-out-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                <circle key={`bo-handle-out-${idx}`} cx={hx} cy={hy} 
                    r={handleRadius * 0.8}
                    fill="#646cff" vectorEffect="non-scaling-stroke" style={{cursor: 'crosshair'}}
                    onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, idx, 'out'); }} />
            );
        }
        return elements;
    }) : null;

    const midButtons = isSelected ? midPoints.map(m => {
        const isHovered = hoveredMidpointIndex === m.index;
        const bgFill = isHovered ? "#ffaa00" : "#333";
        const strokeColor = isHovered ? "#fff" : "#666";
        const plusColor = isHovered ? "#000" : "white";
        const r = handleRadius * (isHovered ? 1.0 : 0.8);

        return (
            <g 
            key={`mid-${m.index}`} 
            style={{ cursor: "pointer" }}
            onClick={(e) => { e.stopPropagation(); onAddMidpoint && onAddMidpoint(shape.id, m.index); }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredMidpointIndex && setHoveredMidpointIndex(m.index)}
            onMouseLeave={() => setHoveredMidpointIndex && setHoveredMidpointIndex(null)}
            >
                <circle cx={m.x} cy={m.y} r={r} fill={bgFill} stroke={strokeColor} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <line x1={m.x - r * 0.5} y1={m.y} x2={m.x + r * 0.5} y2={m.y} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <line x1={m.x} y1={m.y - r * 0.5} x2={m.x} y2={m.y + r * 0.5} stroke={plusColor} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            </g>
        );
    }) : null;

    if (onlyHandles) {
        return <g>{handles}{midButtons}</g>;
    }

    return (
        <g>
            <path d={d} fill="none" stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" style={{ cursor: "pointer" }}
                onMouseDown={(e) => onMouseDown(e, shape.id)} />
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={strokeDasharray} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            {handles}
            {midButtons}
        </g>
    );
};