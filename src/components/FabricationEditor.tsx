// src/components/FabricationEditor.tsx
import { useState, useRef } from "react";
import { FabricationPlan, Footprint, StackupLayer, FabricationMethod } from "../types";
import { IconOutline } from "./Icons";

const IconGrip = ({ className }: { className?: string }) => (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 3H11V21H9V3ZM13 3H15V21H13V3Z" />
    </svg>
);

interface Props {
  fabPlans: FabricationPlan[];
  setFabPlans: React.Dispatch<React.SetStateAction<FabricationPlan[]>>;
  footprints: Footprint[];
  stackup: StackupLayer[];
}

export default function FabricationEditor({ fabPlans, setFabPlans, footprints, stackup }: Props) {
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const activePlan = fabPlans.find(p => p.id === activePlanId);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemIndex = useRef<number | null>(null);

  const addPlan = () => {
    const newPlan: FabricationPlan = { id: crypto.randomUUID(), name: "New Fabrication Plan", footprintId: footprints.length > 0 ? footprints[0].id : "", layerMethods: {} };
    setFabPlans([...fabPlans, newPlan]);
    setActivePlanId(newPlan.id);
  };

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
      <div className="editor-content">
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '20px' }}>
          <button className="secondary" onClick={() => setActivePlanId(null)}>← Back to Library</button>
          <h2 style={{ margin: 0 }}>Edit Plan: {activePlan.name}</h2>
        </div>

        <div className="row" style={{ marginBottom: '20px' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Plan Name</label>
            <input type="text" value={activePlan.name} onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {...p, name: e.target.value} : p))} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Target Footprint</label>
            <select value={activePlan.footprintId} onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? {...p, footprintId: e.target.value} : p))}>
              <option value="" disabled>Select Footprint...</option>
              {footprints.map(fp => ( <option key={fp.id} value={fp.id}>{fp.name}</option> ))}
            </select>
          </div>
        </div>

        <h3>Layer Fabrication Strategy</h3>
        <table>
          <thead>
            <tr>
              <th style={{ width: '40px' }}></th>
              <th>Layer Name</th>
              <th>Type</th>
              <th>Fabrication Method</th>
            </tr>
          </thead>
          <tbody>
            {stackup.map(layer => (
              <tr key={layer.id}>
                <td><div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: layer.color }} /></td>
                <td>{layer.name}</td>
                <td style={{ color: '#888', fontSize: '0.9em' }}>{layer.type}</td>
                <td>
                  <select 
                    value={activePlan.layerMethods[layer.id] || (layer.type === "Cut" ? "Laser cut" : "CNC")}
                    onChange={(e) => setFabPlans(prev => prev.map(p => p.id === activePlan.id ? 
                        {...p, layerMethods: {...p.layerMethods, [layer.id]: e.target.value as FabricationMethod}} : p))}
                  >
                    {layer.type === "Cut" ? <option value="Laser cut">Laser cut</option> : 
                    <><option value="CNC">CNC</option><option value="Waterline laser cut">Waterline laser cut</option><option value="3D printed">3D printed</option></>}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
              <tr 
                key={plan.id} 
                draggable
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
          {/* BOTTOM DROP TARGET */}
          {fabPlans.length > 0 && (
            <tr
                onDragOver={(e) => { e.preventDefault(); setDragOverIndex(fabPlans.length); }}
                onDrop={(e) => {
                    e.preventDefault();
                    if (dragItemIndex.current !== null) handleReorder(dragItemIndex.current, fabPlans.length);
                    setDragOverIndex(null);
                }}
                className={`drop-zone-row ${dragOverIndex === fabPlans.length ? "drag-over" : ""}`}
            >
                <td colSpan={6}></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}