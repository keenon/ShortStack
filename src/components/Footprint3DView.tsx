// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef, memo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, Point, FootprintReference } from "../types";

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // Required for recursion
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>;
  is3DActive: boolean;
}

export interface Footprint3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function evaluate(expression: string, params: Parameter[]): number {
  if (!expression || !expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      // Treat parameters as pure numbers in mm
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
  if (width <= 0 || height <= 0) return shape;

  const x = -width / 2;
  const y = -height / 2;
  
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
       // Fixed: Correctly target top-right corner coordinates (y + height)
       shape.quadraticCurveTo(x + width, y + height, x + width, y + height - r);
       shape.lineTo(x + width, y + r);
       shape.quadraticCurveTo(x + width, y, x + width - r, y);
       shape.lineTo(x + r, y);
       shape.quadraticCurveTo(x, y, x, y + r);
  }
  return shape;
}

function createLineShape(shape: FootprintLine, params: Parameter[], thicknessOverride?: number): THREE.Shape | null {
  const points = shape.points;
  if (points.length < 2) return null;

  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;
  
  const halfThick = thickVal / 2;

  const pathPoints: THREE.Vector2[] = [];

  for (let i = 0; i < points.length - 1; i++) {
      const curr = points[i];
      const next = points[i+1];
      
      const x1 = evaluate(curr.x, params);
      const y1 = evaluate(curr.y, params);
      const x2 = evaluate(next.x, params);
      const y2 = evaluate(next.y, params);

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

          const divisions = 24; 
          const sp = curve.getPoints(divisions);
          if (pathPoints.length > 0) sp.shift();
          sp.forEach(p => pathPoints.push(p));
      } else {
          if (pathPoints.length === 0) pathPoints.push(new THREE.Vector2(x1, y1));
          pathPoints.push(new THREE.Vector2(x2, y2));
      }
  }

  if (pathPoints.length < 2) return null;

  const leftPts: THREE.Vector2[] = [];
  const rightPts: THREE.Vector2[] = [];

  for (let i = 0; i < pathPoints.length; i++) {
      const p = pathPoints[i];
      let tangent: THREE.Vector2;
      
      if (i === 0) {
          const next = pathPoints[i+1];
          tangent = new THREE.Vector2().subVectors(next, p).normalize();
      } else if (i === pathPoints.length - 1) {
          const prev = pathPoints[i-1];
          tangent = new THREE.Vector2().subVectors(p, prev).normalize();
      } else {
          const prev = pathPoints[i-1];
          const next = pathPoints[i+1];
          const t1 = new THREE.Vector2().subVectors(p, prev).normalize();
          const t2 = new THREE.Vector2().subVectors(next, p).normalize();
          tangent = new THREE.Vector2().addVectors(t1, t2).normalize();
      }

      const normal = new THREE.Vector2(-tangent.y, tangent.x);
      leftPts.push(new THREE.Vector2(p.x + normal.x * halfThick, p.y + normal.y * halfThick));
      rightPts.push(new THREE.Vector2(p.x - normal.x * halfThick, p.y - normal.y * halfThick));
  }

  const shape2D = new THREE.Shape();
  shape2D.moveTo(leftPts[0].x, leftPts[0].y);
  
  for (let i = 1; i < leftPts.length; i++) {
      shape2D.lineTo(leftPts[i].x, leftPts[i].y);
  }

  const lastIdx = pathPoints.length - 1;
  const pLast = pathPoints[lastIdx];
  const vLast = new THREE.Vector2().subVectors(leftPts[lastIdx], pLast);
  const angLast = Math.atan2(vLast.y, vLast.x);
  
  shape2D.absarc(pLast.x, pLast.y, halfThick, angLast, angLast + Math.PI, true);

  for (let i = rightPts.length - 2; i >= 0; i--) {
      shape2D.lineTo(rightPts[i].x, rightPts[i].y);
  }

  const pFirst = pathPoints[0];
  const vFirst = new THREE.Vector2().subVectors(rightPts[0], pFirst);
  const angFirst = Math.atan2(vFirst.y, vFirst.x);
  
  shape2D.absarc(pFirst.x, pFirst.y, halfThick, angFirst, angFirst + Math.PI, true);

  return shape2D;
}

function createBoardShape(points: Point[], params: Parameter[]): THREE.Shape | null {
    if (!points || points.length < 3) return null;
    const shape = new THREE.Shape();

    const p0 = points[0];
    shape.moveTo(evaluate(p0.x, params), evaluate(p0.y, params));
    
    for(let i = 0; i < points.length; i++) {
        const curr = points[i];
        const next = points[(i + 1) % points.length];
        
        const x2 = evaluate(next.x, params);
        const y2 = evaluate(next.y, params);

        if (curr.handleOut || next.handleIn) {
            const x1 = evaluate(curr.x, params);
            const y1 = evaluate(curr.y, params);
            
            const cp1x = x1 + (curr.handleOut ? evaluate(curr.handleOut.x, params) : 0);
            const cp1y = y1 + (curr.handleOut ? evaluate(curr.handleOut.y, params) : 0);
            
            const cp2x = x2 + (next.handleIn ? evaluate(next.handleIn.x, params) : 0);
            const cp2y = y2 + (next.handleIn ? evaluate(next.handleIn.y, params) : 0);
            
            shape.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);
        } else {
            shape.lineTo(x2, y2);
        }
    }
    return shape;
}

// ------------------------------------------------------------------
// FLATTENING LOGIC
// ------------------------------------------------------------------

interface FlatShape {
    shape: FootprintShape; // The actual primitive shape
    x: number;             // Global X in mm
    y: number;             // Global Y in mm
    rotation: number;      // Global Rotation in degrees
    originalId: string;
}

// Recursively traverse footprint references to build a flat list of primitives with absolute transforms
function flattenShapes(
    shapes: FootprintShape[], 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = { x: 0, y: 0, rotation: 0 },
    depth = 0
): FlatShape[] {
    if (depth > 10) return []; // Safety break

    let result: FlatShape[] = [];

    shapes.forEach(shape => {
        // Calculate Global Transform for this specific shape
        const localX = evaluate(shape.x, params);
        const localY = evaluate(shape.y, params);
        
        const rad = (transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const globalX = transform.x + (localX * cos - localY * sin);
        const globalY = transform.y + (localX * sin + localY * cos);
        
        // Rects and Refs have own angle. Circle/Line usually don't have rotation that affects bounding box center same way,
        // but Rect angle is local rotation.
        let localRotation = 0;
        if (shape.type === "rect" || shape.type === "footprint") {
            localRotation = evaluate((shape as any).angle, params);
        }
        const globalRotation = transform.rotation + localRotation;

        if (shape.type === "footprint") {
            const ref = shape as FootprintReference;
            const target = allFootprints.find(f => f.id === ref.footprintId);
            if (target) {
                // Recurse
                const children = flattenShapes(target.shapes, allFootprints, params, {
                    x: globalX,
                    y: globalY,
                    rotation: globalRotation
                }, depth + 1);
                result = result.concat(children);
            }
        } else {
            // It's a primitive (Circle, Rect, Line)
            result.push({
                shape: shape,
                x: globalX,
                y: globalY,
                rotation: globalRotation,
                originalId: shape.id
            });
        }
    });

    return result;
}

// ------------------------------------------------------------------
// COMPONENTS
// ------------------------------------------------------------------

interface LayerCSGProps {
    layer: StackupLayer;
    flatShapes: FlatShape[];
    params: Parameter[];
    thickness: number;
    width: number;
    depth: number;
    centerX: number;
    centerZ: number;
    boardShape: THREE.Shape | null;
}

const CSGLayerGeometry = memo(({
    layer,
    flatShapes,
    params,
    thickness,
    width,
    depth,
    centerX,
    centerZ,
    boardShape
}: LayerCSGProps) => {

    const CSG_EPSILON = 0.01;

    // Base geometry
    const baseGeometry = boardShape ? (
        <Base rotation={[-Math.PI / 2, 0, 0]} position={[0, -thickness / 2, 0]}>
            <extrudeGeometry args={[boardShape, { depth: thickness, bevelEnabled: false }]} />
        </Base>
    ) : (
        <Base>
            <boxGeometry args={[width, thickness, depth]} />
        </Base>
    );

    return (
        <Geometry>
            {baseGeometry}

            {flatShapes.map((item, idx) => { // ADDED idx here
                const shape = item.shape;

                // Check Assignment
                if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return null;

                // 1. Calculate Target Depth & Radius
                let actualDepth = thickness;
                let endmillRadius = 0;

                if (layer.type === "Cut") {
                    actualDepth = thickness; 
                } else {
                    const assignment = shape.assignedLayers[layer.id];
                    const valExpr = (typeof assignment === 'object') ? assignment.depth : (assignment as string);
                    const radiusExpr = (typeof assignment === 'object') ? assignment.endmillRadius : "0";

                    const val = evaluate(valExpr, params);
                    endmillRadius = evaluate(radiusExpr, params);
                    actualDepth = Math.max(0, Math.min(val, thickness));
                }

                const isPartialCut = actualDepth < thickness - 0.001;
                const hasRadius = endmillRadius > 0.001;
                const shouldRound = isPartialCut && hasRadius;

                // 2. Calculate Vertical Geometry
                const throughHeight = thickness + 0.2; 
                const throughY = 0; 

                // Fill logic
                let fillHeight = thickness - actualDepth;
                if (shouldRound) fillHeight += endmillRadius;

                let fillY = 0;
                const shouldFill = fillHeight > 0.001;
                if (shouldFill) {
                    fillY = layer.carveSide === "Top" 
                        ? (-thickness / 2 + fillHeight / 2) 
                        : (thickness / 2 - fillHeight / 2);
                }

                // 3. Local Position in CSG Space
                // Transform Global 2D (item.x, item.y) to Local 3D (X, Z) relative to center
                const localX = item.x - centerX;
                const localZ = centerZ - item.y; // Y-flip

                // 4. Generate Shapes / Args
                let argsThrough: any[] = [];
                let typeThrough: "cylinder" | "box" | "extrude" | null = null;
                let rotThrough: [number, number, number] = [0, 0, 0];
                
                let roundedCutArgs: any[] = [];
                let roundedCutRot: [number, number, number] = [0, 0, 0];
                let roundedCutPos: [number, number, number] = [0, 0, 0];

                const globalRotRad = (item.rotation * Math.PI) / 180;

                const getShapeObj = (extraOffset: number = 0): THREE.Shape | null => {
                    if (shape.type === "circle") {
                        const d = evaluate((shape as any).diameter, params);
                        if (d <= 0) return null;
                        const s = new THREE.Shape();
                        s.absarc(0, 0, d/2 + extraOffset, 0, Math.PI*2, true);
                        return s;
                    } else if (shape.type === "rect") {
                        const w = evaluate((shape as FootprintRect).width, params);
                        const h = evaluate((shape as FootprintRect).height, params);
                        const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                        const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                        return createRoundedRectShape(w + extraOffset, h + extraOffset, cr + extraOffset/2);
                    } else if (shape.type === "line") {
                        const t = evaluate((shape as FootprintLine).thickness, params);
                        const validT = t > 0 ? t : 0.01;
                        return createLineShape(shape as FootprintLine, params, validT + extraOffset);
                    }
                    return null;
                };

                // --- Geometry Setup ---
                if (shape.type === "circle") {
                    const d = evaluate((shape as any).diameter, params);
                    if (d > 0) {
                        argsThrough = [d/2, d/2, throughHeight, 32];
                        typeThrough = "cylinder";
                    }
                } else if (shape.type === "rect") {
                    const w = evaluate((shape as FootprintRect).width, params);
                    const h = evaluate((shape as FootprintRect).height, params);
                    const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                    const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));

                    if (w > 0 && h > 0) {
                        if (cr > 0.001) {
                            const s = createRoundedRectShape(w, h, cr);
                            argsThrough = [s, { depth: throughHeight, bevelEnabled: false }];
                            typeThrough = "extrude";
                            rotThrough = [-Math.PI/2, 0, globalRotRad];
                        } else {
                            argsThrough = [w, throughHeight, h];
                            typeThrough = "box";
                            rotThrough = [0, globalRotRad, 0];
                        }
                    }
                } else if (shape.type === "line") {
                    const s = createLineShape(shape as FootprintLine, params);
                    if (s) {
                        argsThrough = [s, { depth: throughHeight, bevelEnabled: false }];
                        typeThrough = "extrude";
                        rotThrough = [-Math.PI/2, 0, globalRotRad];
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
                        roundedCutRot = [-Math.PI/2, 0, globalRotRad];

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
                    <React.Fragment key={`${item.originalId}-${idx}`}>
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
                                        // Re-generate shape with epsilon
                                        const s = getShapeObj(CSG_EPSILON);
                                        if (!s) return null;
                                        return <extrudeGeometry args={[s, { depth: fillHeight, bevelEnabled: false }]} />;
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
    if (prev.layer.id !== next.layer.id) return false;
    if (prev.thickness !== next.thickness) return false;
    if (prev.width !== next.width) return false;
    if (prev.depth !== next.depth) return false;
    // Deep check shapes
    if (prev.flatShapes.length !== next.flatShapes.length) return false;
    for (let i = 0; i < prev.flatShapes.length; i++) {
        const p = prev.flatShapes[i];
        const n = next.flatShapes[i];
        if (p.x !== n.x || p.y !== n.y || p.rotation !== n.rotation || p.originalId !== n.originalId) return false;
        if (p.shape !== n.shape) return false; 
    }
    // Check board shape ref
    if (prev.boardShape !== next.boardShape) return false;
    return true;
});


/**
 * Renders a single layer as a solid block with cuts subtracted (CSG).
 */
const LayerSolid = ({
  layer,
  footprint,
  allFootprints,
  params,
  bottomZ,
  thickness,
  bounds,
  boardShape,
  registerMesh, // NEW
}: {
  layer: StackupLayer;
  footprint: Footprint;
  allFootprints: Footprint[];
  params: Parameter[];
  bottomZ: number;
  thickness: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  boardShape: THREE.Shape | null;
  registerMesh?: (id: string, mesh: THREE.Mesh | null) => void; // NEW
}) => {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY; 
  
  const centerX = boardShape ? 0 : (bounds.minX + bounds.maxX) / 2;
  const centerZ = boardShape ? 0 : (bounds.minY + bounds.maxY) / 2;
  const centerY = bottomZ + thickness / 2;

  // Flatten shapes
  const flatShapes = useMemo(() => {
    return flattenShapes(footprint.shapes, allFootprints, params);
  }, [footprint, allFootprints, params]);

  return (
    <mesh 
        position={[centerX, centerY, centerZ]}
        ref={(ref) => registerMesh && registerMesh(layer.id, ref)}
    >
      <CSGLayerGeometry 
          layer={layer}
          flatShapes={flatShapes}
          params={params}
          thickness={thickness}
          width={width}
          depth={depth}
          centerX={centerX}
          centerZ={centerZ}
          boardShape={boardShape}
      />
      <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
    </mesh>
  );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, visibleLayers, is3DActive }, ref) => {
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
      if (footprint.isBoard && footprint.boardOutline && footprint.boardOutline.length >= 3) {
          return createBoardShape(footprint.boardOutline, params);
      }
      return null;
  }, [footprint, params]);

  // 1. Calculate Bounding Box of all shapes (or board outline) + Padding
  const bounds = useMemo(() => {
    const PADDING = 10;
    
    if (footprint.isBoard && footprint.boardOutline && footprint.boardOutline.length >= 3) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        footprint.boardOutline.forEach(p => {
             const x = evaluate(p.x, params);
             const y = evaluate(p.y, params);
             if (x < minX) minX = x;
             if (x > maxX) maxX = x;
             if (y < minY) minY = y;
             if (y > maxY) maxY = y;
        });
        return { minX: minX - PADDING, maxX: maxX + PADDING, minY: minY - PADDING, maxY: maxY + PADDING };
    }

    // Basic bounds of root shapes
    if (!footprint.shapes || footprint.shapes.length === 0) {
        return { minX: -PADDING, maxX: PADDING, minY: -PADDING, maxY: PADDING };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    footprint.shapes.forEach(shape => {
        const x = evaluate(shape.x, params);
        const y = evaluate(shape.y, params);
        const MARGIN = 50; 
        if (x - MARGIN < minX) minX = x - MARGIN;
        if (x + MARGIN > maxX) maxX = x + MARGIN;
        if (y - MARGIN < minY) minY = y - MARGIN;
        if (y + MARGIN > maxY) maxY = y + MARGIN;
    });

    return { minX, maxX, minY, maxY };

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
                  boardShape={boardShape}
                  registerMesh={(id, mesh) => { 
                      if (mesh) meshRefs.current[id] = mesh; 
                      else delete meshRefs.current[id]; 
                  }}
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
// Duplicated from Layout3DView to avoid dependency issues
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

export default Footprint3DView;