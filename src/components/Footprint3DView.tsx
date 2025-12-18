// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
// Note: Requires @react-three/csg and three-bvh-csg installed
import { Geometry, Base, Subtraction } from "@react-three/csg";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape } from "../types";

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
      scope[p.key] = math.unit(p.value, p.unit);
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

  // Identify shapes affecting this layer
  const activeShapes = footprint.shapes.filter(s => 
    s.assignedLayers && s.assignedLayers[layer.id] !== undefined
  );

  // Optimization: If no cuts, just return a simple mesh
  if (activeShapes.length === 0) {
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

        {/* Subtractions */}
        {activeShapes.map((shape) => {
          // 1. Calculate Cut Dimensions
          let cutDepth = 0;
          let cutY = 0; // Local Y position relative to center of layer

          if (layer.type === "Cut") {
             // Through Cut
             // Make it slightly taller than thickness to ensure clean boolean
             cutDepth = thickness + 0.2; 
             cutY = 0;
          } else {
             // Carved
             const val = evaluate(shape.assignedLayers[layer.id], params);
             const clampedVal = Math.max(0, Math.min(val, thickness));
             
             if (clampedVal <= 0) return null;

             // Extra length for clean boolean
             cutDepth = clampedVal + 0.1;

             if (layer.carveSide === "Top") {
                 // Cut from top (+thickness/2) down
                 // Center of cut = Top - (clampedVal / 2)
                 // Local Top is thickness/2
                 // We add a small offset (0.05) to ensure it breaks the surface
                 cutY = (thickness / 2) - (clampedVal / 2) + 0.05;
             } else {
                 // Cut from bottom (-thickness/2) up
                 cutY = (-thickness / 2) + (clampedVal / 2) - 0.05;
             }
          }

          // 2. Calculate 2D Position
          const sx = evaluate(shape.x, params);
          const sy = evaluate(shape.y, params);

          // 3. Local Position Calculation
          // The Base is at (0,0,0) inside this mesh, which corresponds to (centerX, centerY, centerZ) in world.
          // Shape World Pos: (sx, ?, sy)
          // Local Pos: (sx - centerX, cutY, sy - centerZ)
          const localX = sx - centerX;
          const localZ = sy - centerZ;

          if (shape.type === "circle") {
            const diameter = evaluate(shape.diameter, params);
            return (
              <Subtraction key={shape.id} position={[localX, cutY, localZ]}>
                 <cylinderGeometry args={[diameter/2, diameter/2, cutDepth, 32]} />
              </Subtraction>
            );
          } else if (shape.type === "rect") {
            const w = evaluate(shape.width, params);
            const h = evaluate(shape.height, params);
            return (
              <Subtraction key={shape.id} position={[localX, cutY, localZ]}>
                <boxGeometry args={[w, cutDepth, h]} />
              </Subtraction>
            );
          }
          return null;
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
            dx = evaluate(shape.width, params) / 2;
            dy = evaluate(shape.height, params) / 2;
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