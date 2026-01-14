// src/components/FabricationEditor.tsx
import { useState, useRef, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { 
    FabricationPlan, 
    Footprint, 
    StackupLayer, 
    FabricationMethod, 
    Parameter, 
    WaterlineSettings, CNCSettings, 
    MeshAsset, 
    FootprintBoardOutline, 
    FootprintLine, 
    FootprintReference 
} from "../types";
import { IconOutline, IconGrip } from "./Icons";
import ExpressionEditor from "./ExpressionEditor";
import { evaluateExpression, resolvePoint, getLineLength, convertExportShapeToFootprintShape } from "../utils/footprintUtils";
import { collectExportShapesAsync, sliceExportShapes } from "../utils/exportUtils";
import Footprint3DView, { Footprint3DViewHandle, callWorker } from "./Footprint3DView";
import "./FabricationEditor.css";

const MATERIAL_DATA: Record<string, { density: number; methods: string[] }> = {
    "PLA (10% Infill)": { density: 0.124, methods: ["3D printed"] },
    "PLA (100% Infill)": { density: 1.24, methods: ["3D printed"] },
    "Balsa Wood": { density: 0.14, methods: ["CNC", "Laser cut", "Waterline laser cut"] },
    "Aluminum": { density: 2.66, methods: ["CNC", "Laser cut", "Waterline laser cut"] },
    "XPS Foam": { density: 0.045, methods: ["CNC"] },
    "Delrin": { density: 1.41, methods: ["Laser cut", "Waterline laser cut"] },
    "Plexiglass": { density: 1.2, methods: ["Laser cut", "Waterline laser cut"] },
    "Carbon Fiber": { density: 1.7, methods: ["Laser cut", "Waterline laser cut"] },
};

interface Props {
  fabPlans: FabricationPlan[];
  setFabPlans: React.Dispatch<React.SetStateAction<FabricationPlan[]>>;
  footprints: Footprint[];
  stackup: StackupLayer[];
  params: Parameter[];
  meshAssets: MeshAsset[];
}

export default function FabricationEditor({ fabPlans, setFabPlans, footprints, stackup, params, meshAssets }: Props) {
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>({});
  const [layerVolumes, setLayerVolumes] = useState<Record<string, number>>({});
  const [activeToolpaths, setActiveToolpaths] = useState<Record<string, number[][]>>({});
  
  // NEW: Visual Stack State
  const [visualStack, setVisualStack] = useState<{ layer: StackupLayer, footprint: Footprint }[] | undefined>(undefined);
  const [isComputingVisuals, setIsComputingVisuals] = useState(false);
  

  const toggleLayerVisibility = (id: string) => {
    setLayerVisibility(prev => ({ 
        ...prev, 
        [id]: prev[id] === undefined ? false : !prev[id] 
    }));
  };
  
  const activePlan = fabPlans.find(p => p.id === activePlanId);

  const DEFAULT_CNC: CNCSettings = {
    stockDepthExpression: "10",
    toolDiameterExpression: "3.175",
    toolLengthExpression: "20",
    chuckDiameterExpression: "15",
    stepDownExpression: "1",
    stepOverExpression: "1.2",
    feedrateExpression: "1000",
    spindleRpmExpression: "18000"
  };

  const updateCNCSetting = (layerId: string, field: keyof CNCSettings, value: string) => {
    if (!activePlan) return;
    const existing = activePlan.cncSettings?.[layerId] || { ...DEFAULT_CNC };
    const updatedPlan = {
        ...activePlan,
        cncSettings: { 
            ...(activePlan.cncSettings || {}), 
            [layerId]: { ...existing, [field]: value } 
        }
    };
    setFabPlans(prev => prev.map(p => p.id === activePlan.id ? updatedPlan : p));
  };

  const dragItemIndex = useRef<number | null>(null);
  const view3DRef = useRef<Footprint3DViewHandle>(null);

  const renderParams = useMemo(() => {
      return params;
  }, [params]);

  const getLayerStats = (layer: StackupLayer) => {
    if (!activePlan) return { method: "Laser cut" as FabricationMethod, numFiles: 1, exportText: "", numSheets: 0, actualThickness: 0, delta: 0, progThickness: 0, sheetThickness: 0 };
    const method = activePlan.layerMethods[layer.id] || (layer.type === "Cut" ? "Laser cut" : "CNC");
    const settings = activePlan.waterlineSettings[layer.id] || { sheetThicknessExpression: "3", startSide: "Cut side", rounding: "Round up" };
    const progThickness = evaluateExpression(layer.thicknessExpression, params);
    const sheetThickness = evaluateExpression(settings.sheetThicknessExpression, params);
    
    let numSheets = 0;
    if (method === "Waterline laser cut" && sheetThickness > 0) {
        const ratio = progThickness / sheetThickness;
        numSheets = settings.rounding === "Round up" ? Math.ceil(ratio) : Math.floor(ratio);
    }
    
    const actualThickness = numSheets * sheetThickness;
    const delta = actualThickness - progThickness;
    let numFiles = method === "Waterline laser cut" ? numSheets : 1;
    
    let exportText = "Single file";
    if (method === "Waterline laser cut") exportText = `Exports ${numSheets} DXF cuts`;
    else if (method === "CNC") exportText = "Exports SVG depth map";
    else if (method === "3D printed") exportText = "Exports STL mesh";
    
    return { method, numFiles, exportText, numSheets, actualThickness, delta, progThickness, sheetThickness };
  };

  const targetFootprint = useMemo(() => {
    return footprints.find(fp => fp.id === activePlan?.footprintId);
  }, [activePlan, footprints]);
  // --- BOM COLLECTION LOGIC ---
  const bomEntries = useMemo(() => {
    if (!targetFootprint || !activePlan) return [];
    const entries: { name: string; notes: string }[] = [];

    // 1. Add Layers
    stackup.forEach(layer => {
      const { method } = getLayerStats(layer);
      entries.push({ name: `Layer: ${layer.name}`, notes: `Method: ${method}` });
    });

    // 2. Recursive items
    const collectRecursive = (fp: Footprint) => {
      fp.shapes.forEach(shape => {
        if (shape.type === "line" && (shape as any).includeInBom) {
          const line = shape as FootprintLine;
          const length = getLineLength(line, params, fp, footprints);
          const customNotes = (line as any).bomNotes ? ` - ${(line as any).bomNotes}` : "";
          entries.push({ name: line.name, notes: `Length: ${length.toFixed(2)}mm${customNotes}` });
        } else if (shape.type === "footprint") {
          const child = footprints.find(f => f.id === (shape as FootprintReference).footprintId);
          if (child) collectRecursive(child);
        }
      });
      (fp.meshes || []).forEach(mesh => {
        if (mesh.includeInBom) {
          entries.push({ name: mesh.name, notes: mesh.bomNotes || "No notes" });
        }
      });
    };

    collectRecursive(targetFootprint);
    return entries;
  }, [targetFootprint, activePlan, footprints, params, stackup]);
  const addPlan = () => {
    const newPlan: FabricationPlan = { 
        id: crypto.randomUUID(), 
        name: "New Fabrication Plan", 
        footprintId: footprints.length > 0 ? footprints[0].id : "", 
        layerMethods: {},
        waterlineSettings: {},
        layerMaterials: {},
        cncSettings: {}
    };
    setFabPlans([...fabPlans, newPlan]);
    setActivePlanId(newPlan.id);
  };

  const updateWaterlineSetting = (layerId: string, field: keyof WaterlineSettings, value: any) => {
    if (!activePlan) return;
    const existing = activePlan.waterlineSettings[layerId] || {
        sheetThicknessExpression: "3",
        startSide: "Cut side",
        rounding: "Round up"
    };
    const updatedPlan = {
        ...activePlan,
        waterlineSettings: { ...activePlan.waterlineSettings, [layerId]: { ...existing, [field]: value } }
    };
    setFabPlans(prev => prev.map(p => p.id === activePlan.id ? updatedPlan : p));
  };

  const updateSplitSettings = (layerId: string, updates: { enabled?: boolean, lineIds?: string[], kerf?: string }) => {
      if (!activePlan) return;
      const currentSplitSettings = (activePlan as any).layerSplitSettings || {};
      const oldLayerSettings = currentSplitSettings[layerId] || {};
      const newSettings = {
          ...currentSplitSettings,
          [layerId]: { ...oldLayerSettings, ...updates }
      };
      setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {...p, layerSplitSettings: newSettings} : p));
  };
  
  const updatePlanLayer = (layerId: string, field: "layerMethods" | "layerMaterials", value: string) => {
    if (!activePlan) return;
    let updatedMethods = { ...activePlan.layerMethods };
    let updatedMaterials = { ...activePlan.layerMaterials || {} };
    if (field === "layerMethods") {
        updatedMethods[layerId] = value as any;
        const validMaterials = Object.keys(MATERIAL_DATA).filter(m => MATERIAL_DATA[m].methods.includes(value));
        if (!validMaterials.includes(updatedMaterials[layerId])) {
            updatedMaterials[layerId] = validMaterials[0] || "";
        }
    } else {
        updatedMaterials[layerId] = value;
    }
    setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {
        ...p, layerMethods: updatedMethods, layerMaterials: updatedMaterials 
    } : p));
  };



  const totalFiles = useMemo(() => {
    if (!activePlan) return 0;
    return stackup.reduce((sum, layer) => sum + getLayerStats(layer).numFiles, 0);
  }, [activePlan, stackup, params]);

  const handleReorder = (dragIndex: number, dropIndex: number) => {
    if (dragIndex === dropIndex) return;
    const next = [...fabPlans];
    const [movedItem] = next.splice(dragIndex, 1);
    const targetIndex = dragIndex < dropIndex ? dropIndex - 1 : dropIndex;
    next.splice(targetIndex, 0, movedItem);
    setFabPlans(next);
  };

  // --- BULK EXPORT LOGIC ---
  const handleBulkExport = async () => {
    if (!activePlan || !targetFootprint) return;

    const folderPath = await open({
        directory: true,
        multiple: false,
        title: "Select Export Folder"
    });

    if (!folderPath) return;

    setIsExporting(true);
    const planName = activePlan.name.replace(/[^a-zA-Z0-9]/g, '_');

    try {
        // 1. Prepare 3D View if any layer needs STL
        const needsStl = stackup.some(l => activePlan.layerMethods[l.id] === "3D printed");
        if (needsStl) {
            setExportProgress("Computing high-resolution meshes...");
            await view3DRef.current?.ensureHighRes();
        }

        // 2. Iterate Layers
        for (const layer of stackup) {
            const { method, numSheets, sheetThickness } = getLayerStats(layer);
            
            setExportProgress(`Processing layer: ${layer.name}...`);

            // Resolve Board Outline for this layer
            const assignedOutlineId = targetFootprint.boardOutlineAssignments?.[layer.id];
            const outlineShape = targetFootprint.shapes.find(s => s.id === assignedOutlineId) as FootprintBoardOutline | undefined;
            const originX = outlineShape ? evaluateExpression(outlineShape.x, params) : 0;
            const originY = outlineShape ? evaluateExpression(outlineShape.y, params) : 0;

            const outline = (outlineShape?.points || []).map(p => {
                const resolved = resolvePoint(p, targetFootprint, footprints, params);
                return {
                    x: resolved.x + originX,
                    y: resolved.y + originY,
                    handle_in: resolved.handleIn,
                    handle_out: resolved.handleOut
                };
            });

            // --- STRATEGY SWITCH ---
            
            if (method === "Waterline laser cut") {
                // Collect RAW shapes once
                const layerThickness = evaluateExpression(layer.thicknessExpression, params);
                const rawShapes = await collectExportShapesAsync(
                    targetFootprint, 
                    targetFootprint.shapes, 
                    footprints,
                    params,
                    layer,
                    layerThickness,
                    view3DRef.current
                );

                const settings = activePlan.waterlineSettings[layer.id];
                const invertOrder = settings && settings.startSide === "Back side";

                // Iterate Sheets
                for (let i = 0; i < numSheets; i++) {
                    const sheetIndex = invertOrder ? (numSheets - 1 - i) : i;
                    const sliceZ = sheetIndex * sheetThickness; // Check profile at start of sheet (Top of sheet)
                    
                    // Generate Sliced Shapes
                    const slicedShapes = sliceExportShapes(rawShapes, sliceZ, sheetThickness);
                    
                    const fileName = `${planName}_${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}_Sheet${i+1}.dxf`;
                    const fullPath = await join(folderPath as string, fileName);

                    // Export DXF for this sheet
                    await invoke("export_layer_files", {
                        request: {
                            filepath: fullPath,
                            file_type: "DXF",
                            machining_type: "Cut", // Force Cut mode for DXF output
                            cut_direction: "Top",
                            outline,
                            shapes: slicedShapes,
                            layer_thickness: sheetThickness,
                            stl_content: null
                        }
                    });
                }

            } else {
                // Determine file extension and rust format
                let extension = "svg";
                if (method === "Laser cut") extension = "dxf";
                if (method === "3D printed") extension = "stl";
                const rustFormat = extension.toUpperCase();
                
                const fileName = `${planName}_${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}.${extension}`;
                const fullPath = await join(folderPath as string, fileName);

                const layerThickness = evaluateExpression(layer.thicknessExpression, params);
                let stl_content: number[] | null = null;
                let shapes: any[] = [];

                if (method === "3D printed") {
                    // Try to get multiple parts if split
                    const stlParts = await view3DRef.current?.getLayerSTLs(layer.id) || [];
                    
                    if (stlParts.length === 0) {
                        console.error(`Failed to get STL for layer ${layer.name}`);
                        continue;
                    }

                    if (stlParts.length > 1) {
                        // Multi-file export
                        for (let i = 0; i < stlParts.length; i++) {
                            const partFileName = `${planName}_${layer.name.replace(/[^a-zA-Z0-9]/g, '_')}_Part${i+1}.${extension}`;
                            const partPath = await join(folderPath as string, partFileName);
                            
                            await invoke("export_layer_files", {
                                request: {
                                    filepath: partPath,
                                    file_type: rustFormat,
                                    machining_type: "Carved/Printed",
                                    cut_direction: layer.carveSide,
                                    outline,
                                    shapes: [],
                                    layer_thickness: layerThickness,
                                    stl_content: Array.from(stlParts[i])
                                }
                            });
                        }
                        // Skip the single export below
                        continue; 
                    } else {
                        // Single file
                        stl_content = Array.from(stlParts[0]);
                    }
                } else {
                    const effectiveType = method === "Laser cut" ? "Cut" as const : "Carved/Printed" as const;
                    shapes = await collectExportShapesAsync(
                        targetFootprint, 
                        targetFootprint.shapes, 
                        footprints,
                        params,
                        { ...layer, type: effectiveType },
                        layerThickness,
                        view3DRef.current
                    );
                }

                await invoke("export_layer_files", {
                    request: {
                        filepath: fullPath,
                        file_type: rustFormat,
                        machining_type: method === "Laser cut" ? "Cut" : "Carved/Printed",
                        cut_direction: layer.carveSide,
                        outline,
                        shapes,
                        layer_thickness: layerThickness,
                        stl_content
                    }
                });
            }
        }
        setExportProgress("");
        alert("Bulk export successful!");
    } catch (e) {
        console.error("Bulk export failed", e);
        alert("Export failed: " + e);
    } finally {
        setIsExporting(false);
    }
  };

    // NEW: Calculate Visual Stackup for Waterline Cuts
  useEffect(() => {
    if (!activePlan || !targetFootprint) {
        setVisualStack(undefined);
        return;
    }

    let isMounted = true;
    const computeVisuals = async () => {
        setIsComputingVisuals(true);
        const newStack: { layer: StackupLayer, footprint: Footprint }[] = [];
        
        // We iterate the original stackup
        for (const layer of stackup) {
            const method = activePlan.layerMethods[layer.id];
            
            if (method === "Waterline laser cut") {
                const settings = activePlan.waterlineSettings[layer.id] || { sheetThicknessExpression: "3", startSide: "Cut side", rounding: "Round up" };
                const progThickness = evaluateExpression(layer.thicknessExpression, params);
                const sheetThickness = evaluateExpression(settings.sheetThicknessExpression, params);

                if (sheetThickness <= 0.001) {
                    newStack.push({ layer, footprint: targetFootprint });
                    continue;
                }

                const ratio = progThickness / sheetThickness;
                const numSheets = settings.rounding === "Round up" ? Math.ceil(ratio) : Math.floor(ratio);

                // Collect RAW export shapes
                const rawShapes = await collectExportShapesAsync(
                    targetFootprint,
                    targetFootprint.shapes,
                    footprints,
                    params,
                    layer, 
                    progThickness,
                    view3DRef.current
                );

                console.log('RAW SHAPES FOR VISUALS:', rawShapes);

                const invertOrder = settings.startSide === "Back side";

                for (let i = 0; i < numSheets; i++) {
                    const sheetIndex = invertOrder ? (numSheets - 1 - i) : i;
                    const sliceZ = sheetIndex * sheetThickness;

                    const slicedExportShapes = sliceExportShapes(rawShapes, sliceZ, sheetThickness);
                    const sheetLayerId = `${layer.id}_sheet_${i}`;

                    const tempShapes = slicedExportShapes.map(s => {
                        const shape = convertExportShapeToFootprintShape(s);
                        // FIX: Explicitly assign shape to this sheet layer so the worker picks it up
                        shape.assignedLayers = { [sheetLayerId]: String(sheetThickness) };
                        return shape;
                    });
                    
                    // Inherit Board Outlines
                    let sheetShapes = [...tempShapes];
                    let sheetAssignments: Record<string, string> = {};

                    if (targetFootprint.isBoard) {
                        const sourceOutlines = targetFootprint.shapes.filter(s => s.type === "boardOutline");
                        if (sourceOutlines.length > 0) {
                             sheetShapes = [...sheetShapes, ...sourceOutlines];
                             sheetAssignments[sheetLayerId] = sourceOutlines[0].id;
                        }
                    }

                    const sheetFp: Footprint = {
                        id: `temp_fp_${layer.id}_${i}`,
                        name: `${targetFootprint.name} (Sheet ${i+1})`,
                        shapes: sheetShapes,
                        isBoard: targetFootprint.isBoard,
                        boardOutlineAssignments: sheetAssignments
                    };

                    const sheetLayer: StackupLayer = {
                        ...layer,
                        id: sheetLayerId,
                        name: `${layer.name} [Sheet ${i+1}]`,
                        type: "Cut",
                        thicknessExpression: String(sheetThickness),
                    };

                    newStack.push({ layer: sheetLayer, footprint: sheetFp });
                }
            } else {
                newStack.push({ layer, footprint: targetFootprint });
            }
        }
        
        if (isMounted) {
            setVisualStack(newStack);
            setIsComputingVisuals(false);
        }
    };

    const timer = setTimeout(computeVisuals, 200);
    return () => { isMounted = false; clearTimeout(timer); };
  }, [activePlan, stackup, targetFootprint, params, footprints]);

    // NEW: Map visibility of generated sheets to their parents
  useEffect(() => {
    if (!activePlan || !targetFootprint) { setActiveToolpaths({}); return; }
    let currentZAccum = 0;
    stackup.forEach(layer => {
        const thickness = evaluateExpression(layer.thicknessExpression, params);
        const method = activePlan.layerMethods[layer.id];
        if (method === "CNC") {
            const settings = activePlan.cncSettings[layer.id] || DEFAULT_CNC;
            callWorker("computeToolpath", {
                shapes: targetFootprint.shapes,
                layerId: layer.id,
                params,
                contextFp: targetFootprint,
                allFootprints: footprints,
                settings,
                layerThickness: thickness,
                bottomZ: currentZAccum,
                carveSide: layer.carveSide
            }).then(paths => {
                setActiveToolpaths(prev => ({ ...prev, [layer.id]: paths }));
            });
        } else {
            setActiveToolpaths(prev => { const n = {...prev}; delete n[layer.id]; return n; });
        }
        currentZAccum += thickness;
    });
  }, [activePlan, targetFootprint, params, stackup]);
  const mappedVisibleLayers = useMemo(() => {
    if (!visualStack) return layerVisibility;
    const res = { ...layerVisibility };
    visualStack.forEach(({ layer }) => {
        const parts = layer.id.split("_sheet_");
        if (parts.length > 1) {
             const parentId = parts[0];
             if (layerVisibility[parentId] === false) {
                 res[layer.id] = false;
             }
        }
    });
    return res;
  }, [layerVisibility, visualStack]);

  if (activePlan) {
    return (
      <div className="fab-editor-layout">
        <div className="fab-settings-panel">
            <header className="fab-header">
                <button className="secondary" onClick={() => setActivePlanId(null)}>← Back</button>
                <h2>{activePlan.name}</h2>
            </header>

            <div className="prop-group">
                <label>Plan Name</label>
                <input type="text" value={activePlan.name} onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {...p, name: e.target.value} : p))} />
            </div>
            <div className="prop-group">
                <label>Target Footprint</label>
                <select value={activePlan.footprintId} onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {...p, footprintId: e.target.value} : p))}>
                    <option value="" disabled>Select...</option>
                    {footprints.map(fp => ( <option key={fp.id} value={fp.id}>{fp.name}</option> ))}
                </select>
            </div>
            <div className="prop-section" style={{ marginTop: '20px' }}>
                <h4>Bill of Materials (BOM)</h4>
                <table className="unified-editor-table" style={{ fontSize: '0.85em' }}>
                    <thead>
                        <tr>
                            <th style={{ width: '40%' }}>Item</th>
                            <th>Notes</th>
                        </tr>
                    </thead>
                    <tbody>
                        {bomEntries.map((item, idx) => (
                            <tr key={idx}>
                                <td style={{ whiteSpace: 'normal', fontWeight: 'bold' }}>{item.name}</td>
                                <td style={{ whiteSpace: 'normal', color: '#aaa' }}>{item.notes}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {bomEntries.length === 0 && <div className="empty-hint" style={{textAlign:'center', padding:'10px'}}>No items marked for BOM.</div>}
            </div>

            <div className="fab-layers-list">
                <h3>Layer Strategies</h3>
                {stackup.map(layer => {
                    const { method, exportText, numSheets, actualThickness, delta, progThickness } = getLayerStats(layer);
                    const settings = activePlan.waterlineSettings[layer.id] || { sheetThicknessExpression: "3", startSide: "Cut side", rounding: "Round up" };
                    
                    const isVisible = layerVisibility[layer.id] !== false;
                    
                    const volMm3 = layerVolumes[layer.id] || 0;
                    const volCm3 = volMm3 / 1000;

                    const splitSettings = (activePlan as any).layerSplitSettings?.[layer.id] || { enabled: false };
                    const availableSplitLines = targetFootprint?.shapes.filter(s => s.type === "splitLine") || [];

                    return (
                        <div key={layer.id} className="fab-layer-card" style={{ opacity: isVisible ? 1 : 0.6 }}>
                            <div className="fab-layer-title">
                                <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                                <strong>{layer.name}</strong>
                                <span className="thickness-tag">{progThickness.toFixed(2)}mm</span>
                                <button 
                                    className="vis-toggle-btn" 
                                    style={{ 
                                        marginLeft: '10px', 
                                        padding: '2px 8px', 
                                        fontSize: '0.7em',
                                        backgroundColor: isVisible ? '#3b5b9d' : '#444'
                                    }}
                                    onClick={() => toggleLayerVisibility(layer.id)}
                                >
                                    {isVisible ? "Hide" : "Show"}
                                </button>
                            </div>

                            <select 
                                value={method}
                                onChange={(e) => updatePlanLayer(layer.id, "layerMethods", e.target.value)}
                            >
                                {layer.type === "Cut" ? <option value="Laser cut">Laser cut (DXF)</option> : 
                                <>
                                    <option value="CNC">CNC</option>
                                    <option value="Waterline laser cut">Waterline laser cut</option>
                                    <option value="3D printed">3D printed (STL)</option>
                                </>}
                            </select>

                            {method === "CNC" && (
                                <div className="cnc-parameters-grid">
                                    <div className="cnc-prop">
                                        <label>Stock Depth</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.stockDepthExpression || DEFAULT_CNC.stockDepthExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "stockDepthExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Tool Dia</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.toolDiameterExpression || DEFAULT_CNC.toolDiameterExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "toolDiameterExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Tool Length</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.toolLengthExpression || DEFAULT_CNC.toolLengthExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "toolLengthExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Chuck Dia</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.chuckDiameterExpression || DEFAULT_CNC.chuckDiameterExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "chuckDiameterExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Step-down</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.stepDownExpression || DEFAULT_CNC.stepDownExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "stepDownExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Step-over</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.stepOverExpression || DEFAULT_CNC.stepOverExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "stepOverExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Feedrate</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.feedrateExpression || DEFAULT_CNC.feedrateExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "feedrateExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                    <div className="cnc-prop">
                                        <label>Spindle RPM</label>
                                        <ExpressionEditor 
                                            value={activePlan.cncSettings?.[layer.id]?.spindleRpmExpression || DEFAULT_CNC.spindleRpmExpression} 
                                            onChange={(val) => updateCNCSetting(layer.id, "spindleRpmExpression", val)} 
                                            params={params} 
                                        />
                                    </div>
                                </div>
                            )}

                            {method === "Waterline laser cut" && (
                                <div className="waterline-mini-settings">
                                    <label>Sheet thickness</label>
                                    <ExpressionEditor 
                                        value={settings.sheetThicknessExpression} 
                                        onChange={(val) => updateWaterlineSetting(layer.id, "sheetThicknessExpression", val)} 
                                        params={params} 
                                    />
                                    <div className="waterline-summary">
                                        {numSheets} sheets → {actualThickness.toFixed(2)}mm 
                                        <span className={delta < 0 ? "error" : "success"}>({delta >= 0 ? '+' : ''}{delta.toFixed(2)})</span>
                                    </div>
                                    {/* Order toggle */}
                                    <div style={{marginTop: '5px'}}>
                                        <select 
                                            style={{fontSize: '0.9em', padding: '2px'}}
                                            value={settings.startSide}
                                            onChange={(e) => updateWaterlineSetting(layer.id, "startSide", e.target.value)}
                                        >
                                            <option value="Cut side">Start from Cut Side (Top)</option>
                                            <option value="Back side">Start from Back Side (Bottom)</option>
                                        </select>
                                    </div>
                                </div>
                            )}

                            {method === "3D printed" && availableSplitLines.length > 0 && (
                                <div className="waterline-mini-settings">
                                    <label className="checkbox-label" style={{ fontWeight: 'bold' }}>
                                        <input 
                                            type="checkbox" 
                                            checked={!!splitSettings.enabled} 
                                            onChange={(e) => updateSplitSettings(layer.id, { enabled: e.target.checked })} 
                                        />
                                        Split into Parts
                                    </label>
                                    {splitSettings.enabled && (
                                        <div style={{ paddingLeft: '22px', marginBottom: '5px' }}>
                                            <label style={{ fontSize: '0.8em', color: '#888' }}>Cut Kerf (mm)</label>
                                            <input 
                                                type="number" step="0.1" 
                                                style={{ width: '60px', marginLeft: '8px', background:'#333', border:'1px solid #555', color:'white', fontSize:'0.9em' }}
                                                value={splitSettings.kerf || "0.5"}
                                                onChange={(e) => updateSplitSettings(layer.id, { kerf: e.target.value })}
                                            />
                                        </div>
                                    )}
                                    {splitSettings.enabled && (
                                        <div style={{ marginTop: '8px', paddingLeft: '5px' }}>
                                            <label style={{ fontSize: '0.85em', color: '#888' }}>Active Split Lines:</label>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
                                                {availableSplitLines.map(sl => {
                                                    const isSelected = !splitSettings.lineIds || splitSettings.lineIds.includes(sl.id);
                                                    return (
                                                        <label key={sl.id} className="checkbox-label" style={{ fontSize: '0.85em' }}>
                                                            <input 
                                                                type="checkbox" 
                                                                checked={isSelected} 
                                                                onChange={(e) => {
                                                                    const current = splitSettings.lineIds || availableSplitLines.map(s => s.id);
                                                                    let next;
                                                                    if (e.target.checked) next = [...current, sl.id];
                                                                    else next = current.filter((id: string) => id !== sl.id);
                                                                    updateSplitSettings(layer.id, { enabled: true, lineIds: next });
                                                                }} 
                                                            />
                                                            {sl.name}
                                                        </label>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {(() => {
                                const currentMaterial = activePlan.layerMaterials?.[layer.id] || 
                                    Object.keys(MATERIAL_DATA).find(m => MATERIAL_DATA[m].methods.includes(method)) || "";
                                const availableMaterials = Object.keys(MATERIAL_DATA).filter(m => MATERIAL_DATA[m].methods.includes(method));
                                const density = MATERIAL_DATA[currentMaterial]?.density || 0;
                                const mass = volCm3 * density;
                                
                                return (
                                    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #444', display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '0.9em' }}>
                                        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                                            <span style={{color:'#888'}}>Volume:</span>
                                            <span style={{fontFamily:'monospace'}}>{volCm3.toFixed(2)} cm³</span>
                                        </div>
                                        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                                            <select 
                                                value={currentMaterial}
                                                onChange={(e) => updatePlanLayer(layer.id, "layerMaterials", e.target.value)}
                                                style={{ width: '60%', padding: '2px', fontSize: '0.9em', background: '#222', border: '1px solid #555', color: '#ccc' }}
                                            >
                                                {availableMaterials.map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                            <span style={{fontWeight:'bold', color: '#646cff'}}>{mass.toFixed(1)} g</span>
                                        </div>
                                    </div>
                                );
                            })()}
                            <div className="fab-hint">{exportText}</div>
                        </div>
                    );
                })}
            </div>

            <footer className="fab-footer">
                <div className="summary">
                    {isExporting ? exportProgress : `Ready to export ${totalFiles} files`}
                </div>
                <button 
                    className="primary" 
                    onClick={handleBulkExport}
                    disabled={isExporting || !targetFootprint}
                >
                    {isExporting ? "Exporting..." : "Export Folder"}
                </button>
            </footer>
        </div>

        <div className="fab-preview-panel">
            {targetFootprint ? (
                <>
                    {isComputingVisuals && (
                        <div style={{
                            position: 'absolute', top: 20, right: 20, zIndex: 10,
                            background: 'rgba(0,0,0,0.6)', color: 'white', padding: '5px 10px', borderRadius: '4px'
                        }}>
                            Updating Preview...
                        </div>
                    )}
                    <Footprint3DView 
                        ref={view3DRef}
                        footprint={targetFootprint}
                        allFootprints={footprints}
                        params={renderParams}
                        stackup={stackup}
                        meshAssets={meshAssets}
                        is3DActive={true}
                        visibleLayers={mappedVisibleLayers}
                        selectedId={null} 
                        onSelect={() => {}}
                        onUpdateMesh={() => {}}
                        onLayerVolumeCalculated={(id, vol) => setLayerVolumes(prev => ({...prev, [id]: vol}))}
                        toolpaths={Object.values(activeToolpaths).flat()}
                        customStack={visualStack}
                        layerSplitSettings={(activePlan as any).layerSplitSettings}
                />
                </>
            ) : (
                <div className="empty-preview">
                    <p>Select a target footprint to preview the stackup</p>
                </div>
            )}
        </div>
      </div>
    );
  }

  return (
    <div className="editor-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>Fabrication Plan Library</h2>
        <button onClick={addPlan}>+ Create New Plan</button>
      </div>

      <table className="unified-editor-table">
        <thead>
          <tr>
            <th className="col-grip"></th>
            <th className="col-type">Type</th>
            <th className="col-name">Plan Name</th>
            <th className="col-info">Target Footprint</th>
            <th className="col-info-wide">Layers</th>
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody onDragLeave={() => setDragOverIndex(null)}>
          {fabPlans.map((plan, index) => {
            const targetFp = footprints.find(f => f.id === plan.footprintId);
            return (
              <tr key={plan.id} draggable
                onDragStart={(e) => { dragItemIndex.current = index; e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); setDragOverIndex(index); }}
                onDrop={(e) => {
                    e.preventDefault();
                    if (dragItemIndex.current !== null) handleReorder(dragItemIndex.current, index);
                    setDragOverIndex(null);
                }}
                onClick={() => setActivePlanId(plan.id)}
                className={`footprint-row ${dragOverIndex === index ? "drag-over" : ""}`}
              >
                <td className="col-grip drag-handle-cell"><IconGrip /></td>
                <td className="col-type" style={{ textAlign: "center", color: '#888' }}><IconOutline size={18} /></td>
                <td className="col-name" style={{ fontWeight: 'bold' }}>{plan.name}</td>
                <td className="col-info">{targetFp?.name || "None"}</td>
                <td className="col-info-wide">{stackup.length}</td>
                <td className="col-actions actions-cell">
                  <button className="danger icon-btn" onClick={(e) => { e.stopPropagation(); setFabPlans(fabPlans.filter(p => p.id !== plan.id)); }}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}