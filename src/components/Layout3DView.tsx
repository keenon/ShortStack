// src/components/Layout3DView.tsx
import React, { useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Geometry, Base, Subtraction } from "@react-three/csg";
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

                    return fp.shapes.map(shape => {
                         // Check layer assignment
                         if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return null;

                         // Calculate Cut Depth / Position (Local Z)
                         let cutDepth = 0;
                         let cutZ = 0;

                         if (layer.type === "Cut") {
                             cutDepth = thickness + 1.0; 
                             cutZ = thickness / 2;
                         } else {
                             const rawDepth = evaluateExpression(shape.assignedLayers[layer.id], params);
                             const val = Math.max(0, Math.min(rawDepth, thickness));
                             if (val <= 0) return null;
                             
                             cutDepth = val + 0.1;
                             
                             if (layer.carveSide === "Top") {
                                 cutZ = thickness - (val / 2) + 0.05;
                             } else {
                                 cutZ = (val / 2) - 0.05;
                             }
                         }

                         // Calculate 2D Position
                         const sx = evaluateExpression(shape.x, params);
                         const sy = evaluateExpression(shape.y, params);
                         
                         const rotX = sx * cosA - sy * sinA;
                         const rotY = sx * sinA + sy * cosA;
                         
                         const finalX = instX + rotX;
                         // Fix: Negate Y so that after -90X rotation, +Y in 2D maps to +Z in 3D
                         const finalY = -(instY + rotY); 
                         
                         if (shape.type === "circle") {
                             const diameter = evaluateExpression(shape.diameter, params);
                             return (
                                 <Subtraction 
                                    key={`${inst.id}-${shape.id}`}
                                    position={[finalX, finalY, cutZ]}
                                    rotation={[Math.PI/2, 0, 0]}
                                 >
                                     <cylinderGeometry args={[diameter/2, diameter/2, cutDepth, 32]} />
                                 </Subtraction>
                             );
                         } else {
                             const w = evaluateExpression((shape as FootprintRect).width, params);
                             const h = evaluateExpression((shape as FootprintRect).height, params);
                             const sAngle = evaluateExpression((shape as FootprintRect).angle, params);
                             const totalAngleRad = instAngleRad + (sAngle * Math.PI) / 180;
                             
                             return (
                                 <Subtraction
                                    key={`${inst.id}-${shape.id}`}
                                    position={[finalX, finalY, cutZ]}
                                    // Fix: Negate rotation angle to account for Y-axis flip
                                    rotation={[0, 0, -totalAngleRad]}
                                 >
                                     <boxGeometry args={[w, h, cutDepth]} />
                                 </Subtraction>
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
          // Fix: Negate Y to align with 3D View coordinates
          s.moveTo(evaluateExpression(first.x, params), -evaluateExpression(first.y, params));
          
          for (let i = 1; i < boardOutline.points.length; i++) {
              const p = boardOutline.points[i];
              // Fix: Negate Y
              s.lineTo(evaluateExpression(p.x, params), -evaluateExpression(p.y, params));
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