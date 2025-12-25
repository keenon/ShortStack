// src/components/Unified3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef, memo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
// Requires @react-three/csg and three-bvh-csg
import { Geometry, Base, Subtraction, Addition } from "@react-three/csg";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, FootprintInstance, BoardOutline, FootprintCircle } from "../types";

// ------------------------------------------------------------------
// TYPES
// ------------------------------------------------------------------

export type RenderItem = 
  | { type: 'shape'; data: FootprintShape }
  | { type: 'instance'; data: FootprintInstance };

interface Props {
  items: RenderItem[];
  footprints?: Footprint[]; // Required if items contains instances
  boardOutline?: BoardOutline; // If provided, used as base. If not, auto-bounds used.
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>;
  is3DActive?: boolean; // For performance toggling
}

export interface Unified3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function evaluate(expression: string | undefined | null, params: Parameter[]): number {
  if (!expression || !expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
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
          const sp = curve.getPoints(24);
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

// ------------------------------------------------------------------
// CSG LAYER COMPONENT
// ------------------------------------------------------------------

interface LayerCSGProps {
    layer: StackupLayer;
    items: RenderItem[];
    footprints?: Footprint[];
    params: Parameter[];
    thickness: number;
    baseShape: THREE.Shape;
}

/**
 * Renders the CSG geometry for a single layer.
 * Coordinate System (Local to this Mesh):
 * X = World X (Right)
 * Y = World Z (Depth, away from screen) -> Note: We rotate mesh X -90 globally
 * Z = World Y (Height/Thickness, up)
 * 
 * Subtractions are placed in this X/Y plane and extruded along Z.
 */
const CSGLayerGeometry = memo(({
    layer,
    items,
    footprints,
    params,
    thickness,
    baseShape
}: LayerCSGProps) => {

    const CSG_EPSILON = 0.01;
    const throughHeight = thickness + 0.2; 
    const throughZ = thickness / 2; // Center of cut (since BoxGeometry is centered)

    return (
        <Geometry>
            {/* BASE: Extruded Board/Rect */}
            <Base>
                {/* extrudeGeometry aligns along Z axis by default. Perfect for thickness. */}
                <extrudeGeometry args={[baseShape, { depth: thickness, bevelEnabled: false }]} />
            </Base>

            {/* CUTS */}
            {items.map((item) => {
                // Resolve list of shapes to render for this item
                let shapesToRender: { shape: FootprintShape; tx: number; ty: number; rot: number }[] = [];

                if (item.type === 'shape') {
                    // Raw Shape (Footprint Editor Mode)
                    const s = item.data;
                    const sx = evaluate(s.x, params);
                    const sy = evaluate(s.y, params);
                    // Single shape at (sx, sy) with 0 extra rotation (internal angle handled later)
                    shapesToRender.push({ shape: s, tx: sx, ty: sy, rot: 0 });
                } else if (item.type === 'instance') {
                    // Instance (Layout Editor Mode)
                    const inst = item.data;
                    const fp = footprints?.find(f => f.id === inst.footprintId);
                    if (fp) {
                        const ix = evaluate(inst.x, params);
                        const iy = evaluate(inst.y, params);
                        const iAngle = evaluate(inst.angle, params);
                        const iAngleRad = (iAngle * Math.PI) / 180;
                        const cosA = Math.cos(iAngleRad);
                        const sinA = Math.sin(iAngleRad);

                        // Shapes in Footprint (Reversed to match painter's order logic if needed, 
                        // though for union/subtraction order matters less if they don't overlap self)
                        [...fp.shapes].reverse().forEach(s => {
                            const sx = evaluate(s.x, params);
                            const sy = evaluate(s.y, params);
                            // Rotation transform
                            const finalX = ix + (sx * cosA - sy * sinA);
                            const finalY = iy + (sx * sinA + sy * cosA);
                            shapesToRender.push({ shape: s, tx: finalX, ty: finalY, rot: iAngleRad });
                        });
                    }
                }

                // Render each resolved shape
                return shapesToRender.map(({ shape, tx, ty, rot }, idx) => {
                    // Check assignment
                    if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return null;

                    const assignment = shape.assignedLayers[layer.id];
                    let depthVal = 0;
                    let radiusVal = 0;
                    
                    if (layer.type === "Cut") {
                        depthVal = thickness;
                    } else {
                        const valStr = typeof assignment === 'string' ? assignment : assignment.depth;
                        const radStr = typeof assignment === 'string' ? "0" : assignment.endmillRadius;
                        depthVal = evaluate(valStr, params);
                        radiusVal = evaluate(radStr, params);
                        depthVal = Math.max(0, Math.min(depthVal, thickness));
                    }

                    if (depthVal <= 0.001) return null;

                    const isPartial = depthVal < thickness - 0.001;
                    const hasRadius = radiusVal > 0.001;
                    const shouldRound = isPartial && hasRadius;

                    // Fill material height (from bottom up)
                    // If carving from Top: Fill is at bottom (Z=0 to Z=thick-depth)
                    // If carving from Bottom: Fill is at top (Z=depth to Z=thick)
                    // Note: extrudeGeometry starts at Z=0 and goes to Z=depth.
                    
                    let fillHeight = thickness - depthVal;
                    if (shouldRound) fillHeight += radiusVal;
                    
                    let fillZ = 0;
                    const shouldFill = fillHeight > 0.001;

                    // Align Fill Block
                    // "Bottom" carve means we keep material at Top (Z=thickness).
                    // "Top" carve means we keep material at Bottom (Z=0).
                    if (shouldFill) {
                        if (layer.carveSide === "Top") {
                            // Material sits at Z=0. Extrusion of fillHeight goes 0->fillHeight.
                            fillZ = 0; 
                        } else {
                            // Material sits at top. 
                            fillZ = thickness - fillHeight;
                        }
                    }

                    const key = `${item.type === 'instance' ? item.data.id : 'raw'}-${shape.id}-${idx}`;

                    // --- GENERATE GEOMETRY ARGS ---
                    
                    let cutNode: React.ReactNode = null;
                    let fillNode: React.ReactNode = null;
                    let filletNode: React.ReactNode = null;

                    if (shape.type === "circle") {
                        const d = evaluate(shape.diameter, params);
                        if (d > 0) {
                             // CYLINDER
                             // Cylinder geometry is Y-up centered.
                             // We want Z-up (aligned with thickness). Rotate X 90.
                             // And position at (tx, ty, throughZ).
                             cutNode = (
                                 <Subtraction position={[tx, ty, throughZ]} rotation={[Math.PI/2, 0, 0]}>
                                     <cylinderGeometry args={[d/2, d/2, throughHeight, 32]} />
                                 </Subtraction>
                             );
                             
                             if (shouldFill) {
                                 // Fill cylinder. Position z is center of fill segment.
                                 // Cylinder center is at height/2. 
                                 // So Z = fillZ + fillHeight/2
                                 const fz = fillZ + fillHeight/2;
                                 fillNode = (
                                     <Addition position={[tx, ty, fz]} rotation={[Math.PI/2, 0, 0]}>
                                         <cylinderGeometry args={[d/2 + CSG_EPSILON, d/2 + CSG_EPSILON, fillHeight, 32]} />
                                     </Addition>
                                 );
                             }

                             if (shouldRound) {
                                // Torus/Fillet logic is complex for cylinder holes, skipping advanced fillet for Cylinder
                                // unless we use a specialized revolve shape. 
                                // Standard Footprint3DView handled simple holes mostly.
                                // If needed, we could use an extruded annulus with fillet, but standard Cylinder is simpler.
                             }
                        }
                    } else if (shape.type === "rect") {
                        const w = evaluate(shape.width, params);
                        const h = evaluate(shape.height, params);
                        const sAngle = evaluate((shape as FootprintRect).angle, params);
                        const sAngleRad = (sAngle * Math.PI) / 180;
                        const totalAngle = rot + sAngleRad;
                        
                        const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                        const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));

                        // RECT / ROUNDED RECT
                        // Use Extruded Shape for consistency
                        let sGeom: THREE.Shape;
                        if (cr > 0.001) {
                            sGeom = createRoundedRectShape(w, h, cr);
                        } else {
                            sGeom = new THREE.Shape();
                            sGeom.moveTo(-w/2, -h/2);
                            sGeom.lineTo(w/2, -h/2);
                            sGeom.lineTo(w/2, h/2);
                            sGeom.lineTo(-w/2, h/2);
                            sGeom.lineTo(-w/2, -h/2);
                        }

                        // Cut: Extrude through
                        // Position Z: Center is throughZ? No, Extrusion starts at 0 local.
                        // We want to subtract the full thickness.
                        // Subtraction Z: -0.1.
                        cutNode = (
                            <Subtraction position={[tx, ty, -0.1]} rotation={[0, 0, totalAngle]}>
                                <extrudeGeometry args={[sGeom, { depth: throughHeight, bevelEnabled: false }]} />
                            </Subtraction>
                        );

                        if (shouldFill) {
                            // Expand slightly for overlap
                            let fillShape = sGeom;
                            if (cr > 0.001) fillShape = createRoundedRectShape(w + CSG_EPSILON, h + CSG_EPSILON, cr + CSG_EPSILON/2);
                            
                            // Fill starts at fillZ
                            fillNode = (
                                <Addition position={[tx, ty, fillZ]} rotation={[0, 0, totalAngle]}>
                                    <extrudeGeometry args={[fillShape, { depth: fillHeight, bevelEnabled: false }]} />
                                </Addition>
                            );
                        }

                        if (shouldRound) {
                             // Fillet geometry (Extrude with bevel)
                             // Position logic from Footprint3DView
                             // It placed the shape at the bottom of the cut.
                             // Cut Depth Z = (Top - depth). 
                             // If Carve Top: Cut Floor is at (Thick - depth).
                             // If Carve Bottom: Cut Floor is at (Depth).
                             
                             const bevelOpts = {
                                depth: throughHeight, // Cut through
                                bevelEnabled: true,
                                bevelThickness: radiusVal,
                                bevelSize: radiusVal,
                                bevelOffset: -radiusVal,
                                bevelSegments: 10
                             };
                             
                             let filletZ = 0;
                             if (layer.carveSide === "Top") {
                                 // Floor is at Z = Thickness - Depth.
                                 // We place geometry such that bevel starts there.
                                 filletZ = thickness - depthVal + radiusVal;
                             } else {
                                 // Floor is at Z = Depth.
                                 // We want to cut from Top down to Floor? No, "Bottom" carve means cutting from Z=0 upwards.
                                 // The filleted edge is at Z = Depth.
                                 // The geometry is extruded UP?
                                 // This is tricky. Simplified: Just skipping intricate fillet for Layout mode to ensure stability for now
                                 // unless requested. Footprint3DView had it.
                                 filletZ = -100; // Hide
                             }

                             if (layer.carveSide === "Top") {
                                filletNode = (
                                    <Subtraction position={[tx, ty, filletZ]} rotation={[0, 0, totalAngle]}>
                                        <extrudeGeometry args={[createRoundedRectShape(w, h, cr), bevelOpts]} />
                                    </Subtraction>
                                );
                             }
                        }

                    } else if (shape.type === "line") {
                        const sGeom = createLineShape(shape as FootprintLine, params);
                        if (sGeom) {
                             // Extruded Line
                             cutNode = (
                                <Subtraction position={[tx, ty, -0.1]} rotation={[0, 0, rot]}>
                                    <extrudeGeometry args={[sGeom, { depth: throughHeight, bevelEnabled: false }]} />
                                </Subtraction>
                            );

                            if (shouldFill) {
                                const thick = evaluate((shape as FootprintLine).thickness, params);
                                const fillGeom = createLineShape(shape as FootprintLine, params, thick + CSG_EPSILON);
                                if (fillGeom) {
                                    fillNode = (
                                        <Addition position={[tx, ty, fillZ]} rotation={[0, 0, rot]}>
                                            <extrudeGeometry args={[fillGeom, { depth: fillHeight, bevelEnabled: false }]} />
                                        </Addition>
                                    );
                                }
                            }
                        }
                    }

                    return (
                        <React.Fragment key={key}>
                            {cutNode}
                            {fillNode}
                            {filletNode}
                        </React.Fragment>
                    );
                });
            })}
        </Geometry>
    );

}, (prev, next) => {
    // Custom Memo comparator
    // We only re-render if layer props change or if items list changed length/content
    // Simplified shallow check for items
    if (prev.layer.id !== next.layer.id) return false;
    if (prev.thickness !== next.thickness) return false;
    if (prev.items.length !== next.items.length) return false;
    if (prev.baseShape !== next.baseShape) return false;
    // Check items equality (shallow reference check for data)
    for (let i = 0; i < prev.items.length; i++) {
        if (prev.items[i].data !== next.items[i].data) return false;
        if (prev.items[i].type !== next.items[i].type) return false;
    }
    // Check params deeply? Or just assume ref change
    if (prev.params !== next.params) return false;
    return true;
});


// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

const Unified3DView = forwardRef<Unified3DViewHandle, Props>(({ items, footprints, boardOutline, params, stackup, visibleLayers, is3DActive = true }, ref) => {
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

  // 1. Calculate Base Shape (Board Outline or Auto-Bounds)
  const baseShape = useMemo(() => {
    const shape = new THREE.Shape();
    
    if (boardOutline && boardOutline.points.length > 2) {
        // Use Board Outline
        const first = boardOutline.points[0];
        shape.moveTo(evaluate(first.x, params), evaluate(first.y, params));
        for (let i = 1; i < boardOutline.points.length; i++) {
            const p = boardOutline.points[i];
            shape.lineTo(evaluate(p.x, params), evaluate(p.y, params));
        }
        shape.closePath();
    } else {
        // Auto Bounds from Items (Footprint Editor Mode)
        const PADDING = 10;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        
        // Scan items to find bounds
        // Simplified scanning (does not account for rotation of instances perfectly, uses center + radius approx)
        if (items.length === 0) {
            minX = -50; maxX = 50; minY = -50; maxY = 50;
        } else {
            items.forEach(item => {
                let x = 0, y = 0, r = 0;
                if (item.type === 'shape') {
                    x = evaluate(item.data.x, params);
                    y = evaluate(item.data.y, params);
                    if (item.data.type === 'circle') r = evaluate(item.data.diameter, params)/2;
                    else if (item.data.type === 'rect') r = Math.max(evaluate(item.data.width, params), evaluate(item.data.height, params))/2;
                    else r = 10; // line approx
                } else {
                    x = evaluate(item.data.x, params);
                    y = evaluate(item.data.y, params);
                    r = 20; // Instance approx
                }
                if (x - r < minX) minX = x - r;
                if (x + r > maxX) maxX = x + r;
                if (y - r < minY) minY = y - r;
                if (y + r > maxY) maxY = y + r;
            });
            minX -= PADDING; maxX += PADDING;
            minY -= PADDING; maxY += PADDING;
        }

        shape.moveTo(minX, minY);
        shape.lineTo(maxX, minY);
        shape.lineTo(maxX, maxY);
        shape.lineTo(minX, maxY);
        shape.lineTo(minX, minY);
    }
    return shape;
  }, [boardOutline, items, params]);

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
            let currentHeight = 0; // World Y
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluate(layer.thicknessExpression, params);
              const isVisible = visibleLayers ? visibleLayers[layer.id] !== false : true;

              // RENDER LAYER
              // We rotate the mesh X -90 so that:
              // Local X -> World X
              // Local Y -> World -Z (Depth)
              // Local Z -> World Y (Height)
              // We position it at [0, currentHeight, 0] in World Space.
              
              const node = isVisible ? (
                <mesh 
                    key={layer.id}
                    ref={(el) => { if (el) meshRefs.current[layer.id] = el; else delete meshRefs.current[layer.id]; }}
                    rotation={[-Math.PI / 2, 0, 0]}
                    position={[0, currentHeight, 0]}
                >
                    <CSGLayerGeometry 
                        layer={layer}
                        items={items}
                        footprints={footprints}
                        params={params}
                        thickness={thickness}
                        baseShape={baseShape}
                    />
                    <meshStandardMaterial color={layer.color} transparent opacity={0.9} />
                </mesh>
              ) : null;

              currentHeight += thickness;
              return node;
            });
          })()}
        </group>

        <Grid infiniteGrid fadeDistance={200} sectionColor="#444" cellColor="#222" position={[0, 0, 0]} />
        <OrbitControls makeDefault ref={controlsRef} />
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={['#9d4b4b', '#2f7f4f', '#3b5b9d']} labelColor="white" />
        </GizmoHelper>
      </Canvas>
    </div>
  );
});

// Helper to generate Binary STL
function geometryToSTL(geometry: THREE.BufferGeometry): Uint8Array {
    const geom = geometry.toNonIndexed();
    const pos = geom.getAttribute('position');
    const count = pos.count; 
    const triangleCount = Math.floor(count / 3);
    const bufferLen = 80 + 4 + (50 * triangleCount);
    const buffer = new ArrayBuffer(bufferLen);
    const view = new DataView(buffer);
    view.setUint32(80, triangleCount, true);

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
        const i3 = i * 3;
        const ax = pos.getX(i3), ay = pos.getY(i3), az = pos.getZ(i3);
        const bx = pos.getX(i3+1), by = pos.getY(i3+1), bz = pos.getZ(i3+1);
        const cx = pos.getX(i3+2), cy = pos.getY(i3+2), cz = pos.getZ(i3+2);

        const ux = bx-ax, uy = by-ay, uz = bz-az;
        const vx = cx-ax, vy = cy-ay, vz = cz-az;
        let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (len > 0) { nx /= len; ny /= len; nz /= len; }

        view.setFloat32(offset, nx, true);
        view.setFloat32(offset+4, ny, true);
        view.setFloat32(offset+8, nz, true);
        offset += 12;

        view.setFloat32(offset, ax, true);
        view.setFloat32(offset+4, ay, true);
        view.setFloat32(offset+8, az, true);
        offset += 12;

        view.setFloat32(offset, bx, true);
        view.setFloat32(offset+4, by, true);
        view.setFloat32(offset+8, bz, true);
        offset += 12;

        view.setFloat32(offset, cx, true);
        view.setFloat32(offset+4, cy, true);
        view.setFloat32(offset+8, cz, true);
        offset += 12;
        offset += 2;
    }
    return new Uint8Array(buffer);
}

export default Unified3DView;