// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
// Note: Requires @react-three/csg and three-bvh-csg installed
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine } from "../types";

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

/**
 * Generates a 2D THREE.Shape representing the outline of the thick line.
 * Handles Bezier curves and thickness.
 */
function createLineShape(shape: FootprintLine, params: Parameter[], thicknessOverride?: number): THREE.Shape | null {
  const points = shape.points;
  if (points.length < 2) return null;

  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  const halfThick = thickVal / 2;

  // 1. Sample the path into a dense polyline of Vector2
  const pathPoints: THREE.Vector2[] = [];

  for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i+1];
      
      const x1 = evaluate(curr.x, params);
      const y1 = evaluate(curr.y, params);
      const x2 = evaluate(next.x, params);
      const y2 = evaluate(next.y, params);

      // Check for handles to determine if this segment is a curve
      // HandleIn is for the 'next' point (approaching it), HandleOut is for 'curr' point (leaving it)
      const hasCurve = (curr.handleOut || next.handleIn);

      if (hasCurve) {
          const cp1x = x1 + (curr.handleOut ? evaluate(curr.handleOut.x, params) : 0);
          const cp1y = y1 + (curr.handleOut ? evaluate(curr.handleOut.y, params) : 0);
          const cp2x = x2 + (next.handleIn ? evaluate(next.handleIn.x, params) : 0);
          const cp2y = y2 + (next.handleIn ? evaluate(next.handleIn.y, params) : 0);

          const curve = new THREE.CubicBezierCurve(
              new THREE.Vector2(x1, y1),
              new THREE.Vector2(cp1x, cp1y),
              new THREE.Vector2(cp2x, cp2y),
              new THREE.Vector2(x2, y2)
          );

          // Sample points
          const divisions = 24; 
          const sp = curve.getPoints(divisions);
          
          // If not the first segment, remove the first point to avoid duplicate
          if (pathPoints.length > 0) sp.shift();
          sp.forEach(p => pathPoints.push(p));
      } else {
          // Straight Line
          if (pathPoints.length === 0) pathPoints.push(new THREE.Vector2(x1, y1));
          pathPoints.push(new THREE.Vector2(x2, y2));
      }
  }

  if (pathPoints.length < 2) return null;

  // 2. Compute Offset Polygon (Outline)
  const leftPts: THREE.Vector2[] = [];
  const rightPts: THREE.Vector2[] = [];

  for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];

      // Calculate tangent/normal
      let tangent: THREE.Vector2;
      
      if (i === 0) {
          const next = pathPoints[i+1];
          tangent = new THREE.Vector2().subVectors(next, p).normalize();
      } else if (i === pathPoints.length - 1) {
          const prev = pathPoints[i-1];
          tangent = new THREE.Vector2().subVectors(p, prev).normalize();
      } else {
          // Miter-ish average
          const prev = pathPoints[i-1];
          const next = pathPoints[i+1];
          const t1 = new THREE.Vector2().subVectors(p, prev).normalize();
          const t2 = new THREE.Vector2().subVectors(next, p).normalize();
          tangent = new THREE.Vector2().addVectors(t1, t2).normalize();
      }

      const normal = new THREE.Vector2(-tangent.y, tangent.x);

      // Simple normal offset (could be improved with true miter join logic)
      leftPts.push(new THREE.Vector2(p.x + normal.x * halfThick, p.y + normal.y * halfThick));
      rightPts.push(new THREE.Vector2(p.x - normal.x * halfThick, p.y - normal.y * halfThick));
  }

  // 3. Build THREE.Shape
  const shape2D = new THREE.Shape();
  // Forward along Left
  shape2D.moveTo(leftPts[0].x, leftPts[0].y);
  for (let i = 1; i < leftPts.length; i++) {
      shape2D.lineTo(leftPts[i].x, leftPts[i].y);
  }
  // Backward along Right
  for (let i = rightPts.length - 1; i >= 0; i--) {
      shape2D.lineTo(rightPts[i].x, rightPts[i].y);
  }
  shape2D.closePath();

  return shape2D;
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
                  fillY = -actualDepth / 2;
              } else {
                  // Carving from Bottom: Material remains at the Top.
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
          let type: "cylinder" | "box" | "extrude" | null = null;
          
          // For line, we generate the Shape object
          let generatedShape: THREE.Shape | null = null;
          
          // Extrude geometries (lines) originate at Z=0. 
          // We need offsets to center them to match Box/Cylinder logic.
          let extrudeOffsetSub = 0;
          let extrudeOffsetAdd = 0;

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
          } else if (shape.type === "line") {
              generatedShape = createLineShape(shape as FootprintLine, params);
              if (generatedShape) {
                  args = [generatedShape, { depth: throughHeight, bevelEnabled: false }];
                  // Rotate to align Extrude Z with World Y, and Shape Y with World -Z
                  rotation = [-Math.PI / 2, 0, 0];
                  type = "extrude";
                  
                  // Fix: Center the extrusion geometry
                  extrudeOffsetSub = -throughHeight / 2;
                  extrudeOffsetAdd = -fillHeight / 2;
              }
          }

          if (!type) return null;

          // FIX: Small epsilon expansion for fill operations to prevent coincident face errors (Z-fighting/narrow triangles)
          const CSG_EPSILON = 0.01;

          return (
             <React.Fragment key={shape.id}>
                {/* Step A: Always subtract FULL THICKNESS to clear the column */}
                <Subtraction position={[localX, throughY + extrudeOffsetSub, localZ]} rotation={rotation}>
                    {type === "cylinder" ? (
                        <cylinderGeometry args={[args[0], args[1], throughHeight, args[3]]} />
                    ) : type === "box" ? (
                        <boxGeometry args={[args[0], throughHeight, args[2]]} />
                    ) : (
                        <extrudeGeometry args={args as [THREE.Shape, THREE.ExtrudeGeometryOptions]} />
                    )}
                </Subtraction>

                {/* Step B: Add back material if needed */}
                {shouldFill && (
                    <Addition position={[localX, fillY + extrudeOffsetAdd, localZ]} rotation={rotation}>
                        {(() => {
                            if (type === "cylinder") {
                                return <cylinderGeometry args={[args[0] + CSG_EPSILON, args[1] + CSG_EPSILON, fillHeight, args[3]]} />;
                            }
                            if (type === "box") {
                                return <boxGeometry args={[args[0] + CSG_EPSILON, fillHeight, args[2] + CSG_EPSILON]} />;
                            }
                            if (type === "extrude") {
                                // For lines, we need to regenerate the shape with slightly larger thickness for the fill
                                // to ensure it bonds correctly to the walls.
                                const baseThick = evaluate((shape as FootprintLine).thickness, params);
                                const thickShape = createLineShape(shape as FootprintLine, params, baseThick + CSG_EPSILON);
                                if (!thickShape) return null;
                                return <extrudeGeometry args={[thickShape, { depth: fillHeight, bevelEnabled: false }]} />;
                            }
                            return null;
                        })()}
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
            const radius = Math.sqrt(Math.pow(w / 2, 2) + Math.pow(h / 2, 2));
            dx = radius;
            dy = radius;
        } else if (shape.type === "line") {
            // Rough bounds for line
            const thick = evaluate(shape.thickness, params);
            const pts = (shape as FootprintLine).points;
            let lxMin = Infinity, lxMax = -Infinity, lyMin = Infinity, lyMax = -Infinity;
            pts.forEach(p => {
                const px = evaluate(p.x, params);
                const py = evaluate(p.y, params);
                if (px < lxMin) lxMin = px;
                if (px > lxMax) lxMax = px;
                if (py < lyMin) lyMin = py;
                if (py > lyMax) lyMax = py;
            });
            // Update global bounds directly with the line points + thickness
            // Since line points are absolute, we don't add x/y (which are usually 0 for lines)
            // But if x/y are set, we should respect them.
            if (lxMin < Infinity) {
                if (lxMin + x - thick < minX) minX = lxMin + x - thick;
                if (lxMax + x + thick > maxX) maxX = lxMax + x + thick;
                if (lyMin + y - thick < minY) minY = lyMin + y - thick;
                if (lyMax + y + thick > maxY) maxY = lyMax + y + thick;
            }
            return; // Continue to next shape
        }

        if (x - dx < minX) minX = x - dx;
        if (x + dx > maxX) maxX = x + dx;
        if (y - dy < minY) minY = y - dy;
        if (y + dy > maxY) maxY = y + dy;
    });

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
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluate(layer.thicknessExpression, params);
              
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