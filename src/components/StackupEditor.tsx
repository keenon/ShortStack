import React from "react";
import * as math from "mathjs";
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

  // 4. MOVE ROW (New Function)
  function moveRow(index: number, direction: -1 | 1) {
    // Prevent moving out of bounds
    if (direction === -1 && index === 0) return;
    if (direction === 1 && index === stackup.length - 1) return;

    const newStackup = [...stackup];
    const targetIndex = index + direction;

    // Swap the elements
    const temp = newStackup[index];
    newStackup[index] = newStackup[targetIndex];
    newStackup[targetIndex] = temp;

    setStackup(newStackup);
  }

  // 5. EVALUATE MATH HELPER
  function evaluateThickness(expression: string) {
    if (!expression.trim()) return { value: 0, error: null };
    try {
      const scope: Record<string, any> = {};
      params.forEach((p) => {
        scope[p.key] = math.unit(p.value, p.unit);
      });
      const result = math.evaluate(expression, scope);
      let valInMm = 0;
      if (typeof result === "number") {
        valInMm = result;
      } else if (result && typeof result.toNumber === "function") {
        valInMm = result.toNumber("mm");
      } else {
        return { value: null, error: "Invalid Type" };
      }
      return { value: valInMm, error: null };
    } catch (err: any) {
      return { value: null, error: err.message };
    }
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
            {/* Increased width to fit buttons */}
            <th style={{ width: "120px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {/* Note: added 'index' to the map callback */}
          {stackup.map((layer, index) => {
            const { value, error } = evaluateThickness(layer.thicknessExpression);
            
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
                  >
                    <option value="Cut">Cut</option>
                    <option value="Carved/Printed">Carved/Printed</option>
                  </select>
                </td>

                {/* EXPRESSION EDITOR */}
                <td>
                  <div className="thickness-cell">
                    <ExpressionEditor 
                        value={layer.thicknessExpression}
                        onChange={(val) => updateRow(layer.id, "thicknessExpression", val)}
                        params={params}
                        placeholder="e.g. Width / 2"
                        hasError={!!error}
                    />
                    <div className="math-result">
                        {error ? (
                            <span style={{ color: "#ff6b6b" }}>⚠ {error}</span>
                        ) : (
                            <span style={{ color: "#51cf66" }}>
                                = {value?.toFixed(3)} mm
                            </span>
                        )}
                    </div>
                  </div>
                </td>

                {/* ACTIONS: UP / DOWN / DELETE */}
                <td style={{ verticalAlign: 'top' }}>
                  <div className="action-buttons">
                    <button 
                      className="icon-btn btn-up" 
                      onClick={() => moveRow(index, -1)}
                      disabled={index === 0} // Disable if first item
                      title="Move Up"
                    >
                      ↑
                    </button>
                    <button 
                      className="icon-btn btn-down" 
                      onClick={() => moveRow(index, 1)}
                      disabled={index === stackup.length - 1} // Disable if last item
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