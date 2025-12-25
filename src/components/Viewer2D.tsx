// src/components/Viewer2D.tsx
import React, { useRef, useLayoutEffect, useEffect } from "react";
import * as math from "mathjs";
import { 
  Parameter, 
  StackupLayer, 
  FootprintShape, 
  FootprintInstance, 
  BoardOutline, 
  FootprintRect, 
  FootprintCircle, 
  FootprintLine,
  Footprint,
  LayerAssignment 
} from "../types";

// ------------------------------------------------------------------
// HELPERS (Moved from FootprintEditor)
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
          const newVal = val - delta;
          if (newVal >= 0) {
               return `${prefix}- ${parseFloat(newVal.toFixed(4))}`;
          } else {
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
      const val = p.unit === "in" ? p.value * 25.4 : p.value;
      scope[p.key] = val;
    });
    const result = math.evaluate(exprStr, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0;
  }
}

export function interpolateColor(hex: string, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  if (r === 1) return "black";
  if (r === 0) return hex;

  let c = hex.trim();
  if (c.startsWith("#")) c = c.substring(1);
  if (c.length === 3) c = c.split("").map(char => char + char).join("");
  if (c.length !== 6) return "black";

  const num = parseInt(c, 16);
  const red = (num >> 16) & 0xff;
  const green = (num >> 8) & 0xff;
  const blue = num & 0xff;

  const f = 1 - r;
  return `rgb(${Math.round(red * f)}, ${Math.round(green * f)}, ${Math.round(blue * f)})`;
}

// ------------------------------------------------------------------
// TYPES
// ------------------------------------------------------------------

export type Viewer2DItem = 
  | { type: "shape"; id: string; data: FootprintShape; selected: boolean; visible: boolean; }
  | { type: "instance"; id: string; data: FootprintInstance; footprint: Footprint; selected: boolean; visible: boolean; }
  | { type: "board"; id: string; data: BoardOutline; selected: boolean; visible: boolean; };

interface Props {
  items: Viewer2DItem[];
  params: Parameter[];
  stackup: StackupLayer[];
  viewBox: { x: number; y: number; width: number; height: number };
  setViewBox: (vb: { x: number; y: number; width: number; height: number }) => void;
  // Generic callback for item interactions
  // subId: Point Index (Line) or Point ID (Board)
  // handleType: 'in' | 'out' (Bezier Handles)
  onItemDown: (e: React.MouseEvent, item: Viewer2DItem, subId?: string | number, handleType?: 'in' | 'out') => void;
  // Optional ref to get access to the wrapper div for drag calculations in parent
  wrapperRef?: React.RefObject<HTMLDivElement>;
}

// ------------------------------------------------------------------
// RENDERERS
// ------------------------------------------------------------------

const ShapeRenderer = ({
  item,
  params,
  stackup,
  onDown
}: {
  item: Viewer2DItem & { type: "shape" };
  params: Parameter[];
  stackup: StackupLayer[];
  onDown: (e: React.MouseEvent, subId?: number, handleType?: 'in' | 'out') => void;
}) => {
  const shape = item.data;
  const isSelected = item.selected;

  let fill = isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)";
  let stroke = isSelected ? "#646cff" : "#888";
  let strokeWidth = isSelected ? 2 : 1;
  const vectorEffect = "non-scaling-stroke";

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

  const commonProps = {
    onMouseDown: (e: React.MouseEvent) => onDown(e),
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
              const endX = next.x;
              const endY = -next.y;
              d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
          }
      }

      const handles = isSelected ? pts.map((pt, idx) => {
          const elements = [];
          
          // Anchor
          elements.push(
              <circle 
                  key={`anchor-${idx}`}
                  cx={pt.x} cy={-pt.y} r={3/strokeWidth} 
                  fill="#fff" stroke="#646cff" strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                  onMouseDown={(e) => {
                      e.stopPropagation();
                      onDown(e, idx);
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
                        onDown(e, idx, 'in');
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
                        onDown(e, idx, 'out');
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

// Simplified renderer for instances (groups of shapes)
// Reuses logic but applies Instance Transforms
const InstanceRenderer = ({
    item,
    params,
    stackup,
    onDown
}: {
    item: Viewer2DItem & { type: "instance" };
    params: Parameter[];
    stackup: StackupLayer[];
    onDown: (e: React.MouseEvent) => void;
}) => {
    const inst = item.data;
    const fp = item.footprint;
    const isSelected = item.selected;

    if (!fp) return null;
    
    const evalX = evaluateExpression(inst.x, params);
    const evalY = evaluateExpression(inst.y, params);
    const evalAngle = evaluateExpression(inst.angle, params);

    return (
        <g 
            transform={`translate(${evalX}, ${-evalY}) rotate(${-evalAngle})`}
            style={{ cursor: 'grab' }}
            onMouseDown={onDown}
        >
            {/* Invisible hit area for easier selection */}
            <circle r="5" fill="transparent" />
            
            <g style={{ filter: isSelected ? 'drop-shadow(0 0 2px #646cff)' : undefined }}>
                {/* 
                   We construct synthetic "Shape" items to reuse the ShapeRenderer logic 
                   purely for visual consistency (colors, depths), 
                   but we disable interaction on children (passed no-op onDown).
                */}
                {[...fp.shapes].reverse().map(shape => {
                    // Filter visibility based on parent's visibility logic passed down via props?
                    // The Viewer2D receives pre-filtered items, but for Instances, the instance is the item.
                    // We need to check if the shape's layers are visible. 
                    // However, Viewer2D doesn't know about layer visibility state explicitly, 
                    // it expects the parent to have filtered the items list.
                    // But for instances, we pass the whole instance.
                    // Let's assume visibility is handled by rendering all shapes of the instance 
                    // unless we want to inject layer visibility into Viewer2D props.
                    // For simplicity, we render all assigned shapes, but we might want to pass a 
                    // "isLayerVisible" callback in the future. 
                    
                    // Construct a synthetic item for rendering
                    const subItem: Viewer2DItem & { type: 'shape' } = {
                        type: 'shape',
                        id: shape.id,
                        data: shape,
                        selected: false, // Children not individually selectable in Layout mode
                        visible: true 
                    };

                    return (
                        <ShapeRenderer 
                            key={shape.id}
                            item={subItem}
                            params={params}
                            stackup={stackup}
                            onDown={(e) => { e.stopPropagation(); onDown(e); }} // Propagate to instance handler
                        />
                    );
                })}
            </g>
        </g>
    );
};

const BoardRenderer = ({
    item,
    params,
    onDown
}: {
    item: Viewer2DItem & { type: "board" };
    params: Parameter[];
    onDown: (e: React.MouseEvent, pointId?: string) => void;
}) => {
    const outline = item.data;
    const isSelected = item.selected;

    const pointsStr = outline.points
        .map(p => `${evaluateExpression(p.x, params)},${-evaluateExpression(p.y, params)}`)
        .join(' ');

    const handleSize = 5; // Fixed size or scaled?

    return (
        <g>
            <polygon 
                points={pointsStr}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
                onMouseDown={(e) => onDown(e)}
            />
            <polygon 
                points={pointsStr}
                fill="none"
                stroke={isSelected ? "#646cff" : "#555"}
                strokeWidth={isSelected ? 3 : 2}
                strokeDasharray={isSelected ? "0" : "5,5"}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
            />
            {isSelected && outline.points.map((p) => {
                  const px = evaluateExpression(p.x, params);
                  const py = evaluateExpression(p.y, params);
                  return (
                    <rect
                        key={p.id}
                        x={px - handleSize / 2}
                        y={-py - handleSize / 2}
                        width={handleSize}
                        height={handleSize}
                        fill="#fff"
                        stroke="#646cff"
                        strokeWidth={1}
                        style={{ cursor: 'grab' }}
                        vectorEffect="non-scaling-stroke"
                        onMouseDown={(e) => {
                            e.stopPropagation();
                            onDown(e, p.id);
                        }}
                    />
                  );
            })}
        </g>
    );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function Viewer2D({ 
    items, 
    params, 
    stackup, 
    viewBox, 
    setViewBox, 
    onItemDown,
    wrapperRef: externalWrapperRef
}: Props) {
    const internalWrapperRef = useRef<HTMLDivElement>(null);
    const wrapperRef = externalWrapperRef || internalWrapperRef;

    const viewBoxRef = useRef(viewBox);
    useEffect(() => { viewBoxRef.current = viewBox; }, [viewBox]);

    // Dragging state for PANNING
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const dragStartViewBox = useRef({ x: 0, y: 0 });

    // --- RESIZE OBSERVER (Adaptive Grid/Fill) ---
    useLayoutEffect(() => {
        if (!wrapperRef.current) return;
        
        const updateDimensions = () => {
            if (!wrapperRef.current) return;
            const { width, height } = wrapperRef.current.getBoundingClientRect();
            if (width === 0 || height === 0) return;
                
            setViewBox({
                ...viewBoxRef.current,
                height: viewBoxRef.current.width / (width / height)
            });
        };

        const observer = new ResizeObserver(() => {
            updateDimensions();
        });
        
        observer.observe(wrapperRef.current);
        updateDimensions(); 

        return () => observer.disconnect();
    }, []); // Empty deps, logic relies on refs mostly, though setViewBox might change

    // --- ZOOM HANDLER ---
    useEffect(() => {
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
    }, []);

    // --- PAN HANDLERS ---
    const handleCanvasMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        isDragging.current = true;
        dragStart.current = { x: e.clientX, y: e.clientY };
        dragStartViewBox.current = { x: viewBox.x, y: viewBox.y };
        
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
        if (!isDragging.current || !wrapperRef.current) return;
        
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        
        const rect = wrapperRef.current.getBoundingClientRect();
        const scaleX = viewBoxRef.current.width / rect.width;
        const scaleY = viewBoxRef.current.height / rect.height;
        
        const newX = dragStartViewBox.current.x - dx * scaleX;
        const newY = dragStartViewBox.current.y - dy * scaleY;
        
        setViewBox({
            ...viewBoxRef.current,
            x: newX,
            y: newY
        });
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
        isDragging.current = false;
        window.removeEventListener('mousemove', handleGlobalMouseMove);
        window.removeEventListener('mouseup', handleGlobalMouseUp);
    };

    const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

    // Reverse items for rendering order? 
    // Usually Last item = Top. 
    // SVG renders strictly first-to-last (Painter's algorithm).
    // So the last item in the array is drawn on top.
    // The Editor logic usually expects [...shapes].reverse() map if the input array 
    // has the "top" layer at index 0. 
    // Let's assume the parent passes items in Draw Order (Bottom to Top).
    // If FootprintEditor passes shapes (Top First), it should reverse them before passing.
    
    return (
        <svg 
            className="viewer-2d-canvas" 
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
            onMouseDown={handleCanvasMouseDown}
            style={{ width: '100%', height: '100%', display: 'block' }}
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

            {items.map((item) => {
                if (!item.visible) return null;
                
                if (item.type === "shape") {
                    return (
                        <ShapeRenderer
                            key={item.id}
                            item={item}
                            params={params}
                            stackup={stackup}
                            onDown={(e, subId, type) => {
                                e.stopPropagation();
                                onItemDown(e, item, subId, type);
                            }}
                        />
                    );
                }
                
                if (item.type === "instance") {
                    return (
                        <InstanceRenderer
                            key={item.id}
                            item={item}
                            params={params}
                            stackup={stackup}
                            onDown={(e) => {
                                e.stopPropagation();
                                onItemDown(e, item);
                            }}
                        />
                    );
                }

                if (item.type === "board") {
                    return (
                        <BoardRenderer
                            key={item.id}
                            item={item}
                            params={params}
                            onDown={(e, pointId) => {
                                e.stopPropagation();
                                onItemDown(e, item, pointId);
                            }}
                        />
                    );
                }

                return null;
            })}
        </svg>
    );
}