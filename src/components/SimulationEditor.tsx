import { useState, useRef, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { 
  OrbitControls, 
  Grid, 
  Environment, 
  GizmoHelper, 
  GizmoViewport 
} from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import * as THREE from "three";
import { STLLoader } from "three-stdlib";
import TetrahedralRenderer from "./TetrahedralRenderer";

// Simple Spinner Component
function LoadingOverlay({ message }: { message: string }) {
    return (
        <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
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

export default function SimulationEditor() {
  const [tetMesh, setTetMesh] = useState<any | null>(null);
  const [previewGeo, setPreviewGeo] = useState<THREE.BufferGeometry | null>(null);
  const [isMeshing, setIsMeshing] = useState(false);
  const [shrink, setShrink] = useState(0.8);
  const [stats, setStats] = useState({ tets: 0, verts: 0 });
  const [fileName, setFileName] = useState<string>("");
  const [modelPosition, setModelPosition] = useState<[number, number, number]>([0, 0, 0]);

  // --- Auto Rotate State ---
  const [autoRotate, setAutoRotate] = useState(true);
  const idleTimer = useRef<number | null>(null);
  const controlsRef = useRef<any>(null);

  const handleUserInteraction = () => {
    // User is interacting: stop rotation
    setAutoRotate(false);
    
    // Clear existing timer
    if (idleTimer.current) clearTimeout(idleTimer.current);

    // Set new timer to resume rotation after 3 seconds of idleness
    idleTimer.current = window.setTimeout(() => {
        setAutoRotate(true);
    }, 3000);
  };

  const handleHome = () => {
    if (controlsRef.current) controlsRef.current.reset();
  };

  // AABB Calculation
  useEffect(() => {
    if (!previewGeo && !tetMesh) return;

    let min = new THREE.Vector3(Infinity, Infinity, Infinity);
    let max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    if (tetMesh) {
        tetMesh.vertices.forEach((v: number[]) => {
            if (v[0] < min.x) min.x = v[0]; if (v[0] > max.x) max.x = v[0];
            if (v[1] < min.y) min.y = v[1]; if (v[1] > max.y) max.y = v[1];
            if (v[2] < min.z) min.z = v[2]; if (v[2] > max.z) max.z = v[2];
        });
    } else if (previewGeo) {
        previewGeo.computeBoundingBox();
        if (previewGeo.boundingBox) {
            min.copy(previewGeo.boundingBox.min);
            max.copy(previewGeo.boundingBox.max);
        }
    }

    if (min.x !== Infinity) {
        const centerX = (min.x + max.x) / 2;
        const centerZ = (min.z + max.z) / 2;
        setModelPosition([-centerX, -min.y, -centerZ]);
    }
  }, [previewGeo, tetMesh]);

  const handleOpenFile = async () => {
    try {
      const selected = await open({
        multiple: false, filters: [{ name: "STL Mesh", extensions: ["stl"] }],
      });
      if (selected && typeof selected === "string") {
        setFileName(selected);
        const content = await readFile(selected);
        const loader = new STLLoader();
        const geometry = loader.parse(content.buffer);
        geometry.computeVertexNormals();
        setPreviewGeo(geometry);
        setTetMesh(null); 
      }
    } catch (err) {
      console.error(err);
      alert("Could not load file.");
    }
  };

  const handleGenerate = async () => {
    if (!previewGeo) return;
    setIsMeshing(true);
    setTimeout(async () => {
        try {
            const positions = Array.from(previewGeo.attributes.position.array);
            const numVerts = positions.length / 3;
            let indices = previewGeo.index ? Array.from(previewGeo.index.array) : Array.from({ length: numVerts }, (_, i) => i);
            
            const result: any = await invoke("cmd_tetrahedralize", {
                vertices: positions, faces: indices
            });
            
            setTetMesh(result);
            setStats({ tets: result.indices.length / 4, verts: result.vertices.length });
        } catch (e) {
            console.error(e);
            alert("Meshing failed: " + e);
        } finally {
            setIsMeshing(false);
        }
    }, 100);
  };

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", position: "relative" }}>
      {/* LOADING OVERLAY */}
      {isMeshing && <LoadingOverlay message="Generating Tetrahedral Mesh..." />}

      {/* Sidebar Controls */}
      <div style={{ width: "320px", padding: "20px", background: "#222", borderRight: "1px solid #444", display: "flex", flexDirection: "column", gap: "20px", zIndex: 10 }}>
        <header>
            <h3 style={{ margin: "0 0 10px 0" }}>Simulation Setup</h3>
            <p style={{ fontSize: "0.8em", color: "#888", margin: 0 }}>Test the FEA mesh generation pipeline.</p>
        </header>
        
        <div style={{ padding: "15px", background: "#1a1a1a", borderRadius: "8px", border: "1px dashed #444" }}>
          <label style={{display:"block", marginBottom:"10px", fontWeight:"bold", color:"#ccc"}}>Input Mesh</label>
          <button onClick={handleOpenFile} style={{ width: "100%", marginBottom: "10px" }}>📂 Load STL File</button>
          {fileName && <div style={{ fontSize: "0.85em", wordBreak: "break-all", color: "#646cff" }}>{fileName.split(/[/\\]/).pop()}</div>}
        </div>

        <button className="primary" onClick={handleGenerate} disabled={!previewGeo || isMeshing} style={{ width: "100%", padding: "12px" }}>
          {isMeshing ? "Generating..." : "Generate Tetrahedra"}
        </button>

        {tetMesh && (
          <div style={{ padding: "15px", background: "#2a2a2a", borderRadius: "8px", border: "1px solid #444" }}>
            <h4 style={{ marginTop: 0 }}>Mesh Statistics</h4>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", fontSize: "0.9em" }}>
                <div style={{ color: "#888" }}>Nodes:</div><div style={{ textAlign: "right", fontWeight: "bold" }}>{stats.verts}</div>
                <div style={{ color: "#888" }}>Tetrahedra:</div><div style={{ textAlign: "right", fontWeight: "bold" }}>{stats.tets}</div>
            </div>
            <div style={{ marginTop: "20px" }}>
              <label style={{ fontSize: "0.8em", textTransform: "uppercase", fontWeight: "bold", color: "#666" }}>Explode View: {(shrink * 100).toFixed(0)}%</label>
              <input type="range" min="0.0" max="1.0" step="0.01" value={shrink} onChange={e => setShrink(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "#646cff" }} />
            </div>
          </div>
        )}
      </div>

      {/* 3D Viewport */}
      <div style={{ flex: 1, background: "#111", position: "relative" }}>
        <button onClick={handleHome} style={{ position: "absolute", top: "20px", right: "20px", zIndex: 5, padding: "8px 12px", background: "rgba(40,40,40,0.8)", border: "1px solid #555", borderRadius: "4px", color: "white", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", backdropFilter: "blur(4px)" }} title="Reset Camera to Center">
            <span>⌂</span> Home
        </button>

        {!previewGeo && !tetMesh && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", color: "#444" }}>Load an STL file to begin</div>}
        
        <Canvas shadows camera={{ position: [50, 50, 50], fov: 45 }}>
            {/* 1. Seamless Background: Color matches ground plane */}
            <color attach="background" args={['#1a1a1a']} />
            
            {/* 2. Fog: Blends floor into background. 
                Start (50) ensures object is clear, End (300) hides the grid edge. 
            */}
            <fog attach="fog" args={['#1a1a1a', 100, 300]} />

            <Environment preset="city" />
            
            <directionalLight 
                position={[50, 80, 50]} 
                intensity={10} 
                castShadow 
                shadow-mapSize={[4096, 4096]}
                shadow-bias={-0.0001}
                shadow-normalBias={0.1}
            >
                <orthographicCamera attach="shadow-camera" args={[-500, 500, 500, -500]} far={400} />
            </directionalLight>
            
            <hemisphereLight intensity={0.4} groundColor="#333" />
            
            {/* Ground Plane (color must match background for seamless effect) */}
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.1, 0]} receiveShadow>
                <planeGeometry args={[2000, 2000]} />
                <meshStandardMaterial color="#1a1a1a" roughness={0.8} metalness={0.2} />
            </mesh>
            
            <Grid infiniteGrid sectionColor="#444" cellColor="#2a2a2a" fadeDistance={250} position={[0, 0.01, 0]} />
            
            <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                <GizmoViewport axisColors={['#ff3653', '#0adb50', '#2c8fdf']} labelColor="black" />
            </GizmoHelper>
            
            {/* 3. Orbit Controls with Auto-Rotate Logic */}
            <OrbitControls 
                ref={controlsRef} 
                makeDefault 
                autoRotate={autoRotate}
                autoRotateSpeed={0.5} // Subtle rotation speed
                onStart={handleUserInteraction} // Detect drag start
                onEnd={handleUserInteraction}   // Detect drag end
            />

            <group position={modelPosition}>
                {previewGeo && !tetMesh && <mesh geometry={previewGeo} castShadow receiveShadow><meshStandardMaterial color="#aaa" roughness={0.3} metalness={0.2} side={THREE.DoubleSide} /></mesh>}
                {tetMesh && <TetrahedralRenderer mesh={tetMesh} shrinkFactor={shrink} color="#ff6b6b" />}
            </group>
        </Canvas>
      </div>
    </div>
  );
}