// src/components/StackupEditor.tsx
import React from "react";
// Removed mathjs import as it's now handled in ExpressionEditor
import { Parameter, StackupLayer, ManufacturingType } from "../types";
import ExpressionEditor from "./ExpressionEditor";

// Tableau 10 Color Palette
const TABLEAU_10 = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", 
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"
];

interface Props {
  stackup: StackupLayer[];
  setStackup: React.Dispatch<React.SetStateAction<StackupLayer[]>>;
  params: Parameter[];
}

export default function StackupEditor({ stackup, setStackup, params }: Props) {
  
  // 1. ADD ROW
  function addRow() {
    const nextColorIndex = stackup.length % TABLEAU_10.length;
    const newLayer: StackupLayer = {
      id: crypto.randomUUID(),
      name: "New Layer",
      type: "Cut",
      thicknessExpression: "0",
      color: TABLEAU_10[nextColorIndex],
      carveSide: "Top",
    };
    setStackup([...stackup, newLayer]);
  }

  // 2. UPDATE ROW
  function updateRow(id: string, field: keyof StackupLayer, value: any) {
    setStackup((prev) =>
      prev.map((layer) => (layer.id === id ? { ...layer, [field]: value } : layer))
    );
  }

  // 3. DELETE ROW
  function deleteRow(id: string) {
    setStackup((prev) => prev.filter((layer) => layer.id !== id));
  }

  // 4. MOVE ROW
  function moveRow(index: number, direction: -1 | 1) {
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === stackup.length - 1) return;

    const newStackup = [...stackup];
    const targetIndex = index + direction;

    const temp = newStackup[index];
    newStackup[index] = newStackup[targetIndex];
    newStackup[targetIndex] = temp;

    setStackup(newStackup);
  }

  return (
    <div className="editor-content">
      <h2>Stackup Editor</h2>
      <table>
        <thead>
          <tr>
            <th style={{ width: "60px" }}>Color</th>
            <th style={{ width: "25%" }}>Name</th>
            <th style={{ width: "20%" }}>Manufacturing</th>
            <th style={{ width: "35%" }}>Thickness (Expression)</th>
            <th style={{ width: "120px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {stackup.map((layer, index) => {
            return (
              <tr key={layer.id}>
                 {/* COLOR PICKER */}
                 <td style={{ verticalAlign: 'middle' }}>
                  <input
                    type="color"
                    value={layer.color}
                    onChange={(e) => updateRow(layer.id, "color", e.target.value)}
                    style={{ 
                      width: "40px", 
                      height: "40px", 
                      padding: "2px", 
                      cursor: "pointer",
                      border: "1px solid #444",
                      backgroundColor: "transparent"
                    }}
                  />
                </td>

                {/* NAME INPUT */}
                <td style={{ verticalAlign: 'top' }}>
                  <input
                    type="text"
                    value={layer.name}
                    onChange={(e) => updateRow(layer.id, "name", e.target.value)}
                  />
                </td>

                {/* DROPDOWN */}
                <td style={{ verticalAlign: 'top' }}>
                  <select
                    value={layer.type}
                    onChange={(e) =>
                      updateRow(layer.id, "type", e.target.value as ManufacturingType)
                    }
                    style={{ marginBottom: layer.type === "Carved/Printed" ? "8px" : "0" }}
                  >
                    <option value="Cut">Cut</option>
                    <option value="Carved/Printed">Carved/Printed</option>
                  </select>

                  {layer.type === "Carved/Printed" && (
                    <select
                        value={layer.carveSide}
                        onChange={(e) => updateRow(layer.id, "carveSide", e.target.value)}
                        title="Side to carve from"
                    >
                        <option value="Top">Cut into Top Side</option>
                        <option value="Bottom">Cut into Bottom Side</option>
                    </select>
                  )}
                </td>

                {/* EXPRESSION EDITOR */}
                <td>
                  <div className="thickness-cell">
                    {/* ExpressionEditor now handles evaluation display */}
                    <ExpressionEditor 
                        value={layer.thicknessExpression}
                        onChange={(val) => updateRow(layer.id, "thicknessExpression", val)}
                        params={params}
                        placeholder="e.g. Width / 2"
                    />
                  </div>
                </td>

                {/* ACTIONS */}
                <td style={{ verticalAlign: 'top' }}>
                  <div className="action-buttons">
                    <button 
                      className="icon-btn btn-up" 
                      onClick={() => moveRow(index, -1)}
                      disabled={index === 0}
                      title="Move Up"
                    >
                      ↑
                    </button>
                    <button 
                      className="icon-btn btn-down" 
                      onClick={() => moveRow(index, 1)}
                      disabled={index === stackup.length - 1}
                      title="Move Down"
                    >
                      ↓
                    </button>
                    <button 
                      className="icon-btn danger" 
                      onClick={() => deleteRow(layer.id)}
                      title="Delete Layer"
                    >
                      ✕
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <button className="add-btn" onClick={addRow}>
        + Add Layer
      </button>
    </div>
  );
}