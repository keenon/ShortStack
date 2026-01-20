import { useState, useRef, useEffect, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { 
  OrbitControls, 
  Environment, 
  GizmoHelper, 
  GizmoViewport,
  Billboard,
  Text
} from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import TetrahedralRenderer from "./TetrahedralRenderer";
import SurfaceRenderer from "./SurfaceRenderer";
import { FabricationPlan, Footprint, StackupLayer, Parameter } from "../types";
import { callWorker } from "./Footprint3DView"; // Reuse the Manifold worker connection
import { evaluateExpression } from "../utils/footprintUtils";

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

// --- Helper UI Components ---
function LoadingOverlay({ message }: { message: string }) {
    return (
        <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, backdropFilter: 'blur(5px)'
        }}>
            <div className="spinner" style={{
                width: '50px', height: '50px', border: '5px solid #444',
                borderTop: '5px solid #646cff', borderRadius: '50%',
                animation: 'spin 1s linear infinite'
            }} />
            <h3 style={{ marginTop: '20px', color: 'white' }}>{message}</h3>
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
}

export default function SimulationEditor({ footprints, fabPlans, stackup, params }: Props) {
  // State
  const [activePlanId, setActivePlanId] = useState<string>(fabPlans.length > 0 ? fabPlans[0].id : "");
  const [isProcessing, setIsProcessing] = useState(false);
  const [processMessage, setProcessMessage] = useState("");
  
  // Data State
  const [manifoldMetrics, setManifoldMetrics] = useState<ComparisonMetrics | null>(null);
  const [gmshMetrics, setGmshMetrics] = useState<ComparisonMetrics | null>(null);
  const [previewGeo, setPreviewGeo] = useState<THREE.BufferGeometry | null>(null);
  const [tetMesh, setTetMesh] = useState<{ vertices: number[], indices: number[][] } | null>(null);
  
  // Visual State
  const [viewMode, setViewMode] = useState<'boundary' | 'mesh'>('boundary');
  const [layerClip, setLayerClip] = useState<number>(1.0); // 0.0 to 1.0
  const [shrink, setShrink] = useState(0.9);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  
  const controlsRef = useRef<any>(null);

  const activePlan = fabPlans.find(p => p.id === activePlanId);
  const targetFootprint = footprints.find(f => f.id === activePlan?.footprintId);

  // --- 1. Compute Geometry & Compare (Stage 1) ---
  const handleVerifyGeometry = async () => {
    if (!activePlan || !targetFootprint) return;
    setIsProcessing(true);
    setProcessMessage("Computing Manifold Geometry...");
    
    try {
        // A. FRONTEND (MANIFOLD) CALCULATION
        // We reuse the worker logic to get a precise volume/area from the frontend geometry engine
        // We calculate the FULL stackup merged
        const totalThickness = stackup.reduce((acc, l) => acc + evaluateExpression(l.thicknessExpression, params), 0);
        
        const manifoldResult = await callWorker("computeFullStackupMetrics", {
            footprint: targetFootprint,
            allFootprints: footprints,
            stackup,
            params,
            fabPlan: activePlan
        });

        setManifoldMetrics({
            volume: manifoldResult.volume,
            surfaceArea: manifoldResult.surfaceArea,
            computedAt: Date.now()
        });

        // Generate Preview Mesh for display
        if (manifoldResult.meshData) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(manifoldResult.meshData.vertices, 3));
            if (manifoldResult.meshData.indices) {
                geo.setIndex(manifoldResult.meshData.indices);
            }
            geo.computeVertexNormals();
            geo.computeBoundingBox();
            setPreviewGeo(geo);
            
            // Calculate Bounds
            if (geo.boundingBox) {
                const size = new THREE.Vector3();
                const center = new THREE.Vector3();
                geo.boundingBox.getSize(size);
                geo.boundingBox.getCenter(center);
                setBounds({ min: geo.boundingBox.min, max: geo.boundingBox.max, center, size });
            }
        }

        // B. BACKEND (GMSH) VERIFICATION
        setProcessMessage("Verifying with Sidecar...");
        
        // Prepare payload for Rust
        const feaRequest = {
            footprint: targetFootprint,
            stackup: stackup, // Ensure serialization works on Rust side
            params: params,
            quality: 0.0 // 0.0 means "Don't mesh yet, just build geo and inspect"
        };

        const gmshResult: any = await invoke("run_gmsh_meshing", { req: feaRequest });
        
        setGmshMetrics({
            volume: gmshResult.volume,
            surfaceArea: gmshResult.surface_area,
            computedAt: Date.now()
        });

        setViewMode('boundary');
        setTetMesh(null);

    } catch (e) {
        console.error(e);
        alert("Geometry Verification Failed: " + e);
    } finally {
        setIsProcessing(false);
    }
  };

  // --- 2. Generate Tetrahedral Mesh (Stage 2) ---
  const handleGenerateMesh = async () => {
    if (!activePlan || !targetFootprint) return;
    setIsProcessing(true);
    setProcessMessage("Generating Tetrahedral Mesh (this may take a moment)...");

    try {
        const feaRequest = {
            footprint: targetFootprint,
            stackup: stackup,
            params: params,
            quality: 1.0 // High quality Request
        };

        // Call the sidecar via Rust
        const result: any = await invoke("run_gmsh_meshing", { req: feaRequest });
        
        // Result.mesh contains { vertices: [[x,y,z]...], indices: [[n1...n10]...] }
        // We need to flatten vertices for ThreeJS
        const flatVerts = result.mesh.vertices.flat();
        // Take only first 4 nodes of 10-node tets for visualization (corners)
        const tetIndices = result.mesh.indices.map((t: number[]) => [t[0], t[1], t[2], t[3]]);

        setTetMesh({
            vertices: flatVerts,
            indices: tetIndices
        });
        
        setViewMode('mesh');

    } catch (e) {
        console.error(e);
        alert("Meshing Failed: " + e);
    } finally {
        setIsProcessing(false);
    }
  };

  const metricDiff = (m1: number, m2: number) => {
      const diff = Math.abs(m1 - m2);
      const pct = (diff / ((m1+m2)/2)) * 100;
      return pct.toFixed(2) + "%";
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", position: "relative" }}>
      {isProcessing && <LoadingOverlay message={processMessage} />}

      {/* --- SIDEBAR CONTROLS --- */}
      <div style={{ width: "350px", background: "#222", borderRight: "1px solid #444", display: "flex", flexDirection: "column" }}>
        
        {/* Header / Selection */}
        <div style={{ padding: "20px", borderBottom: "1px solid #333" }}>
            <h3 style={{ margin: "0 0 15px 0" }}>FEA Pre-processor</h3>
            <label style={{ fontSize: "0.85em", color: "#888" }}>Fabrication Plan</label>
            <select 
                value={activePlanId} 
                onChange={(e) => setActivePlanId(e.target.value)}
                style={{ width: "100%", marginTop: "5px", padding: "8px", background: "#333", border: "1px solid #555", color: "white" }}
            >
                {fabPlans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
        </div>

        {/* Step 1: Geometry Verification */}
        <div style={{ padding: "20px", borderBottom: "1px solid #333" }}>
            <h4 style={{ margin: "0 0 10px 0", color: "#ccc" }}>1. Geometry & Verification</h4>
            <button className="secondary" onClick={handleVerifyGeometry} style={{ width: "100%", padding: "10px" }}>
                Compute & Verify Geometry
            </button>

            {manifoldMetrics && gmshMetrics && (
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
                    <div style={{ marginTop: "8px", fontSize: "0.8em", color: "#666", fontStyle: "italic" }}>
                        Note: Discrepancies &lt;1% are expected due to triangulation differences.
                    </div>
                </div>
            )}
        </div>

        {/* Step 2: Meshing */}
        <div style={{ padding: "20px", flex: 1, display: "flex", flexDirection: "column" }}>
            <h4 style={{ margin: "0 0 10px 0", color: "#ccc" }}>2. Discretization</h4>
            <button 
                className="primary" 
                onClick={handleGenerateMesh} 
                disabled={!manifoldMetrics} // Force verification first
                style={{ width: "100%", padding: "12px", marginBottom: "20px" }}
            >
                Generate Tetrahedrons
            </button>

            {/* View Controls */}
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
        
        {/* Toggle Mode Button (Floating) */}
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

            <group position={[0,0,0]}> {/* Center geometry if needed */}
                {/* 1. Boundary View (Manifold Output) */}
                {viewMode === 'boundary' && previewGeo && (
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

                {/* 2. Tetrahedral Mesh View (Gmsh Output) */}
                {viewMode === 'mesh' && tetMesh && bounds && (
                    <TetrahedralRenderer 
                        mesh={tetMesh} 
                        shrinkFactor={shrink} 
                        color="#ff6b6b" 
                        minZ={bounds.min.z} // Assuming Z is up in geometry
                        // Calculate clip height based on bounds
                        clipZ={bounds.min.z + (bounds.max.z - bounds.min.z) * layerClip} 
                    />
                )}
            </group>
        </Canvas>
      </div>
    </div>
  );
}