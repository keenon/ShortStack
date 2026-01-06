// src/components/ParametersEditor.tsx
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Parameter } from "../types";

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
      value: 0,
      unit: "mm", // Default unit
    };
    setParams([...params, newParam]);
  }

  // ACTION: Update a specific row
  function updateRow(
    id: string,
    field: keyof Parameter,
    newValue: string | number
  ) {
    setParams((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, [field]: newValue } : item
      )
    );
  }

  // ACTION: Delete a row
  function deleteRow(id: string) {
    setParams((prev) => prev.filter((item) => item.id !== id));
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
        const valueRaw = cols[3].trim(); // Value column is index 3
        
        const val = parseFloat(valueRaw);
        if (isNaN(val)) return;

        // Sanitize Key to be a valid variable name
        const cleanKey = name.replace(/[^a-zA-Z0-9_]/g, "_");
        
        newItems.push({
            id: crypto.randomUUID(),
            key: cleanKey,
            value: val,
            unit: unitRaw === "in" ? "in" : "mm"
        });
      });

      if (newItems.length > 0) {
          // Merge strategy: Update existing keys, append new ones
          setParams(prev => {
              const next = [...prev];
              newItems.forEach(item => {
                  const idx = next.findIndex(p => p.key === item.key);
                  if (idx !== -1) {
                      // Update existing
                      next[idx] = { ...next[idx], value: item.value, unit: item.unit };
                  } else {
                      // Append new
                      next.push(item);
                  }
              });
              return next;
          });
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
            // Reconstruct a simple expression string (e.g., "10 mm")
            const expr = `${p.value} ${p.unit}`;
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
            <th>Value</th>
            <th style={{ width: "100px" }}>Unit</th>
            <th style={{ width: "50px" }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {params.map((item) => (
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
                <input
                  type="number"
                  value={item.value}
                  onChange={(e) =>
                    updateRow(item.id, "value", Number(e.target.value))
                  }
                />
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
          ))}
        </tbody>
      </table>

      <button className="add-btn" onClick={addRow}>
        + Add Parameter
      </button>
    </div>
  );
}