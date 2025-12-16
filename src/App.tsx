import { useState, useEffect } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./App.css";

// Define the shape of our data
interface Parameter {
  id: string; // Unique ID for React rendering
  key: string;
  value: number;
}

function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [params, setParams] = useState<Parameter[]>([]);

  // AUTO-SAVE: Whenever 'params' changes, write to file if we have a path
  useEffect(() => {
    if (!currentPath) return;

    const saveData = async () => {
      try {
        // We strip the 'id' before saving to keep the JSON clean, 
        // or keep it if you want the ID to persist.
        const content = JSON.stringify(params, null, 2);
        await writeTextFile(currentPath, content);
        console.log("Auto-saved to", currentPath);
      } catch (err) {
        console.error("Failed to auto-save", err);
      }
    };

    // specific delay/debounce could be added here if the table gets huge
    saveData();
  }, [params, currentPath]);

  // ACTION: Create a new project file
  async function createProject() {
    try {
      const path = await save({
        filters: [{ name: "Project JSON", extensions: ["json"] }],
      });
      
      if (path) {
        // Initialize with empty array
        await writeTextFile(path, "[]"); 
        setParams([]);
        setCurrentPath(path);
      }
    } catch (err) {
      console.error(err);
    }
  }

  // ACTION: Load an existing project
  async function loadProject() {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Project JSON", extensions: ["json"] }],
      });

      if (path) {
        const content = await readTextFile(path as string);
        const data = JSON.parse(content);
        
        // Ensure data has IDs for React (if the JSON is just keys/values)
        // If your JSON saves IDs, you don't need to generate new ones.
        const dataWithIds = data.map((item: any) => ({
          ...item,
          id: item.id || crypto.randomUUID()
        }));

        setParams(dataWithIds);
        setCurrentPath(path as string);
      }
    } catch (err) {
      console.error(err);
      alert("Failed to load file. Is it valid JSON?");
    }
  }

  // ACTION: Add a new row
  function addRow() {
    const newParam: Parameter = {
      id: crypto.randomUUID(),
      key: "New Parameter",
      value: 0
    };
    setParams([...params, newParam]);
  }

  // ACTION: Update a specific row
  function updateRow(id: string, field: "key" | "value", newValue: string | number) {
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

  // ACTION: Close project
  function closeProject() {
    setCurrentPath(null);
    setParams([]);
  }

  // VIEW: 1. Welcome Screen
  if (!currentPath) {
    return (
      <div className="container welcome-screen">
        <h1>Project Manager</h1>
        <div className="row">
          <button onClick={createProject}>Create New Project</button>
          <button onClick={loadProject}>Load Existing Project</button>
        </div>
      </div>
    );
  }

  // VIEW: 2. Parameter Editor
  return (
    <div className="container editor-screen">
      <header className="editor-header">
        <div className="file-info">
          <span>Editing: <strong>{currentPath}</strong></span>
        </div>
        <button className="secondary" onClick={closeProject}>Close Project</button>
      </header>

      <main>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
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
                    onChange={(e) => updateRow(item.id, "key", e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={item.value}
                    onChange={(e) => updateRow(item.id, "value", Number(e.target.value))}
                  />
                </td>
                <td>
                  <button className="danger" onClick={() => deleteRow(item.id)}>X</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        <button className="add-btn" onClick={addRow}>+ Add Parameter</button>
      </main>
    </div>
  );
}

export default App;