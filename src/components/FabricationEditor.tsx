// src/components/FabricationEditor.tsx
import { useState, useRef, useMemo } from "react";
import { FabricationPlan, Footprint, StackupLayer, FabricationMethod, Parameter, WaterlineSettings, MeshAsset } from "../types";
import { IconOutline, IconGrip } from "./Icons";
import ExpressionEditor from "./ExpressionEditor";
import { evaluateExpression } from "../utils/footprintUtils";
// Import the 3D View
import Footprint3DView, { Footprint3DViewHandle } from "./Footprint3DView";
import "./FabricationEditor.css";

interface Props {
  fabPlans: FabricationPlan[];
  setFabPlans: React.Dispatch<React.SetStateAction<FabricationPlan[]>>;
  footprints: Footprint[];
  stackup: StackupLayer[];
  params: Parameter[];
  meshAssets: MeshAsset[]; // Added to props
}

export default function FabricationEditor({ fabPlans, setFabPlans, footprints, stackup, params, meshAssets }: Props) {
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const activePlan = fabPlans.find(p => p.id === activePlanId);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemIndex = useRef<number | null>(null);
  
  // Ref for 3D View to handle STL exports later
  const view3DRef = useRef<Footprint3DViewHandle>(null);

  // Identify the target footprint for the 3D viewer
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
    if (!activePlan) return { method: "Laser cut" as FabricationMethod, numFiles: 1, exportText: "", numSheets: 0, actualThickness: 0, delta: 0, progThickness: 0 };
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
    let numFiles = 1;
    let exportText = method === "Waterline laser cut" ? `Exports ${numSheets} DXF cuts` : (method === "CNC" ? "Exports SVG depth" : "Single file");
    return { method, numFiles, exportText, numSheets, actualThickness, delta, progThickness };
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

  if (activePlan) {
    return (
      <div className="fab-editor-layout">
        {/* LEFT SIDE: Settings */}
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
                                {layer.type === "Cut" ? <option value="Laser cut">Laser cut</option> : 
                                <>
                                    <option value="CNC">CNC</option>
                                    <option value="Waterline laser cut">Waterline laser cut</option>
                                    <option value="3D printed">3D printed</option>
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
                                </div>
                            )}
                            <div className="fab-hint">{exportText}</div>
                        </div>
                    );
                })}
            </div>

            <footer className="fab-footer">
                <div className="summary">Exports <strong>{totalFiles} files</strong></div>
                <button className="primary" onClick={() => alert("Bulk export coming soon!")}>Export Folder</button>
            </footer>
        </div>

        {/* RIGHT SIDE: 3D Preview */}
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
                    selectedId={null} // Read-only mode for fab
                    onSelect={() => {}}
                    onUpdateMesh={() => {}}
                />
            ) : (
                <div className="empty-preview">
                    <p>Select a footprint to preview stackup</p>
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