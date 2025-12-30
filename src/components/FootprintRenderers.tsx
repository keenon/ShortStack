// src/components/FootprintRenderers.tsx
import React from "react";
import { Footprint, FootprintShape, Parameter, StackupLayer, Point, FootprintReference, FootprintRect, FootprintWireGuide, FootprintBoardOutline } from "../types";
import { evaluateExpression, interpolateColor, resolvePoint } from "../utils/footprintUtils";

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
  handleRadius,
  rootFootprint, // NEW: Context for point resolution
  layerVisibility,
}: {
  shape: FootprintShape;
  allFootprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
  isSelected: boolean;
  isParentSelected: boolean;
  onMouseDown: (e: React.MouseEvent, id: string, pointIndex?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => void;
  handleRadius: number;
  rootFootprint: Footprint; // NEW
  layerVisibility: Record<string, boolean>;
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
          />
      );
  }

  // --- WIRE GUIDE RENDERER (Virtual Shape) ---
  if (shape.type === "wireGuide") {
    const wg = shape as FootprintWireGuide;
    const x = evaluateExpression(wg.x, params);
    const y = evaluateExpression(wg.y, params);

    // Rendered with dotted/dashed lines in green to indicate "virtual" and "guide"
    const stroke = isSelected ? "#646cff" : "#00ff00";
    const vectorEffect = "non-scaling-stroke";

    const elements = [];
    
    // Constant size markers based on handleRadius, but slightly larger than standard handles
    const markerSize = handleRadius * 3.0;
    const circleRadius = handleRadius * 2.0;

    // Main marker (Crosshair)
    elements.push(
      <g key="marker" style={{ cursor: "pointer" }} onMouseDown={(e) => onMouseDown(e, shape.id)}>
        <line x1={x - markerSize} y1={-y} x2={x + markerSize} y2={-y} stroke={stroke} strokeWidth={1} vectorEffect={vectorEffect} strokeDasharray="2,2" />
        <line x1={x} y1={-(y - markerSize)} x2={x} y2={-(y + markerSize)} stroke={stroke} strokeWidth={1} vectorEffect={vectorEffect} strokeDasharray="2,2" />
        <circle cx={x} cy={-y} r={circleRadius} fill="transparent" stroke={stroke} strokeWidth={1} vectorEffect={vectorEffect} strokeDasharray="1,1" />
      </g>
    );

    // Draggable handles for the guide itself
    if (isSelected) {
      if (wg.handleIn) {
        const hx = x + evaluateExpression(wg.handleIn.x, params);
        const hy = -(y + evaluateExpression(wg.handleIn.y, params));
        elements.push(
          <line key="h-in-l" x1={x} y1={-y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect={vectorEffect} strokeDasharray="2,2" />,
          <circle key="h-in-c" cx={hx} cy={hy} r={handleRadius * 0.8} fill={stroke} vectorEffect={vectorEffect} style={{ cursor: 'crosshair' }}
            onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, 0, 'in'); }} />
        );
      }
      if (wg.handleOut) {
        const hx = x + evaluateExpression(wg.handleOut.x, params);
        const hy = -(y + evaluateExpression(wg.handleOut.y, params));
        elements.push(
          <line key="h-out-l" x1={x} y1={-y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect={vectorEffect} strokeDasharray="2,2" />,
          <circle key="h-out-c" cx={hx} cy={hy} r={handleRadius * 0.8} fill={stroke} vectorEffect={vectorEffect} style={{ cursor: 'crosshair' }}
            onMouseDown={(e) => { e.stopPropagation(); onHandleDown(e, shape.id, 0, 'out'); }} />
        );
      }
    }

    return <g>{elements}</g>;
  }

  // If this is a reference to another footprint, we render that footprint's shapes inside a group
  if (shape.type === "footprint") {
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
            style={containerStyle}
          >
              {/* Optional: Selection Indicator for the Group */}
              {isSelected && <circle cx={0} cy={0} r={handleRadius} fill="#646cff" vectorEffect="non-scaling-stroke"/>}
              
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
                    handleRadius={handleRadius}
                    rootFootprint={rootFootprint}
                    layerVisibility={layerVisibility}
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

  // Calculate Color based on highest VISIBLE layer
  const assigned = shape.assignedLayers || {};
  const highestLayer = stackup.find(l => assigned[l.id] !== undefined && layerVisibility[l.id] !== false);

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
      
        const pts = shape.points.map(p => {
            const resolved = resolvePoint(p, rootFootprint, allFootprints, params);
            return {
                x: resolved.x,
                y: resolved.y,
                hIn: resolved.handleIn,   // These are now global-frame relative vectors
                hOut: resolved.handleOut, // These are now global-frame relative vectors
                isSnapped: !!p.snapTo
            };
        });

        let d = "";
        if (pts.length > 0) {
            d = `M ${pts[0].x} ${-pts[0].y}`;
            for (let i = 0; i < pts.length - 1; i++) {
                const curr = pts[i];
                const next = pts[i+1];
                
                // Use the handles directly because they were rotated by resolvePoint
                const cp1x = curr.x + (curr.hOut?.x || 0);
                const cp1y = -(curr.y + (curr.hOut?.y || 0)); // SVG Y is inverted
                const cp2x = next.x + (next.hIn?.x || 0);
                const cp2y = -(next.y + (next.hIn?.y || 0));
                
                d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${next.x} ${-next.y}`;
            }
        }

      // Render Handles only if strictly selected (not just parent selected)
      const handles = isSelected ? pts.map((pt, idx) => {
          const elements = [];
          
          // Anchor Point: Green if snapped to a guide
          const anchorFill = pt.isSnapped ? "#00ff00" : "#fff";

          elements.push(
              <circle 
                  key={`anchor-${idx}`}
                  cx={pt.x} cy={-pt.y} 
                  r={handleRadius} // Use scaled radius
                  fill={anchorFill} stroke="#646cff" strokeWidth={1}
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
                  <circle key={`handle-in-${idx}`} cx={hx} cy={hy} 
                      r={handleRadius * 0.8} // Slightly smaller handle for controls
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
}: {
  shape: FootprintBoardOutline;
  isSelected: boolean;
  params: Parameter[];
  onMouseDown: (e: React.MouseEvent, id: string, idx?: number) => void;
  onHandleDown: (e: React.MouseEvent, id: string, idx: number, type: 'in' | 'out') => void;
  handleRadius: number;
  rootFootprint: Footprint;
  allFootprints: Footprint[];
}) => {
    const points = shape.points;
    const stroke = isSelected ? "#646cff" : "#555";
    const strokeWidth = isSelected ? 3 : 2;
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
        const anchorColor = pt.isSnapped ? "#00ff00" : "#fff";

        elements.push(
            <circle key={`bo-anchor-${idx}`} cx={pt.x} cy={-pt.y} 
                r={handleRadius} // Use scaled radius
                fill={anchorColor} stroke="#646cff" strokeWidth={1} vectorEffect="non-scaling-stroke"
                onMouseDown={(e) => { e.stopPropagation(); onMouseDown(e, shape.id, idx); }} />
        );
        if (pt.hIn) {
            const hx = pt.x + pt.hIn.x;
            const hy = -(pt.y + pt.hIn.y);
            elements.push(
                <line key={`bo-line-in-${idx}`} x1={pt.x} y1={-pt.y} x2={hx} y2={hy} stroke="#888" strokeWidth={1} vectorEffect="non-scaling-stroke" />,
                <circle key={`bo-handle-in-${idx}`} cx={hx} cy={hy} 
                    r={handleRadius * 0.8} // Smaller control handles
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

    return (
        <g>
            <path d={d} fill="none" stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke" style={{ cursor: "pointer" }}
                onMouseDown={(e) => onMouseDown(e, shape.id)} />
            <path d={d} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={strokeDasharray} vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            {handles}
        </g>
    );
};