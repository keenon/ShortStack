// src/App.tsx
import { useState, useEffect } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./App.css";

import { Parameter, StackupLayer, ProjectData, Footprint } from "./types";

import ParametersEditor from "./components/ParametersEditor";
import StackupEditor from "./components/StackupEditor";
import FootprintLibrary from "./components/FootprintLibrary";
import LayoutEditor from "./components/LayoutEditor";

const TABLEAU_10 = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", 
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"
];

type Tab = "stackup" | "footprint" | "layout" | "parameters";

function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  
  const [params, setParams] = useState<Parameter[]>([]);
  const [stackup, setStackup] = useState<StackupLayer[]>([]);
  // NEW: State for Footprints
  const [footprints, setFootprints] = useState<Footprint[]>([]);
  
  const [activeTab, setActiveTab] = useState<Tab>("stackup");

  // AUTO-SAVE
  useEffect(() => {
    if (!currentPath) return;

    const saveData = async () => {
      try {
        // Include footprints in save data
        const projectData: ProjectData = { params, stackup, footprints };
        const content = JSON.stringify(projectData, null, 2);
        await writeTextFile(currentPath, content);
        console.log("Auto-saved to", currentPath);
      } catch (err) {
        console.error("Failed to auto-save", err);
      }
    };
    
    const timer = setTimeout(saveData, 500);
    return () => clearTimeout(timer);
  }, [params, stackup, footprints, currentPath]);

  // CREATE PROJECT
  async function createProject() {
    try {
      const path = await save({
        filters: [{ name: "Project JSON", extensions: ["json"] }],
      });

      if (path) {
        const initialData: ProjectData = { params: [], stackup: [], footprints: [] };
        await writeTextFile(path, JSON.stringify(initialData));
        setParams([]);
        setStackup([]);
        setFootprints([]); // Reset
        setCurrentPath(path);
        setActiveTab("stackup");
      }
    } catch (err) {
      console.error(err);
    }
  }

  // LOAD PROJECT
  async function loadProject() {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Project JSON", extensions: ["json"] }],
      });

      if (path) {
        const content = await readTextFile(path as string);
        const rawData = JSON.parse(content);

        // Handle backward compatibility or raw arrays
        let newParams: Parameter[] = [];
        let newStackup: StackupLayer[] = [];
        let newFootprints: Footprint[] = [];

        if (Array.isArray(rawData)) {
            // Very old legacy check
            newParams = rawData;
        } else {
            newParams = rawData.params || [];
            newStackup = rawData.stackup || [];
            newFootprints = rawData.footprints || [];
        }

        // Sanitize IDs
        newParams = newParams.map((item: any) => ({
          ...item,
          id: item.id || crypto.randomUUID(),
          unit: item.unit || "mm",
        }));

        newStackup = newStackup.map((layer: any, index: number) => ({
          ...layer,
          id: layer.id || crypto.randomUUID(),
          color: layer.color || TABLEAU_10[index % TABLEAU_10.length]
        }));

        // Sanitize Footprints
        newFootprints = newFootprints.map((fp: any) => ({
          ...fp,
          id: fp.id || crypto.randomUUID(),
          shapes: (fp.shapes || []).map((s: any) => ({
              ...s,
              assignedLayers: s.assignedLayers || {}
          }))
        }));

        setParams(newParams);
        setStackup(newStackup);
        setFootprints(newFootprints);
        setCurrentPath(path as string);
        setActiveTab("stackup");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to load file.");
    }
  }

  function closeProject() {
    setCurrentPath(null);
    setParams([]);
    setStackup([]);
    setFootprints([]);
  }

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

  return (
    <div className="container editor-screen">
      <header className="editor-header">
        <div className="file-info">
          <span>Editing: <strong>{currentPath}</strong></span>
        </div>
        <button className="secondary" onClick={closeProject}>Close Project</button>
      </header>

      <nav className="tab-nav">
        <button className={`tab-btn ${activeTab === "stackup" ? "active" : ""}`} onClick={() => setActiveTab("stackup")}>Stackup Editor</button>
        <button className={`tab-btn ${activeTab === "footprint" ? "active" : ""}`} onClick={() => setActiveTab("footprint")}>Footprint Library</button>
        <button className={`tab-btn ${activeTab === "layout" ? "active" : ""}`} onClick={() => setActiveTab("layout")}>Layout Editor</button>
        <button className={`tab-btn ${activeTab === "parameters" ? "active" : ""}`} onClick={() => setActiveTab("parameters")}>Parameters Editor</button>
      </nav>

      <main>
        {activeTab === "stackup" && (
            <StackupEditor 
                stackup={stackup} 
                setStackup={setStackup} 
                params={params} 
            />
        )}
        {activeTab === "footprint" && (
            <FootprintLibrary 
                footprints={footprints}
                setFootprints={setFootprints}
                params={params}
                stackup={stackup}
            />
        )}
        {activeTab === "layout" && <LayoutEditor />}
        {activeTab === "parameters" && (
          <ParametersEditor params={params} setParams={setParams} />
        )}
      </main>
    </div>
  );
}

export default App;