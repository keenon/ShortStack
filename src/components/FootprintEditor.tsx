// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintShape, Parameter, StackupLayer, Point, FootprintReference, FootprintRect, FootprintCircle, FootprintLine, FootprintWireGuide } from "../types";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import { BOARD_OUTLINE_ID, modifyExpression, isFootprintOptionValid, getRecursiveLayers, evaluateExpression, resolvePoint } from "../utils/footprintUtils";
import { RecursiveShapeRenderer, BoardOutlineRenderer } from "./FootprintRenderers";
import FootprintPropertiesPanel from "./FootprintPropertiesPanel";
import './FootprintEditor.css';

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // NEW: Need full list for recursion lookups
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  params: Parameter[];
  stackup: StackupLayer[];
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

// 3. LAYER VISIBILITY PANEL
const LayerVisibilityPanel = ({
  stackup,
  visibility,
  onToggle,
  onExport,
  isBoard,
}: {
  stackup: StackupLayer[];
  visibility: Record<string, boolean>;
  onToggle: (id: string) => void;
  onExport: (id: string, type: "SVG" | "DXF" | "STL") => void;
  isBoard: boolean;
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
             <div key={layer.id} className={`layer-vis-item ${visibility[layer.id] === false ? "is-hidden" : ""}`} style={{flexWrap: 'wrap'}}>
                <div className="layer-vis-info" style={{width: '100%', marginBottom: '5px'}}>
                    <div className="layer-color-square" style={{ backgroundColor: layer.color }} />
                    <span className="layer-vis-name" title={layer.name}>{layer.name}</span>
                </div>
                
                <div style={{ display: 'flex', gap: '5px', width: '100%', justifyContent: 'flex-end' }}>
                    <button className={`vis-toggle-btn ${visibility[layer.id] !== false ? "visible" : "hidden"}`} onClick={() => onToggle(layer.id)} style={{ marginRight: 'auto' }}>
                        {visibility[layer.id] !== false ? "Hide" : "Show"}
                    </button>
                    
                    {isBoard && (
                        <>
                            {layer.type === "Cut" ? (
                                <>
                                    <button className="vis-toggle-btn" onClick={() => onExport(layer.id, "SVG")}>SVG</button>
                                    <button className="vis-toggle-btn" onClick={() => onExport(layer.id, "DXF")}>DXF</button>
                                </>
                            ) : (
                                <>
                                    <button className="vis-toggle-btn" onClick={() => onExport(layer.id, "STL")}>STL</button>
                                    <button className="vis-toggle-btn" onClick={() => onExport(layer.id, "SVG")}>SVG</button>
                                </>
                            )}
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

          // Determine which layers are used (recursively for footprints)
          let usedLayers: StackupLayer[] = [];
          if (shape.type === "footprint") {
              usedLayers = getRecursiveLayers((shape as FootprintReference).footprintId, allFootprints, stackup);
          } else {
              usedLayers = stackup.filter(l => shape.assignedLayers && shape.assignedLayers[l.id] !== undefined);
          }
          
          const isGuide = shape.type === "wireGuide";

          return (
          <div key={shape.id}
            className={`shape-item ${shape.id === selectedShapeId ? "selected" : ""} ${!visible ? "is-hidden" : ""} ${hasError ? "error-item" : ""}`}
            onClick={() => onSelect(shape.id)}
            style={hasError ? { border: '1px solid red' } : {}}
          >
            <div className="shape-layer-indicators">
              {usedLayers.map(layer => (
                 <div key={layer.id} className="layer-indicator-dot" style={{ backgroundColor: layer.color }} title={layer.name} />
              ))}
              {isGuide && (
                 <div className="layer-indicator-dot" style={{ backgroundColor: '#0f0', borderRadius: '50%' }} title="Wire Guide" />
              )}
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
    const timer = setTimeout(() => { setDeferredFootprint(footprint); }, 100);
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
               if (p.snapTo) return; // Cannot drag handles of a point snapped to a guide
               if (handleType === 'in' && p.handleIn) {
                   newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorld) } };
               } else if (handleType === 'out' && p.handleOut) {
                   newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorld) } };
               }
          } else if (pointIdx !== undefined) {
               const p = newPoints[pointIdx];
               if (p.snapTo) return; // Cannot drag position of a point snapped to a guide
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
                          if (p.snapTo) return s; // Cannot drag handles of a point snapped to a guide
                          if (handleType === 'in' && p.handleIn) {
                              newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorld) } };
                          } else if (handleType === 'out' && p.handleOut) {
                              newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorld) } };
                          }
                      } else if (pointIdx !== undefined) {
                          const p = newPoints[pointIdx];
                          if (p.snapTo) return s; // Cannot drag position of a point snapped to a guide
                          newPoints[pointIdx] = { ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) };
                      } else {
                          const allMoved = newPoints.map(p => ({ ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) }));
                          return { ...s, points: allMoved };
                      }
                      return { ...s, points: newPoints };
                  } 
                  if ((s.type === "circle" || s.type === "rect" || s.type === "footprint" || s.type === "wireGuide") && (startShape.type === "circle" || startShape.type === "rect" || startShape.type === "footprint" || startShape.type === "wireGuide")) {
                      // Wire Guides have handle properties too (handleIn, handleOut), check if drag target is handle
                      if (s.type === "wireGuide" && handleType) {
                           const wg = s as FootprintWireGuide;
                           const startWg = startShape as FootprintWireGuide;
                           if (handleType === 'in' && startWg.handleIn) {
                               return { ...s, handleIn: { x: modifyExpression(startWg.handleIn.x, dxWorld), y: modifyExpression(startWg.handleIn.y, dyWorld) } };
                           } else if (handleType === 'out' && startWg.handleOut) {
                               return { ...s, handleOut: { x: modifyExpression(startWg.handleOut.x, dxWorld), y: modifyExpression(startWg.handleOut.y, dyWorld) } };
                           }
                      }
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
  const addShape = (type: "circle" | "rect" | "line" | "footprint" | "wireGuide", footprintId?: string) => {
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
    } else if (type === "wireGuide") {
      // Wire Guides go to index 0 to ensure they are at the top of the list and rendered "on top" (last drawn if we didn't reverse, but we reverse, so first drawn???)
      // Wait, in Canvas we do `[...shapes].reverse().map`.
      // The `reverse()` puts the last element of array to the first rendered component.
      // SVG renders first component at bottom.
      // So Last Element of Array -> First Component -> Bottom Layer.
      // First Element of Array -> Last Component -> Top Layer.
      // So to render on top, we need index 0.
      newShape = { ...base, type: "wireGuide", x: "0", y: "0", name: "Wire Guide" } as FootprintWireGuide;
    } else {
      newShape = { ...base, type: "line", thickness: "1", x: "0", y: "0", points: [{ id: crypto.randomUUID(), x: "0", y: "0" }, { id: crypto.randomUUID(), x: "10", y: "10" }] };
    }

    if (type === "wireGuide") {
        onUpdate({ ...footprint, shapes: [newShape, ...footprint.shapes] });
    } else {
        onUpdate({ ...footprint, shapes: [...footprint.shapes, newShape] });
    }
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

  const handleExport = async (layerId: string, format: "SVG" | "DXF" | "STL") => {
    const layer = stackup.find(l => l.id === layerId);
    if (!layer) return;

    // 1. Open Save Dialog
    const path = await save({
        defaultPath: `${footprint.name.replace(/[^a-zA-Z0-9]/g, '_')}_${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}_${format.toLowerCase()}.${format.toLowerCase()}`,
        filters: [{
            name: `${format} File`,
            extensions: [format.toLowerCase()]
        }]
    });

    if (!path) return;

    // 2. Prepare Data
    const layerThickness = evaluateExpression(layer.thicknessExpression, params);

    // Evaluate Board Outline with Handles and Snaps
    const outline = (footprint.boardOutline || []).map(p => {
        const resolved = resolvePoint(p, footprint, allFootprints, params);
        return {
            x: resolved.x,
            y: resolved.y,
            handle_in: resolved.handleIn,
            handle_out: resolved.handleOut
        };
    });

    // Gather Shapes (Recursive)
    const shapes = collectExportShapes(
        footprint, // Pass Current Context
        footprint.shapes, // Pass Shapes
        allFootprints,
        params,
        layer,
        layerThickness
    );

    // 3. Prepare STL Data if needed
    let stlContent: number[] | null = null;
    if (format === "STL") {
        const raw = footprint3DRef.current?.getLayerSTL(layerId);
        if (raw) {
            stlContent = Array.from(raw);
        } else {
             alert("Warning: Could not retrieve 3D mesh for STL export. Ensure the layer is visible in the 3D preview.");
             return;
        }
    }

    // 4. Send to Rust
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

  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);
  const isBoardSelected = selectedShapeId === BOARD_OUTLINE_ID;
  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const isShapeVisible = (shape: FootprintShape) => {
      // Wire guides always visible in editor
      if (shape.type === "wireGuide") return true;
      // Recursive footprints are visible if not explicitly hidden (no layer assignment usually, but could implement)
      if (shape.type === "footprint") return true; 

      const assignedIds = Object.keys(shape.assignedLayers || {});
      if (assignedIds.length === 0) return layerVisibility["unassigned"] !== false;
      return !assignedIds.every(id => layerVisibility[id] === false);
  };

  // NEW: Calculate Scale for Constant Handle Size
  // We want handles to be approx 6px radius on screen.
  // Scale = viewBox.width / assumed_canvas_width (e.g. 150)
  // This is a heuristic. If viewBox width is small (zoomed in), handles are small in units.
  const handleRadius = viewBox.width / 100;

  return (
    <div className="footprint-editor-container">
      <div className="fp-toolbar">
        <button className="secondary" onClick={onClose}>← Back</button>
        <input className="toolbar-name-input" type="text" value={footprint.name} onChange={(e) => updateFootprintName(e.target.value)} />
        <div className="spacer" />
        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
        <button onClick={() => addShape("line")}>+ Line</button>
        <button onClick={() => addShape("wireGuide")}>+ Guide</button>
        
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
            <LayerVisibilityPanel 
                stackup={stackup} 
                visibility={layerVisibility} 
                onToggle={toggleLayerVisibility} 
                onExport={handleExport}
                isBoard={!!footprint.isBoard}
            />
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
                            handleRadius={handleRadius}
                            // Pass context for resolving snaps
                            rootFootprint={footprint}
                            allFootprints={allFootprints}
                        />
                    )}

                    {/* Shapes Rendered Reversed (Bottom to Top visual order) */}
                    {/* Reverse reverses the array in place if not copied. Copy with spread. */}
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
                                handleRadius={handleRadius}
                                rootFootprint={footprint}
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
              <FootprintPropertiesPanel 
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

// ------------------------------------------------------------------
// HELPER: Collect Export Shapes Recursively
// ------------------------------------------------------------------
function collectExportShapes(
    contextFootprint: Footprint, // The footprint defining the shapes
    shapes: FootprintShape[],
    allFootprints: Footprint[],
    params: Parameter[],
    layer: StackupLayer,
    layerThickness: number,
    transform = { x: 0, y: 0, angle: 0 }
): any[] {
    let result: any[] = [];

    // Process shapes. Reverse to match visual order in export list if needed (though CSG doesn't care much for cut)
    const reversedShapes = [...shapes].reverse();

    reversedShapes.forEach(shape => {
        // SKIP WIRE GUIDES (Virtual)
        if (shape.type === "wireGuide") return;

        // 1. Calculate Local Transform
        const lx = evaluateExpression(shape.x, params);
        const ly = evaluateExpression(shape.y, params);
        
        // Global Position
        const rad = (transform.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const gx = transform.x + (lx * cos - ly * sin);
        const gy = transform.y + (lx * sin + ly * cos);

        if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const target = allFootprints.find(f => f.id === ref.footprintId);
             if (target) {
                 const localAngle = evaluateExpression(ref.angle, params);
                 const globalAngle = transform.angle + localAngle;
                 
                 result = result.concat(collectExportShapes(
                     target, // Switch context to the referenced footprint
                     target.shapes,
                     allFootprints,
                     params,
                     layer,
                     layerThickness,
                     { x: gx, y: gy, angle: globalAngle }
                 ));
             }
        } else {
             // Check assignment
             if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return;
             
             // Calculate Depth
             let depth = 0;
             if (layer.type === "Cut") {
                 depth = layerThickness;
             } else {
                 const assign = shape.assignedLayers[layer.id];
                 const val = evaluateExpression(typeof assign === 'object' ? assign.depth : assign, params);
                 depth = Math.max(0, val);
             }
             if (depth <= 0.0001) return;

             // Prepare Export Object
             const exportObj: any = {
                 x: gx,
                 y: gy,
                 depth: depth
             };

             if (layer.type === "Carved/Printed") {
                 const assign = shape.assignedLayers[layer.id];
                 const radExpr = (typeof assign === 'object') ? assign.endmillRadius : "0";
                 const radVal = evaluateExpression(radExpr, params);
                 if (radVal > 0) {
                     exportObj.endmill_radius = radVal;
                 }
             }

             if (shape.type === "circle") {
                 exportObj.shape_type = "circle";
                 exportObj.diameter = evaluateExpression((shape as FootprintCircle).diameter, params);
             } else if (shape.type === "rect") {
                 exportObj.shape_type = "rect";
                 exportObj.width = evaluateExpression((shape as FootprintRect).width, params);
                 exportObj.height = evaluateExpression((shape as FootprintRect).height, params);
                 const localAngle = evaluateExpression((shape as FootprintRect).angle, params);
                 exportObj.angle = transform.angle + localAngle;
                 exportObj.corner_radius = evaluateExpression((shape as FootprintRect).cornerRadius, params);
             } else if (shape.type === "line") {
                 exportObj.shape_type = "line";
                 exportObj.thickness = evaluateExpression((shape as FootprintLine).thickness, params);
                 
                 // Resolve Points
                 const points = (shape as FootprintLine).points.map(p => {
                     // Resolve point in context of the footprint where it is defined
                     const resolved = resolvePoint(p, contextFootprint, allFootprints, params);
                     
                     // resolved is relative to contextFootprint origin (0,0)
                     // We need to transform it by the *accumulated transform* of this recursion
                     // transform = Parent's Global Pos/Rot
                     
                     const px = resolved.x;
                     const py = resolved.y;
                     
                     // Rotate point by parent transform angle
                     const prx = px * cos - py * sin;
                     const pry = px * sin + py * cos;
                     
                     // Handles
                     const transformHandle = (h: {x:number, y:number} | undefined) => {
                         if (!h) return undefined;
                         // Handles are vectors, rotate only
                         return {
                             x: h.x * cos - h.y * sin,
                             y: h.x * sin + h.y * cos
                         };
                     };

                     return {
                         x: transform.x + prx, // transform.x is parent's GX. Wait.
                         // transform.x is the position of the PARENT of this shape?
                         // In recursion: { x: gx, y: gy, angle... } passed as `transform`.
                         // `gx`, `gy` is the origin of the current context footprint in Global Space.
                         // So YES.
                         
                         y: transform.y + pry,
                         handle_in: transformHandle(resolved.handleIn),
                         handle_out: transformHandle(resolved.handleOut)
                     };
                 });
                 exportObj.points = points;
             }

             result.push(exportObj);
        }
    });

    return result;
}