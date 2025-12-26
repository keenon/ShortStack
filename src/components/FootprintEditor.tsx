// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Footprint, FootprintShape, Parameter, StackupLayer, Point, FootprintReference } from "../types";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import { BOARD_OUTLINE_ID, modifyExpression, isFootprintOptionValid, getRecursiveLayers } from "../utils/footprintUtils";
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

          // Determine which layers are used (recursively for footprints)
          let usedLayers: StackupLayer[] = [];
          if (shape.type === "footprint") {
              usedLayers = getRecursiveLayers((shape as FootprintReference).footprintId, allFootprints, stackup);
          } else {
              usedLayers = stackup.filter(l => shape.assignedLayers && shape.assignedLayers[l.id] !== undefined);
          }

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
              {/* Show gray dot only if recursive footprint is valid but has no layers? Or just showing nothing is fine. */}
              {shape.type === "footprint" && usedLayers.length === 0 && !hasError && (
                 <div className="layer-indicator-dot" style={{ backgroundColor: "#555", borderRadius: '50%' }} title="Empty Footprint" />
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
                            handleRadius={handleRadius}
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
                                handleRadius={handleRadius}
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