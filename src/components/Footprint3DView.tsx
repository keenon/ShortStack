// src/components/Footprint3DView.tsx
import React, { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, Center } from "@react-three/drei";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape } from "../types";

interface Props {
  footprint: Footprint;
  params: Parameter[];
  stackup: StackupLayer[];
}

// Helper to evaluate math expressions (duplicated from Editor to avoid circular deps)
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

// Individual Mesh Component for a Cut
const CutMesh = ({
  shape,
  layer,
  bottomZ,
  layerThickness,
  params
}: {
  shape: FootprintShape;
  layer: StackupLayer;
  bottomZ: number;
  layerThickness: number;
  params: Parameter[];
}) => {
  // 1. Calculate Cut Geometry (Height & Y-Position)
  // ------------------------------------------------
  let cutHeight = 0;
  let cutCenterY = 0;
  
  const layerTopZ = bottomZ + layerThickness;

  if (layer.type === "Cut") {
    // Through-hole: Full height
    cutHeight = layerThickness;
    cutCenterY = bottomZ + layerThickness / 2;
  } else {
    // Carved: specified depth
    const depthExpr = shape.assignedLayers[layer.id] || "0";
    let depth = evaluate(depthExpr, params);
    
    // Clamp depth to thickness
    if (depth > layerThickness) depth = layerThickness;
    if (depth < 0) depth = 0;
    if (depth === 0) return null; // Nothing to render

    cutHeight = depth;

    if (layer.carveSide === "Top") {
      // Cutting down from top
      cutCenterY = layerTopZ - depth / 2;
    } else {
      // Cutting up from bottom
      cutCenterY = bottomZ + depth / 2;
    }
  }

  // 2. Calculate 2D Shape Properties
  // ------------------------------------------------
  const x = evaluate(shape.x, params);
  const y = evaluate(shape.y, params); // Mapped to Z in 3D

  const color = layer.color;
  const opacity = 0.6;

  if (shape.type === "circle") {
    const diameter = evaluate(shape.diameter, params);
    const radius = diameter / 2;
    return (
      <mesh position={[x, cutCenterY, y]}>
        {/* Cylinder: TopRad, BotRad, Height, Segments */}
        <cylinderGeometry args={[radius, radius, cutHeight, 32]} />
        <meshStandardMaterial 
            color={color} 
            transparent 
            opacity={opacity} 
            side={THREE.DoubleSide} 
        />
      </mesh>
    );
  } else if (shape.type === "rect") {
    const w = evaluate(shape.width, params);
    const h = evaluate(shape.height, params); // This is 'height' in 2D, so 'depth' (Z) in 3D
    return (
      <mesh position={[x, cutCenterY, y]}>
        {/* Box: Width(X), Height(Y), Depth(Z) */}
        <boxGeometry args={[w, cutHeight, h]} />
        <meshStandardMaterial 
            color={color} 
            transparent 
            opacity={opacity} 
            side={THREE.DoubleSide}
        />
      </mesh>
    );
  }

  return null;
};

export default function Footprint3DView({ footprint, params, stackup }: Props) {
  return (
    <div style={{ width: "100%", height: "100%", background: "#111" }}>
      <Canvas camera={{ position: [50, 50, 50], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {/* Render Shapes */}
          {(() => {
            let currentZ = 0;
            const meshes: React.ReactNode[] = [];

            stackup.forEach((layer) => {
              const thickness = evaluate(layer.thicknessExpression, params);
              
              footprint.shapes.forEach((shape) => {
                // Check if shape is assigned to this layer
                if (shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined) {
                  meshes.push(
                    <CutMesh 
                      key={`${shape.id}-${layer.id}`}
                      shape={shape}
                      layer={layer}
                      bottomZ={currentZ}
                      layerThickness={thickness}
                      params={params}
                    />
                  );
                }
              });

              currentZ += thickness;
            });

            return meshes;
          })()}
        </group>

        {/* Helpers */}
        <Grid 
            infiniteGrid 
            fadeDistance={200} 
            sectionColor="#444" 
            cellColor="#222" 
            position={[0, 0, 0]} 
        />
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={['#9d4b4b', '#2f7f4f', '#3b5b9d']} labelColor="white" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}