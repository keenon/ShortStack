// src/components/Layout3DView.tsx
import React, { useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import { Footprint, Parameter, StackupLayer, FootprintInstance, BoardOutline, FootprintRect } from "../types";
import { evaluateExpression } from "../utils/footprintUtils";

interface Props {
  layout: FootprintInstance[];
  boardOutline: BoardOutline;
  footprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>;
}

export interface Layout3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
}

interface LayerVolumeProps {
    layer: StackupLayer;
    layout: FootprintInstance[];
    footprints: Footprint[];
    params: Parameter[];
    boardShape: THREE.Shape;
    bottomZ: number;
    thickness: number;
}

const LayerVolume = forwardRef<THREE.Mesh, LayerVolumeProps>(({
    layer,
    layout,
    footprints,
    params,
    boardShape,
    bottomZ, // World Y
    thickness
}, ref) => {
    // We construct the geometry in a Local Space where:
    // Local X = World X
    // Local Y = World Z (Depth)
    // Local Z = World -Y (Downwards, Thickness) due to rotation -90 X
    
    return (
        <mesh 
            ref={ref}
            rotation={[-Math.PI / 2, 0, 0]} 
            position={[0, bottomZ, 0]} 
        >
             <Geometry>
                <Base>
                    <extrudeGeometry args={[boardShape, { depth: thickness, bevelEnabled: false }]} />
                </Base>
                
                {layout.map((inst) => {
                    const fp = footprints.find(f => f.id === inst.footprintId);
                    if (!fp) return null;
                    
                    // Pre-calc Instance Transform
                    const instX = evaluateExpression(inst.x, params);
                    const instY = evaluateExpression(inst.y, params);
                    const instAngle = evaluateExpression(inst.angle, params);
                    const instAngleRad = (instAngle * Math.PI) / 180;
                    
                    const cosA = Math.cos(instAngleRad);
                    const sinA = Math.sin(instAngleRad);

                    // Reverse shapes to match "Top overwrites Bottom" logic
                    const orderedShapes = [...fp.shapes].reverse();

                    return orderedShapes.map(shape => {
                         // Check layer assignment
                         if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return null;

                         // Calculate Target Depth
                         let actualDepth = thickness;

                         if (layer.type === "Cut") {
                             // Through Cut
                             actualDepth = thickness; 
                         } else {
                             // Carved
                             const val = evaluateExpression(shape.assignedLayers[layer.id], params);
                             actualDepth = Math.max(0, Math.min(val, thickness));
                         }

                         // 2. Calculate Cut & Fill Geometries
                         
                         // A. Through Cut (Removes all material in the shape's footprint)
                         const throughHeight = thickness + 0.2; 
                         
                         const throughZ = thickness / 2; // Center of cut box

                         // B. Fill (Add material back if depth < thickness)
                         // We want the resulting surface to be at `actualDepth` from the reference side.
                         const fillHeight = thickness - actualDepth;
                         const shouldFill = fillHeight > 0.001;
                         let fillZ = 0;

                         if (shouldFill) {
                             if (layer.carveSide === "Top") {
                                 // Carving from Top (Local Z = thickness).
                                 fillZ = fillHeight / 2;
                             } else {
                                 // Carving from Bottom (Local Z = 0).
                                 fillZ = thickness - (fillHeight / 2);
                             }
                         }

                         // Calculate 2D Position
                         const sx = evaluateExpression(shape.x, params);
                         const sy = evaluateExpression(shape.y, params);
                         
                         const rotX = sx * cosA - sy * sinA;
                         const rotY = sx * sinA + sy * cosA;
                         
                         const finalX = instX + rotX;
                         // UN-MIRRORING: Use positive Y (Y-Up in 2D matches logic now)
                         const finalY = (instY + rotY); 
                         
                         const CSG_EPSILON = 0.01;

                         if (shape.type === "circle") {
                             const diameter = evaluateExpression(shape.diameter, params);
                             return (
                                 <React.Fragment key={`${inst.id}-${shape.id}`}>
                                    <Subtraction 
                                        position={[finalX, finalY, throughZ]}
                                        rotation={[Math.PI/2, 0, 0]}
                                    >
                                        <cylinderGeometry args={[diameter/2, diameter/2, throughHeight, 32]} />
                                    </Subtraction>
                                    {shouldFill && (
                                        <Addition
                                            position={[finalX, finalY, fillZ]}
                                            rotation={[Math.PI/2, 0, 0]}
                                        >
                                            <cylinderGeometry args={[diameter/2 + CSG_EPSILON, diameter/2 + CSG_EPSILON, fillHeight, 32]} />
                                        </Addition>
                                    )}
                                 </React.Fragment>
                             );
                         } else {
                             const w = evaluateExpression((shape as FootprintRect).width, params);
                             const h = evaluateExpression((shape as FootprintRect).height, params);
                             const sAngle = evaluateExpression((shape as FootprintRect).angle, params);
                             const totalAngleRad = instAngleRad + (sAngle * Math.PI) / 180;
                             
                             return (
                                 <React.Fragment key={`${inst.id}-${shape.id}`}>
                                     <Subtraction
                                        position={[finalX, finalY, throughZ]}
                                        // UN-MIRRORING: Use positive angle
                                        rotation={[0, 0, totalAngleRad]}
                                     >
                                         <boxGeometry args={[w, h, throughHeight]} />
                                     </Subtraction>
                                     {shouldFill && (
                                         <Addition
                                            position={[finalX, finalY, fillZ]}
                                            rotation={[0, 0, totalAngleRad]}
                                         >
                                             <boxGeometry args={[w + CSG_EPSILON, h + CSG_EPSILON, fillHeight]} />
                                         </Addition>
                                     )}
                                 </React.Fragment>
                             );
                         }
                    });
                })}
             </Geometry>
             <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
        </mesh>
    );
});

const Layout3DView = forwardRef<Layout3DViewHandle, Props>(({ layout, boardOutline, footprints, params, stackup, visibleLayers }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
    },
    getLayerSTL: (layerId: string) => {
        const mesh = meshRefs.current[layerId];
        if (!mesh) return null;
        return geometryToSTL(mesh.geometry);
    }
  }));

  const boardShape = useMemo(() => {
      const s = new THREE.Shape();
      if (boardOutline.points.length > 0) {
          const first = boardOutline.points[0];
          // UN-MIRRORING: Use positive Y
          s.moveTo(evaluateExpression(first.x, params), evaluateExpression(first.y, params));
          
          for (let i = 1; i < boardOutline.points.length; i++) {
              const p = boardOutline.points[i];
              // UN-MIRRORING: Use positive Y
              s.lineTo(evaluateExpression(p.x, params), evaluateExpression(p.y, params));
          }
          s.closePath();
      }
      return s;
  }, [boardOutline, params]);

  return (
    <div style={{ width: "100%", height: "100%", background: "#111" }}>
      <Canvas camera={{ position: [50, 50, 50], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {(() => {
            let currentZ = 0; // World Y
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluateExpression(layer.thicknessExpression, params);
              
              // NEW: CHECK VISIBILITY
              const isVisible = visibleLayers ? visibleLayers[layer.id] !== false : true;

              const node = isVisible ? (
                <LayerVolume 
                  key={layer.id}
                  ref={(el) => {
                      if (el) meshRefs.current[layer.id] = el;
                      else delete meshRefs.current[layer.id];
                  }}
                  layer={layer}
                  layout={layout}
                  footprints={footprints}
                  params={params}
                  boardShape={boardShape}
                  bottomZ={currentZ}
                  thickness={thickness}
                />
              ) : null;

              currentZ += thickness;
              return node;
            });
          })()}
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
    </div>
  );
});

// Helper to generate Binary STL from Three.js BufferGeometry
// Note: This exports the geometry in its LOCAL coordinates. 
// For LayerVolume, Local coordinates are:
// X = Design X
// Y = Design Y
// Z = Thickness (Extrusion Direction)
// This perfectly maps to STL standard (Z is up/thickness).
function geometryToSTL(geometry: THREE.BufferGeometry): Uint8Array {
    // Ensure non-indexed geometry for simplicity
    const geom = geometry.toNonIndexed();
    const pos = geom.getAttribute('position');
    const count = pos.count; // Number of vertices
    const triangleCount = Math.floor(count / 3);

    // Binary STL Header: 80 bytes (Header) + 4 bytes (Count) + 50 bytes per triangle
    const bufferLen = 80 + 4 + (50 * triangleCount);
    const buffer = new ArrayBuffer(bufferLen);
    const view = new DataView(buffer);

    // Header (80 bytes) - leaving zeroed or add text
    // ...

    // Triangle Count (4 bytes, little endian)
    view.setUint32(80, triangleCount, true);

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
        const i3 = i * 3;

        // Vertices
        const ax = pos.getX(i3);
        const ay = pos.getY(i3);
        const az = pos.getZ(i3);

        const bx = pos.getX(i3 + 1);
        const by = pos.getY(i3 + 1);
        const bz = pos.getZ(i3 + 1);

        const cx = pos.getX(i3 + 2);
        const cy = pos.getY(i3 + 2);
        const cz = pos.getZ(i3 + 2);

        // Calculate Normal (Cross product)
        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;

        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;

        // Normalize
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
            nx /= len; ny /= len; nz /= len;
        }

        // Write Normal (12 bytes)
        view.setFloat32(offset, nx, true);
        view.setFloat32(offset + 4, ny, true);
        view.setFloat32(offset + 8, nz, true);
        offset += 12;

        // Write Vertex 1 (12 bytes)
        view.setFloat32(offset, ax, true);
        view.setFloat32(offset + 4, ay, true);
        view.setFloat32(offset + 8, az, true);
        offset += 12;

        // Write Vertex 2 (12 bytes)
        view.setFloat32(offset, bx, true);
        view.setFloat32(offset + 4, by, true);
        view.setFloat32(offset + 8, bz, true);
        offset += 12;

        // Write Vertex 3 (12 bytes)
        view.setFloat32(offset, cx, true);
        view.setFloat32(offset + 4, cy, true);
        view.setFloat32(offset + 8, cz, true);
        offset += 12;

        // Attribute Byte Count (2 bytes)
        view.setUint16(offset, 0, true);
        offset += 2;
    }

    // Clean up temporary geometry if created
    if (geom !== geometry) {
        geom.dispose();
    }

    return new Uint8Array(buffer);
}

export default Layout3DView;