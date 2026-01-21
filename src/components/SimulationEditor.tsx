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
    
    // Start Validation Mode
    setSimMode('validating');
    setProcessPercent(0);
    setProcessMessage("Initializing Validation...");
    setSimLogs([]); 

    try {
        // 1. Validation Step (Frontend Manifold)
        if (validateEnabled) {
            if (!selectedLayerId) throw new Error("Please select a target layer.");
            
            const activeSplitSettings = (activePlan as any)?.layerSplitSettings?.[selectedLayerId];
            
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
                setProcessMessage(`Validating: ${progress.message}`);
                setProcessPercent(progress.percent * 100);
            });

            if (manifoldResult && manifoldResult.meshData) {
                setManifoldMetrics({
                    volume: manifoldResult.volume,
                    surfaceArea: manifoldResult.surfaceArea,
                    computedAt: Date.now()
                });

                const geo = new THREE.BufferGeometry();
                geo.setAttribute('position', new THREE.Float32BufferAttribute(manifoldResult.meshData.vertices, 3));
                if (manifoldResult.meshData.indices) geo.setIndex(Array.from(manifoldResult.meshData.indices));
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
            }
        }

        // 2. Meshing Step (Backend Gmsh)
        setSimMode('meshing'); 
        setProcessMessage("Preparing Gmsh Geometry...");
        setProcessPercent(0);

        // Handle Split Lines for Gmsh
        let processedFootprint = JSON.parse(JSON.stringify(targetFootprint)); 
        const splitSettings = (activePlan as any).layerSplitSettings?.[selectedLayerId];

        if (splitSettings?.enabled) {
            const kerf = parseFloat(splitSettings.kerf || "0.5");
            const newShapes: any[] = [];
            
            processedFootprint.shapes.forEach((s: any) => {
                if (s.type === "splitLine") {
                    const isActive = !splitSettings.lineIds || splitSettings.lineIds.includes(s.id);
                    if (isActive) {
                        const startX = evaluateExpression(s.x, params);
                        const startY = evaluateExpression(s.y, params);
                        const endX = startX + evaluateExpression(s.endX, params);
                        const endY = startY + evaluateExpression(s.endY, params);
                        const positions = (s.dovetailPositions || []).map((p: string) => evaluateExpression(p, params));
                        const dWidth = evaluateExpression(s.dovetailWidth, params);
                        const dHeight = evaluateExpression(s.dovetailHeight, params);
                        
                        const rawPts = generateDovetailPoints(startX, startY, endX, endY, positions, dWidth, dHeight, !!s.flip);
                        
                        const mockLine: any = {
                            id: "temp_split_" + s.id,
                            type: "line",
                            points: rawPts.map(p => ({ x: p.x, y: p.y })),
                            thickness: String(kerf)
                        };

                        const outlinePts = getLineOutlinePoints(mockLine, params, kerf, 16, targetFootprint, footprints);
                        
                        if (outlinePts.length > 2) {
                            newShapes.push({
                                type: "polygon",
                                id: mockLine.id,
                                points: outlinePts.map(p => ({ x: p.x, y: p.y })),
                                assignedLayers: { [selectedLayerId]: { depth: "1000" } },
                                x: "0", y: "0"
                            });
                        }
                    }
                } else {
                    newShapes.push(s);
                }
            });
            processedFootprint.shapes = newShapes;
        }

        const feaRequest = {
            footprint: processedFootprint,
            stackup: stackup,
            params: params,
            mesh_size: meshSize,
            target_layer_id: selectedLayerId,
            part_index: partIndex
        };

        const result: any = await invoke("run_gmsh_pipeline", { req: feaRequest })
            .catch(err => { throw new Error("Backend invoke failed: " + JSON.stringify(err)); });
        
        setGmshMetrics({
            volume: result.volume,
            surfaceArea: result.surface_area,
            computedAt: Date.now()
        });

        if (result.mesh && result.mesh.vertices) {
            const flatVerts = result.mesh.vertices.flat();
            const tetIndices = result.mesh.indices.map((t: number[]) => [t[0], t[1], t[2], t[3]]);
            setTetMesh({ vertices: flatVerts, indices: tetIndices });

            let min = new THREE.Vector3(Infinity, Infinity, Infinity);
            let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
            for(let i=0; i<flatVerts.length; i+=3) {
                const x = flatVerts[i], y = flatVerts[i+1], z = flatVerts[i+2];
                if (x < min.x) min.x = x; if (y < min.y) min.y = y; if (z < min.z) min.z = z;
                if (x > max.x) max.x = x; if (y > max.y) max.y = y; if (z > max.z) max.z = z;
            }
            const size = new THREE.Vector3().subVectors(max, min);
            const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
            setGmshBounds({ min, max, center, size });
        }

        setVisualSource('gmsh');
        setViewMode('mesh');

    } catch (e) {
        console.error(e);
        alert("Simulation Failed: " + e);
    } finally {
        setSimMode('idle');
    }
  };

  const metricDiff = (m1: number, m2: number) => {
      const diff = Math.abs(m1 - m2);
      const pct = (diff / ((m1+m2)/2)) * 100;
      return pct.toFixed(2) + "%";
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", position: "relative" }}>
      {/* UI Overlays */}
      {simMode === 'preview' && <PreviewToast message={processMessage} percent={processPercent} />}
      {(simMode === 'validating' || simMode === 'meshing') && (
          <LoadingOverlay 
              message={processMessage} 
              percent={processPercent} 
              logs={simLogs}
              onAbort={simMode === 'meshing' ? () => invoke("abort_gmsh") : undefined} 
          />
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
            
            <div style={{ marginBottom: "15px" }}>
                <label className="checkbox-label" style={{ display: "flex", alignItems: "center", gap: "8px", color: "#ccc", cursor: "pointer" }}>
                    <input 
                        type="checkbox" 
                        checked={validateEnabled} 
                        onChange={(e) => setValidateEnabled(e.target.checked)} 
                    />
                    Validate against Manifold
                </label>
            </div>

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

        <Canvas shadows camera={{ position: [50, 50, 50], fov: 45 }}>
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
                    const center = manifoldBounds?.center || gmshBounds?.center || new THREE.Vector3(0,0,0);
                    
                    return (
                        <group position={[-center.x, -center.y, -center.z]}>
                            {visualSource === 'manifold' && previewGeo && (
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
                            )}

                            {visualSource === 'gmsh' && tetMesh && gmshBounds && (
                                <group rotation={[-Math.PI / 2, 0, 0]}>
                                    <group position={[-gmshBounds.center.x, -gmshBounds.center.y, -gmshBounds.center.z]}>
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
                        </group>
                    );
                })()}
            </group>
        </Canvas>
      </div>
    </div>
  );
}