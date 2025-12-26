// src/App.tsx
import { useState, useEffect } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import "./App.css";

import { Parameter, StackupLayer, ProjectData, Footprint, FootprintShape, FootprintInstance, BoardOutline, LayerAssignment } from "./types";

import ParametersEditor from "./components/ParametersEditor";
import StackupEditor from "./components/StackupEditor";
import FootprintLibrary from "./components/FootprintLibrary";

const TABLEAU_10 = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", 
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"
];

const DEFAULT_BOARD: BoardOutline = {
  points: [
    { id: crypto.randomUUID(), x: "-50", y: "-50" },
    { id: crypto.randomUUID(), x: "50", y: "-50" },
    { id: crypto.randomUUID(), x: "50", y: "50" },
    { id: crypto.randomUUID(), x: "-50", y: "50" },
  ]
};

type Tab = "stackup" | "footprint" | "layout" | "parameters";

function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  
  const [params, setParams] = useState<Parameter[]>([]);
  const [stackup, setStackup] = useState<StackupLayer[]>([]);
  const [footprints, setFootprints] = useState<Footprint[]>([]);
  
  const [activeTab, setActiveTab] = useState<Tab>("stackup");

  // AUTO-SAVE
  useEffect(() => {
    if (!currentPath) return;

    const saveData = async () => {
      try {
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
        const initialData: ProjectData = { 
            params: [], 
            stackup: [], 
            footprints: [], 
        };
        await writeTextFile(path, JSON.stringify(initialData));
        setParams([]);
        setStackup([]);
        setFootprints([]);
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

        let needsUpgrade = false;

        let rawParams: any[] = [];
        let rawStackup: any[] = [];
        let rawFootprints: any[] = [];
        let rawLayout: any[] = [];
        let rawBoard: any = null;

        if (Array.isArray(rawData)) {
            rawParams = rawData;
            needsUpgrade = true;
        } else {
            rawParams = rawData.params || [];
            rawStackup = rawData.stackup || [];
            rawFootprints = rawData.footprints || [];
            rawLayout = rawData.layout || [];
            rawBoard = rawData.boardOutline;
            if (!rawData.params || !rawData.stackup || !rawData.footprints || !rawData.layout || !rawData.boardOutline) needsUpgrade = true;
        }

        // Sanitize Parameters
        const newParams: Parameter[] = rawParams.map((item: any) => {
          if (!item.id || !item.unit) needsUpgrade = true;
          return {
            ...item,
            id: item.id || crypto.randomUUID(),
            unit: item.unit || "mm",
          };
        });

        // Sanitize Stackup
        const newStackup: StackupLayer[] = rawStackup.map((layer: any, index: number) => {
          if (!layer.id || !layer.color || !layer.carveSide) needsUpgrade = true;
          return {
            ...layer,
            id: layer.id || crypto.randomUUID(),
            color: layer.color || TABLEAU_10[index % TABLEAU_10.length],
            carveSide: layer.carveSide || "Top"
          };
        });

        // Sanitize Footprints
        const newFootprints: Footprint[] = rawFootprints.map((fp: any) => {
          if (!fp.id || !fp.shapes) needsUpgrade = true;
          
          // New properties sanitization
          if (fp.isBoard === undefined) { fp.isBoard = false; needsUpgrade = true; }
          if (fp.isBoard && !fp.boardOutline) { fp.boardOutline = []; needsUpgrade = true; }

          const sanitizedShapes = (fp.shapes || []).map((s: any) => {
            if (!s.id || !s.assignedLayers || s.name === undefined) needsUpgrade = true;
            
            // Normalize Assigned Layers
            const rawLayers = s.assignedLayers || {};
            const assignedLayers: Record<string, LayerAssignment> = {};
            Object.entries(rawLayers).forEach(([k, v]) => {
                if (typeof v === "string") {
                    assignedLayers[k] = { depth: v, endmillRadius: "0" };
                    needsUpgrade = true;
                } else {
                    const obj = v as any;
                    assignedLayers[k] = { 
                        depth: obj.depth || "0", 
                        endmillRadius: obj.endmillRadius || "0" 
                    };
                }
            });

            const baseShape = {
              ...s,
              id: s.id || crypto.randomUUID(),
              name: s.name || "Unnamed Shape",
              assignedLayers: assignedLayers,
              x: s.x ?? "0",
              y: s.y ?? "0",
            };
            if (s.type === "rect") {
              if (s.angle === undefined) { needsUpgrade = true; baseShape.angle = "0"; }
              baseShape.width = s.width ?? "10";
              baseShape.height = s.height ?? "10";
              baseShape.cornerRadius = s.cornerRadius ?? "0";
            } else if (s.type === "circle") {
              baseShape.diameter = s.diameter ?? "10";
            }
            return baseShape as FootprintShape;
          });
          return { ...fp, id: fp.id || crypto.randomUUID(), shapes: sanitizedShapes };
        });

        // Sanitize Layout
        const newLayout: FootprintInstance[] = rawLayout.map((inst: any) => {
          if (!inst.id || !inst.footprintId || inst.name === undefined) needsUpgrade = true;
          const fp = newFootprints.find(f => f.id === inst.footprintId);
          return {
            ...inst,
            id: inst.id || crypto.randomUUID(),
            footprintId: inst.footprintId || "",
            name: inst.name || fp?.name || "Unnamed Instance",
            x: inst.x ?? "0",
            y: inst.y ?? "0",
            angle: inst.angle ?? "0"
          };
        });

        // Sanitize Board Outline
        const newBoard: BoardOutline = rawBoard || DEFAULT_BOARD;

        if (needsUpgrade) {
          alert("This file was created with an older version of the editor. Some missing properties have been initialized to default values.");
        }

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
        <button className={`tab-btn ${activeTab === "footprint" ? "active" : ""}`} onClick={() => setActiveTab("footprint")}>Footprint Editor</button>
        <button className={`tab-btn ${activeTab === "parameters" ? "active" : ""}`} onClick={() => setActiveTab("parameters")}>Parameters Editor</button>
      </nav>

      <main>
        <div className={`tab-pane ${activeTab === "stackup" ? "active" : ""}`}>
          <StackupEditor 
            stackup={stackup} 
            setStackup={setStackup} 
            params={params} 
          />
        </div>
        <div className={`tab-pane ${activeTab === "footprint" ? "active" : ""}`}>
          <FootprintLibrary 
            footprints={footprints}
            setFootprints={setFootprints}
            params={params}
            stackup={stackup}
          />
        </div>
        <div className={`tab-pane ${activeTab === "parameters" ? "active" : ""}`}>
          <ParametersEditor params={params} setParams={setParams} />
        </div>
      </main>
    </div>
  );
}

export default App;