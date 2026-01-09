// src/components/FabricationEditor.tsx
import { useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { 
    FabricationPlan, 
    Footprint, 
    StackupLayer, 
    FabricationMethod, 
    Parameter, 
    WaterlineSettings, 
    MeshAsset, 
    FootprintBoardOutline 
} from "../types";
import { IconOutline, IconGrip } from "./Icons";
import ExpressionEditor from "./ExpressionEditor";
import { evaluateExpression, resolvePoint } from "../utils/footprintUtils";
import { collectExportShapesAsync, sliceExportShapes } from "../utils/exportUtils";
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import "./FabricationEditor.css";

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
  
  const activePlan = fabPlans.find(p => p.id === activePlanId);
  const dragItemIndex = useRef<number | null>(null);
  const view3DRef = useRef<Footprint3DViewHandle>(null);

  const targetFootprint = useMemo(() => {
    return footprints.find(fp => fp.id === activePlan?.footprintId);
  }, [activePlan, footprints]);

  const addPlan = () => {
    const newPlan: FabricationPlan = { 
        id: crypto.randomUUID(), 
        name: "New Fabrication Plan", 
        footprintId: footprints.length > 0 ? footprints[0].id : "", 
        layerMethods: {},
        waterlineSettings: {} 
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
                    { ...layer, type: "Carved/Printed" }, // Force carved to get depths
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
                    const rawStl = view3DRef.current?.getLayerSTL(layer.id);
                    if (rawStl) {
                        stl_content = Array.from(rawStl);
                    } else {
                        console.error(`Failed to get STL for layer ${layer.name}`);
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

            <div className="fab-layers-list">
                <h3>Layer Strategies</h3>
                {stackup.map(layer => {
                    const { method, exportText, numSheets, actualThickness, delta, progThickness } = getLayerStats(layer);
                    const settings = activePlan.waterlineSettings[layer.id] || { sheetThicknessExpression: "3", startSide: "Cut side", rounding: "Round up" };
                    
                    return (
                        <div key={layer.id} className="fab-layer-card">
                            <div className="fab-layer-title">
                                <div className="layer-color-badge" style={{ backgroundColor: layer.color }} />
                                <strong>{layer.name}</strong>
                                <span className="thickness-tag">{progThickness.toFixed(2)}mm</span>
                            </div>

                            <select 
                                value={method}
                                onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? 
                                    {...p, layerMethods: {...p.layerMethods, [layer.id]: e.target.value as FabricationMethod}} : p))}
                            >
                                {layer.type === "Cut" ? <option value="Laser cut">Laser cut (DXF)</option> : 
                                <>
                                    <option value="CNC">CNC (SVG Depth Map)</option>
                                    <option value="Waterline laser cut">Waterline laser cut</option>
                                    <option value="3D printed">3D printed (STL)</option>
                                </>}
                            </select>

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
                <Footprint3DView 
                    ref={view3DRef}
                    footprint={targetFootprint}
                    allFootprints={footprints}
                    params={params}
                    stackup={stackup}
                    meshAssets={meshAssets}
                    is3DActive={true}
                    selectedId={null} 
                    onSelect={() => {}}
                    onUpdateMesh={() => {}}
                />
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