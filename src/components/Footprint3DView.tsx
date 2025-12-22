// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
// Note: Requires @react-three/csg and three-bvh-csg installed
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect } from "../types";

interface Props {
  footprint: Footprint;
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>;
}

export interface Footprint3DViewHandle {
    resetCamera: () => void;
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function evaluate(expression: string, params: Parameter[]): number {
  if (!expression || !expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      // Treat parameters as pure numbers in mm to allow mixed arithmetic (e.g. "Width + 5")
      const val = p.unit === "in" ? p.value * 25.4 : p.value;
      scope[p.key] = val;
    });
    const result = math.evaluate(expression, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0;
  }
}

// ------------------------------------------------------------------
// COMPONENTS
// ------------------------------------------------------------------

/**
 * Renders a single layer as a solid block with cuts subtracted (CSG).
 */
const LayerSolid = ({
  layer,
  footprint,
  params,
  bottomZ,
  thickness,
  bounds
}: {
  layer: StackupLayer;
  footprint: Footprint;
  params: Parameter[];
  bottomZ: number;
  thickness: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}) => {
  // Dimensions of the base plate
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY; // 2D Y becomes 3D Depth (Z)
  
  // Center in 3D Space
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minY + bounds.maxY) / 2;
  const centerY = bottomZ + thickness / 2;

  // Identify shapes affecting this layer.
  // We need to process shapes from Bottom of stack to Top of stack.
  // The 'footprint.shapes' array has the Top shape at index 0 (if rendered last in 2D by reverse map) 
  // or logic dictates index 0 is Top. Based on Editor logic, rendering is usually ordered.
  // We assume footprint.shapes is ordered such that the last drawn shape (Top) is effectively highest priority.
  // The editor renders `[...shapes].reverse()`, drawing index N-1 first (Bottom) and index 0 last (Top).
  // So index 0 is Top.
  // To apply "Top shape dictates depth", we use a "Cut and Replace" strategy:
  // 1. Start with Base.
  // 2. Iterate Bottom -> Top.
  // 3. For each shape: Cut a FULL HOLE, then Add back material to the desired depth.
  // This ensures the last shape processed (Top) overwrites the column of material.
  //
  // Order: Reverse of `shapes` array gives [Bottom ... Top].
  const orderedShapes = useMemo(() => {
    return [...footprint.shapes].reverse().filter(s => 
      s.assignedLayers && s.assignedLayers[layer.id] !== undefined
    );
  }, [footprint.shapes, layer.id]);

  // Optimization: If no cuts, just return a simple mesh
  if (orderedShapes.length === 0) {
    return (
      <mesh position={[centerX, centerY, centerZ]}>
        <boxGeometry args={[width, thickness, depth]} />
        <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
      </mesh>
    );
  }

  return (
    <mesh position={[centerX, centerY, centerZ]}>
      {/* 
        CSG Geometry Wrapper 
        The <Geometry> component creates a computed mesh from children 
      */}
      <Geometry>
        {/* Base Positive Shape: Local position (0,0,0) corresponds to mesh position */}
        <Base>
          <boxGeometry args={[width, thickness, depth]} />
        </Base>

        {/* Operations */}
        {orderedShapes.map((shape) => {
          // 1. Calculate Target Depth
          let actualDepth = thickness;

          if (layer.type === "Cut") {
             // Through Cut
             actualDepth = thickness; 
          } else {
             // Carved
             const val = evaluate(shape.assignedLayers[layer.id], params);
             actualDepth = Math.max(0, Math.min(val, thickness));
          }

          // 2. Calculate Cut & Fill Geometries
          
          // A. Through Cut (Removes all material in the shape's footprint)
          const throughHeight = thickness + 0.2; 
          const throughY = 0; // Centered

          // B. Fill (Add material back if depth < thickness)
          // We want the resulting surface to be at `actualDepth` from the reference side.
          const fillHeight = thickness - actualDepth;
          let fillY = 0;
          const shouldFill = fillHeight > 0.001;

          if (shouldFill) {
              if (layer.carveSide === "Top") {
                  // Carving from Top: Material remains at the Bottom.
                  // Range: [-T/2, T/2 - depth]
                  // Center: (T/2 - depth - T/2) / 2 = -depth / 2
                  fillY = -actualDepth / 2;
              } else {
                  // Carving from Bottom: Material remains at the Top.
                  // Range: [-T/2 + depth, T/2]
                  // Center: (-T/2 + depth + T/2) / 2 = depth / 2
                  fillY = actualDepth / 2;
              }
          }

          // 3. Calculate 2D Position
          const sx = evaluate(shape.x, params);
          const sy = evaluate(shape.y, params);

          // 4. Local Position Calculation
          // UN-MIRRORING Y -> -Z
          const localX = sx - centerX;
          const localZ = centerZ - sy; 

          // 5. Geometry Args
          let args: any[] = [];
          let rotation: [number, number, number] = [0, 0, 0];
          let type: "cylinder" | "box" | null = null;

          if (shape.type === "circle") {
            const diameter = evaluate(shape.diameter, params);
            // Cylinder: [radiusTop, radiusBottom, height, segments]
            args = [diameter/2, diameter/2, 0, 32];
            type = "cylinder";
          } else if (shape.type === "rect") {
            const w = evaluate(shape.width, params);
            const h = evaluate(shape.height, params);
            const angleDeg = evaluate((shape as FootprintRect).angle, params);
            const angleRad = (angleDeg * Math.PI) / 180;
            // Box: [width, height, depth]
            args = [w, 0, h]; 
            rotation = [0, angleRad, 0];
            type = "box";
          }

          if (!type) return null;

          return (
             <React.Fragment key={shape.id}>
                {/* Step A: Always subtract FULL THICKNESS to clear the column */}
                <Subtraction position={[localX, throughY, localZ]} rotation={rotation}>
                    {type === "cylinder" ? (
                        <cylinderGeometry args={[args[0], args[1], throughHeight, args[3]]} />
                    ) : (
                        <boxGeometry args={[args[0], throughHeight, args[2]]} />
                    )}
                </Subtraction>

                {/* Step B: Add back material if needed */}
                {shouldFill && (
                    <Addition position={[localX, fillY, localZ]} rotation={rotation}>
                        {type === "cylinder" ? (
                            <cylinderGeometry args={[args[0], args[1], fillHeight, args[3]]} />
                        ) : (
                            <boxGeometry args={[args[0], fillHeight, args[2]]} />
                        )}
                    </Addition>
                )}
             </React.Fragment>
          );
        })}
      </Geometry>
      <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
    </mesh>
  );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, params, stackup, visibleLayers }, ref) => {
  const controlsRef = useRef<any>(null);

  useImperativeHandle(ref, () => ({
    resetCamera: () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
    }
  }));

  // 1. Calculate Bounding Box of all shapes + Padding
  const bounds = useMemo(() => {
    const PADDING = 10;
    
    if (!footprint.shapes || footprint.shapes.length === 0) {
        return { minX: -PADDING, maxX: PADDING, minY: -PADDING, maxY: PADDING };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity; // mapped to 2D Y
    let maxY = -Infinity;

    footprint.shapes.forEach(shape => {
        const x = evaluate(shape.x, params);
        const y = evaluate(shape.y, params);
        
        let dx = 0;
        let dy = 0;

        if (shape.type === "circle") {
            const r = evaluate(shape.diameter, params) / 2;
            dx = r;
            dy = r;
        } else if (shape.type === "rect") {
            const w = evaluate(shape.width, params);
            const h = evaluate(shape.height, params);
            // Calculate a bounding radius to account for rotation 
            // (The diagonal is the furthest any point can be from center)
            const radius = Math.sqrt(Math.pow(w / 2, 2) + Math.pow(h / 2, 2));
            dx = radius;
            dy = radius;
        }

        if (x - dx < minX) minX = x - dx;
        if (x + dx > maxX) maxX = x + dx;
        if (y - dy < minY) minY = y - dy;
        if (y + dy > maxY) maxY = y + dy;
    });

    // Apply Padding
    return {
        minX: minX - PADDING,
        maxX: maxX + PADDING,
        minY: minY - PADDING,
        maxY: maxY + PADDING
    };

  }, [footprint, params]);

  return (
    <div style={{ width: "100%", height: "100%", background: "#111" }}>
      <Canvas camera={{ position: [50, 50, 50], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {(() => {
            let currentZ = 0; // This tracks height (Y in 3D)
            // Reverse the stack order so the first item in list appears on top
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluate(layer.thicknessExpression, params);
              
              // NEW: Check visibility
              const isVisible = visibleLayers ? visibleLayers[layer.id] !== false : true;
              
              const node = isVisible ? (
                <LayerSolid 
                  key={layer.id}
                  layer={layer}
                  footprint={footprint}
                  params={params}
                  bottomZ={currentZ}
                  thickness={thickness}
                  bounds={bounds}
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

export default Footprint3DView;