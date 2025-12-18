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
    // Local Z = World -Y (Downwards, Thickness) -> Wait, rotation -90 X makes Local Z point to World Y
    //
    // Rotation -90 deg around X:
    // Local (0,0,1) -> World (0,1,0)
    //
    // ExtrudeGeometry extrudes along positive Z (Local).
    // So it creates a volume from Local Z=0 to Local Z=thickness.
    // In World space, this maps to Y=0 to Y=thickness (relative to mesh position).

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
                    
                    // Optimization: calc cos/sin once per instance
                    const cosA = Math.cos(instAngleRad);
                    const sinA = Math.sin(instAngleRad);

                    return fp.shapes.map(shape => {
                         // Check layer assignment
                         if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return null;

                         // Calculate Cut Depth / Position (Local Z)
                         // Local Z=0 is Bottom Surface (World Y=bottomZ). 
                         // Local Z=thickness is Top Surface (World Y=bottomZ+thickness).
                         let cutDepth = 0;
                         let cutZ = 0; // Center of cut in Local Z

                         if (layer.type === "Cut") {
                             cutDepth = thickness + 1.0; // Overshoot for clean cut
                             cutZ = thickness / 2;
                         } else {
                             const rawDepth = evaluateExpression(shape.assignedLayers[layer.id], params);
                             const val = Math.max(0, Math.min(rawDepth, thickness));
                             if (val <= 0) return null;
                             
                             cutDepth = val + 0.1; // small overshoot
                             
                             if (layer.carveSide === "Top") {
                                 // From Z=thickness (Top) downwards
                                 // Center of cut = Top - (val / 2)
                                 // Add small offset to ensure it breaks the surface
                                 cutZ = thickness - (val / 2) + 0.05;
                             } else {
                                 // From Z=0 (Bottom) upwards
                                 // Center of cut = Bottom + (val / 2)
                                 cutZ = (val / 2) - 0.05;
                             }
                         }

                         // Calculate 2D Position
                         const sx = evaluateExpression(shape.x, params);
                         const sy = evaluateExpression(shape.y, params);
                         
                         // Rotate Shape Vector by Instance Angle
                         // Standard 2D rotation: x' = x cos - y sin, y' = x sin + y cos
                         // This produces CW rotation if Y axis is down (Screen/SVG coords), or CCW if Y is up.
                         // Consistent with FootprintEditor 2D view.
                         const rotX = sx * cosA - sy * sinA;
                         const rotY = sx * sinA + sy * cosA;
                         
                         const finalX = instX + rotX;
                         const finalY = instY + rotY; // This maps to Local Y (World Z)
                         
                         // Orientation & Geometry
                         if (shape.type === "circle") {
                             const diameter = evaluateExpression(shape.diameter, params);
                             return (
                                 <Subtraction 
                                    key={`${inst.id}-${shape.id}`}
                                    position={[finalX, finalY, cutZ]}
                                    // Rotate Cylinder to align with Local Z (Axis of thickness)
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
                             
                             // Box args: Width(X), Height(Y), Depth(Z)
                             // We map 2D Rect (w, h) to Local (X, Y). Cut Depth to Local Z.
                             return (
                                 <Subtraction
                                    key={`${inst.id}-${shape.id}`}
                                    position={[finalX, finalY, cutZ]}
                                    // Rotate around Local Z axis (Thickness axis)
                                    // Positive angle is CW in Top-Down view (Local X to Local Y)
                                    rotation={[0, 0, totalAngleRad]}
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

const Layout3DView = forwardRef<Layout3DViewHandle, Props>(({ layout, boardOutline, footprints, params, stackup }, ref) => {
  const controlsRef = useRef<any>(null);

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
    }
  }));

  // Create THREE.Shape from board outline
  const boardShape = useMemo(() => {
      const s = new THREE.Shape();
      if (boardOutline.points.length > 0) {
          const first = boardOutline.points[0];
          s.moveTo(evaluateExpression(first.x, params), evaluateExpression(first.y, params));
          
          for (let i = 1; i < boardOutline.points.length; i++) {
              const p = boardOutline.points[i];
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
            let currentZ = 0; // World Y (Height)
            // FIXED: Reverse stackup to match Footprint3DView and logical Bottom-to-Top visual stacking
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluateExpression(layer.thicknessExpression, params);
              
              const node = (
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
              );

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