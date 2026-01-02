// src/components/FootprintLibrary.tsx
import { useState, useRef } from "react";
import { Footprint, Parameter, StackupLayer, MeshAsset } from "../types";
import FootprintEditor from "./FootprintEditor";
import { IconOutline, IconFootprint } from "./Icons";
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
  // CHANGED: Use a stack for navigation to support "jumping into" footprints
  const [editStack, setEditStack] = useState<string[]>([]);

  // --- TOOLTIP STATE ---
  // Store initial position in state to prevent "jumping" on first render
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // --- ACTIONS ---

  const addFootprint = () => {
    const newFp: Footprint = {
      id: crypto.randomUUID(),
      name: "New Footprint",
      shapes: [],
    };
    setFootprints([...footprints, newFp]);
    setEditStack([newFp.id]); // Auto-open
  };

  const deleteFootprint = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm("Are you sure you want to delete this footprint?")) {
      setFootprints((prev) => prev.filter((fp) => fp.id !== id));
      if (editStack.includes(id)) setEditStack([]);
    }
  };

  const handleFootprintUpdate = (updatedFootprint: Footprint) => {
    setFootprints((prev) =>
      prev.map((fp) => (fp.id === updatedFootprint.id ? updatedFootprint : fp))
    );
  };

  // NEW: Reorder Footprints
  const moveFootprint = (e: React.MouseEvent, index: number, direction: -1 | 1) => {
    e.stopPropagation(); // Prevent opening the editor when clicking move buttons
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === footprints.length - 1) return;

    const newFootprints = [...footprints];
    const targetIndex = index + direction;
    const temp = newFootprints[index];
    newFootprints[index] = newFootprints[targetIndex];
    newFootprints[targetIndex] = temp;

    setFootprints(newFootprints);
  };

  // --- TOOLTIP HANDLERS ---
  const handleIconMouseEnter = (e: React.MouseEvent, text: string) => {
    // Set initial position immediately to avoid first-frame jump
    setTooltip({ 
        text, 
        x: e.clientX + 15, 
        y: e.clientY + 15 
    });
  };

  const handleIconMouseLeave = () => {
    setTooltip(null);
  };

  const handleIconMouseMove = (e: React.MouseEvent) => {
    if (tooltipRef.current) {
      // Update position directly via ref for performance during movement
      tooltipRef.current.style.left = `${e.clientX + 15}px`;
      tooltipRef.current.style.top = `${e.clientY + 15}px`;
    }
  };

  // --- DERIVED STATE ---
  const activeId = editStack.length > 0 ? editStack[editStack.length - 1] : null;
  const activeFootprint = footprints.find((fp) => fp.id === activeId);

  // --- RENDER: EDITOR VIEW ---
  if (activeFootprint) {
    return (
      <FootprintEditor
        footprint={activeFootprint}
        allFootprints={footprints} 
        onUpdate={handleFootprintUpdate}
        // Take user back one step in the stack
        onClose={() => setEditStack(prev => prev.slice(0, -1))}
        // Jump deeper into the stack
        onEditChild={(id) => setEditStack(prev => [...prev, id])}
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
            <th style={{ width: "60px" }}>Type</th>
            <th>Footprint Name</th>
            <th style={{ width: "100px" }}>Shapes</th>
            <th style={{ width: "160px" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {footprints.map((fp, index) => (
            <tr 
              key={fp.id} 
              onClick={() => setEditStack([fp.id])}
              className="footprint-row"
            >
              <td style={{ textAlign: "center", verticalAlign: "middle" }}>
                <div 
                  className="type-icon-wrapper"
                  onMouseEnter={(e) => handleIconMouseEnter(e, fp.isBoard ? "Standalone Board" : "Component Footprint")}
                  onMouseLeave={handleIconMouseLeave}
                  onMouseMove={handleIconMouseMove}
                >
                    {fp.isBoard ? (
                      <div style={{ color: "#646cff", display: "flex", justifyContent: "center" }}>
                        <IconOutline size={18} />
                      </div>
                    ) : (
                      <div style={{ color: "#888", display: "flex", justifyContent: "center" }}>
                        <IconFootprint size={18} />
                      </div>
                    )}
                </div>
              </td>
              <td className="name-cell">
                {fp.name}
              </td>
              <td>{fp.shapes.length}</td>
              <td className="actions-cell">
                <div className="action-buttons">
                  <button 
                    className="icon-btn btn-up" 
                    onClick={(e) => moveFootprint(e, index, -1)}
                    disabled={index === 0}
                    title="Move Up"
                  >
                    ↑
                  </button>
                  <button 
                    className="icon-btn btn-down" 
                    onClick={(e) => moveFootprint(e, index, 1)}
                    disabled={index === footprints.length - 1}
                    title="Move Down"
                  >
                    ↓
                  </button>
                  <button
                    className="danger icon-btn"
                    onClick={(e) => deleteFootprint(fp.id, e)}
                    title="Delete Footprint"
                  >
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {footprints.length === 0 && (
              <tr><td colSpan={4} style={{textAlign:'center', color:'#666'}}>No footprints yet.</td></tr>
          )}
        </tbody>
      </table>
      <button className="add-btn" onClick={addFootprint}>
        + New Footprint
      </button>
      
      {/* TOOLTIP ELEMENT */}
      {tooltip && (
        <div 
            ref={tooltipRef} 
            className="custom-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}