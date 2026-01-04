// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintRect, FootprintCircle, FootprintLine, FootprintWireGuide, FootprintMesh, FootprintBoardOutline, Point, MeshAsset, FootprintPolygon } from "../types";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import { modifyExpression, isFootprintOptionValid, getRecursiveLayers, evaluateExpression, resolvePoint, bezier1D, getPolyOutlinePoints, offsetPolygonContour, getShapeAABB, doRectsIntersect, isShapeInSelection } from "../utils/footprintUtils";
import { RecursiveShapeRenderer } from "./FootprintRenderers";
import FootprintPropertiesPanel from "./FootprintPropertiesPanel";
import { IconCircle, IconRect, IconLine, IconGuide, IconOutline, IconFootprint, IconMesh, IconPolygon } from "./Icons";
import { useUndoHistory } from "../hooks/useUndoHistory"; 
import './FootprintEditor.css';

// --- GLOBAL CLIPBOARD (Persists across footprint switches) ---
let GLOBAL_CLIPBOARD: { type: "shape" | "mesh", data: any } | null = null;

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // NEW: Need full list for recursion lookups
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  onEditChild: (id: string) => void; // NEW: Callback to drill down
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
  onRegisterMesh: (asset: MeshAsset) => void;
}

// ------------------------------------------------------------------
// HELPERS FOR BASE64
// ------------------------------------------------------------------
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
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
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="fp-left-subpanel" style={{ flex: collapsed ? '0 0 auto' : 1, minHeight: 'auto', transition: 'flex 0.2s' }}>
      <div 
        onClick={() => setCollapsed(!collapsed)} 
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: collapsed ? 0 : '10px' }}
      >
          <h3 style={{ margin: 0, userSelect: 'none' }}>Layers</h3>
          <span style={{ fontSize: '0.8em', color: '#888' }}>{collapsed ? "▶" : "▼"}</span>
      </div>
      
      {!collapsed && (
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
      )}
    </div>
  );
};

// 4. SHAPE LIST PANEL
const ShapeListPanel = ({
  footprint,
  allFootprints,
  selectedShapeIds, // UPDATED: Multi-select
  onSelect,
  onDelete,
  onRename,
  onMove,
  stackup,
  isShapeVisible,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedShapeIds: string[]; // UPDATED: Multi-select
  onSelect: (id: string, multi: boolean) => void; // UPDATED
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  stackup: StackupLayer[];
  isShapeVisible: (shape: FootprintShape) => boolean;
}) => {
  const [collapsed, setCollapsed] = useState(false);

  const getIcon = (type: string) => {
      switch(type) {
          case "circle": return <IconCircle className="shape-icon" />;
          case "rect": return <IconRect className="shape-icon" />;
          case "line": return <IconLine className="shape-icon" />;
          case "polygon": return <IconPolygon className="shape-icon" />;
          case "wireGuide": return <IconGuide className="shape-icon" />;
          case "boardOutline": return <IconOutline className="shape-icon" />;
          case "footprint": return <IconFootprint className="shape-icon" />;
          default: return null;
      }
  };

  return (
    <div className="fp-left-subpanel" style={{ flex: collapsed ? '0 0 auto' : 1, minHeight: 'auto', transition: 'flex 0.2s' }}>
      <div 
        onClick={() => setCollapsed(!collapsed)} 
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: collapsed ? 0 : '10px' }}
      >
          <h3 style={{ margin: 0, userSelect: 'none' }}>Objects</h3>
          <span style={{ fontSize: '0.8em', color: '#888' }}>{collapsed ? "▶" : "▼"}</span>
      </div>
      
      {!collapsed && (
        <div className="shape-list-container">
            {footprint.shapes.map((shape, index) => {
            // If not a board, hide outline shapes in the list
            if (!footprint.isBoard && shape.type === "boardOutline") return null;

            const visible = isShapeVisible(shape);
            
            let hasError = false;
            if (shape.type === "footprint") {
                const refId = (shape as FootprintReference).footprintId;
                const target = allFootprints.find(f => f.id === refId);
                if (!target) hasError = true;
                // CHANGE: Only validate direct loop, allow isBoard
                else if (!isFootprintOptionValid(footprint.id, target, allFootprints)) {
                    hasError = true;
                }
            }

            // Determine which layers are used (recursively for footprints)
            let usedLayers: StackupLayer[] = [];
            if (shape.type === "footprint") {
                usedLayers = getRecursiveLayers((shape as FootprintReference).footprintId, allFootprints, stackup);
            } else if (shape.type === "boardOutline") {
                // Show layers explicitly assigned to this outline
                const assignments = footprint.boardOutlineAssignments || {};
                usedLayers = stackup.filter(l => assignments[l.id] === shape.id);
            } else {
                usedLayers = stackup.filter(l => shape.assignedLayers && shape.assignedLayers[l.id] !== undefined);
            }
            
            const isGuide = shape.type === "wireGuide";

            return (
            <div key={shape.id}
                className={`shape-item ${selectedShapeIds.includes(shape.id) ? "selected" : ""} ${!visible ? "is-hidden" : ""} ${hasError ? "error-item" : ""}`}
                onClick={(e) => onSelect(shape.id, e.metaKey || e.ctrlKey)}
                style={hasError ? { border: '1px solid red' } : {}}
            >
                {getIcon(shape.type)}
                
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
            {footprint.shapes.length === 0 && <div className="empty-state-small">No shapes added.</div>}
        </div>
      )}
    </div>
  );
};

// 5. MESH LIST PANEL
const MeshListPanel = ({
    meshes,
    meshAssets,
    selectedShapeIds, // UPDATED: Multi-select
    onSelect,
    onDelete,
    onRename,
    updateMesh
}: {
    meshes: FootprintMesh[];
    meshAssets: MeshAsset[];
    selectedShapeIds: string[]; // UPDATED: Multi-select
    onSelect: (id: string, multi: boolean) => void; // UPDATED
    onDelete: (id: string) => void;
    onRename: (id: string, name: string) => void;
    updateMesh: (id: string, field: string, val: any) => void;
}) => {
    const [collapsed, setCollapsed] = useState(false);
    (onRename); // Unused for now

    return (
        <div className="fp-left-subpanel" style={{ flex: collapsed ? '0 0 auto' : 1, minHeight: 'auto', transition: 'flex 0.2s' }}>
            <div 
                onClick={() => setCollapsed(!collapsed)} 
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: collapsed ? 0 : '10px' }}
            >
                <h3 style={{ margin: 0, userSelect: 'none' }}>Meshes</h3>
                <span style={{ fontSize: '0.8em', color: '#888' }}>{collapsed ? "▶" : "▼"}</span>
            </div>

            {!collapsed && (
                <div className="shape-list-container">
                    {meshes.map(mesh => {
                        const asset = meshAssets.find(a => a.id === mesh.meshId);
                        return (
                            <div key={mesh.id}
                                className={`shape-item ${selectedShapeIds.includes(mesh.id) ? "selected" : ""}`}
                                style={{ flexDirection: 'column', alignItems: 'flex-start' }}
                                onClick={(e) => onSelect(mesh.id, e.metaKey || e.ctrlKey)}
                            >
                                <div style={{ display: 'flex', width: '100%', alignItems: 'center' }}>
                                    <IconMesh className="shape-icon" />
                                    <div style={{ marginRight: '8px', fontSize: '0.8em', color: '#888', textTransform: 'uppercase' }}>
                                        {asset?.format || "???"}
                                    </div>
                                    <input 
                                        type="text" 
                                        value={mesh.name} 
                                        onChange={(e) => updateMesh(mesh.id, "name", e.target.value)} 
                                        className="shape-name-edit" 
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                    <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(mesh.id); }} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Delete">✕</button>
                                </div>
                                
                                <div style={{ display: 'flex', width: '100%', marginTop: '5px' }}>
                                    <button
                                        className={`vis-toggle-btn ${mesh.renderingType !== "hidden" ? "visible" : ""}`}
                                        style={{ fontSize: '0.8em', padding: '2px 8px', width: '100%' }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const newType = mesh.renderingType === "hidden" ? "solid" : "hidden";
                                            updateMesh(mesh.id, "renderingType", newType);
                                        }}
                                    >
                                        {mesh.renderingType === "hidden" ? "Show" : "Hide"}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                    {meshes.length === 0 && <div className="empty-state-small">Drag & Drop STL/OBJ/STEP files onto 3D view.</div>}
                </div>
            )}
        </div>
    );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function FootprintEditor({ footprint: initialFootprint, allFootprints, onUpdate, onClose, onEditChild, params, stackup, meshAssets, onRegisterMesh }: Props) {
  // --- HISTORY HOOK ---
  // We rename the hook's state to 'footprint' so the rest of the component uses it naturally.
  // The 'set' function from the hook handles the undo stack logic.
  const { 
    state: footprint, 
    set: updateHistory, 
    undo, 
    redo, 
    canUndo, 
    canRedo,
    resetHistory
  } = useUndoHistory(initialFootprint, 500);

  // FIX: Use a ref to access the latest onUpdate callback without triggering the effect loop
  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Sync back to parent for auto-save
  useEffect(() => {
      onUpdateRef.current(footprint);
  }, [footprint]);

  // Reset history if jumping to a different footprint
  const activeIdRef = useRef(initialFootprint.id);
  if (activeIdRef.current !== initialFootprint.id) {
      activeIdRef.current = initialFootprint.id;
      resetHistory(initialFootprint);
  }

  const [selectedShapeIds, setSelectedShapeIds] = useState<string[]>([]); 
  const [processingMessage, setProcessingMessage] = useState<string | null>(null);
  
  // NEW: Selection Box State
  const [selectionBox, setSelectionBox] = useState<{ start: {x: number, y: number}, current: {x: number, y: number} } | null>(null);
  const isSelectionDragging = useRef(false);
  const selectionStartRef = useRef<{x: number, y: number} | null>(null);
  const selectionCurrentRef = useRef<{x: number, y: number} | null>(null);

  // NEW: State for point interaction
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [scrollToPointIndex, setScrollToPointIndex] = useState<number | null>(null);
  // NEW: State for midpoint interaction
  const [hoveredMidpointIndex, setHoveredMidpointIndex] = useState<number | null>(null);

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

  const isDragging = useRef(false); // Used for PANNING
  const hasMoved = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });
  const clickedShapeId = useRef<string | null>(null);

  const isShapeDragging = useRef(false);
  const shapeDragStartPos = useRef({ x: 0, y: 0 });
  // UPDATED: Store start state for ALL selected shapes
  const shapeDragStartDataMap = useRef<Map<string, any>>(new Map());
  const dragTargetRef = useRef<{ id: string; pointIdx?: number; handleType?: 'in' | 'out' | 'symmetric'; } | null>(null);

  // HEALING EFFECT: Convert non-GLB meshes to GLB
  useEffect(() => {
    if (!footprint.meshes || footprint.meshes.length === 0) return;
    
    const nonGlbInstances = footprint.meshes.filter(m => {
        const asset = meshAssets.find(a => a.id === m.meshId);
        return asset && asset.format !== "glb";
    });
    if (nonGlbInstances.length === 0) return;

    // Only attempt to heal if we have a ref to the 3D view (which contains the engine)
    if (!footprint3DRef.current) return;

    const healMeshes = async () => {
        setProcessingMessage("Optimizing 3D Meshes...");
        // Yield to render to show message
        await new Promise(r => setTimeout(r, 100));

        for (const inst of nonGlbInstances) {
            const asset = meshAssets.find(a => a.id === inst.meshId);
            if (!asset) continue;

            try {
                // Mock a mesh object for the converter to work with legacy signature
                const mockMesh: FootprintMesh = { ...inst, content: asset.content, format: asset.format } as any;
                const converted = await footprint3DRef.current?.convertMeshToGlb(mockMesh);
                if (converted) {
                    onRegisterMesh({
                        id: asset.id, // Reuse ID, update content
                        name: asset.name,
                        content: (converted as any).content,
                        format: "glb"
                    });
                }
            } catch (e) {
                console.error("Failed to heal mesh", asset.name, e);
            }
        }

        setProcessingMessage(null);
    };

    healMeshes();
  }, [footprint.meshes, meshAssets, footprint3DRef.current]);

  useEffect(() => { viewBoxRef.current = viewBox; }, [viewBox]);

  useLayoutEffect(() => {
    if (!wrapperRef.current || viewMode !== "2D") return;
    const updateDimensions = () => {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        setViewBox(prev => {
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

  // HELPER: Screen to World Coordinates
  const getMouseWorldPos = (clientX: number, clientY: number) => {
      if (!wrapperRef.current) return { x: 0, y: 0 };
      const rect = wrapperRef.current.getBoundingClientRect();
      const scaleX = viewBoxRef.current.width / rect.width;
      const scaleY = viewBoxRef.current.height / rect.height;
      const x = viewBoxRef.current.x + (clientX - rect.left) * scaleX;
      const y = viewBoxRef.current.y + (clientY - rect.top) * scaleY;
      return { x, y };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (viewMode !== "2D") return;
    
    // CHANGED: Right Click (2) or Middle Click (1) for PAN
    if (e.button === 1 || e.button === 2) {
        e.preventDefault();
        isDragging.current = true;
        hasMoved.current = false;
        dragStart.current = { x: e.clientX, y: e.clientY };
        dragStartViewBox.current = { x: viewBox.x, y: viewBox.y };
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return;
    }

    // NEW: Left Click (0) for SELECTION BOX
    if (e.button === 0) {
        // If Shift/Ctrl is NOT held, clear selection when clicking background
        const isMulti = e.shiftKey || e.metaKey || e.ctrlKey;
        if (!isMulti) {
            setSelectedShapeIds([]);
        }

        isSelectionDragging.current = true;
        const startPos = getMouseWorldPos(e.clientX, e.clientY);
        
        // Use refs for robust event handling, bypassing state closures
        selectionStartRef.current = startPos;
        selectionCurrentRef.current = startPos;
        setSelectionBox({ start: startPos, current: startPos });

        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
    }
  };

  const handleGlobalMouseMove = (e: MouseEvent) => {
    // 1. PANNING LOGIC
    if (isDragging.current && wrapperRef.current) {
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved.current = true;
        const rect = wrapperRef.current.getBoundingClientRect();
        const scaleX = viewBoxRef.current.width / rect.width;
        const scaleY = viewBoxRef.current.height / rect.height;
        const newX = dragStartViewBox.current.x - dx * scaleX;
        const newY = dragStartViewBox.current.y - dy * scaleY;
        setViewBox(prev => ({ ...prev, x: newX, y: newY }));
        return;
    }

    // 2. SELECTION BOX LOGIC
    if (isSelectionDragging.current && wrapperRef.current) {
        const currentPos = getMouseWorldPos(e.clientX, e.clientY);
        selectionCurrentRef.current = currentPos;
        
        // Update visual state (batched by React)
        if (selectionStartRef.current) {
            setSelectionBox({ start: selectionStartRef.current, current: currentPos });
        }
    }
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    // 1. STOP PANNING
    if (isDragging.current) {
        isDragging.current = false;
    }

    // 2. FINISH SELECTION BOX
    if (isSelectionDragging.current) {
        isSelectionDragging.current = false;
        
        if (selectionStartRef.current && selectionCurrentRef.current) {
            const start = selectionStartRef.current;
            const current = selectionCurrentRef.current;
            
            const rect = { 
                x1: start.x, 
                y1: start.y, 
                x2: current.x, 
                y2: current.y 
            };
            
            const newSelectedIds: string[] = [];
            
            // Check Intersection with Shapes using precise logic
            footprintRef.current.shapes.forEach(shape => {
                if (shape.type === "boardOutline" && !footprintRef.current.isBoard) return;
                
                // Use the new precise check which handles "hollow" outlines properly
                if (isShapeInSelection(rect, shape, params, footprintRef.current, allFootprints)) {
                    newSelectedIds.push(shape.id);
                }
            });

            // Check Intersection with Meshes
            (footprintRef.current.meshes || []).forEach(mesh => {
                const px = evaluateExpression(mesh.x, params);
                const py = -evaluateExpression(mesh.y, params); // Invert Y for Visual
                // Simple point check for mesh origin
                if (px >= Math.min(rect.x1, rect.x2) && px <= Math.max(rect.x1, rect.x2) &&
                    py >= Math.min(rect.y1, rect.y2) && py <= Math.max(rect.y1, rect.y2)) {
                    newSelectedIds.push(mesh.id);
                }
            });

            const isMulti = e.shiftKey || e.metaKey || e.ctrlKey;
            if (isMulti) {
                setSelectedShapeIds(prev => Array.from(new Set([...prev, ...newSelectedIds])));
            } else {
                setSelectedShapeIds(newSelectedIds);
            }
        }

        // Cleanup
        setSelectionBox(null);
        selectionStartRef.current = null;
        selectionCurrentRef.current = null;
    }

    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);
    clickedShapeId.current = null;
  };

  const handleShapeMouseDown = (e: React.MouseEvent, id: string, pointIndex?: number) => {
      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;

      const multi = e.metaKey || e.ctrlKey;
      
      // Selection logic
      if (multi) {
          setSelectedShapeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
      } else if (pointIndex !== undefined) {
          // If we click a point, we focus that single shape
          setSelectedShapeIds([id]);
      } else if (!selectedShapeIds.includes(id)) {
          // Normal click on a new item resets selection
          setSelectedShapeIds([id]);
      }
      
      // NEW: Trigger scroll to point properties if a specific point was clicked
      if (pointIndex !== undefined) {
          setScrollToPointIndex(pointIndex);
      }

      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;

      isShapeDragging.current = true;
      hasMoved.current = false;

      // UPDATED: Check for Ctrl/Meta key to trigger symmetric handle creation
      if (pointIndex !== undefined && (e.ctrlKey || e.metaKey)) {
          dragTargetRef.current = { id, pointIdx: pointIndex, handleType: 'symmetric' };
      } else {
          dragTargetRef.current = { id, pointIdx: pointIndex };
      }

      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      
      // SNAPSHOT ALL SELECTED SHAPES
      shapeDragStartDataMap.current.clear();
      footprint.shapes.forEach(s => {
          if (s.id === id || selectedShapeIds.includes(s.id)) {
              shapeDragStartDataMap.current.set(s.id, JSON.parse(JSON.stringify(s)));
          }
      });
      
      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleHandleMouseDown = (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => {
      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;
      
      setSelectedShapeIds([id]);
      
      // NEW: Trigger scroll
      setScrollToPointIndex(pointIndex);

      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;
      isShapeDragging.current = true;
      hasMoved.current = false;
      dragTargetRef.current = { id, pointIdx: pointIndex, handleType: type };
      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      shapeDragStartDataMap.current.clear();
      shapeDragStartDataMap.current.set(id, JSON.parse(JSON.stringify(shape)));
      
      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleShapeMouseMove = (e: MouseEvent) => {
      if (!isShapeDragging.current || !wrapperRef.current || !dragTargetRef.current) return;
      const rect = wrapperRef.current.getBoundingClientRect();
      const scaleX = viewBoxRef.current.width / rect.width;
      const scaleY = viewBoxRef.current.height / rect.height;
      const dxPx = e.clientX - shapeDragStartPos.current.x;
      const dyPx = e.clientY - shapeDragStartPos.current.y;
      
      if (Math.abs(dxPx) > 2 || Math.abs(dyPx) > 2) hasMoved.current = true;

      const dxWorld = dxPx * scaleX;
      const dyWorld = -dyPx * scaleY;
      const currentFP = footprintRef.current;
      const { id: targetId, pointIdx, handleType } = dragTargetRef.current;
      
      const updatedShapes = currentFP.shapes.map(s => {
          const startShape = shapeDragStartDataMap.current.get(s.id);
          if (!startShape) return s;

          // Only move if part of selection, OR it is the specific target shape
          if (s.id === targetId || selectedShapeIds.includes(s.id)) {
              
              // Case A: Dragging a specific Point or Handle (Only affect the targetId shape)
              if (pointIdx !== undefined && s.id === targetId) {
                  if ((s.type === "line" || s.type === "boardOutline" || s.type === "polygon") && (startShape.type === "line" || startShape.type === "boardOutline" || startShape.type === "polygon")) {
                      const newPoints = [...(startShape as any).points];

                      if (handleType === 'symmetric') {
                          newPoints[pointIdx] = {
                              ...newPoints[pointIdx],
                              handleOut: { x: parseFloat(dxWorld.toFixed(4)).toString(), y: parseFloat(dyWorld.toFixed(4)).toString() },
                              handleIn: { x: parseFloat((-dxWorld).toFixed(4)).toString(), y: parseFloat((-dyWorld).toFixed(4)).toString() }
                          };
                      } else if (handleType) {
                          const p = newPoints[pointIdx];
                          if (p.snapTo) return s; 
                          if (handleType === 'in' && p.handleIn) {
                              newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorld) } };
                          } else if (handleType === 'out' && p.handleOut) {
                              newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorld) } };
                          }
                      } else {
                          const p = newPoints[pointIdx];
                          if (p.snapTo) return s; 
                          newPoints[pointIdx] = { ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) };
                      }
                      return { ...s, points: newPoints };
                  }
                  if (s.type === "wireGuide" && handleType && startShape.type === "wireGuide") {
                       if (startShape.handle) {
                           return { ...s, handle: { x: modifyExpression(startShape.handle.x, dxWorld), y: modifyExpression(startShape.handle.y, dyWorld) } };
                       }
                  }
                  // Non-point shapes don't have point indices, so fall through to body drag
              }

              // Case B: Group Body Drag (Affect all selected shapes)
              // Only trigger if no pointIdx or if pointIdx is not on this specific shape
              if (pointIdx === undefined || s.id !== targetId) {
                  if (s.type === "line" || s.type === "boardOutline" || s.type === "polygon") {
                      const newPoints = (startShape as any).points.map((p: any) => ({ ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorld) }));
                      return { ...s, points: newPoints };
                  } 
                  return { ...s, x: modifyExpression(startShape.x, dxWorld), y: modifyExpression(startShape.y, dyWorld) };
              }
          }
          return s;
      });
      updateHistory({ ...currentFP, shapes: updatedShapes });
  };

  const handleShapeMouseUp = (e: MouseEvent) => {
      isShapeDragging.current = false;
      
      // If we didn't move much and didn't use meta/ctrl, reset selection to single item
      if (!hasMoved.current && !e.metaKey && !e.ctrlKey && dragTargetRef.current?.pointIdx === undefined) {
          if (dragTargetRef.current) setSelectedShapeIds([dragTargetRef.current.id]);
      }

      dragTargetRef.current = null;
      shapeDragStartDataMap.current.clear();
      window.removeEventListener('mousemove', handleShapeMouseMove);
      window.removeEventListener('mouseup', handleShapeMouseUp);
  };

  // ------------------------------------------------------------------
  // COPY / PASTE / DUPLICATE LOGIC
  // ------------------------------------------------------------------

  const handleCopy = useCallback(() => {
    if (selectedShapeIds.length === 0) return;
    const primaryId = selectedShapeIds[0];

    // Check Shapes
    const shape = footprint.shapes.find(s => s.id === primaryId);
    if (shape) {
        GLOBAL_CLIPBOARD = { type: "shape", data: JSON.parse(JSON.stringify(shape)) };
        return;
    }

    // Check Meshes
    if (footprint.meshes) {
        const mesh = footprint.meshes.find(m => m.id === primaryId);
        if (mesh) {
            GLOBAL_CLIPBOARD = { type: "mesh", data: JSON.parse(JSON.stringify(mesh)) };
            return;
        }
    }
  }, [selectedShapeIds, footprint]);

  const handlePaste = useCallback(() => {
    if (!GLOBAL_CLIPBOARD) return;
    const { type, data } = GLOBAL_CLIPBOARD;

    // 1. Clone Data
    const newItem = JSON.parse(JSON.stringify(data));
    
    // 2. Assign New ID
    newItem.id = crypto.randomUUID();

    // 3. Regenerate Sub-IDs (e.g. Points in Lines/Outlines)
    if (newItem.points && Array.isArray(newItem.points)) {
        newItem.points = newItem.points.map((p: any) => ({
            ...p,
            id: crypto.randomUUID()
        }));
    }

    // 4. Generate Unique Name
    let baseName = newItem.name;
    // Strip trailing increment if exists: "Shape (1)" -> "Shape"
    const match = baseName.match(/^(.*) \(\d+\)$/);
    if (match) baseName = match[1];

    let newName = baseName;
    let counter = 1;
    const existingNames = new Set([
        ...footprint.shapes.map(s => s.name),
        ...(footprint.meshes || []).map(m => m.name)
    ]);

    while (existingNames.has(newName)) {
        newName = `${baseName} (${counter})`;
        counter++;
    }
    newItem.name = newName;

    // 5. Add to Footprint (IMPROVEMENT: Prepend to appear on top of list and visuals)
    if (type === "shape") {
        updateHistory({ ...footprint, shapes: [newItem, ...footprint.shapes] });
    } else if (type === "mesh") {
        updateHistory({ ...footprint, meshes: [newItem, ...(footprint.meshes || [])] });
    }

    // 6. Select the copy
    setSelectedShapeIds([newItem.id]);
  }, [footprint, updateHistory]);

  const handleDuplicate = useCallback(() => {
    if (selectedShapeIds.length > 0) {
        handleCopy();
        handlePaste();
    }
  }, [selectedShapeIds, handleCopy, handlePaste]);
  
  const deleteShape = useCallback((shapeId: string) => {
    const shapeToDelete = footprintRef.current.shapes.find(s => s.id === shapeId);
    let newAssignments = { ...footprintRef.current.boardOutlineAssignments };
    const newShapes = footprintRef.current.shapes.filter(s => s.id !== shapeId);

    // REASSIGNMENT LOGIC for Board Outlines
    if (shapeToDelete?.type === "boardOutline") {
        const remainingOutlines = newShapes.filter(s => s.type === "boardOutline");
        Object.entries(newAssignments).forEach(([layerId, assignedId]) => {
            if (assignedId === shapeId) {
                newAssignments[layerId] = remainingOutlines.length > 0 ? remainingOutlines[0].id : "";
            }
        });
    }

    updateHistory({ ...footprintRef.current, shapes: newShapes, boardOutlineAssignments: newAssignments });
    setSelectedShapeIds(prev => prev.filter(x => x !== shapeId));
  }, [updateHistory]);

  const convertShape = useCallback((oldShapeId: string, newShape: FootprintShape) => {
      const currentShapes = footprintRef.current.shapes;
      const index = currentShapes.findIndex(s => s.id === oldShapeId);
      if (index === -1) return;

      const newShapes = [...currentShapes];
      newShapes[index] = newShape;

      // Update board outline assignments if necessary
      let newAssignments = { ...footprintRef.current.boardOutlineAssignments };
      if (footprintRef.current.isBoard) {
          Object.keys(newAssignments).forEach(layerId => {
              if (newAssignments[layerId] === oldShapeId) {
                  newAssignments[layerId] = newShape.id;
              }
          });
      }

      updateHistory({ 
          ...footprintRef.current, 
          shapes: newShapes, 
          boardOutlineAssignments: newAssignments 
      });
      setSelectedShapeIds([newShape.id]);
  }, [updateHistory]);

  const deleteMesh = useCallback((meshId: string) => {
      updateHistory({ ...footprintRef.current, meshes: (footprintRef.current.meshes || []).filter(m => m.id !== meshId) });
      setSelectedShapeIds(prev => prev.filter(x => x !== meshId));
  }, [updateHistory]);

  // Keyboard Shortcuts Listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        // Ignore if focus is in an input or select
        const target = e.target as HTMLElement;
        const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

        const isCtrl = e.ctrlKey || e.metaKey;

        // UNDO / REDO logic
        if (isCtrl && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey) {
                if (canRedo) redo();
            } else {
                if (canUndo) undo();
            }
            return;
        }

        if (isInput) return;

        // SELECT ALL
        if (isCtrl && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            const allIds = [
                ...footprintRef.current.shapes.map(s => s.id),
                ...(footprintRef.current.meshes || []).map(m => m.id)
            ];
            setSelectedShapeIds(allIds);
            return;
        }

        if (isCtrl && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            handleCopy();
        }
        if (isCtrl && e.key.toLowerCase() === 'v') {
            e.preventDefault();
            handlePaste();
        }
        if (isCtrl && e.key.toLowerCase() === 'd') {
            e.preventDefault();
            handleDuplicate();
        }
        
        // DELETE Key logic
        if (e.key === "Delete" || e.key === "Backspace") {
            selectedShapeIds.forEach(id => {
                if (footprintRef.current.shapes.some(s => s.id === id)) {
                    deleteShape(id);
                } else if (footprintRef.current.meshes?.some(m => m.id === id)) {
                    deleteMesh(id);
                }
            });
        }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCopy, handlePaste, handleDuplicate, selectedShapeIds, deleteShape, deleteMesh, undo, redo, canUndo, canRedo]);

  // --- ACTIONS ---
  const addShape = (type: "circle" | "rect" | "line" | "footprint" | "wireGuide" | "boardOutline" | "polygon", footprintId?: string) => {
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
      newShape = { ...base, type: "wireGuide", x: "0", y: "0", name: "Wire Guide" } as FootprintWireGuide;
    } else if (type === "boardOutline") {
      newShape = { ...base, type: "boardOutline", x: "0", y: "0", name: "Board Outline", points: [{ id: crypto.randomUUID(), x: "-10", y: "-10" }, { id: crypto.randomUUID(), x: "10", y: "-10" }, { id: crypto.randomUUID(), x: "10", y: "10" }, { id: crypto.randomUUID(), x: "-10", y: "10" }] } as FootprintBoardOutline;
    } else if (type === "polygon") {
      newShape = { ...base, type: "polygon", x: "0", y: "0", name: "Polygon", points: [{ id: crypto.randomUUID(), x: "0", y: "10" }, { id: crypto.randomUUID(), x: "10", y: "-10" }, { id: crypto.randomUUID(), x: "-10", y: "-10" }] } as FootprintPolygon;
    } else {
      newShape = { ...base, type: "line", thickness: "1", x: "0", y: "0", points: [{ id: crypto.randomUUID(), x: "0", y: "0" }, { id: crypto.randomUUID(), x: "10", y: "10" }] };
    }

    // IMPROVEMENT: Always prepend new shapes to the list so they appear on top visually
    let nextFootprint = { ...footprint, shapes: [newShape, ...footprint.shapes] };

    // Automatic Layer Assignment for Board Outlines
    if (type === "boardOutline") {
        const assignments = { ...footprint.boardOutlineAssignments };
        const outlines = nextFootprint.shapes.filter(s => s.type === "boardOutline");
        // If this is the first outline, assign it to all layers
        if (outlines.length === 1) {
            stackup.forEach(l => {
                assignments[l.id] = newShape.id;
            });
            nextFootprint = { ...nextFootprint, boardOutlineAssignments: assignments };
        }
    }

    updateHistory(nextFootprint);
    setSelectedShapeIds([newShape.id]);
  };

  // NEW: Handle adding midpoint from 2D view
  const handleAddMidpoint = (shapeId: string, index: number) => {
    const shape = footprint.shapes.find(s => s.id === shapeId);
    if (!shape) return;
    if (shape.type !== "line" && shape.type !== "boardOutline" && shape.type !== "polygon") return;
    
    // Type guard/assertion for points presence
    const points = (shape as any).points as Point[];
    const p1Raw = points[index];
    
    const isClosed = shape.type === "boardOutline" || shape.type === "polygon";
    const p2Raw = isClosed ? points[(index + 1) % points.length] : points[index + 1];

    if (!p1Raw || !p2Raw) return;

    // Resolve Origin X/Y
    const originX = (shape.type === "boardOutline" || shape.type === "polygon") ? evaluateExpression(shape.x, params) : 0;
    const originY = (shape.type === "boardOutline" || shape.type === "polygon") ? evaluateExpression(shape.y, params) : 0;

    // Resolve points to numeric values (handling parameters and snaps)
    let p1 = resolvePoint(p1Raw, footprint, allFootprints, params);
    let p2 = resolvePoint(p2Raw, footprint, allFootprints, params);

    // Normalize coordinates to Global Space before averaging
    if (!p1Raw.snapTo) {
        p1 = { ...p1, x: p1.x + originX, y: p1.y + originY };
    }
    if (!p2Raw.snapTo) {
        p2 = { ...p2, x: p2.x + originX, y: p2.y + originY };
    }

    let midX, midY;

    // Check if we need Bezier interpolation
    // handleOut is p1's outgoing handle, handleIn is p2's incoming handle
    if (p1.handleOut || p2.handleIn) {
        // Control points (relative to anchors in resolved point structure)
        // p1.handleOut is {x, y} vector relative to p1
        const cp1x = p1.x + (p1.handleOut?.x || 0);
        const cp1y = p1.y + (p1.handleOut?.y || 0);
        
        // p2.handleIn is {x, y} vector relative to p2
        const cp2x = p2.x + (p2.handleIn?.x || 0);
        const cp2y = p2.y + (p2.handleIn?.y || 0);

        midX = bezier1D(p1.x, cp1x, cp2x, p2.x, 0.5);
        midY = bezier1D(p1.y, cp1y, cp2y, p2.y, 0.5);
    } else {
        // Linear midpoint
        midX = (p1.x + p2.x) / 2;
        midY = (p1.y + p2.y) / 2;
    }

    // Convert back to Local Space
    midX -= originX;
    midY -= originY;

    const newPoint: Point = {
        id: crypto.randomUUID(),
        // Convert back to string, rounded to 4 decimals to avoid float garbage
        x: parseFloat(midX.toFixed(4)).toString(),
        y: parseFloat(midY.toFixed(4)).toString()
    };

    const newPoints = [...points];
    newPoints.splice(index + 1, 0, newPoint);
    
    updateHistory({ ...footprint, shapes: footprint.shapes.map(s => s.id === shapeId ? { ...s, points: newPoints } : s) });
    // Keep shape selected
    setSelectedShapeIds([shapeId]);
  };

  const updateShape = (shapeId: string, field: string, val: any) => {
    updateHistory({ ...footprint, shapes: footprint.shapes.map((s) => s.id === shapeId ? { ...s, [field]: val } : s), });
  };
  const updateFootprintField = (field: string, val: any) => { updateHistory({ ...footprint, [field]: val }); };

  const moveShape = (index: number, direction: -1 | 1) => {
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === footprint.shapes.length - 1) return;
    const newShapes = [...footprint.shapes];
    [newShapes[index], newShapes[index + direction]] = [newShapes[index + direction], newShapes[index]];
    updateHistory({ ...footprint, shapes: newShapes });
  };
  
  // --- MESH ACTIONS ---
  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // NEW: Explicitly extract files using items fallback for WebKit/Tauri
      let files: File[] = [];
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          files = Array.from(e.dataTransfer.files);
      } else if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
          for (let i = 0; i < e.dataTransfer.items.length; i++) {
              const item = e.dataTransfer.items[i];
              if (item.kind === 'file') {
                  const f = item.getAsFile();
                  if (f) files.push(f);
              }
          }
      }

      console.log("Drop detected. Files found:", files.length);

      if (files.length > 0) {
          // Show spinner
          setProcessingMessage("Processing 3D File...");
          
          // Use timeout to allow render to update UI before heavy lifting
          setTimeout(() => {
              const newMeshes: FootprintMesh[] = [];

              const processNext = async (index: number) => {
                  if (index >= files.length) {
                      // All done
                      if (newMeshes.length > 0) {
                           // IMPROVEMENT: Prepend to appear at top
                           updateHistory({ ...footprint, meshes: [...newMeshes, ...(footprint.meshes || [])] });
                           setSelectedShapeIds([newMeshes[newMeshes.length - 1].id]);
                      }
                      setProcessingMessage(null);
                      return;
                  }

                  const file = files[index];
                  const ext = file.name.split('.').pop()?.toLowerCase();
                  
                  if (ext === "stl" || ext === "step" || ext === "stp" || ext === "obj" || ext === "glb" || ext === "gltf") {
                       let processedContent: string | null = null;
                       let processedFormat: "stl" | "step" | "obj" | "glb" = "stl";

                       if (footprint3DRef.current) {
                           const newMesh = await footprint3DRef.current.processDroppedFile(file);
                           if (newMesh) {
                               processedContent = (newMesh as any).content;
                               processedFormat = (newMesh as any).format;
                           }
                       } else {
                           // Fallback for 2D mode or uninitialized 3D view
                           const reader = new FileReader();
                           await new Promise<void>((resolve) => {
                               reader.onload = () => {
                                  if (reader.result instanceof ArrayBuffer) {
                                      processedContent = arrayBufferToBase64(reader.result);
                                      processedFormat = (ext === "stl" ? "stl" : (ext === "obj" ? "obj" : (ext === "glb" || ext === "gltf" ? "glb" : "step")));
                                  }
                                  resolve();
                               };
                               reader.readAsArrayBuffer(file);
                           });
                       }

                       if (processedContent) {
                           // DEDUPLICATION: Check if library already has this content
                           const existingAsset = meshAssets.find(a => a.content === processedContent);
                           let finalAssetId = "";
                           
                           if (existingAsset) {
                               finalAssetId = existingAsset.id;
                           } else {
                               finalAssetId = crypto.randomUUID();
                               onRegisterMesh({
                                   id: finalAssetId,
                                   name: file.name,
                                   content: processedContent,
                                   format: processedFormat
                               });
                           }

                           newMeshes.push({
                               id: crypto.randomUUID(),
                               name: file.name,
                               meshId: finalAssetId,
                               x: "0", y: "0", z: "0",
                               rotationX: "0", rotationY: "0", rotationZ: "0",
                               renderingType: "solid"
                           });
                       }
                  }
                  
                  processNext(index + 1);
              };

              processNext(0);
          }, 50);
      }
  };

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // NEW: Explicitly allow copy effect for drop
      e.dataTransfer.dropEffect = 'copy';
  };
  
  const updateMesh = (meshId: string, field: string, val: any) => {
      updateHistory({ ...footprint, meshes: (footprint.meshes || []).map(m => m.id === meshId ? { ...m, [field]: val } : m) });
  };


  const updateFootprintName = (name: string) => { updateHistory({ ...footprint, name }); };
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
    const assignedOutlineId = footprint.boardOutlineAssignments?.[layerId];
    const outlineShape = footprint.shapes.find(s => s.id === assignedOutlineId) as FootprintBoardOutline | undefined;
    
    const outline = (outlineShape?.points || []).map(p => {
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

  // Derive selection for properties panel (Primary selection is usually first in list)
  const primarySelectedId = selectedShapeIds.length > 0 ? selectedShapeIds[0] : null;
  const activeShape = footprint.shapes.find((s) => s.id === primarySelectedId);
  const activeMesh = footprint.meshes ? footprint.meshes.find(m => m.id === primarySelectedId) : null;
  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  const isShapeVisible = (shape: FootprintShape) => {
      // Board outlines visible based on isBoard flag
      if (shape.type === "boardOutline") return !!footprint.isBoard;
      // Wire guides always visible in editor
      if (shape.type === "wireGuide") return true;
      // Recursive footprints are visible if not explicitly hidden
      if (shape.type === "footprint") return true; 

      const assignedIds = Object.keys(shape.assignedLayers || {});
      if (assignedIds.length === 0) return layerVisibility["unassigned"] !== false;
      return !assignedIds.every(id => layerVisibility[id] === false);
  };

  const handleRadius = viewBox.width / 100;

  // Jump into footprint handler for double-clicks
  const handleShapeDoubleClick = (e: React.MouseEvent, id: string) => {
      e.stopPropagation(); e.preventDefault();
      const shape = footprint.shapes.find(s => s.id === id);
      if (shape && shape.type === "footprint") {
          onEditChild((shape as FootprintReference).footprintId);
      }
  };

  const handleBoardToggle = (checked: boolean) => {
      updateFootprintField("isBoard", checked);
      if (checked) {
          const hasOutline = footprint.shapes.some(s => s.type === "boardOutline");
          if (!hasOutline) {
              addShape("boardOutline");
          }
      }
  };

  const handleSelection = (id: string, multi: boolean) => {
      if (multi) {
          setSelectedShapeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
      } else {
          setSelectedShapeIds([id]);
      }
  };

  return (
    <div className="footprint-editor-container">
      {/* PROCESSING OVERLAY */}
      {processingMessage && (
          <div className="processing-overlay">
              <div className="spinner"></div>
              <div className="processing-text">{processingMessage}</div>
          </div>
      )}

      <div className="fp-toolbar">
        <button className="secondary" onClick={onClose}>← Back</button>
        {/* UNDO / REDO CONTROLS REMOVED FROM GUI, BUT HOOK AND KEYBOARD SHORTCUTS REMAIN */}
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginLeft: '10px' }}>
            <input className="toolbar-name-input" style={{ margin: 0 }} type="text" value={footprint.name} onChange={(e) => updateFootprintName(e.target.value)} />
            <label className="checkbox-label" style={{ fontSize: '0.85em', color: '#aaa', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!footprint.isBoard} onChange={(e) => handleBoardToggle(e.target.checked)} />
                Standalone Board (enables fabrication file exports)
            </label>
        </div>
        <div className="spacer" />
        <button onClick={() => addShape("circle")}><IconCircle /> Circle</button>
        <button onClick={() => addShape("rect")}><IconRect /> Rect</button>
        <button onClick={() => addShape("polygon")}><IconPolygon /> Polygon</button>
        <button onClick={() => addShape("line")}><IconLine /> Line</button>
        <button onClick={() => addShape("wireGuide")}><IconGuide /> Guide</button>
        {footprint.isBoard && <button onClick={() => addShape("boardOutline")}><IconOutline /> Outline</button>}
        
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
                selectedShapeIds={selectedShapeIds}
                onSelect={handleSelection}
                onDelete={deleteShape}
                onRename={(id, name) => updateShape(id, "name", name)}
                onMove={moveShape}
                stackup={stackup}
                isShapeVisible={isShapeVisible}
            />
            <MeshListPanel
                meshes={footprint.meshes || []}
                meshAssets={meshAssets}
                selectedShapeIds={selectedShapeIds}
                onSelect={handleSelection}
                onDelete={deleteMesh}
                onRename={(id, name) => updateMesh(id, "name", name)}
                updateMesh={updateMesh}
            />
        </div>

        <div className="fp-center-column">
            <div className="view-toggle-bar">
                <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>Sketch</button>
                <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D View</button>
            </div>

            <div 
                className="fp-canvas-wrapper" 
                ref={wrapperRef}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onContextMenu={(e) => e.preventDefault()} // DISABLE CONTEXT MENU FOR MAC DRAG
            >
                <button className="canvas-home-btn" onClick={handleHomeClick} title="Reset View">🏠</button>

            <div style={{ display: viewMode === "2D" ? 'contents' : 'none' }}>
                <svg 
                    ref={svgRef}
                    className="fp-canvas" 
                    viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                    onMouseDown={handleMouseDown}
                    style={{ cursor: isDragging.current ? 'grabbing' : 'default' }}
                >
                    <defs>
                    <pattern id="grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                        <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    </pattern>
                    </defs>
                    <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#grid)" />
                    <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    
                    {/* Shapes Rendered Reversed (Bottom to Top visual order) */}
                    {[...footprint.shapes].reverse().map((shape) => {
                        if (!isShapeVisible(shape)) return null;
                        
                        return (
                            <RecursiveShapeRenderer
                                key={shape.id}
                                shape={shape}
                                allFootprints={allFootprints}
                                params={params}
                                stackup={stackup}
                                isSelected={selectedShapeIds.includes(shape.id)}
                                isParentSelected={false}
                                onMouseDown={handleShapeMouseDown}
                                onHandleDown={handleHandleMouseDown}
                                onDoubleClick={handleShapeDoubleClick}
                                handleRadius={handleRadius}
                                rootFootprint={footprint}
                                layerVisibility={layerVisibility}
                                hoveredPointIndex={hoveredPointIndex}
                                setHoveredPointIndex={setHoveredPointIndex}
                                hoveredMidpointIndex={hoveredMidpointIndex}
                                setHoveredMidpointIndex={setHoveredMidpointIndex}
                                onAddMidpoint={handleAddMidpoint}
                            />
                        );
                    })}

                    {/* IMPROVEMENT: Second pass to render selected handles on top of everything else */}
                    {selectedShapeIds.map(id => {
                        const selectedShape = footprint.shapes.find(s => s.id === id);
                        if (selectedShape && isShapeVisible(selectedShape)) {
                            return (
                                <RecursiveShapeRenderer
                                    key={selectedShape.id + "_overlay"}
                                    shape={selectedShape}
                                    allFootprints={allFootprints}
                                    params={params}
                                    stackup={stackup}
                                    isSelected={true}
                                    isParentSelected={false}
                                    onMouseDown={handleShapeMouseDown}
                                    onHandleDown={handleHandleMouseDown}
                                    onDoubleClick={handleShapeDoubleClick}
                                    handleRadius={handleRadius}
                                    rootFootprint={footprint}
                                    layerVisibility={layerVisibility}
                                    hoveredPointIndex={hoveredPointIndex}
                                    setHoveredPointIndex={setHoveredPointIndex}
                                    hoveredMidpointIndex={hoveredMidpointIndex}
                                    setHoveredMidpointIndex={setHoveredMidpointIndex}
                                    onAddMidpoint={handleAddMidpoint}
                                    onlyHandles={true}
                                />
                            );
                        }
                        return null;
                    })}

                    {/* NEW: Selection Box Overlay */}
                    {selectionBox && (
                        <rect 
                            x={Math.min(selectionBox.start.x, selectionBox.current.x)}
                            y={Math.min(selectionBox.start.y, selectionBox.current.y)}
                            width={Math.abs(selectionBox.current.x - selectionBox.start.x)}
                            height={Math.abs(selectionBox.current.y - selectionBox.start.y)}
                            fill="rgba(100, 108, 255, 0.1)"
                            stroke="#646cff"
                            strokeWidth={1}
                            strokeDasharray="4,2"
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                        />
                    )}
                </svg>
                <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Left Drag: Select | Right/Middle Drag: Pan | Scroll: Zoom</div>
            </div>
            
            <div style={{ display: viewMode === "3D" ? 'contents' : 'none' }}>
                <Footprint3DView 
                    ref={footprint3DRef}
                    footprint={deferredFootprint}
                    allFootprints={allFootprints} // Pass full list for recursion
                    params={params}
                    stackup={stackup}
                    meshAssets={meshAssets}
                    visibleLayers={layerVisibility} 
                    is3DActive={viewMode === "3D"} 
                    selectedId={primarySelectedId}
                    onSelect={(id) => setSelectedShapeIds([id])}
                    onUpdateMesh={updateMesh} // Passed to allow Gizmo updates
                />
            </div>
            </div>
        </div>

        <div className="fp-sidebar">
          {activeShape || activeMesh ? (
            <>
              <FootprintPropertiesPanel 
                footprint={footprint}
                allFootprints={allFootprints}
                selectedId={primarySelectedId}
                updateShape={updateShape} 
                updateMesh={updateMesh} // NEW
                updateFootprint={updateFootprintField}
                params={params} 
                stackup={stackup}
                meshAssets={meshAssets}
                hoveredPointIndex={hoveredPointIndex}
                setHoveredPointIndex={setHoveredPointIndex}
                scrollToPointIndex={scrollToPointIndex}
                hoveredMidpointIndex={hoveredMidpointIndex}
                setHoveredMidpointIndex={setHoveredMidpointIndex}
                onDuplicate={handleDuplicate} // NEW
                onEditChild={onEditChild}
                onConvertShape={convertShape}
              />
              {activeShape && (
                <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                    <button className="danger" style={{width: '100%'}} onClick={() => deleteShape(activeShape.id)}>
                        Delete Shape
                    </button>
                </div>
              )}
              {activeMesh && (
                <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                    <button className="danger" style={{width: '100%'}} onClick={() => deleteMesh(activeMesh.id)}>
                        Delete Mesh
                    </button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <p>Select a shape, mesh, or board outline to edit properties.</p>
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
    contextFootprint: Footprint, 
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
        // SKIP WIRE GUIDES (Virtual) & BOARD OUTLINES
        if (shape.type === "wireGuide" || shape.type === "boardOutline") return;

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
             let endmillRadius = 0;
             if (layer.type === "Cut") {
                 depth = layerThickness;
             } else {
                 const assign = shape.assignedLayers[layer.id];
                 const val = evaluateExpression(typeof assign === 'object' ? assign.depth : assign, params);
                 depth = Math.max(0, val);
                 if (typeof assign === 'object') {
                     endmillRadius = evaluateExpression(assign.endmillRadius, params);
                 }
             }
             if (depth <= 0.0001) return;

             // Prepare Export Object
             const exportObj: any = {
                 x: gx,
                 y: gy,
                 depth: depth
             };

             if (layer.type === "Carved/Printed" && endmillRadius > 0) {
                 exportObj.endmill_radius = endmillRadius;
             }

             if (shape.type === "circle") {
                 exportObj.shape_type = "circle";
                 exportObj.diameter = evaluateExpression((shape as FootprintCircle).diameter, params);
                 result.push(exportObj);
             } else if (shape.type === "rect") {
                 exportObj.shape_type = "rect";
                 exportObj.width = evaluateExpression((shape as FootprintRect).width, params);
                 exportObj.height = evaluateExpression((shape as FootprintRect).height, params);
                 const localAngle = evaluateExpression((shape as FootprintRect).angle, params);
                 exportObj.angle = transform.angle + localAngle;
                 exportObj.corner_radius = evaluateExpression((shape as FootprintRect).cornerRadius, params);
                 result.push(exportObj);
             } else if (shape.type === "line") {
                exportObj.shape_type = "line";
                exportObj.thickness = evaluateExpression((shape as FootprintLine).thickness, params);
                
                const lineShape = shape as FootprintLine;
                exportObj.points = lineShape.points.map(p => {
                    // 1. Resolve point in the context of the footprint where it resides
                    const resolved = resolvePoint(p, contextFootprint, allFootprints, params);
                    
                    // 2. Transform the resolved point by the cumulative transform of the recursion
                    // transform.angle is the rotation of contextFootprint in the global export frame
                    const rad = (transform.angle * Math.PI) / 180;
                    const cos = Math.cos(rad);
                    const sin = Math.sin(rad);
                    
                    // Rotate anchor
                    const rx = resolved.x * cos - resolved.y * sin;
                    const ry = resolved.x * sin + resolved.y * cos;
                    
                    // Helper to rotate handle vectors
                    const rotateVec = (v?: {x: number, y: number}) => v ? {
                        x: v.x * cos - v.y * sin,
                        y: v.x * sin + v.y * cos
                    } : undefined;

                    return {
                        x: transform.x + rx,
                        y: transform.y + ry,
                        handle_in: rotateVec(resolved.handleIn),
                        handle_out: rotateVec(resolved.handleOut)
                    };
                });
                result.push(exportObj);
            } else if (shape.type === "polygon") {
                const poly = shape as FootprintPolygon;
                
                // If it's a simple cut or flat carve, just send the definition
                if (endmillRadius <= 0.001 || layer.type === "Cut") {
                    exportObj.shape_type = "polygon";
                    exportObj.points = poly.points.map(p => {
                        const resolved = resolvePoint(p, contextFootprint, allFootprints, params);
                        const rad = (transform.angle * Math.PI) / 180;
                        const cos = Math.cos(rad);
                        const sin = Math.sin(rad);
                        const rx = resolved.x * cos - resolved.y * sin;
                        const ry = resolved.x * sin + resolved.y * cos;
                        const rotateVec = (v?: {x: number, y: number}) => v ? {
                            x: v.x * cos - v.y * sin,
                            y: v.x * sin + v.y * cos
                        } : undefined;
                        return {
                            x: transform.x + rx,
                            y: transform.y + ry,
                            handle_in: rotateVec(resolved.handleIn),
                            handle_out: rotateVec(resolved.handleOut)
                        };
                    });
                    result.push(exportObj);
                } else {
                    // Complex Carve: Pre-calculate slices in JS
                    const basePoints = getPolyOutlinePoints(poly.points, 0, 0, params, contextFootprint, allFootprints, 32);
                    
                    // Slicing parameters
                    const safeR = Math.min(endmillRadius, depth);
                    const steps = 8;
                    const baseDepth = depth - safeR;

                    const layers: { z: number, offset: number }[] = [];
                    // 1. Base (Deepest flat part)
                    if (baseDepth > 0.001) layers.push({ z: baseDepth, offset: 0 });
                    
                    // 2. Gradient Steps
                    for(let i=1; i<=steps; i++) {
                        const theta = (i / steps) * (Math.PI / 2);
                        const z = baseDepth + Math.sin(theta) * safeR;
                        const off = (1 - Math.cos(theta)) * safeR;
                        layers.push({ z, offset: off });
                    }

                    // 3. Generate and Push Slices
                    const globalRad = (transform.angle * Math.PI) / 180;
                    const gCos = Math.cos(globalRad);
                    const gSin = Math.sin(globalRad);

                    layers.forEach(layer => {
                        const offsetPts = offsetPolygonContour(basePoints, layer.offset);
                        if (offsetPts.length < 3) return;

                        // Transform offset points to Global export coordinates
                        const outputPoints = offsetPts.map(p => {
                            // Re-apply rotation to these points (basePoints are relative to shape origin)
                            const rx = p.x * gCos - p.y * gSin; 
                            const ry = p.x * gSin + p.y * gCos;
                            
                            return {
                                x: transform.x + rx,
                                y: transform.y + ry,
                                handle_in: undefined,
                                handle_out: undefined
                            };
                        });

                        result.push({
                            shape_type: "polygon",
                            x: gx, 
                            y: gy,
                            depth: layer.z,
                            endmill_radius: 0, // Mark as pre-processed
                            points: outputPoints
                        });
                    });
                }
            }
        }
    });

    return result;
}