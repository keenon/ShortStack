// src/App.tsx
import { useState, useEffect } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
// UPDATER IMPORTS
import { getVersion } from '@tauri-apps/api/app';
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";

import { Parameter, StackupLayer, ProjectData, Footprint, FootprintShape, LayerAssignment, FootprintBoardOutline, MeshAsset } from "./types";
import { resolveParameters, repairBoardAssignments } from "./utils/footprintUtils";

import ParametersEditor from "./components/ParametersEditor";
import StackupEditor from "./components/StackupEditor";
import FootprintLibrary from "./components/FootprintLibrary";
import FabricationEditor from "./components/FabricationEditor";
import SimulationEditor from "./components/SimulationEditor";

const TABLEAU_10 = [
  "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", 
  "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"
];

type Tab = "stackup" | "footprint" | "layout" | "parameters" | "fabrication" | "simulation";

function App() {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [params, setParams] = useState<Parameter[]>([]);
  const [stackup, setStackup] = useState<StackupLayer[]>([]);
  const [footprints, setFootprints] = useState<Footprint[]>([]);
  const [meshAssets, setMeshAssets] = useState<MeshAsset[]>([]);
  
  const [activeTab, setActiveTab] = useState<Tab>("stackup");
  const [fabPlans, setFabPlans] = useState<any[]>([]);

  // --- UPDATER STATE ---
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<"idle" | "available" | "downloading" | "installing" | "ready">("idle");
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadTotal, setDownloadTotal] = useState<number>(0);

  // --- CHECK FOR UPDATES ---
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const u = await check();
        if (u?.available) {
          setUpdate(u);
          setUpdateStatus("available");
        }
      } catch (err) {
        console.error("Failed to check for updates:", err);
      }
    };
    checkForUpdates();
    getVersion().then(v => setVersion(v));
  }, []);

  // --- INSTALL UPDATE ---
  async function installUpdate() {
    if (!update) return;
    setUpdateStatus("downloading");
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            setDownloadTotal(event.data.contentLength || 0);
            setDownloadProgress(0);
            break;
          case 'Progress':
            setDownloadProgress((prev) => prev + (event.data.chunkLength || 0));
            break;
          case 'Finished':
            setUpdateStatus("installing");
            break;
        }
      });
      setUpdateStatus("ready");
      
      // Prompt user or relaunch immediately
      if (confirm("Update installed. Relaunch now?")) {
          await relaunch();
      }
    } catch (err) {
      console.error("Update failed", err);
      alert("Failed to install update. Check console for details.");
      setUpdateStatus("available"); // Reset logic to try again
    }
  }

  // AUTO-SAVE
  useEffect(() => {
    if (!currentPath) return;

    const saveData = async () => {
      try {
        const projectData: ProjectData = { params, stackup, footprints, meshes: meshAssets, fabPlans };
        const content = JSON.stringify(projectData, null, 2);
        await writeTextFile(currentPath, content);
        console.log("Auto-saved to", currentPath);
      } catch (err) {
        console.error("Failed to auto-save", err);
      }
    };
    
    const timer = setTimeout(saveData, 500);
    return () => clearTimeout(timer);
  }, [params, stackup, footprints, meshAssets, fabPlans, currentPath]);

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
            meshes: [],
            fabPlans: [],
        };
        await writeTextFile(path, JSON.stringify(initialData));
        setParams([]);
        setStackup([]);
        setFootprints([]);
        setMeshAssets([]);
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
        let rawMeshAssets: MeshAsset[] = [];

        if (Array.isArray(rawData)) {
            rawParams = rawData;
            needsUpgrade = true;
        } else {
            rawParams = rawData.params || [];
            rawStackup = rawData.stackup || [];
            rawFootprints = rawData.footprints || [];
            rawMeshAssets = rawData.meshes || [];
            if (!rawData.params || !rawData.stackup || !rawData.footprints) needsUpgrade = true;
        }

        // Sanitize Parameters
        const newParams: Parameter[] = rawParams.map((item: any) => {
          if (!item.id || !item.unit || item.expression === undefined) needsUpgrade = true;
          return {
            ...item,
            id: item.id || crypto.randomUUID(),
            expression: item.expression || String(item.value || 0), 
            value: item.value || 0,
            unit: item.unit || "mm",
            isFavorite: !!item.isFavorite, // NEW: Ensure boolean, default false
          };
        });

        // Ensure values are fresh based on expressions (resolves stale values from legacy files)
        const resolvedParams = resolveParameters(newParams);

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

        // MIGRATION: Extract and deduplicate legacy embedded meshes
        const assetMap = new Map<string, string>(); // content -> id
        rawMeshAssets.forEach(asset => assetMap.set(asset.content, asset.id));

        // Recursive Helper for Shape Sanitization
        const sanitizeShape = (s: any): FootprintShape => {
            if (!s.id || !s.assignedLayers || s.name === undefined) needsUpgrade = true;
            
            // Normalize Assigned Layers
            const rawLayers = s.assignedLayers || {};
            const assignedLayers: Record<string, LayerAssignment> = {};
            Object.entries(rawLayers).forEach(([k, v]) => {
                if (typeof v === "string") {
                    assignedLayers[k] = { depth: v, endmillRadius: "0", inputFillet: "0" };
                    needsUpgrade = true;
                } else {
                    const obj = v as any;
                    assignedLayers[k] = { 
                        depth: obj.depth || "0", 
                        endmillRadius: obj.endmillRadius || "0",
                        inputFillet: obj.inputFillet || "0"
                    };
                }
            });

            // MIGRATION: Convert legacy Wire Guide handles to single handle
            if (s.type === "wireGuide") {
                const wg = s as any;
                if (!wg.handle && (wg.handleOut || wg.handleIn)) {
                    s.handle = wg.handleOut || { x: "5", y: "0" };
                    delete s.handleOut;
                    delete s.handleIn;
                    needsUpgrade = true;
                }
            }

            const baseShape: any = {
              ...s,
              id: s.id || crypto.randomUUID(),
              name: s.name || "Unnamed Shape",
              locked: !!s.locked,
              includeInBom: !!s.includeInBom,
              bomNotes: s.bomNotes || "",
              assignedLayers: assignedLayers,
              x: String(s.x ?? "0"),
              y: String(s.y ?? "0"),
            };

            if (s.type === "rect") {
              if (s.angle === undefined) { needsUpgrade = true; baseShape.angle = "0"; }
              baseShape.width = s.width ?? "10";
              baseShape.height = s.height ?? "10";
              baseShape.cornerRadius = s.cornerRadius ?? "0";
            } else if (s.type === "circle") {
              baseShape.diameter = s.diameter ?? "10";
            } else if (s.type === "boardOutline") {
              baseShape.points = s.points || [];
            } else if (s.type === "union") {
              // RECURSION FIX: Sanitize shapes nested inside unions
              baseShape.shapes = (s.shapes || []).map((child: any) => sanitizeShape(child));
              if (s.angle === undefined) { needsUpgrade = true; baseShape.angle = "0"; }
            } else if (s.type === "text") {
              if (s.angle === undefined) { needsUpgrade = true; baseShape.angle = "0"; }
            }
            
            return baseShape as FootprintShape;
        };

        // Sanitize Footprints
        const newFootprints: Footprint[] = rawFootprints.map((fp: any) => {
          if (!fp.id || !fp.shapes) needsUpgrade = true;
          
          // New properties sanitization
          if (fp.isBoard === undefined) { fp.isBoard = false; needsUpgrade = true; }
          
          // Legacy migration: Move boardOutline array into a boardOutline Shape
          let processedShapes = fp.shapes || [];
          if (fp.isBoard && Array.isArray(fp.boardOutline) && fp.boardOutline.length > 0) {
              needsUpgrade = true;
              const legacyOutlineShape: FootprintBoardOutline = {
                  id: "LEGACY_OUTLINE",
                  type: "boardOutline",
                  name: "Main Outline",
                  x: "0",
                  y: "0",
                  points: fp.boardOutline,
                  assignedLayers: {}
              };
              processedShapes = [legacyOutlineShape, ...processedShapes];
          }

          // Initialize Board Outline Assignments
          const boardOutlineAssignments: Record<string, string> = fp.boardOutlineAssignments || {};
          const outlines = processedShapes.filter((s: any) => s.type === "boardOutline");
          
          if (fp.isBoard && outlines.length > 0) {
              newStackup.forEach(layer => {
                  if (!boardOutlineAssignments[layer.id]) {
                      boardOutlineAssignments[layer.id] = outlines[0].id;
                      needsUpgrade = true;
                  }
              });
          }

          // Apply Recursive Sanitization
          const sanitizedShapes = (processedShapes || []).map((s: any) => sanitizeShape(s));

          // LEGACY MESH MIGRATION
          const processedMeshes = (fp.meshes || []).map((m: any) => {
              if (m.content) {
                  needsUpgrade = true;
                  let assetId = assetMap.get(m.content);
                  if (!assetId) {
                      assetId = crypto.randomUUID();
                      const newAsset: MeshAsset = {
                          id: assetId,
                          name: m.name || "Imported Mesh",
                          content: m.content,
                          format: m.format || "stl"
                      };
                      rawMeshAssets.push(newAsset);
                      assetMap.set(m.content, assetId);
                  }
                  const { content, format, ...instance } = m;
                  return { ...instance, meshId: assetId, includeInBom: !!m.includeInBom, bomNotes: m.bomNotes || "" };
              }
              return m;
          });

          const preRepairedFp = { 
              ...fp, 
              id: fp.id || crypto.randomUUID(), 
              shapes: sanitizedShapes, 
              meshes: processedMeshes,
              boardOutline: undefined, // Clear legacy
              boardOutlineAssignments 
          };

          // --- REPAIR ASSIGNMENTS ON LOAD ---
          return repairBoardAssignments(preRepairedFp, newStackup);
        });

        if (needsUpgrade) {
          alert("This file was created with an older version of the editor. Some properties have been updated to the new project structure.");
        }

        setParams(resolvedParams);
        setStackup(newStackup);
        setFootprints(newFootprints);
        setMeshAssets(rawMeshAssets);
        setFabPlans((rawData.fabPlans || []).map((p: any) => ({
            ...p,
            layerMethods: p.layerMethods || {},
            waterlineSettings: p.waterlineSettings || {},
            cncSettings: p.cncSettings || {}
        })));
        setCurrentPath(path as string);
        setActiveTab("stackup");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to load file.");
    }
  }

  function registerMeshAsset(asset: MeshAsset) {
      setMeshAssets(prev => [...prev, asset]);
  }

  function closeProject() {
    setCurrentPath(null);
    setParams([]);
    setStackup([]);
    setFootprints([]);
    setMeshAssets([]);
  }

  // --- UI BANNER ---
  const updateBanner = update && updateStatus !== "idle" ? (
    <div className="update-banner">
      <div className="update-info">
        <h3>Update Available: {update.version}</h3>
        <p>{update.body ? (update.body.length > 100 ? update.body.substring(0, 100) + "..." : update.body) : "New version available."}</p>
        
        {updateStatus === "available" && (
           <button onClick={installUpdate}>Install Now</button>
        )}

        {updateStatus === "downloading" && (
           <div className="progress-container">
             <div className="progress-bar">
                <div 
                    className="fill" 
                    style={{ width: downloadTotal > 0 ? `${(downloadProgress / downloadTotal) * 100}%` : '0%' }} 
                />
             </div>
             <span className="progress-text">
                {downloadTotal > 0 ? Math.round((downloadProgress / downloadTotal) * 100) : 0}%
             </span>
           </div>
        )}

        {updateStatus === "installing" && <span>Installing update...</span>}
        {updateStatus === "ready" && <span>Ready to relaunch!</span>}
      </div>
    </div>
  ) : null;

  if (!currentPath) {
    return (
      <div className="container welcome-screen">
    <div className="welcome-content"> {/* Added a wrapper div */}
      <h1>ShortStack <span className="version-tag">v{version}</span></h1>
      <div className="row">
        <button className="premium-btn" onClick={createProject}> New Project</button>
        <button className="premium-btn" onClick={loadProject}>Load Project</button>
      </div>
    </div>
    {updateBanner}
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
        <button className={`tab-btn ${activeTab === "fabrication" ? "active" : ""}`} onClick={() => setActiveTab("fabrication")}>Fabrication Editor</button>
        <button className={`tab-btn ${activeTab === "simulation" ? "active" : ""}`} onClick={() => setActiveTab("simulation")}>Simulation</button>
      </nav>

      <main>
        {activeTab === "stackup" && (
          <div className="tab-pane active">
            <StackupEditor 
              stackup={stackup} 
              setStackup={setStackup} 
              params={params} 
            />
          </div>
        )}

        {activeTab === "footprint" && (
          <div className="tab-pane active">
            <FootprintLibrary 
              footprints={footprints}
              setFootprints={setFootprints}
              params={params}
              stackup={stackup}
              meshAssets={meshAssets}
              onRegisterMesh={registerMeshAsset}
            />
          </div>
        )}

        {activeTab === "parameters" && (
          <div className="tab-pane active">
            <ParametersEditor params={params} setParams={setParams} />
          </div>
        )}

        {activeTab === "fabrication" && (
          <div className="tab-pane active">
            <FabricationEditor 
              fabPlans={fabPlans}
              setFabPlans={setFabPlans}
              footprints={footprints}
              stackup={stackup}
              params={params}
              meshAssets={meshAssets}
            />
          </div>
        )}

        {activeTab === "simulation" && (
          <div className="tab-pane active">
            <SimulationEditor />
          </div>
        )}
      </main>

      {updateBanner}
    </div>
  );
}

export default App;