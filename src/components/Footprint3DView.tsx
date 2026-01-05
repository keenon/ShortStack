// src/components/Footprint3DView.tsx
import { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls, Edges } from "@react-three/drei";
import * as THREE from "three";
import { Footprint, Parameter, StackupLayer, FootprintMesh, FootprintReference, FootprintUnion, MeshAsset, FootprintBoardOutline } from "../types";
import { mergeVertices } from "three-stdlib";
import { evaluateExpression, resolvePoint, modifyExpression } from "../utils/footprintUtils";

// WORKER IMPORT
import MeshWorker from "../workers/meshWorker?worker";

// WASM URLS (Passed to worker)
// @ts-ignore
import wasmUrl from "manifold-3d/manifold.wasm?url";
// @ts-ignore
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // Required for recursion
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
  visibleLayers?: Record<string, boolean>;
  is3DActive: boolean;
  // NEW: Selection Props
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpdateMesh: (id: string, field: string, val: any) => void;
}

export interface Footprint3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
    processDroppedFile: (file: File) => Promise<FootprintMesh | null>;
    convertMeshToGlb: (mesh: FootprintMesh) => Promise<FootprintMesh | null>;
}

// ------------------------------------------------------------------
// WORKER INFRASTRUCTURE
// ------------------------------------------------------------------

let sharedWorker: Worker | null = null;
let initPromise: Promise<void> | null = null;
const workerCallbacks = new Map<string, {resolve: (v:any)=>void, reject: (e:any)=>void, onProgress?: (p:any)=>void}>();

function getWorker() {
    if (!sharedWorker) {
        sharedWorker = new MeshWorker();
        sharedWorker.onmessage = (e) => {
            const { id, type, payload, error } = e.data;
            
            // Handle Progress Updates (Do not resolve promise yet)
            if (type === "progress") {
                const cb = workerCallbacks.get(id);
                if (cb && cb.onProgress) cb.onProgress(payload);
                return;
            }

            if (workerCallbacks.has(id)) {
                const cb = workerCallbacks.get(id)!;
                if (type === "error") cb.reject(new Error(error));
                else cb.resolve(payload);
                workerCallbacks.delete(id);
            }
        };
        
        // Initialize Worker and store promise
        initPromise = new Promise((resolve, reject) => {
            const initId = crypto.randomUUID();
            workerCallbacks.set(initId, { resolve, reject });
            sharedWorker!.postMessage({ 
                id: initId, 
                type: "init", 
                payload: { occtWasmUrl, manifoldWasmUrl: wasmUrl } 
            });
        });
    }
    return sharedWorker;
}

async function callWorker(type: string, payload: any, onProgress?: (p: any) => void): Promise<any> {
    const worker = getWorker();
    
    // WAIT FOR INIT TO COMPLETE
    if (initPromise) {
        try {
            await initPromise;
        } catch (e) {
            console.error("Worker initialization failed", e);
            throw e;
        }
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        workerCallbacks.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, type, payload });
    });
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function evaluate(expression: string, params: Parameter[]): number {
  return evaluateExpression(expression, params);
}

const ProgressBar = ({ progress }: { progress: { active: boolean, text: string, percent: number } }) => {
    // Only return null if strictly not active to allow fade out
    if (!progress.active) return null;
    return (
        <div style={{
            position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(30, 30, 30, 0.9)', padding: '15px 20px', borderRadius: '8px', border: '1px solid #444',
            color: 'white', display: 'flex', flexDirection: 'column', gap: '8px', width: '420px',
            pointerEvents: 'none', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            transition: 'opacity 0.3s', opacity: progress.active ? 1 : 0
        }}>
            <div style={{ fontSize: '0.85em', display: 'flex', justifyContent: 'space-between', color: '#ccc' }}>
                <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '350px' }}>
                    {progress.text}
                </span>
                <span style={{ fontFamily: 'monospace' }}>{Math.round(progress.percent * 100)}%</span>
            </div>
            <div style={{ width: '100%', height: '6px', background: '#111', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, progress.percent * 100))}%`, height: '100%', background: '#646cff', transition: 'width 0.2s ease-out' }} />
            </div>
        </div>
    );
};

// ------------------------------------------------------------------
// COMPONENTS (LayerSolid, MeshObject)
// ------------------------------------------------------------------

const LayerSolid = ({
  layer,
  footprint,
  allFootprints,
  params,
  bottomZ,
  thickness,
  bounds,
  layerIndex,
  totalLayers,
  onProgress,
  registerMesh
}: {
  layer: StackupLayer;
  footprint: Footprint;
  allFootprints: Footprint[];
  params: Parameter[];
  bottomZ: number;
  thickness: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  layerIndex: number;
  totalLayers: number;
  onProgress: (id: string, percent: number, msg: string) => void;
  registerMesh?: (id: string, mesh: THREE.Mesh | null) => void;
}) => {
  // Determine Center X/Z to match Worker Logic
  // This ensures the local geometry returned by the worker aligns with the React mesh position
  const isBoard = footprint.isBoard;
  
  const assignments = footprint.boardOutlineAssignments || {};
  const assignedId = assignments[layer.id];
  let outlineShape = footprint.shapes.find(s => s.id === assignedId);
  if (!outlineShape) {
      outlineShape = footprint.shapes.find(s => s.type === "boardOutline");
  }
  
  // If board + outline exists, origin is 0,0. Else, bounds center.
  const useBoardOrigin = isBoard && !!outlineShape;
  const centerX = useBoardOrigin ? 0 : (bounds.minX + bounds.maxX) / 2;
  const centerZ = useBoardOrigin ? 0 : (bounds.minY + bounds.maxY) / 2;
  const centerY = bottomZ + thickness / 2;

  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (thickness <= 0.0001) {
        onProgress(layer.id, 1.0, `Layer ${layer.name} skipped`);
        return;
    }
    
    let cancelled = false;
    setHasError(false);

    // Initial Progress
    onProgress(layer.id, 0.01, `Layer ${layer.name}: Queued...`);

    callWorker("computeLayer", {
        layer, 
        footprint, 
        allFootprints, 
        params, 
        bottomZ, 
        thickness, 
        bounds,
        layerIndex,
        totalLayers
    }, (p) => {
        if (!cancelled && onProgress) {
             onProgress(layer.id, p.percent, p.message);
        }
    }).then((data) => {
        if (cancelled) return;
        
        if (data.vertProperties && data.triVerts) {
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position', new THREE.BufferAttribute(data.vertProperties, 3));
            geom.setIndex(new THREE.BufferAttribute(data.triVerts, 1));
            geom.computeVertexNormals();
            setGeometry(geom);
        } else {
            setGeometry(null);
        }
        // Ensure we hit 100% on success to clear the bar
        onProgress(layer.id, 1.0, `Layer ${layer.name}: Ready`);
    }).catch(e => {
        if (cancelled) return;
        console.error(`Layer ${layer.name} compute failed`, e);
        setHasError(true);
        // FORCE COMPLETE ON ERROR to unblock progress bar
        onProgress(layer.id, 1.0, `Layer ${layer.name}: Error`);
    });

    return () => { cancelled = true; };
  }, [layer, footprint, allFootprints, params, bottomZ, thickness, bounds, layerIndex, totalLayers]);

  return (
    <mesh 
        position={[centerX, centerY, centerZ]}
        ref={(ref) => registerMesh && registerMesh(layer.id, ref)}
        geometry={geometry || undefined}
        frustumCulled={false}
    >
      <meshStandardMaterial 
          color={hasError ? "#ff6666" : layer.color} 
          transparent={true} 
          opacity={hasError ? 1.0 : 0.9} 
          flatShading 
          side={THREE.FrontSide} 
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
      />
      {geometry && (
            <Edges 
                key={geometry.uuid}
                geometry={geometry}
                threshold={15} 
                color="#222" 
            />
        )}
      {hasError && geometry && (
        <mesh geometry={geometry} frustumCulled={false}>
          <meshBasicMaterial 
            color="#330000" 
            wireframe 
            wireframeLinewidth={1} 
          />
        </mesh>
      )}
    </mesh>
  );
};

// --- MESH RENDERER UTILS ---

interface FlatMesh {
    mesh: FootprintMesh;
    globalTransform: THREE.Matrix4;
    selectableId: string; // The ID to select when clicking (parent ref or self)
    isEditable: boolean; // Only true if direct child of current footprint
    uniqueId: string; // Unique ID for keying and progress tracking
}

function flattenMeshes(
    rootFp: Footprint, 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = new THREE.Matrix4(),
    ancestorRefId: string | null = null
): FlatMesh[] {
    let result: FlatMesh[] = [];

    if (rootFp.meshes) {
        rootFp.meshes.forEach((m, i) => {
            const x = evaluate(m.x, params);
            const y = evaluate(m.y, params);
            const z = evaluate(m.z, params);
            const rx = evaluate(m.rotationX, params) * Math.PI / 180;
            const ry = evaluate(m.rotationY, params) * Math.PI / 180;
            const rz = evaluate(m.rotationZ, params) * Math.PI / 180;

            const meshMat = new THREE.Matrix4();
            const rot = new THREE.Euler(rx, ry, rz, 'XYZ');
            meshMat.makeRotationFromEuler(rot);
            meshMat.setPosition(x, y, z); 
            
            const finalMat = transform.clone().multiply(meshMat);
            
            result.push({ 
                mesh: m, 
                globalTransform: finalMat,
                selectableId: ancestorRefId || m.id,
                isEditable: ancestorRefId === null,
                uniqueId: (ancestorRefId || rootFp.id) + "_mesh_" + m.id + "_" + i
            });
        });
    }

    rootFp.shapes.forEach(s => {
        if (s.type === "footprint") {
             const ref = s as FootprintReference;
             const child = allFootprints.find(f => f.id === ref.footprintId);
             if (child) {
                 const x = evaluate(ref.x, params);
                 const y = evaluate(ref.y, params);
                 const angle = evaluate(ref.angle, params);
                 
                 const childMat = new THREE.Matrix4();
                 childMat.makeRotationY(angle * Math.PI / 180);
                 childMat.setPosition(x, 0, -y);
                 
                 const globalChildMat = transform.clone().multiply(childMat);
                 
                 result = result.concat(flattenMeshes(
                     child, 
                     allFootprints, 
                     params, 
                     globalChildMat,
                     ancestorRefId || ref.id
                 ));
             }
        } else if (s.type === "union") {
             const u = s as FootprintUnion;
             const x = evaluate(u.x, params);
             const y = evaluate(u.y, params);
             const angle = evaluate(u.angle, params);

             const uMat = new THREE.Matrix4();
             uMat.makeRotationY(angle * Math.PI / 180);
             uMat.setPosition(x, 0, -y);

             const globalUMat = transform.clone().multiply(uMat);

             // Recurse using the union's internal shapes
             result = result.concat(flattenMeshes(
                 u as unknown as Footprint,
                 allFootprints,
                 params,
                 globalUMat,
                 ancestorRefId || u.id
             ));
        }
    });

    return result;
}

// Helper component to switch modes with keyboard
const TransformControlsModeSwitcher = ({ controlRef }: { controlRef: any }) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (controlRef.current) {
                if (e.key === 'r') controlRef.current.setMode('rotate');
                if (e.key === 't') controlRef.current.setMode('translate');
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [controlRef]);
    return null;
};

const MeshObject = ({ 
    meshData, 
    meshAssets,
    isSelected,
    onSelect,
    onUpdate,
    onProgress
}: { 
    meshData: FlatMesh, 
    meshAssets: MeshAsset[],
    isSelected: boolean,
    onSelect: () => void,
    onUpdate: (id: string, field: string, val: any) => void,
    onProgress: (id: string, percent: number, msg: string) => void
}) => {
    const { mesh, globalTransform, isEditable, uniqueId } = meshData;
    const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
    const meshRef = useRef<THREE.Mesh>(null);

    // Ghost object for TransformControls to follow
    const ghostRef = useRef<THREE.Object3D>(null);
    const controlRef = useRef<any>(null);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        let mounted = true;
        const asset = meshAssets.find(a => a.id === mesh.meshId);
        const meshName = mesh.name || "mesh";
        
        onProgress(uniqueId, 0.1, `Loading mesh ${meshName}...`);

        if (asset) {
            // Load via Worker
            callWorker("loadMesh", { 
                content: asset.content, 
                format: asset.format, 
                name: meshName 
            }, (p) => {
                if(mounted) onProgress(uniqueId, p.percent, p.message);
            })
            .then(data => {
                if (!mounted) return;
                const geom = new THREE.BufferGeometry();
                
                if (data.position) geom.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
                if (data.normal) geom.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
                if (data.index) geom.setIndex(new THREE.BufferAttribute(data.index, 1));
                
                if (!data.normal) geom.computeVertexNormals();
                
                setGeometry(geom);
                onProgress(uniqueId, 1.0, `Loaded ${meshName}`);
            })
            .catch(err => {
                console.error("Mesh load failed", err);
                onProgress(uniqueId, 1.0, "Mesh load error");
            });
        } else {
             onProgress(uniqueId, 1.0, "Mesh missing");
        }
        return () => { mounted = false; };
    }, [mesh.meshId, meshAssets, uniqueId, mesh.name]);

    // 1. Calculate transforms from the matrix immediately during render
    const position = useMemo(() => new THREE.Vector3().setFromMatrixPosition(globalTransform), [globalTransform]);
    const quaternion = useMemo(() => new THREE.Quaternion().setFromRotationMatrix(globalTransform), [globalTransform]);
    const scale = useMemo(() => new THREE.Vector3().setFromMatrixScale(globalTransform), [globalTransform]);

    const handleChange = () => {
        if (!ghostRef.current || !isEditable) return;
        
        const ghostPos = ghostRef.current.position;
        const ghostRot = ghostRef.current.rotation; 
        
        // Compare against the authoritative state
        const currentPos = new THREE.Vector3().setFromMatrixPosition(globalTransform);
        const currentRot = new THREE.Euler().setFromRotationMatrix(globalTransform);

        const dx = ghostPos.x - currentPos.x;
        const dy = ghostPos.y - currentPos.y;
        const dz = ghostPos.z - currentPos.z;
        
        const dRx = (ghostRot.x - currentRot.x) * (180/Math.PI);
        const dRy = (ghostRot.y - currentRot.y) * (180/Math.PI);
        const dRz = (ghostRot.z - currentRot.z) * (180/Math.PI);

        if (Math.abs(dx) > 1e-4) onUpdate(mesh.id, "x", modifyExpression(mesh.x, dx));
        if (Math.abs(dy) > 1e-4) onUpdate(mesh.id, "y", modifyExpression(mesh.y, dy));
        if (Math.abs(dz) > 1e-4) onUpdate(mesh.id, "z", modifyExpression(mesh.z, dz));
        
        if (Math.abs(dRx) > 1e-4) onUpdate(mesh.id, "rotationX", modifyExpression(mesh.rotationX, dRx));
        if (Math.abs(dRy) > 1e-4) onUpdate(mesh.id, "rotationY", modifyExpression(mesh.rotationY, dRy));
        if (Math.abs(dRz) > 1e-4) onUpdate(mesh.id, "rotationZ", modifyExpression(mesh.rotationZ, dRz));
    };

    if (!geometry || mesh.renderingType === "hidden") return null;

    const color = isSelected ? "#646cff" : (mesh.color || "#ccc");
    const emissive = isSelected ? "#3333aa" : "#000000";

    return (
        <>
            <mesh 
                ref={meshRef}
                geometry={geometry} 
                // Apply transforms to visible mesh
                position={position}
                quaternion={quaternion}
                scale={scale}
                frustumCulled={false}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect();
                }}
            >
                {mesh.renderingType === "wireframe" ? (
                    <meshBasicMaterial color={color} wireframe />
                ) : (
                    <>
                        <meshStandardMaterial 
                            color={color} 
                            emissive={emissive} 
                            emissiveIntensity={0.2}
                            polygonOffset
                            polygonOffsetFactor={1}
                            polygonOffsetUnits={1}
                        />
                        <Edges threshold={15} color="#222" />
                    </>
                )}
            </mesh>
            
            {isSelected && isEditable && (
                <>
                    <object3D 
                        ref={ghostRef} 
                        position={isDragging ? undefined : position}
                        quaternion={isDragging ? undefined : quaternion}
                        scale={isDragging ? undefined : scale}
                    />
                    
                    <TransformControls 
                        ref={controlRef}
                        object={ghostRef as any} 
                        mode="translate" 
                        space="local" 
                        onMouseDown={() => setIsDragging(true)}
                        onMouseUp={() => setIsDragging(false)}
                        onChange={handleChange}
                    />
                    <TransformControlsModeSwitcher controlRef={controlRef} />
                </>
            )}
        </>
    );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, meshAssets, visibleLayers, is3DActive, selectedId, onSelect, onUpdateMesh }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});
  const hasInitiallySnapped = useRef(false);
  const [firstMeshReady, setFirstMeshReady] = useState(false);
  
  // Flatten meshes once per render cycle
  const flattenedMeshes = useMemo(() => flattenMeshes(footprint, allFootprints, params), [footprint, allFootprints, params]);
  
  // Progress State
  const progressStatus = useRef(new Map<string, number>());
  const [progress, setProgress] = useState({ active: false, text: "", percent: 0 });
  const progressTimeout = useRef<number | null>(null);

  // Unified Progress Handler
  const handleProgress = useCallback((id: string, percent: number, message: string) => {
      progressStatus.current.set(id, percent);
      
      const visibleMeshCount = flattenedMeshes.filter(m => m.mesh.renderingType !== 'hidden').length;
      const totalTasks = stackup.length + visibleMeshCount;
      
      let sum = 0;
      progressStatus.current.forEach(v => sum += v);
      
      // Calculate overall percent
      const overall = sum / Math.max(1, totalTasks);
      
      setProgress(() => {
          return { active: true, text: message, percent: overall };
      });

      // Cleanup Logic
      if (progressTimeout.current) clearTimeout(progressTimeout.current);
      
      if (overall >= 0.999) {
          progressTimeout.current = window.setTimeout(() => {
              setProgress(p => ({ ...p, active: false }));
          }, 800);
      }
  }, [stackup.length, flattenedMeshes]); // Dependency on task count

  // Reset progress map when structure changes significantly
  useEffect(() => {
      progressStatus.current.clear();
      setProgress({ active: false, text: "", percent: 0 });
  }, [stackup.length, flattenedMeshes.length]);

  const fitToHome = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const camera = controls.object as THREE.PerspectiveCamera;
    const box = new THREE.Box3();
    let hasMeshes = false;

    Object.values(meshRefs.current).forEach((mesh) => {
        if (mesh && mesh.geometry) {
            mesh.updateMatrixWorld();
            const meshBox = new THREE.Box3().setFromObject(mesh);
            if (!meshBox.isEmpty()) {
                box.union(meshBox);
                hasMeshes = true;
            }
        }
    });

    if (!hasMeshes) {
        camera.position.set(50, 50, 50);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const aspect = camera.aspect || 1;
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const effectiveFOV = Math.min(fov, fovH);
    
    let distance = maxDim / (2 * Math.tan(effectiveFOV / 2));
    distance *= 1.3;

    const direction = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    
    controls.target.copy(center);
    controls.update();
  }, []);

  useEffect(() => {
    if (firstMeshReady && !hasInitiallySnapped.current && is3DActive) {
        fitToHome();
        hasInitiallySnapped.current = true;
    }
  }, [firstMeshReady, is3DActive, fitToHome]);

  useImperativeHandle(ref, () => ({
    resetCamera: fitToHome,
    getLayerSTL: (layerId: string) => {
        const mesh = meshRefs.current[layerId];
        if (!mesh || !mesh.geometry) return null;

        let geom = mesh.geometry.clone();
        mesh.updateMatrixWorld();
        geom.applyMatrix4(mesh.matrixWorld);

        geom.deleteAttribute('uv');
        geom.deleteAttribute('normal');

        try {
            geom = mergeVertices(geom, 1e-4);
        } catch (e) {
            console.warn("Vertex merge failed", e);
        }

        geom.computeVertexNormals();
        const data = geometryToSTL(geom);
        geom.dispose();
        
        return data;
    },
    processDroppedFile: async (file: File): Promise<FootprintMesh | null> => {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ext) return null;
        
        // Report Drop progress
        handleProgress("drop_file", 0.1, "Reading file...");

        const buffer = await file.arrayBuffer();
        const format = (ext === "stp" || ext === "step") ? "step" : (ext === "obj" ? "obj" : (ext === "glb" || ext === "gltf" ? "glb" : "stl"));
        
        try {
            const result = await callWorker("convert", {
                buffer,
                format,
                fileName: file.name
            }, (p) => {
                 handleProgress("drop_file", p.percent, p.message);
            });
            
            handleProgress("drop_file", 1.0, "File processed");

            return {
                id: crypto.randomUUID(),
                name: file.name,
                content: result.base64,
                format: result.format,
                renderingType: "solid",
                x: "0", y: "0", z: "0",
                rotationX: "0", rotationY: "0", rotationZ: "0"
            } as any;
        } catch (e) {
            console.error("Worker Conversion Failed", e);
            handleProgress("drop_file", 1.0, "File processing failed");
            alert(`File processing failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    },
    convertMeshToGlb: async (mesh: FootprintMesh): Promise<FootprintMesh | null> => {
        const mock = mesh as any;
        try {
            // Convert base64 string to buffer for worker
            const binString = window.atob(mock.content);
            const len = binString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) bytes[i] = binString.charCodeAt(i);
            
            const result = await callWorker("convert", {
                buffer: bytes.buffer,
                format: mock.format,
                fileName: mock.name
            });
            
            return {
                ...mesh,
                content: result.base64,
                format: result.format
            } as any;
        } catch (e) {
             console.error("Worker Healing Failed", e);
             return null;
        }
    }
  }));

  const bounds = useMemo(() => {
    const PADDING = 10;
    const outlines = footprint.shapes.filter(s => s.type === "boardOutline") as FootprintBoardOutline[];

    if (footprint.isBoard && outlines.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        outlines.forEach(outline => {
            const originX = evaluateExpression(outline.x, params);
            const originY = evaluateExpression(outline.y, params);
            outline.points.forEach(pRaw => {
                const p = resolvePoint(pRaw, footprint, allFootprints, params);
                const x = originX + p.x;
                const y = originY + p.y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            });
        });
        return { minX: minX - PADDING, maxX: maxX + PADDING, minY: minY - PADDING, maxY: maxY + PADDING };
    }

    if (!footprint.shapes || footprint.shapes.length === 0) {
        return { minX: -PADDING, maxX: PADDING, minY: -PADDING, maxY: PADDING };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    footprint.shapes.forEach(shape => {
        if (shape.type === "wireGuide") return;
        const x = evaluateExpression(shape.x, params);
        const y = evaluateExpression(shape.y, params);
        const MARGIN = 50; 
        if (x - MARGIN < minX) minX = x - MARGIN;
        if (x + MARGIN > maxX) maxX = x + MARGIN;
        if (y - MARGIN < minY) minY = y - MARGIN;
        if (y + MARGIN > maxY) maxY = y + MARGIN;
    });

    return { minX, maxX, minY, maxY };

  }, [footprint, params, allFootprints]);

  const activeMeshIsEditable = useMemo(() => {
      if (!selectedId) return false;
      const flat = flattenedMeshes.find(m => m.selectableId === selectedId);
      return flat ? flat.isEditable : false;
  }, [selectedId, flattenedMeshes]);

  return (
    <div style={{ width: "100%", height: "100%", background: "#111", position: 'relative' }}>
      <ProgressBar progress={progress} />
      <Canvas 
        camera={{ position: [50, 50, 50], fov: 45, near: 0.1, far: 100000 }}
        frameloop={is3DActive ? "always" : "never"}
        onPointerMissed={() => onSelect && onSelect("")}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {(() => {
            let currentZ = 0; 
            return [...stackup].reverse().map((layer, idx) => {
              const thickness = evaluateExpression(layer.thicknessExpression, params);
              
              const isVisible = visibleLayers ? visibleLayers[layer.id] !== false : true;
              
              const node = isVisible ? (
                <LayerSolid 
                  key={layer.id}
                  layer={layer}
                  footprint={footprint}
                  allFootprints={allFootprints}
                  params={params}
                  bottomZ={currentZ}
                  thickness={thickness}
                  bounds={bounds}
                  layerIndex={idx}
                  totalLayers={stackup.length}
                  onProgress={handleProgress}
                  registerMesh={(id, mesh) => { 
                      if (mesh) {
                        meshRefs.current[id] = mesh; 
                        if (mesh.geometry) setFirstMeshReady(true);
                      } else {
                        delete meshRefs.current[id]; 
                      }
                  }}
                />
              ) : null;

              currentZ += thickness;
              return node;
            });
          })()}
        </group>
        
        <group>
            {flattenedMeshes.map((m) => (
                <MeshObject 
                    key={m.uniqueId} 
                    meshData={m} 
                    meshAssets={meshAssets}
                    isSelected={selectedId === m.selectableId}
                    onSelect={() => onSelect(m.selectableId)}
                    onUpdate={onUpdateMesh}
                    onProgress={handleProgress}
                />
            ))}
        </group>

        <Grid 
            infiniteGrid 
            fadeDistance={200} 
            sectionColor="#444" 
            cellColor="#222" 
            position={[0, 0, 0]} 
        />
        <OrbitControls makeDefault ref={controlsRef} />
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={['#9d4b4b', '#2f7f4f', '#3b5b9d']} labelColor="white" />
        </GizmoHelper>
      </Canvas>
      {activeMeshIsEditable && (
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.5)', pointerEvents: 'none', fontSize: '12px' }}>
           Select Mesh: 'T' for Translate, 'R' for Rotate
        </div>
      )}
    </div>
  );
});

function geometryToSTL(geometry: THREE.BufferGeometry): Uint8Array {
    const geom = geometry.toNonIndexed();
    const pos = geom.getAttribute('position');
    const count = pos.count;
    const triangleCount = Math.floor(count / 3);

    const bufferLen = 80 + 4 + (50 * triangleCount);
    const buffer = new ArrayBuffer(bufferLen);
    const view = new DataView(buffer);

    view.setUint32(80, triangleCount, true);

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
        const i3 = i * 3;

        const ax = pos.getX(i3);
        const ay = pos.getY(i3);
        const az = pos.getZ(i3);

        const bx = pos.getX(i3 + 1);
        const by = pos.getY(i3 + 1);
        const bz = pos.getZ(i3 + 1);

        const cx = pos.getX(i3 + 2);
        const cy = pos.getY(i3 + 2);
        const cz = pos.getZ(i3 + 2);

        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;

        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
            nx /= len; ny /= len; nz /= len;
        }

        view.setFloat32(offset, nx, true);
        view.setFloat32(offset + 4, ny, true);
        view.setFloat32(offset + 8, nz, true);
        offset += 12;

        view.setFloat32(offset, ax, true);
        view.setFloat32(offset + 4, ay, true);
        view.setFloat32(offset + 8, az, true);
        offset += 12;

        view.setFloat32(offset, bx, true);
        view.setFloat32(offset + 4, by, true);
        view.setFloat32(offset + 8, bz, true);
        offset += 12;

        view.setFloat32(offset, cx, true);
        view.setFloat32(offset + 4, cy, true);
        view.setFloat32(offset + 8, cz, true);
        offset += 12;

        view.setUint16(offset, 0, true);
        offset += 2;
    }

    if (geom !== geometry) {
        geom.dispose();
    }

    return new Uint8Array(buffer);
}

export default Footprint3DView;