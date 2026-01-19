import * as THREE from "three";
import { Footprint, Parameter, FootprintShape, FootprintRect, FootprintLine, FootprintPolygon } from "../types";
import { evaluateExpression, resolvePoint } from "../utils/footprintUtils";
import { getLineOutlinePoints } from "./meshUtils";
import { Point } from "../types"; // Needed for getPolyOutlineWithFeatures signature

// --- COMPLEX GEOMETRY ALGORITHMS ---

/**
 * Enhanced discretization that tracks the indices of sharp corners
 */
function getPolyOutlineWithFeatures(
    points: Point[],
    originX: number,
    originY: number,
    params: Parameter[],
    rootFp: Footprint,
    allFootprints: Footprint[],
    resolution: number,
    parentTransform?: { x: number, y: number, angle: number }
): { points: THREE.Vector2[], cornerIndices: number[] } {
    if (points.length < 3) return { points: [], cornerIndices: [] };

    const pathPoints: THREE.Vector2[] = [];
    const cornerIndices: number[] = [];

    const curveDivisions = Math.max(4, Math.ceil(resolution / 2));

    for (let i = 0; i < points.length; i++) {
        cornerIndices.push(pathPoints.length);

        const currRaw = points[i];
        const nextRaw = points[(i + 1) % points.length];

        const curr = resolvePoint(currRaw, rootFp, allFootprints, params, parentTransform);
        const next = resolvePoint(nextRaw, rootFp, allFootprints, params, parentTransform);

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

            const sp = curve.getPoints(curveDivisions);
            sp.pop(); 
            sp.forEach(p => pathPoints.push(p));
        } else {
            pathPoints.push(new THREE.Vector2(x1, y1));
        }
    }

    let area = 0;
    for (let i = 0; i < pathPoints.length; i++) {
        const j = (i + 1) % pathPoints.length;
        area += pathPoints[i].x * pathPoints[j].y - pathPoints[j].x * pathPoints[i].y;
    }
    if (area < 0) {
        pathPoints.reverse();
        const len = pathPoints.length;
        const reversedCorners = cornerIndices.map(idx => (len - idx) % len).sort((a,b) => a-b);
        return { points: pathPoints, cornerIndices: reversedCorners };
    }

    return { points: pathPoints, cornerIndices };
}

export function generateProceduralTool(
    manifoldModule: any,
    shape: FootprintShape, 
    params: Parameter[],
    depth: number, 
    topRadius: number,
    bottomRadius: number,
    rootFp: Footprint,
    allFootprints: Footprint[],
    resolution = 32,
    overrideCS?: any,
    parentTransform?: { x: number, y: number, angle: number }
) {
    const localGarbage: any[] = [];
    const collectLocal = <T>(obj: T): T => { if(obj && (obj as any).delete) localGarbage.push(obj); return obj; };
    
    let effTopR = topRadius;
    let effBottomR = bottomRadius;
    const maxTotal = depth - 0.001; 

    if (effTopR + effBottomR > maxTotal && maxTotal > 0) {
        const halfDepth = maxTotal / 2;
        if (effTopR > halfDepth) effTopR = halfDepth;
        if (effBottomR > halfDepth) effBottomR = halfDepth;
    } else if (maxTotal <= 0) {
        effTopR = 0;
        effBottomR = 0;
    }

    const steps: { z: number, offset: number }[] = [];
    const arcSteps = Math.max(3, Math.ceil(resolution / 4));

    if (effTopR > 0.001) {
        for(let i=0; i<=arcSteps; i++) {
            const theta = (Math.PI / 2) * (1 - i / arcSteps);
            const z = -effTopR + effTopR * Math.sin(theta);
            const off = -effTopR + effTopR * Math.cos(theta); 
            steps.push({ z, offset: off });
        }
    } else {
        steps.push({ z: 0, offset: 0 });
    }

    const availableDepth = depth - effTopR;
    const safeBottomR = Math.min(effBottomR, availableDepth);
    const verticalEndZ = -(depth - safeBottomR);

    if (safeBottomR > 0.001) {
        if (availableDepth > safeBottomR + 0.001) {
            steps.push({ z: verticalEndZ, offset: 0 });
        }
        for(let i=1; i<=arcSteps; i++) {
            const theta = (i / arcSteps) * (Math.PI / 2);
            const z = verticalEndZ - safeBottomR * Math.sin(theta);
            const off = safeBottomR * (1 - Math.cos(theta));
            steps.push({ z, offset: off });
        }
    } else {
        steps.push({ z: -depth, offset: 0 });
    }

    for(let i=steps.length-1; i>0; i--) {
        if (Math.abs(steps[i].z - steps[i-1].z) < 0.0001) {
            steps.splice(i, 1);
        }
    }

    const getContourFromShape = (offset: number): THREE.Vector2[] => {
        let rawPoints: THREE.Vector2[] = [];
        
        if (shape.type === "circle") {
            const d = evaluateExpression((shape as any).diameter, params);
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
            
            const w = Math.max(0.001, wRaw - offset * 2);
            const h = Math.max(0.001, hRaw - offset * 2);
            
            const crRaw = evaluateExpression((shape as FootprintRect).cornerRadius, params);
            let cr = Math.max(0, crRaw - offset);
            
            const halfW = w / 2;
            const halfH = h / 2;
            const limit = Math.min(halfW, halfH);
            if (cr > limit - 0.001) cr = limit - 0.001;
            
            const segCorner = Math.max(4, Math.ceil(resolution / 4));
            
            const quadrants = [
                { x: halfW - cr, y: halfH - cr, startAng: 0 },         
                { x: -halfW + cr, y: halfH - cr, startAng: Math.PI/2 },
                { x: -halfW + cr, y: -halfH + cr, startAng: Math.PI }, 
                { x: halfW - cr, y: -halfH + cr, startAng: 1.5*Math.PI}
            ];
            quadrants.forEach(q => {
                const startAng = q.startAng;
                const endAng = startAng + Math.PI/2;
                const p0X = q.x + cr * Math.cos(startAng);
                const p0Y = q.y + cr * Math.sin(startAng);
                const p2X = q.x + cr * Math.cos(endAng);
                const p2Y = q.y + cr * Math.sin(endAng);
                const cpX = q.x + cr * (Math.cos(startAng) + Math.cos(endAng));
                const cpY = q.y + cr * (Math.sin(startAng) + Math.sin(endAng));
                for(let i=0; i<=segCorner; i++) {
                    const t = i / segCorner;
                    const invT = 1 - t;
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
            const effectiveT = Math.max(0.001, t - offset * 2);
            rawPoints = getLineOutlinePoints(shape as FootprintLine, params, effectiveT, resolution, rootFp, allFootprints, parentTransform);
        }

        if (rawPoints.length > 0) {
            const clean: THREE.Vector2[] = [rawPoints[0]];
            for(let i=1; i<rawPoints.length; i++) clean.push(rawPoints[i]);
            let area = 0;
            for (let i = 0; i < clean.length; i++) {
                const j = (i + 1) % clean.length;
                area += clean[i].x * clean[j].y - clean[j].x * clean[i].y;
            }
            if (area < 0) clean.reverse();
            return clean;
        }
        return rawPoints;
    };

    let baseCSforComplex: any = null;

    if (overrideCS || shape.type === "polygon") {
        if (overrideCS) {
            baseCSforComplex = overrideCS;
        } else {
            const poly = shape as FootprintPolygon;
            const baseData = getPolyOutlineWithFeatures(poly.points, 0, 0, params, rootFp, allFootprints, resolution, parentTransform);
            const pts = baseData.points;
            if (pts.length >= 3) {
                baseCSforComplex = collectLocal(new manifoldModule.CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
            }
        }
    }

    try {
        if (baseCSforComplex) {
            const polys = baseCSforComplex.toPolygons();
            if (polys.length > 1) {
                throw new Error("Internal islands detected; forcing stairstep fallback.");
            }
        }

        const rawVertices: number[] = [];
        const layerData: { z: number, contours: THREE.Vector2[][], startIdx: number }[] = [];
        let totalVerts = 0;

        steps.forEach(step => {
            let processedPolys: THREE.Vector2[][] = [];
            
            if (baseCSforComplex) {
                let cs = baseCSforComplex;
                if (Math.abs(step.offset) > 0.001) {
                    cs = collectLocal(baseCSforComplex.offset(-step.offset, "Miter", 2.0));
                } else {
                    cs = collectLocal(baseCSforComplex.offset(0, "Miter", 2.0));
                }
                
                const rawPolys = cs.toPolygons().map((p: any) => p.map((pt: any) => new THREE.Vector2(pt[0], pt[1])));
                processedPolys = rawPolys.map((poly: any) => {
                    const clean = [poly[0]];
                    for(let i=1; i<poly.length; i++) {
                        if(poly[i].distanceToSquared(clean[clean.length-1]) > 1e-9) clean.push(poly[i]);
                    }
                    if(clean.length > 2 && clean[clean.length-1].distanceToSquared(clean[0]) < 1e-9) clean.pop();
                    let area = 0;
                    for (let i = 0; i < clean.length; i++) {
                        const j = (i + 1) % clean.length;
                        area += clean[i].x * clean[j].y - clean[j].x * clean[i].y;
                    }
                    if (Math.abs(area) < 0.00001) return null;
                    return clean;
                }).filter((p: any) => p !== null && p.length >= 3);
            } else {
                const contour = getContourFromShape(step.offset);
                if (contour.length > 0) processedPolys = [contour];
            }

            layerData.push({ z: step.z, contours: processedPolys, startIdx: totalVerts });
            processedPolys.forEach((contour: THREE.Vector2[]) => {
                contour.forEach(p => { rawVertices.push(p.x, step.z, -p.y); totalVerts++; });
            });
        });

        // --- RESTORED TRIANGULATION LOGIC ---
        const rawIndices: number[] = [];
        const safeMod = (n: number, m: number) => ((n % m) + m) % m;

        // --- TRIANGULATION HELPERS ---
        const isPointInPoly = (pt: THREE.Vector2, poly: THREE.Vector2[]) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const xi = poly[i].x, yi = poly[i].y;
                const xj = poly[j].x, yj = poly[j].y;
                const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
                    (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        };

        const getSignedArea = (poly: THREE.Vector2[]) => {
            let area = 0;
            for (let i = 0; i < poly.length; i++) {
                const j = (i + 1) % poly.length;
                area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
            }
            return area * 0.5;
        };

        const triangulateFlat = (contours: THREE.Vector2[][], startIdx: number, reverse: boolean) => {
            const contourOffsets: number[] = [];
            let runningOffset = startIdx;
            contours.forEach(c => {
                contourOffsets.push(runningOffset);
                runningOffset += c.length;
            });

            const solids: { poly: THREE.Vector2[], idx: number }[] = [];
            const holes: { poly: THREE.Vector2[], idx: number }[] = [];

            contours.forEach((c, i) => {
                if (getSignedArea(c) > 0) {
                    solids.push({ poly: c, idx: i });
                } else {
                    holes.push({ poly: c, idx: i });
                }
            });

            solids.forEach(solid => {
                const myHoles = holes.filter(h => isPointInPoly(h.poly[0], solid.poly));
                const holeArrays = myHoles.map(h => h.poly);
                const tris = THREE.ShapeUtils.triangulateShape(solid.poly, holeArrays);
                
                tris.forEach(t => {
                    const getGlobalIndex = (localIdx: number) => {
                        if (localIdx < solid.poly.length) return contourOffsets[solid.idx] + localIdx;
                        let remaining = localIdx - solid.poly.length;
                        for (let k = 0; k < myHoles.length; k++) {
                            const hLen = myHoles[k].poly.length;
                            if (remaining < hLen) return contourOffsets[myHoles[k].idx] + remaining;
                            remaining -= hLen;
                        }
                        return 0;
                    };
                    const a = getGlobalIndex(t[0]);
                    const b = getGlobalIndex(t[1]);
                    const c = getGlobalIndex(t[2]);
                    if (reverse) rawIndices.push(a, c, b);
                    else rawIndices.push(a, b, c);
                });
            });
        };

        // --- TRIANGULATION EXECUTION ---
        if (layerData.length > 0) {
            triangulateFlat(layerData[0].contours, layerData[0].startIdx, false);
            triangulateFlat(layerData[layerData.length - 1].contours, layerData[layerData.length - 1].startIdx, true);
        }

        // Triangulate between layers
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
            const AREA_WEIGHT = 4.0; 

            const getTriArea2x = (p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2) => {
                return Math.abs(p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
            };

            // Added 'strictMode' flag to allow fallback if geometry is impossible
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

                        // Transition 1: Move along Poly A
                        if (i > 0) {
                            const c = costTable[idx(i - 1, j)];
                            if (c !== Infinity) {
                                const pPrevA = polyA[(i - 1) % lenA];
                                const triArea = getTriArea2x(pPrevA, pB, pA) * 0.5;
                                const newCost = c + distSq + (triArea * AREA_WEIGHT);

                                if (newCost < costTable[idx(i, j)]) {
                                    costTable[idx(i, j)] = newCost;
                                    fromTable[idx(i, j)] = 1;
                                }
                            }
                        }

                        // Transition 2: Move along Poly B
                        if (j > 0) {
                            const c = costTable[idx(i, j - 1)];
                            if (c !== Infinity) {
                                const pPrevB = polyB[(j - 1 + offsetB) % lenB];
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
                
                // --- INFINITE LOOP PROTECTION ---
                let safety = 0;
                const MAX_STEPS = (lenA + lenB) * 2; 

                while ((curI > 0 || curJ > 0) && safety++ < MAX_STEPS) {
                    let dir = fromTable[idx(curI, curJ)];
                    
                    // --- FALLBACK FOR BROKEN PATHS ---
                    // If strict mode blocked all paths to this cell, dir will be 0.
                    if (dir === 0) {
                         if (curI > 0) dir = 1;
                         else dir = 2;
                    }

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
            
            // Find geometric best start to limit search space
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

        for(let l=0; l<layerData.length-1; l++) {
            const up = layerData[l];
            const low = layerData[l+1];
            
            const upToLow = new Map<number, number[]>();
            for(let i=0; i<up.contours.length; i++) upToLow.set(i, []);

            low.contours.forEach((lowPoly, iLow) => {
                const lowCenter = new THREE.Vector2();
                lowPoly.forEach(p => lowCenter.add(p));
                lowCenter.divideScalar(lowPoly.length);

                let bestUp = -1;
                let minDist = Infinity;

                up.contours.forEach((upPoly, iUp) => {
                    const upCenter = new THREE.Vector2();
                    upPoly.forEach(p => upCenter.add(p));
                    upCenter.divideScalar(upPoly.length);
                    const d = upCenter.distanceToSquared(lowCenter);
                    if (d < minDist) { minDist = d; bestUp = iUp; }
                });

                if (bestUp !== -1) upToLow.get(bestUp)!.push(iLow);
            });

            upToLow.forEach((childIndices, iUp) => {
                const upPoly = up.contours[iUp];
                if (childIndices.length === 1) {
                    const iLow = childIndices[0];
                    const lowPoly = low.contours[iLow];
                    let sA = up.startIdx; for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                    let sB = low.startIdx; for(let k=0; k<iLow; k++) sB += low.contours[k].length;
                    triangulateRobust(upPoly, lowPoly, sA, sB);
                } else if (childIndices.length === 0) {
                     let sA = up.startIdx; for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                     const tris = THREE.ShapeUtils.triangulateShape(upPoly, []);
                     tris.forEach(t => rawIndices.push(sA + t[0], sA + t[2], sA + t[1]));
                } else {
                    const holes = childIndices.map(i => low.contours[i]);
                    const holesReversed = holes.map(h => [...h].reverse());
                    const tris = THREE.ShapeUtils.triangulateShape(upPoly, holesReversed);
                    let sA = up.startIdx; for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                    tris.forEach(t => {
                        const resolve = (localIdx: number) => {
                            if (localIdx < upPoly.length) return sA + localIdx;
                            let rem = localIdx - upPoly.length;
                            for(let c=0; c<childIndices.length; c++) {
                                const hLen = holes[c].length;
                                if (rem < hLen) {
                                    const realChildIdx = childIndices[c];
                                    let sB = low.startIdx;
                                    for(let k=0; k<realChildIdx; k++) sB += low.contours[k].length;
                                    return sB + ((hLen - 1) - rem);
                                }
                                rem -= hLen;
                            }
                            return sA; 
                        };
                        rawIndices.push(resolve(t[0]), resolve(t[2]), resolve(t[1]));
                    });
                }
            });
        }

        const uniqueVerts: number[] = [];
        const vertMap = new Map<string, number>();
        const oldToNew = new Int32Array(rawVertices.length / 3);
        const decimalShift = 1 / 1e-5;

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

        const mesh = new manifoldModule.Mesh();
        mesh.numProp = 3;
        mesh.vertProperties = vertProperties;
        mesh.triVerts = triVerts;
        return { manifold: new manifoldModule.Manifold(mesh), vertProperties, triVerts };
        
        // Unreachable return in this specific stub, but needed for TS structure
        // return { manifold: new manifoldModule.Manifold(new manifoldModule.Mesh()), vertProperties: new Float32Array(), triVerts: new Uint32Array() };

    } catch (e) { 
        // console.warn(`[MeshWorker] Manual tool failed or fallback forced: ${e}`);
        
        const parts: any[] = [];
        let fallbackSteps = steps;
        
        for (let i = 0; i < fallbackSteps.length - 1; i++) {
            const topZ = fallbackSteps[i].z;
            const bottomZ = fallbackSteps[i + 1].z;
            const height = topZ - bottomZ; 
            if (height <= 0.00001) continue;
            const offset = fallbackSteps[i].offset; 

            let cs;
            if (baseCSforComplex) {
                if (Math.abs(offset) > 0.001) cs = collectLocal(baseCSforComplex.offset(-offset, "Miter", 2.0));
                else cs = collectLocal(baseCSforComplex.offset(0, "Miter", 2.0));
            } else {
                const pts = getContourFromShape(offset);
                if (pts.length < 3) continue;
                const polyArr = pts.map((p: THREE.Vector2) => [p.x, p.y]);
                cs = collectLocal(new manifoldModule.CrossSection([polyArr], "EvenOdd"));
            }

            const slab = collectLocal(cs.extrude(height));
            const moved = collectLocal(slab.translate([0, 0, bottomZ]));
            parts.push(moved);
        }

        if (parts.length > 0) {
            let result = parts[0];
            for(let k = 1; k < parts.length; k++) {
                const next = collectLocal(result.add(parts[k]));
                result = next;
            }
            const finalAligned = collectLocal(result.rotate([-90, 0, 0]));
            const fallbackMesh = finalAligned.getMesh();
            const idx = localGarbage.indexOf(finalAligned);
            if (idx > -1) localGarbage.splice(idx, 1);
            return { manifold: finalAligned, vertProperties: fallbackMesh.vertProperties, triVerts: fallbackMesh.triVerts };
        }
        return { manifold: null, vertProperties: new Float32Array(), triVerts: new Uint32Array() };
    } finally {
        localGarbage.forEach(g => { try { g.delete(); } catch(e) {} });
    }
}
