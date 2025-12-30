// src/components/Footprint3DView.tsx
import { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader, OBJLoader, GLTFLoader, GLTFExporter } from "three-stdlib";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, Point, FootprintReference, FootprintMesh } from "../types";
import { mergeVertices, mergeBufferGeometries } from "three-stdlib";
import { evaluateExpression, resolvePoint, modifyExpression } from "../utils/footprintUtils";
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
  onUpdateMesh: (id: string, field: string, val: any) => void;
}

export interface Footprint3DViewHandle {
    resetCamera: () => void;
    getLayerSTL: (layerId: string) => Uint8Array | null;
    processDroppedFile: (file: File) => Promise<FootprintMesh | null>;
    convertMeshToGlb: (mesh: FootprintMesh) => Promise<FootprintMesh | null>;
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// ------------------------------------------------------------------
// GEOMETRY GENERATION (Remaining geometry code omitted for brevity as it is unchanged)
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
// FLATTENING LOGIC & MANIFOLD UTILS
// ------------------------------------------------------------------

interface FlatShape {
    shape: FootprintShape;
    x: number;
    y: number;
    rotation: number;
    originalId: string;
    contextFp: Footprint;
}

function flattenShapes(
    contextFp: Footprint,
    shapes: FootprintShape[], 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = { x: 0, y: 0, rotation: 0 },
    depth = 0
): FlatShape[] {
    if (depth > 10) return [];

    let result: FlatShape[] = [];

    shapes.forEach(shape => {
        if (shape.type === "wireGuide") return;

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

function shapeToManifold(wasm: any, shape: THREE.Shape, resolution = 32) {
    let points = shape.getPoints(resolution);
    
    if (points.length > 1 && points[0].distanceTo(points[points.length-1]) < 0.001) {
        points.pop();
    }
    
    const contour = points.map(p => [p.x, p.y]);

    const holes = shape.holes.map(h => {
        let hPts = h.getPoints(resolution);
        if (hPts.length > 1 && hPts[0].distanceTo(hPts[hPts.length-1]) < 0.001) {
            hPts.pop();
        }
        return hPts.map(p => [p.x, p.y]);
    });
    
    const contours = [contour, ...holes];
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
            
            let area = 0;
            for (let i = 0; i < clean.length; i++) {
                const j = (i + 1) % clean.length;
                area += clean[i].x * clean[j].y - clean[j].x * clean[i].y;
            }
            
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

    const topFaces = THREE.ShapeUtils.triangulateShape(baseProfile, []);
    topFaces.forEach(face => {
        pushTri(getIdx(0, face[0]), getIdx(0, face[1]), getIdx(0, face[2]));
    });

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
        } else if (mesh.format === "obj") {
             const text = new TextDecoder().decode(buffer);
             const loader = new OBJLoader();
             const group = loader.parse(text);
             const geometries: THREE.BufferGeometry[] = [];
             group.traverse((child) => {
                 if ((child as THREE.Mesh).isMesh) {
                     geometries.push((child as THREE.Mesh).geometry);
                 }
             });
             if (geometries.length > 0) {
                 const merged = mergeBufferGeometries(geometries);
                 meshGeometryCache.set(cacheKey, merged);
                 return merged;
             }
        } else if (mesh.format === "step") {
            if (!occtModule) {
                console.error("OCCT Module not initialized.");
                return null;
            }
            try {
                const result = occtModule.ReadStepFile(new Uint8Array(buffer), null);
                if (result && result.meshes && result.meshes.length > 0) {
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
        } else if (mesh.format === "glb") {
            const loader = new GLTFLoader();
            return new Promise((resolve) => {
                loader.parse(buffer, '', (gltf) => {
                    const geometries: THREE.BufferGeometry[] = [];
                    gltf.scene.traverse((child) => {
                        if ((child as THREE.Mesh).isMesh) {
                            geometries.push((child as THREE.Mesh).geometry);
                        }
                    });
                    if (geometries.length > 0) {
                        const merged = mergeBufferGeometries(geometries);
                        meshGeometryCache.set(cacheKey, merged);
                        resolve(merged);
                    } else {
                        resolve(null);
                    }
                }, (err) => {
                    console.error("GLB Parse error", err);
                    resolve(null);
                });
            });
        }
    } catch (e) {
        console.error("Failed to load mesh", e);
    }
    return null;
}

// ------------------------------------------------------------------
// COMPONENTS (LayerSolid, FlatMesh, FlattenMeshes, etc. omitted)
// ------------------------------------------------------------------

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

  const flatShapes = useMemo(() => {
    return flattenShapes(footprint, footprint.shapes, allFootprints, params);
  }, [footprint, allFootprints, params]);

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

        let base: any;
        if (boardShape) {
            const cs = collect(shapeToManifold(manifoldModule, boardShape));
            const ext = collect(cs.extrude(thickness));
            const rotated = collect(ext.rotate([-90, 0, 0]));
            base = collect(rotated.translate([0, -thickness/2, 0]));
        } else {
            base = collect(Manifold.cube([width, thickness, depth], true));
        }

        const failedFillets: THREE.BufferGeometry[] = [];

        [...flatShapes].reverse().forEach((item) => {
            const shape = item.shape;
            if (!shape.assignedLayers || shape.assignedLayers[layer.id] === undefined) return;

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

            const throughHeight = thickness + 0.2; 
            const throughY = 0; 

            let fillHeight = thickness - actualDepth;
            if (shouldRound) fillHeight += safeRadius;

            let fillY = 0;
            const shouldFill = fillHeight > 0.001;
            if (shouldFill) {
                fillY = layer.carveSide === "Top" 
                    ? (-thickness / 2 + fillHeight / 2) 
                    : (thickness / 2 - fillHeight / 2);
            }

            const localX = item.x - centerX;
            const localZ = centerZ - item.y;
            const globalRot = item.rotation; 

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

            const toolCut = createTool(0, throughHeight);
            if (toolCut) {
                const moved = collect(toolCut.translate([localX, throughY, localZ]));
                const diff = collect(Manifold.difference(base, moved));
                base = diff;
            }

            if (shouldFill) {
                const toolFill = createTool(CSG_EPSILON, fillHeight);
                if (toolFill) {
                    const moved = collect(toolFill.translate([localX, fillY, localZ]));
                    const added = collect(Manifold.union(base, moved));
                    base = added;
                }
            }

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
                        const flipped = collect(r.rotate([180, 0, 0]));
                        final = collect(flipped.translate([localX, -thickness/2, localZ]));
                    }
                    
                    const diff = collect(Manifold.difference(base, final));
                    base = diff;

                } else if (result && result.vertProperties && result.triVerts) {
                    const geom = new THREE.BufferGeometry();
                    geom.setAttribute('position', new THREE.BufferAttribute(result.vertProperties, 3));
                    geom.setIndex(new THREE.BufferAttribute(result.triVerts, 1));
                    
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
      <meshStandardMaterial 
          color={hasError ? "#ff6666" : layer.color} 
          transparent={!hasError} 
          opacity={hasError ? 1.0 : 0.9} 
          flatShading 
          side={THREE.FrontSide} 
          visible={true} 
      />
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
    selectableId: string; // The ID to select when clicking (parent ref or self)
    isEditable: boolean; // Only true if direct child of current footprint
}

function flattenMeshes(
    rootFp: Footprint, 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = new THREE.Matrix4(),
    ancestorRefId: string | null = null
): FlatMesh[] {
    let result: FlatMesh[] = [];

    if (rootFp.meshes) {
        rootFp.meshes.forEach(m => {
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
            
            const finalMat = transform.clone().multiply(meshMat);
            
            result.push({ 
                mesh: m, 
                globalTransform: finalMat,
                selectableId: ancestorRefId || m.id,
                isEditable: ancestorRefId === null
            });
        });
    }

    rootFp.shapes.forEach(s => {
        if (s.type === "footprint") {
             const ref = s as FootprintReference;
             const child = allFootprints.find(f => f.id === ref.footprintId);
             if (child) {
                 const x = evaluate(ref.x, params);
                 const y = evaluate(ref.y, params);
                 const angle = evaluate(ref.angle, params);
                 
                 const childMat = new THREE.Matrix4();
                 childMat.makeRotationY(angle * Math.PI / 180);
                 childMat.setPosition(x, 0, -y);
                 
                 const globalChildMat = transform.clone().multiply(childMat);
                 
                 result = result.concat(flattenMeshes(
                     child, 
                     allFootprints, 
                     params, 
                     globalChildMat,
                     ancestorRefId || ref.id
                 ));
             }
        }
    });

    return result;
}

// Helper component to switch modes with keyboard
const TransformControlsModeSwitcher = ({ controlRef }: { controlRef: any }) => {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (controlRef.current) {
                if (e.key === 'r') controlRef.current.setMode('rotate');
                if (e.key === 't') controlRef.current.setMode('translate');
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [controlRef]);
    return null;
};

const MeshObject = ({ 
    meshData, 
    occtModule,
    isSelected,
    onSelect,
    onUpdate
}: { 
    meshData: FlatMesh, 
    occtModule: any,
    isSelected: boolean,
    onSelect: () => void,
    onUpdate: (id: string, field: string, val: any) => void
}) => {
    const { mesh, globalTransform, isEditable } = meshData;
    const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
    const meshRef = useRef<THREE.Mesh>(null);

    // Ghost object for TransformControls to follow
    const ghostRef = useRef<THREE.Object3D>(null);
    const controlRef = useRef<any>(null);
    const [isDragging, setIsDragging] = useState(false);

    useEffect(() => {
        let mounted = true;
        loadMeshGeometry(mesh, occtModule).then(geom => {
            if(mounted && geom) setGeometry(geom);
        });
        return () => { mounted = false; };
    }, [mesh, occtModule]);

    // Sync Ghost to globalTransform when NOT dragging to avoid loops
    useEffect(() => {
        if (!isDragging && ghostRef.current) {
            ghostRef.current.position.setFromMatrixPosition(globalTransform);
            ghostRef.current.quaternion.setFromRotationMatrix(globalTransform);
            ghostRef.current.scale.setFromMatrixScale(globalTransform);
        }
    }, [globalTransform, isDragging]);

    const handleChange = () => {
        if (!ghostRef.current || !isEditable) return;
        
        const ghostPos = ghostRef.current.position;
        const ghostRot = ghostRef.current.rotation; // Euler
        
        // Decompose current state transform to compare
        const currentPos = new THREE.Vector3().setFromMatrixPosition(globalTransform);
        const currentRot = new THREE.Euler().setFromRotationMatrix(globalTransform);

        // Calculate delta from where the state IS to where the gizmo IS
        const dx = ghostPos.x - currentPos.x;
        const dy = ghostPos.y - currentPos.y;
        const dz = ghostPos.z - currentPos.z;
        
        // Rotation diff (approximate for small steps)
        const dRx = (ghostRot.x - currentRot.x) * (180/Math.PI);
        const dRy = (ghostRot.y - currentRot.y) * (180/Math.PI);
        const dRz = (ghostRot.z - currentRot.z) * (180/Math.PI);

        if (Math.abs(dx) > 1e-4) onUpdate(mesh.id, "x", modifyExpression(mesh.x, dx));
        if (Math.abs(dy) > 1e-4) onUpdate(mesh.id, "y", modifyExpression(mesh.y, dy));
        if (Math.abs(dz) > 1e-4) onUpdate(mesh.id, "z", modifyExpression(mesh.z, dz));
        
        if (Math.abs(dRx) > 1e-4) onUpdate(mesh.id, "rotationX", modifyExpression(mesh.rotationX, dRx));
        if (Math.abs(dRy) > 1e-4) onUpdate(mesh.id, "rotationY", modifyExpression(mesh.rotationY, dRy));
        if (Math.abs(dRz) > 1e-4) onUpdate(mesh.id, "rotationZ", modifyExpression(mesh.rotationZ, dRz));
    };

    if (!geometry || mesh.renderingType === "hidden") return null;

    const color = isSelected ? "#646cff" : (mesh.color || "#ccc");
    const emissive = isSelected ? "#3333aa" : "#000000";

    return (
        <>
            <mesh 
                ref={meshRef}
                geometry={geometry} 
                // Render visible mesh purely from props (state leads rendering)
                position={new THREE.Vector3().setFromMatrixPosition(globalTransform)}
                quaternion={new THREE.Quaternion().setFromRotationMatrix(globalTransform)}
                scale={new THREE.Vector3().setFromMatrixScale(globalTransform)}
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
            
            {isSelected && isEditable && (
                <>
                    {/* Phantom Object for controls to attach to */}
                    <object3D ref={ghostRef} />
                    
                    <TransformControls 
                        ref={controlRef}
                        object={ghostRef} 
                        mode="translate" 
                        space="local" 
                        onMouseDown={() => setIsDragging(true)}
                        onMouseUp={() => setIsDragging(false)}
                        onChange={handleChange}
                    />
                    <TransformControlsModeSwitcher controlRef={controlRef} />
                </>
            )}
        </>
    );
};

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, visibleLayers, is3DActive, selectedId, onSelect, onUpdateMesh }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});
  const hasInitiallySnapped = useRef(false);
  const [firstMeshReady, setFirstMeshReady] = useState(false);
  
  const [manifoldModule, setManifoldModule] = useState<any>(null);
  const [occtModule, setOcctModule] = useState<any>(null);
  
  useEffect(() => {
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
        camera.position.set(50, 50, 50);
        controls.target.set(0, 0, 0);
        controls.update();
        return;
    }

    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = camera.fov * (Math.PI / 180);
    const aspect = camera.aspect || 1;
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * aspect);
    const effectiveFOV = Math.min(fov, fovH);
    
    let distance = maxDim / (2 * Math.tan(effectiveFOV / 2));
    distance *= 1.3;

    const direction = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center).add(direction.multiplyScalar(distance));
    
    controls.target.copy(center);
    controls.update();
  }, []);

  useEffect(() => {
    if (firstMeshReady && !hasInitiallySnapped.current && is3DActive) {
        fitToHome();
        hasInitiallySnapped.current = true;
    }
  }, [firstMeshReady, is3DActive, fitToHome]);

  // NEW: Refactoring reusable logic for export/conversion
  const convertGeometryToMeshObject = async (mesh: FootprintMesh): Promise<FootprintMesh | null> => {
      // 1. Get geometry
      const geometry = await loadMeshGeometry(mesh, occtModule);
      if (!geometry) {
          // If we failed to load (e.g. OCCT missing for STEP), return null
          return null;
      }

      // 2. Convert to GLB
      const threeMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
      const exporter = new GLTFExporter();

      return new Promise((resolve) => {
          exporter.parse(
              threeMesh,
              (result) => {
                  if (result instanceof ArrayBuffer) {
                      const glbBase64 = arrayBufferToBase64(result);
                      resolve({
                          ...mesh,
                          content: glbBase64,
                          format: "glb"
                      });
                  } else {
                      console.error("GLTFExporter returned JSON instead of binary");
                      resolve(null);
                  }
              },
              (err) => {
                  console.error("GLTF Export failed", err);
                  resolve(null);
              },
              { binary: true }
          );
      });
  };

  useImperativeHandle(ref, () => ({
    resetCamera: fitToHome,
    getLayerSTL: (layerId: string) => {
        const mesh = meshRefs.current[layerId];
        if (!mesh || !mesh.geometry) return null;

        let geom = mesh.geometry.clone();
        mesh.updateMatrixWorld();
        geom.applyMatrix4(mesh.matrixWorld);

        geom.deleteAttribute('uv');
        geom.deleteAttribute('normal');

        try {
            geom = mergeVertices(geom, 1e-4);
        } catch (e) {
            console.warn("Vertex merge failed", e);
        }

        geom.computeVertexNormals();
        const data = geometryToSTL(geom);
        geom.dispose();
        
        return data;
    },
    processDroppedFile: async (file: File): Promise<FootprintMesh | null> => {
        const ext = file.name.split('.').pop()?.toLowerCase();
        if (!ext) return null;
        
        // Read file content
        const buffer = await file.arrayBuffer();
        
        // Construct temporary mesh object for loader reuse
        const tempMesh: FootprintMesh = {
            id: crypto.randomUUID(),
            name: file.name,
            content: arrayBufferToBase64(buffer),
            format: (ext === "stp" || ext === "step") ? "step" : (ext === "obj" ? "obj" : (ext === "glb" || ext === "gltf" ? "glb" : "stl")),
            renderingType: "solid",
            x: "0", y: "0", z: "0",
            rotationX: "0", rotationY: "0", rotationZ: "0"
        };
        
        // If it's already GLB/GLTF, return as is
        if (tempMesh.format === "glb") {
            return tempMesh;
        }

        // Convert to GLB immediately
        return await convertGeometryToMeshObject(tempMesh);
    },
    convertMeshToGlb: async (mesh: FootprintMesh): Promise<FootprintMesh | null> => {
        if (mesh.format === "glb") return mesh;
        return await convertGeometryToMeshObject(mesh);
    }
  }));

  const boardShape = useMemo(() => {
      if (footprint.isBoard && footprint.boardOutline && footprint.boardOutline.length >= 3) {
          return createBoardShape(footprint.boardOutline, params, footprint, allFootprints);
      }
      return null;
  }, [footprint, params, allFootprints]);

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

  const activeMeshIsEditable = useMemo(() => {
      if (!selectedId) return false;
      const flat = flattenedMeshes.find(m => m.selectableId === selectedId);
      return flat ? flat.isEditable : false;
  }, [selectedId, flattenedMeshes]);

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
            let currentZ = 0; 
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
                    isSelected={selectedId === m.selectableId}
                    onSelect={() => onSelect(m.selectableId)}
                    onUpdate={onUpdateMesh}
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
      {activeMeshIsEditable && (
        <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', color: 'rgba(255,255,255,0.5)', pointerEvents: 'none', fontSize: '12px' }}>
           Select Mesh: 'T' for Translate, 'R' for Rotate
        </div>
      )}
    </div>
  );
});

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

        const ax = pos.getX(i3);
        const ay = pos.getY(i3);
        const az = pos.getZ(i3);

        const bx = pos.getX(i3 + 1);
        const by = pos.getY(i3 + 1);
        const bz = pos.getZ(i3 + 1);

        const cx = pos.getX(i3 + 2);
        const cy = pos.getY(i3 + 2);
        const cz = pos.getZ(i3 + 2);

        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;

        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
            nx /= len; ny /= len; nz /= len;
        }

        view.setFloat32(offset, nx, true);
        view.setFloat32(offset + 4, ny, true);
        view.setFloat32(offset + 8, nz, true);
        offset += 12;

        view.setFloat32(offset, ax, true);
        view.setFloat32(offset + 4, ay, true);
        view.setFloat32(offset + 8, az, true);
        offset += 12;

        view.setFloat32(offset, bx, true);
        view.setFloat32(offset + 4, by, true);
        view.setFloat32(offset + 8, bz, true);
        offset += 12;

        view.setFloat32(offset, cx, true);
        view.setFloat32(offset + 4, cy, true);
        view.setFloat32(offset + 8, cz, true);
        offset += 12;

        view.setUint16(offset, 0, true);
        offset += 2;
    }

    if (geom !== geometry) {
        geom.dispose();
    }

    return new Uint8Array(buffer);
}

export default Footprint3DView;