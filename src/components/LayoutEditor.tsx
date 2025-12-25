// src/components/LayoutEditor.tsx
import { useState, useRef, useEffect, Fragment, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintInstance, Parameter, StackupLayer, FootprintShape, BoardOutline, Point, FootprintRect, FootprintCircle } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import Unified3DView, { Unified3DViewHandle, RenderItem } from "./Unified3DView";
import Viewer2D, { Viewer2DItem, evaluateExpression, modifyExpression } from "./Viewer2D";
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

// ... (Sub-components LayerVisibilityPanel, BoardOutlineProperties remain unchanged) ...
// ------------------------------------------------------------------
// SUB-COMPONENTS (Keep original implementations)
// ------------------------------------------------------------------

// 1. LAYER VISIBILITY PANEL (Unchanged)
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

// 2. BOARD OUTLINE PROPERTIES (Unchanged)
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
  const [selectedId, setSelectedId] = useState<string | null>("BOARD_OUTLINE");
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  const [viewBox, setViewBox] = useState({ x: -100, y: -100, width: 200, height: 200 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  const wrapperRef = useRef<HTMLDivElement>(null);
  
  const layout3DRef = useRef<Unified3DViewHandle>(null);

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

  // --- ACTIONS (Unchanged) ---
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

    const path = await save({
        defaultPath: `${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}_${format.toLowerCase()}.${format.toLowerCase()}`,
        filters: [{
            name: `${format} File`,
            extensions: [format.toLowerCase()]
        }]
    });

    if (!path) return;

    const layerThickness = evaluateExpression(layer.thicknessExpression, params);

    const outline = boardOutline.points.map(p => ({
        x: evaluateExpression(p.x, params),
        y: evaluateExpression(p.y, params)
    }));

    const shapes: any[] = [];

    layout.forEach(inst => {
        const fp = footprints.find(f => f.id === inst.footprintId);
        if (!fp) return;

        const instX = evaluateExpression(inst.x, params);
        const instY = evaluateExpression(inst.y, params);
        const instAngle = evaluateExpression(inst.angle, params);
        const instAngleRad = (instAngle * Math.PI) / 180;
        const cosA = Math.cos(instAngleRad);
        const sinA = Math.sin(instAngleRad);

        [...fp.shapes].reverse().forEach(s => {
            if (!s.assignedLayers || s.assignedLayers[layer.id] === undefined) return;

            let depth = 0;
            if (layer.type === "Cut") {
                depth = layerThickness; 
            } else {
                const val = evaluateExpression(s.assignedLayers[layer.id], params);
                depth = Math.max(0, val);
            }
            if (depth <= 0) return;

            const sx = evaluateExpression(s.x, params);
            const sy = evaluateExpression(s.y, params);
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
                    angle: instAngle + sAngle, 
                    depth: depth
                });
            }
        });
    });

    let stlContent: number[] | null = null;
    if (format === "STL") {
        const raw = layout3DRef.current?.getLayerSTL(layerId);
        if (raw) {
            stlContent = Array.from(raw);
        } else {
             alert("Warning: Could not retrieve 3D mesh for STL export. Ensure the layer is visible in the 3D preview.");
             return;
        }
    }

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

  // --- UNIFIED HANDLERS for Viewer2D (Unchanged) ---
  const handleItemMouseDown = (e: React.MouseEvent, item: Viewer2DItem, subId?: string | number) => {
      e.stopPropagation();
      e.preventDefault();

      setSelectedId(item.id);

      if (item.type === "instance") {
          const inst = layout.find(i => i.id === item.id);
          if (!inst) return;
          
          isInstanceDragging.current = true;
          draggedInstanceId.current = item.id;
          instanceDragStartPos.current = { x: e.clientX, y: e.clientY };
          instanceDragStartExpr.current = { x: inst.x, y: inst.y };

          window.addEventListener('mousemove', handleInstanceMouseMove);
          window.addEventListener('mouseup', handleInstanceMouseUp);
      }

      if (item.type === "board") {
          if (subId && typeof subId === "string") {
            const point = boardOutline.points.find(p => p.id === subId);
            if (!point) return;

            isPointDragging.current = true;
            draggedPointId.current = subId;
            pointDragStartPos.current = { x: e.clientX, y: e.clientY };
            pointDragStartExpr.current = { x: point.x, y: point.y };

            window.addEventListener('mousemove', handlePointMouseMove);
            window.addEventListener('mouseup', handlePointMouseUp);
          }
      }
  };

  const handleInstanceMouseMove = (e: MouseEvent) => {
    if (!isInstanceDragging.current || !wrapperRef.current || !draggedInstanceId.current) return;

    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBox.width / rect.width;
    const scaleY = viewBox.height / rect.height;

    const dxPx = e.clientX - instanceDragStartPos.current.x;
    const dyPx = e.clientY - instanceDragStartPos.current.y;

    const dxWorld = dxPx * scaleX;
    // Y-axis flip
    const dyWorld = -dyPx * scaleY;

    const startExpr = instanceDragStartExpr.current;
    
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

  const handlePointMouseMove = (e: MouseEvent) => {
    if (!isPointDragging.current || !wrapperRef.current || !draggedPointId.current) return;

    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBox.width / rect.width;
    const scaleY = viewBox.height / rect.height;

    const dxPx = e.clientX - pointDragStartPos.current.x;
    const dyPx = e.clientY - pointDragStartPos.current.y;

    const dxWorld = dxPx * scaleX;
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

  const selectedInstance = layout.find(inst => inst.id === selectedId);

  // PREPARE VIEWER ITEMS
  const viewerItems: Viewer2DItem[] = [];

  viewerItems.push({
      type: "board",
      id: "BOARD_OUTLINE",
      data: boardOutline,
      selected: selectedId === "BOARD_OUTLINE",
      visible: true
  });

  layout.forEach(inst => {
      const fp = footprints.find(f => f.id === inst.footprintId);
      if (fp) {
          viewerItems.push({
              type: "instance",
              id: inst.id,
              data: inst,
              footprint: fp,
              selected: inst.id === selectedId,
              visible: true
          });
      }
  });

  // PREPARE 3D ITEMS
  const renderItems: RenderItem[] = useMemo(() => 
    layout.map(inst => ({
        type: 'instance' as const,
        data: inst
    }))
  , [layout]);

  return (
    <div className="layout-editor-container">
      <div className="layout-sidebar-left">
        <LayerVisibilityPanel 
            stackup={stackup}
            visibility={layerVisibility}
            onToggle={toggleLayerVisibility}
            onExport={handleExport}
        />
        {/* ... (Instance list panel remains same) ... */}
        <div className="layout-left-subpanel">
            <div className="sidebar-header-row">
                <h3>Layout Objects</h3>
            </div>

            <div className="layout-instance-list">
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

      <div className="layout-center">
        <div className="view-toggle-bar">
          <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>2D Layout</button>
          <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D Preview</button>
        </div>

        <div className="layout-canvas-wrapper" ref={wrapperRef}>
          <button className="canvas-home-btn" onClick={handleHomeClick} title="Reset View">🏠</button>
          
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
            <div className="canvas-hint">Scroll to Zoom | Drag to Pan</div>
          </div>
          
          <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
            <Unified3DView 
                ref={layout3DRef}
                items={renderItems}
                footprints={footprints}
                boardOutline={boardOutline}
                params={params}
                stackup={stackup}
                visibleLayers={layerVisibility} 
                is3DActive={viewMode === "3D"}
            />
          </div>
        </div>
      </div>

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