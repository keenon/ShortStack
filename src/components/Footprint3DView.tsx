// src/components/Footprint3DView.tsx
import React, { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, Point, FootprintReference } from "../types";
import { mergeVertices, mergeBufferGeometries } from "three-stdlib";
import Module from "manifold-3d";
// @ts-ignore
import wasmUrl from "manifold-3d/manifold.wasm?url";

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
// MANIFOLD UTILS
// ------------------------------------------------------------------

function analyzeGeometry(geometry: THREE.BufferGeometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  if (!pos) return;

  console.group("Mesh Analysis Detailed");
  
  const vCount = pos.count;
  const iCount = index ? index.count : vCount;
  const triCount = iCount / 3;
  console.log(`Vertices: ${vCount}, Triangles: ${triCount}`);

  // 1. NaN Check
  let hasNaN = false;
  // @ts-ignore
  const arr = pos.array;
  for(let i=0; i<pos.count * 3; i++) {
      if (isNaN(arr[i])) {
          hasNaN = true;
          break;
      }
  }
  if (hasNaN) console.error("FATAL: Mesh contains NaN positions.");

  // 2. Degenerate Triangles (Area) & Topology Build
  let zeroArea = 0;
  let smallArea = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  
  // Track directed edges to check winding: "u_v" means edge u -> v
  const directedEdges = new Map<string, number>();
  // Track vertex-to-face adjacency for singularity check
  const vertexFaces: number[][] = Array.from({ length: vCount }, () => []);

  for (let i = 0; i < triCount; i++) {
      const i0 = index ? index.getX(i*3) : i*3;
      const i1 = index ? index.getX(i*3+1) : i*3+1;
      const i2 = index ? index.getX(i*3+2) : i*3+2;

      // Bounds check
      if (i0 >= vCount || i1 >= vCount || i2 >= vCount) {
         console.error(`Index out of bounds at tri ${i}: ${i0}, ${i1}, ${i2} (max ${vCount-1})`);
         continue;
      }

      // Area Check
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const areaSq = new THREE.Vector3().crossVectors(ab, ac).lengthSq();
      
      if (areaSq <= 1e-12) zeroArea++;
      else if (areaSq <= 1e-6) smallArea++;

      // Register Directed Edges
      const addEdge = (u: number, v: number) => {
          const key = `${u}_${v}`;
          directedEdges.set(key, (directedEdges.get(key) || 0) + 1);
      };
      addEdge(i0, i1);
      addEdge(i1, i2);
      addEdge(i2, i0);

      // Register Vertex Adjacency
      vertexFaces[i0].push(i);
      vertexFaces[i1].push(i);
      vertexFaces[i2].push(i);
  }

  if (zeroArea > 0) console.error(`Found ${zeroArea} degenerate triangles (zero area).`);
  if (smallArea > 0) console.warn(`Found ${smallArea} very small triangles (potential precision issues).`);

  // 3. Topology Analysis (Manifoldness & Winding)
  let boundaryEdges = 0;
  let reversedEdges = 0;    // Edges where neighbors traverse in same direction
  let nonManifoldEdges = 0; // Edges shared by > 2 faces

  // Consolidate directed edges into undirected edges to check consistency
  const undirectedMap = new Map<string, { fwd: number, rev: number }>();
  
  for (const [key, count] of directedEdges.entries()) {
      const [u, v] = key.split('_').map(Number);
      const undirKey = u < v ? `${u}_${v}` : `${v}_${u}`;
      
      if (!undirectedMap.has(undirKey)) undirectedMap.set(undirKey, { fwd: 0, rev: 0 });
      const entry = undirectedMap.get(undirKey)!;
      
      if (u < v) entry.fwd += count;
      else entry.rev += count;
  }

  for (const { fwd, rev } of undirectedMap.values()) {
      const total = fwd + rev;
      if (total === 1) {
          boundaryEdges++;
      } else if (total > 2) {
          nonManifoldEdges++;
      } else if (total === 2) {
          // For a closed oriented manifold, one face must be fwd (u->v) and one rev (v->u)
          // relative to the sorted key.
          if (fwd !== 1 || rev !== 1) {
              reversedEdges++;
          }
      }
  }

  if (boundaryEdges > 0) console.error(`Mesh is open (not watertight): ${boundaryEdges} boundary edges.`);
  if (nonManifoldEdges > 0) console.error(`Mesh is non-manifold: ${nonManifoldEdges} edges shared by >2 faces.`);
  if (reversedEdges > 0) console.error(`Mesh has inconsistent winding: ${reversedEdges} edges have mismatched normals (flipped faces).`);

  // 4. Singular Vertex Check (Bowtie / Hourglass)
  // A vertex is singular if its incident faces do not form a single connected component
  // (i.e. the vertex connects two otherwise disjoint volumes).
  let singularVertices = 0;
  // Limit check to reasonable size to prevent UI freeze on huge meshes
  if (vCount < 20000) {
      for(let v = 0; v < vCount; v++) {
          const faces = vertexFaces[v];
          if (faces.length === 0) continue; // Isolated vertex
          
          const components = countConnectedComponentsAtVertex(v, faces, index);
          if (components > 1) {
              singularVertices++;
          }
      }
  }
  
  if (singularVertices > 0) console.error(`Found ${singularVertices} singular vertices (bowtie/hourglass). This causes "Not Manifold".`);

  if (boundaryEdges === 0 && nonManifoldEdges === 0 && reversedEdges === 0 && singularVertices === 0 && zeroArea === 0 && !hasNaN) {
      console.log("Topology checks passed. The issue is likely Self-Intersection (geometry overlaps without nodes).");
  }

  console.groupEnd();
}

// Helper to count connected components of faces around a vertex v
function countConnectedComponentsAtVertex(vIdx: number, faces: number[], index: THREE.BufferAttribute | null): number {
    if (faces.length <= 1) return 1;

    // We define two faces as connected if they share an edge INCIDENT to v.
    // Faces are triangles. If they share an edge connected to v, they share v AND one other vertex.
    
    // 1. Get the "other" vertices for each face
    const faceOthers = new Map<number, number[]>();
    for(const f of faces) {
        const i0 = index ? index.getX(f*3) : f*3;
        const i1 = index ? index.getX(f*3+1) : f*3+1;
        const i2 = index ? index.getX(f*3+2) : f*3+2;
        // Filter out vIdx
        const others = [i0, i1, i2].filter(x => x !== vIdx);
        // Should be 2 others. If <2, it's degenerate (handled elsewhere).
        faceOthers.set(f, others);
    }

    // 2. BFS / Union-Find
    const visited = new Set<number>();
    let components = 0;

    for(const f of faces) {
        if (visited.has(f)) continue;
        components++;
        
        const queue = [f];
        visited.add(f);
        
        while(queue.length > 0) {
            const curr = queue.pop()!;
            const others = faceOthers.get(curr);
            if (!others) continue;

            // Find neighbors in the 'link' of v
            for(const neighbor of faces) {
                if (visited.has(neighbor)) continue;
                const neighborOthers = faceOthers.get(neighbor);
                if (!neighborOthers) continue;

                // Check if they share any vertex in 'others'
                // If they share a vertex u in 'others', then they share edge (v, u).
                const share = others.some(o => neighborOthers.includes(o));
                if (share) {
                    visited.add(neighbor);
                    queue.push(neighbor);
                }
            }
        }
    }
    return components;
}

function shapeToManifold(wasm: any, shape: THREE.Shape, resolution = 32) {
    const points = shape.getPoints(resolution).map(p => [p.x, p.y]);
    // Handle holes
    const holes = shape.holes.map(h => h.getPoints(resolution).map(p => [p.x, p.y]));
    // Manifold expects [contour, hole, hole, ...] or [contour]
    const contours = [points, ...holes];
    // Use string literal "EvenOdd"
    return new wasm.CrossSection(contours, "EvenOdd");
}

function geometryToManifold(geometry: THREE.BufferGeometry, Manifold: any) {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!pos) return null;

    // Convert attributes to typed arrays
    const vertProperties = new Float32Array(pos.array);
    let triVerts: Uint32Array;

    if (index) {
        triVerts = new Uint32Array(index.array);
    } else {
        // If unindexed, generate sequential indices
        triVerts = new Uint32Array(pos.count);
        for(let i=0; i<pos.count; i++) triVerts[i] = i;
    }

    try {
        // Construct manifold from mesh data
        return new Manifold({ vertProperties, triVerts });
    } catch(e: any) {
        console.warn("geometryToManifold conversion failed", e);
        if (e && e.code) console.warn("Error Code:", e.code);
        // Automatically analyze to see why it failed
        analyzeGeometry(geometry);
        return null;
    }
}

/**
 * Generates a valid manifold mesh for a shape with a ball-nosed (filleted) bottom.
 * Replaces the brittle THREE.ExtrudeGeometry bevel logic.
 */
function generateProceduralFillet(
    manifoldModule: any,
    shape: FootprintShape, 
    params: Parameter[],
    depth: number, 
    filletRadius: number,
    resolution = 32
) {
    let minDimension = Infinity;
    
    // Generates a contour at a specific inward offset
    const getContour = (offset: number): THREE.Vector2[] => {
        let result: THREE.Vector2[] = [];
        
        if (shape.type === "circle") {
            const d = evaluate((shape as any).diameter, params);
            minDimension = d;
            const r = Math.max(0.001, d/2 - offset); // Prevent zero radius
            const segments = resolution;
            for(let i=0; i<segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                result.push(new THREE.Vector2(Math.cos(theta) * r, Math.sin(theta) * r));
            }
        } 
        else if (shape.type === "rect") {
            const wRaw = evaluate((shape as FootprintRect).width, params);
            const hRaw = evaluate((shape as FootprintRect).height, params);
            minDimension = Math.min(wRaw, hRaw);
            
            // Ensure width/height don't collapse to 0 or negative
            const w = Math.max(0.001, wRaw - offset * 2);
            const h = Math.max(0.001, hRaw - offset * 2);
            const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
            
            const halfW = w / 2;
            const halfH = h / 2;
            
            // If the requested radius is less than offset, the effective radius is 0
            // But we keep a tiny value to avoid degeneracies if needed, 
            // or simply use the corner vertex.
            let cr = Math.max(0, crRaw - offset);
            
            // Clamp to size
            const limit = Math.min(halfW, halfH);
            if (cr > limit) cr = limit;
            
            // Always use consistent segments, do not optimize for sharpness, to ensure topology matches
            const segCorner = 6; 
            
            const quadrants = [
                { x: halfW - cr, y: halfH - cr, startAng: 0 },         
                { x: -halfW + cr, y: halfH - cr, startAng: Math.PI/2 },
                { x: -halfW + cr, y: -halfH + cr, startAng: Math.PI }, 
                { x: halfW - cr, y: -halfH + cr, startAng: 1.5*Math.PI}
            ];

            quadrants.forEach(q => {
                for(let i=0; i<=segCorner; i++) {
                    const ang = q.startAng + (i/segCorner) * (Math.PI/2);
                    const vx = q.x + Math.cos(ang) * cr;
                    const vy = q.y + Math.sin(ang) * cr;
                    result.push(new THREE.Vector2(vx, vy));
                }
            });
        }
        else if (shape.type === "line") {
            const t = evaluate((shape as FootprintLine).thickness, params);
            minDimension = t;
            // Prevent thickness collapse
            const effectiveT = Math.max(0.001, t - offset * 2);
            
            const tempShape = createLineShape(shape as FootprintLine, params, effectiveT);
            if (tempShape) {
                // Use getPoints (based on division) not getSpacedPoints (based on length)
                // This keeps topology consistent even if length shrinks
                const div = Math.max(4, Math.floor(resolution / 2));
                const pts = tempShape.getPoints(div);
                // getPoints closes the loop so last == first usually, or we can check
                if (pts.length > 0 && pts[0].distanceTo(pts[pts.length-1]) < 0.001) {
                    pts.pop();
                }

                // Ensure consistent winding (CCW) so walls have correct normals
                // isClockWise returns true for negative area (CW)
                // We want CCW (matching rect/circle), so if it IS Clockwise, reverse it.
                if (THREE.ShapeUtils.isClockWise(pts)) {
                    pts.reverse();
                }

                pts.forEach(p => result.push(p));
            }
        }
        
        // IMPORTANT: Do NOT remove duplicate points here based on distance.
        // Doing so breaks index alignment between layers if one layer shrinks and points merge.
        // We accept potential degenerate triangles (zero area) to maintain index topology.

        return result;
    };

    // Pre-calc dimension to clamp radius
    const baseProfile = getContour(0); 
    const vertsPerLayer = baseProfile.length;
    if (vertsPerLayer < 3) return null;

    const safeR = Math.min(filletRadius, minDimension / 2 - 0.01, depth);
    if (safeR <= 0.001) return null;

    const layers: { z: number, offset: number }[] = [];
    layers.push({ z: 0, offset: 0 });

    const wallBottomZ = -(depth - safeR);
    // Add the start of the fillet curve
    if (Math.abs(wallBottomZ) > 0.001) {
        layers.push({ z: wallBottomZ, offset: 0 });
    }

    const filletSteps = 6; 
    for(let i=1; i<=filletSteps; i++) {
        const theta = (i / filletSteps) * (Math.PI / 2);
        const z = wallBottomZ - Math.sin(theta) * safeR;
        const off = (1 - Math.cos(theta)) * safeR;
        // Clamp offset slightly to prevent total collapse at the very bottom
        const maxOffset = minDimension / 2 - 0.001; 
        layers.push({ z, offset: Math.min(off, maxOffset) });
    }

    const vertices: number[] = [];
    const indices: number[] = [];

    layers.forEach(layer => {
        const points = getContour(layer.offset);
        // Topology protection: If a layer collapses (rare due to clamps), we can't build a manifold
        if (points.length !== vertsPerLayer) {
             console.error(`Topology Mismatch: Layer has ${points.length} verts, expected ${vertsPerLayer}. This causes index errors.`);
        }
        
        points.forEach(p => {
            // Map 2D (x,y) to 3D (x, z, -y)
            vertices.push(p.x, layer.z, -p.y); 
        });
    });

    const getIdx = (layerIdx: number, ptIdx: number) => {
        return layerIdx * vertsPerLayer + (ptIdx % vertsPerLayer);
    };

    // A. Top Cap
    // Normal UP (+Y)
    // 3D mapping makes the CCW contour appear CW in X-Z plane (looking down).
    // However, the cross product of (0, 1, 2) yields a Normal UP in this coordinate space.
    const topFaces = THREE.ShapeUtils.triangulateShape(baseProfile, []);
    topFaces.forEach(face => {
        indices.push(getIdx(0, face[0]), getIdx(0, face[1]), getIdx(0, face[2]));
    });

    // B. Walls
    for(let l=0; l<layers.length-1; l++) {
        for(let i=0; i<vertsPerLayer; i++) {
            const curr = i;
            const next = (i+1) % vertsPerLayer;
            
            const v1 = getIdx(l, curr);      // Top Current
            const v2 = getIdx(l+1, curr);    // Bot Current
            const v3 = getIdx(l+1, next);    // Bot Next
            const v4 = getIdx(l, next);      // Top Next

            // Standard CCW outward facing wall
            indices.push(v1, v2, v4); 
            indices.push(v2, v3, v4);
        }
    }

    // C. Bottom Cap
    // Normal DOWN (-Y)
    // We want the normal to point Down.
    // (0, 1, 2) points Up, so we swap to (0, 2, 1) to point Down.
    const lastL = layers.length - 1;
    const botProfile = getContour(layers[lastL].offset);
    if (botProfile.length === vertsPerLayer) {
        const botFaces = THREE.ShapeUtils.triangulateShape(botProfile, []);
        botFaces.forEach(face => {
            indices.push(getIdx(lastL, face[0]), getIdx(lastL, face[2]), getIdx(lastL, face[1]));
        });
    }

    const vertProperties = new Float32Array(vertices);
    const triVerts = new Uint32Array(indices);

    try {
        const manifold = new manifoldModule.Manifold({ vertProperties, triVerts });
        return { manifold, vertProperties, triVerts };
    } catch (e) {
        console.error("Procedural Fillet Failed", e);
        analyzeGeometry(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(vertProperties, 3)).setIndex(new THREE.BufferAttribute(triVerts, 1)));
        // Return raw geometry to allow visualization of failed mesh
        return { manifold: null, vertProperties, triVerts };
    }
}

// ------------------------------------------------------------------
// COMPONENTS
// ------------------------------------------------------------------

/**
 * Renders a single layer as a solid block with cuts subtracted (using manifold-3d).
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
  registerMesh,
  manifoldModule
}: {
  layer: StackupLayer;
  footprint: Footprint;
  allFootprints: Footprint[];
  params: Parameter[];
  bottomZ: number;
  thickness: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  boardShape: THREE.Shape | null;
  registerMesh?: (id: string, mesh: THREE.Mesh | null) => void;
  manifoldModule: any;
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

  // Compute Geometry using Manifold
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!manifoldModule || thickness <= 0.0001) return;
    setHasError(false);

    const garbage: any[] = [];
    const collect = <T extends unknown>(obj: T): T => {
        if (obj && typeof (obj as any).delete === 'function') {
            garbage.push(obj);
        }
        return obj;
    };

    try {
        const { Manifold } = manifoldModule;
        const CSG_EPSILON = 0.01;

        // 1. Create Base
        let base;
        if (boardShape) {
            const cs = collect(shapeToManifold(manifoldModule, boardShape));
            // Extrude along Z, then rotate to match Y-up convention if needed, 
            // but here we just produce the volume relative to center.
            const ext = collect(cs.extrude(thickness));
            const rotated = collect(ext.rotate([-90, 0, 0]));
            base = collect(rotated.translate([0, -thickness/2, 0]));
        } else {
            // Box
            base = collect(Manifold.cube([width, thickness, depth], true));
        }

        const throughCuts: any[] = [];
        const fills: any[] = [];
        const fillets: any[] = [];
        const failedFillets: THREE.BufferGeometry[] = [];

        flatShapes.forEach((item) => {
            const shape = item.shape;
            if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return;

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

            // SAFETY: Clamp radius to avoid self-intersection inside ExtrudeGeometry
            // This is a heuristic. For arbitrary shapes, it is hard to know the perfect limit.
            let safeRadius = endmillRadius;
            if (shape.type === "circle") {
                 const d = evaluate((shape as any).diameter, params);
                 safeRadius = Math.min(safeRadius, d/2 - 0.01);
            } else if (shape.type === "rect") {
                 const w = evaluate((shape as FootprintRect).width, params);
                 const h = evaluate((shape as FootprintRect).height, params);
                 safeRadius = Math.min(safeRadius, Math.min(w, h)/2 - 0.01);
            } else if (shape.type === "line") {
                 const t = evaluate((shape as FootprintLine).thickness, params);
                 safeRadius = Math.min(safeRadius, t/2 - 0.01);
            }
            if (safeRadius < 0) safeRadius = 0;

            const isPartialCut = actualDepth < thickness - 0.001;
            const hasRadius = safeRadius > 0.001;
            const shouldRound = isPartialCut && hasRadius;

            // 2. Vertical Logic
            const throughHeight = thickness + 0.2; 
            const throughY = 0; // Center

            // If rounding is enabled, the "fill" part needs to account for the fillet
            let fillHeight = thickness - actualDepth;
            if (shouldRound) fillHeight += safeRadius;

            let fillY = 0;
            const shouldFill = fillHeight > 0.001;
            if (shouldFill) {
                fillY = layer.carveSide === "Top" 
                    ? (-thickness / 2 + fillHeight / 2) 
                    : (thickness / 2 - fillHeight / 2);
            }

            // 3. Position Logic
            const localX = item.x - centerX;
            const localZ = centerZ - item.y;
            const globalRot = item.rotation; // Degrees

            // 4. Create Shape Functions
            const createTool = (extraOffset = 0, height: number) => {
                let tool = null;

                if (shape.type === "circle") {
                    const d = evaluate((shape as any).diameter, params);
                    if (d > 0) {
                        const r = d/2 + extraOffset;
                        tool = collect(Manifold.cylinder(height, r, r, 32, true));
                        tool = collect(tool.rotate([90, 0, 0])); 
                    }
                } else if (shape.type === "rect") {
                    const w = evaluate((shape as FootprintRect).width, params);
                    const h = evaluate((shape as FootprintRect).height, params);
                    const crRaw = evaluate((shape as FootprintRect).cornerRadius, params);
                    const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                    
                    if (w > 0 && h > 0) {
                        const rw = w + extraOffset * 2;
                        const rh = h + extraOffset * 2;
                        const rcr = cr + extraOffset;

                        if (rcr > 0.001) {
                            const s = createRoundedRectShape(rw, rh, rcr);
                            const cs = collect(shapeToManifold(manifoldModule, s));
                            const csRot = collect(cs.rotate(globalRot));
                            const ext = collect(csRot.extrude(height));
                            const centered = collect(ext.translate([0, 0, -height/2]));
                            tool = collect(centered.rotate([-90, 0, 0]));
                        } else {
                            tool = collect(Manifold.cube([rw, height, rh], true));
                            tool = collect(tool.rotate([0, globalRot, 0]));
                        }
                    }
                } else if (shape.type === "line") {
                    const t = evaluate((shape as FootprintLine).thickness, params);
                    const validT = (t > 0 ? t : 0.01) + extraOffset * 2;
                    const s = createLineShape(shape as FootprintLine, params, validT);
                    if (s) {
                        const cs = collect(shapeToManifold(manifoldModule, s));
                        const csRot = collect(cs.rotate(globalRot));
                        const ext = collect(csRot.extrude(height));
                        const centered = collect(ext.translate([0, 0, -height/2]));
                        tool = collect(centered.rotate([-90, 0, 0]));
                    }
                }

                return tool;
            };

            // A. THROUGH CUT
            const toolCut = createTool(0, throughHeight);
            if (toolCut) {
                const moved = collect(toolCut.translate([localX, throughY, localZ]));
                throughCuts.push(moved);
            }

            // B. FILL
            if (shouldFill) {
                // Use epsilon for fill to ensure overlap
                const toolFill = createTool(CSG_EPSILON, fillHeight);
                if (toolFill) {
                    const moved = collect(toolFill.translate([localX, fillY, localZ]));
                    fills.push(moved);
                }
            }

            // C. ROUNDED CUT (FILLET)
            if (shouldRound) {
                const result = generateProceduralFillet(
                    manifoldModule, 
                    shape, 
                    params, 
                    actualDepth, // Tool depth equals cut depth
                    safeRadius,
                    32
                );

                if (result) {
                    if (result.manifold) {
                        const toolFillet = collect(result.manifold);
                        const r = collect(toolFillet.rotate([0, globalRot, 0]));
    
                        if (layer.carveSide === "Top") {
                            // Top carve: Top of tool matches top of layer
                            const topY = thickness / 2;
                            const final = collect(r.translate([localX, topY, localZ]));
                            fillets.push(final);
                        } else {
                            // Bottom carve: Drill enters from bottom.
                            // Top of tool (entry point) matches bottom of layer (-thickness/2).
                            // Rotate 180X: (x,y,z) -> (x,-y,-z). Top(0) -> 0. Tip(-Depth) -> +Depth.
                            // Translate Y to -thickness/2.
                            const flipped = collect(r.rotate([180, 0, 0]));
                            const final = collect(flipped.translate([localX, -thickness/2, localZ]));
                            fillets.push(final);
                        }
                    } else if (result.vertProperties && result.triVerts) {
                        // Failed to convert to manifold. Store for display.
                        const geom = new THREE.BufferGeometry();
                        geom.setAttribute('position', new THREE.BufferAttribute(result.vertProperties, 3));
                        geom.setIndex(new THREE.BufferAttribute(result.triVerts, 1));
                        
                        // Apply transforms manually to match where it would have been
                        geom.rotateY(globalRot * (Math.PI / 180));
                        
                        if (layer.carveSide === "Top") {
                            geom.translate(localX, thickness / 2, localZ);
                        } else {
                            geom.rotateX(Math.PI);
                            geom.translate(localX, -thickness / 2, localZ);
                        }
                        
                        failedFillets.push(geom);
                    }
                }
            }
        });

        if (failedFillets.length > 0) {
            // Merge all failed fillets into one geometry for display
            const merged = mergeBufferGeometries(failedFillets);
            setGeometry(merged);
            setHasError(true);
            return;
        }

        // 5. Apply Booleans
        if (throughCuts.length > 0) {
            const unionCuts = collect(Manifold.compose(throughCuts));
            const diff = collect(Manifold.difference(base, unionCuts));
            base = diff;
        }

        if (fills.length > 0) {
            const unionFills = collect(Manifold.compose(fills));
            const added = collect(Manifold.union(base, unionFills));
            base = added;
        }

        if (fillets.length > 0) {
            const unionFillets = collect(Manifold.compose(fillets));
            const diff = collect(Manifold.difference(base, unionFillets));
            base = diff;
        }

        // 6. Convert to Mesh
        const mesh = base.getMesh();
        const bufferGeom = new THREE.BufferGeometry();
        
        if (mesh.vertProperties && mesh.triVerts) {
             bufferGeom.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3));
             bufferGeom.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
             setGeometry(bufferGeom);
        } else {
             setGeometry(null);
        }

    } catch (e) {
        console.error("Manifold Error", e);
    } finally {
        garbage.forEach(g => {
            try { g.delete(); } catch(e) {}
        });
    }

  }, [manifoldModule, thickness, width, depth, layer, flatShapes, params, boardShape, centerX, centerZ, bounds]);

  return (
    <mesh 
        position={[centerX, centerY, centerZ]}
        ref={(ref) => registerMesh && registerMesh(layer.id, ref)}
        geometry={geometry || undefined}
    >
      <meshStandardMaterial color={hasError ? "#ff0000" : layer.color} transparent opacity={0.9} flatShading />
    </mesh>
  );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, visibleLayers, is3DActive }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});
  
  // Initialize Manifold
  const [manifoldModule, setManifoldModule] = useState<any>(null);
  
  useEffect(() => {
    // Load WASM
    // We explicitly locate the file using Vite's imported URL to prevent 404/MIME errors
    Module({
        locateFile: ((path: string) => {
            if (path.endsWith('.wasm')) {
                return wasmUrl;
            }
            return path;
        }) as any
    }).then((m) => {
        m.setup();
        setManifoldModule(m);
    });
  }, []);

useImperativeHandle(ref, () => ({
    resetCamera: () => {
        if (controlsRef.current) {
            controlsRef.current.reset();
        }
    },
    getLayerSTL: (layerId: string) => {
        const mesh = meshRefs.current[layerId];
        if (!mesh || !mesh.geometry) return null;

        // 1. Clone the geometry
        let geom = mesh.geometry.clone();

        // 2. Apply transform
        mesh.updateMatrixWorld();
        geom.applyMatrix4(mesh.matrixWorld);

        // 3. Clean
        geom.deleteAttribute('uv');
        geom.deleteAttribute('normal');

        // 4. Merge
        try {
            geom = mergeVertices(geom, 1e-4);
        } catch (e) {
            console.warn("Vertex merge failed", e);
        }

        geom.computeVertexNormals();
        const data = geometryToSTL(geom);
        geom.dispose();
        
        return data;
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
                  manifoldModule={manifoldModule}
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