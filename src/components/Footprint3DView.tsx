// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef, memo } from "react";
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
  is3DActive: boolean;
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

function createRoundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  // Ensure valid dimensions
  if (width <= 0 || height <= 0) return shape;

  const x = -width / 2;
  const y = -height / 2;
  
  // Clamp radius to prevent self-intersection
  const maxR = Math.min(width, height) / 2;
  const r = Math.max(0, Math.min(radius, maxR));
  
  if (r <= 0.001) {
      shape.moveTo(x, y);
      shape.lineTo(x + width, y);
      shape.lineTo(x + width, y + height);
      shape.lineTo(x, y + height);
      shape.lineTo(x, y);
  } else {
       shape.moveTo(x, y + r);
       shape.lineTo(x, y + height - r);
       shape.quadraticCurveTo(x, y + height, x + r, y + height);
       shape.lineTo(x + width - r, y + height);
       shape.quadraticCurveTo(x + width, y + height, x + width, y + height - r);
       shape.lineTo(x + width, y + r);
       shape.quadraticCurveTo(x + width, y, x + width - r, y);
       shape.lineTo(x + r, y);
       shape.quadraticCurveTo(x, y, x, y + r);
  }
  return shape;
}

/**
 * Generates a 2D THREE.Shape representing the outline of the thick line.
 * Handles Bezier curves and thickness.
 */
function createLineShape(shape: FootprintLine, params: Parameter[], thicknessOverride?: number): THREE.Shape | null {
  const points = shape.points;
  if (points.length < 2) return null;

  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;
  
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

  // 3. Build THREE.Shape with Rounded Ends
  const shape2D = new THREE.Shape();
  
  // Start at the first Left point
  shape2D.moveTo(leftPts[0].x, leftPts[0].y);
  
  // Traverse Left side forward
  for (let i = 1; i < leftPts.length; i++) {
      shape2D.lineTo(leftPts[i].x, leftPts[i].y);
  }

  // End Cap: Rounded Arc from Left[end] to Right[end]
  const lastIdx = pathPoints.length - 1;
  const pLast = pathPoints[lastIdx];
  // Calculate angle of the vector from center to the current point (Left[end])
  const vLast = new THREE.Vector2().subVectors(leftPts[lastIdx], pLast);
  const angLast = Math.atan2(vLast.y, vLast.x);
  
  // Draw clockwise arc to the opposite side (Left -> Right)
  shape2D.absarc(pLast.x, pLast.y, halfThick, angLast, angLast + Math.PI, true);

  // Traverse Right side backward
  // We start from the second-to-last point because the arc lands us on the last Right point
  for (let i = rightPts.length - 2; i >= 0; i--) {
      shape2D.lineTo(rightPts[i].x, rightPts[i].y);
  }

  // Start Cap: Rounded Arc from Right[0] to Left[0]
  const pFirst = pathPoints[0];
  // Calculate angle of the vector from center to the current point (Right[0])
  const vFirst = new THREE.Vector2().subVectors(rightPts[0], pFirst);
  const angFirst = Math.atan2(vFirst.y, vFirst.x);
  
  // Draw clockwise arc back to the start point (Right -> Left)
  shape2D.absarc(pFirst.x, pFirst.y, halfThick, angFirst, angFirst + Math.PI, true);

  return shape2D;
}

// ------------------------------------------------------------------
// COMPONENTS
// ------------------------------------------------------------------

interface LayerCSGProps {
    layer: StackupLayer;
    shapes: FootprintShape[];
    params: Parameter[];
    thickness: number;
    width: number;
    depth: number;
    centerX: number;
    centerZ: number;
}

/**
 * Memoized Component for the expensive CSG Geometry calculation.
 * It will only re-render if the 'shapes' array changes in a way that affects THIS layer.
 * We rely on checking if the shape objects themselves have changed reference.
 */
const CSGLayerGeometry = memo(({
    layer,
    shapes,
    params,
    thickness,
    width,
    depth,
    centerX,
    centerZ
}: LayerCSGProps) => {

    const CSG_EPSILON = 0.01;

    // Optimization: If no cuts, just return a simple boxGeometry (handled via early exit inside Geometry usually, but here for clarity)
    // However, react-three-csg <Geometry> container handles base + empty ops fine.
    
    return (
        <Geometry>
            {/* Base Positive Shape */}
            <Base>
                <boxGeometry args={[width, thickness, depth]} />
            </Base>

            {/* Operations */}
            {shapes.map((shape) => {
                // 1. Calculate Target Depth & Radius
                let actualDepth = thickness;
                let endmillRadius = 0;

                if (layer.type === "Cut") {
                    actualDepth = thickness; 
                } else {
                    const assignment = shape.assignedLayers[layer.id];
                    // Handle both legacy string and object assignment
                    const valExpr = (typeof assignment === 'object') ? assignment.depth : (assignment as string);
                    const radiusExpr = (typeof assignment === 'object') ? assignment.endmillRadius : "0";

                    const val = evaluate(valExpr, params);
                    endmillRadius = evaluate(radiusExpr, params);
                    actualDepth = Math.max(0, Math.min(val, thickness));
                }

                const isPartialCut = actualDepth < thickness - 0.001;
                const hasRadius = endmillRadius > 0.001;
                const shouldRound = isPartialCut && hasRadius;

                // 2. Calculate Geometry Parameters
                const throughHeight = thickness + 0.2; 
                const throughY = 0; 

                // Fill (Addition)
                // If rounding, we add extra material to allow the ball nose to "carve" the fillet
                let fillHeight = thickness - actualDepth;
                if (shouldRound) {
                    fillHeight += endmillRadius;
                }

                let fillY = 0;
                const shouldFill = fillHeight > 0.001;

                // Align Fill Block
                if (shouldFill) {
                    if (layer.carveSide === "Top") {
                        fillY = -thickness / 2 + fillHeight / 2;
                    } else {
                        fillY = thickness / 2 - fillHeight / 2;
                    }
                }

                // 3. Local Position
                const sx = evaluate(shape.x, params);
                const sy = evaluate(shape.y, params);
                const localX = sx - centerX;
                const localZ = centerZ - sy; 

                // 4. Generate Shapes / Args
                let argsThrough: any[] = [];
                let typeThrough: "cylinder" | "box" | "extrude" | null = null;
                let rotThrough: [number, number, number] = [0, 0, 0];
                
                let roundedCutArgs: any[] = [];
                let roundedCutRot: [number, number, number] = [0, 0, 0];
                let roundedCutPos: [number, number, number] = [0, 0, 0];

                const getShapeObj = (extraOffset: number = 0): THREE.Shape | null => {
                    if (shape.type === "circle") {
                        const d = evaluate(shape.diameter, params);
                        if (d <= 0) return null;
                        const s = new THREE.Shape();
                        s.absarc(0, 0, d/2 + extraOffset, 0, Math.PI*2, true);
                        return s;
                    } else if (shape.type === "rect") {
                        const w = evaluate(shape.width, params);
                        const h = evaluate(shape.height, params);
                        const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                        const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                        return createRoundedRectShape(w + extraOffset, h + extraOffset, cr + extraOffset/2);
                    } else if (shape.type === "line") {
                        const t = evaluate(shape.thickness, params);
                        const validT = t > 0 ? t : 0.01;
                        return createLineShape(shape as FootprintLine, params, validT + extraOffset);
                    }
                    return null;
                };

                // --- Through Cut Geometry ---
                if (shape.type === "circle") {
                    const d = evaluate(shape.diameter, params);
                    if (d > 0) {
                        argsThrough = [d/2, d/2, throughHeight, 32];
                        typeThrough = "cylinder";
                    }
                } else if (shape.type === "rect") {
                    const w = evaluate(shape.width, params);
                    const h = evaluate(shape.height, params);
                    const angle = evaluate((shape as FootprintRect).angle, params);
                    const rad = (angle * Math.PI) / 180;
                    const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                    const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));

                    if (w > 0 && h > 0) {
                        if (cr > 0.001) {
                            const s = createRoundedRectShape(w, h, cr);
                            argsThrough = [s, { depth: throughHeight, bevelEnabled: false }];
                            typeThrough = "extrude";
                            // For extruded shape (XY plane), rotate X -90 puts it on XZ plane.
                            // The local Z axis then points along World -Y.
                            // To rotate the shape on the floor (XZ), we must rotate around local Z.
                            rotThrough = [-Math.PI/2, 0, rad];
                        } else {
                            argsThrough = [w, throughHeight, h];
                            typeThrough = "box";
                            rotThrough = [0, rad, 0];
                        }
                    }
                } else if (shape.type === "line") {
                    const s = createLineShape(shape as FootprintLine, params);
                    if (s) {
                        argsThrough = [s, { depth: throughHeight, bevelEnabled: false }];
                        typeThrough = "extrude";
                        rotThrough = [-Math.PI/2, 0, 0];
                    }
                }

                if (!typeThrough) return null; 

                const extrudeCenterOffset = -throughHeight / 2;

                // --- Rounded Cut Geometry ---
                if (shouldRound) {
                    const s = getShapeObj(CSG_EPSILON);
                    if (s) {
                        const options: THREE.ExtrudeGeometryOptions = {
                            depth: throughHeight, 
                            bevelEnabled: true,
                            bevelThickness: endmillRadius,
                            bevelSize: endmillRadius,
                            bevelOffset: -endmillRadius,
                            bevelSegments: 10,
                            curveSegments: 32
                        };
                        
                        roundedCutArgs = [s, options];

                        let angleRad = 0;
                        if (shape.type === "rect") angleRad = (evaluate((shape as FootprintRect).angle, params) * Math.PI) / 180;

                        roundedCutRot = [-Math.PI/2, 0, angleRad];

                        if (layer.carveSide === "Top") {
                            const floorY = (thickness / 2) - actualDepth;
                            roundedCutPos = [localX, floorY + endmillRadius, localZ];
                        } else {
                            const floorY = (-thickness / 2) + actualDepth;
                            roundedCutPos = [localX, floorY - (throughHeight + endmillRadius), localZ];
                        }
                    }
                }

                return (
                    <React.Fragment key={shape.id}>
                        {/* 1. THROUGH CUT */}
                        <Subtraction 
                            position={[localX, throughY + (typeThrough === 'extrude' ? extrudeCenterOffset : 0), localZ]} 
                            rotation={rotThrough}
                        >
                            {typeThrough === "cylinder" ? (
                                <cylinderGeometry args={argsThrough as any} />
                            ) : typeThrough === "box" ? (
                                <boxGeometry args={argsThrough as any} />
                            ) : (
                                <extrudeGeometry args={argsThrough as any} />
                            )}
                        </Subtraction>

                        {/* 2. ADD BACK MATERIAL (Floor) */}
                        {shouldFill && (
                            <Addition 
                                position={[
                                    localX, 
                                    (typeThrough === 'extrude') ? (fillY - fillHeight/2) : fillY, 
                                    localZ
                                ]} 
                                rotation={rotThrough}
                            >
                                {(() => {
                                    if (typeThrough === "cylinder") {
                                        const [rt, rb, h, s] = argsThrough;
                                        return <cylinderGeometry args={[rt + CSG_EPSILON, rb + CSG_EPSILON, fillHeight, s]} />;
                                    }
                                    if (typeThrough === "box") {
                                        const [w, h, d] = argsThrough;
                                        return <boxGeometry args={[w + CSG_EPSILON, fillHeight, d + CSG_EPSILON]} />;
                                    }
                                    if (typeThrough === "extrude") {
                                        if (shape.type === "line") {
                                            const baseThick = evaluate((shape as FootprintLine).thickness, params);
                                            const validThick = baseThick > 0 ? baseThick : 0.01;
                                            const thickShape = createLineShape(shape as FootprintLine, params, validThick + CSG_EPSILON);
                                            if (!thickShape) return null;
                                            return <extrudeGeometry args={[thickShape, { depth: fillHeight, bevelEnabled: false }]} />;
                                        } 
                                        else if (shape.type === "rect") {
                                            const w = evaluate((shape as FootprintRect).width, params);
                                            const h = evaluate((shape as FootprintRect).height, params);
                                            const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                                            const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                                            
                                            const expandedShape = createRoundedRectShape(w + CSG_EPSILON, h + CSG_EPSILON, cr + CSG_EPSILON/2);
                                            return <extrudeGeometry args={[expandedShape, { depth: fillHeight, bevelEnabled: false }]} />;
                                        }
                                    }
                                    return null;
                                })()}
                            </Addition>
                        )}

                        {/* 3. ROUNDED CUT (Fillet) */}
                        {shouldRound && roundedCutArgs.length > 0 && (
                            <Subtraction position={roundedCutPos} rotation={roundedCutRot}>
                                <extrudeGeometry args={roundedCutArgs as any} />
                            </Subtraction>
                        )}
                    </React.Fragment>
                );
            })}
        </Geometry>
    );

}, (prev, next) => {
    // Custom Comparator for React.memo
    // Returns true if props are equivalent (DO NOT RE-RENDER)
    if (prev.layer.id !== next.layer.id) return false;
    if (prev.thickness !== next.thickness) return false;
    if (prev.width !== next.width) return false;
    if (prev.depth !== next.depth) return false;
    if (prev.centerX !== next.centerX) return false;
    if (prev.centerZ !== next.centerZ) return false;
    if (prev.params !== next.params) return false; // Params change rarely, but if they do, re-render
    
    // Check shapes array
    if (prev.shapes.length !== next.shapes.length) return false;
    
    // Check shape references. 
    // In FootprintEditor, we only create new shape objects when that specific shape is modified.
    // So if the shapes assigned to this layer haven't changed, their references will be identical.
    for (let i = 0; i < prev.shapes.length; i++) {
        if (prev.shapes[i] !== next.shapes[i]) return false;
    }

    return true;
});


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
  // We use useMemo to derive the list. If `footprint.shapes` changes (new array ref), this runs.
  // However, `CSGLayerGeometry` is memoized and checks the *contents* of this list.
  const orderedShapes = useMemo(() => {
    return [...footprint.shapes].reverse().filter(s => 
      s.assignedLayers && s.assignedLayers[layer.id] !== undefined
    );
  }, [footprint.shapes, layer.id]);

  // Optimization: If no cuts, we could skip CSG, but CSGLayerGeometry handles it efficiently.
  // We'll just render the mesh wrapper and delegate geometry.

  return (
    <mesh position={[centerX, centerY, centerZ]}>
      <CSGLayerGeometry 
          layer={layer}
          shapes={orderedShapes}
          params={params}
          thickness={thickness}
          width={width}
          depth={depth}
          centerX={centerX}
          centerZ={centerZ}
      />
      <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
    </mesh>
  );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, params, stackup, visibleLayers, is3DActive }, ref) => {
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
            const d = evaluate(shape.diameter, params);
            const r = d > 0 ? d/2 : 0;
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
            if (lxMin < Infinity) {
                if (lxMin + x - thick < minX) minX = lxMin + x - thick;
                if (lxMax + x + thick > maxX) maxX = lxMax + x + thick;
                if (lyMin + y - thick < minY) minY = lyMin + y - thick;
                if (lyMax + y + thick > maxY) maxY = lyMax + y + thick;
            }
            return;
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
      <Canvas 
        camera={{ position: [50, 50, 50], fov: 45 }}
        frameloop={is3DActive ? "always" : "never"}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {(() => {
            let currentZ = 0; // This tracks height (Y in 3D)
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluate(layer.thicknessExpression, params);
              
              const isVisible = visibleLayers ? visibleLayers[layer.id] !== false : true;
              
              // PERFORMANCE OPTIMIZATION: 
              // If layer is hidden, render null. This unmounts LayerSolid, skipping CSGLayerGeometry calculation.
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