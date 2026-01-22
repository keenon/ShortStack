// src/components/SimulationEditor.tsx
import { useState, useRef, useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { 
  OrbitControls, 
  Environment, 
  GizmoHelper, 
  GizmoViewport 
} from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as THREE from "three";
import TetrahedralRenderer from "./TetrahedralRenderer";
import { FabricationPlan, Footprint, StackupLayer, Parameter } from "../types";
import { callWorker } from "./Footprint3DView";
import { evaluateExpression, generateDovetailPoints } from "../utils/footprintUtils";
import { getLineOutlinePoints } from "../workers/meshUtils";

// --- Types ---
interface ComparisonMetrics {
    volume: number;
    surfaceArea: number;
    computedAt: number;
}

interface Bounds {
    min: THREE.Vector3;
    max: THREE.Vector3;
    center: THREE.Vector3;
    size: THREE.Vector3;
}

interface SimpleTriMesh {
    vertices: number[][]; // Array of [x, y, z] arrays
    indices: number[][];  // Array of [n1, n2, n3] arrays
}

// --- Global State ---
// Persist simulation progress across tab switches
const globalSimState = {
    mode: 'idle' as 'idle' | 'preview' | 'validating' | 'meshing',
    message: "",
    percent: 0,
    logs: [] as string[]
};

// --- Helper UI Components ---

// Non-blocking toast for background updates (Auto-Preview)
function PreviewToast({ message, percent }: { message: string, percent: number }) {
    return (
        <div style={{
            position: 'absolute', bottom: 20, right: 20, width: '300px',
            backgroundColor: '#2a2a2a', border: '1px solid #444', borderRadius: '6px',
            padding: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', zIndex: 1000,
            display: 'flex', flexDirection: 'column', gap: '8px'
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.9em', fontWeight: 'bold', color: '#ccc' }}>Background Task</span>
                <span style={{ fontSize: '0.8em', color: '#666' }}>{Math.round(percent)}%</span>
            </div>
            <div style={{ width: '100%', height: '4px', background: '#444', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${percent}%`, height: '100%', background: '#646cff', transition: 'width 0.2s' }} />
            </div>
            <div style={{ fontSize: '0.85em', color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {message}
            </div>
        </div>
    );
}

// Blocking overlay for heavy simulation tasks (Validation & Meshing)
function LoadingOverlay({ message, percent, logs, onAbort }: { message: string, percent: number, logs: string[], onAbort?: () => void }) {
    const [showDetails, setShowDetails] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);

    // Auto-scroll logs
    useEffect(() => {
        if (showDetails && logRef.current) {
            logRef.current.scrollTop = logRef.current.scrollHeight;
        }
    }, [logs, showDetails]);

    return (
        <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.9)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, backdropFilter: 'blur(4px)'
        }}>
            <div className="spinner" style={{
                width: '50px', height: '50px', border: '5px solid #444',
                borderTop: '5px solid #646cff', borderRadius: '50%',
                animation: 'spin 1s linear infinite', marginBottom: '20px'
            }} />
            
            <div style={{ width: '400px', height: '8px', background: '#333', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ 
                    width: `${Math.max(0, Math.min(100, percent))}%`, 
                    height: '100%', 
                    background: '#646cff', 
                    transition: 'width 0.2s ease-out' 
                }} />
            </div>
            
            <h3 style={{ marginTop: '15px', color: 'white', fontFamily: 'monospace', fontSize: '1.1em' }}>{message}</h3>
            
            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button 
                    onClick={() => setShowDetails(!showDetails)}
                    style={{ 
                        padding: '6px 12px', background: 'transparent', border: '1px solid #666', 
                        color: '#ccc', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em'
                    }}
                >
                    {showDetails ? "Hide Logs" : "Show Logs"}
                </button>
                
                {onAbort && (
                    <button 
                        onClick={onAbort}
                        style={{ 
                            padding: '6px 12px', background: '#991b1b', border: '1px solid #ef4444', 
                            color: 'white', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85em'
                        }}
                    >
                        ABORT
                    </button>
                )}
            </div>

            {showDetails && (
                <div 
                    ref={logRef}
                    style={{
                        marginTop: '15px', width: '80%', maxWidth: '800px', height: '300px',
                        background: '#111', border: '1px solid #333', borderRadius: '4px',
                        padding: '10px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '0.8em', color: '#aaa',
                        whiteSpace: 'pre-wrap'
                    }}
                >
                    {logs.join("")}
                </div>
            )}
            
            <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

// --- Main Component ---

interface Props {
    footprints: Footprint[];
    fabPlans: FabricationPlan[];
    stackup: StackupLayer[];
    params: Parameter[];
    onJumpToPlan?: (planId: string) => void;
}

export default function SimulationEditor({ footprints, fabPlans, stackup, params, onJumpToPlan }: Props) {
  // State
  const [activePlanId, setActivePlanId] = useState<string>(fabPlans.length > 0 ? fabPlans[0].id : "");
  
  // Initialize from global state to persist across tab switches
  const [simMode, setSimMode] = useState(globalSimState.mode);
  const [processMessage, setProcessMessage] = useState(globalSimState.message);
  const [processPercent, setProcessPercent] = useState(globalSimState.percent);
  const [simLogs, setSimLogs] = useState<string[]>(globalSimState.logs);

  // Sync local state to global
  useEffect(() => {
      globalSimState.mode = simMode;
      globalSimState.message = processMessage;
      globalSimState.percent = processPercent;
      globalSimState.logs = simLogs;
  }, [simMode, processMessage, processPercent, simLogs]);

  // Listen for backend events
  useEffect(() => {
      const u1 = listen("gmsh_progress", (event: any) => {
          setProcessMessage(event.payload.message);
          setProcessPercent(event.payload.percent);
      });
      const u2 = listen("gmsh_log", (event: any) => {
          setSimLogs(prev => [...prev, event.payload]);
      });
      const u3 = listen("debug_mesh_2d", (event: any) => {
          console.log("Received Debug Mesh 2D", event.payload);
          const mesh = event.payload as SimpleTriMesh;

          if (mesh && mesh.vertices && mesh.indices) {
              // 1. Convert Data to Three.js format
              const flatVerts = new Float32Array(mesh.vertices.flat());
              // Handle Type 9 (6-node) by taking only first 3 indices if necessary, 
              // but your Rust patch sends 3-node triangles now, so flat() is fine.
              const flatIndices = mesh.indices.flat();

              const geo = new THREE.BufferGeometry();
              geo.setAttribute('position', new THREE.BufferAttribute(flatVerts, 3));
              geo.setIndex(Array.from(flatIndices));
              geo.computeVertexNormals();
              geo.computeBoundingBox();

              // 2. Update Viewport
              setPreviewGeo(geo);       // Set as the current "surface" geometry
              setVisualSource('manifold'); // Ensure we are rendering the surface, not the volume
              
              // 3. Center Camera (Optional, depends on bounds)
              if (geo.boundingBox) {
                  const center = new THREE.Vector3();
                  geo.boundingBox.getCenter(center);
                  const size = new THREE.Vector3();
                  geo.boundingBox.getSize(size);
                  setManifoldBounds({ min: geo.boundingBox.min, max: geo.boundingBox.max, center, size });
              }

              // 4. "Suspend" the loading wheel (Minimize Overlay)
              // This lets you see the mesh immediately
              setIsOverlayMinimized(true);
              setProcessMessage("Inspecting Intermediate Mesh...");
          }
      });
      return () => { 
          u1.then(f => f()); 
          u2.then(f => f());
      };
  }, []);

  // Data State
  const [manifoldMetrics, setManifoldMetrics] = useState<ComparisonMetrics | null>(null);
  const [gmshMetrics, setGmshMetrics] = useState<ComparisonMetrics | null>(null);
  const [previewGeo, setPreviewGeo] = useState<THREE.BufferGeometry | null>(null);
  const [tetMesh, setTetMesh] = useState<{ vertices: number[], indices: number[][] } | null>(null);
  
  // Visual State
  const [viewMode, setViewMode] = useState<'boundary' | 'mesh'>('mesh');
  const [visualSource, setVisualSource] = useState<'manifold' | 'gmsh'>('manifold');
  const [layerClip, setLayerClip] = useState<number>(1.0); // 0.0 to 1.0
  const [shrink, setShrink] = useState(0.9);
  const [isOverlayMinimized, setIsOverlayMinimized] = useState(false);
  
  // Separate bounds for alignment
  const [manifoldBounds, setManifoldBounds] = useState<Bounds | null>(null);
  const [gmshBounds, setGmshBounds] = useState<Bounds | null>(null);

  const [selectedLayerId, setSelectedLayerId] = useState<string>("");
  const [partIndex, setPartIndex] = useState<number>(0); 
  const [validateEnabled, setValidateEnabled] = useState(true);
  const [meshSize, setMeshSize] = useState<number>(5.0);
  
  const controlsRef = useRef<any>(null);

  const activePlan = fabPlans.find(p => p.id === activePlanId);
  const targetFootprint = footprints.find(f => f.id === activePlan?.footprintId);

  // --- Smart State Reset ---
  useEffect(() => {
      setGmshMetrics(null);
      setTetMesh(null);
      setGmshBounds(null);
      setVisualSource('manifold'); 
  }, [activePlanId, selectedLayerId, partIndex, (activePlan as any)?.layerSplitSettings]);

  // Reset Part Index when Plan or Layer changes
  useEffect(() => {
      setPartIndex(0);
  }, [activePlanId, selectedLayerId]);

  // --- Auto-Preview Effect (Background Toast) ---
  useEffect(() => {
    if (!activePlan || !targetFootprint || !selectedLayerId) return;

    // GUARD: If we are restoring a heavy task (Meshing/Validating), do NOT switch to Preview mode.
    // We check globalSimState directly to avoid race conditions on mount.
    if (globalSimState.mode === 'meshing' || globalSimState.mode === 'validating') return;

    let isMounted = true;
    const activeSplitSettings = (activePlan as any)?.layerSplitSettings?.[selectedLayerId];
    
    // Trigger Background Toast
    setSimMode('preview');
    setProcessMessage("Updating Preview...");
    setProcessPercent(0);

    callWorker("computeAnalyzablePart", {
        footprint: targetFootprint,
        allFootprints: footprints,
        stackup,
        params,
        layerId: selectedLayerId,
        partIndex: partIndex,
        enableSplit: activeSplitSettings?.enabled || false,
        splitLineIds: activeSplitSettings?.lineIds
    }, (progress) => {
        if (!isMounted) return;
        setProcessMessage(`${progress.message}`);
        setProcessPercent(progress.percent * 100);
    }).then(result => {
        if (isMounted && simMode === 'preview') setSimMode('idle');
        if (!isMounted || !result || !result.meshData) return;
        
        setManifoldMetrics({
            volume: result.volume,
            surfaceArea: result.surfaceArea,
            computedAt: Date.now()
        });

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(result.meshData.vertices, 3));
        if (result.meshData.indices) geo.setIndex(Array.from(result.meshData.indices));
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        
        setPreviewGeo(geo);
        
        if (geo.boundingBox) {
            const size = new THREE.Vector3();
            const center = new THREE.Vector3();
            geo.boundingBox.getSize(size);
            geo.boundingBox.getCenter(center);
            setManifoldBounds({ min: geo.boundingBox.min, max: geo.boundingBox.max, center, size });
        }
        
        if (visualSource !== 'gmsh') {
             setVisualSource('manifold');
        }
    }).catch(e => {
        console.error("Auto-preview failed", e);
        if (isMounted) setSimMode('idle');
    });

    return () => { isMounted = false; };
  }, [activePlanId, selectedLayerId, partIndex, validateEnabled, (activePlan as any)?.layerSplitSettings]);

  // Filter for valid 3D printable layers
  const printableLayers = useMemo(() => {
      if (!activePlan) return [];
      return stackup.filter(l => {
          const method = activePlan.layerMethods[l.id];
          return method === "3D printed";
      });
  }, [stackup, activePlan]);

  // Auto-select first printable layer
  useEffect(() => {
      if (printableLayers.length > 0 && !selectedLayerId) {
          setSelectedLayerId(printableLayers[0].id);
      }
  }, [printableLayers]);

  // --- Unified Simulation Runner ---
  const runSimulation = async () => {
    if (!activePlan || !targetFootprint) return;
    
    // Reset Views
    setSimMode('validating'); // Re-using 'validating' for the Analysis Phase
    setProcessPercent(0);
    setProcessMessage("Computing Manifold Geometry...");
    setSimLogs([]); 
    setTetMesh(null);
    setIsOverlayMinimized(false);

    try {
        if (!selectedLayerId) throw new Error("Please select a target layer.");

        // --- STEP 1: Manifold Calculation (Ground Truth) ---
        const activeSplitSettings = (activePlan as any)?.layerSplitSettings?.[selectedLayerId];
        
        // This is a Promise that resolves when worker is done
        const manifoldResult = await callWorker("computeAnalyzablePart", {
            footprint: targetFootprint,
            allFootprints: footprints,
            stackup,
            params,
            layerId: selectedLayerId,
            partIndex: partIndex,
            enableSplit: activeSplitSettings?.enabled || false,
            splitLineIds: activeSplitSettings?.lineIds
        }, (progress) => {
            setProcessMessage(`Manifold: ${progress.message}`);
        });

        if (!manifoldResult || !manifoldResult.meshData) throw new Error("Manifold Generation Failed");

        setManifoldMetrics({
            volume: manifoldResult.volume,
            surfaceArea: manifoldResult.surfaceArea,
            computedAt: Date.now()
        });
        
        // Update Preview
        const manifoldGeo = new THREE.BufferGeometry();
        manifoldGeo.setAttribute('position', new THREE.Float32BufferAttribute(manifoldResult.meshData.vertices, 3));
        if (manifoldResult.meshData.indices) manifoldGeo.setIndex(Array.from(manifoldResult.meshData.indices));
        manifoldGeo.computeVertexNormals();
        manifoldGeo.computeBoundingBox();
        setPreviewGeo(manifoldGeo);
        if (manifoldGeo.boundingBox) {
             const center = new THREE.Vector3();
             manifoldGeo.boundingBox.getCenter(center);
             const size = new THREE.Vector3();
             manifoldGeo.boundingBox.getSize(size);
             setManifoldBounds({ min: manifoldGeo.boundingBox.min, max: manifoldGeo.boundingBox.max, center, size });
        }

        // --- STEP 2: Gmsh 2D Analysis ---
        setProcessMessage("Running Gmsh 2D Analysis...");        
        // Reuse the resolution logic for variables
        const resolveVal = (v: any) => {
            if (typeof v === 'number') return v;
            if (typeof v === 'string') return evaluateExpression(v, params);
            return v;
        };

        // Prepare Footprint with Splits for Gmsh
        let processedFootprint = JSON.parse(JSON.stringify(targetFootprint)); 
        if (activeSplitSettings?.enabled) {
            const kerf = parseFloat(activeSplitSettings.kerf || "0.5");
            const newShapes: any[] = [];
            processedFootprint.shapes.forEach((s: any) => {
                 if (s.type === "splitLine") {
                    const isActive = !activeSplitSettings.lineIds || activeSplitSettings.lineIds.includes(s.id);
                    if (isActive) {
                        const startX = evaluateExpression(s.x, params);
                        const startY = evaluateExpression(s.y, params);
                        const endX = startX + evaluateExpression(s.endX, params);
                        const endY = startY + evaluateExpression(s.endY, params);
                        const positions = (s.dovetailPositions || []).map((p: string) => evaluateExpression(p, params));
                        const dWidth = evaluateExpression(s.dovetailWidth, params);
                        const dHeight = evaluateExpression(s.dovetailHeight, params);
                        const rawPts = generateDovetailPoints(startX, startY, endX, endY, positions, dWidth, dHeight, !!s.flip);
                        const mockLine: any = { id: "temp_split_" + s.id, type: "line", points: rawPts.map(p => ({ x: p.x, y: p.y })), thickness: String(kerf) };
                        const outlinePts = getLineOutlinePoints(mockLine, params, kerf, 16, targetFootprint, footprints);
                        if (outlinePts.length > 2) {
                            newShapes.push({ type: "polygon", id: mockLine.id, points: outlinePts.map(p => ({ x: p.x, y: p.y })), assignedLayers: { [selectedLayerId]: { depth: "1000" } }, x: "0", y: "0" });
                        }
                    }
                 } else { newShapes.push(s); }
            });
            processedFootprint.shapes = newShapes;
        }

        // Resolve Shapes (using the previously injected logic if available, or re-implementing briefly)
        processedFootprint.shapes = processedFootprint.shapes.map((s: any) => {
             const newS = { ...s };
             ['x', 'y', 'width', 'height', 'diameter', 'cornerRadius'].forEach(k => { if (newS[k] !== undefined) newS[k] = resolveVal(newS[k]); });
             if (newS.points) {
                newS.points = newS.points.map((p: any) => {
                    const newP = { ...p, x: resolveVal(p.x), y: resolveVal(p.y) };
                    if (newP.handleIn) newP.handleIn = { x: resolveVal(newP.handleIn.x), y: resolveVal(newP.handleIn.y) };
                    if (newP.handleOut) newP.handleOut = { x: resolveVal(newP.handleOut.x), y: resolveVal(newP.handleOut.y) };
                    return newP;
                });
             }
             return newS;
        });

        const feaRequest = {
            footprint: processedFootprint,
            stackup: stackup,
            params: params,
            mesh_size: meshSize,
            target_layer_id: selectedLayerId,
            part_index: partIndex
        };

        const analysis: any = await invoke("start_gmsh_analysis", { req: feaRequest });
        
        const gmshVol = analysis.volume;
        const maniVol = manifoldResult.volume;
        const diff = Math.abs((gmshVol - maniVol) / maniVol);

        setGmshMetrics({ volume: gmshVol, surfaceArea: 0, computedAt: Date.now() });

        console.log("----------------------------");
        // --- STEP 3: Validate ---
        if (diff > 0.001) { // 0.1% Threshold
             setProcessMessage(`Validation Failed! Diff: ${(diff*100).toFixed(2)}%`);
             
             // Show the 2D mesh from Gmsh
             const mesh = analysis.mesh;
             const flatVerts = new Float32Array(mesh.vertices.flat());
             const flatIndices = mesh.indices.flat();
             const geo = new THREE.BufferGeometry();
             // --- DEBUG: Bounds Reporting ---
            const mBox = manifoldGeo.boundingBox!;
            
            console.log("--- MESH ALIGNMENT DEBUG ---");
            console.log("Manifold Bounds:", { 
                min: mBox.min, max: mBox.max, 
                center: new THREE.Vector3().addVectors(mBox.min, mBox.max).multiplyScalar(0.5) 
            });
            
             geo.setAttribute('position', new THREE.BufferAttribute(flatVerts, 3));
             geo.setIndex(Array.from(flatIndices));
             geo.computeVertexNormals();
             geo.computeBoundingBox();
             const gBox = geo.boundingBox!;

             console.log("Gmsh Bounds:", { 
                min: gBox.min, max: gBox.max, 
                center: new THREE.Vector3().addVectors(gBox.min, gBox.max).multiplyScalar(0.5) 
            });
            setGmshBounds({ 
                min: gBox.min, 
                max: gBox.max,
                center: new THREE.Vector3().addVectors(gBox.min, gBox.max).multiplyScalar(0.5),
                size: new THREE.Vector3().subVectors(gBox.max, gBox.min)
            });
             
             setTetMesh({ vertices: Array.from(flatVerts), indices: mesh.indices });
             setVisualSource('gmsh'); 
             setSimMode('idle'); // Stop
             alert(`Validation Failed!\nManifold Vol: ${maniVol.toFixed(2)}\nGmsh Vol: ${gmshVol.toFixed(2)}\nDifference: ${(diff*100).toFixed(2)}%\n\nShowing Gmsh 2D Analysis mesh.`);
             return;
        }

        // --- STEP 4: Finalize 3D ---
        setSimMode('meshing');
        setProcessMessage("Validation Passed. Meshing 3D...");
        
        const finalRes: any = await invoke("finalize_gmsh_3d", { sessionId: analysis.session_id, partIndex: partIndex });
        
        setGmshMetrics({ volume: finalRes.volume, surfaceArea: finalRes.surface_area, computedAt: Date.now() });
        const flatVerts = finalRes.mesh.vertices.flat();
        const tetIndices = finalRes.mesh.indices.map((t: number[]) => [t[0], t[1], t[2], t[3]]);
        setTetMesh({ vertices: flatVerts, indices: tetIndices });
        
        // Update Bounds
        let min = new THREE.Vector3(Infinity, Infinity, Infinity);
        let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        for(let i=0; i<flatVerts.length; i+=3) {
            const x = flatVerts[i], y = flatVerts[i+1], z = flatVerts[i+2];
            if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
            if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
        }
        setGmshBounds({ min, max, center: new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5), size: new THREE.Vector3().subVectors(max, min) });
        
        setVisualSource('gmsh');
        setSimMode('idle');

    } catch (e) {
        console.error(e);
        setSimMode('idle');
        setProcessMessage("Failed: " + e);
        alert("Simulation Error: " + e);
    }
  };

  const metricDiff = (m1: number, m2: number) => {
      const diff = Math.abs(m1 - m2);
      const pct = (diff / ((m1+m2)/2)) * 100;
      return pct.toFixed(2) + "%";
  };

  const handleAbort = async () => {
      if (simMode === 'meshing') {
          try { await invoke("abort_gmsh"); } catch (e) { console.error("Abort failed", e); }
      }
      // Force UI reset immediately
      setSimMode('idle');
      setProcessMessage("Aborted by user.");
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", position: "relative" }}>
      {/* UI Overlays */}
      {simMode === 'preview' && <PreviewToast message={processMessage} percent={processPercent} />}
      
      {/* [MODIFIED] Loading Overlay with Minimize capability */}
      {(simMode === 'validating' || simMode === 'meshing') && (
          isOverlayMinimized ? (
            // MINIMIZED STATE: Tiny box in the corner
            <div style={{
                position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)',
                backgroundColor: 'rgba(0,0,0,0.8)', padding: '10px 20px', borderRadius: '30px',
                border: '1px solid #444', zIndex: 9999, display: 'flex', alignItems: 'center', gap: '15px'
            }}>
                <div className="spinner" style={{ width: '15px', height: '15px', border: '2px solid #666', borderTopColor: '#646cff', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                <span style={{ fontSize: '0.9em', color: '#fff' }}>{processMessage} ({Math.round(processPercent)}%)</span>
                <button 
                    onClick={() => setIsOverlayMinimized(false)}
                    style={{ background: '#333', border: 'none', color: '#aaa', cursor: 'pointer', padding: '5px 10px', borderRadius: '15px', fontSize: '0.8em' }}
                >
                    Expand
                </button>
            </div>
          ) : (
            // MAXIMIZED STATE: Passes "onMinimize" handler
            <LoadingOverlay 
                message={processMessage} 
                percent={processPercent} 
                logs={simLogs}
                onAbort={handleAbort} 
                // Pass a new prop if you modify LoadingOverlay, OR just wrap it:
            />
          )
      )}

      {/* --- SIDEBAR CONTROLS --- */}
      <div style={{ width: "350px", background: "#222", borderRight: "1px solid #444", display: "flex", flexDirection: "column", overflowY: "auto" }}>        
        <div style={{ padding: "20px", borderBottom: "1px solid #333" }}>
            <h3 style={{ margin: "0 0 15px 0" }}>FEA Pre-processor</h3>
            <label style={{ fontSize: "0.85em", color: "#888" }}>Fabrication Plan</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '5px' }}>
                <select 
                    value={activePlanId} 
                    onChange={(e) => setActivePlanId(e.target.value)}
                    style={{ flexGrow: 1, padding: "8px", background: "#333", border: "1px solid #555", color: "white" }}
                >
                    {fabPlans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button 
                    onClick={() => onJumpToPlan && activePlanId && onJumpToPlan(activePlanId)}
                    title="Jump to Fabrication Editor"
                    style={{ padding: '4px 10px', cursor: 'pointer', background: "#2d4b38", border: "1px solid #487e5b", color: "white", borderRadius: '3px' }}
                >
                    Jump to Plan
                </button>
            </div>

            <label style={{ fontSize: "0.85em", color: "#888", marginTop: "15px", display: "block" }}>Target Part (Layer)</label>
            <select 
                value={selectedLayerId} 
                onChange={(e) => setSelectedLayerId(e.target.value)}
                style={{ width: "100%", marginTop: "5px", padding: "8px", background: "#333", border: "1px solid #555", color: "white" }}
                disabled={printableLayers.length === 0}
            >
                {printableLayers.length === 0 && <option>No 3D Printed Layers</option>}
                {printableLayers.map(l => (
                    <option key={l.id} value={l.id}>
                        {l.name}
                    </option>
                ))}
            </select>

            {/* Dynamic Part Selector */}
            {(() => {
                const splitSettings = (activePlan as any)?.layerSplitSettings?.[selectedLayerId];
                const isSplitEnabled = splitSettings?.enabled;
                const availableSplitLines = isSplitEnabled 
                    ? (splitSettings.lineIds || targetFootprint?.shapes.filter(s => s.type === "splitLine").map(s => s.id) || [])
                    : [];
                const partCount = isSplitEnabled ? availableSplitLines.length + 1 : 1;

                if (!isSplitEnabled) return null;

                return (
                    <>
                        <label style={{ fontSize: "0.85em", color: "#888", marginTop: "15px", display: "block" }}>Select Part (Split)</label>
                        <select 
                            value={partIndex} 
                            onChange={(e) => setPartIndex(parseInt(e.target.value))}
                            style={{ width: "100%", marginTop: "5px", padding: "8px", background: "#333", border: "1px solid #555", color: "white" }}
                        >
                            {Array.from({ length: partCount }).map((_, i) => (
                                <option key={i} value={i}>
                                    Part {i + 1} {i === 0 ? "(Largest)" : ""}
                                </option>
                            ))}
                        </select>
                    </>
                );
            })()}

            <label style={{ fontSize: "0.85em", color: "#888", marginTop: "15px", display: "block" }}>Target Mesh Size (mm)</label>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "5px" }}>
                <input 
                    type="number" 
                    min="0.1" step="0.1"
                    value={meshSize} 
                    onChange={(e) => setMeshSize(parseFloat(e.target.value))}
                    style={{ width: "100%", padding: "8px", background: "#333", border: "1px solid #555", color: "white" }}
                />
            </div>
        </div>

        <div style={{ padding: "20px", borderBottom: "1px solid #333" }}>
            <h4 style={{ margin: "0 0 15px 0", color: "#ccc" }}>Actions</h4>

            <button 
                className="primary" 
                onClick={runSimulation} 
                disabled={(simMode !== 'idle' && simMode !== 'preview') || !selectedLayerId}
                style={{ width: "100%", padding: "12px", background: "#2d4b38", border: "1px solid #487e5b", color: "white", cursor: "pointer", borderRadius: "4px" }}
            >
                {simMode === 'validating' || simMode === 'meshing' ? "Processing..." : "Run Simulation"}
            </button>

            {validateEnabled && manifoldMetrics && gmshMetrics && (
                <div style={{ marginTop: "15px", fontSize: "0.85em", background: "#1a1a1a", padding: "10px", borderRadius: "6px" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                            <tr style={{ color: "#888", textAlign: "left" }}>
                                <th>Metric</th>
                                <th>Diff</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td style={{ padding: "4px 0" }}>Volume</td>
                                <td style={{ color: parseFloat(metricDiff(manifoldMetrics.volume, gmshMetrics.volume)) < 1.0 ? "#51cf66" : "#ff6b6b" }}>
                                    {metricDiff(manifoldMetrics.volume, gmshMetrics.volume)}
                                </td>
                            </tr>
                            <tr>
                                <td style={{ padding: "4px 0" }}>Surface Area</td>
                                <td style={{ color: parseFloat(metricDiff(manifoldMetrics.surfaceArea, gmshMetrics.surfaceArea)) < 5.0 ? "#51cf66" : "#ff6b6b" }}>
                                    {metricDiff(manifoldMetrics.surfaceArea, gmshMetrics.surfaceArea)}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}
        </div>

        <div style={{ padding: "20px", flex: 1 }}>
            <h4 style={{ margin: "0 0 10px 0", color: "#ccc" }}>Visualization</h4>
            
            <div style={{ display: 'flex', marginBottom: '15px', background: '#111', padding: '2px', borderRadius: '4px' }}>
                <button 
                    onClick={() => setVisualSource('manifold')}
                    style={{ flex: 1, padding: '6px', border: 'none', background: visualSource === 'manifold' ? '#646cff' : 'transparent', color: 'white', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em' }}
                >
                    Frontend (Manifold)
                </button>
                <button 
                    onClick={() => setVisualSource('gmsh')}
                    style={{ flex: 1, padding: '6px', border: 'none', background: visualSource === 'gmsh' ? '#d97706' : 'transparent', color: 'white', borderRadius: '3px', cursor: 'pointer', fontSize: '0.85em' }}
                >
                    Backend (Gmsh)
                </button>
            </div>

            {tetMesh && (
                <div style={{ background: "#2a2a2a", padding: "15px", borderRadius: "8px", border: "1px solid #444" }}>
                    <div style={{ marginBottom: "15px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                            <label style={{ fontSize: "0.8em", color: "#ccc" }}>Z-Clip (Layer View)</label>
                            <span style={{ fontSize: "0.8em", fontFamily: "monospace" }}>{Math.round(layerClip * 100)}%</span>
                        </div>
                        <input 
                            type="range" min="0" max="1" step="0.01" 
                            value={layerClip} 
                            onChange={(e) => setLayerClip(parseFloat(e.target.value))} 
                            style={{ width: "100%", accentColor: "#646cff" }}
                        />
                    </div>

                    <div>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                            <label style={{ fontSize: "0.8em", color: "#ccc" }}>Element Shrink</label>
                            <span style={{ fontSize: "0.8em", fontFamily: "monospace" }}>{(shrink * 100).toFixed(0)}%</span>
                        </div>
                        <input 
                            type="range" min="0" max="1" step="0.01" 
                            value={shrink} 
                            onChange={(e) => setShrink(parseFloat(e.target.value))} 
                            style={{ width: "100%", accentColor: "#646cff" }}
                        />
                    </div>
                    
                    <div style={{ marginTop: "15px", fontSize: "0.8em", color: "#888" }}>
                        Elements: <b>{tetMesh.indices.length}</b><br/>
                        Nodes: <b>{tetMesh.vertices.length / 3}</b>
                    </div>
                </div>
            )}
        </div>
      </div>

      {/* --- 3D VIEWPORT --- */}
      <div style={{ flex: 1, background: "#111", position: "relative" }}>
        
        {tetMesh && (
            <div style={{ position: "absolute", top: 20, right: 20, zIndex: 10, background: "#333", borderRadius: "4px", padding: "4px" }}>
                <button 
                    onClick={() => setViewMode('boundary')}
                    style={{ background: viewMode === 'boundary' ? '#555' : 'transparent', border: 'none', color: 'white', padding: '6px 12px', cursor: 'pointer' }}
                >
                    Boundary
                </button>
                <button 
                    onClick={() => setViewMode('mesh')}
                    style={{ background: viewMode === 'mesh' ? '#646cff' : 'transparent', border: 'none', color: 'white', padding: '6px 12px', cursor: 'pointer' }}
                >
                    Internal Mesh
                </button>
            </div>
        )}

        <Canvas shadows camera={{ position: [50, 50, 50], fov: 45, near: 0.1, far: 10000 }}>
            <color attach="background" args={['#1a1a1a']} />
            <Environment preset="city" />
            
            <directionalLight position={[50, 80, 50]} intensity={1.5} castShadow />
            <ambientLight intensity={0.4} />
            
            <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                <GizmoViewport axisColors={['#ff3653', '#0adb50', '#2c8fdf']} labelColor="black" />
            </GizmoHelper>
            
            <OrbitControls ref={controlsRef} makeDefault />

            <group position={[0,0,0]}>
                {(() => {
                    // Determine centers independently to avoid mixed-coordinate confusion
                    const maniCenter = manifoldBounds?.center || new THREE.Vector3(0,0,0);
                    const gmshCenter = gmshBounds?.center || new THREE.Vector3(0,0,0);
                    
                    return (
                        <>
                            {visualSource === 'manifold' && previewGeo && (
                                <group position={[-maniCenter.x, -maniCenter.y, -maniCenter.z]}>
                                    <mesh geometry={previewGeo}>
                                        <meshStandardMaterial 
                                            color="#aaa" 
                                            roughness={0.4} 
                                            metalness={0.2} 
                                            transparent 
                                            opacity={0.9}
                                            polygonOffset
                                            polygonOffsetFactor={1}
                                        />
                                        <lineSegments>
                                            <edgesGeometry args={[previewGeo]} />
                                            <lineBasicMaterial color="#444" />
                                        </lineSegments>
                                    </mesh>
                                </group>
                            )}

                            {visualSource === 'gmsh' && tetMesh && gmshBounds && (
                                // Rotate -90 X to convert Z-up (Engineering) to Y-up (ThreeJS)
                                <group rotation={[-Math.PI / 2, 0, 0]}>
                                    {/* Center in LOCAL space (Z-up) before rotation */}
                                    <group position={[-gmshCenter.x, -gmshCenter.y, -gmshCenter.z]}>
                                        <TetrahedralRenderer 
                                            mesh={tetMesh} 
                                            shrinkFactor={viewMode === 'boundary' ? 1.0 : shrink} 
                                            color="#d97706"
                                            minZ={gmshBounds.min.z}
                                            clipZ={gmshBounds.min.z + (gmshBounds.max.z - gmshBounds.min.z) * layerClip} 
                                        />
                                    </group>
                                </group>
                            )}
                        </>
                    );
                })()}
            </group>
        </Canvas>
      </div>
    </div>
  );
}