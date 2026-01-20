import { useState, useRef, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { 
  OrbitControls, 
  Environment, 
  GizmoHelper, 
  GizmoViewport,
  Text,
  Billboard
} from "@react-three/drei";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import * as THREE from "three";
import { STLLoader } from "three-stdlib";
import TetrahedralRenderer from "./TetrahedralRenderer";
import SurfaceRenderer from "./SurfaceRenderer";

// --- Ruler Component ---
interface Bounds {
    size: THREE.Vector3;
    center: THREE.Vector3;
    min: THREE.Vector3;
}

const AXIS_COLORS = {
    x: '#ff3653',
    y: '#0adb50',
    z: '#2c8fdf',
    label: '#ffcc00'
};

function FloatingCornerWidget({ size, maxEdgeLen, fontSize }: { size: THREE.Vector3, maxEdgeLen: number, fontSize: number }) {
    const groupRef = useRef<THREE.Group>(null);
    const { camera } = useThree();

    const [directions, setDirections] = useState({ x: 1, y: 1, z: 1 });

    useFrame(() => {
        if (!groupRef.current) return;

        const hX = size.x / 2;
        const hY = size.y / 2;
        const hZ = size.z / 2;

        const corners = [
            new THREE.Vector3( hX,  hY,  hZ), new THREE.Vector3( hX,  hY, -hZ),
            new THREE.Vector3( hX, -hY,  hZ), new THREE.Vector3( hX, -hY, -hZ),
            new THREE.Vector3(-hX,  hY,  hZ), new THREE.Vector3(-hX,  hY, -hZ),
            new THREE.Vector3(-hX, -hY,  hZ), new THREE.Vector3(-hX, -hY, -hZ),
        ];

        const cameraLocalPos = groupRef.current.parent!.worldToLocal(camera.position.clone());
        let closestIdx = 0;
        let minDist = Infinity;
        
        corners.forEach((c, i) => {
            const dist = c.distanceTo(cameraLocalPos);
            if (dist < minDist) {
                minDist = dist;
                closestIdx = i;
            }
        });

        const targetCorner = corners[closestIdx];
        const dirX = targetCorner.x > 0 ? -1 : 1;
        const dirY = targetCorner.y > 0 ? -1 : 1;
        const dirZ = targetCorner.z > 0 ? -1 : 1;
        
        const offset = new THREE.Vector3(0,0,0);
        groupRef.current.position.lerp(targetCorner.clone().add(offset), 0.1);
        
        if (dirX !== directions.x || dirY !== directions.y || dirZ !== directions.z) {
            setDirections({ x: dirX, y: dirY, z: dirZ });
        }
    });

    const thickness = fontSize * 0.1;

    return (
        <group ref={groupRef}>
            <mesh position={[(maxEdgeLen / 2) * directions.x, 0, 0]}>
                <boxGeometry args={[maxEdgeLen, thickness, thickness]} />
                <meshBasicMaterial color={AXIS_COLORS.x} />
            </mesh>
            <mesh position={[0, (maxEdgeLen / 2) * directions.y, 0]}>
                <boxGeometry args={[thickness, maxEdgeLen, thickness]} />
                <meshBasicMaterial color={AXIS_COLORS.y} />
            </mesh>
            <mesh position={[0, 0, (maxEdgeLen / 2) * directions.z]}>
                <boxGeometry args={[thickness, thickness, maxEdgeLen]} />
                <meshBasicMaterial color={AXIS_COLORS.z} />
            </mesh>
            <mesh>
                <sphereGeometry args={[thickness * 1.5]} />
                <meshBasicMaterial color="white" />
            </mesh>
            <Billboard position={[-directions.x * fontSize, directions.y * fontSize, -directions.z * fontSize]}>
                <Text fontSize={fontSize * 0.8} color={AXIS_COLORS.label} outlineWidth={0.02} outlineColor="#000">
                    a = {maxEdgeLen}mm
                </Text>
            </Billboard>
        </group>
    );
}

function RulerOverlay({ bounds, maxEdgeLen, visible }: { bounds: Bounds | null, maxEdgeLen: number, visible: boolean }) {
    if (!visible || !bounds) return null;

    const { size, center } = bounds;
    const fontSize = Math.max(size.x, size.y, size.z) * 0.05;

    return (
        <group position={center} name="ruler-overlay">
            <group>
                <mesh>
                    <boxGeometry args={[size.x, size.y, size.z]} />
                    <meshBasicMaterial visible={false} />
                    <lineSegments>
                        <edgesGeometry args={[new THREE.BoxGeometry(size.x, size.y, size.z)]} />
                        <lineBasicMaterial color="#ffffff" opacity={0.5} transparent />
                    </lineSegments>
                </mesh>
            </group>

            <Billboard position={[0, size.y / 2 - fontSize * 1.5, size.z / 2]}>
                <Text fontSize={fontSize} color={AXIS_COLORS.x}>W: {size.x.toFixed(1)}</Text>
            </Billboard>
            <Billboard position={[-size.x / 2 - fontSize * 1.5, 0, size.z / 2]}>
                <Text fontSize={fontSize} color={AXIS_COLORS.y}>H: {size.y.toFixed(1)}</Text>
            </Billboard>
            <Billboard position={[size.x / 2 + fontSize * 1.5, size.y / 2 - fontSize * 1.5, 0]}>
                <Text fontSize={fontSize} color={AXIS_COLORS.z}>D: {size.z.toFixed(1)}</Text>
            </Billboard>

            {maxEdgeLen > 0 && (
                <FloatingCornerWidget size={size} maxEdgeLen={maxEdgeLen} fontSize={fontSize} />
            )}
        </group>
    );
}

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
  const [repairedMesh, setRepairedMesh] = useState<THREE.BufferGeometry | null>(null);
  const [previewGeo, setPreviewGeo] = useState<THREE.BufferGeometry | null>(null);
  const [isMeshing, setIsMeshing] = useState(false);
  const [shrink, setShrink] = useState(0.8);
  const [stats, setStats] = useState({ tets: 0, verts: 0 });
  const [fileName, setFileName] = useState<string>("");
  const [modelPosition, setModelPosition] = useState<[number, number, number]>([0, 0, 0]);
  const [viewMode, setViewMode] = useState<'surface' | 'volume'>('surface');
  
  // --- Updated State ---
  const [maxEdgeLen, setMaxEdgeLen] = useState<number>(3.0); // Default 3.0mm
  const [enableRegularization, setEnableRegularization] = useState(true); // Default ON
  const [showRuler, setShowRuler] = useState(false);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  const [autoRotate, setAutoRotate] = useState(true);
  const idleTimer = useRef<number | null>(null);
  const controlsRef = useRef<any>(null);

  const handleUserInteraction = () => {
    setAutoRotate(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
        setAutoRotate(true);
    }, 3000);
  };

  const handleHome = () => {
    if (controlsRef.current) controlsRef.current.reset();
  };

  useEffect(() => {
    if (!previewGeo && !tetMesh) {
        setBounds(null);
        return;
    }

    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

    if (tetMesh) {
        for(let i=0; i<tetMesh.vertices.length; i+=3) {
            const x = tetMesh.vertices[i];
            const y = tetMesh.vertices[i+1];
            const z = tetMesh.vertices[i+2];
            if(x < min.x) min.x = x; if(x > max.x) max.x = x;
            if(y < min.y) min.y = y; if(y > max.y) max.y = y;
            if(z < min.z) min.z = z; if(z > max.z) max.z = z;
        }
    } else if (repairedMesh) {
        repairedMesh.computeBoundingBox();
        if (repairedMesh.boundingBox) {
            min.copy(repairedMesh.boundingBox.min);
            max.copy(repairedMesh.boundingBox.max);
        }
    } else if (previewGeo) {
        previewGeo.computeBoundingBox();
        if (previewGeo.boundingBox) {
            min.copy(previewGeo.boundingBox.min);
            max.copy(previewGeo.boundingBox.max);
        }
    }

    if (min.x !== Infinity) {
        const size = new THREE.Vector3().subVectors(max, min);
        const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
        
        setBounds({ size, center, min });

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
        setRepairedMesh(null);
        setTetMesh(null); 
      }
    } catch (err) {
      console.error(err);
      alert("Could not load file.");
    }
  };

  const handleRepairPreview = async () => {
    if (!previewGeo) return;
    setIsMeshing(true);
    try {
        const positions = Array.from(previewGeo.attributes.position.array);
        // Invoke Gmsh via Rust
        const result: any = await invoke("cmd_repair_mesh", {
            vertices: positions,
            targetLen: enableRegularization ? maxEdgeLen : 0.0
        });

        // Result contains vertices [x,y,z, x,y,z...]
        // Reconstruct BufferGeometry
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(result.vertices, 3));
        geometry.computeVertexNormals();
        
        setRepairedMesh(geometry);
        setTetMesh(null); // Clear volume mesh if we have a new surface
    } catch (e) {
        console.error(e);
        alert("Gmsh Repair Failed: " + e);
    } finally {
        setIsMeshing(false);
    }
  };

  const handleGenerate = async () => {
    if (!previewGeo) return;
    setIsMeshing(true);
    setTimeout(async () => {
        try {
            const positions = Array.from(previewGeo.attributes.position.array);
            
            let flags = "pqz"; 
            
            // Only apply regularization and max volume if enabled
            const effectiveEdgeLen = enableRegularization ? maxEdgeLen : 0;

            if (enableRegularization && maxEdgeLen > 0) {
                const maxVol = (Math.pow(maxEdgeLen, 3) / 8.48).toFixed(5);
                flags += `a${maxVol}`;
            }

            const result: any = await invoke("cmd_tetrahedralize", {
                vertices: positions, 
                options: flags,
                targetLen: effectiveEdgeLen > 0 ? effectiveEdgeLen : null
            });
            
            setTetMesh(result);
            const numTets = result.indices.length / 4;
            setStats({ tets: numTets, verts: Math.floor(result.vertices.length / 3) });

            if (numTets > 50000) setViewMode('surface');
            else setViewMode('volume');

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
      {isMeshing && <LoadingOverlay message="Generating Tetrahedral Mesh..." />}

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

        {/* --- Meshing Parameters (Updated) --- */}
        <div style={{ padding: "12px", background: "#333", borderRadius: "6px", fontSize: "0.9em" }}>
             <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", fontWeight: "bold", color: "#ccc", cursor: "pointer" }}>
                <input 
                    type="checkbox" 
                    checked={enableRegularization} 
                    onChange={e => setEnableRegularization(e.target.checked)} 
                />
                Regularize Mesh
            </label>
            
            <div style={{ paddingLeft: "22px", opacity: enableRegularization ? 1 : 0.5 }}>
                <label style={{ display: "block", fontSize: "0.8em", color: "#888", marginBottom: "4px" }}>
                    Target Edge Length (mm)
                </label>
                <input 
                    type="number" 
                    min="0.1" 
                    step="0.1" 
                    value={maxEdgeLen} 
                    disabled={!enableRegularization}
                    onChange={e => setMaxEdgeLen(Math.max(0.1, parseFloat(e.target.value)))}
                    style={{ 
                        width: "100%", 
                        padding: "6px", 
                        background: "#222", 
                        border: "1px solid #555", 
                        color: "white",
                        borderRadius: "4px" 
                    }}
                />
            </div>
            <div style={{ fontSize: "0.75em", color: "#666", marginTop:"8px", lineHeight: "1.4" }}>
                {enableRegularization 
                    ? "Enforces uniform element density and simplifies overly dense regions." 
                    : "Uses raw curvature adaptation (default TetGen)."}
            </div>
        </div>

        <div style={{ display: "flex", gap: "10px" }}>
            <button onClick={handleRepairPreview} disabled={!previewGeo || isMeshing} style={{ flex: 1, padding: "10px", fontSize: "0.9em", background: "#444", border: "1px solid #666", color: "white", cursor: "pointer", borderRadius: "4px" }}>
                👁 Preview Fixed
            </button>
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
            
            <div style={{ marginTop: "15px", borderTop: "1px solid #444", paddingTop: "10px" }}>
                <label style={{ display:"block", color:"#aaa", marginBottom:"5px" }}>Render Mode</label>
                <div style={{ display:"flex", gap:"5px" }}>
                    <button onClick={() => setViewMode('surface')} style={{ flex:1, background: viewMode === 'surface' ? '#646cff' : '#444', border:'none', color:'white', padding:'5px', cursor:'pointer' }}>Surface</button>
                    <button onClick={() => setViewMode('volume')} style={{ flex:1, background: viewMode === 'volume' ? '#646cff' : '#444', border:'none', color:'white', padding:'5px', cursor:'pointer' }}>Volume</button>
                </div>
            </div>

            {viewMode === 'volume' && (
                <div style={{ marginTop: "15px" }}>
                    <label style={{ fontSize: "0.8em", textTransform: "uppercase", fontWeight: "bold", color: "#666" }}>Explode View: {(shrink * 100).toFixed(0)}%</label>
                    <input type="range" min="0.0" max="1.0" step="0.01" value={shrink} onChange={e => setShrink(parseFloat(e.target.value))} style={{ width: "100%", accentColor: "#646cff" }} />
                </div>
            )}
            
            {/* Removed Slider, removed display of angle. Render logic passes 0. */}
          </div>
        )}
      </div>

      <div style={{ flex: 1, background: "#111", position: "relative" }}>
        
        <div style={{ position: "absolute", top: "20px", right: "20px", zIndex: 5, display: "flex", gap: "10px" }}>
            <button 
                onClick={() => setShowRuler(!showRuler)}
                style={{
                    padding: "8px 12px", background: showRuler ? "#646cff" : "rgba(40,40,40,0.8)",
                    border: "1px solid #555", borderRadius: "4px", color: "white",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: "5px",
                    backdropFilter: "blur(4px)"
                }}
            >
                <span>📏</span> Ruler
            </button>

            <button 
                onClick={handleHome}
                style={{
                    padding: "8px 12px", background: "rgba(40,40,40,0.8)",
                    border: "1px solid #555", borderRadius: "4px", color: "white",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: "5px",
                    backdropFilter: "blur(4px)"
                }}
            >
                <span>⌂</span> Home
            </button>
        </div>

        {!previewGeo && !tetMesh && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", color: "#444" }}>Load an STL file to begin</div>}
        
        <Canvas shadows camera={{ position: [50, 50, 50], fov: 45 }}>
            <color attach="background" args={['#1a1a1a']} />
            <Environment preset="city" />
            <directionalLight position={[50, 80, 50]} intensity={1.5} castShadow shadow-mapSize={[4096, 4096]} shadow-bias={-0.001} shadow-normalBias={0.1}>
                <orthographicCamera attach="shadow-camera" args={[-500, 500, 500, -500]} far={400} />
            </directionalLight>
            <hemisphereLight intensity={0.4} groundColor="#333" />
            
            <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
                <GizmoViewport axisColors={['#ff3653', '#0adb50', '#2c8fdf']} labelColor="black" />
            </GizmoHelper>
            
            <OrbitControls ref={controlsRef} makeDefault autoRotate={autoRotate} autoRotateSpeed={0.5} onStart={handleUserInteraction} onEnd={handleUserInteraction} />

            <group position={modelPosition}>
                {/* Original Mesh (Gray) - Only show if no repair and no tet mesh */}
                {previewGeo && !tetMesh && !repairedMesh && (
                    <mesh geometry={previewGeo} castShadow receiveShadow>
                        <meshStandardMaterial color="#aaa" roughness={0.3} metalness={0.2} side={THREE.DoubleSide} shadowSide={THREE.BackSide} />
                    </mesh>
                )}

                {/* Repaired Mesh (Cyan with Wireframe) */}
                {repairedMesh && !tetMesh && (
                    <group>
                        <mesh geometry={repairedMesh} castShadow receiveShadow>
                            <meshStandardMaterial color="#00cccc" roughness={0.5} metalness={0.1} side={THREE.DoubleSide} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
                        </mesh>
                        <mesh geometry={repairedMesh}>
                            <meshBasicMaterial color="#00ffff" wireframe />
                        </mesh>
                    </group>
                )}

                {tetMesh && (
                    <>
                        {viewMode === 'volume' ? 
                            <TetrahedralRenderer mesh={tetMesh} shrinkFactor={shrink} color="#ff6b6b" /> : 
                            <SurfaceRenderer 
                                mesh={tetMesh} 
                                color="#ff6b6b" 
                                threshold={0} // Force full wireframe
                            />
                        }
                    </>
                )}
                
                <RulerOverlay 
                    bounds={bounds} 
                    // Only show 'a' on the ruler if Regularization is ON
                    maxEdgeLen={enableRegularization ? maxEdgeLen : 0} 
                    visible={showRuler} 
                />
            </group>
        </Canvas>
      </div>
    </div>
  );
}