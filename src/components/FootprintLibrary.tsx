// src/components/FootprintLibrary.tsx
import React, { useState } from "react";
import { Footprint, Parameter, StackupLayer, MeshAsset } from "../types";
import FootprintEditor from "./FootprintEditor";
import './FootprintLibrary.css';

interface Props {
  footprints: Footprint[];
  setFootprints: React.Dispatch<React.SetStateAction<Footprint[]>>;
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
  onRegisterMesh: (asset: MeshAsset) => void;
}

export default function FootprintLibrary({ footprints, setFootprints, params, stackup, meshAssets, onRegisterMesh }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);

  // --- ACTIONS ---

  const addFootprint = () => {
    const newFp: Footprint = {
      id: crypto.randomUUID(),
      name: "New Footprint",
      shapes: [],
    };
    setFootprints([...footprints, newFp]);
    setEditingId(newFp.id); // Auto-open
  };

  const deleteFootprint = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Are you sure you want to delete this footprint?")) {
      setFootprints((prev) => prev.filter((fp) => fp.id !== id));
      if (editingId === id) setEditingId(null);
    }
  };

  const updateFootprintName = (id: string, name: string) => {
    setFootprints((prev) =>
      prev.map((fp) => (fp.id === id ? { ...fp, name } : fp))
    );
  };

  const handleFootprintUpdate = (updatedFootprint: Footprint) => {
    setFootprints((prev) =>
      prev.map((fp) => (fp.id === updatedFootprint.id ? updatedFootprint : fp))
    );
  };

  // --- DERIVED STATE ---
  const activeFootprint = footprints.find((fp) => fp.id === editingId);

  // --- RENDER: EDITOR VIEW ---
  if (activeFootprint) {
    return (
      <FootprintEditor
        footprint={activeFootprint}
        allFootprints={footprints} 
        onUpdate={handleFootprintUpdate}
        onClose={() => setEditingId(null)}
        params={params}
        stackup={stackup}
        meshAssets={meshAssets}
        onRegisterMesh={onRegisterMesh}
      />
    );
  }

  // --- RENDER: LIST VIEW ---
  return (
    <div className="editor-content">
      <h2>Footprint Library</h2>
      <table className="footprint-list">
        <thead>
          <tr>
            <th>Footprint Name</th>
            <th style={{ width: "100px" }}>Shapes</th>
            <th style={{ width: "220px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {footprints.map((fp) => (
            <tr key={fp.id}>
              <td>
                <input
                  type="text"
                  value={fp.name}
                  onChange={(e) => updateFootprintName(fp.id, e.target.value)}
                />
              </td>
              <td>{fp.shapes.length}</td>
              <td className="actions-cell">
                <button
                  className="edit-btn"
                  onClick={() => setEditingId(fp.id)}
                >
                  Edit
                </button>
                <button
                  className="danger icon-btn"
                  onClick={(e) => deleteFootprint(fp.id, e)}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {footprints.length === 0 && (
              <tr><td colSpan={3} style={{textAlign:'center', color:'#666'}}>No footprints yet.</td></tr>
          )}
        </tbody>
      </table>
      <button className="add-btn" onClick={addFootprint}>
        + New Footprint
      </button>
    </div>
  );
}