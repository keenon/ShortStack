// src/components/Footprint3DView.tsx
import { useMemo, forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Grid, GizmoHelper, GizmoViewport, TransformControls, Edges } from "@react-three/drei";
import * as THREE from "three";
import { STLLoader, OBJLoader, GLTFLoader } from "three-stdlib";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, FootprintReference, FootprintMesh, FootprintBoardOutline, FootprintPolygon, Point, MeshAsset, FootprintUnion } from "../types";
import { mergeVertices, mergeBufferGeometries } from "three-stdlib";
import { evaluateExpression, resolvePoint, modifyExpression, getPolyOutlinePoints } from "../utils/footprintUtils";
import Module from "manifold-3d";
// @ts-ignore
import wasmUrl from "manifold-3d/manifold.wasm?url";

// IMPORT WORKER
import MeshWorker from "../workers/meshWorker?worker";
// @ts-ignore
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

interface Props {
  footprint: Footprint;
  allFootprints: Footprint[]; // Required for recursion
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
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

// ------------------------------------------------------------------
// GEOMETRY GENERATION
// ------------------------------------------------------------------

/**
 * Enhanced discretization that tracks the indices of sharp corners
 */
function getPolyOutlineWithFeatures(
    points: Point[],
    originX: number,
    originY: number,
    params: Parameter[],
    contextFp: Footprint,
    allFootprints: Footprint[],
    resolution: number
): { points: THREE.Vector2[], cornerIndices: number[] } {
    if (points.length < 3) return { points: [], cornerIndices: [] };

    const pathPoints: THREE.Vector2[] = [];
    const cornerIndices: number[] = [];

    for (let i = 0; i < points.length; i++) {
        cornerIndices.push(pathPoints.length);

        const currRaw = points[i];
        const nextRaw = points[(i + 1) % points.length];

        const curr = resolvePoint(currRaw, contextFp, allFootprints, params);
        const next = resolvePoint(nextRaw, contextFp, allFootprints, params);

        const x1 = originX + curr.x;
        const y1 = originY + curr.y;
        const x2 = originX + next.x;
        const y2 = originY + next.y;

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

            const sp = curve.getPoints(resolution);
            sp.pop(); // Remove end point to avoid duplicate with next start
            sp.forEach(p => pathPoints.push(p));
        } else {
            pathPoints.push(new THREE.Vector2(x1, y1));
        }
    }

    // Ensure CCW Winding for consistent offsetting
    let area = 0;
    for (let i = 0; i < pathPoints.length; i++) {
        const j = (i + 1) % pathPoints.length;
        area += pathPoints[i].x * pathPoints[j].y - pathPoints[j].x * pathPoints[i].y;
    }
    if (area < 0) {
        pathPoints.reverse();
        // Recalculate corner indices after reversal
        const len = pathPoints.length;
        const reversedCorners = cornerIndices.map(idx => (len - idx) % len).sort((a,b) => a-b);
        return { points: pathPoints, cornerIndices: reversedCorners };
    }

    return { points: pathPoints, cornerIndices };
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

function createBoardShape(outlineShape: FootprintBoardOutline, params: Parameter[], rootFootprint: Footprint, allFootprints: Footprint[]): THREE.Shape | null {
    const points = outlineShape.points;
    if (!points || points.length < 3) return null;
    const shape = new THREE.Shape();

    const originX = evaluateExpression(outlineShape.x, params);
    const originY = evaluateExpression(outlineShape.y, params);

    const p0Raw = points[0];
    const p0 = resolvePoint(p0Raw, rootFootprint, allFootprints, params);
    shape.moveTo(originX + p0.x, originY + p0.y);
    
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
            
            shape.bezierCurveTo(originX + cp1x, originY + cp1y, originX + cp2x, originY + cp2y, originX + x2, originY + y2);
        } else {
            shape.lineTo(originX + x2, originY + y2);
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
        if (shape.type === "wireGuide" || shape.type === "boardOutline") return;

        const localX = evaluate(shape.x, params);
        const localY = evaluate(shape.y, params);
        
        const rad = (transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const globalX = transform.x + (localX * cos - localY * sin);
        const globalY = transform.y + (localX * sin + localY * cos);
        
        let localRotation = 0;
        if (shape.type === "rect" || shape.type === "footprint" || shape.type === "union") {
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
        } else if (shape.type === "union") {
            const u = shape as FootprintUnion;
            const children = flattenShapes(u as unknown as Footprint, u.shapes, allFootprints, params, {
                x: globalX,
                y: globalY,
                rotation: globalRotation
            }, depth + 1);

            // Apply override logic: if Union has layer assignments, they propagate to all children
            if (Object.keys(u.assignedLayers || {}).length > 0) {
                children.forEach(c => {
                    c.shape = { ...c.shape, assignedLayers: u.assignedLayers };
                });
            }
            result = result.concat(children);
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

// Helper for safe modulo in JS (handles negative numbers)
function safeMod(n: number, m: number) {
  return ((n % m) + m) % m;
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
    const rawVertices: number[] = [];
    const rawIndices: number[] = [];

    // -----------------------------------------------------------------------
    // NEW: Cyclic Optimal Triangulation
    // Runs the DP Tiling algorithm multiple times to find the best "Seam"
    // to prevent twisting on low-poly shapes (like triangles/rectangles).
    // -----------------------------------------------------------------------
    const triangulateRobust = (polyA: THREE.Vector2[], polyB: THREE.Vector2[], idxStartA: number, idxStartB: number) => {
        const lenA = polyA.length;
        const lenB = polyB.length;
        if (lenA < 3 || lenB < 3) return;

        // DP Table Reused to avoid allocation spam
        const dimCol = lenB + 1;
        const costTable = new Float32Array((lenA + 1) * dimCol);
        const fromTable = new Int8Array((lenA + 1) * dimCol); // 1: Up, 2: Left
        const idx = (r: number, c: number) => r * dimCol + c;

        // Area Weight Constant
        // Penalizes large triangles to prevent "shortcuts" across concave voids.
        // A value of 1.0-10.0 keeps the solver focused on the ribbon path.
        const AREA_WEIGHT = 4.0; 

        // Helper: Calculate 2x Area of triangle (to avoid 0.5 multiplication repeatedly)
        const getTriArea2x = (p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2) => {
            return Math.abs(p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
        };

        const solveForOffset = (offsetB: number) => {
            costTable.fill(Infinity);
            fromTable.fill(0);
            costTable[0] = 0; 

            for (let i = 0; i <= lenA; i++) {
                for (let j = 0; j <= lenB; j++) {
                    if (i === 0 && j === 0) continue;
                    
                    // Current vertices being considered
                    const pA = polyA[i % lenA];
                    const pB = polyB[(j + offsetB) % lenB]; 
                    const distSq = pA.distanceToSquared(pB);

                    // Transition 1: Move along Poly A (i-1 -> i)
                    // Triangle created: (A[i-1], B[j], A[i])
                    if (i > 0) {
                        const c = costTable[idx(i - 1, j)];
                        if (c !== Infinity) {
                            const pPrevA = polyA[(i - 1) % lenA];
                            // Add Area Cost to prevent degenerate giant triangles
                            const triArea = getTriArea2x(pPrevA, pB, pA) * 0.5;
                            const newCost = c + distSq + (triArea * AREA_WEIGHT);

                            if (newCost < costTable[idx(i, j)]) {
                                costTable[idx(i, j)] = newCost;
                                fromTable[idx(i, j)] = 1;
                            }
                        }
                    }

                    // Transition 2: Move along Poly B (j-1 -> j)
                    // Triangle created: (A[i], B[j-1], B[j])
                    if (j > 0) {
                        const c = costTable[idx(i, j - 1)];
                        if (c !== Infinity) {
                            const pPrevB = polyB[(j - 1 + offsetB) % lenB];
                            // Add Area Cost to prevent degenerate giant triangles
                            const triArea = getTriArea2x(pA, pPrevB, pB) * 0.5;
                            const newCost = c + distSq + (triArea * AREA_WEIGHT);
                            
                            if (newCost < costTable[idx(i, j)]) {
                                costTable[idx(i, j)] = newCost;
                                fromTable[idx(i, j)] = 2;
                            }
                        }
                    }
                }
            }
            return costTable[idx(lenA, lenB)];
        };

        const generateIndices = (offsetB: number) => {
            solveForOffset(offsetB); 
            let curI = lenA;
            let curJ = lenB;
            while (curI > 0 || curJ > 0) {
                const dir = fromTable[idx(curI, curJ)];
                const vA_curr = idxStartA + (curI % lenA);
                const vB_curr = idxStartB + ((curJ + offsetB) % lenB);
                if (dir === 1) {
                    const vA_prev = idxStartA + safeMod(curI - 1, lenA);
                    rawIndices.push(vA_prev, vB_curr, vA_curr);
                    curI--;
                } else {
                    const vB_prev = idxStartB + safeMod(curJ - 1 + offsetB, lenB);
                    rawIndices.push(vA_curr, vB_prev, vB_curr);
                    curJ--;
                }
            }
        };

        let bestOffset = 0;
        let minTotalCost = Infinity;
        let geoBestOffset = 0;
        let minGeoDist = Infinity;
        for(let i=0; i<lenB; i++) {
            const d = polyA[0].distanceToSquared(polyB[i]);
            if(d < minGeoDist) { minGeoDist = d; geoBestOffset = i; }
        }

        let searchStart = 0;
        let searchCount = lenB;
        if (lenB > 60) {
            searchStart = geoBestOffset - 10;
            searchCount = 20;
        }

        for (let k = 0; k < searchCount; k++) {
            const offset = safeMod(searchStart + k, lenB);
            const cost = solveForOffset(offset);
            
            // Add seam cost (distance between start points)
            const pA = polyA[0];
            const pB = polyB[offset];
            const seamDistSq = pA.distanceToSquared(pB);
            const totalCost = cost + seamDistSq;

            if (totalCost < minTotalCost) {
                minTotalCost = totalCost;
                bestOffset = offset;
            }
        }
        generateIndices(bestOffset);
    };

    if (shape.type === "polygon") {
        const poly = shape as FootprintPolygon;
        const baseData = getPolyOutlineWithFeatures(poly.points, 0, 0, params, contextFp, allFootprints, resolution);

        let area = 0;
        for (let i = 0; i < baseData.points.length; i++) {
            const j = (i + 1) % baseData.points.length;
            area += baseData.points[i].x * baseData.points[j].y - baseData.points[j].x * baseData.points[i].y;
        }
        // If our input is CW (negative area), reverse it to prevent loft twisting.
        if (area < 0) {
            baseData.points.reverse();
        }

        if (baseData.points.length < 3) {
            console.warn("Fillet generation failed: insufficient polygon points.");
            return null;
        }

        const baseCS = new manifoldModule.CrossSection([baseData.points.map(p => [p.x, p.y])], "EvenOdd");
        const steps: { z: number, offset: number }[] = [];
        const wallBottomZ = -(depth - filletRadius);
        steps.push({ z: 0, offset: 0 });
        if (Math.abs(wallBottomZ) > 0.001) steps.push({ z: wallBottomZ, offset: 0 });
        const filletSteps = 8;
        for(let i=1; i<=filletSteps; i++) {
            const theta = (i / filletSteps) * (Math.PI / 2);
            steps.push({ z: wallBottomZ - Math.sin(theta) * filletRadius, offset: (1 - Math.cos(theta)) * filletRadius });
        }

        const layerData: { z: number, contours: THREE.Vector2[][], startIdx: number }[] = [];
        let totalVerts = 0;
        steps.forEach(step => {
            let processedPolys: THREE.Vector2[][] = [];
            if (step.offset > 0.001) {
                const cs = baseCS.offset(-step.offset, "Miter", 2.0);
                const rawPolys = cs.toPolygons().map((p: any) => p.map((pt: any) => new THREE.Vector2(pt[0], pt[1])));
                // Clean up duplicate points which confuse triangulation
                processedPolys = rawPolys.map((poly: any) => {
                    const clean = [poly[0]];
                    for(let i=1; i<poly.length; i++) {
                        if(poly[i].distanceToSquared(clean[clean.length-1]) > 1e-9) clean.push(poly[i]);
                    }
                    if(clean.length > 2 && clean[clean.length-1].distanceToSquared(clean[0]) < 1e-9) clean.pop();
                    
                    // Ensure consistent winding order (CCW/Positive Area)
                    // Manifold offsets might invert winding for certain operations.
                    let area = 0;
                    for (let i = 0; i < clean.length; i++) {
                        const j = (i + 1) % clean.length;
                        area += clean[i].x * clean[j].y - clean[j].x * clean[i].y;
                    }
                    if (area < 0) clean.reverse();

                    return clean;
                }).filter((p: any) => p.length >= 3);
            } else {
                processedPolys = [baseData.points];
            }

            layerData.push({ z: step.z, contours: processedPolys, startIdx: totalVerts });
            processedPolys.forEach((contour: THREE.Vector2[]) => {
                contour.forEach(p => { rawVertices.push(p.x, step.z, -p.y); totalVerts++; });
            });
        });

        // Triangulate Top and Bottom Caps
        const triangulateFlat = (contours: THREE.Vector2[][], startIdx: number, reverse: boolean) => {
            let offset = startIdx;
            contours.forEach(c => {
                const tris = THREE.ShapeUtils.triangulateShape(c, []);
                tris.forEach(t => {
                    if (reverse) rawIndices.push(offset + t[0], offset + t[2], offset + t[1]);
                    else rawIndices.push(offset + t[0], offset + t[1], offset + t[2]);
                });
                offset += c.length;
            });
        };
        triangulateFlat(layerData[0].contours, layerData[0].startIdx, false);
        triangulateFlat(layerData[layerData.length - 1].contours, layerData[layerData.length - 1].startIdx, true);

        // Loft between layers
        for(let l=0; l<layerData.length-1; l++) {
            const up = layerData[l];
            const low = layerData[l+1];
            
            low.contours.forEach((lowPoly, iLow) => {
                const lowCenter = new THREE.Vector2();
                lowPoly.forEach(p => lowCenter.add(p));
                lowCenter.divideScalar(lowPoly.length);
                let bestUpIdx = -1, minDist = Infinity;
                up.contours.forEach((upPoly, iUp) => {
                    const upCenter = new THREE.Vector2();
                    upPoly.forEach(p => upCenter.add(p));
                    upCenter.divideScalar(upPoly.length);
                    const d = upCenter.distanceToSquared(lowCenter);
                    if (d < minDist) { minDist = d; bestUpIdx = iUp; }
                });
                if (bestUpIdx !== -1) {
                    let sA = up.startIdx; for(let i=0; i<bestUpIdx; i++) sA += up.contours[i].length;
                    let sB = low.startIdx; for(let i=0; i<iLow; i++) sB += low.contours[i].length;
                    triangulateRobust(up.contours[bestUpIdx], lowPoly, sA, sB);
                }
                else {
                    console.warn("Fillet generation warning: could not find matching upper contour for lofting.");
                }
            });
        }
    } else {
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
                
                // Match Three.js Shape resolution (defaults to 32 segments per curve)
                const segCorner = 32; 
                
                const quadrants = [
                    { x: halfW - cr, y: halfH - cr, startAng: 0 },         
                    { x: -halfW + cr, y: halfH - cr, startAng: Math.PI/2 },
                    { x: -halfW + cr, y: -halfH + cr, startAng: Math.PI }, 
                    { x: halfW - cr, y: -halfH + cr, startAng: 1.5*Math.PI}
                ];

                quadrants.forEach(q => {
                    const startAng = q.startAng;
                    const endAng = startAng + Math.PI/2;
                    
                    // 1. Calculate Bezier Control Points
                    // P0: Start of arc (on the edge)
                    const p0X = q.x + cr * Math.cos(startAng);
                    const p0Y = q.y + cr * Math.sin(startAng);
                    
                    // P2: End of arc (on the next edge)
                    const p2X = q.x + cr * Math.cos(endAng);
                    const p2Y = q.y + cr * Math.sin(endAng);

                    // P1: Control Point (The sharp corner of the bounding box)
                    // We derive this by adding the corner offset components
                    const cpX = q.x + cr * (Math.cos(startAng) + Math.cos(endAng));
                    const cpY = q.y + cr * (Math.sin(startAng) + Math.sin(endAng));

                    // 2. Generate Points along the Quadratic Curve
                    for(let i=0; i<=segCorner; i++) {
                        const t = i / segCorner;
                        const invT = 1 - t;
                        
                        // Quadratic Bezier Basis: (1-t)^2, 2(1-t)t, t^2
                        const c0 = invT * invT;
                        const c1 = 2 * invT * t;
                        const c2 = t * t;
                        
                        const vx = c0 * p0X + c1 * cpX + c2 * p2X;
                        const vy = c0 * p0Y + c1 * cpY + c2 * p2Y;
                        
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
                    clean.push(rawPoints[i]);
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
        
        if (vertsPerLayer < 3) {
            console.warn("Fillet generation failed: insufficient shape complexity, less than 3 vertices.");
            return null;
        }

        const safeR = Math.min(filletRadius, minDimension / 2 - 0.01, depth);
        if (safeR <= 0.001) {
            console.warn("Fillet generation failed: fillet radius too large for shape dimensions.");
            return null;
        }

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

        let topologyValid = true;
        layers.forEach((layer) => {
            const points = getContour(layer.offset);
            if (points.length !== vertsPerLayer) topologyValid = false;
            if (!topologyValid) return;
            points.forEach(p => rawVertices.push(p.x, layer.z, -p.y));
        });

        if (!topologyValid) {
            console.warn("Fillet generation failed: inconsistent topology between layers.");
            return null;
        }

        const getIdx = (layerIdx: number, ptIdx: number) => layerIdx * vertsPerLayer + (ptIdx % vertsPerLayer);
        const pushTri = (i1: number, i2: number, i3: number) => rawIndices.push(i1, i2, i3);

        const topFaces = THREE.ShapeUtils.triangulateShape(baseProfile, []);
        topFaces.forEach(face => pushTri(getIdx(0, face[0]), getIdx(0, face[1]), getIdx(0, face[2])));

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
        const botFaces = THREE.ShapeUtils.triangulateShape(botProfile, []);
        botFaces.forEach(face => pushTri(getIdx(lastL, face[0]), getIdx(lastL, face[2]), getIdx(lastL, face[1])));
    }

    const uniqueVerts: number[] = [];
    const vertMap = new Map<string, number>();
    const oldToNew = new Int32Array(rawVertices.length / 3);
    const PRECISION = 1e-5;
    const decimalShift = 1 / PRECISION;

    for(let i=0; i<rawVertices.length / 3; i++) {
        const x = rawVertices[i*3], y = rawVertices[i*3+1], z = rawVertices[i*3+2];
        const key = `${Math.round(x*decimalShift)}_${Math.round(y*decimalShift)}_${Math.round(z*decimalShift)}`;
        if (vertMap.has(key)) oldToNew[i] = vertMap.get(key)!;
        else { const newIdx = uniqueVerts.length / 3; uniqueVerts.push(x, y, z); vertMap.set(key, newIdx); oldToNew[i] = newIdx; }
    }
    const finalIndices: number[] = [];
    for(let i=0; i<rawIndices.length; i+=3) {
        const a = oldToNew[rawIndices[i]], b = oldToNew[rawIndices[i+1]], c = oldToNew[rawIndices[i+2]];
        if (a === b || b === c || a === c) continue;
        finalIndices.push(a, b, c);
    }

    const vertProperties = new Float32Array(uniqueVerts);
    const triVerts = new Uint32Array(finalIndices);

    try {
        const mesh = new manifoldModule.Mesh();
        mesh.numProp = 3;
        mesh.vertProperties = vertProperties;
        mesh.triVerts = triVerts;
        return { manifold: new manifoldModule.Manifold(mesh), vertProperties, triVerts };
    } catch (e) { 
        console.error("Failed to create fillet manifold", e);
        return { manifold: null, vertProperties, triVerts };
    }
}

// ------------------------------------------------------------------
// MESH PARSING
// ------------------------------------------------------------------

const meshGeometryCache = new Map<string, THREE.BufferGeometry>();

async function loadMeshGeometry(asset: MeshAsset): Promise<THREE.BufferGeometry | null> {
    const cacheKey = asset.id;
    if (meshGeometryCache.has(cacheKey)) {
        return meshGeometryCache.get(cacheKey)!.clone();
    }

    const buffer = base64ToArrayBuffer(asset.content);

    try {
        console.log(`Loading mesh asset ${asset.id} of format ${asset.format}`);
        if (asset.format === "stl") {
            const loader = new STLLoader();
            const geometry = loader.parse(buffer);
            meshGeometryCache.set(cacheKey, geometry);
            return geometry;
        } else if (asset.format === "obj") {
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
                 if (merged) {
                    meshGeometryCache.set(cacheKey, merged);
                 }
                 return merged;
             }
        } else if (asset.format === "glb") {
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
                        if (merged) {
                            meshGeometryCache.set(cacheKey, merged);
                        }
                        resolve(merged);
                    } else {
                        resolve(null);
                    }
                }, (err) => {
                    console.error("GLB Parse error", err);
                    resolve(null);
                });
            });
        } else if (asset.format === "step") {
            console.warn("Legacy STEP format found on main thread. Processing should be handled by worker.");
            return null; // The healing effect will catch this and convert it
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
  manifoldModule,
  registerMesh
}: {
  layer: StackupLayer;
  footprint: Footprint;
  allFootprints: Footprint[];
  params: Parameter[];
  bottomZ: number;
  thickness: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  manifoldModule: any;
  registerMesh?: (id: string, mesh: THREE.Mesh | null) => void;
}) => {
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxY - bounds.minY; 
  
  const boardShape = useMemo(() => {
      if (!footprint.isBoard) return null;

      // Resolve Assigned Board Outline
      const assignments = footprint.boardOutlineAssignments || {};
      const assignedId = assignments[layer.id];
      let outlineShape = footprint.shapes.find(s => s.id === assignedId) as FootprintBoardOutline | undefined;

      // Fallback: If no assignment, use the first available outline
      if (!outlineShape) {
          outlineShape = footprint.shapes.find(s => s.type === "boardOutline") as FootprintBoardOutline | undefined;
      }

      if (outlineShape) {
          return createBoardShape(outlineShape, params, footprint, allFootprints);
      }
      return null;
  }, [footprint, layer.id, params, allFootprints]);

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
    }

    try {
        const { Manifold, CrossSection } = manifoldModule;
        const CSG_EPSILON = 0.001;

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

        // Track processed cuts to detect overlaps. 
        // We store the 2D CrossSection (transformed to world space) to check intersections.
        const processedCuts: { depth: number, cs: any, id: string }[] = [];

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
                 safeRadius = Math.min(safeRadius, d/2 - 0.05);
            } else if (shape.type === "rect") {
                 const w = evaluateExpression((shape as FootprintRect).width, params);
                 const h = evaluateExpression((shape as FootprintRect).height, params);
                 safeRadius = Math.min(safeRadius, Math.min(w, h)/2 - 0.05);
            } else if (shape.type === "line") {
                 const t = evaluateExpression((shape as FootprintLine).thickness, params);
                 safeRadius = Math.min(safeRadius, t/2 - 0.05);
            }
            if (safeRadius < 0) safeRadius = 0;

            const isPartialCut = actualDepth < thickness - CSG_EPSILON;
            const hasRadius = safeRadius > CSG_EPSILON;
            const shouldRound = isPartialCut && hasRadius;

            const localX = item.x - centerX;
            const localZ = centerZ - item.y;
            const globalRot = item.rotation; 

            // 1. Generate 2D CrossSection (CS)
            // This replaces the old 'createTool' which returned 3D objects immediately.
            const getCrossSection = () => {
                let cs = null;
                if (shape.type === "circle") {
                    const d = evaluateExpression((shape as any).diameter, params);
                    if (d > 0) cs = collect(CrossSection.circle(d/2, 32));
                } else if (shape.type === "rect") {
                    const w = evaluateExpression((shape as FootprintRect).width, params);
                    const h = evaluateExpression((shape as FootprintRect).height, params);
                    const crRaw = evaluateExpression((shape as FootprintRect).cornerRadius, params);
                    const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                    
                    if (w > 0 && h > 0) {
                        cs = collect(CrossSection.square([w, h], true));
                        if (cr > 0.001) cs = collect(cs.offset(-cr, "Round", 8)).offset(cr, "Round", 8);
                    }
                } else if (shape.type === "line") {
                    const t = evaluateExpression((shape as FootprintLine).thickness, params);
                    const validT = t > 0 ? t : 0.01;
                    const s = createLineShape(shape as FootprintLine, params, item.contextFp, allFootprints, validT);
                    if (s) cs = collect(shapeToManifold(manifoldModule, s));
                } else if (shape.type === "polygon") {
                    const poly = shape as FootprintPolygon;
                    const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, 32);
                    if (pts.length > 2) {
                        cs = new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd");
                    }
                }
                return cs;
            };

            let currentCS = getCrossSection();
            
            if (currentCS) {
                // Apply Global Transform to the 2D CrossSection
                // 1. Rotate (2D rotation around Z is same as 3D rotation around Y for the footprint)
                currentCS = collect(currentCS.rotate(globalRot));
                
                // 2. Translate
                // IMPORTANT: Manifold 2D Y maps to 3D -Z after the extrusion rotate([-90,0,0]).
                // To position at `localZ`, we must translate 2D Y to `-localZ`.
                currentCS = collect(currentCS.translate([localX, -localZ]));
            }

            // 2. Check for Overlaps with Deeper Cuts
            let isRestorative = false;
            
            if (currentCS) {
                for (const prev of processedCuts) {
                    // If a previous shape is deeper than us...
                    if (prev.depth > actualDepth + CSG_EPSILON) {
                        // ...and we overlap in 2D
                        const intersection = collect(currentCS.intersect(prev.cs));
                        if (!intersection.isEmpty()) {
                            isRestorative = true;
                            break;
                        }
                    }
                }
                // Store for future checks
                processedCuts.push({ depth: actualDepth, cs: currentCS, id: shape.id });
            }

            // 3. Perform 3D Boolean Operations
            const throughHeight = thickness + 0.2; 
            
            if (isRestorative) {
                // === 3-STEP PROCESS (Robust for overlaps) ===
                // Cut through -> Fill back -> Subtract fillet
                
                const toolCutThrough = collect(collect(currentCS!.extrude(throughHeight)).translate([0, 0, -throughHeight/2]));
                const toolAligned = collect(toolCutThrough.rotate([-90, 0, 0])); 
                // No need to translate [localX, 0, localZ] here because the CS was already translated!
                // We just need to align height (Y).
                
                const diff = collect(Manifold.difference(base, toolAligned));
                base = diff;

                // Add Back
                let fillHeight = thickness - actualDepth;
                if (shouldRound) fillHeight += safeRadius;

                if (fillHeight > CSG_EPSILON) {
                    const toolFill = collect(collect(currentCS!.extrude(fillHeight)).translate([0, 0, -fillHeight/2]));
                    const fillAligned = collect(toolFill.rotate([-90, 0, 0]));
                    
                    const fillY = layer.carveSide === "Top" 
                        ? (-thickness / 2 + fillHeight / 2) 
                        : (thickness / 2 - fillHeight / 2);
                        
                    const moved = collect(fillAligned.translate([0, fillY, 0]));
                    base = collect(Manifold.union(base, moved));
                }
            } else {
                // === 1-STEP PROCESS (Optimized) ===
                // Only subtract what is needed.
                
                if (!shouldRound && currentCS && actualDepth > CSG_EPSILON) {
                    // Standard Cut (No Fillet)
                    const toolCut = collect(collect(currentCS.extrude(actualDepth)).translate([0, 0, -actualDepth/2]));
                    const toolAligned = collect(toolCut.rotate([-90, 0, 0]));

                    const cutY = layer.carveSide === "Top"
                        ? (thickness / 2 - actualDepth / 2)
                        : (-thickness / 2 + actualDepth / 2);

                    const moved = collect(toolAligned.translate([0, cutY, 0]));
                    base = collect(Manifold.difference(base, moved));
                }
                // If shouldRound is true, we skip the hard cut entirely here!
                // We will only subtract the fillet mesh below.
            }

            // 4. Fillet Subtraction (Common to both paths if enabled)
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
                    
                    base = collect(Manifold.difference(base, final));

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
        frustumCulled={false}
    >
      <meshStandardMaterial 
          color={hasError ? "#ff6666" : layer.color} 
          transparent={!hasError} 
          opacity={hasError ? 1.0 : 0.9} 
          flatShading 
          side={THREE.FrontSide} 
          visible={true} 
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
      />
      {geometry && (
            <Edges 
                key={geometry.uuid}      // Force remount when geometry instance changes
                geometry={geometry}      // Explicitly pass geometry to be safe
                threshold={15} 
                color="#222" 
            />
        )}
      {hasError && geometry && (
        <mesh geometry={geometry} frustumCulled={false}>
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
        } else if (s.type === "union") {
             const u = s as FootprintUnion;
             const x = evaluate(u.x, params);
             const y = evaluate(u.y, params);
             const angle = evaluate(u.angle, params);

             const uMat = new THREE.Matrix4();
             uMat.makeRotationY(angle * Math.PI / 180);
             uMat.setPosition(x, 0, -y);

             const globalUMat = transform.clone().multiply(uMat);

             // Recurse using the union's internal shapes
             result = result.concat(flattenMeshes(
                 u as unknown as Footprint,
                 allFootprints,
                 params,
                 globalUMat,
                 ancestorRefId || u.id
             ));
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
    meshAssets,
    isSelected,
    onSelect,
    onUpdate
}: { 
    meshData: FlatMesh, 
    meshAssets: MeshAsset[],
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
        const asset = meshAssets.find(a => a.id === mesh.meshId);
        if (asset) {
            loadMeshGeometry(asset).then(geom => {
                if(mounted && geom) setGeometry(geom);
            });
        }
        return () => { mounted = false; };
    }, [mesh, meshAssets]);

    // 1. Calculate transforms from the matrix immediately during render
    // This ensures we have the values ready to pass to the props
    const position = useMemo(() => new THREE.Vector3().setFromMatrixPosition(globalTransform), [globalTransform]);
    const quaternion = useMemo(() => new THREE.Quaternion().setFromRotationMatrix(globalTransform), [globalTransform]);
    const scale = useMemo(() => new THREE.Vector3().setFromMatrixScale(globalTransform), [globalTransform]);

    // REMOVED: The useEffect/useLayoutEffect for syncing ghostRef. 
    // We now handle this via props on the <object3D> below.

    const handleChange = () => {
        if (!ghostRef.current || !isEditable) return;
        
        const ghostPos = ghostRef.current.position;
        const ghostRot = ghostRef.current.rotation; 
        
        // Compare against the authoritative state
        const currentPos = new THREE.Vector3().setFromMatrixPosition(globalTransform);
        const currentRot = new THREE.Euler().setFromRotationMatrix(globalTransform);

        const dx = ghostPos.x - currentPos.x;
        const dy = ghostPos.y - currentPos.y;
        const dz = ghostPos.z - currentPos.z;
        
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
                // Apply transforms to visible mesh
                position={position}
                quaternion={quaternion}
                scale={scale}
                frustumCulled={false}
                onClick={(e) => {
                    e.stopPropagation();
                    onSelect();
                }}
            >
                {mesh.renderingType === "wireframe" ? (
                    <meshBasicMaterial color={color} wireframe />
                ) : (
                    <>
                        <meshStandardMaterial 
                            color={color} 
                            emissive={emissive} 
                            emissiveIntensity={0.2}
                            polygonOffset
                            polygonOffsetFactor={1}
                            polygonOffsetUnits={1}
                        />
                        <Edges threshold={15} color="#222" />
                    </>
                )}
            </mesh>
            
            {isSelected && isEditable && (
                <>
                    {/* 
                       FIX: Pass props directly to initialize correctly.
                       Use `undefined` when dragging so React doesn't overwrite the Gizmo's work.
                    */}
                    <object3D 
                        ref={ghostRef} 
                        position={isDragging ? undefined : position}
                        quaternion={isDragging ? undefined : quaternion}
                        scale={isDragging ? undefined : scale}
                    />
                    
                    <TransformControls 
                        ref={controlRef}
                        object={ghostRef as any} 
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

const Footprint3DView = forwardRef<Footprint3DViewHandle, Props>(({ footprint, allFootprints, params, stackup, meshAssets, visibleLayers, is3DActive, selectedId, onSelect, onUpdateMesh }, ref) => {
  const controlsRef = useRef<any>(null);
  const meshRefs = useRef<Record<string, THREE.Mesh>>({});
  const hasInitiallySnapped = useRef(false);
  const [firstMeshReady, setFirstMeshReady] = useState(false);
  
  const [manifoldModule, setManifoldModule] = useState<any>(null);

  // WORKER MANAGEMENT
  const workerRef = useRef<Worker | null>(null);
  const workerCallbacks = useRef<Map<string, {resolve: (v:any)=>void, reject: (e:any)=>void}>>(new Map());

  useEffect(() => {
    // 1. Manifold Init
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

    // 2. Worker Init
    if (!workerRef.current) {
        const worker = new MeshWorker();
        workerRef.current = worker;
        
        // NEW: Catch startup errors (like import failures)
        worker.onerror = (err: any) => {
            console.error("Worker Initialization Error:", err.message, err.filename, err.lineno);
        };

        worker.onmessage = (e: MessageEvent) => {
            const { id, type, payload, error } = e.data;
            if (workerCallbacks.current.has(id)) {
                const cb = workerCallbacks.current.get(id)!;
                if (type === "error") cb.reject(new Error(error));
                else cb.resolve(payload);
                workerCallbacks.current.delete(id);
            }
        };

        // Send OCCT Init
        const initId = crypto.randomUUID();
        worker.postMessage({ 
            id: initId, 
            type: "init", 
            payload: { wasmUrl: occtWasmUrl } 
        });
        
        workerCallbacks.current.set(initId, { 
            resolve: () => console.log("Mesh Worker Initialized"), 
            reject: (e) => console.error("Mesh Worker Failed Init", e) 
        });
    }

    return () => {
        workerRef.current?.terminate();
        workerRef.current = null;
    };
  }, []);

  const callWorker = async (type: string, payload: any): Promise<any> => {
      if (!workerRef.current) throw new Error("Worker not initialized");
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
          workerCallbacks.current.set(id, { resolve, reject });
          workerRef.current!.postMessage({ id, type, payload });
      });
  };

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
        
        // Read file content as ArrayBuffer to pass to worker
        const buffer = await file.arrayBuffer();
        
        const format = (ext === "stp" || ext === "step") ? "step" : (ext === "obj" ? "obj" : (ext === "glb" || ext === "gltf" ? "glb" : "stl"));
        
        try {
            // Offload to worker
            const result = await callWorker("convert", {
                buffer,
                format,
                fileName: file.name
            });
            
            return {
                id: crypto.randomUUID(),
                name: file.name,
                content: result.base64,
                format: result.format, // Should be 'glb'
                renderingType: "solid",
                x: "0", y: "0", z: "0",
                rotationX: "0", rotationY: "0", rotationZ: "0"
            } as any;
        } catch (e) {
            console.error("Worker Conversion Failed", e);
            // Alert user visually since the spinner just dies
            alert(`File processing failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    },
    convertMeshToGlb: async (mesh: FootprintMesh): Promise<FootprintMesh | null> => {
        // mesh argument here is a mock passed by the healer with embedded content
        const mock = mesh as any;

        try {
            const buffer = base64ToArrayBuffer(mock.content);
            const result = await callWorker("convert", {
                buffer,
                format: mock.format,
                fileName: mock.name
            });
            
            return {
                ...mesh,
                content: result.base64,
                format: result.format
            } as any;
        } catch (e) {
             console.error("Worker Healing Failed", e);
             return null;
        }
    }
  }));

  const bounds = useMemo(() => {
    const PADDING = 10;
    const outlines = footprint.shapes.filter(s => s.type === "boardOutline") as FootprintBoardOutline[];

    if (footprint.isBoard && outlines.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        outlines.forEach(outline => {
            const originX = evaluateExpression(outline.x, params);
            const originY = evaluateExpression(outline.y, params);
            outline.points.forEach(pRaw => {
                const p = resolvePoint(pRaw, footprint, allFootprints, params);
                const x = originX + p.x;
                const y = originY + p.y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            });
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
        camera={{ position: [50, 50, 50], fov: 45, near: 0.1, far: 100000 }}
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
                    meshAssets={meshAssets}
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