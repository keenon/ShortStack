// src/components/Layout3DView.tsx
import React, { useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import { Footprint, Parameter, StackupLayer, FootprintInstance, BoardOutline, FootprintRect } from "../types";
import { evaluateExpression } from "./FootprintEditor";

interface Props {
  layout: FootprintInstance[];
  boardOutline: BoardOutline;
  footprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>; // NEW PROP
}

export interface Layout3DViewHandle {
    resetCamera: () => void;
}

const LayerVolume = ({
    layer,
    layout,
    footprints,
    params,
    boardShape,
    bottomZ, // World Y
    thickness
}: {
    layer: StackupLayer;
    layout: FootprintInstance[];
    footprints: Footprint[];
    params: Parameter[];
    boardShape: THREE.Shape;
    bottomZ: number;
    thickness: number;
}) => {
    // We construct the geometry in a Local Space where:
    // Local X = World X
    // Local Y = World Z (Depth)
    // Local Z = World -Y (Downwards, Thickness) due to rotation -90 X
    
    return (
        <mesh 
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
                    // The last CSG operation (Addition/Subtraction) wins.
                    // Index 0 is "Top", so it should be processed last (or first in this reversed list?)
                    // In Footprint3DView, we reversed the list.
                    // If A overwrites B, A must happen AFTER B.
                    // If Index 0 is Top (A) and Index 1 is Bottom (B).
                    // We want [B, A] execution order.
                    // fp.shapes is [A, B].
                    // fp.shapes.reverse() is [B, A].
                    // So we iterate the reversed array.
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
                         // Center of the board in Local Z (which is 0..thickness)
                         // Actually extrusion starts at 0 and goes to `depth` (thickness).
                         // So 0 is bottom (in local coords) or top?
                         // extrudeGeometry with depth > 0 extrudes along +Z.
                         // So Z=0 is one face, Z=thickness is the other.
                         // We position the board at `bottomZ`.
                         // Local Z=0 corresponds to World Y = bottomZ.
                         // Local Z=thickness corresponds to World Y = bottomZ + thickness (Top).
                         
                         const throughZ = thickness / 2; // Center of cut box

                         // B. Fill (Add material back if depth < thickness)
                         // We want the resulting surface to be at `actualDepth` from the reference side.
                         const fillHeight = thickness - actualDepth;
                         const shouldFill = fillHeight > 0.001;
                         let fillZ = 0;

                         if (shouldFill) {
                             if (layer.carveSide === "Top") {
                                 // Carving from Top (Local Z = thickness).
                                 // Material remains at Bottom (Local Z = 0).
                                 // Fill center = fillHeight / 2.
                                 fillZ = fillHeight / 2;
                             } else {
                                 // Carving from Bottom (Local Z = 0).
                                 // Material remains at Top (Local Z = thickness).
                                 // Fill center = thickness - (fillHeight / 2).
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
};

const Layout3DView = forwardRef<Layout3DViewHandle, Props>(({ layout, boardOutline, footprints, params, stackup, visibleLayers }, ref) => {
  const controlsRef = useRef<any>(null);

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
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

export default Layout3DView;