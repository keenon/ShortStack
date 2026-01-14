// src/components/FootprintEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintLine, FootprintWireGuide, FootprintMesh, FootprintBoardOutline, Point, MeshAsset, FootprintPolygon, FootprintUnion, FootprintText, FootprintSplitLine } from "../types";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import { modifyExpression, isFootprintOptionValid, evaluateExpression, resolvePoint, bezier1D, getShapeAABB, isShapeInSelection, rotatePoint, getAvailableWireGuides, findWireGuideByPath, getFootprintAABB, getTransformAlongLine, getClosestDistanceAlongLine, getLineLength, repairBoardAssignments, collectGlobalObstacles } from "../utils/footprintUtils";
import { RecursiveShapeRenderer } from "./FootprintRenderers";
import { checkSplitPartSizes, findSafeSplitLine, autoComputeSplit } from "../utils/splitUtils";
import FootprintPropertiesPanel from "./FootprintPropertiesPanel";
import { IconCircle, IconRect, IconLine, IconGuide, IconOutline, IconMesh, IconPolygon, IconText, IconSplit  } from "./Icons";
import ShapeListPanel from "./ShapeListPanel";
import { useUndoHistory } from "../hooks/useUndoHistory"; 
import { collectExportShapesAsync } from "../utils/exportUtils";
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
  onExport: (id: string, type: "SVG_DEPTH" | "SVG_CUT" | "DXF_CUT" | "SVG" | "DXF" | "STL") => void;
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
            {/* UNASSIGNED LAYER */}
            <div className={`layer-vis-item ${visibility["unassigned"] === false ? "is-hidden" : ""}`}>
                <div className="layer-vis-info">
                    <div className="layer-color-square unassigned" title="Unassigned" />
                    <span className="layer-vis-name">Unassigned</span>
                </div>
                {/* Show/Hide button on the right */}
                <button className={`vis-toggle-btn ${visibility["unassigned"] !== false ? "visible" : "hidden"}`} onClick={() => onToggle("unassigned")}>
                    {visibility["unassigned"] !== false ? "Hide" : "Show"}
                </button>
            </div>

            {/* STACKUP LAYERS */}
            {stackup.map((layer) => (
                <div key={layer.id} className={`layer-vis-item ${visibility[layer.id] === false ? "is-hidden" : ""}`} style={{flexDirection: 'column', alignItems: 'stretch', gap: '5px'}}>
                    
                    {/* Top Row: Info + Toggle */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                        <div className="layer-vis-info" style={{ overflow: 'hidden' }}>
                            <div className="layer-color-square" style={{ backgroundColor: layer.color }} />
                            <span className="layer-vis-name" title={layer.name}>{layer.name}</span>
                        </div>
                        <button 
                            className={`vis-toggle-btn ${visibility[layer.id] !== false ? "visible" : "hidden"}`} 
                            onClick={() => onToggle(layer.id)}
                        >
                            {visibility[layer.id] !== false ? "Hide" : "Show"}
                        </button>
                    </div>
                    
                    {/* Bottom Row: Export Buttons (aligned left) */}
                    {isBoard && (
                        <div style={{ display: 'flex', gap: '5px', width: '100%', justifyContent: 'flex-start', paddingLeft: '22px', flexWrap: 'wrap' }}>
                            {layer.type === "Cut" ? (
                                <>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "SVG")}>SVG</button>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "DXF")}>DXF</button>
                                </>
                            ) : (
                                <>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "STL")}>STL</button>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "SVG_DEPTH")}>SVG</button>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "SVG_CUT")}>SVG Cut</button>
                                    <button className="vis-toggle-btn" style={{minWidth: '35px'}} onClick={() => onExport(layer.id, "DXF_CUT")}>DXF Cut</button>
                                </>
                            )}
                        </div>
                    )}
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

  // SPLIT TOOL STATE
  const [isSplitToolActive, setIsSplitToolActive] = useState(false);
  const [bedSize, setBedSize] = useState({ width: 256, height: 256 });
  const [splitToolOptions, setSplitToolOptions] = useState<{ignoredLayerIds: string[]}>({ ignoredLayerIds: [] });

  // Visualization of obstacles for Split Tool
  const visualObstacles = useMemo(() => {
    if (isSplitToolActive || (selectedShapeIds.length === 1 && footprint.shapes.find(s => s.id === selectedShapeIds[0])?.type === 'splitLine')) {
         // Pass 'footprint' as context to correctly resolve local guides
         let ignored: string[] = splitToolOptions.ignoredLayerIds;
         
         // If a specific line is selected, use its settings instead of global defaults
         if (selectedShapeIds.length === 1) {
             const sl = footprint.shapes.find(s => s.id === selectedShapeIds[0]);
             if (sl && sl.type === 'splitLine') {
                 ignored = (sl as any).ignoredLayerIds || [];
             }
         }
         return collectGlobalObstacles(footprint.shapes, params, allFootprints, stackup, {x:0, y:0, angle:0}, footprint, ignored);
    }
    return [];
  }, [isSplitToolActive, selectedShapeIds, footprint, params, allFootprints, stackup, splitToolOptions]);
  
  // Compute Split Parts (Hulls) for the whole board if a split line exists
  const splitPartHulls = useMemo(() => {
      // Only show if tool is active OR a split line is selected
      const hasSelection = selectedShapeIds.some(id => footprint.shapes.find(s => s.id === id && s.type === 'splitLine'));
      if (!isSplitToolActive && !hasSelection) return [];

      return checkSplitPartSizes(footprint, params, allFootprints, bedSize).parts;
  }, [footprint, params, allFootprints, bedSize, isSplitToolActive, selectedShapeIds]);

  
  const splitStart = useRef<{x:number, y:number} | null>(null);
  const [splitPreview, setSplitPreview] = useState<{x1:number, y1:number, x2:number, y2:number} | null>(null);
  const [debugLines, setDebugLines] = useState<any[]>([]); // New Debug State

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

    if (isSplitToolActive && e.button === 0) {
        e.stopPropagation();
        const pos = getMouseWorldPos(e.clientX, e.clientY);
        // Visual Y is inverted relative to Math Y. Convert to Math Y for logic.
        const mathPos = { x: pos.x, y: -pos.y };
        
        splitStart.current = mathPos;
        setSplitPreview({ x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
        
        window.addEventListener('mousemove', handleSplitMouseMove);
        window.addEventListener('mouseup', handleSplitMouseUp);
        return;
    }
    
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

            if (s.type === "circle" || s.type === "rect" || s.type === "footprint" || s.type === "wireGuide" || s.type === "union" || s.type === "splitLine") {
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

                // 6. Handle Split Line Vector Rotation with Snapping
                if (s.type === "splitLine") {
                    const ex = evaluateExpression((startState as any).endX, params);
                    const ey = evaluateExpression((startState as any).endY, params);
                    
                    // Rotate the relative vector
                    const nex = ex * hCos - ey * hSin;
                    const ney = ex * hSin + ey * hCos;
                    
                    // Tentative Position (Geometry only)
                    newProps.endX = modifyExpression((startState as any).endX, nex - ex);
                    newProps.endY = modifyExpression((startState as any).endY, ney - ey);

                    // Perform Snap Check
                    // Evaluate current tentative Global Start
                    const currentX = evaluateExpression(newProps.x, params);
                    const currentY = evaluateExpression(newProps.y, params);
                    
                    // Run Snapping Search
                    const snapRes = findSafeSplitLine(
                        footprintRef.current, allFootprints, params, stackup, 
                        {x: currentX, y: currentY}, 
                        {x: currentX + nex, y: currentY + ney},
                        bedSize,
                        { searchRadius: 10, angleRange: 5 }, // Tight snapping corridor
                        (startState as any).ignoredLayerIds
                    );

                    if (snapRes.result) {
                        // Override with Snapped Geometry
                        // We need to calculate deltas relative to StartState to preserve expression structure
                        const startXVal = evaluateExpression(startState.x, params);
                        const startYVal = evaluateExpression(startState.y, params);
                        
                        newProps.x = modifyExpression(startState.x, snapRes.result.start.x - startXVal);
                        newProps.y = modifyExpression(startState.y, snapRes.result.start.y - startYVal);
                        
                        const newDX = snapRes.result.end.x - snapRes.result.start.x;
                        const newDY = snapRes.result.end.y - snapRes.result.start.y;
                        
                        newProps.endX = modifyExpression((startState as any).endX, newDX - ex);
                        newProps.endY = modifyExpression((startState as any).endY, newDY - ey);
                    }
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

  // SPLIT TOOL HANDLERS
  const handleSplitMouseMove = (e: MouseEvent) => {
      if (!splitStart.current) return;
      const pos = getMouseWorldPos(e.clientX, e.clientY);
      setSplitPreview(prev => prev ? { ...prev, x2: pos.x, y2: pos.y } : null);
  };

  const handleSplitMouseUp = (e: MouseEvent) => {
      window.removeEventListener('mousemove', handleSplitMouseMove);
      window.removeEventListener('mouseup', handleSplitMouseUp);
      
      if (!splitStart.current) return;
      const pos = getMouseWorldPos(e.clientX, e.clientY);
      const mathEnd = { x: pos.x, y: -pos.y }; // Convert to Math Y

      // SAFETY CHECKS
      // 1. Minimum Length Check
      const dist = Math.sqrt((pos.x - splitStart.current.x)**2 + (pos.y - splitStart.current.y)**2); // Visual dist
      if (dist < 5) {
          setSplitPreview(null);
          splitStart.current = null;
          setIsSplitToolActive(false); // Auto-exit tool
          return;
      }

      // 2. Intersection Check (Must touch/cross board AABB at minimum)
      const aabb = getFootprintAABB(footprintRef.current, params, allFootprints);
      if (aabb) {
          // Simple check: does segment intersect bounding box?
          // We convert mouse pos (Visual Y) to Math Y for check
          const sMath = { x: splitStart.current!.x, y: splitStart.current!.y };
          // Check intersection of sMath->mathEnd with aabb (which is Visual Y, so flip AABB Ys or flip Point Ys)
          // `getFootprintAABB` returns Visual Y. 
          // `mathEnd` is Math Y. `splitStart` is Math Y.
          // Let's use Visual Coords for the check since we have `pos` and `splitStart.current` (wait splitStart is Math).
          // Re-convert splitStart to visual
          const vStart = { x: splitStart.current!.x, y: -splitStart.current!.y };
          const vEnd = { x: pos.x, y: pos.y };
          
          // Helper to check rect intersection
          const minX = Math.min(vStart.x, vEnd.x), maxX = Math.max(vStart.x, vEnd.x);
          const minY = Math.min(vStart.y, vEnd.y), maxY = Math.max(vStart.y, vEnd.y);
          
          if (maxX < aabb.x1 || minX > aabb.x2 || maxY < aabb.y1 || minY > aabb.y2) {
               // Completely outside bounding box
               setSplitPreview(null);
               splitStart.current = null;
            //    setIsSplitToolActive(false); // Auto-exit tool
               return;
          }
      }

      // Run Search Algorithm
      setProcessingMessage("Computing Optimal Split...");

      setTimeout(() => {
          // Destructure new return type
          const { result } = findSafeSplitLine(
                                footprintRef.current, 
                                allFootprints, 
                                params, 
                                stackup, 
                                splitStart.current!, 
                                mathEnd,
                                bedSize,
                                undefined, // Default search options
                                splitToolOptions.ignoredLayerIds // Pass global tool defaults
                            );
          if (!result) {
              alert("Unable to find a valid split line that avoids obstacles. Ensure the line crosses the board.");
              setSplitPreview(null);
              setSplitPreview(null);
              splitStart.current = null;
              // Do NOT close tool immediately so user can see debug
              // setIsSplitToolActive(false); 
              setProcessingMessage(null);
              return;
          }
          const newSplit: FootprintSplitLine = {
              id: crypto.randomUUID(),
              type: "splitLine",
              name: "Fabrication Split",
              x: result.start.x.toFixed(4),
              y: result.start.y.toFixed(4),
              endX: (result.end.x - result.start.x).toFixed(4),
              endY: (result.end.y - result.start.y).toFixed(4),
              dovetailCount: result.count.toString(),
              dovetailWidth: result.width.toString(),
              assignedLayers: {},
              // Apply current tool options
              ignoredLayerIds: splitToolOptions.ignoredLayerIds
          } as FootprintSplitLine;

          updateHistory({ 
              footprint: { ...footprintRef.current, shapes: [...footprintRef.current.shapes, newSplit] },
              selectedShapeIds: [newSplit.id]
          });
          setProcessingMessage(null);
          setSplitPreview(null);
          splitStart.current = null;
          setIsSplitToolActive(false); // Auto-exit tool on success
      }, 10);
  };;

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
      
      // Get the raw value from the expression
      const initialEvaluatedDist = evaluateExpression(tieDown.distance, params);
      
      // Calculate the visual limit (clamped)
      const lineLength = getLineLength(shape, params, footprint, allFootprints);
      const clampedDist = Math.max(0, Math.min(initialEvaluatedDist, lineLength));

      // Calculate Pivot Point based on CLAMPED distance
      const tf = getTransformAlongLine(shape, clampedDist, params, footprint, allFootprints);
      if (!tf) return;

      let startState: any = {
          active: true,
          type,
          tieDownId,
          lineId,
          startMouse: mouseMath,
          pivot: { x: tf.x, y: tf.y },
          initialParamAngle: evaluateExpression(tieDown.angle, params),
          initialEvaluatedDist, // The original numerical value (could be -50 or 500)
          initialClampedDist: clampedDist, // Where it is visually (0 or lineLength)
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
          
          // OFFSET is calculated from the CLAMPED visual position. 
          // This removes the "dead zone" catch-up effect.
          startState.distOffset = clampedDist - result.distance;
          
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
          const desiredVisualDist = result.distance + state.distOffset;
          
          // 2. Calculate the DELTA relative to the INITIAL EVALUATED value.
          // Example: expression was "-50" (initialEvaluatedDist). Clamped was "0" (initialClampedDist).
          // If we drag 10mm forward, desiredVisualDist becomes 10.
          // Delta = 10 - (-50) = 60.
          // modifyExpression("-50", 60) results in "10", effectively snapping the 
          // tie down to the line edge the moment dragging starts.
          const deltaToApply = desiredVisualDist - (state as any).initialEvaluatedDist;
          
          const newDistExpr = modifyExpression(String((state as any).initialEvaluatedDist), deltaToApply);

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

                  // Handle Dragging
                  if (handleType) {
                      // We are dragging a Bezier Handle (In or Out)
                      const mode = startPt.handleMode || "independent";
                      
                      const draggedHandleKey = handleType === 'in' ? 'handleIn' : 'handleOut';
                      const otherHandleKey = handleType === 'in' ? 'handleOut' : 'handleIn';
                      
                      const startDraggedHandle = startPt[draggedHandleKey] || { x: "0", y: "0" };
                      const startOtherHandle = startPt[otherHandleKey];

                      // 1. Update the dragged handle using delta relative to start
                      // Use modifyExpression to preserve user's formula if possible
                      const newDraggedHandle = { 
                          x: modifyExpression(startDraggedHandle.x, dxWorld), 
                          y: modifyExpression(startDraggedHandle.y, dyWorldMath) 
                      };

                      // Evaluate numeric values for math calculation
                      const numDraggedX = evaluateExpression(startDraggedHandle.x, params) + dxWorld;
                      const numDraggedY = evaluateExpression(startDraggedHandle.y, params) + dyWorldMath;

                      let newOtherHandle = startOtherHandle ? { ...startOtherHandle } : undefined;

                      if (startOtherHandle) {
                          const numOtherX = evaluateExpression(startOtherHandle.x, params);
                          const numOtherY = evaluateExpression(startOtherHandle.y, params);

                          if (mode === 'symmetrical') {
                              // Symmetrical: Other = -Dragged
                              newOtherHandle = {
                                  x: (-numDraggedX).toFixed(4),
                                  y: (-numDraggedY).toFixed(4)
                              };
                          } else if (mode === 'angle') {
                              // Angle: Other aligned with -Dragged, but keeps own length
                              const draggedLen = Math.sqrt(numDraggedX * numDraggedX + numDraggedY * numDraggedY);
                              const otherLen = Math.sqrt(numOtherX * numOtherX + numOtherY * numOtherY);
                              
                              if (draggedLen > 0.001) {
                                  const nx = numDraggedX / draggedLen;
                                  const ny = numDraggedY / draggedLen;
                                  newOtherHandle = {
                                      x: (-nx * otherLen).toFixed(4),
                                      y: (-ny * otherLen).toFixed(4)
                                  };
                              }
                          }
                          // Independent: Do nothing to other handle
                      }

                      newPoints[pointIdx] = { 
                          ...startPt, 
                          [draggedHandleKey]: newDraggedHandle,
                          [otherHandleKey]: newOtherHandle
                      };

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
                              x: modifyExpression(startPt.x, dxWorld), 
                              y: modifyExpression(startPt.y, dyWorldMath) 
                          };
                          setSnapPreview(null);
                      }
                  }
                  return { ...s, points: newPoints } as any;
              }
                if (s.type === "splitLine") {
                  // Dragging Split Line: Calculate tentative position
                  const tentX = evaluateExpression(startShape.x, params) + dxWorld;
                  const tentY = evaluateExpression(startShape.y, params) + dyWorldMath;
                  const endXRel = evaluateExpression((startShape as any).endX, params);
                  const endYRel = evaluateExpression((startShape as any).endY, params);
                  
                  // Run local search for valid snap with rotation
                  // OPTIMIZATION: Use smaller search radius and angle range during drag
                  const snapRes = findSafeSplitLine(
                      footprintRef.current, allFootprints, params, stackup, 
                      {x: tentX, y: tentY}, 
                      {x: tentX + endXRel, y: tentY + endYRel},
                      bedSize,
                      { searchRadius: 5, angleRange: 5 },
                      startShape.ignoredLayerIds
                  );

                  if (snapRes.result) {
                      return { 
                          ...s, 
                          x: snapRes.result.start.x.toFixed(4), 
                          y: snapRes.result.start.y.toFixed(4),
                          endX: (snapRes.result.end.x - snapRes.result.start.x).toFixed(4),
                          endY: (snapRes.result.end.y - snapRes.result.start.y).toFixed(4)
                      };
                  }
                  
                  // If no valid snap found, do not move. Snap back to original (s).
                  return s;
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
    const currentFp = footprintRef.current;
    const shapeToDelete = currentFp.shapes.find(s => s.id === shapeId);
    
    // --- INTEGRITY GUARD: Prevent deleting the last board outline ---
    if (shapeToDelete?.type === "boardOutline" && currentFp.isBoard) {
        const remainingOutlines = currentFp.shapes.filter(s => s.type === "boardOutline" && s.id !== shapeId);
        if (remainingOutlines.length === 0) {
            alert("Cannot delete the last board outline while 'Standalone Board' is checked. Disable 'Standalone Board' first if you wish to remove all outlines.");
            return;
        }
    }

    let newShapes = currentFp.shapes.filter(s => s.id !== shapeId);

    // Apply repair logic to re-map layers if the current outline was deleted
    let repairedFp = { ...currentFp, shapes: newShapes };
    repairedFp = repairBoardAssignments(repairedFp, stackup);

    updateHistory({ 
        footprint: repairedFp, 
        selectedShapeIds: selectedShapeIds.filter(x => x !== shapeId) 
    });
  }, [editorState, updateHistory, stackup]);

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

        if (e.key === "Escape") {
            if (isSplitToolActive) {
                setIsSplitToolActive(false);
                setSplitPreview(null);
                splitStart.current = null;
                setProcessingMessage(null);
                setDebugLines([]);
            } else {
                // Standard behavior: Clear selection if not in tool
                setSelectedShapeIds([]);
            }
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

const handleExport = async (layerId: string, format: "SVG_DEPTH" | "SVG_CUT" | "DXF_CUT" | "SVG" | "DXF" | "STL") => {
    const layer = stackup.find(l => l.id === layerId);
    if (!layer) return;

    // --- REPAIR BEFORE EXPORT ---
    const repairedFp = repairBoardAssignments(footprint, stackup);
    if (repairedFp !== footprint) {
        onUpdate(repairedFp);
    }

    // Determine intended output style
    const isCutStyle = format === "SVG_CUT" || format === "DXF_CUT" || layer.type === "Cut";
    const extension = format.startsWith("DXF") ? "dxf" : (format.startsWith("SVG") ? "svg" : "stl");
    const rustFormat = extension.toUpperCase();

    if (rustFormat === "STL") {
        // Force switch to 3D View if not active to ensure the Mesh Worker and R3F Loop are running.
        // This prevents the "generating high resolution 3D mesh" step from hanging due to paused render loops in 2D mode.
        if (viewMode !== "3D") {
            setViewMode("3D");
            // Yield execution to allow React to render the view switch and the Canvas to initialize
            await new Promise(resolve => setTimeout(resolve, 100));
        }

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
    const suffix = (isCutStyle && layer.type !== "Cut") ? "_cut" : (format === "SVG_DEPTH" ? "_depth" : "");
    const path = await save({
        defaultPath: `${footprint.name.replace(/[^a-zA-Z0-9]/g, '_')}_${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}${suffix}.${extension}`,
        filters: [{
            name: `${rustFormat} File`,
            extensions: [extension]
        }]
    });

    if (!path) return;

    // ... (Rest of function remains unchanged) ...
    
    // 2. Prepare Data
    const layerThickness = evaluateExpression(layer.thicknessExpression, params);

    // Evaluate Board Outline with Handles and Snaps
    const assignedOutlineId = footprint.boardOutlineAssignments?.[layerId];
    const outlineShape = footprint.shapes.find(s => s.id === assignedOutlineId) as FootprintBoardOutline | undefined;
    
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

    // Determine effective machining type for the shape collector
    const effectiveLayer = {
        ...layer,
        type: isCutStyle ? "Cut" as const : "Carved/Printed" as const
    };

    const shapes = await collectExportShapesAsync(
        footprint, 
        footprint.shapes, 
        allFootprints,
        params,
        effectiveLayer,
        layerThickness,
        footprint3DRef.current // Pass view ref to access worker
    );

    // 3. Prepare STL Data if needed
    let stlContent: number[] | null = null;
    if (rustFormat === "STL") {
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
                file_type: rustFormat,
                machining_type: effectiveLayer.type,
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

  const getObsColor = (i: number) => {
        const colors = ["#00ffff", "#ff00ff", "#00ff00", "#ffaa00"]; // Cyan, Magenta, Lime, Orange
        return colors[i % colors.length];
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
        <button 
            className={isSplitToolActive ? "active" : ""} 
            onClick={() => setIsSplitToolActive(!isSplitToolActive)}
            style={isSplitToolActive ? { background: '#3b5b9d', borderColor: '#646cff', color: 'white' } : {}}
        >
            <IconSplit /> Split
        </button>
        {(isSplitToolActive || (selectedShapeIds.length === 1 && footprint.shapes.find(s => s.id === selectedShapeIds[0])?.type === 'splitLine')) && (() => {
            const activeSplit = selectedShapeIds.length === 1 ? footprint.shapes.find(s => s.id === selectedShapeIds[0]) as any : null;
            const currentW = activeSplit?.bedWidth || bedSize.width;
            const currentH = activeSplit?.bedHeight || bedSize.height;
            
            const handleBedChange = (field: 'width' | 'height', val: string) => {
                const num = parseFloat(val);
                if (activeSplit) {
                    // Update shape property
                    updateShape(activeSplit.id, field === 'width' ? 'bedWidth' : 'bedHeight', num);
                } else {
                    // Update global tool default
                    setBedSize(prev => ({ ...prev, [field]: num }));
                }
            };

            return (
                <div style={{display:'flex', gap:'5px', marginLeft:'10px', alignItems:'center'}}>
                    <span style={{fontSize:'0.8em', color:'#aaa'}}>Bed:</span>
                    <input 
                        type="number" 
                        className="toolbar-name-input" 
                        style={{width:'80px'}} 
                        value={currentW} 
                        onChange={e => handleBedChange('width', e.target.value)} 
                        title="Print Bed Width" 
                    />
                    <span style={{color:'#666'}}>x</span>
                    <input 
                        type="number" 
                        className="toolbar-name-input" 
                        style={{width:'80px'}} 
                        value={currentH} 
                        onChange={e => handleBedChange('height', e.target.value)} 
                        title="Print Bed Height" 
                    />
                                        <button 
                        style={{marginLeft:'10px', fontSize:'0.9em', background: '#2d4b38', border:'1px solid #487e5b'}}
                        onClick={async () => {
                            if (!footprint.isBoard) { alert("Please enable 'Standalone Board' first."); return; }
                            
                            setProcessingMessage("Running Global Search...");
                            
                            // Yield to UI to show spinner
                            await new Promise(resolve => setTimeout(resolve, 50));

                            const res = autoComputeSplit(
                                footprint, allFootprints, params, stackup, 
                                bedSize, { clearance: 2, desiredCuts: 1 }, 
                                splitToolOptions.ignoredLayerIds
                            );
                            
                            setProcessingMessage(null);
                            
                            // Show debug log from algorithm
                            if (res.log) alert(res.log);

                            if (res.success) {
                                if (res.shapes && res.shapes.length > 0) {
                                    const newIds = res.shapes.map(s => s.id);
                                    updateHistory({ 
                                        footprint: { ...footprint, shapes: [...footprint.shapes, ...res.shapes] },
                                        selectedShapeIds: newIds
                                    });
                                } else {
                                    alert("No split needed! The footprint already fits within the bed dimensions.");
                                }
                            } else {
                                // Fallback or Failure
                                if (res.shapes && res.shapes.length > 0) {
                                    alert(`Warning: Perfect fit not found. Found ${res.shapes.length} cuts with excess: ${res.maxExcess?.toFixed(1)}mm`);
                                } else {
                                    alert("Global search failed completely. Check obstacle layers or try increasing bed size.");
                                }
                            }
                            if (res.debugLines) setDebugLines(res.debugLines);
                        }}
                    >
                        Auto-Split
                    </button>
                </div>
            );
        })()}
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
                    {/* OBSTACLE VISUALIZATION */}
                    {visualObstacles.map((obs, i) => (
                        obs.type === 'circle' ? 
                        <circle key={'obs'+i} cx={obs.x} cy={-obs.y} r={obs.r} fill={getObsColor(i) + "40"} stroke={getObsColor(i)} strokeWidth={1} vectorEffect="non-scaling-stroke" /> :
                        <polygon key={'obs'+i} points={obs.points.map(p => `${p.x},${-p.y}`).join(' ')} fill={getObsColor(i) + "40"} stroke={getObsColor(i)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    ))}

                    
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

                    
                    {/* SPLIT PART SIZE CHECK - Using Unified Hull Logic */}
                    {splitPartHulls.map((part, i) => {
                        if (!part.hull || part.hull.length < 1) return null;
                        const hullPts = part.hull.map(p => `${p.x},${-p.y}`).join(' ');
                        
                        // 1. Hull Visualization
                        const hullColor = part.valid ? "rgba(0, 255, 0, 0.05)" : "rgba(0, 0, 255, 0.88)";
                        const hullStroke = part.valid ? "rgba(0, 255, 0, 0.3)" : "rgba(255, 0, 0, 0.3)";
                        
                        // 2. Bed Visualization logic (Simplified for unified check)
                        let bedPoly = null;
                        if (part.corners.length === 4) {
                            // OBB Center and Axes
                            const c = part.corners;
                            const center = { x: (c[0].x + c[2].x)/2, y: (c[0].y + c[2].y)/2 };
                            const u = { x: c[1].x - c[0].x, y: c[1].y - c[0].y };
                            const v = { x: c[2].x - c[1].x, y: c[2].y - c[1].y };
                            const uLen = Math.sqrt(u.x*u.x + u.y*u.y);
                            const vLen = Math.sqrt(v.x*v.x + v.y*v.y);
                            const uHat = { x: u.x/uLen, y: u.y/uLen };
                            const vHat = { x: v.x/vLen, y: v.y/vLen };

                            const bedLong = Math.max(bedSize.width, bedSize.height);
                            const bedShort = Math.min(bedSize.width, bedSize.height);
                            const isULong = uLen >= vLen;
                            
                            let renderW, renderH;
                            if (isULong) { renderW = bedLong; renderH = bedShort; }
                            else { renderW = bedShort; renderH = bedLong; }

                            const halfW = renderW / 2;
                            const halfH = renderH / 2;
                            
                            const bc = [
                                { x: center.x - uHat.x*halfW - vHat.x*halfH, y: center.y - uHat.y*halfW - vHat.y*halfH },
                                { x: center.x + uHat.x*halfW - vHat.x*halfH, y: center.y + uHat.y*halfW - vHat.y*halfH },
                                { x: center.x + uHat.x*halfW + vHat.x*halfH, y: center.y + uHat.y*halfW + vHat.y*halfH },
                                { x: center.x - uHat.x*halfW + vHat.x*halfH, y: center.y - uHat.y*halfW + vHat.y*halfH }
                            ];
                            
                            bedPoly = (
                                <polygon 
                                    points={bc.map(p => `${p.x},${-p.y}`).join(' ')} 
                                    fill="none" 
                                    stroke={part.valid ? "cyan" : "orange"} 
                                    strokeWidth={1} 
                                    strokeDasharray="2,2" 
                                    vectorEffect="non-scaling-stroke" 
                                    opacity={0.6}
                                />
                            );
                        }

                        return (
                            <g key={'size-check-'+i} pointerEvents="none">
                                <polygon points={hullPts} fill={hullColor} stroke={hullStroke} strokeWidth={1} strokeDasharray="4,4" vectorEffect="non-scaling-stroke" />
                                {bedPoly}
                                {!part.valid && part.corners.length > 0 && (
                                    <>
                                        <polygon 
                                            points={part.corners.map(p => `${p.x},${-p.y}`).join(' ')} 
                                            fill="none" 
                                            stroke="red" 
                                            strokeWidth={2} 
                                            vectorEffect="non-scaling-stroke" 
                                        />
                                        <text 
                                            x={part.corners[0].x} 
                                            y={-part.corners[0].y} 
                                            fill="red" 
                                            fontSize={6} 
                                            fontWeight="bold" 
                                            dy={-2}
                                            style={{ textShadow: '0 0 2px black' }}
                                        >
                                            OVERSIZE
                                        </text>
                                    </>
                                )}
                            </g>
                        );
                    })}

                    {debugLines.map((l, i) => (
                        <line key={'dbg'+i}
                            x1={l.x1} y1={-l.y1} x2={l.x2} y2={-l.y2}
                            stroke={l.color || "rgba(255,255,0,0.5)"}
                            strokeWidth={1}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                        />
                    ))}
                    {splitPreview && (
                        <line 
                            x1={splitPreview.x1} y1={splitPreview.y1} 
                            x2={splitPreview.x2} y2={splitPreview.y2} 
                            stroke="#ff00ff" 
                            strokeWidth={2} 
                            strokeDasharray="5,5" 
                            vectorEffect="non-scaling-stroke" 
                            pointerEvents="none"
                        />
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
          {selectedShapeIds.length > 0 || activeMesh || isSplitToolActive ? (
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
                // @ts-ignore - passing extra props for split tool logic
                isSplitToolActive={isSplitToolActive}
                splitToolOptions={splitToolOptions}
                setSplitToolOptions={setSplitToolOptions}
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