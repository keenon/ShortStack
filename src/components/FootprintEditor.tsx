// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintRect, FootprintCircle, FootprintLine, FootprintWireGuide, FootprintMesh, FootprintBoardOutline, Point, MeshAsset, FootprintPolygon, FootprintUnion, FootprintText } from "../types";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import { modifyExpression, isFootprintOptionValid, evaluateExpression, resolvePoint, bezier1D, getPolyOutlinePoints, offsetPolygonContour, getShapeAABB, isShapeInSelection, rotatePoint, getAvailableWireGuides, findWireGuideByPath, getFootprintAABB, getTransformAlongLine, getClosestDistanceAlongLine } from "../utils/footprintUtils";
import { RecursiveShapeRenderer } from "./FootprintRenderers";
import FootprintPropertiesPanel from "./FootprintPropertiesPanel";
import { IconCircle, IconRect, IconLine, IconGuide, IconOutline, IconMesh, IconPolygon, IconText } from "./Icons";
import ShapeListPanel from "./ShapeListPanel";
import { useUndoHistory } from "../hooks/useUndoHistory"; 
import * as THREE from "three";
import './FootprintEditor.css';

// --- GLOBAL CLIPBOARD (Persists across footprint switches) ---
let GLOBAL_CLIPBOARD: { 
  type: "shapes" | "meshes", 
  sourceFootprintId: string, // Added this
  data: any[] 
} | null = null;

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

// Type helper for Undo History state
type FootprintEditorState = {
  footprint: Footprint;
  selectedShapeIds: string[];
};

export default function FootprintEditor({ footprint: initialFootprint, allFootprints, onUpdate, onClose, onEditChild, params, stackup, meshAssets, onRegisterMesh }: Props) {
  // --- HISTORY HOOK ---
  // Updated to include selection in the present state
  const { 
    state: editorState, 
    set: updateHistory, 
    undo, 
    redo, 
    canUndo, 
    canRedo,
    resetHistory
  } = useUndoHistory<FootprintEditorState>({
    footprint: initialFootprint,
    selectedShapeIds: []
  }, 500);

  // Derived properties from history state
  const { footprint, selectedShapeIds } = editorState;

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
      resetHistory({ footprint: initialFootprint, selectedShapeIds: [] });
  }

  // Helper to push history updates
  const setFootprint = (newFootprint: Footprint) => updateHistory({ ...editorState, footprint: newFootprint });
  const setSelectedShapeIds = (newSelection: string[]) => updateHistory({ ...editorState, selectedShapeIds: newSelection });

  const [processingMessage, setProcessingMessage] = useState<string | null>(null);
  
  // NEW: Selection Box State
  const [selectionBox, setSelectionBox] = useState<{ start: {x: number, y: number}, current: {x: number, y: number} } | null>(null);
  const isSelectionDragging = useRef(false);
  const selectionStartRef = useRef<{x: number, y: number} | null>(null);
  const selectionCurrentRef = useRef<{x: number, y: number} | null>(null);

  // Rotation State
  const [rotationGuide, setRotationGuide] = useState<{ center: {x:number, y:number}, current: {x:number, y:number} } | null>(null);
  const isRotating = useRef(false);
  const rotationStartData = useRef<{
    center: { x: number, y: number };
    startMouseAngle: number;
    initialShapes: Map<string, any>;
  } | null>(null);

  // NEW: State for point interaction
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const [scrollToPointIndex, setScrollToPointIndex] = useState<number | null>(null);
  // NEW: State for midpoint interaction
  const [hoveredMidpointIndex, setHoveredMidpointIndex] = useState<number | null>(null);

  // NEW: State for visual feedback during soft-snapping
  const [snapPreview, setSnapPreview] = useState<{
    targetId: string;
    x: number;
    y: number;
  } | null>(null);

  // NEW: State for Tie Down Interaction
  const [hoveredTieDownId, setHoveredTieDownId] = useState<string | null>(null);
  const [scrollToTieDownId, setScrollToTieDownId] = useState<string | null>(null);

  // NEW: Dedicated Tie Down Drag State
  const tieDownDragState = useRef<{
      active: boolean;
      type: 'slide' | 'rotate';
      tieDownId: string;
      lineId: string;
      startMouse: { x: number, y: number };
      pivot: { x: number, y: number }; // Global coordinates of the tie down anchor
      startAngle: number; // For rotation: mouse angle
      initialParamAngle: number; // Value of angle param at start
      initialParamDist: number; // Value of dist param at start
      distOffset: number; // The difference between mouse projection on wire and the actual object center at start
      wireSnapPoint: { x: number, y: number } | null; // For visualization
  } | null>(null);

  // Visual helper for tie down operations (passed to renderer or overlay)
  const [tieDownVisuals, setTieDownVisuals] = useState<{
      type: 'slide' | 'rotate';
      lineStart: { x: number, y: number }; // Start of dotted line (Mouse or Pivot)
      lineEnd: { x: number, y: number };   // End of dotted line (Wire Point or Mouse)
  } | null>(null);

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

  // UPDATED: Added DragMode and Resize specific metadata
  type DragMode = 'move' | 'resize';
  type ResizeHandle = 'top' | 'bottom' | 'left' | 'right' | 'ring';

  const dragTargetRef = useRef<{ 
      id: string; 
      pointIdx?: number; 
      handleType?: 'in' | 'out' | 'symmetric';
      mode: DragMode;
      resizeHandle?: ResizeHandle;
      initialVal?: string; // Original expression for width/height/dia
      tieDownId?: string; // NEW: Dragging a tie down
  } | null>(null);
  
  // FIX: Store the effective selection used during drag so we don't rely on stale closure state
  const dragSelectionRef = useRef<string[]>([]);

  // NEW: Memoized list of guide positions for proximity checking
  const snapTargets = useMemo(() => {
    // We only care about guides at the current footprint level for simplicity, 
    // but this uses the pathId for full compatibility.
    return getAvailableWireGuides(footprint, allFootprints).map(guideDef => {
        const guide = findWireGuideByPath(guideDef.pathId, footprint, allFootprints);
        if (!guide) return null;
        
        // Use resolvePoint to get global coordinates within this footprint's frame
        // (Note: resolvePoint handles the math of nested footprints if the path is complex)
        const res = resolvePoint({ snapTo: guideDef.pathId } as Point, footprint, allFootprints, params);
        
        return {
            pathId: guideDef.pathId,
            id: guide.id,
            x: res.x,
            y: -res.y // Visual Y is inverted
        };
    }).filter(t => t !== null) as { pathId: string, id: string, x: number, y: number }[];
  }, [footprint, allFootprints, params]);

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
    
    // Right Click (2) or Middle Click (1) for PAN
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

    // ALT + Left Click -> ROTATION
    if (e.button === 0 && e.altKey && selectedShapeIds.length > 0) {
        e.stopPropagation(); e.preventDefault();

        // NEW: Filter out locked shapes so they don't rotate
        const rotatableIds = selectedShapeIds.filter(id => {
            const s = footprint.shapes.find(shape => shape.id === id);
            return s && !s.locked;
        });

        if (rotatableIds.length === 0) return; // Abort if everything selected is locked

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let count = 0;
        
        // Calculate centroid based only on rotatable shapes
        rotatableIds.forEach(id => {
            const shape = footprint.shapes.find(s => s.id === id);
            if (shape) {
                const aabb = getShapeAABB(shape, params, footprint, allFootprints);
                if (aabb) {
                    minX = Math.min(minX, aabb.x1, aabb.x2); maxX = Math.max(maxX, aabb.x1, aabb.x2);
                    minY = Math.min(minY, aabb.y1, aabb.y2); maxY = Math.max(maxY, aabb.y1, aabb.y2);
                    count++;
                }
            }
        });
        if (count === 0) return;
        const centroid = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        const mousePos = getMouseWorldPos(e.clientX, e.clientY);
        const startAngle = Math.atan2(mousePos.y - centroid.y, mousePos.x - centroid.x);
        const snapshot = new Map<string, any>();
        
        // Snapshot only rotatable shapes
        footprint.shapes.forEach(s => { 
            if (rotatableIds.includes(s.id)) snapshot.set(s.id, JSON.parse(JSON.stringify(s))); 
        });
        
        isRotating.current = true;
        rotationStartData.current = { center: centroid, startMouseAngle: startAngle, initialShapes: snapshot };
        setRotationGuide({ center: centroid, current: mousePos });
        window.addEventListener('mousemove', handleGlobalMouseMove);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return;
    }

    // Left Click (0) for SELECTION BOX
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
    // 1. ROTATION LOGIC
    if (isRotating.current && rotationStartData.current) {
        const mousePos = getMouseWorldPos(e.clientX, e.clientY);
        setRotationGuide({ center: rotationStartData.current.center, current: mousePos });
        
        const currentAngle = Math.atan2(mousePos.y - rotationStartData.current.center.y, mousePos.x - rotationStartData.current.center.x);
        const deltaAngleRad = currentAngle - rotationStartData.current.startMouseAngle;
        const deltaAngleDeg = deltaAngleRad * (180 / Math.PI);
        
        const cx = rotationStartData.current.center.x; 
        const cy = rotationStartData.current.center.y;

        // Pre-calculate Handle Rotation Trigs (Inverted Angle for Math Space vectors)
        // Visual CW (+angle) == Math CW (-angle) because Y is inverted.
        const hCos = Math.cos(-deltaAngleRad);
        const hSin = Math.sin(-deltaAngleRad);
        
        const newShapes = footprintRef.current.shapes.map(s => {
            const startState = rotationStartData.current!.initialShapes.get(s.id);
            if (!startState) return s;

            // Helper: Resolve visual origin from expression string
            const getVis = (sx: string, sy: string) => ({ 
                x: evaluateExpression(sx, params), 
                y: -evaluateExpression(sy, params) // Visual Y is inverted
            });

            if (s.type === "circle" || s.type === "rect" || s.type === "footprint" || s.type === "wireGuide" || s.type === "union") {
                // 1. Calculate Numeric Rotation
                const origin = getVis(startState.x, startState.y);
                const rotatedOrigin = rotatePoint(origin, { x: cx, y: cy }, deltaAngleRad);
                
                // 2. Calculate Deltas (New Numeric - Old Numeric)
                const startXVal = origin.x;
                const startYVal = -origin.y; // Convert visual Y back to math Y
                
                const newXVal = rotatedOrigin.x;
                const newYVal = -rotatedOrigin.y; // Convert visual Y back to math Y
                
                const dx = newXVal - startXVal;
                const dy = newYVal - startYVal;

                // 3. Apply Deltas to Expressions
                const newProps: any = { 
                    x: modifyExpression(startState.x, dx), 
                    y: modifyExpression(startState.y, dy) 
                };

                // 4. Handle Rotation Property (Rects/Footprints/Unions)
                if (s.type === "rect" || s.type === "footprint" || s.type === "union") {
                    newProps.angle = modifyExpression(startState.angle, -deltaAngleDeg);
                }

                // 5. Handle Wire Guide Orientation Handle (if exists)
                if (s.type === "wireGuide" && (s as any).handle) {
                    const h = (startState as any).handle;
                    const hx = evaluateExpression(h.x, params);
                    const hy = evaluateExpression(h.y, params);
                    
                    const rvhx = hx * hCos - hy * hSin;
                    const rvhy = hx * hSin + hy * hCos;
                    
                    newProps.handle = {
                        x: modifyExpression(h.x, rvhx - hx),
                        y: modifyExpression(h.y, rvhy - hy)
                    };
                }

                return { ...s, ...newProps };

            } else if (s.type === "line" || s.type === "boardOutline" || s.type === "polygon") {
                // Recompute point locations using static origin frame
                const originX = (s.type === "line") ? 0 : evaluateExpression(startState.x, params);
                const visualOriginX = originX;
                const visualOriginY = (s.type === "line") ? 0 : -evaluateExpression(startState.y, params);

                const rotatedPoints = (startState.points as Point[]).map(p => {
                    const pxRaw = evaluateExpression(p.x, params);
                    const pyRaw = evaluateExpression(p.y, params);
                    
                    // Visual global position: (ShapeOrigin + PointLocal)
                    // Visual Y = VisualOriginY - pyRaw (since pyRaw is positive up)
                    const vP = { 
                        x: visualOriginX + pxRaw, 
                        y: visualOriginY - pyRaw 
                    };

                    // Rotate the VISUAL point around the Centroid
                    const rP = rotatePoint(vP, { x: cx, y: cy }, deltaAngleRad);
                    
                    // Convert back to Local Math Coordinates
                    const npx = rP.x - visualOriginX;
                    const npy = visualOriginY - rP.y;
                    
                    const dx = npx - pxRaw;
                    const dy = npy - pyRaw;

                    // Rotate Handles (Vectors)
                    // Uses hCos/hSin (Negative Angle) to rotate correctly in Math Space
                    const rotateVecExp = (h: {x: string, y: string}) => {
                        const hx = evaluateExpression(h.x, params);
                        const hy = evaluateExpression(h.y, params);
                        
                        const rvhx = hx * hCos - hy * hSin;
                        const rvhy = hx * hSin + hy * hCos;
                        
                        return { 
                            x: modifyExpression(h.x, rvhx - hx), 
                            y: modifyExpression(h.y, rvhy - hy) 
                        };
                    };

                    return {
                        ...p,
                        x: modifyExpression(p.x, dx),
                        y: modifyExpression(p.y, dy),
                        handleIn: p.handleIn ? rotateVecExp(p.handleIn) : undefined,
                        handleOut: p.handleOut ? rotateVecExp(p.handleOut) : undefined
                    };
                });
                return { ...s, points: rotatedPoints };
            }
            return s;
        });
        setFootprint({ ...footprintRef.current, shapes: newShapes });
        return;
    }

    // 2. PANNING LOGIC
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

    // 3. SELECTION BOX LOGIC
    if (isSelectionDragging.current && wrapperRef.current) {
        const currentPos = getMouseWorldPos(e.clientX, e.clientY);
        selectionCurrentRef.current = currentPos;
        if (selectionStartRef.current) {
            setSelectionBox({ start: selectionStartRef.current, current: currentPos });
        }
    }
  };

  const handleGlobalMouseUp = (e: MouseEvent) => {
    // 1. ROTATION STOP
    if (isRotating.current) {
        isRotating.current = false; setRotationGuide(null); rotationStartData.current = null;
        updateHistory({ footprint: footprintRef.current, selectedShapeIds });
    }

    // 2. STOP PANNING
    if (isDragging.current) {
        isDragging.current = false;
    }

    // 3. FINISH SELECTION BOX
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
                setSelectedShapeIds(Array.from(new Set([...selectedShapeIds, ...newSelectedIds])));
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

  // NEW: Handle Mouse Down on a Tie Down
  const handleTieDownMouseDown = (e: React.MouseEvent, lineId: string, tieDownId: string) => {
      if (e.button !== 0) return; // Left Click Only
      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;

      // FIX: Ensure selection happens first so panel renders
      if (!selectedShapeIds.includes(lineId)) {
          setSelectedShapeIds([lineId]);
      }

      // FIX: Toggle scroll ID to force effect trigger even if same ID clicked
      setScrollToTieDownId(null);
      setTimeout(() => {
          setScrollToTieDownId(tieDownId);
      }, 10);

      const shape = footprint.shapes.find(s => s.id === lineId) as FootprintLine;
      if (!shape || shape.locked) return;
      const tieDown = shape.tieDowns?.find(td => td.id === tieDownId);
      if (!tieDown) return;

      const mWorld = getMouseWorldPos(e.clientX, e.clientY);
      // NOTE: getMouseWorldPos returns visual coords (Y down). 
      // We convert to Math coords (Y up) for geometry calculations.
      const mouseMath = { x: mWorld.x, y: -mWorld.y };

      const type = e.altKey ? 'rotate' : 'slide';
      
      // Calculate Pivot Point (Current location of Tie Down)
      const currentDist = evaluateExpression(tieDown.distance, params);
      const tf = getTransformAlongLine(shape, currentDist, params, footprint, allFootprints);
      if (!tf) return;

      let startState: any = {
          active: true,
          type,
          tieDownId,
          lineId,
          startMouse: mouseMath,
          pivot: { x: tf.x, y: tf.y },
          initialParamAngle: evaluateExpression(tieDown.angle, params),
          initialParamDist: currentDist,
      };

      if (type === 'rotate') {
          // Calculate initial angle from pivot to mouse
          const dy = mouseMath.y - tf.y;
          const dx = mouseMath.x - tf.x;
          startState.startAngle = Math.atan2(dy, dx) * (180 / Math.PI);
          
          setTieDownVisuals({
              type: 'rotate',
              lineStart: { x: tf.x, y: tf.y },
              lineEnd: { x: mouseMath.x, y: mouseMath.y } // Visual Y handled in render
          });
      } else {
          // Slide: Find where the mouse projects onto the wire NOW to set the offset
          // so drag doesn't snap center to mouse
          const result = getClosestDistanceAlongLine(shape, mouseMath, params, footprint, allFootprints);
          startState.distOffset = currentDist - result.distance;
          
          setTieDownVisuals({
              type: 'slide',
              lineStart: { x: mouseMath.x, y: mouseMath.y }, // From mouse
              lineEnd: { x: result.closestPoint.x, y: result.closestPoint.y } // To wire
          });
      }

      tieDownDragState.current = startState;
      
      window.addEventListener('mousemove', handleTieDownMouseMove);
      window.addEventListener('mouseup', handleTieDownMouseUp);
  };

  const handleTieDownMouseMove = (e: MouseEvent) => {
      if (!tieDownDragState.current || !tieDownDragState.current.active) return;
      const state = tieDownDragState.current;
      
      const mWorld = getMouseWorldPos(e.clientX, e.clientY);
      const mouseMath = { x: mWorld.x, y: -mWorld.y };

      const currentShape = footprintRef.current.shapes.find(s => s.id === state.lineId) as FootprintLine;
      if (!currentShape || !currentShape.tieDowns) return;
      
      const tdIndex = currentShape.tieDowns.findIndex(td => td.id === state.tieDownId);
      if (tdIndex === -1) return;

      if (state.type === 'rotate') {
          // Calculate Delta Angle
          const dy = mouseMath.y - state.pivot.y;
          const dx = mouseMath.x - state.pivot.x;
          const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI);
          const delta = currentAngle - state.startAngle; // CCW is positive in math
          
          // Apply to initial param
          const newAngleExpr = modifyExpression(String(state.initialParamAngle), delta);
          
          const newTieDowns = [...currentShape.tieDowns];
          newTieDowns[tdIndex] = { ...newTieDowns[tdIndex], angle: newAngleExpr };
          
          updateHistory({ 
              footprint: { 
                  ...footprintRef.current, 
                  shapes: footprintRef.current.shapes.map(s => s.id === state.lineId ? { ...s, tieDowns: newTieDowns } : s) 
              },
              selectedShapeIds: dragSelectionRef.current
          });

          // Update Visual
          setTieDownVisuals({
              type: 'rotate',
              lineStart: { x: state.pivot.x, y: state.pivot.y },
              lineEnd: { x: mouseMath.x, y: mouseMath.y }
          });

      } else {
          // Slide Logic
          const result = getClosestDistanceAlongLine(currentShape, mouseMath, params, footprintRef.current, allFootprints);
          
          // New distance = Projected Distance + Constant Offset
          const rawNewDist = result.distance + state.distOffset;
          
          // Update Param
          const deltaDist = rawNewDist - state.initialParamDist;
          const newDistExpr = modifyExpression(String(state.initialParamDist), deltaDist);

          const newTieDowns = [...currentShape.tieDowns];
          newTieDowns[tdIndex] = { ...newTieDowns[tdIndex], distance: newDistExpr };

          updateHistory({ 
              footprint: { 
                  ...footprintRef.current, 
                  shapes: footprintRef.current.shapes.map(s => s.id === state.lineId ? { ...s, tieDowns: newTieDowns } : s) 
              },
              selectedShapeIds: dragSelectionRef.current
          });

          // Update Visual: Line from Mouse to Closest Point on Wire
          setTieDownVisuals({
              type: 'slide',
              lineStart: { x: mouseMath.x, y: mouseMath.y },
              lineEnd: { x: result.closestPoint.x, y: result.closestPoint.y }
          });
      }
  };

  const handleTieDownMouseUp = () => {
      if (!tieDownDragState.current) return;
      const finalLineId = tieDownDragState.current.lineId;
      
      tieDownDragState.current = null;
      setTieDownVisuals(null);

      // FIX: Use finalLineId from the ref instead of the stale selectedShapeIds state
      updateHistory({ 
          footprint: footprintRef.current, 
          selectedShapeIds: [finalLineId] 
      });
      window.removeEventListener('mousemove', handleTieDownMouseMove);
      window.removeEventListener('mouseup', handleTieDownMouseUp);
  };

  const handleShapeMouseDown = (e: React.MouseEvent, id: string, pointIndex?: number) => {
      // Only allow Left Click (0) for shape interaction.
      // This allows Right Click (2) and Middle Click (1) to bubble up to camera panning.
      if (e.button !== 0) return;
      // Pass through if Alt is held to allow Global Rotation
      if (e.altKey) return; 

      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;

      const multi = e.metaKey || e.ctrlKey;
      let effectiveSelection: string[] = [];

      // Selection logic
      if (pointIndex !== undefined) {
          // If we click a point, we focus that single shape
          effectiveSelection = [id];
      } else if (multi) {
          effectiveSelection = selectedShapeIds.includes(id) ? selectedShapeIds.filter(x => x !== id) : [...selectedShapeIds, id];
      } else if (!selectedShapeIds.includes(id)) {
          // Normal click on a new item resets selection
          effectiveSelection = [id];
      } else {
          // Already selected, preserve for group drag
          effectiveSelection = [...selectedShapeIds];
      }

      setSelectedShapeIds(effectiveSelection);
      if (pointIndex !== undefined) setScrollToPointIndex(pointIndex);

      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;

      // NEW: Check lock state
      if (shape.locked) return;

      isShapeDragging.current = true;
      hasMoved.current = false;
      shapeDragStartPos.current = { x: e.clientX, y: e.clientY };
      
      // FIX: Store effective selection in ref to be used in mouseMove
      dragSelectionRef.current = effectiveSelection;

      // SNAPSHOT ALL SELECTED SHAPES
      // FIX: Use effectiveSelection calculated synchronously to ensure drag snapshot is correct
      shapeDragStartDataMap.current.clear();
      footprint.shapes.forEach(s => {
          if (effectiveSelection.includes(s.id)) {
              shapeDragStartDataMap.current.set(s.id, JSON.parse(JSON.stringify(s)));
          }
      });

      // --- HIT TESTING FOR RESIZE vs MOVE ---
      let dragMode: DragMode = 'move';
      let resizeHandle: ResizeHandle | undefined;
      let initialVal: string | undefined;

      // Only attempt resize if one shape is selected and we aren't clicking a point handle
      if (pointIndex === undefined && effectiveSelection.length === 1 && wrapperRef.current) {
          const rect = wrapperRef.current.getBoundingClientRect();
          const scaleX = viewBoxRef.current.width / rect.width;
          const threshold = 8 * scaleX; // 8 pixels in world units

          const mWorld = getMouseWorldPos(e.clientX, e.clientY);
          const cx = evaluateExpression((shape as any).x, params);
          const cy = -evaluateExpression((shape as any).y, params);

          if (shape.type === 'circle') {
              const dia = evaluateExpression(shape.diameter, params);
              const dist = Math.sqrt(Math.pow(mWorld.x - cx, 2) + Math.pow(mWorld.y - cy, 2));
              if (Math.abs(dist - dia / 2) < threshold && (dia / 2) > threshold * 2) {
                  dragMode = 'resize';
                  resizeHandle = 'ring';
                  initialVal = shape.diameter;
              }
          } else if (shape.type === 'rect') {
              const w = evaluateExpression(shape.width, params);
              const h = evaluateExpression(shape.height, params);
              const angle = evaluateExpression(shape.angle, params);
              const rad = (angle * Math.PI) / 180;
              
              // Rotate mouse into local space
              const dx = mWorld.x - cx;
              const dy = mWorld.y - cy;
              const lmx = dx * Math.cos(rad) - dy * Math.sin(rad);
              const lmy = dx * Math.sin(rad) + dy * Math.cos(rad);

              const hw = w / 2; const hh = h / 2;
              const isVertEdge = Math.abs(lmy) < (hh + threshold);
              const isHorizEdge = Math.abs(lmx) < (hw + threshold);

              if (Math.abs(lmx - hw) < threshold && isVertEdge) { dragMode = 'resize'; resizeHandle = 'right'; initialVal = shape.width; }
              else if (Math.abs(lmx + hw) < threshold && isVertEdge) { dragMode = 'resize'; resizeHandle = 'left'; initialVal = shape.width; }
              else if (Math.abs(lmy - hh) < threshold && isHorizEdge) { dragMode = 'resize'; resizeHandle = 'bottom'; initialVal = shape.height; }
              else if (Math.abs(lmy + hh) < threshold && isHorizEdge) { dragMode = 'resize'; resizeHandle = 'top'; initialVal = shape.height; }
          }
      }

      dragTargetRef.current = { 
          id, pointIdx: pointIndex, 
          handleType: (pointIndex !== undefined && (e.ctrlKey || e.metaKey)) ? 'symmetric' : undefined,
          mode: dragMode, resizeHandle, initialVal 
      };

      window.addEventListener('mousemove', handleShapeMouseMove);
      window.addEventListener('mouseup', handleShapeMouseUp);
  };

  const handleHandleMouseDown = (e: React.MouseEvent, id: string, pointIndex: number, type: 'in' | 'out') => {
      // Only allow Left Click (0) for shape interaction.
      // This allows Right Click (2) and Middle Click (1) to bubble up to camera panning.
      if (e.button !== 0) return;

      // Pass through if Alt is held to allow Global Rotation
      if (e.altKey) return; 

      e.stopPropagation(); e.preventDefault();
      if (viewMode !== "2D") return;
      
      const effectiveSelection = [id];
      setSelectedShapeIds(effectiveSelection);
      dragSelectionRef.current = effectiveSelection; // Sync drag ref
      
      // NEW: Trigger scroll
      setScrollToPointIndex(pointIndex);

      const shape = footprint.shapes.find(s => s.id === id);
      if (!shape) return;

      // NEW: Check lock state
      if (shape.locked) return;

      isShapeDragging.current = true;
      hasMoved.current = false;
      dragTargetRef.current = { id, pointIdx: pointIndex, handleType: type, mode: 'move' };
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
      const dyWorldMath = -dyPx * scaleY;
      const dyWorldVis = dyPx * scaleY;

      const currentFP = footprintRef.current;
      const { id: targetId, pointIdx, handleType, mode, resizeHandle, initialVal } = dragTargetRef.current;
      
      const updatedShapes = currentFP.shapes.map(s => {
          // NEW: Safety check for multi-selection dragging.
          if (s.locked) return s;

          const startShape = shapeDragStartDataMap.current.get(s.id);
          if (!startShape) return s;

          // Only move if part of selection, OR it is the specific target shape
          // FIX: Use dragSelectionRef instead of state to avoid stale closure issues
          if (s.id === targetId || dragSelectionRef.current.includes(s.id)) {
              
              // --- RESIZE EXECUTION ---
              if (mode === 'resize' && s.id === targetId && initialVal) {
                  const cx = evaluateExpression(startShape.x, params);
                  const cy = -evaluateExpression(startShape.y, params);
                  const angle = evaluateExpression((startShape as any).angle || "0", params);
                  const rad = (angle * Math.PI) / 180;

                  if (s.type === 'circle') {
                      const m = getMouseWorldPos(e.clientX, e.clientY);
                      const dist = Math.sqrt(Math.pow(m.x - cx, 2) + Math.pow(m.y - cy, 2));
                      const startM = getMouseWorldPos(shapeDragStartPos.current.x, shapeDragStartPos.current.y);
                      const startDist = Math.sqrt(Math.pow(startM.x - cx, 2) + Math.pow(startM.y - cy, 2));
                      return { ...s, diameter: modifyExpression(initialVal, (dist - startDist) * 2) };
                  }
                  if (s.type === 'rect') {
                      const ldx = dxWorld * Math.cos(rad) - dyWorldVis * Math.sin(rad);
                      const ldy = dxWorld * Math.sin(rad) + dyWorldVis * Math.cos(rad);
                      const startM = getMouseWorldPos(shapeDragStartPos.current.x, shapeDragStartPos.current.y);
                      const slx = (startM.x - cx) * Math.cos(rad) - (startM.y - cy) * Math.sin(rad);
                      const sly = (startM.x - cx) * Math.sin(rad) + (startM.y - cy) * Math.cos(rad);

                      if (resizeHandle === 'left' || resizeHandle === 'right') {
                          return { ...s, width: modifyExpression(initialVal, ldx * (slx >= 0 ? 1 : -1) * 2) };
                      } else {
                          return { ...s, height: modifyExpression(initialVal, ldy * (sly >= 0 ? 1 : -1) * 2) };
                      }
                  }
              }

              // --- UPDATED POINT MOVE LOGIC WITH SOFT SNAP ---
              if (pointIdx !== undefined && s.id === targetId) {
                  // Handle Wire Guide direction handle specifically
                  if (startShape.type === "wireGuide") {
                      if (startShape.handle) {
                          return {
                              ...s,
                              handle: {
                                  x: modifyExpression(startShape.handle.x, dxWorld),
                                  y: modifyExpression(startShape.handle.y, dyWorldMath)
                              }
                          };
                      }
                      return s;
                  }

                  const newPoints = [...(startShape as any).points];
                  const startPt = startShape.points[pointIdx];

                  if (handleType === 'symmetric') {
                      newPoints[pointIdx] = { ...newPoints[pointIdx], 
                          handleOut: { x: dxWorld.toFixed(4), y: dyWorldMath.toFixed(4) },
                          handleIn: { x: (-dxWorld).toFixed(4), y: (-dyWorldMath).toFixed(4) } 
                      };
                  } else if (handleType) {
                      const p = newPoints[pointIdx];
                      if (handleType === 'in' && p.handleIn) newPoints[pointIdx] = { ...p, handleIn: { x: modifyExpression(p.handleIn.x, dxWorld), y: modifyExpression(p.handleIn.y, dyWorldMath) } };
                      else if (handleType === 'out' && p.handleOut) newPoints[pointIdx] = { ...p, handleOut: { x: modifyExpression(p.handleOut.x, dxWorld), y: modifyExpression(p.handleOut.y, dyWorldMath) } };
                  } else {
                      // DRAGGING THE ANCHOR POINT
                      const SNAP_DISTANCE = 10 * scaleX; // 10 pixels threshold
                      
                      // 1. Calculate the raw "unsnapped" position based on mouse movement
                      const resStart = resolvePoint(startPt, footprint, allFootprints, params);
                      const currentMouseLocalX = resStart.x + dxWorld;
                      const currentMouseLocalY = resStart.y + dyWorldMath;

                      // 2. Find if we are near any guides
                      let bestSnapId: string | undefined = undefined;
                      let closestDist = Infinity;
                      let snapVisualPos = { x: 0, y: 0 };

                      // Shape origin for global comparison
                      const sOriginX = (s.type === "line") ? 0 : evaluateExpression((startShape as any).x, params);
                      const sOriginY = (s.type === "line") ? 0 : evaluateExpression((startShape as any).y, params);

                      snapTargets.forEach(target => {
                          // Compare current point world pos to guide world pos
                          const pWorldX = sOriginX + currentMouseLocalX;
                          const pWorldY = -(sOriginY + currentMouseLocalY); // Visual Y
                          
                          const d = Math.sqrt((pWorldX - target.x)**2 + (pWorldY - target.y)**2);
                          if (d < SNAP_DISTANCE && d < closestDist) {
                              closestDist = d;
                              bestSnapId = target.pathId;
                              snapVisualPos = { x: target.x, y: target.y };
                          }
                      });

                      if (bestSnapId) {
                          // CASE: SNAP TO GUIDE
                          newPoints[pointIdx] = { ...startPt, snapTo: bestSnapId };
                          setSnapPreview({ targetId: bestSnapId, x: snapVisualPos.x, y: snapVisualPos.y });
                      } else {
                          // CASE: FREE DRAG (or Unsnap)
                          newPoints[pointIdx] = { 
                              ...startPt, 
                              snapTo: undefined, 
                              x: currentMouseLocalX.toFixed(4), 
                              y: currentMouseLocalY.toFixed(4) 
                          };
                          setSnapPreview(null);
                      }
                  }
                  return { ...s, points: newPoints } as any;
              }
              if (s.type === "line" || s.type === "boardOutline" || s.type === "polygon") {
                  return { ...s, points: (startShape as any).points.map((p: any) => ({ ...p, x: modifyExpression(p.x, dxWorld), y: modifyExpression(p.y, dyWorldMath) })) };
              } 
              return { ...s, x: modifyExpression(startShape.x, dxWorld), y: modifyExpression(startShape.y, dyWorldMath) };
          }
          return s;
      });
      
      // FIX: Update history directly using the cached selection ref to ensure we don't revert selection
      updateHistory({
          footprint: { ...currentFP, shapes: updatedShapes },
          selectedShapeIds: dragSelectionRef.current
      });
  };

  const handleShapeMouseUp = (e: MouseEvent) => {
      isShapeDragging.current = false;
      setSnapPreview(null); // Clear visuals
      
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
    
    // Check Shapes: Filter preserves the internal Z-order from footprint.shapes
    const selectedShapes = footprint.shapes.filter(s => selectedShapeIds.includes(s.id));
    if (selectedShapes.length > 0) {
        GLOBAL_CLIPBOARD = { 
            type: "shapes", 
            sourceFootprintId: footprint.id, // Store source context
            data: JSON.parse(JSON.stringify(selectedShapes)) 
        };
        return;
    }

    // Check Meshes
    if (footprint.meshes) {
        const selectedMeshes = footprint.meshes.filter(m => selectedShapeIds.includes(m.id));
        if (selectedMeshes.length > 0) {
            GLOBAL_CLIPBOARD = { 
                type: "meshes", 
                sourceFootprintId: footprint.id, // Store source context
                data: JSON.parse(JSON.stringify(selectedMeshes)) 
            };
            return;
        }
    }
  }, [selectedShapeIds, footprint]);

  const handlePaste = useCallback(() => {
    if (!GLOBAL_CLIPBOARD) return;
    const { type, data, sourceFootprintId } = GLOBAL_CLIPBOARD;

    if (!Array.isArray(data)) return;

    const newItems: any[] = [];
    const newIds: string[] = [];

    // Setup name collision detection against existing items
    const existingNames = new Set([
        ...footprint.shapes.map(s => s.name),
        ...(footprint.meshes || []).map(m => m.name)
    ]);

    data.forEach(item => {
        // 1. Clone Data
        const newItem = JSON.parse(JSON.stringify(item));
        
        // 2. Assign New ID
        newItem.id = crypto.randomUUID();
        newIds.push(newItem.id);

        // 3. Regenerate Sub-IDs (Points)
        if (newItem.points && Array.isArray(newItem.points)) {
            newItem.points = newItem.points.map((p: any) => ({
                ...p,
                id: crypto.randomUUID()
            }));
        }

        // 4. Regenerate Union Child IDs (Deep copy safety)
        if (newItem.type === "union" && Array.isArray(newItem.shapes)) {
             newItem.shapes = newItem.shapes.map((child: any) => {
                 const newChild = { ...child, id: crypto.randomUUID() };
                 if (newChild.points && Array.isArray(newChild.points)) {
                     newChild.points = newChild.points.map((p: any) => ({ ...p, id: crypto.randomUUID() }));
                 }
                 return newChild;
             });
        }

        // 5. Generate Unique Name
        let baseName = newItem.name;
        // Strip trailing increment if exists: "Shape (1)" -> "Shape"
        const match = baseName.match(/^(.*) \(\d+\)$/);
        if (match) baseName = match[1];

        let newName = baseName;
        let counter = 1;
        while (existingNames.has(newName)) {
            newName = `${baseName} (${counter})`;
            counter++;
        }
        newItem.name = newName;
        existingNames.add(newName); // Add to set so next item in loop doesn't take same name

        newItems.push(newItem);
    });

    // 2. CALCULATE INSERTION INDEX
    let insertionIndex = 0; // Default: top of the list
    
    if (sourceFootprintId === footprint.id) {
        // Find the index of the "highest" (first in array) original item 
        // that still exists in the footprint
        const sourceIds = data.map((d: any) => d.id);
        const foundIndex = (type === "shapes" ? footprint.shapes : (footprint.meshes || []))
            .findIndex(item => sourceIds.includes(item.id));
        
        if (foundIndex !== -1) {
            insertionIndex = foundIndex;
        }
    }

    // 3. Insert into the array at the calculated index
    if (type === "shapes") {
        const nextShapes = [...footprint.shapes];
        nextShapes.splice(insertionIndex, 0, ...newItems);
        updateHistory({ 
            footprint: { ...footprint, shapes: nextShapes }, 
            selectedShapeIds: newIds 
        });
    } else if (type === "meshes") {
        const nextMeshes = [...(footprint.meshes || [])];
        nextMeshes.splice(insertionIndex, 0, ...newItems);
        updateHistory({ 
            footprint: { ...footprint, meshes: nextMeshes }, 
            selectedShapeIds: newIds 
        });
    }
  }, [footprint, updateHistory]);

  const handleDuplicate = useCallback(() => {
    if (selectedShapeIds.length > 0) {
        handleCopy();
        handlePaste();
    }
  }, [selectedShapeIds, handleCopy, handlePaste]);

  // --- UNION / UNGROUP LOGIC ---

const handleGroup = () => {
    // 1. Identify which selected shapes are valid for unioning (primitives and other unions)
    const selectedShapes = footprint.shapes.filter(s => selectedShapeIds.includes(s.id));
    const unionableShapes = selectedShapes.filter(s => s.type !== "footprint" && s.type !== "wireGuide");
    
    // We only proceed if there are at least 2 primitives/unions to join
    if (unionableShapes.length < 2) return;

    // Track which specific IDs will be removed (only the ones going into the union)
    const consumedIds = unionableShapes.map(s => s.id);

    const flattenedPrimitives: FootprintShape[] = [];
    
    // Determine Layer Assignment Source from unionable shapes only
    let assignmentSource: FootprintShape | null = null;
    let maxUnionArea = -1;
    const selectedUnions = unionableShapes.filter(s => s.type === "union") as FootprintUnion[];

    if (selectedUnions.length > 0) {
        selectedUnions.forEach(u => {
            const aabb = getShapeAABB(u, params, footprint, allFootprints);
            if (aabb) {
                const area = Math.abs((aabb.x2 - aabb.x1) * (aabb.y2 - aabb.y1));
                if (area > maxUnionArea) {
                    maxUnionArea = area;
                    assignmentSource = u;
                }
            }
        });
    }
    if (!assignmentSource) assignmentSource = unionableShapes[0];

    const inheritedAssignments = assignmentSource ? JSON.parse(JSON.stringify(assignmentSource.assignedLayers)) : {};

    // 2. Flatten only the unionable shapes
    unionableShapes.forEach(shape => {
        if (shape.type === "union") {
            // "Ungroup" logic to find child positions in current footprint space
            const u = shape as FootprintUnion;
            const ux = evaluateExpression(u.x, params);
            const uy = evaluateExpression(u.y, params);
            const uAngle = evaluateExpression(u.angle, params);
            const rad = uAngle * (Math.PI / 180);
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);

            u.shapes.forEach(s => {
                // Skip recursive items nested inside existing unions
                if (s.type === "footprint" || s.type === "wireGuide") return;

                const lx = evaluateExpression((s as any).x || "0", params);
                const ly = evaluateExpression((s as any).y || "0", params);
                
                // Calculate absolute position in the context of the footprint
                const gx = ux + (lx * cos - ly * sin);
                const gy = uy + (lx * sin + ly * cos);

                const newS: any = { 
                    ...JSON.parse(JSON.stringify(s)), 
                    id: crypto.randomUUID(),
                    x: gx.toFixed(4).toString(), 
                    y: gy.toFixed(4).toString() 
                };

                if (s.type === "rect" || s.type === "union") {
                    const sa = evaluateExpression((s as any).angle, params);
                    newS.angle = (sa + uAngle).toFixed(4).toString();
                }

                if (s.type === "line" || s.type === "polygon" || s.type === "boardOutline") {
                    // For points, we bake the union's translation/rotation into the points directly
                    const pts = (s as any).points.map((p: any) => {
                        const lpx = evaluateExpression(p.x, params);
                        const lpy = evaluateExpression(p.y, params);
                        
                        // Point logic:
                        // 1. Local Point (lpx) is relative to Shape Origin (lx).
                        // 2. We need Global Point Position.
                        // 3. Shape Origin (lx) rotates around Union Origin (0,0) -> (rlx, rly)
                        // 4. Point (lpx) rotates around Shape Origin? No, usually points rotate with shape.
                        //    So Point vector relative to Union Origin is (lx + lpx).
                        
                        const absLx = lx + lpx;
                        const absLy = ly + lpy;
                        
                        // Rotate entire vector around Union Center
                        const rpx = absLx * cos - absLy * sin;
                        const rpy = absLx * sin + absLy * cos;
                        
                        // Translate to Global
                        const gpx = ux + rpx;
                        const gpy = uy + rpy;

                        const rotHandle = (h?: {x:string, y:string}) => {
                            if (!h) return undefined;
                            const hx = evaluateExpression(h.x, params);
                            const hy = evaluateExpression(h.y, params);
                            return {
                                x: (hx * cos - hy * sin).toFixed(4).toString(),
                                y: (hx * sin + hy * cos).toFixed(4).toString()
                            };
                        };

                        return {
                            ...p,
                            id: crypto.randomUUID(),
                            x: gpx.toFixed(4).toString(),
                            y: gpy.toFixed(4).toString(),
                            handleIn: rotHandle(p.handleIn),
                            handleOut: rotHandle(p.handleOut)
                        };
                    });
                    newS.points = pts;
                    
                    // FIXED: Reset Origin to 0,0 for all point-based shapes
                    // Since 'pts' are now Global coordinates, adding 'x/y' (which are also global gx/gy) 
                    // would double-apply the translation.
                    newS.x = "0"; 
                    newS.y = "0"; 
                }
                flattenedPrimitives.push(newS);
            });
        } else {
            flattenedPrimitives.push(JSON.parse(JSON.stringify(shape)));
        }
    });
    
    // 2. Calculate Centroid of the pool
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    flattenedPrimitives.forEach(s => {
        const aabb = getShapeAABB(s, params, footprint, allFootprints);
        if (aabb) {
            minX = Math.min(minX, aabb.x1, aabb.x2); maxX = Math.max(maxX, aabb.x1, aabb.x2);
            minY = Math.min(minY, aabb.y1, aabb.y2); maxY = Math.max(maxY, aabb.y1, aabb.y2);
        }
    });
    
    if (minX === Infinity) return;
    
    const cx = (minX + maxX) / 2;
    const cy = -((minY + maxY) / 2);
    
    // 3. Create the new single-level Union Shape
    const unionId = crypto.randomUUID();
    const newUnion: FootprintUnion = {
        id: unionId,
        type: "union",
        name: "Union Group",
        x: cx.toFixed(4).toString(),
        y: cy.toFixed(4).toString(),
        angle: "0",
        assignedLayers: inheritedAssignments,
        shapes: flattenedPrimitives.map(s => {
            const dx = -cx;
            const dy = -cy;
            if (s.type === "line" || s.type === "polygon" || s.type === "boardOutline") {
                const pts = (s as any).points.map((p: any) => ({
                    ...p, x: modifyExpression(p.x, dx), y: modifyExpression(p.y, dy)
                }));
                return { ...s, points: pts };
            }
            return { ...s, x: modifyExpression((s as any).x, dx), y: modifyExpression((s as any).y, dy) };
        })
    };

    // 3. Update Footprint: Only remove consumed IDs. Footprints/Guides stay.
    const remainingShapes = footprint.shapes.filter(s => !consumedIds.includes(s.id));
    updateHistory({
        footprint: { ...footprint, shapes: [newUnion, ...remainingShapes] },
        selectedShapeIds: [unionId]
    });
};

const handleUngroup = (unionId: string) => {
    const unionShape = footprint.shapes.find(s => s.id === unionId);
    if (!unionShape || unionShape.type !== "union") return;
    const union = unionShape as FootprintUnion;

    const ux = evaluateExpression(union.x, params);
    const uy = evaluateExpression(union.y, params);
    const uAngle = evaluateExpression(union.angle, params);

    // Transform logic: apply union's translation and rotation back to individual shapes
    const rad = uAngle * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const restoredShapes = union.shapes.map(s => {
        const lx = evaluateExpression((s as any).x || "0", params);
        const ly = evaluateExpression((s as any).y || "0", params);
        
        // Frame translation & rotation for Shape Origin
        const gx = ux + (lx * cos - ly * sin);
        const gy = uy + (lx * sin + ly * cos);
        
        // Base restoration object
        let newS: any = { 
            ...s, 
            id: crypto.randomUUID(), // New ID
            x: parseFloat(gx.toFixed(4)).toString(), 
            y: parseFloat(gy.toFixed(4)).toString(),
            assignedLayers: JSON.parse(JSON.stringify(union.assignedLayers)) // UPDATED: Inherit from parent
        };
        
        if (s.type === "rect" || s.type === "footprint" || s.type === "union") {
            const sa = evaluateExpression((s as any).angle, params);
            newS.angle = parseFloat((sa + uAngle).toFixed(4)).toString();
        }

        if (s.type === "line" || s.type === "polygon" || s.type === "boardOutline") {
            // Lines/Polys rely on point coordinates. Bake rotation/translation into points.
            // Note: s.x/s.y might be non-zero inside the Union (though we zero them in Group, manually created unions might vary).
            // We use 'lx, ly' as the Local Origin.
            
            const pts = (s as any).points.map((p: any) => {
                const lpx = evaluateExpression(p.x, params);
                const lpy = evaluateExpression(p.y, params);
                
                // Point location is relative to shape origin (lx, ly)
                // We rotate the vector (lx+lpx, ly+lpy)
                // Wait, if s.type is Polygon, lpx is relative to lx.
                // If we calculated 'gx' as the new origin, we only need to rotate 'lpx'.
                // BUT, rotating lpx alone assumes origin rotation matches point rotation.
                // Correct logic:
                // GlobalPoint = UnionTx * (ShapeTx * Point)
                // ShapeTx * Point = (lx + lpx, ly + lpy)
                // UnionTx(v) = ux + Rotate(v)
                
                // If we want newS.x = gx, and newS.points = p':
                // Visual = gx + p'
                // ux + Rotate(lx) + p' = ux + Rotate(lx + lpx)
                // p' = Rotate(lx + lpx) - Rotate(lx)
                // p' = Rotate(lpx)
                
                // So yes, simply rotating the point vector is sufficient IF we preserve gx as origin.
                
                // Rotate point around local (0,0) by uAngle
                const rpx = lpx * cos - lpy * sin;
                const rpy = lpx * sin + lpy * cos;

                // ROTATE HANDLES
                const rotHandle = (h?: {x:string, y:string}) => {
                    if (!h) return undefined;
                    const hx = evaluateExpression(h.x, params);
                    const hy = evaluateExpression(h.y, params);
                    // Standard vector rotation
                    const rhx = hx * cos - hy * sin;
                    const rhy = hx * sin + hy * cos;
                    return {
                        x: parseFloat(rhx.toFixed(4)).toString(),
                        y: parseFloat(rhy.toFixed(4)).toString()
                    };
                };

                return {
                    ...p,
                    id: crypto.randomUUID(),
                    x: parseFloat(rpx.toFixed(4)).toString(),
                    y: parseFloat(rpy.toFixed(4)).toString(),
                    handleIn: rotHandle(p.handleIn),
                    handleOut: rotHandle(p.handleOut)
                };
            });
            newS.points = pts;
            
            // For Lines, we typically enforce 0,0 origin to keep points absolute
            if (s.type === "line") {
                // If it was a line, 'lx'/'ly' were likely 0. 
                // But if they weren't, we should bake the origin shift into the points too?
                // Actually, logic above sets newS.x = gx.
                // If we want line to be 0,0:
                // newS.x = 0;
                // newS.points = gx + p'
                
                // Let's standardise lines to 0,0 absolute.
                const ptsAbsolute = pts.map((p: any) => ({
                    ...p,
                    x: (evaluateExpression(p.x, params) + gx).toFixed(4),
                    y: (evaluateExpression(p.y, params) + gy).toFixed(4)
                }));
                newS.points = ptsAbsolute;
                newS.x = "0";
                newS.y = "0";
            }
        }

        return newS as FootprintShape;
    });

    const others = footprint.shapes.filter(s => s.id !== unionId);
    updateHistory({
        footprint: { ...footprint, shapes: [...restoredShapes, ...others] },
        selectedShapeIds: restoredShapes.map(s => s.id)
    });
  };
  
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

    updateHistory({ footprint: { ...footprintRef.current, shapes: newShapes, boardOutlineAssignments: newAssignments }, selectedShapeIds: selectedShapeIds.filter(x => x !== shapeId) });
  }, [editorState, updateHistory]);

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
          footprint: { 
              ...footprintRef.current, 
              shapes: newShapes, 
              boardOutlineAssignments: newAssignments 
          }, 
          selectedShapeIds: [newShape.id] 
      });
  }, [editorState, updateHistory]);

  const deleteMesh = useCallback((meshId: string) => {
      updateHistory({ footprint: { ...footprintRef.current, meshes: (footprintRef.current.meshes || []).filter(m => m.id !== meshId) }, selectedShapeIds: selectedShapeIds.filter(x => x !== meshId) });
  }, [editorState, updateHistory]);

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
        if (isCtrl && e.key.toLowerCase() === 'g') {
            e.preventDefault();
            handleGroup();
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
  }, [handleCopy, handlePaste, handleDuplicate, editorState, deleteShape, deleteMesh, undo, redo, canUndo, canRedo, handleGroup]);

  // --- ACTIONS ---
  const addShape = (type: "circle" | "rect" | "line" | "footprint" | "wireGuide" | "boardOutline" | "polygon" | "text", footprintId?: string) => {
    // Calculate the current center of the viewport in Math Space
    const centerMathX = (viewBox.x + viewBox.width / 2).toFixed(2);
    const centerMathY = (-(viewBox.y + viewBox.height / 2)).toFixed(2);

    const base = { id: crypto.randomUUID(), name: `New ${type}`, assignedLayers: {}, };
    let newShape: FootprintShape;

    if (type === "footprint" && footprintId) {
         // Create Recursive Reference
         const targetFp = allFootprints.find(f => f.id === footprintId);
         newShape = {
             ...base,
             type: "footprint",
             x: centerMathX, y: centerMathY, angle: "0",
             footprintId,
             name: targetFp?.name || "Ref"
         } as FootprintReference;
    } else if (type === "circle") {
      newShape = { ...base, type: "circle", x: centerMathX, y: centerMathY, diameter: "10" };
    } else if (type === "text") {
        newShape = { 
            ...base, 
            type: "text", 
            x: centerMathX, y: centerMathY, angle: "0", 
            text: "New Comment", 
            fontSize: "5", 
            anchor: "start" 
        } as FootprintText;
    } else if (type === "rect") {
      newShape = { ...base, type: "rect", x: centerMathX, y: centerMathY, width: "10", height: "10", angle: "0", cornerRadius: "0" };
    } else if (type === "wireGuide") {
      newShape = { ...base, type: "wireGuide", x: centerMathX, y: centerMathY, name: "Wire Guide" } as FootprintWireGuide;
    } else if (type === "boardOutline") {
      newShape = { ...base, type: "boardOutline", x: centerMathX, y: centerMathY, name: "Board Outline", points: [{ id: crypto.randomUUID(), x: "-10", y: "-10" }, { id: crypto.randomUUID(), x: "10", y: "-10" }, { id: crypto.randomUUID(), x: "10", y: "10" }, { id: crypto.randomUUID(), x: "-10", y: "10" }] } as FootprintBoardOutline;
    } else if (type === "polygon") {
      newShape = { ...base, type: "polygon", x: centerMathX, y: centerMathY, name: "Polygon", points: [{ id: crypto.randomUUID(), x: "0", y: "10" }, { id: crypto.randomUUID(), x: "10", y: "-10" }, { id: crypto.randomUUID(), x: "-10", y: "-10" }] } as FootprintPolygon;
    } else {
      newShape = { ...base, type: "line", thickness: "1", x: "0", y: "0", points: [{ id: crypto.randomUUID(), x: centerMathX, y: centerMathY }, { id: crypto.randomUUID(), x: (parseFloat(centerMathX) + 10).toString(), y: (parseFloat(centerMathY) + 10).toString() }] };
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

    updateHistory({ footprint: nextFootprint, selectedShapeIds: [newShape.id] });
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
    
    setFootprint({ ...footprint, shapes: footprint.shapes.map(s => s.id === shapeId ? { ...s, points: newPoints } : s) });
  };

  const updateShape = (shapeId: string, field: string, val: any) => {
    setFootprint({ ...footprint, shapes: footprint.shapes.map((s) => s.id === shapeId ? { ...s, [field]: val } : s), });
  };
  const updateFootprintField = (field: string, val: any) => { setFootprint({ ...footprint, [field]: val }); };

  const handleReorder = (dragIndex: number, targetIndex: number) => {
    const currentShapes = [...footprint.shapes];
    const draggedShape = currentShapes[dragIndex];

    // Determine which shapes are moving
    let idsToMove: string[] = [];
    
    // If dragging a selected item, move ALL selected items
    if (selectedShapeIds.includes(draggedShape.id)) {
        // Filter out IDs that might no longer exist in shapes array for safety
        idsToMove = selectedShapeIds.filter(id => currentShapes.some(s => s.id === id));
    } else {
        // Otherwise, just move the single dragged item
        idsToMove = [draggedShape.id];
    }

    // Extract the shapes to move, preserving their relative order
    const shapesToMove = currentShapes.filter(s => idsToMove.includes(s.id));
    
    // Create the list WITHOUT the moving shapes
    const remainingShapes = currentShapes.filter(s => !idsToMove.includes(s.id));

    // Calculate insertion index
    // We need to map the targetIndex (which comes from the ORIGINAL list) 
    // to a position in the 'remainingShapes' list.
    
    let insertionIndex = 0;
    
    if (targetIndex >= currentShapes.length) {
        // Dropped at the very end
        insertionIndex = remainingShapes.length;
    } else {
        // Find the shape that was originally at targetIndex
        const targetShapeId = currentShapes[targetIndex].id;
        
        // If the target itself is being moved, we need to find the "visual" target.
        // But in standard DnD, if you drop ON a moving item, behavior is undefined/no-op.
        // If we drop on a non-moving item, we insert before it.
        
        const indexInRemaining = remainingShapes.findIndex(s => s.id === targetShapeId);
        
        if (indexInRemaining !== -1) {
            insertionIndex = indexInRemaining;
        } else {
            // If we are dropping onto a selected item (which is technically removed from remaining),
            // it usually implies no change if within the block, or complex calc.
            // Simplified: If target is part of moving group, assume we want to place 'shapesToMove' 
            // where 'dragIndex' was? No, simpler to just abort or append if confused.
            // A robust strategy: Find the nearest non-moving neighbor.
            
            // For this specific logic: strictly insert BEFORE the item currently at targetIndex,
            // UNLESS that item is also moving.
            
            // Fallback: If target index was "after" the dragged items in original list, 
            // we effectively subtract the number of moved items before it.
            let unadjustedIndex = 0;
            for(let i=0; i<targetIndex; i++) {
                if (!idsToMove.includes(currentShapes[i].id)) unadjustedIndex++;
            }
            insertionIndex = unadjustedIndex;
        }
    }

    // Insert
    remainingShapes.splice(insertionIndex, 0, ...shapesToMove);
    
    setFootprint({ ...footprint, shapes: remainingShapes });
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
                           updateHistory({ footprint: { ...footprint, meshes: [...newMeshes, ...(footprint.meshes || [])] }, selectedShapeIds: [newMeshes[newMeshes.length - 1].id] });
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
      setFootprint({ ...footprint, meshes: (footprint.meshes || []).map(m => m.id === meshId ? { ...m, [field]: val } : m) });
  };


  const updateFootprintName = (name: string) => { updateFootprintField("name", name); };
  const toggleLayerVisibility = (id: string) => { setLayerVisibility(prev => ({ ...prev, [id]: prev[id] === undefined ? false : !prev[id] })); };

    // Helper function to fit view to content
    const fitViewToContent = useCallback(() => {
        if (!wrapperRef.current) return;

        // 1. Calculate the bounding box of the CAD objects
        const totalAABB = getFootprintAABB(footprint, params, allFootprints);
        
        // 2. Get container dimensions
        const { width: containerW, height: containerH } = wrapperRef.current.getBoundingClientRect();
        if (containerW === 0 || containerH === 0) return;

        const containerAspect = containerW / containerH;

        let targetX, targetY, targetW, targetH;
        const PADDING_FACTOR = 1.2; // Add 20% padding

        if (!totalAABB) {
            // Fallback if footprint is empty
            targetW = 100;
            targetH = 100 / containerAspect;
            targetX = -targetW / 2;
            targetY = -targetH / 2;
        } else {
            const bbW = Math.abs(totalAABB.x2 - totalAABB.x1);
            const bbH = Math.abs(totalAABB.y2 - totalAABB.y1);
            const bbCenterX = (totalAABB.x1 + totalAABB.x2) / 2;
            const bbCenterY = (totalAABB.y1 + totalAABB.y2) / 2;

            // Apply padding
            const paddedW = (bbW === 0 ? 10 : bbW) * PADDING_FACTOR;
            const paddedH = (bbH === 0 ? 10 : bbH) * PADDING_FACTOR;

            // Fit the box to the container aspect ratio
            if (paddedW / paddedH > containerAspect) {
                // Box is wider than container
                targetW = paddedW;
                targetH = paddedW / containerAspect;
            } else {
                // Box is taller than container
                targetH = paddedH;
                targetW = paddedH * containerAspect;
            }

            targetX = bbCenterX - targetW / 2;
            targetY = bbCenterY - targetH / 2;
        }

        setViewBox({ x: targetX, y: targetY, width: targetW, height: targetH });
    }, [footprint, params, allFootprints]);

    // Trigger fit on first mount (2D mode)
    useEffect(() => {
        // Small delay to ensure container dimensions are calculated by the browser
        const timer = setTimeout(() => {
            fitViewToContent();
        }, 50);
        return () => clearTimeout(timer);
    }, []); // Empty dependency ensures it only runs on component mount

    // Update handleHomeClick to use the new logic
    const handleHomeClick = () => {
        if (viewMode === "2D") {
            fitViewToContent();
        } else {
            footprint3DRef.current?.resetCamera();
        }
    };

  const handleExport = async (layerId: string, format: "SVG" | "DXF" | "STL") => {
    const layer = stackup.find(l => l.id === layerId);
    if (!layer) return;

    if (format === "STL") {
        if (!footprint3DRef.current) {
            alert("Please switch to 3D View to initialize the mesh before exporting STL.");
            return;
        }
        
        setProcessingMessage("Computing High Resolution Mesh...");
        try {
            await footprint3DRef.current.ensureHighRes();
        } catch (e) {
            console.error("High res compute failed", e);
        }
        setProcessingMessage(null);
    }

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
    
    // FIX: Retrieve Origin for Board Outline (it might not be 0,0)
    const originX = outlineShape ? evaluateExpression(outlineShape.x, params) : 0;
    const originY = outlineShape ? evaluateExpression(outlineShape.y, params) : 0;

    const outline = (outlineShape?.points || []).map(p => {
        const resolved = resolvePoint(p, footprint, allFootprints, params);
        return {
            x: resolved.x + originX,
            y: resolved.y + originY,
            handle_in: resolved.handleIn,
            handle_out: resolved.handleOut
        };
    });

    const shapes = await collectExportShapesAsync(
        footprint, 
        footprint.shapes, 
        allFootprints,
        params,
        layer,
        layerThickness,
        footprint3DRef.current // Pass view ref to access worker
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

  // NEW: Scaling factors for SVG elements to prevent scaling issues on zoom
  const strokeScale = viewBox.width / 800;
  const handleRadius = viewBox.width / 100;

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

  // Jump into footprint handler for double-clicks
  const handleShapeDoubleClick = (e: React.MouseEvent, id: string) => {
      e.stopPropagation(); e.preventDefault();
      const shape = footprint.shapes.find(s => s.id === id);
      if (shape && shape.type === "footprint") {
          onEditChild((shape as FootprintReference).footprintId);
      }
  };

    const handleBoardToggle = (checked: boolean) => {
        // 1. Start with the updated flag
        let nextFootprint = { ...footprint, isBoard: checked };
        let nextSelection = [...selectedShapeIds];

        // 2. If we are turning it ON and no outline exists, create one manually 
        // instead of calling addShape (which would trigger a second history push)
        if (checked) {
            const hasOutline = footprint.shapes.some(s => s.type === "boardOutline");
            if (!hasOutline) {
                const centerMathX = (viewBox.x + viewBox.width / 2).toFixed(2);
                const centerMathY = (-(viewBox.y + viewBox.height / 2)).toFixed(2);
                
                const newOutline: FootprintBoardOutline = {
                    id: crypto.randomUUID(),
                    type: "boardOutline",
                    name: "Board Outline",
                    x: centerMathX,
                    y: centerMathY,
                    assignedLayers: {},
                    points: [
                        { id: crypto.randomUUID(), x: "-50", y: "-50" },
                        { id: crypto.randomUUID(), x: "50", y: "-50" },
                        { id: crypto.randomUUID(), x: "50", y: "50" },
                        { id: crypto.randomUUID(), x: "-50", y: "50" }
                    ]
                };

                // Add the shape to our temporary object
                nextFootprint.shapes = [newOutline, ...nextFootprint.shapes];
                
                // Auto-assign to all layers
                const assignments = { ...footprint.boardOutlineAssignments };
                stackup.forEach(l => {
                    assignments[l.id] = newOutline.id;
                });
                nextFootprint.boardOutlineAssignments = assignments;

                // Select the new outline immediately
                nextSelection = [newOutline.id];
            }
        }

        // 3. Push a single unified update to history
        updateHistory({ 
            footprint: nextFootprint, 
            selectedShapeIds: nextSelection 
        });
    };

  const handleSelection = (id: string, multi: boolean) => {
      if (multi) {
          setSelectedShapeIds(selectedShapeIds.includes(id) ? selectedShapeIds.filter(x => x !== id) : [...selectedShapeIds, id]);
      } else {
          setSelectedShapeIds([id]);
      }
  };

  const handleBatchUpdate = (updates: {id: string, field: string, value: any}[]) => {
      const updateMap = new Map<string, any>();
      updates.forEach(u => {
          if(!updateMap.has(u.id)) updateMap.set(u.id, {});
          const record = updateMap.get(u.id);
          record[u.field] = u.value;
      });

      const newShapes = footprint.shapes.map(s => {
          if (updateMap.has(s.id)) {
              return { ...s, ...updateMap.get(s.id) };
          }
          return s;
      });
      
      updateHistory({ 
          footprint: { ...footprint, shapes: newShapes }, 
          selectedShapeIds: selectedShapeIds 
      });
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
        <button onClick={() => addShape("text")}><IconText /> Comment</button>
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
                onReorder={handleReorder}
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
                        <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth={strokeScale} vectorEffect="non-scaling-stroke" />
                    </pattern>
                    </defs>
                    <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#grid)" />
                    <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth={strokeScale * 2} vectorEffect="non-scaling-stroke" />
                    <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth={strokeScale * 2} vectorEffect="non-scaling-stroke" />
                    
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
                                parentTransform={{ x: 0, y: 0, angle: 0 }}
                                layerVisibility={layerVisibility}
                                hoveredPointIndex={hoveredPointIndex}
                                setHoveredPointIndex={setHoveredPointIndex}
                                hoveredMidpointIndex={hoveredMidpointIndex}
                                setHoveredMidpointIndex={setHoveredMidpointIndex}
                                onAddMidpoint={handleAddMidpoint}
                                strokeScale={strokeScale}
                                hoveredTieDownId={hoveredTieDownId}
                                setHoveredTieDownId={setHoveredTieDownId}
                                onTieDownMouseDown={handleTieDownMouseDown}
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
                                    parentTransform={{ x: 0, y: 0, angle: 0 }}
                                    layerVisibility={layerVisibility}
                                    hoveredPointIndex={hoveredPointIndex}
                                    setHoveredPointIndex={setHoveredPointIndex}
                                    hoveredMidpointIndex={hoveredMidpointIndex}
                                    setHoveredMidpointIndex={setHoveredMidpointIndex}
                                    onAddMidpoint={handleAddMidpoint}
                                    onlyHandles={true}
                                    strokeScale={strokeScale}
                                />
                            );
                        }
                        return null;
                    })}

                    {/* Rotation Guide Line */}
                    {rotationGuide && (
                        <g pointerEvents="none">
                            <line 
                                x1={rotationGuide.center.x} y1={rotationGuide.center.y}
                                x2={rotationGuide.current.x} y2={rotationGuide.current.y}
                                stroke="#646cff"
                                strokeWidth={1}
                                strokeDasharray="4,4"
                                vectorEffect="non-scaling-stroke"
                            />
                            {/* Centroid Pivot */}
                            <circle 
                                cx={rotationGuide.center.x} cy={rotationGuide.center.y}
                                r={handleRadius}
                                fill="#646cff"
                                vectorEffect="non-scaling-stroke"
                            />
                        </g>
                    )}

                    {/* NEW: Snap Preview Highlight */}
                    {snapPreview && (
                        <g pointerEvents="none">
                            <circle 
                                cx={snapPreview.x} 
                                cy={snapPreview.y} 
                                r={handleRadius * 1.5} 
                                fill="none" 
                                stroke="#00ff00" 
                                strokeWidth={2} 
                                strokeDasharray="2,2"
                                vectorEffect="non-scaling-stroke"
                            />
                            <circle 
                                cx={snapPreview.x} 
                                cy={snapPreview.y} 
                                r={handleRadius * 0.5} 
                                fill="#00ff00" 
                                vectorEffect="non-scaling-stroke"
                            />
                        </g>
                    )}

                    {/* NEW: Tie Down Visual Guides */}
                    {tieDownVisuals && (
                        <g pointerEvents="none">
                            <line 
                                x1={tieDownVisuals.lineStart.x} y1={-tieDownVisuals.lineStart.y} 
                                x2={tieDownVisuals.lineEnd.x} y2={-tieDownVisuals.lineEnd.y} 
                                stroke="#646cff" 
                                strokeWidth={1.5} 
                                strokeDasharray="4,2" 
                                vectorEffect="non-scaling-stroke"
                            />
                            {tieDownVisuals.type === 'slide' && (
                                <circle 
                                    cx={tieDownVisuals.lineEnd.x} cy={-tieDownVisuals.lineEnd.y} 
                                    r={handleRadius * 0.6} 
                                    fill="#646cff" 
                                    vectorEffect="non-scaling-stroke" 
                                />
                            )}
                        </g>
                    )}

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
                <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Left Drag: Select | Alt + Drag: Rotate | Right/Middle Drag: Pan | Scroll: Zoom</div>
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
          {selectedShapeIds.length > 0 || activeMesh ? (
            <>
              <FootprintPropertiesPanel 
                footprint={footprint}
                allFootprints={allFootprints}
                selectedId={primarySelectedId}
                selectedShapeIds={selectedShapeIds}
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
                onGroup={handleGroup}
                onUngroup={handleUngroup}
                onBatchUpdate={handleBatchUpdate}
                hoveredTieDownId={hoveredTieDownId}
                setHoveredTieDownId={setHoveredTieDownId}
                scrollToTieDownId={scrollToTieDownId}
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
async function collectExportShapesAsync(
    contextFootprint: Footprint, 
    shapes: FootprintShape[],
    allFootprints: Footprint[],
    params: Parameter[],
    layer: StackupLayer,
    layerThickness: number,
    viewRef: Footprint3DViewHandle | null,
    transform = { x: 0, y: 0, angle: 0 },
    forceInclude = false
): Promise<any[]> {
    let result: any[] = [];

    // Process shapes. Reverse to match visual order in export list if needed (though CSG doesn't care much for cut)
    const reversedShapes = [...shapes].reverse();

    for (const shape of reversedShapes) {
        // SKIP WIRE GUIDES (Virtual) & BOARD OUTLINES
        if (shape.type === "wireGuide" || shape.type === "boardOutline") continue;

        // 1. Calculate Local Transform
        // FIX: Force Line origin to 0,0. The 2D renderer uses absolute points for lines.
        const lx = (shape.type === "line") ? 0 : evaluateExpression(shape.x, params);
        const ly = (shape.type === "line") ? 0 : evaluateExpression(shape.y, params);
        
        // Global Position
        const rad = (transform.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        // Global Origin of the current shape (Parent Origin + Rotated Local Offset)
        const gx = transform.x + (lx * cos - ly * sin);
        const gy = transform.y + (lx * sin + ly * cos);

        if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const target = allFootprints.find(f => f.id === ref.footprintId);
             if (target) {
                 const localAngle = evaluateExpression(ref.angle, params);
                 const globalAngle = transform.angle + localAngle;
                 
                 const children = await collectExportShapesAsync(
                     target, // Switch context to the referenced footprint
                     target.shapes,
                     allFootprints,
                     params,
                     layer,
                     layerThickness,
                     viewRef,
                     { x: gx, y: gy, angle: globalAngle },
                     forceInclude // Pass down forceInclude
                 );
                 result = result.concat(children);
             }
        } else if (shape.type === "union") {
             const u = shape as FootprintUnion;
             const assigned = u.assignedLayers?.[layer.id];
             let overrideDepth = -1;
             let overrideRadius = 0;
             let effectiveDepth = 0;
             
             if (assigned) {
                 if (layer.type === "Cut") {
                     overrideDepth = layerThickness;
                 } else {
                     const val = evaluateExpression(typeof assigned === 'object' ? assigned.depth : assigned, params);
                     overrideDepth = Math.max(0, val);
                     effectiveDepth = overrideDepth;
                     if (typeof assigned === 'object') {
                         overrideRadius = evaluateExpression(assigned.endmillRadius, params);
                     }
                 }
             }

             // --- NEW: SPECIAL HANDLING FOR GRADIENT UNIONS (Carved/Printed with Radius) ---
             if (layer.type === "Carved/Printed" && overrideRadius > 0 && viewRef) {
                 // Union -> Polygon -> Slice
                 // We call the Worker to get the Union Outline
                 const contourPoints = await viewRef.computeUnionOutline(
                     u.shapes, params, contextFootprint, allFootprints, { x: gx, y: gy, rotation: transform.angle + evaluateExpression(u.angle, params) }
                 );

                 // Use manual slice logic for each returned contour
                 const sliceResult = slicePolygonContours(contourPoints, effectiveDepth, overrideRadius, 0, 0, 0); // x,y,rot already applied in worker results (0 offset)
                 result = result.concat(sliceResult);

             } else {
                 // Standard Recursion (Flatten)
                 const uAngle = evaluateExpression(u.angle, params);
                 const globalAngle = transform.angle + uAngle;
                 
                 // FIX: Pass down forceInclude logic if THIS union is assigned
                 const shouldForceChildren = forceInclude || !!assigned;

                 const childrenExport = await collectExportShapesAsync(
                     contextFootprint,
                     u.shapes,
                     allFootprints,
                     params,
                     layer,
                     layerThickness,
                     viewRef,
                     { x: gx, y: gy, angle: globalAngle },
                     shouldForceChildren
                 );

                 if (overrideDepth >= 0) {
                     childrenExport.forEach(child => {
                         child.depth = overrideDepth;
                         if (overrideRadius > 0) child.endmill_radius = overrideRadius;
                     });
                 }
                 result = result.concat(childrenExport);
             }

        } else {
             // Check assignment
             // FIX: If forceInclude is true, we proceed even if assignment is missing
             const explicitAssignment = shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined;
             
             if (!forceInclude && !explicitAssignment) continue;
             
             // Calculate Depth
             let depth = 0;
             let endmillRadius = 0;
             
             if (explicitAssignment) {
                 if (layer.type === "Cut") {
                     depth = layerThickness;
                 } else {
                     const assign = shape.assignedLayers![layer.id];
                     const val = evaluateExpression(typeof assign === 'object' ? assign.depth : assign, params);
                     depth = Math.max(0, val);
                     if (typeof assign === 'object') {
                         endmillRadius = evaluateExpression(assign.endmillRadius, params);
                     }
                 }
             } else {
                 // Default values if forced by parent (will likely be overwritten by parent overrideDepth)
                 if (layer.type === "Cut") depth = layerThickness;
                 else depth = 0; 
             }

             // If not forced and depth is zero, skip
             if (!forceInclude && depth <= 0.0001) continue;

             // Prepare Export Object
             // Note: x/y here is the Shape's global origin (gx, gy).
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
                const lineShape = shape as FootprintLine;
                exportObj.thickness = evaluateExpression(lineShape.thickness, params);
                
                // NEW: Export Tie Downs
                if (lineShape.tieDowns) {
                    for (const td of lineShape.tieDowns) {
                        const target = allFootprints.find(f => f.id === td.footprintId);
                        if (target) {
                            const dist = evaluateExpression(td.distance, params);
                            const rotOffset = evaluateExpression(td.angle, params);
                            
                            const tf = getTransformAlongLine(lineShape, dist, params, contextFootprint, allFootprints);
                            if (tf) {
                                const rx = tf.x * cos - tf.y * sin;
                                const ry = tf.x * sin + tf.y * cos;
                                
                                const tdGx = gx + rx;
                                const tdGy = gy + ry;
                                const tdAngle = transform.angle + (tf.angle - 90 + rotOffset);
                                
                                const children = await collectExportShapesAsync(
                                    target, target.shapes, allFootprints, params, layer, layerThickness, viewRef,
                                    { x: tdGx, y: tdGy, angle: tdAngle }, forceInclude
                                );
                                result = result.concat(children);
                            }
                        }
                    }
                }

                exportObj.points = lineShape.points.map(p => {
                    const resolved = resolvePoint(p, contextFootprint, allFootprints, params, transform);
                    
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

                    if (p.snapTo) {
                        return {
                            x: transform.x + rx,
                            y: transform.y + ry,
                            handle_in: rotateVec(resolved.handleIn),
                            handle_out: rotateVec(resolved.handleOut)
                        };
                    } else {
                        return {
                            x: gx + rx,
                            y: gy + ry,
                            handle_in: rotateVec(resolved.handleIn),
                            handle_out: rotateVec(resolved.handleOut)
                        };
                    }
                });
                result.push(exportObj);
            } else if (shape.type === "polygon") {
                const poly = shape as FootprintPolygon;
                
                // If it's a simple cut or flat carve, just send the definition
                if (endmillRadius <= 0.001 || layer.type === "Cut") {
                    exportObj.shape_type = "polygon";
                    exportObj.points = poly.points.map(p => {
                        const resolved = resolvePoint(p, contextFootprint, allFootprints, params, transform);
                        const rad = (transform.angle * Math.PI) / 180;
                        const cos = Math.cos(rad);
                        const sin = Math.sin(rad);
                        const rx = resolved.x * cos - resolved.y * sin;
                        const ry = resolved.x * sin + resolved.y * cos;
                        const rotateVec = (v?: {x: number, y: number}) => v ? {
                            x: v.x * cos - v.y * sin,
                            y: v.x * sin + v.y * cos
                        } : undefined;
                        
                        if (p.snapTo) {
                            return {
                                x: transform.x + rx,
                                y: transform.y + ry,
                                handle_in: rotateVec(resolved.handleIn),
                                handle_out: rotateVec(resolved.handleOut)
                            };
                        } else {
                            return {
                                x: gx + rx,
                                y: gy + ry,
                                handle_in: rotateVec(resolved.handleIn),
                                handle_out: rotateVec(resolved.handleOut)
                            };
                        }
                    });
                    result.push(exportObj);
                } else {
                    // Complex Carve: Pre-calculate slices in JS
                    const basePoints = getPolyOutlinePoints(poly.points, 0, 0, params, contextFootprint, allFootprints, 32, transform, { x: lx, y: ly });
                    
                    // Transform basePoints to Global Export Frame (gx, gy, angle)
                    // getPolyOutlinePoints returns local (relative to shape origin).
                    // We need to apply rotation manually since getPolyOutlinePoints doesn't do it.
                    // And add gx/gy.
                    
                    const globalRad = (transform.angle * Math.PI) / 180;
                    const gCos = Math.cos(globalRad);
                    const gSin = Math.sin(globalRad);

                    const globalBasePoints = basePoints.map(p => ({
                        // This block was already using gx/gy, which is correct
                        x: gx + (p.x * gCos - p.y * gSin),
                        y: gy + (p.x * gSin + p.y * gCos)
                    }));

                    // Convert THREE.Vector2[] to {x,y}[]
                    const contour = globalBasePoints.map(p => ({x: p.x, y: p.y}));
                    
                    const slices = slicePolygonContours([contour], depth, endmillRadius, 0, 0, 0); // Already transformed
                    result = result.concat(slices);
                }
            }
        }
    }

    return result;
}

// Helper to Slice Polygons (Used for both Polygon Shapes and Union Outlines)
function slicePolygonContours(
    contours: {x:number, y:number}[][], 
    depth: number, 
    endmillRadius: number,
    // Optional additional transform if points are not already global
    tx = 0, ty = 0, rot = 0
): any[] {
    const result: any[] = [];
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    contours.forEach(contourPts => {
        // Convert to THREE.Vector2
        const basePoints = contourPts.map(p => new THREE.Vector2(p.x, p.y));
        if (basePoints.length < 3) return;

        // Ensure CCW Winding
        let area = 0;
        for (let i = 0; i < basePoints.length; i++) {
            const j = (i + 1) % basePoints.length;
            area += basePoints[i].x * basePoints[j].y - basePoints[j].x * basePoints[i].y;
        }
        if (area < 0) basePoints.reverse();

        // Slicing parameters
        const safeR = Math.min(endmillRadius, depth);
        const steps = 8;
        const baseDepth = depth - safeR;

        const layers: { z: number, offset: number }[] = [];
        if (baseDepth > 0.001) layers.push({ z: baseDepth, offset: 0 });
        
        for(let i=1; i<=steps; i++) {
            const theta = (i / steps) * (Math.PI / 2);
            const z = baseDepth + Math.sin(theta) * safeR;
            const off = (1 - Math.cos(theta)) * safeR;
            layers.push({ z, offset: off });
        }

        layers.forEach(layer => {
            const offsetPts = offsetPolygonContour(basePoints, layer.offset);
            if (offsetPts.length < 3) return;

            const outputPoints = offsetPts.map(p => {
                // Apply transform if needed (usually 0,0,0 if pre-transformed)
                const rx = p.x * cos - p.y * sin; 
                const ry = p.x * sin + p.y * cos;
                return {
                    x: tx + rx,
                    y: ty + ry,
                    handle_in: undefined,
                    handle_out: undefined
                };
            });

            result.push({
                shape_type: "polygon",
                x: 0, // Points are absolute
                y: 0,
                depth: layer.z,
                endmill_radius: 0, // Mark as pre-processed
                points: outputPoints
            });
        });
    });

    return result;
}