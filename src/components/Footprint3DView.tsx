// src/components/Footprint3DView.tsx
// import React, { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from "react";
import { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader } from "three-stdlib";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, Point, FootprintReference, FootprintMesh } from "../types";
import { mergeVertices, mergeBufferGeometries } from "three-stdlib";
import { evaluateExpression, resolvePoint } from "../utils/footprintUtils";
import Module from "manifold-3d";
// @ts-ignore
import wasmUrl from "manifold-3d/manifold.wasm?url";

// OCCT Imports
// @ts-ignore
import initOCCT from "occt-import-js";
// @ts-ignore
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // Required for recursion
  params: Parameter[];
  stackup: StackupLayer[];
  visibleLayers?: Record<string, boolean>;
  is3DActive: boolean;
  // NEW: Selection Props
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export interface Footprint3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

function evaluate(expression: string, params: Parameter[]): number {
  return evaluateExpression(expression, params);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// ------------------------------------------------------------------
// GEOMETRY GENERATION
// ------------------------------------------------------------------

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
        // Note to the future: These curve commands are tricky, and LLMs often swap the ordering around.
        // Please double-check if modifying, especially around the quadraticCurveTo control points.
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

function getLineOutlinePoints(
    shape: FootprintLine, 
    params: Parameter[], 
    thickness: number, 
    resolution: number,
    contextFp: Footprint,
    allFootprints: Footprint[]
): THREE.Vector2[] {
    const points = shape.points;
    if (points.length < 2) return [];

    const halfThick = thickness / 2;
    const pathPoints: THREE.Vector2[] = [];

    // 1. Generate Spine (Centerline)
    for (let i = 0; i < points.length - 1; i++) {
        const currRaw = points[i];
        const nextRaw = points[i+1];
        
        const curr = resolvePoint(currRaw, contextFp, allFootprints, params);
        const next = resolvePoint(nextRaw, contextFp, allFootprints, params);

        const x1 = curr.x;
        const y1 = curr.y;
        const x2 = next.x;
        const y2 = next.y;

        const hasCurve = (curr.handleOut || next.handleIn);

        if (hasCurve) {
            const cp1x = x1 + (curr.handleOut ? curr.handleOut.x : 0);
            const cp1y = y1 + (curr.handleOut ? curr.handleOut.y : 0);
            const cp2x = x2 + (next.handleIn ? next.handleIn.x : 0);
            const cp2y = y2 + (next.handleIn ? next.handleIn.y : 0);

            const curve = new THREE.CubicBezierCurve(
                new THREE.Vector2(x1, y1),
                new THREE.Vector2(cp1x, cp1y),
                new THREE.Vector2(cp2x, cp2y),
                new THREE.Vector2(x2, y2)
            );

            // Fixed divisions for spine to ensure stability
            const divisions = 24; 
            const sp = curve.getPoints(divisions);
            
            // Remove first point if it duplicates the last point of previous segment
            if (pathPoints.length > 0) sp.shift();
            sp.forEach(p => pathPoints.push(p));
        } else {
            if (pathPoints.length === 0) pathPoints.push(new THREE.Vector2(x1, y1));
            pathPoints.push(new THREE.Vector2(x2, y2));
        }
    }

    if (pathPoints.length < 2) return [];

    // 2. Calculate Offsets (Left/Right rails)
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

    // 3. Assemble Contour (CCW Winding)
    const contour: THREE.Vector2[] = [];
    const arcDivisions = Math.max(4, Math.floor(resolution / 2));

    // A. Left Side (Forward)
    for (let i = 0; i < leftPts.length; i++) {
        contour.push(leftPts[i]);
    }

    // B. End Cap (Semi-circle)
    {
        const lastIdx = pathPoints.length - 1;
        const pLast = pathPoints[lastIdx];
        const vLast = new THREE.Vector2().subVectors(leftPts[lastIdx], pLast);
        const startAng = Math.atan2(vLast.y, vLast.x);
        // Arc from Left Rail end to Right Rail end
        for (let i = 1; i <= arcDivisions; i++) {
            const t = i / arcDivisions;
            const ang = startAng - t * Math.PI; // 180 degree turn
            contour.push(new THREE.Vector2(
                pLast.x + Math.cos(ang) * halfThick,
                pLast.y + Math.sin(ang) * halfThick
            ));
        }
    }

    // C. Right Side (Reverse)
    for (let i = rightPts.length - 1; i >= 0; i--) {
        contour.push(rightPts[i]);
    }

    // D. Start Cap (Semi-circle)
    {
        const pFirst = pathPoints[0];
        const vFirst = new THREE.Vector2().subVectors(rightPts[0], pFirst);
        const startAng = Math.atan2(vFirst.y, vFirst.x);
        
        // Arc from Right Rail start to Left Rail start
        // We stop 1 step short of the end because the loop wraps back to contour[0]
        for (let i = 1; i < arcDivisions; i++) {
            const t = i / arcDivisions;
            const ang = startAng - t * Math.PI;
            contour.push(new THREE.Vector2(
                pFirst.x + Math.cos(ang) * halfThick,
                pFirst.y + Math.sin(ang) * halfThick
            ));
        }
    }

    return contour;
}

function createLineShape(
    shape: FootprintLine, 
    params: Parameter[], 
    contextFp: Footprint,
    allFootprints: Footprint[],
    thicknessOverride?: number
): THREE.Shape | null {
  // Use the deterministic point generator for the flat cut shape as well
  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;

  const pts = getLineOutlinePoints(shape, params, thickVal, 12, contextFp, allFootprints);
  if (pts.length < 3) return null;
  
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  for(let i=1; i<pts.length; i++) {
      s.lineTo(pts[i].x, pts[i].y);
  }
  s.closePath();
  return s;
}

function createBoardShape(points: Point[], params: Parameter[], rootFootprint: Footprint, allFootprints: Footprint[]): THREE.Shape | null {
    if (!points || points.length < 3) return null;
    const shape = new THREE.Shape();

    const p0Raw = points[0];
    const p0 = resolvePoint(p0Raw, rootFootprint, allFootprints, params);
    shape.moveTo(p0.x, p0.y);
    
    for(let i = 0; i < points.length; i++) {
        const currRaw = points[i];
        const nextRaw = points[(i + 1) % points.length];

        const curr = resolvePoint(currRaw, rootFootprint, allFootprints, params);
        const next = resolvePoint(nextRaw, rootFootprint, allFootprints, params);
        
        const x2 = next.x;
        const y2 = next.y;

        if (curr.handleOut || next.handleIn) {
            const x1 = curr.x;
            const y1 = curr.y;
            
            const cp1x = x1 + (curr.handleOut ? curr.handleOut.x : 0);
            const cp1y = y1 + (curr.handleOut ? curr.handleOut.y : 0);
            
            const cp2x = x2 + (next.handleIn ? next.handleIn.x : 0);
            const cp2y = y2 + (next.handleIn ? next.handleIn.y : 0);
            
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
    contextFp: Footprint;  // Context for resolving snaps
}

// Recursively traverse footprint references to build a flat list of primitives with absolute transforms
function flattenShapes(
    contextFp: Footprint,
    shapes: FootprintShape[], 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = { x: 0, y: 0, rotation: 0 },
    depth = 0
): FlatShape[] {
    if (depth > 10) return []; // Safety break

    let result: FlatShape[] = [];

    shapes.forEach(shape => {
        if (shape.type === "wireGuide") return; // SKIP VIRTUAL WIRE GUIDES

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
                const children = flattenShapes(target, target.shapes, allFootprints, params, {
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
                originalId: shape.id,
                contextFp
            });
        }
    });

    return result;
}

// ------------------------------------------------------------------
// MANIFOLD UTILS
// ------------------------------------------------------------------

function shapeToManifold(wasm: any, shape: THREE.Shape, resolution = 32) {
    let points = shape.getPoints(resolution);
    
    // FIXED: Cleanup duplicate end point if present (Manifold prefers implicit close)
    if (points.length > 1 && points[0].distanceTo(points[points.length-1]) < 0.001) {
        points.pop();
    }
    
    const contour = points.map(p => [p.x, p.y]);

    // Handle holes
    const holes = shape.holes.map(h => {
        let hPts = h.getPoints(resolution);
        if (hPts.length > 1 && hPts[0].distanceTo(hPts[hPts.length-1]) < 0.001) {
            hPts.pop();
        }
        return hPts.map(p => [p.x, p.y]);
    });
    
    // Manifold expects [contour, hole, hole, ...] or [contour]
    const contours = [contour, ...holes];
    // Use string literal "EvenOdd"
    return new wasm.CrossSection(contours, "EvenOdd");
}

function generateProceduralFillet(
    manifoldModule: any,
    shape: FootprintShape, 
    params: Parameter[],
    depth: number, 
    filletRadius: number,
    contextFp: Footprint,
    allFootprints: Footprint[],
    resolution = 32
) {
    let minDimension = Infinity;
    
    // Generates a contour at a specific inward offset
    const getContour = (offset: number): THREE.Vector2[] => {
        let rawPoints: THREE.Vector2[] = [];
        
        if (shape.type === "circle") {
            const d = evaluateExpression((shape as any).diameter, params);
            minDimension = d;
            const r = Math.max(0.001, d/2 - offset); 
            const segments = resolution;
            for(let i=0; i<segments; i++) {
                const theta = (i / segments) * Math.PI * 2;
                rawPoints.push(new THREE.Vector2(Math.cos(theta) * r, Math.sin(theta) * r));
            }
        } 
        else if (shape.type === "rect") {
            const wRaw = evaluateExpression((shape as FootprintRect).width, params);
            const hRaw = evaluateExpression((shape as FootprintRect).height, params);
            minDimension = Math.min(wRaw, hRaw);
            
            const w = Math.max(0.001, wRaw - offset * 2);
            const h = Math.max(0.001, hRaw - offset * 2);
            const crRaw = evaluateExpression((shape as FootprintRect).cornerRadius, params);
            
            const halfW = w / 2;
            const halfH = h / 2;
            let cr = Math.max(0, crRaw - offset);
            const limit = Math.min(halfW, halfH);
            if (cr > limit) cr = limit;
            
            const segCorner = 6; 
            const quadrants = [
                { x: halfW - cr, y: halfH - cr, startAng: 0 },         
                { x: -halfW + cr, y: halfH - cr, startAng: Math.PI/2 },
                { x: -halfW + cr, y: -halfH + cr, startAng: Math.PI }, 
                { x: halfW - cr, y: -halfH + cr, startAng: 1.5*Math.PI}
            ];
            quadrants.forEach(q => {
                for(let i=0; i<segCorner; i++) {
                    const ang = q.startAng + (i/segCorner) * (Math.PI/2);
                    const vx = q.x + Math.cos(ang) * cr;
                    const vy = q.y + Math.sin(ang) * cr;
                    rawPoints.push(new THREE.Vector2(vx, vy));
                }
            });
        }
        else if (shape.type === "line") {
            const t = evaluateExpression((shape as FootprintLine).thickness, params);
            minDimension = t;
            const effectiveT = Math.max(0.001, t - offset * 2);
            rawPoints = getLineOutlinePoints(shape as FootprintLine, params, effectiveT, resolution, contextFp, allFootprints);
        }

        // --- FILTERING ---
        if (rawPoints.length > 0) {
            const clean: THREE.Vector2[] = [rawPoints[0]];
            for(let i=1; i<rawPoints.length; i++) {
                if (rawPoints[i].distanceToSquared(clean[clean.length-1]) > 1e-9) {
                    clean.push(rawPoints[i]);
                }
            }
            if (clean.length > 2 && clean[clean.length-1].distanceToSquared(clean[0]) < 1e-9) {
                clean.pop();
            }
            
            // --- WINDING NORMALIZATION (The Fix) ---
            // Calculate signed area to detect winding direction
            let area = 0;
            for (let i = 0; i < clean.length; i++) {
                const j = (i + 1) % clean.length;
                area += clean[i].x * clean[j].y - clean[j].x * clean[i].y;
            }
            
            // If area is negative (Clockwise), reverse to make it Counter-Clockwise
            // This ensures Lines (CW) match Circles/Rects (CCW)
            if (area < 0) {
                clean.reverse();
            }

            return clean;
        }
        
        return rawPoints;
    };

    const baseProfile = getContour(0); 
    const vertsPerLayer = baseProfile.length;
    
    if (vertsPerLayer < 3) return null;

    const safeR = Math.min(filletRadius, minDimension / 2 - 0.01, depth);
    if (safeR <= 0.001) return null;

    const layers: { z: number, offset: number }[] = [];
    layers.push({ z: 0, offset: 0 });

    const wallBottomZ = -(depth - safeR);
    if (Math.abs(wallBottomZ) > 0.001) {
        layers.push({ z: wallBottomZ, offset: 0 });
    }

    const filletSteps = 8; 
    for(let i=1; i<=filletSteps; i++) {
        const theta = (i / filletSteps) * (Math.PI / 2);
        const z = wallBottomZ - Math.sin(theta) * safeR;
        const off = (1 - Math.cos(theta)) * safeR;
        const maxOffset = minDimension / 2 - 0.001; 
        layers.push({ z, offset: Math.min(off, maxOffset) });
    }

    const rawVertices: number[] = [];
    const rawIndices: number[] = [];
    let topologyValid = true;

    layers.forEach((layer, idx) => {
        const points = getContour(layer.offset);
        
        if (points.length !== vertsPerLayer) {
             console.error(`Topology Mismatch: Layer ${idx} has ${points.length}, expected ${vertsPerLayer}.`);
             topologyValid = false;
        }
        
        if (!topologyValid) return;

        points.forEach(p => {
            rawVertices.push(p.x, layer.z, -p.y); 
        });
    });

    if (!topologyValid) return null;

    const getIdx = (layerIdx: number, ptIdx: number) => {
        return layerIdx * vertsPerLayer + (ptIdx % vertsPerLayer);
    };

    const pushTri = (i1: number, i2: number, i3: number) => {
        rawIndices.push(i1, i2, i3);
    };

    // A. Top Cap
    // Standard winding for CCW input
    const topFaces = THREE.ShapeUtils.triangulateShape(baseProfile, []);
    topFaces.forEach(face => {
        pushTri(getIdx(0, face[0]), getIdx(0, face[1]), getIdx(0, face[2]));
    });

    // B. Walls
    // REVERTED to Standard Logic: (v1, v2, v4) + (v2, v3, v4)
    // Since we forced inputs to be CCW, this logic (which worked for Circles) now works for Lines too.
    for(let l=0; l<layers.length-1; l++) {
        for(let i=0; i<vertsPerLayer; i++) {
            const curr = i;
            const next = (i+1) % vertsPerLayer;
            const v1 = getIdx(l, curr);
            const v2 = getIdx(l+1, curr);
            const v3 = getIdx(l+1, next);
            const v4 = getIdx(l, next);
            
            pushTri(v1, v2, v4); 
            pushTri(v2, v3, v4);
        }
    }

    // C. Bottom Cap
    // Standard winding for CCW input
    const lastL = layers.length - 1;
    const botProfile = getContour(layers[lastL].offset);
    
    let isCollapsed = true;
    if (botProfile.length > 0) {
        const p0 = botProfile[0];
        for(let i=1; i<botProfile.length; i++) {
            if (p0.distanceToSquared(botProfile[i]) > 1e-6) {
                isCollapsed = false;
                break;
            }
        }
    }
    
    if (!isCollapsed && botProfile.length === vertsPerLayer) {
        const botFaces = THREE.ShapeUtils.triangulateShape(botProfile, []);
        botFaces.forEach(face => {
            pushTri(getIdx(lastL, face[0]), getIdx(lastL, face[2]), getIdx(lastL, face[1]));
        });
    }

    // 2. Merge Vertices & Fix Indexing
    const PRECISION = 1e-5;
    const decimalShift = 1 / PRECISION;
    
    const uniqueVerts: number[] = [];
    const vertMap = new Map<string, number>();
    const oldToNew = new Int32Array(rawVertices.length / 3);

    for(let i=0; i<rawVertices.length / 3; i++) {
        const x = rawVertices[i*3];
        const y = rawVertices[i*3+1];
        const z = rawVertices[i*3+2];
        
        const kx = Math.round(x * decimalShift);
        const ky = Math.round(y * decimalShift);
        const kz = Math.round(z * decimalShift);
        const key = `${kx}_${ky}_${kz}`;

        if (vertMap.has(key)) {
            oldToNew[i] = vertMap.get(key)!;
        } else {
            const newIdx = uniqueVerts.length / 3;
            uniqueVerts.push(x, y, z);
            vertMap.set(key, newIdx);
            oldToNew[i] = newIdx;
        }
    }

    const finalIndices: number[] = [];
    
    for(let i=0; i<rawIndices.length; i+=3) {
        const a = oldToNew[rawIndices[i]];
        const b = oldToNew[rawIndices[i+1]];
        const c = oldToNew[rawIndices[i+2]];

        if (a === b || b === c || a === c) continue;
        
        // Geometric area check
        const ax = uniqueVerts[a*3], ay = uniqueVerts[a*3+1], az = uniqueVerts[a*3+2];
        const bx = uniqueVerts[b*3], by = uniqueVerts[b*3+1], bz = uniqueVerts[b*3+2];
        const cx = uniqueVerts[c*3], cy = uniqueVerts[c*3+1], cz = uniqueVerts[c*3+2];

        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        
        const cpx = aby * acz - abz * acy;
        const cpy = abz * acx - abx * acz;
        const cpz = abx * acy - aby * acx;
        
        if (cpx*cpx + cpy*cpy + cpz*cpz > 1e-12) {
             finalIndices.push(a, b, c);
        }
    }

    const vertProperties = new Float32Array(uniqueVerts);
    const triVerts = new Uint32Array(finalIndices);

    try {
        const mesh = new manifoldModule.Mesh();
        mesh.numProp = 3;
        mesh.vertProperties = vertProperties;
        mesh.triVerts = triVerts;
        
        const manifold = new manifoldModule.Manifold(mesh);
        
        if (manifold.status) {
             const status = manifold.status();
             let statusCode = 0;
             if (typeof status === 'number') statusCode = status;
             else if (status && typeof status.value === 'number') statusCode = status.value;
             
             if (statusCode !== 0) {
                 console.error(`Manifold Status Error: ${statusCode}`);
                 return { manifold: null, vertProperties, triVerts };
             }
        }
        
        return { manifold, vertProperties, triVerts };
    } catch (e) {
        console.error("Procedural Fillet Manifold Creation Failed", e);
        return { manifold: null, vertProperties, triVerts };
    }
}

// ------------------------------------------------------------------
// MESH PARSING
// ------------------------------------------------------------------

// Global cache to avoid re-parsing same base64 mesh
const meshGeometryCache = new Map<string, THREE.BufferGeometry>();

async function loadMeshGeometry(mesh: FootprintMesh, occtModule: any): Promise<THREE.BufferGeometry | null> {
    const cacheKey = mesh.id + "_" + mesh.content.slice(0, 30); // Simple hash
    if (meshGeometryCache.has(cacheKey)) {
        return meshGeometryCache.get(cacheKey)!.clone();
    }

    const buffer = base64ToArrayBuffer(mesh.content);

    try {
        console.log(`Loading mesh ${mesh.id} of format ${mesh.format}`);
        if (mesh.format === "stl") {
            const loader = new STLLoader();
            const geometry = loader.parse(buffer);
            meshGeometryCache.set(cacheKey, geometry);
            return geometry;
        } else if (mesh.format === "step") {
            // FIX: Robust check for module
            if (!occtModule) {
                console.error("OCCT Module not initialized.");
                return null;
            }
            
            try {
                // Pass the buffer directly to ReadStepFile
                // The library handles memory management for the buffer input
                const result = occtModule.ReadStepFile(new Uint8Array(buffer), null);
                
                if (result && result.meshes && result.meshes.length > 0) {
                    // Combine all sub-meshes
                    const geometries: THREE.BufferGeometry[] = [];
                    for(const m of result.meshes) {
                        const geom = new THREE.BufferGeometry();
                        const positions = new Float32Array(m.attributes.position.array);
                        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                        if(m.attributes.normal) {
                             const normals = new Float32Array(m.attributes.normal.array);
                             geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
                        }
                        if(m.index) {
                            const indices = new Uint16Array(m.index.array);
                            geom.setIndex(new THREE.BufferAttribute(indices, 1));
                        }
                        geometries.push(geom);
                    }

                    const merged = mergeBufferGeometries(geometries);
                    meshGeometryCache.set(cacheKey, merged);
                    return merged;
                }
            } catch (err) {
                console.error("Error reading STEP file via OCCT:", err);
                return null;
            }
        }
    } catch (e) {
        console.error("Failed to load mesh", e);
    }
    return null;
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
    return flattenShapes(footprint, footprint.shapes, allFootprints, params);
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
        let base: any;
        if (boardShape) {
            const cs = collect(shapeToManifold(manifoldModule, boardShape));
            const ext = collect(cs.extrude(thickness));
            const rotated = collect(ext.rotate([-90, 0, 0]));
            base = collect(rotated.translate([0, -thickness/2, 0]));
        } else {
            // Box
            base = collect(Manifold.cube([width, thickness, depth], true));
        }

        const failedFillets: THREE.BufferGeometry[] = [];

        // Sequential Processing (Painter's Algorithm)
        [...flatShapes].reverse().forEach((item) => {
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

                const val = evaluateExpression(valExpr, params);
                endmillRadius = evaluateExpression(radiusExpr, params);
                actualDepth = Math.max(0, Math.min(val, thickness));
            }

            // SAFETY: Clamp radius to avoid self-intersection inside ExtrudeGeometry
            let safeRadius = endmillRadius;
            if (shape.type === "circle") {
                 const d = evaluateExpression((shape as any).diameter, params);
                 safeRadius = Math.min(safeRadius, d/2 - 0.01);
            } else if (shape.type === "rect") {
                 const w = evaluateExpression((shape as FootprintRect).width, params);
                 const h = evaluateExpression((shape as FootprintRect).height, params);
                 safeRadius = Math.min(safeRadius, Math.min(w, h)/2 - 0.01);
            } else if (shape.type === "line") {
                 const t = evaluateExpression((shape as FootprintLine).thickness, params);
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
                    const d = evaluateExpression((shape as any).diameter, params);
                    if (d > 0) {
                        const r = d/2 + extraOffset;
                        tool = collect(Manifold.cylinder(height, r, r, 32, true));
                        tool = collect(tool.rotate([90, 0, 0])); 
                    }
                } else if (shape.type === "rect") {
                    const w = evaluateExpression((shape as FootprintRect).width, params);
                    const h = evaluateExpression((shape as FootprintRect).height, params);
                    const crRaw = evaluateExpression((shape as FootprintRect).cornerRadius, params);
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
                    const t = evaluateExpression((shape as FootprintLine).thickness, params);
                    const validT = (t > 0 ? t : 0.01) + extraOffset * 2;
                    const s = createLineShape(shape as FootprintLine, params, item.contextFp, allFootprints, validT);
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

            // A. THROUGH CUT (The "Eraser")
            // This removes material from previous shapes in this footprint
            const toolCut = createTool(0, throughHeight);
            if (toolCut) {
                const moved = collect(toolCut.translate([localX, throughY, localZ]));
                const diff = collect(Manifold.difference(base, moved));
                base = diff;
            }

            // B. FILL (Add material back)
            if (shouldFill) {
                // Use epsilon for fill to ensure overlap
                const toolFill = createTool(CSG_EPSILON, fillHeight);
                if (toolFill) {
                    const moved = collect(toolFill.translate([localX, fillY, localZ]));
                    const added = collect(Manifold.union(base, moved));
                    base = added;
                }
            }

            // C. ROUNDED CUT (FILLET)
            if (shouldRound) {
                const result = generateProceduralFillet(
                    manifoldModule, 
                    shape, 
                    params, 
                    actualDepth,
                    safeRadius,
                    item.contextFp,
                    allFootprints,
                    32
                );

                if (result && result.manifold) {
                    const toolFillet = collect(result.manifold);
                    const r = collect(toolFillet.rotate([0, globalRot, 0]));
                    let final;

                    if (layer.carveSide === "Top") {
                        const topY = thickness / 2;
                        final = collect(r.translate([localX, topY, localZ]));
                    } else {
                        // Bottom carve: Drill enters from bottom.
                        const flipped = collect(r.rotate([180, 0, 0]));
                        final = collect(flipped.translate([localX, -thickness/2, localZ]));
                    }
                    
                    const diff = collect(Manifold.difference(base, final));
                    base = diff;

                } else if (result && result.vertProperties && result.triVerts) {
                    // Failed to convert to manifold. Store for display (red wireframe).
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
        });

        if (failedFillets.length > 0) {
            const merged = mergeBufferGeometries(failedFillets);
            setGeometry(merged);
            setHasError(true);
            return;
        }

        // 6. Convert to Mesh
        const mesh = base.getMesh();
        const bufferGeom = new THREE.BufferGeometry();
        
        if (mesh.vertProperties && mesh.triVerts) {
             bufferGeom.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties, 3));
             bufferGeom.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
             bufferGeom.computeVertexNormals();
             setGeometry(bufferGeom);
        } else {
             setGeometry(null);
        }

    } catch (e) {
        console.error("Manifold Error", e);
        setHasError(true);
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
      {/* 
          Main Solid Material 
          - Logic updated: Always visible.
          - On Error: Opaque red, FrontSide only (to catch inverted normals).
          - Normal: Layer color, transparent.
      */}
      <meshStandardMaterial 
          color={hasError ? "#ff6666" : layer.color} 
          transparent={!hasError} 
          opacity={hasError ? 1.0 : 0.9} 
          flatShading 
          side={THREE.FrontSide} // Strict FrontSide helps identify flipped normals (backfaces won't render or will be dark)
          visible={true} 
      />

      {/* 
          Wireframe Overlay (Only on Error)
          - Renders a slightly larger black/dark-red wireframe on top of the solid
          - Helps visualize the topology/triangulation
      */}
      {hasError && geometry && (
        <mesh geometry={geometry}>
          <meshBasicMaterial 
            color="#330000" 
            wireframe 
            wireframeLinewidth={1} 
          />
        </mesh>
      )}
    </mesh>
  );
};

// --- MESH RENDERER ---

interface FlatMesh {
    mesh: FootprintMesh;
    globalTransform: THREE.Matrix4;
}

// Recursive flattener for meshes
function flattenMeshes(
    rootFp: Footprint, 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = new THREE.Matrix4()
): FlatMesh[] {
    let result: FlatMesh[] = [];

    // Add local meshes
    if (rootFp.meshes) {
        rootFp.meshes.forEach(m => {
            // Apply local mesh transform to the accumulated footprint transform
            const x = evaluate(m.x, params);
            const y = evaluate(m.y, params);
            const z = evaluate(m.z, params);
            const rx = evaluate(m.rotationX, params) * Math.PI / 180;
            const ry = evaluate(m.rotationY, params) * Math.PI / 180;
            const rz = evaluate(m.rotationZ, params) * Math.PI / 180;

            const meshMat = new THREE.Matrix4();
            const rot = new THREE.Euler(rx, ry, rz, 'XYZ');
            meshMat.makeRotationFromEuler(rot);
            meshMat.setPosition(x, y, z); 
            // NOTE: CAD view is Y-up in 3D?
            // In Footprint editor 2D: X is right, Y is up (SVG style). 
            // In 3D view: we usually map 2D (x, y) to 3D (x, -y, z=0) or (x, z, y=0).
            // The LayerSolid uses `localZ = centerZ - item.y` implying Y in 2D maps to Z in 3D (inverted).
            // And X maps to X.
            // Let's standardise on the transform passed in.
            
            // However, Footprint3DView maps shapes with:
            // X -> X
            // Y -> -Z (approx)
            // But here `m.x`, `m.y`, `m.z` are explicit 3D coordinates.
            // So we just apply them relative to the footprint origin.
            
            // IMPORTANT: The footprint recursion transform is in "2D plane logic".
            // We need to convert that to 3D logic.
            // But `flattenShapes` calculates `globalX` and `globalY`. 
            
            // Let's assume standard 3D logic for the mesh properties relative to parent.
            // The `transform` passed in is the GLOBAL transform of the parent footprint in 3D space.
            
            const finalMat = transform.clone().multiply(meshMat);
            result.push({ mesh: m, globalTransform: finalMat });
        });
    }

    // Recurse children
    rootFp.shapes.forEach(s => {
        if (s.type === "footprint") {
             const ref = s as FootprintReference;
             const child = allFootprints.find(f => f.id === ref.footprintId);
             if (child) {
                 const x = evaluate(ref.x, params);
                 const y = evaluate(ref.y, params);
                 const angle = evaluate(ref.angle, params);
                 
                 // Create transform for child footprint relative to current
                 // 2D (x, y) maps to 3D (x, 0, -y) typically in this view setup
                 // Rotation is around Y axis in 3D (since Z is depth in 2D)
                 
                 const childMat = new THREE.Matrix4();
                 childMat.makeRotationY(angle * Math.PI / 180);
                 childMat.setPosition(x, 0, -y);
                 
                 const globalChildMat = transform.clone().multiply(childMat);
                 
                 result = result.concat(flattenMeshes(child, allFootprints, params, globalChildMat));
             }
        }
    });

    return result;
}

const MeshObject = ({ 
    meshData, 
    occtModule,
    isSelected,
    onSelect
}: { 
    meshData: FlatMesh, 
    occtModule: any,
    isSelected: boolean,
    onSelect: () => void
}) => {
    const { mesh, globalTransform } = meshData;
    const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);

    useEffect(() => {
        let mounted = true;
        loadMeshGeometry(mesh, occtModule).then(geom => {
            if(mounted && geom) setGeometry(geom);
        });
        return () => { mounted = false; };
    }, [mesh, occtModule]);

    if (!geometry || mesh.renderingType === "hidden") return null;

    const color = isSelected ? "#646cff" : (mesh.color || "#ccc");
    const emissive = isSelected ? "#3333aa" : "#000000";

    return (
        <mesh 
            geometry={geometry} 
            matrix={globalTransform}
            matrixAutoUpdate={false} // Use the matrix we computed
            onClick={(e) => {
                e.stopPropagation();
                onSelect();
            }}
        >
            {mesh.renderingType === "wireframe" ? (
                <meshBasicMaterial color={color} wireframe />
            ) : (
                <meshStandardMaterial 
                    color={color} 
                    emissive={emissive} 
                    emissiveIntensity={0.2}
                />
            )}
        </mesh>
    );
};


const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, visibleLayers, is3DActive, selectedId, onSelect }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});
  const hasInitiallySnapped = useRef(false);
  const [firstMeshReady, setFirstMeshReady] = useState(false);
  
  // Initialize Manifold and OCCT
  const [manifoldModule, setManifoldModule] = useState<any>(null);
  const [occtModule, setOcctModule] = useState<any>(null);
  
  useEffect(() => {
    // Load Manifold WASM
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

    // Load OCCT WASM
    initOCCT({
        locateFile: (name: string) => {
            if (name.endsWith('.wasm')) {
                return occtWasmUrl;
            }
            return name;
        }
    }).then((m: any) => {
        console.log("OCCT Module initialized");
        setOcctModule(m);
    });
  }, []);

  const fitToHome = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    const camera = controls.object as THREE.PerspectiveCamera;
    const box = new THREE.Box3();
    let hasMeshes = false;

    // Iterate through all visible meshes to compute the total bounding box
    Object.values(meshRefs.current).forEach((mesh) => {
        if (mesh && mesh.geometry) {
            mesh.updateMatrixWorld();
            const meshBox = new THREE.Box3().setFromObject(mesh);
            if (!meshBox.isEmpty()) {
                box.union(meshBox);
                hasMeshes = true;
            }
        }
    });

    if (!hasMeshes) {
        // Default fallback if no meshes are visible
        camera.position.set(50, 50, 50);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Calculate the required distance to fit the bounding box in the camera's FOV
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    
    // Take aspect ratio into account for wide bounding boxes
    const aspect = camera.aspect || 1;
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const effectiveFOV = Math.min(fov, fovH);
    
    let distance = maxDim / (2 * Math.tan(effectiveFOV / 2));
    
    // Add 30% margin for "comfortable" framing
    distance *= 1.3;

    // Position camera at a standard isometric-ish angle relative to the center
    const direction = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    
    controls.target.copy(center);
    controls.update();
  }, []);

  // Snap to home the first time computing the mesh finishes
  useEffect(() => {
    if (firstMeshReady && !hasInitiallySnapped.current && is3DActive) {
        fitToHome();
        hasInitiallySnapped.current = true;
    }
  }, [firstMeshReady, is3DActive, fitToHome]);

useImperativeHandle(ref, () => ({
    resetCamera: fitToHome,
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
          return createBoardShape(footprint.boardOutline, params, footprint, allFootprints);
      }
      return null;
  }, [footprint, params, allFootprints]);

  // 1. Calculate Bounding Box of all shapes (or board outline) + Padding
  const bounds = useMemo(() => {
    const PADDING = 10;
    
    if (footprint.isBoard && footprint.boardOutline && footprint.boardOutline.length >= 3) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        footprint.boardOutline.forEach(pRaw => {
             const p = resolvePoint(pRaw, footprint, allFootprints, params);
             const x = p.x;
             const y = p.y;
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
        if (shape.type === "wireGuide") return;
        const x = evaluateExpression(shape.x, params);
        const y = evaluateExpression(shape.y, params);
        const MARGIN = 50; 
        if (x - MARGIN < minX) minX = x - MARGIN;
        if (x + MARGIN > maxX) maxX = x + MARGIN;
        if (y - MARGIN < minY) minY = y - MARGIN;
        if (y + MARGIN > maxY) maxY = y + MARGIN;
    });

    return { minX, maxX, minY, maxY };

  }, [footprint, params, allFootprints]);

  const flattenedMeshes = useMemo(() => flattenMeshes(footprint, allFootprints, params), [footprint, allFootprints, params]);

  return (
    <div style={{ width: "100%", height: "100%", background: "#111" }}>
      <Canvas 
        camera={{ position: [50, 50, 50], fov: 45 }}
        frameloop={is3DActive ? "always" : "never"}
        onPointerMissed={() => onSelect && onSelect("")}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[10, 20, 10]} intensity={1} />
        <pointLight position={[-10, -10, -10]} intensity={0.5} />

        <group>
          {(() => {
            let currentZ = 0; // This tracks height (Y in 3D)
            return [...stackup].reverse().map((layer) => {
              const thickness = evaluateExpression(layer.thicknessExpression, params);
              
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
                      if (mesh) {
                        meshRefs.current[id] = mesh; 
                        // Once geometry is set, indicate we have something to snap to
                        if (mesh.geometry) setFirstMeshReady(true);
                      } else {
                        delete meshRefs.current[id]; 
                      }
                  }}
                />
              ) : null;

              currentZ += thickness;
              return node;
            });
          })()}
        </group>
        
        <group>
            {flattenedMeshes.map((m, idx) => (
                <MeshObject 
                    key={m.mesh.id + idx} 
                    meshData={m} 
                    occtModule={occtModule} 
                    isSelected={selectedId === m.mesh.id}
                    onSelect={() => onSelect(m.mesh.id)}
                />
            ))}
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