// src/components/LayoutEditor.tsx
import { useState, useRef, useEffect, useLayoutEffect, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintInstance, Parameter, StackupLayer, FootprintShape, BoardOutline, Point, FootprintRect, FootprintCircle } from "../types";
import { evaluateExpression, modifyExpression } from "../utils/footprintUtils";
import ExpressionEditor from "./ExpressionEditor";
import Layout3DView, { Layout3DViewHandle } from "./Layout3DView";
import './LayoutEditor.css';

interface Props {
  layout: FootprintInstance[];
  setLayout: React.Dispatch<React.SetStateAction<FootprintInstance[]>>;
  boardOutline: BoardOutline;
  setBoardOutline: React.Dispatch<React.SetStateAction<BoardOutline>>;
  footprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

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

// 1. LAYER VISIBILITY PANEL
const LayerVisibilityPanel = ({
  stackup,
  visibility,
  onToggle,
  onExport
}: {
  stackup: StackupLayer[];
  visibility: Record<string, boolean>;
  onToggle: (id: string) => void;
  onExport: (id: string, type: "SVG" | "DXF" | "STL") => void;
}) => {
  return (
    <div className="layout-left-subpanel">
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
             <div key={layer.id} className={`layer-vis-item ${visibility[layer.id] === false ? "is-hidden" : ""}`} style={{flexWrap: 'wrap'}}>
                <div className="layer-vis-info" style={{ width: '100%', marginBottom: '5px' }}>
                    <div 
                        className="layer-color-square"
                        style={{ backgroundColor: layer.color }}
                    />
                    <span className="layer-vis-name" title={layer.name}>{layer.name}</span>
                </div>
                
                <div style={{ display: 'flex', gap: '5px', width: '100%', justifyContent: 'flex-end' }}>
                    <button 
                        className={`vis-toggle-btn ${visibility[layer.id] !== false ? "visible" : "hidden"}`}
                        onClick={() => onToggle(layer.id)}
                        style={{ marginRight: 'auto' }}
                    >
                        {visibility[layer.id] !== false ? "Hide" : "Show"}
                    </button>

                    {layer.type === "Cut" ? (
                        <>
                          <button 
                              className="vis-toggle-btn"
                              onClick={() => onExport(layer.id, "SVG")}
                              title="Export SVG"
                          >
                              SVG
                          </button>
                          <button 
                              className="vis-toggle-btn"
                              onClick={() => onExport(layer.id, "DXF")}
                              title="Export DXF"
                          >
                              DXF
                          </button>
                        </>
                    ) : (
                        <>
                            <button 
                                className="vis-toggle-btn"
                                onClick={() => onExport(layer.id, "STL")}
                                title="Export STL"
                            >
                                STL
                            </button>
                            <button 
                                className="vis-toggle-btn"
                                onClick={() => onExport(layer.id, "SVG")}
                                title="Export SVG"
                            >
                                SVG
                            </button>
                        </>
                    )}
                </div>
             </div>
        ))}
        {stackup.length === 0 && <div className="empty-state-small">No stackup layers.</div>}
      </div>
    </div>
  );
};

// 2. SHAPE RENDERER
const InstanceShapeRenderer = ({ 
    shape, 
    params,
    isSelected,
    stackup
}: { 
    shape: FootprintShape; 
    params: Parameter[];
    isSelected: boolean;
    stackup: StackupLayer[];
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
            // Cut Layer: Solid black
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
        fill,
        stroke,
        strokeWidth,
        vectorEffect: "non-scaling-stroke" as const,
    };

    if (shape.type === "circle") {
        const r = evaluateExpression(shape.diameter, params) / 2;
        const cx = evaluateExpression(shape.x, params);
        const cy = evaluateExpression(shape.y, params);
        // Y-axis flip: -cy
        return <circle cx={cx} cy={-cy} r={r} {...commonProps} />;
    }

    if (shape.type === "rect") {
        const w = evaluateExpression(shape.width, params);
        const h = evaluateExpression(shape.height, params);
        const x = evaluateExpression(shape.x, params);
        const y = evaluateExpression(shape.y, params);
        const angle = evaluateExpression(shape.angle, params);
        // Y-axis flip: (x, -y). Top-Left: (x - w/2, -y - h/2). Angle: -angle.
        return (
            <rect
                x={x - w / 2}
                y={-y - h / 2}
                width={w}
                height={h}
                transform={`rotate(${-angle}, ${x}, ${-y})`}
                {...commonProps}
            />
        );
    }
    return null;
};

// 3. BOARD OUTLINE PROPERTIES
const BoardOutlineProperties = ({ 
    boardOutline, 
    setBoardOutline, 
    params 
}: { 
    boardOutline: BoardOutline, 
    setBoardOutline: React.Dispatch<React.SetStateAction<BoardOutline>>,
    params: Parameter[]
}) => {
    const updatePoint = (id: string, field: "x" | "y", val: string) => {
        setBoardOutline(prev => ({
            ...prev,
            points: prev.points.map(p => p.id === id ? { ...p, [field]: val } : p)
        }));
    };

    const addPoint = () => {
        const lastPoint = boardOutline.points[boardOutline.points.length - 1];
        const newPoint: Point = {
            id: crypto.randomUUID(),
            x: lastPoint ? lastPoint.x : "0",
            y: lastPoint ? lastPoint.y : "0"
        };
        setBoardOutline(prev => ({ ...prev, points: [...prev.points, newPoint] }));
    };

    const addMidpoint = (index: number) => {
        const p1 = boardOutline.points[index];
        const p2 = boardOutline.points[index + 1];
        if (!p1 || !p2) return;

        const isNumeric = (str: string) => {
            const s = str.trim();
            if (s === "") return false;
            return !isNaN(Number(s));
        };

        const calcMid = (v1: string, v2: string) => {
            if (isNumeric(v1) && isNumeric(v2)) {
                return ((Number(v1) + Number(v2)) / 2).toString();
            }
            return `(${v1} + ${v2}) / 2`;
        };

        const newPoint: Point = {
            id: crypto.randomUUID(),
            x: calcMid(p1.x, p2.x),
            y: calcMid(p1.y, p2.y)
        };

        const newPoints = [...boardOutline.points];
        newPoints.splice(index + 1, 0, newPoint);
        setBoardOutline(prev => ({ ...prev, points: newPoints }));
    };

    const deletePoint = (id: string) => {
        if (boardOutline.points.length <= 3) return;
        setBoardOutline(prev => ({ ...prev, points: prev.points.filter(p => p.id !== id) }));
    };

    const movePoint = (index: number, direction: -1 | 1) => {
        if (direction === -1 && index === 0) return;
        if (direction === 1 && index === boardOutline.points.length - 1) return;
        const newPoints = [...boardOutline.points];
        const target = index + direction;
        [newPoints[index], newPoints[target]] = [newPoints[target], newPoints[index]];
        setBoardOutline(prev => ({ ...prev, points: newPoints }));
    };

    return (
        <div className="properties-editor">
            <h3>Board Outline Points</h3>
            
            <div className="board-points-list">
                {boardOutline.points.map((p, idx) => (
                    <Fragment key={p.id}>
                        <div className="board-point-card">
                            <div className="point-header">
                                <span>Point {idx + 1}</span>
                            </div>
                            
                            <div className="point-field-row">
                                <label>X:</label>
                                <div style={{ flexGrow: 1 }}>
                                    <ExpressionEditor 
                                        value={p.x} 
                                        onChange={(v) => updatePoint(p.id, "x", v)} 
                                        params={params} 
                                    />
                                </div>
                            </div>

                            <div className="point-field-row">
                                <label>Y:</label>
                                <div style={{ flexGrow: 1 }}>
                                    <ExpressionEditor 
                                        value={p.y} 
                                        onChange={(v) => updatePoint(p.id, "y", v)} 
                                        params={params} 
                                    />
                                </div>
                            </div>

                            <div className="point-actions-row">
                                <div className="action-buttons">
                                    <button 
                                        className="icon-btn btn-up" 
                                        onClick={() => movePoint(idx, -1)} 
                                        disabled={idx === 0}
                                        title="Move Up"
                                    >↑</button>
                                    <button 
                                        className="icon-btn btn-down" 
                                        onClick={() => movePoint(idx, 1)} 
                                        disabled={idx === boardOutline.points.length - 1}
                                        title="Move Down"
                                    >↓</button>
                                    <button 
                                        className="icon-btn danger" 
                                        onClick={() => deletePoint(p.id)}
                                        disabled={boardOutline.points.length <= 3}
                                        title="Delete Point"
                                    >✕</button>
                                </div>
                            </div>
                        </div>
                        
                        {idx < boardOutline.points.length - 1 && (
                            <div style={{ display: "flex", justifyContent: "center", margin: "5px 0" }}>
                                <button 
                                    onClick={() => addMidpoint(idx)}
                                    style={{ 
                                        cursor: "pointer", 
                                        padding: "4px 8px", 
                                        fontSize: "0.8rem", 
                                        background: "#333", 
                                        border: "1px solid #555", 
                                        color: "#fff", 
                                        borderRadius: "4px" 
                                    }}
                                    title="Insert Midpoint"
                                >
                                    + Midpoint
                                </button>
                            </div>
                        )}
                    </Fragment>
                ))}
            </div>

            <button className="add-btn" onClick={addPoint}>+ Add Point</button>
        </div>
    );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function LayoutEditor({ layout, setLayout, boardOutline, setBoardOutline, footprints, params, stackup }: Props) {
  // SPECIAL ID: We use "BOARD_OUTLINE" as a hardcoded ID for selection
  const [selectedId, setSelectedId] = useState<string | null>("BOARD_OUTLINE");
  
  // Layer Visibility State: undefined/true = visible, false = hidden
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});

  const [viewBox, setViewBox] = useState({ x: -100, y: -100, width: 200, height: 200 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);
  
  // Ref for 3D View to control camera
  const layout3DRef = useRef<Layout3DViewHandle>(null);

  // Dragging State Refs for Canvas Pan
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedId = useRef<string | null>(null);

  // Dragging State Refs for Instances
  const isInstanceDragging = useRef(false);
  const draggedInstanceId = useRef<string | null>(null);
  const instanceDragStartPos = useRef({ x: 0, y: 0 });
  const instanceDragStartExpr = useRef({ x: "0", y: "0" });

  // Dragging State Refs for Board Points
  const isPointDragging = useRef(false);
  const draggedPointId = useRef<string | null>(null);
  const pointDragStartPos = useRef({ x: 0, y: 0 });
  const pointDragStartExpr = useRef({ x: "0", y: "0" });

  // Ref to access latest layout in event handlers
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // --- ACTIONS ---

  const addInstance = (footprintId: string) => {
    const fp = footprints.find(f => f.id === footprintId);
    const newInstance: FootprintInstance = {
        id: crypto.randomUUID(),
        footprintId: footprintId,
        name: fp?.name || "New Instance",
        x: "0",
        y: "0",
        angle: "0"
    };
    setLayout([...layout, newInstance]);
    setSelectedId(newInstance.id);
  };

  const deleteInstance = (id: string) => {
    setLayout(prev => prev.filter(inst => inst.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const updateInstance = (id: string, field: keyof FootprintInstance, value: string) => {
    setLayout(prev => prev.map(inst => inst.id === id ? { ...inst, [field]: value } : inst));
  };

  const toggleLayerVisibility = (id: string) => {
    setLayerVisibility(prev => ({
        ...prev,
        [id]: prev[id] === undefined ? false : !prev[id]
    }));
  };

  // --- EXPORT HANDLER ---
  const handleExport = async (layerId: string, format: "SVG" | "DXF" | "STL") => {
    const layer = stackup.find(l => l.id === layerId);
    if (!layer) return;

    // 1. Open Save Dialog
    const path = await save({
        defaultPath: `${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}_${format.toLowerCase()}.${format.toLowerCase()}`,
        filters: [{
            name: `${format} File`,
            extensions: [format.toLowerCase()]
        }]
    });

    if (!path) return;

    // 2. Prepare Data
    // Evaluate Layer Thickness
    const layerThickness = evaluateExpression(layer.thicknessExpression, params);

    // Evaluate Board Outline
    const outline = boardOutline.points.map(p => ({
        x: evaluateExpression(p.x, params),
        y: evaluateExpression(p.y, params)
    }));

    // Gather Shapes
    const shapes: any[] = [];

    layout.forEach(inst => {
        const fp = footprints.find(f => f.id === inst.footprintId);
        if (!fp) return;

        // Instance Transforms
        const instX = evaluateExpression(inst.x, params);
        const instY = evaluateExpression(inst.y, params);
        const instAngle = evaluateExpression(inst.angle, params);
        const instAngleRad = (instAngle * Math.PI) / 180;
        const cosA = Math.cos(instAngleRad);
        const sinA = Math.sin(instAngleRad);

        // Process shapes in REVERSE order to match the visual stack (last is top)
        // because the visual editor uses [...fp.shapes].reverse()
        [...fp.shapes].reverse().forEach(s => {
            // Check if shape is assigned to this layer
            if (!s.assignedLayers || s.assignedLayers[layer.id] === undefined) return;

            // Calculate Depth
            let depth = 0;
            if (layer.type === "Cut") {
                // For cut layers, depth is usually full thickness
                depth = layerThickness; 
            } else {
                // For carved layers, depth is defined in the footprint assignment
                const val = evaluateExpression(s.assignedLayers[layer.id], params);
                depth = Math.max(0, val);
            }
            if (depth <= 0) return;

            // Transform Shape Center to Absolute World Coordinates
            const sx = evaluateExpression(s.x, params);
            const sy = evaluateExpression(s.y, params);

            // Rotate shape position relative to instance origin
            const rx = sx * cosA - sy * sinA;
            const ry = sx * sinA + sy * cosA;

            const finalX = instX + rx;
            const finalY = instY + ry;

            if (s.type === "circle") {
                shapes.push({
                    shape_type: "circle",
                    x: finalX,
                    y: finalY,
                    diameter: evaluateExpression((s as FootprintCircle).diameter, params),
                    depth: depth
                });
            } else if (s.type === "rect") {
                const sAngle = evaluateExpression((s as FootprintRect).angle, params);
                shapes.push({
                    shape_type: "rect",
                    x: finalX,
                    y: finalY,
                    width: evaluateExpression((s as FootprintRect).width, params),
                    height: evaluateExpression((s as FootprintRect).height, params),
                    angle: instAngle + sAngle, // Sum angles
                    depth: depth
                });
            }
        });
    });

    // 2. Prepare STL Data if needed
    let stlContent: number[] | null = null;
    if (format === "STL") {
        const raw = layout3DRef.current?.getLayerSTL(layerId);
        if (raw) {
            // Convert Uint8Array to normal array for invoke compatibility
            stlContent = Array.from(raw);
        } else {
             alert("Warning: Could not retrieve 3D mesh for STL export. Ensure the layer is visible in the 3D preview.");
             return;
        }
    }

    // 3. Send to Rust
    try {
        await invoke("export_layer_files", {
            request: {
                filepath: path,
                file_type: format,
                machining_type: layer.type,
                cut_direction: layer.carveSide,
                outline,
                shapes,
                layer_thickness: layerThickness,
                stl_content: stlContent
            }
        });
        alert(`Export initiated for ${path}`);
    } catch (e) {
        console.error("Export failed", e);
        alert("Export failed: " + e);
    }
  };

  // --- HELPERS ---

  // Check if a shape should be visible based on its layer assignment and current global visibility
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

  // --- PANNING HANDLERS ---
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
        setSelectedId(clickedId.current);
    }
    clickedId.current = null;
  };

  // --- INSTANCE DRAG HANDLERS ---
  const handleInstanceMouseDown = (e: React.MouseEvent, id: string) => {
    // Prevent Panning
    e.stopPropagation();
    e.preventDefault();

    if (viewMode !== "2D") return;

    // Select the instance
    setSelectedId(id);

    const inst = layout.find(i => i.id === id);
    if (!inst) return;

    isInstanceDragging.current = true;
    draggedInstanceId.current = id;
    instanceDragStartPos.current = { x: e.clientX, y: e.clientY };
    instanceDragStartExpr.current = { x: inst.x, y: inst.y };

    window.addEventListener('mousemove', handleInstanceMouseMove);
    window.addEventListener('mouseup', handleInstanceMouseUp);
  };

  const handleInstanceMouseMove = (e: MouseEvent) => {
    if (!isInstanceDragging.current || !wrapperRef.current || !draggedInstanceId.current) return;

    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;

    const dxPx = e.clientX - instanceDragStartPos.current.x;
    const dyPx = e.clientY - instanceDragStartPos.current.y;

    const dxWorld = dxPx * scaleX;
    // Y-axis flip: Mouse down = negative world Y direction
    const dyWorld = -dyPx * scaleY;

    const startExpr = instanceDragStartExpr.current;
    
    // Update Expressions
    const newX = modifyExpression(startExpr.x, dxWorld);
    const newY = modifyExpression(startExpr.y, dyWorld);

    setLayout(prev => prev.map(inst => {
        if (inst.id === draggedInstanceId.current) {
            return { ...inst, x: newX, y: newY };
        }
        return inst;
    }));
  };

  const handleInstanceMouseUp = (e: MouseEvent) => {
    isInstanceDragging.current = false;
    draggedInstanceId.current = null;
    window.removeEventListener('mousemove', handleInstanceMouseMove);
    window.removeEventListener('mouseup', handleInstanceMouseUp);
  };

  // --- BOARD POINT DRAG HANDLERS ---
  const handlePointMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (viewMode !== "2D") return;

    setSelectedId("BOARD_OUTLINE"); 

    const point = boardOutline.points.find(p => p.id === id);
    if (!point) return;

    isPointDragging.current = true;
    draggedPointId.current = id;
    pointDragStartPos.current = { x: e.clientX, y: e.clientY };
    pointDragStartExpr.current = { x: point.x, y: point.y };

    window.addEventListener('mousemove', handlePointMouseMove);
    window.addEventListener('mouseup', handlePointMouseUp);
  };

  const handlePointMouseMove = (e: MouseEvent) => {
    if (!isPointDragging.current || !wrapperRef.current || !draggedPointId.current) return;

    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;

    const dxPx = e.clientX - pointDragStartPos.current.x;
    const dyPx = e.clientY - pointDragStartPos.current.y;

    const dxWorld = dxPx * scaleX;
    // Y-axis flip
    const dyWorld = -dyPx * scaleY;

    const startExpr = pointDragStartExpr.current;

    const newX = modifyExpression(startExpr.x, dxWorld);
    const newY = modifyExpression(startExpr.y, dyWorld);

    setBoardOutline(prev => ({
        ...prev,
        points: prev.points.map(p => p.id === draggedPointId.current ? { ...p, x: newX, y: newY } : p)
    }));
  };

  const handlePointMouseUp = () => {
    isPointDragging.current = false;
    draggedPointId.current = null;
    window.removeEventListener('mousemove', handlePointMouseMove);
    window.removeEventListener('mouseup', handlePointMouseUp);
  };

  const handleHomeClick = () => {
    if (viewMode === "2D") {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        const newWidth = 200;
        const newHeight = newWidth * (height / width);
        setViewBox({ x: -newWidth / 2, y: -newHeight / 2, width: newWidth, height: newHeight });
    } else {
        layout3DRef.current?.resetCamera();
    }
  };

  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const selectedInstance = layout.find(inst => inst.id === selectedId);

  // Construct SVG polygon points string
  // Y-axis flip for points
  const boardPointsStr = boardOutline.points
    .map(p => `${evaluateExpression(p.x, params)},${-evaluateExpression(p.y, params)}`)
    .join(' ');

  // Handle size relative to view
  const handleSize = Math.max(viewBox.width / 80, 0.5);

  return (
    <div className="layout-editor-container">
      {/* 1. LEFT PANEL: LAYERS & INSTANCES */}
      <div className="layout-sidebar-left">
        
        {/* Top Half: Layers */}
        <LayerVisibilityPanel 
            stackup={stackup}
            visibility={layerVisibility}
            onToggle={toggleLayerVisibility}
            onExport={handleExport}
        />

        {/* Bottom Half: Layout Objects */}
        <div className="layout-left-subpanel">
            <div className="sidebar-header-row">
                <h3>Layout Objects</h3>
            </div>

            <div className="layout-instance-list">
            {/* HARDCODED BOARD OUTLINE ITEM */}
            <div 
                className={`instance-item board-outline-item ${selectedId === 'BOARD_OUTLINE' ? 'selected' : ''}`}
                onClick={() => setSelectedId('BOARD_OUTLINE')}
            >
                <div className="instance-info">
                    <strong>Board Outline</strong>
                    <span className="inst-id-tag">Polygon</span>
                </div>
            </div>

            <div style={{ borderBottom: '1px solid #333', margin: '10px 0' }} />

            <div className="sidebar-header-row" style={{ marginBottom: '10px' }}>
                <span style={{ fontSize: '0.9em', color: '#888' }}>Instances</span>
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
                        <option value="" disabled>+ Place...</option>
                        {footprints.map(fp => (
                            <option key={fp.id} value={fp.id}>{fp.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {layout.map((inst) => {
                const fp = footprints.find(f => f.id === inst.footprintId);
                return (
                    <div 
                        key={inst.id} 
                        className={`instance-item ${inst.id === selectedId ? 'selected' : ''}`}
                        onClick={() => setSelectedId(inst.id)}
                    >
                        <div className="instance-info">
                            <input
                            type="text"
                            value={inst.name}
                            onChange={(e) => updateInstance(inst.id, "name", e.target.value)}
                            className="instance-name-edit"
                            onClick={(e) => e.stopPropagation()}
                            />
                            <span className="inst-id-tag">{fp?.name || 'Unknown Footprint'}</span>
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
      </div>

      {/* 2. CENTER PANEL: 2D/3D VISUALIZER */}
      <div className="layout-center">
        <div className="view-toggle-bar">
          <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>2D Layout</button>
          <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D Preview</button>
        </div>

        <div className="layout-canvas-wrapper" ref={wrapperRef}>
          <button className="canvas-home-btn" onClick={handleHomeClick} title="Reset View">🏠</button>
          
          <div style={{ display: viewMode === "2D" ? 'contents' : 'none' }}>
            <svg className="layout-canvas" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`} onMouseDown={handleMouseDown}>
              <defs>
                <pattern id="layout-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                  <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </pattern>
              </defs>
              <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#layout-grid)" />
              <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              
              {/* Render Board Outline */}
              <polygon 
                points={boardPointsStr}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
                onMouseDown={(e) => {
                     e.stopPropagation();
                     setSelectedId("BOARD_OUTLINE");
                }}
              />
              <polygon 
                points={boardPointsStr}
                fill="none"
                stroke={selectedId === "BOARD_OUTLINE" ? "#646cff" : "#555"}
                strokeWidth={selectedId === "BOARD_OUTLINE" ? 3 : 2}
                strokeDasharray={selectedId === "BOARD_OUTLINE" ? "0" : "5,5"}
                vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: 'none' }}
              />

              {/* Board Points Handles */}
              {selectedId === "BOARD_OUTLINE" && boardOutline.points.map((p) => {
                  const px = evaluateExpression(p.x, params);
                  const py = evaluateExpression(p.y, params);
                  // Y-axis flip: -py
                  return (
                    <rect
                        key={p.id}
                        x={px - handleSize / 2}
                        y={-py - handleSize / 2}
                        width={handleSize}
                        height={handleSize}
                        fill="#fff"
                        stroke="#646cff"
                        strokeWidth={handleSize / 5}
                        style={{ cursor: 'grab' }}
                        vectorEffect="non-scaling-stroke"
                        onMouseDown={(e) => handlePointMouseDown(e, p.id)}
                    />
                  );
              })}

              {layout.map((inst) => {
                  const fp = footprints.find(f => f.id === inst.footprintId);
                  if (!fp) return null;
                  
                  const evalX = evaluateExpression(inst.x, params);
                  const evalY = evaluateExpression(inst.y, params);
                  const evalAngle = evaluateExpression(inst.angle, params);
                  const isSelected = inst.id === selectedId;

                  // Y-axis flip: translate(x, -y). Rotate(-angle).
                  return (
                      <g 
                        key={inst.id} 
                        transform={`translate(${evalX}, ${-evalY}) rotate(${-evalAngle})`}
                        style={{ cursor: 'grab' }}
                        onMouseDown={(e) => handleInstanceMouseDown(e, inst.id)}
                      >
                          {/* Invisible hit area */}
                          <circle r="5" fill="transparent" />
                          
                          <g style={{ 
                            filter: isSelected ? 'drop-shadow(0 0 2px #646cff)' : undefined
                          }}>
                            {/* Reverse shapes so Index 0 (Top) is rendered last */}
                            {[...fp.shapes].reverse().map(shape => {
                                // 2D VISIBILITY CHECK
                                if (!isShapeVisible(shape)) return null;

                                return (
                                    <InstanceShapeRenderer 
                                        key={shape.id} 
                                        shape={shape} 
                                        params={params} 
                                        isSelected={isSelected}
                                        stackup={stackup}
                                    />
                                );
                            })}
                          </g>
                      </g>
                  );
              })}
            </svg>
            <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan</div>
          </div>
          
          <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
            <Layout3DView 
                ref={layout3DRef}
                layout={layout}
                boardOutline={boardOutline}
                footprints={footprints}
                params={params}
                stackup={stackup}
                visibleLayers={layerVisibility} // PASS VISIBILITY
            />
          </div>
        </div>
      </div>

      {/* 3. RIGHT PANEL: PROPERTIES */}
      <div className="layout-sidebar-right">
        {selectedId === "BOARD_OUTLINE" ? (
            <BoardOutlineProperties 
                boardOutline={boardOutline} 
                setBoardOutline={setBoardOutline} 
                params={params} 
            />
        ) : selectedInstance ? (
          <div className="properties-editor">
            <h3>Footprint Properties</h3>
            <div className="prop-group">
                <label>Name</label>
                <input 
                    type="text" 
                    value={selectedInstance.name} 
                    onChange={(e) => updateInstance(selectedInstance.id, "name", e.target.value)}
                />
            </div>

            <div className="prop-group">
                <label>Footprint Type</label>
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
            <p className="empty-hint">Select an object to edit.</p>
          </div>
        )}
      </div>
    </div>
  );
}