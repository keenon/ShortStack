// src/components/ParametersEditor.tsx
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Parameter } from "../types";
import { resolveParameters, dependsOn } from "../utils/footprintUtils";
import ExpressionEditor from "./ExpressionEditor";

interface Props {
  params: Parameter[];
  setParams: React.Dispatch<React.SetStateAction<Parameter[]>>;
}

export default function ParametersEditor({ params, setParams }: Props) {
  
  // ACTION: Add a new row
  function addRow() {
    const newParam: Parameter = {
      id: crypto.randomUUID(),
      key: "New_Parameter", // defaulted to underscore style
      expression: "0",
      value: 0,
      unit: "mm", // Default unit
    };
    // Recalculate immediately (though new param "0" won't affect others yet)
    setParams(resolveParameters([...params, newParam]));
  }

  // ACTION: Update a specific row
  function updateRow(
    id: string,
    field: keyof Parameter,
    newValue: string | number
  ) {
    const updatedParams = params.map((item) =>
      item.id === id ? { ...item, [field]: newValue } : item
    );
    
    // If expression or unit changed, re-resolve all dependencies
    if (field === "expression" || field === "unit") {
        setParams(resolveParameters(updatedParams));
    } else {
        setParams(updatedParams);
    }
  }

  // ACTION: Delete a row
  function deleteRow(id: string) {
    const updated = params.filter((item) => item.id !== id);
    // Resolve to ensure any dependents become error/0
    setParams(resolveParameters(updated));
  }

  // ACTION: Import CSV
  async function importCSV() {
    try {
      const path = await open({
        filters: [{ name: "CSV File", extensions: ["csv"] }],
        multiple: false
      });
      
      if (!path) return;

      const content = await readTextFile(path as string);
      const lines = content.split(/\r?\n/);
      
      const newItems: Parameter[] = [];
      
      lines.forEach((line) => {
        // Skip empty lines
        if (!line.trim()) return;
        
        const cols = line.split(",");
        
        // Basic Format: Name, Unit, Expression, Value, Comments, Favorite
        // We require Name(0) and Value(3) at minimum
        if (cols.length < 4) return;

        const name = cols[0].trim();
        // Skip Header Row
        if (name.toLowerCase() === "name") return;

        const unitRaw = cols[1].trim().toLowerCase();
        // Use Expression column if available, else Value
        const exprRaw = cols[2] && cols[2].trim() ? cols[2].trim() : cols[3].trim(); 
        
        // Sanitize Key to be a valid variable name
        const cleanKey = name.replace(/[^a-zA-Z0-9_]/g, "_");
        
        newItems.push({
            id: crypto.randomUUID(),
            key: cleanKey,
            expression: exprRaw,
            value: 0, // Will be resolved
            unit: unitRaw === "in" ? "in" : "mm"
        });
      });

      if (newItems.length > 0) {
          // Merge strategy: Update existing keys, append new ones
          const next = [...params];
          newItems.forEach(item => {
              const idx = next.findIndex(p => p.key === item.key);
              if (idx !== -1) {
                  // Update existing
                  next[idx] = { ...next[idx], expression: item.expression, unit: item.unit };
              } else {
                  // Append new
                  next.push(item);
              }
          });
          setParams(resolveParameters(next));
      }

    } catch (e) {
      console.error(e);
      alert("Failed to import CSV.");
    }
  }

  // ACTION: Export CSV
  async function exportCSV() {
    try {
        const path = await save({
            filters: [{ name: "CSV File", extensions: ["csv"] }],
            defaultPath: "parameters.csv"
        });

        if (!path) return;

        // Header matching Fusion format
        let csvContent = "Name,Unit,Expression,Value,Comments,Favorite\n";
        
        // Generate Rows
        params.forEach(p => {
            // Expression is now the source of truth
            const expr = p.expression;
            // Format value to 2 decimal places if it's a float, or keep integer string
            const valStr = Number.isInteger(p.value) ? p.value.toFixed(2) : p.value.toString();
            
            // Output row: Name, Unit, Expression, Value, Comments(empty), Favorite(false)
            csvContent += `${p.key},${p.unit},${expr},${valStr},,false\n`;
        });

        await writeTextFile(path, csvContent);

    } catch (e) {
        console.error(e);
        alert("Failed to export CSV.");
    }
  }

  return (
    <div className="editor-content">
      <h2>Parameters Editor</h2>
      
      {/* Import/Export Toolbar */}
      <div className="row" style={{ marginBottom: "15px" }}>
        <button className="secondary" onClick={importCSV}>Import CSV</button>
        <button className="secondary" onClick={exportCSV}>Export CSV</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th style={{ width: "40%" }}>Expression</th>
            <th style={{ width: "20%" }}>Resolved Value</th>
            <th style={{ width: "100px" }}>Unit</th>
            <th style={{ width: "50px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {params.map((item) => {
            // Calculate forbidden keys for this parameter (itself + anything that depends on it)
            // If P depends on item.key, then item.key cannot depend on P (Cycle).
            // Forbidden = { item.key } + { P | dependsOn(P.key, item.key) }
            // dependsOn(source, target) returns true if source->target path exists.
            // If we are editing item.key, we want to forbid adding P if P->item.key exists.
            
            const forbiddenKeys = params
                .filter(p => p.id === item.id || dependsOn(p.key, item.key, params))
                .map(p => p.key);

            return (
            <tr key={item.id}>
              <td>
                <input
                  type="text"
                  value={item.key}
                  // UPDATED: Replace any non-word character with underscore to ensure valid variable names
                  onChange={(e) => 
                    updateRow(item.id, "key", e.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))
                  }
                />
              </td>
              <td>
                <ExpressionEditor
                    value={item.expression}
                    onChange={(val) => updateRow(item.id, "expression", val)}
                    params={params}
                    placeholder="e.g. 10 or Length / 2"
                    forbiddenKeys={forbiddenKeys}
                />
              </td>
              <td>
                <span className="math-result">
                    {item.value.toFixed(4)}
                </span>
              </td>
              <td>
                <select
                  value={item.unit}
                  onChange={(e) => updateRow(item.id, "unit", e.target.value)}
                >
                  <option value="mm">mm</option>
                  <option value="in">in</option>
                </select>
              </td>
              <td>
                <button className="danger" onClick={() => deleteRow(item.id)}>
                  X
                </button>
              </td>
            </tr>
          );
          })}
        </tbody>
      </table>

      <button className="add-btn" onClick={addRow}>
        + Add Parameter
      </button>
    </div>
  );
}