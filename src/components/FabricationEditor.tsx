import { useState } from "react";
import { FabricationPlan, Footprint, StackupLayer, FabricationMethod } from "../types";

interface Props {
  fabPlans: FabricationPlan[];
  setFabPlans: React.Dispatch<React.SetStateAction<FabricationPlan[]>>;
  footprints: Footprint[];
  stackup: StackupLayer[];
}

export default function FabricationEditor({ fabPlans, setFabPlans, footprints, stackup }: Props) {
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

  const activePlan = fabPlans.find(p => p.id === activePlanId);

  const addPlan = () => {
    const newPlan: FabricationPlan = {
      id: crypto.randomUUID(),
      name: "New Fabrication Plan",
      footprintId: footprints.length > 0 ? footprints[0].id : "",
      layerMethods: {},
    };
    setFabPlans([...fabPlans, newPlan]);
    setActivePlanId(newPlan.id);
  };

  const deletePlan = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("Delete this fabrication plan?")) {
      setFabPlans(fabPlans.filter(p => p.id !== id));
      if (activePlanId === id) setActivePlanId(null);
    }
  };

  const updatePlan = (id: string, field: keyof FabricationPlan, value: any) => {
    setFabPlans(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const setLayerMethod = (planId: string, layerId: string, method: FabricationMethod) => {
    setFabPlans(prev => prev.map(p => {
      if (p.id !== planId) return p;
      return {
        ...p,
        layerMethods: { ...p.layerMethods, [layerId]: method }
      };
    }));
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
            <input 
              type="text" 
              value={activePlan.name} 
              onChange={(e) => updatePlan(activePlan.id, "name", e.target.value)} 
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Target Footprint</label>
            <select 
              value={activePlan.footprintId} 
              onChange={(e) => updatePlan(activePlan.id, "footprintId", e.target.value)}
            >
              <option value="" disabled>Select Footprint...</option>
              {footprints.map(fp => (
                <option key={fp.id} value={fp.id}>{fp.name}</option>
              ))}
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
            {stackup.map(layer => {
              const currentMethod = activePlan.layerMethods[layer.id];
              const effectiveMethod = currentMethod || (layer.type === "Cut" ? "Laser cut" : "CNC");

              return (
                <tr key={layer.id}>
                  <td>
                    <div style={{ width: '12px', height: '12px', borderRadius: '2px', backgroundColor: layer.color }} />
                  </td>
                  <td>{layer.name}</td>
                  <td style={{ color: '#888', fontSize: '0.9em' }}>{layer.type}</td>
                  <td>
                    <select 
                      value={effectiveMethod}
                      onChange={(e) => setLayerMethod(activePlan.id, layer.id, e.target.value as FabricationMethod)}
                    >
                      {layer.type === "Cut" ? (
                        <option value="Laser cut">Laser cut</option>
                      ) : (
                        <>
                          <option value="CNC">CNC</option>
                          <option value="Waterline laser cut">Waterline laser cut</option>
                          <option value="3D printed">3D printed</option>
                        </>
                      )}
                    </select>
                  </td>
                </tr>
              );
            })}
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

      <table>
        <thead>
          <tr>
            <th>Plan Name</th>
            <th>Target Footprint</th>
            <th style={{ width: '100px' }}>Layers</th>
            <th style={{ width: '80px' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {fabPlans.map((plan) => {
            const targetFp = footprints.find(f => f.id === plan.footprintId);
            return (
              <tr 
                key={plan.id} 
                onClick={() => setActivePlanId(plan.id)}
                style={{ cursor: 'pointer' }}
                className="footprint-row"
              >
                <td style={{ fontWeight: 'bold' }}>{plan.name}</td>
                <td>{targetFp?.name || "None"}</td>
                <td>{stackup.length}</td>
                <td>
                  <button className="danger icon-btn" onClick={(e) => { e.stopPropagation(); deletePlan(plan.id, e); }}>✕</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
