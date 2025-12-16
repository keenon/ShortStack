import { useState, useEffect } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./App.css";

// Import Types
import { Parameter } from "./types";

// Import Components
import ParametersEditor from "./components/ParametersEditor";
import StackupEditor from "./components/StackupEditor";
import FootprintEditor from "./components/FootprintEditor";
import LayoutEditor from "./components/LayoutEditor";

// Tab definitions
type Tab = "stackup" | "footprint" | "layout" | "parameters";

function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [params, setParams] = useState<Parameter[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>("stackup");

  // AUTO-SAVE: Whenever 'params' changes, write to file if we have a path
  useEffect(() => {
    if (!currentPath) return;

    const saveData = async () => {
      try {
        const content = JSON.stringify(params, null, 2);
        await writeTextFile(currentPath, content);
        console.log("Auto-saved to", currentPath);
      } catch (err) {
        console.error("Failed to auto-save", err);
      }
    };
    saveData();
  }, [params, currentPath]);

  // ACTION: Create a new project file
  async function createProject() {
    try {
      const path = await save({
        filters: [{ name: "Project JSON", extensions: ["json"] }],
      });

      if (path) {
        await writeTextFile(path, "[]");
        setParams([]);
        setCurrentPath(path);
        setActiveTab("stackup"); // Default tab on new project
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

        // Sanitize data: Ensure ID and Unit exist for older files
        const dataWithIds = data.map((item: any) => ({
          ...item,
          id: item.id || crypto.randomUUID(),
          unit: item.unit || "mm",
        }));

        setParams(dataWithIds);
        setCurrentPath(path as string);
        setActiveTab("stackup"); // Default tab on load
      }
    } catch (err) {
      console.error(err);
      alert("Failed to load file. Is it valid JSON?");
    }
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

  // VIEW: 2. Editor Workspace
  return (
    <div className="container editor-screen">
      {/* Header */}
      <header className="editor-header">
        <div className="file-info">
          <span>
            Editing: <strong>{currentPath}</strong>
          </span>
        </div>
        <button className="secondary" onClick={closeProject}>
          Close Project
        </button>
      </header>

      {/* Navigation Tabs */}
      <nav className="tab-nav">
        <button
          className={`tab-btn ${activeTab === "stackup" ? "active" : ""}`}
          onClick={() => setActiveTab("stackup")}
        >
          Stackup Editor
        </button>
        <button
          className={`tab-btn ${activeTab === "footprint" ? "active" : ""}`}
          onClick={() => setActiveTab("footprint")}
        >
          Footprint Editor
        </button>
        <button
          className={`tab-btn ${activeTab === "layout" ? "active" : ""}`}
          onClick={() => setActiveTab("layout")}
        >
          Layout Editor
        </button>
        <button
          className={`tab-btn ${activeTab === "parameters" ? "active" : ""}`}
          onClick={() => setActiveTab("parameters")}
        >
          Parameters Editor
        </button>
      </nav>

      {/* Main Content Area */}
      <main>
        {activeTab === "stackup" && <StackupEditor />}
        {activeTab === "footprint" && <FootprintEditor />}
        {activeTab === "layout" && <LayoutEditor />}
        {activeTab === "parameters" && (
          <ParametersEditor params={params} setParams={setParams} />
        )}
      </main>
    </div>
  );
}

export default App;