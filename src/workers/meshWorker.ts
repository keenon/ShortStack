// src/workers/meshWorker.ts

// --- POLYFILLS FOR WORKER ENVIRONMENT ---
self.window = self as any;
self.document = {
    createElement: (tag: string) => {
        if (tag === 'canvas') {
            if (typeof OffscreenCanvas !== 'undefined') {
                return new OffscreenCanvas(1, 1);
            }
            return {
                getContext: () => null,
                toDataURL: () => ""
            };
        }
        if (tag === 'img') return { src: "", width: 0, height: 0 };
        return {};
    },
    createElementNS: (_ns: string, tag: string) => (self.document as any).createElement(tag)
} as any;

import * as THREE from "three";
import { STLLoader, OBJLoader, GLTFLoader, GLTFExporter } from "three-stdlib";
import { mergeBufferGeometries, mergeVertices } from "three-stdlib";
// @ts-ignore
import initOCCT from "occt-import-js";
import Module from "manifold-3d";
import { evaluateExpression, resolvePoint, modifyExpression, getPolyOutlinePoints } from "../utils/footprintUtils";
import { Footprint, Parameter, StackupLayer, FootprintShape, FootprintRect, FootprintLine, FootprintPolygon, FootprintReference, FootprintUnion, Point, FootprintBoardOutline } from "../types";

let occt: any = null;
let manifoldModule: any = null;

// --- HELPERS ---

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = self.atob(base64);
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
    const chunk = 8192; 
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunk, len))));
    }
    return self.btoa(binary);
}

function evaluate(expression: string, params: Parameter[]): number {
  return evaluateExpression(expression, params);
}

// --- GEOMETRY UTILS ---

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

            const divisions = 24; 
            const sp = curve.getPoints(divisions);
            if (pathPoints.length > 0) sp.shift();
            sp.forEach(p => pathPoints.push(p));
        } else {
            if (pathPoints.length === 0) pathPoints.push(new THREE.Vector2(x1, y1));
            pathPoints.push(new THREE.Vector2(x2, y2));
        }
    }

    if (pathPoints.length < 2) return [];

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

    const contour: THREE.Vector2[] = [];
    const arcDivisions = Math.max(4, Math.floor(resolution / 2));

    for (let i = 0; i < leftPts.length; i++) contour.push(leftPts[i]);

    {
        const lastIdx = pathPoints.length - 1;
        const pLast = pathPoints[lastIdx];
        const vLast = new THREE.Vector2().subVectors(leftPts[lastIdx], pLast);
        const startAng = Math.atan2(vLast.y, vLast.x);
        for (let i = 1; i <= arcDivisions; i++) {
            const t = i / arcDivisions;
            const ang = startAng - t * Math.PI; 
            contour.push(new THREE.Vector2(
                pLast.x + Math.cos(ang) * halfThick,
                pLast.y + Math.sin(ang) * halfThick
            ));
        }
    }

    for (let i = rightPts.length - 1; i >= 0; i--) contour.push(rightPts[i]);

    {
        const pFirst = pathPoints[0];
        const vFirst = new THREE.Vector2().subVectors(rightPts[0], pFirst);
        const startAng = Math.atan2(vFirst.y, vFirst.x);
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

function createLineShape(shape: FootprintLine, params: Parameter[], contextFp: Footprint, allFootprints: Footprint[], thicknessOverride?: number): THREE.Shape | null {
  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;
  const pts = getLineOutlinePoints(shape, params, thickVal, 12, contextFp, allFootprints);
  if (pts.length < 3) return null;
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  for(let i=1; i<pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
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

function shapeToManifold(wasm: any, shape: THREE.Shape, resolution = 32) {
    let points = shape.getPoints(resolution);
    if (points.length > 1 && points[0].distanceTo(points[points.length-1]) < 0.001) points.pop();
    const contour = points.map(p => [p.x, p.y]);
    const holes = shape.holes.map(h => {
        let hPts = h.getPoints(resolution);
        if (hPts.length > 1 && hPts[0].distanceTo(hPts[hPts.length-1]) < 0.001) hPts.pop();
        return hPts.map(p => [p.x, p.y]);
    });
    return new wasm.CrossSection([contour, ...holes], "EvenOdd");
}

interface FlatShape {
    shape: FootprintShape;
    x: number;
    y: number;
    rotation: number;
    originalId: string;
    contextFp: Footprint;
    unionId?: string;
}

function flattenShapes(
    contextFp: Footprint,
    shapes: FootprintShape[], 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = { x: 0, y: 0, rotation: 0 },
    depth = 0,
    currentUnionId: string | undefined = undefined
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
                const children = flattenShapes(target, target.shapes, allFootprints, params, { x: globalX, y: globalY, rotation: globalRotation }, depth + 1, currentUnionId);
                result = result.concat(children);
            }
        } else if (shape.type === "union") {
            const u = shape as FootprintUnion;
            const effectiveUnionId = currentUnionId || u.id;
            const children = flattenShapes(u as unknown as Footprint, u.shapes, allFootprints, params, { x: globalX, y: globalY, rotation: globalRotation }, depth + 1, effectiveUnionId);
            if (Object.keys(u.assignedLayers || {}).length > 0) {
                children.forEach(c => { c.shape = { ...c.shape, assignedLayers: u.assignedLayers }; });
            }
            result = result.concat(children);
        } else {
            result.push({ shape: shape, x: globalX, y: globalY, rotation: globalRotation, originalId: shape.id, contextFp, unionId: currentUnionId });
        }
    });
    return result;
}

// --- WORKER HANDLERS ---

self.onmessage = async (e: MessageEvent) => {
    const { id, type, payload } = e.data;

    // Helper to send progress updates
    const report = (msg: string, percent: number) => {
        self.postMessage({ 
            type: "progress", 
            id, 
            payload: { 
                message: msg, 
                percent,
                layerIndex: payload.layerIndex // Include if present
            } 
        });
    };

    try {
        // --- 1. INITIALIZATION ---
        if (type === "init") {
            if (payload.occtWasmUrl && !occt) {
                occt = await initOCCT({ locateFile: () => payload.occtWasmUrl });
            }
            if (payload.manifoldWasmUrl && !manifoldModule) {
                Module({
                    locateFile: (path: string) => path.endsWith('.wasm') ? payload.manifoldWasmUrl : path
                }).then((m) => {
                    m.setup();
                    manifoldModule = m;
                    self.postMessage({ id, type: "success", payload: "initialized" });
                });
                return; // Wait for promise
            }
            self.postMessage({ id, type: "success", payload: "initialized" });
        }
        
        // --- 2. LOAD MESH (For Display) ---
        else if (type === "loadMesh") {
             const { content, format } = payload; // content is base64
             
             report("Parsing mesh data...", 0.1);

             const buffer = base64ToArrayBuffer(content);
             let geometry: THREE.BufferGeometry | null = null;
             
             if (format === "stl") {
                 const loader = new STLLoader();
                 geometry = loader.parse(buffer);
             } else if (format === "obj") {
                 const text = new TextDecoder().decode(buffer);
                 const loader = new OBJLoader();
                 const group = loader.parse(text);
                 const geoms: THREE.BufferGeometry[] = [];
                 group.traverse((c: any) => { if(c.isMesh) geoms.push(c.geometry); });
                 if(geoms.length) geometry = mergeBufferGeometries(geoms);
             } else if (format === "glb") {
                 const loader = new GLTFLoader();
                 await new Promise<void>((resolve, reject) => {
                     loader.parse(buffer, "", (gltf) => {
                         const geoms: THREE.BufferGeometry[] = [];
                         gltf.scene.traverse((c: any) => { if(c.isMesh) geoms.push(c.geometry); });
                         if(geoms.length) geometry = mergeBufferGeometries(geoms);
                         resolve();
                     }, reject);
                 });
             }

             report("Optimizing mesh...", 0.8);

             if (geometry) {
                 const nonIndexed = geometry.toNonIndexed();
                 const indexed = mergeVertices(nonIndexed);
                 
                 // Report 1.0 just before success to ensure bar fills
                 report("Ready", 1.0);

                 self.postMessage({ 
                     id, type: "success", 
                     payload: { 
                         position: indexed.getAttribute('position').array,
                         normal: indexed.getAttribute('normal')?.array,
                         index: indexed.getIndex()?.array
                     } 
                 });
             } else {
                 throw new Error("Failed to load geometry");
             }
        }
        
        // --- 3. COMPUTE LAYER SOLID (CSG) ---
        else if (type === "computeLayer") {
            if (!manifoldModule) throw new Error("Manifold not initialized");

            const { layer, footprint, allFootprints, params, bottomZ, thickness, bounds, layerIndex, totalLayers } = payload;
            const { Manifold, CrossSection } = manifoldModule;
            const garbage: any[] = [];
            const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

            report(`Layer ${layer.name}: Preparing geometry...`, 0);

            try {
                // --- COORDINATE SYSTEM SETUP ---
                // We must match the View's coordinate logic to align the generated mesh with the scene.
                // In the View, the mesh is positioned at [centerX, centerY, centerZ].
                // Therefore, geometry generated here must be centered around (0,0) LOCAL space.
                
                const isBoard = footprint.isBoard;
                
                // Resolve Assigned Board Outline to determine origin context
                const assignments = footprint.boardOutlineAssignments || {};
                const assignedId = assignments[layer.id];
                let outlineShape = footprint.shapes.find((s: any) => s.id === assignedId) as FootprintBoardOutline | undefined;
                if (!outlineShape) {
                    outlineShape = footprint.shapes.find((s: any) => s.type === "boardOutline") as FootprintBoardOutline | undefined;
                }
                
                // If this is a board with an outline, origin is (0,0). Otherwise, it's the bounds center.
                const useBoardOrigin = isBoard && !!outlineShape;
                const centerX = useBoardOrigin ? 0 : (bounds.minX + bounds.maxX) / 2;
                const centerZ = useBoardOrigin ? 0 : (bounds.minY + bounds.maxY) / 2;
                
                const width = bounds.maxX - bounds.minX;
                const depth = bounds.maxY - bounds.minY; 

                // 1. Generate Base
                let base: any;
                let boardShape: THREE.Shape | null = null;
                
                if (useBoardOrigin && outlineShape) {
                    boardShape = createBoardShape(outlineShape, params, footprint, allFootprints);
                }

                if (boardShape) {
                    const cs = collect(shapeToManifold(manifoldModule, boardShape));
                    const ext = collect(cs.extrude(thickness));
                    const rotated = collect(ext.rotate([-90, 0, 0]));
                    // Board shape is already at global (0,0), so local transform is just centering Z (height)
                    base = collect(rotated.translate([0, -thickness/2, 0]));
                } else {
                    // Create Cube
                    // Manifold cube(size, true) creates a cube at (0,0,0). 
                    // Since the React Mesh is placed at (centerX, centerY, centerZ), 
                    // a local (0,0,0) cube aligns perfectly with the bounds.
                    base = collect(Manifold.cube([width, thickness, depth], true));
                }

                // 2. Flatten Shapes
                const flatShapes = flattenShapes(footprint, footprint.shapes, allFootprints, params);
                
                // 3. Grouping Logic
                interface ExecutionItem { type: "single" | "union"; shapes: FlatShape[]; unionId?: string; }
                const executionList: ExecutionItem[] = [];
                const unionMap = new Map<string, ExecutionItem>();
                
                // Reverse to match stack visual order
                [...flatShapes].reverse().forEach(item => {
                    if (!item.shape.assignedLayers || item.shape.assignedLayers[layer.id] === undefined) return;
                    
                    if (item.unionId) {
                        if (!unionMap.has(item.unionId)) {
                            const group: ExecutionItem = { type: "union", shapes: [], unionId: item.unionId };
                            unionMap.set(item.unionId, group);
                            executionList.push(group);
                        }
                        unionMap.get(item.unionId)!.shapes.push(item);
                    } else {
                        executionList.push({ type: "single", shapes: [item] });
                    }
                });

                const CSG_EPSILON = 0.001;
                const processedCuts: { depth: number, cs: any, id: string }[] = [];

                // 4. CSG Execution Loop
                executionList.forEach((exec, idx) => {
                    // Update progress, leaving the last 5% for the final meshing step
                    const progressPercent = (idx / executionList.length) * 0.95;
                    if (idx % 5 === 0) report(`Layer ${layer.name}: Processing cut ${idx+1}/${executionList.length}`, progressPercent);
                    
                    const primaryItem = exec.shapes[0];
                    const shape = primaryItem.shape;
                    
                    // Determine Parameters
                    let actualDepth = thickness;
                    let endmillRadius = 0;

                    if (layer.type === "Cut") {
                        actualDepth = thickness; 
                    } else {
                        const assignment = shape.assignedLayers![layer.id];
                        const valExpr = (typeof assignment === 'object') ? assignment.depth : (assignment as string);
                        const radiusExpr = (typeof assignment === 'object') ? assignment.endmillRadius : "0";

                        const val = evaluateExpression(valExpr, params);
                        endmillRadius = evaluateExpression(radiusExpr, params);
                        actualDepth = Math.max(0, Math.min(val, thickness));
                    }

                    let safeRadius = endmillRadius;
                    if (exec.type === "single") {
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
                    } else {
                         safeRadius = Math.min(safeRadius, actualDepth);
                    }
                    if (safeRadius < 0) safeRadius = 0;

                    const isPartialCut = actualDepth < thickness - CSG_EPSILON;
                    const hasRadius = safeRadius > CSG_EPSILON;
                    const shouldRound = isPartialCut && hasRadius;

                    // Generate Combined CrossSection
                    let combinedCS: any = null;

                    exec.shapes.forEach(item => {
                        const s = item.shape;
                        
                        // --- COORDINATE TRANSFORM (Global -> Local) ---
                        // item.x/item.y are in Global coordinates.
                        // We need to shift them to be relative to the mesh origin (centerX, centerZ).
                        // Note: View logic uses: localZ = centerZ - item.y (Axis flip).
                        const localX = item.x - centerX;
                        const localZ = centerZ - item.y; 

                        // Resolve Local CS
                        let cs = null;
                        if (s.type === "circle") {
                            const d = evaluateExpression((s as any).diameter, params);
                            if (d > 0) cs = collect(CrossSection.circle(d/2, 32));
                        } else if (s.type === "rect") {
                            const w = evaluateExpression((s as FootprintRect).width, params);
                            const h = evaluateExpression((s as FootprintRect).height, params);
                            const crRaw = evaluateExpression((s as FootprintRect).cornerRadius, params);
                            const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2));
                            
                            if (w > 0 && h > 0) {
                                cs = collect(CrossSection.square([w, h], true));
                                if (cr > 0.001) cs = collect(cs.offset(-cr, "Round", 8)).offset(cr, "Round", 8);
                            }
                        } else if (s.type === "line") {
                            const t = evaluateExpression((s as FootprintLine).thickness, params);
                            const validT = t > 0 ? t : 0.01;
                            const lShape = createLineShape(s as FootprintLine, params, item.contextFp, allFootprints, validT);
                            if (lShape) cs = collect(shapeToManifold(manifoldModule, lShape));
                        } else if (s.type === "polygon") {
                            const poly = s as FootprintPolygon;
                            const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, 32);
                            if (pts.length > 2) {
                                cs = collect(new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
                            }
                        }

                        if (cs) {
                            // 1. Rotate
                            cs = collect(cs.rotate(item.rotation));
                            // 2. Translate to Local Position
                            // In Manifold 2D (X,Y), we map our Local X to X, and Local Z to Y (negated logic handled by view transform usually, but here:
                            // View: cs.translate([localX, -localZ]). 
                            // -localZ = -(centerZ - item.y) = item.y - centerZ.
                            cs = collect(cs.translate([localX, -localZ]));

                            if (!combinedCS) combinedCS = cs;
                            else combinedCS = collect(combinedCS.add(cs));
                        }
                    });

                    if (!combinedCS) return;

                    // Decompose Islands
                    const disjointComponents = combinedCS.decompose(); 
                    
                    disjointComponents.forEach((rawComponent: any, k: number) => {
                        const componentCS = collect(rawComponent);

                        // Intersection Check
                        let isRestorative = false;
                        for (const prev of processedCuts) {
                            if (prev.depth > actualDepth + CSG_EPSILON) {
                                const intersection = collect(componentCS.intersect(prev.cs));
                                if (!intersection.isEmpty()) {
                                    isRestorative = true;
                                    break;
                                }
                            }
                        }
                        
                        processedCuts.push({ 
                            depth: actualDepth, 
                            cs: componentCS, 
                            id: exec.type === "union" ? `${exec.unionId}_${k}` : primaryItem.originalId 
                        });

                        // Boolean Operations
                        const throughHeight = thickness + 0.2; 
                        
                        if (isRestorative) {
                            const toolCutThrough = collect(collect(componentCS.extrude(throughHeight)).translate([0, 0, -throughHeight/2]));
                            const toolAligned = collect(toolCutThrough.rotate([-90, 0, 0])); 
                            
                            const diff = collect(Manifold.difference(base, toolAligned));
                            base = diff;

                            let fillHeight = thickness - actualDepth;
                            if (shouldRound) fillHeight += safeRadius;

                            if (fillHeight > CSG_EPSILON) {
                                const toolFill = collect(collect(componentCS.extrude(fillHeight)).translate([0, 0, -fillHeight/2]));
                                const fillAligned = collect(toolFill.rotate([-90, 0, 0]));
                                
                                const fillY = layer.carveSide === "Top" 
                                    ? (-thickness / 2 + fillHeight / 2) 
                                    : (thickness / 2 - fillHeight / 2);
                                    
                                const moved = collect(fillAligned.translate([0, fillY, 0]));
                                base = collect(Manifold.union(base, moved));
                            }
                        } else {
                            if (!shouldRound && actualDepth > CSG_EPSILON) {
                                const toolCut = collect(collect(componentCS.extrude(actualDepth)).translate([0, 0, -actualDepth/2]));
                                const toolAligned = collect(toolCut.rotate([-90, 0, 0]));

                                const cutY = layer.carveSide === "Top"
                                    ? (thickness / 2 - actualDepth / 2)
                                    : (-thickness / 2 + actualDepth / 2);

                                const moved = collect(toolAligned.translate([0, cutY, 0]));
                                base = collect(Manifold.difference(base, moved));
                            }
                        }

                        // Fillet Subtraction
                        if (shouldRound) {
                            const result = generateProceduralFillet(
                                manifoldModule, 
                                shape, 
                                params, 
                                actualDepth,
                                safeRadius,
                                primaryItem.contextFp,
                                allFootprints,
                                32,
                                componentCS // Use decomposed island
                            );

                            if (result && result.manifold) {
                                const toolFillet = collect(result.manifold);
                                let final;
                                if (layer.carveSide === "Top") {
                                    final = collect(toolFillet.translate([0, thickness / 2, 0]));
                                } else {
                                    const flipped = collect(toolFillet.rotate([180, 0, 0]));
                                    final = collect(flipped.translate([0, -thickness/2, 0]));
                                }
                                base = collect(Manifold.difference(base, final));
                            }
                        }
                    });
                });

                report(`Layer ${layer.name}: Finalizing mesh...`, 0.95);

                const mesh = base.getMesh();
                
                report(`Layer ${layer.name}: Complete`, 1.0);

                self.postMessage({ 
                    id, type: "success", 
                    payload: { 
                        vertProperties: mesh.vertProperties, 
                        triVerts: mesh.triVerts 
                    } 
                });

            } finally {
                garbage.forEach(g => {
                    try { g.delete(); } catch(e) {}
                });
            }
        }
        
        // --- 4. CONVERT FILE (Drag Drop) ---
        else if (type === "convert") {
            const { buffer, format, fileName } = payload;
            let geometry: THREE.BufferGeometry | null = null;
            
            report("Reading file...", 0.1);

            if (format === "stl") {
                const loader = new STLLoader();
                geometry = loader.parse(buffer);
            } else if (format === "obj") {
                const text = new TextDecoder().decode(buffer);
                const loader = new OBJLoader();
                const group = loader.parse(text);
                const geometries: THREE.BufferGeometry[] = [];
                group.traverse((child: any) => { if (child.isMesh) geometries.push(child.geometry); });
                if (geometries.length > 0) geometry = mergeBufferGeometries(geometries);
            } else if (format === "step" || format === "stp") {
                if (!occt) throw new Error("OCCT not initialized");
                const fileBytes = new Uint8Array(buffer);
                const result = occt.ReadStepFile(fileBytes, null);
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
                    geometry = mergeBufferGeometries(geometries);
                }
            } else if (format === "glb" || format === "gltf") {
                 // Pass through if already GLB
                 const base64 = arrayBufferToBase64(buffer);
                 report("Complete", 1.0);
                 self.postMessage({ id, type: "success", payload: { base64, format: "glb" } });
                 return;
            }

            if (!geometry) {
                throw new Error(`Failed to parse geometry for ${fileName} (${format})`);
            }

            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
            const exporter = new GLTFExporter();
            
            report("Converting to GLB...", 0.8);

            exporter.parse(
                mesh,
                (gltf) => {
                    if (gltf instanceof ArrayBuffer) {
                        const base64 = arrayBufferToBase64(gltf);
                        report("Complete", 1.0);
                        self.postMessage({ id, type: "success", payload: { base64, format: "glb" } });
                    } else {
                        self.postMessage({ id, type: "error", error: "GLTF Exporter returned JSON" });
                    }
                },
                (err) => {
                    self.postMessage({ id, type: "error", error: err.message });
                },
                { binary: true }
            );
        }

    } catch (err: any) {
        self.postMessage({ id, type: "error", error: err.message || "Unknown worker error" });
    }
};

// ----------------------------------------------------------------------
// COMPLEX GEOMETRY ALGORITHMS - PASTE SECTION
// ----------------------------------------------------------------------

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
    resolution = 32,
    overrideCS?: any
) {
    let minDimension = Infinity;
    const rawVertices: number[] = [];
    const rawIndices: number[] = [];

    // Store boundary contours for validity checks in the triangulation step
    let boundaryLoops: THREE.Vector2[][] = [];

    // -----------------------------------------------------------------------
    // NEW: Cyclic Optimal Triangulation
    // Runs the DP Tiling algorithm multiple times to find the best "Seam".
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
        const AREA_WEIGHT = 4.0; 

        const getTriArea2x = (p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2) => {
            return Math.abs(p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));
        };

        // Added 'strictMode' flag to allow fallback if geometry is impossible
        const solveForOffset = (offsetB: number, strictMode: boolean) => {
            costTable.fill(Infinity);
            fromTable.fill(0);
            costTable[0] = 0; 

            for (let i = 0; i <= lenA; i++) {
                for (let j = 0; j <= lenB; j++) {
                    if (i === 0 && j === 0) continue;
                    
                    // Current vertices being considered
                    const pA = polyA[i % lenA];
                    const pB = polyB[(j + offsetB) % lenB]; 

                    // ---------------------------------------------------------
                    // VALIDITY CHECK: Prevent edges from crossing outside the polygon
                    // Only run if strictMode is true
                    // ---------------------------------------------------------
                    if (strictMode && boundaryLoops.length > 0) {
                        const midX = (pA.x + pB.x) * 0.5;
                        const midY = (pA.y + pB.y) * 0.5;

                        // 1. Point in Polygon Check (Midpoint)
                        // Must handle points ON the boundary robustly (distance check)
                        let inside = false;
                        let onBoundary = false;
                        
                        for (const loop of boundaryLoops) {
                            for (let k = 0, l = loop.length - 1; k < loop.length; l = k++) {
                                const xi = loop[k].x, yi = loop[k].y;
                                const xj = loop[l].x, yj = loop[l].y;

                                // A. Standard Ray Casting
                                const intersect = ((yi > midY) !== (yj > midY)) 
                                    && (midX < (xj - xi) * (midY - yi) / (yj - yi) + xi);
                                if (intersect) inside = !inside;

                                // B. On-Segment Check (Distance Squared)
                                // Only check if not already found on a boundary
                                if (!onBoundary) {
                                    const l2 = (xj - xi) ** 2 + (yj - yi) ** 2;
                                    if (l2 > 1e-9) {
                                        let t = ((midX - xi) * (xj - xi) + (midY - yi) * (yj - yi)) / l2;
                                        t = Math.max(0, Math.min(1, t));
                                        const dx = midX - (xi + t * (xj - xi));
                                        const dy = midY - (yi + t * (yj - yi));
                                        // 1e-6 tolerance for being "on" the wall
                                        if ((dx*dx + dy*dy) < 1e-6) onBoundary = true;
                                    }
                                }
                            }
                        }

                        // If it's on the boundary, it's valid regardless of ray cast result
                        if (onBoundary) inside = true;
                        
                        if (!inside) continue; 

                        // 2. Line Segment Intersection Check
                        let intersectsBoundary = false;
                        const minX = Math.min(pA.x, pB.x) - 0.001;
                        const maxX = Math.max(pA.x, pB.x) + 0.001;
                        const minY = Math.min(pA.y, pB.y) - 0.001;
                        const maxY = Math.max(pA.y, pB.y) + 0.001;
                        const dAx = pB.x - pA.x;
                        const dAy = pB.y - pA.y;

                        outerLoop:
                        for (const loop of boundaryLoops) {
                            for (let k = 0; k < loop.length; k++) {
                                const b1 = loop[k];
                                const b2 = loop[(k + 1) % loop.length];

                                // AABB Optimization
                                const bMinX = Math.min(b1.x, b2.x);
                                const bMaxX = Math.max(b1.x, b2.x);
                                if (maxX < bMinX || minX > bMaxX) continue;
                                const bMinY = Math.min(b1.y, b2.y);
                                const bMaxY = Math.max(b1.y, b2.y);
                                if (maxY < bMinY || minY > bMaxY) continue;

                                // Strict Intersection
                                const dBx = b2.x - b1.x;
                                const dBy = b2.y - b1.y;
                                const det = dAx * dBy - dAy * dBx;

                                if (det !== 0) {
                                    const t = ((b1.x - pA.x) * dBy - (b1.y - pA.y) * dBx) / det;
                                    const u = ((b1.x - pA.x) * dAy - (b1.y - pA.y) * dAx) / det;
                                    // Range excludes endpoints to allow sharing vertices
                                    if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) {
                                        intersectsBoundary = true;
                                        break outerLoop;
                                    }
                                }
                            }
                        }
                        if (intersectsBoundary) continue;
                    }

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

        const generateIndices = (offsetB: number, strictMode: boolean) => {
            solveForOffset(offsetB, strictMode); 
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

            if (safety >= MAX_STEPS) {
                console.warn("Triangulation emergency exit: Max steps reached.");
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

        // --- FIRST PASS: STRICT MODE ---
        for (let k = 0; k < searchCount; k++) {
            const offset = safeMod(searchStart + k, lenB);
            const cost = solveForOffset(offset, true);
            const pA = polyA[0];
            const pB = polyB[offset];
            const seamDistSq = pA.distanceToSquared(pB);
            const totalCost = cost + seamDistSq;

            if (totalCost < minTotalCost) {
                minTotalCost = totalCost;
                bestOffset = offset;
            }
        }

        // --- SECOND PASS: PERMISSIVE FALLBACK ---
        // If Strict Mode failed (Cost is Infinity), run again without checks.
        let useStrict = true;
        if (minTotalCost === Infinity) {
            // DEBUG: Why did we fail?
            console.warn(`[Fillet] Strict triangulation failed. Pts A: ${lenA}, B: ${lenB}. Fallback enabled.`);
            
            useStrict = false;
            for (let k = 0; k < searchCount; k++) {
                const offset = safeMod(searchStart + k, lenB);
                const cost = solveForOffset(offset, false);
                const pA = polyA[0];
                const pB = polyB[offset];
                const seamDistSq = pA.distanceToSquared(pB);
                const totalCost = cost + seamDistSq;

                if (totalCost < minTotalCost) {
                    minTotalCost = totalCost;
                    bestOffset = offset;
                }
            }
        }

        generateIndices(bestOffset, useStrict);
    };

    // If overrideCS provided OR shape is polygon, use the generalized Polygon logic
    if (overrideCS || shape.type === "polygon") {
        let baseCS;
        let basePoints: THREE.Vector2[] = [];

        if (overrideCS) {
            baseCS = overrideCS;
            const rawPolys = baseCS.toPolygons().map((p: any) => p.map((pt: any) => new THREE.Vector2(pt[0], pt[1])));
            if(rawPolys.length > 0) basePoints = rawPolys[0]; 
            boundaryLoops = rawPolys;

            let area = 0;
            for (let i = 0; i < basePoints.length; i++) {
                const j = (i + 1) % basePoints.length;
                area += basePoints[i].x * basePoints[j].y - basePoints[j].x * basePoints[i].y;
            }
            if (area < 0) basePoints.reverse();

        } else {
            const poly = shape as FootprintPolygon;
            const baseData = getPolyOutlineWithFeatures(poly.points, 0, 0, params, contextFp, allFootprints, resolution);

            basePoints = baseData.points;
            boundaryLoops = [basePoints];

            let area = 0;
            for (let i = 0; i < basePoints.length; i++) {
                const j = (i + 1) % basePoints.length;
                area += basePoints[i].x * basePoints[j].y - basePoints[j].x * basePoints[i].y;
            }
            if (area < 0) {
                basePoints.reverse();
            }

            if (basePoints.length < 3) return null;
            baseCS = new manifoldModule.CrossSection([basePoints.map(p => [p.x, p.y])], "EvenOdd");
        }
        
        if (!basePoints || basePoints.length < 3) return null;

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
                    if (area < 0) clean.reverse();
                    return clean;
                }).filter((p: any) => p.length >= 3);
            } else {
                processedPolys = [basePoints];
            }

            layerData.push({ z: step.z, contours: processedPolys, startIdx: totalVerts });
            processedPolys.forEach((contour: THREE.Vector2[]) => {
                contour.forEach(p => { rawVertices.push(p.x, step.z, -p.y); totalVerts++; });
            });
        });

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
        // Top cap (Up-facing)
        triangulateFlat(layerData[0].contours, layerData[0].startIdx, false);
        // Bottom cap is handled per-island now, but the final bottom is still capped if it exists
        triangulateFlat(layerData[layerData.length - 1].contours, layerData[layerData.length - 1].startIdx, true);

        for(let l=0; l<layerData.length-1; l++) {
            const up = layerData[l];
            const low = layerData[l+1];
            
            // Map: Index of Up-Polygon -> Array of Indices of Low-Polygons contained within it
            const upToLow = new Map<number, number[]>();
            for(let i=0; i<up.contours.length; i++) upToLow.set(i, []);

            // Identify containment (Parent -> Children)
            // Since shapes shrink with offset, children are always strictly inside (or very close to) parent.
            low.contours.forEach((lowPoly, iLow) => {
                const lowCenter = new THREE.Vector2();
                lowPoly.forEach(p => lowCenter.add(p));
                lowCenter.divideScalar(lowPoly.length);

                let bestUp = -1;
                let minDist = Infinity;

                // 1. Try to find strict containment or closest centroid
                up.contours.forEach((upPoly, iUp) => {
                    const upCenter = new THREE.Vector2();
                    upPoly.forEach(p => upCenter.add(p));
                    upCenter.divideScalar(upPoly.length);
                    const d = upCenter.distanceToSquared(lowCenter);
                    
                    if (d < minDist) {
                        minDist = d;
                        bestUp = iUp;
                    }
                });

                if (bestUp !== -1) {
                    upToLow.get(bestUp)!.push(iLow);
                }
            });

            // Iterate parents and handle topology transitions
            upToLow.forEach((childIndices, iUp) => {
                const upPoly = up.contours[iUp];
                
                if (childIndices.length === 1) {
                    // --- CASE 1: 1-to-1 Topology (Use robust tiling) ---
                    const iLow = childIndices[0];
                    const lowPoly = low.contours[iLow];
                    
                    // Calculate absolute start indices in the global buffer
                    let sA = up.startIdx; 
                    for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                    
                    let sB = low.startIdx; 
                    for(let k=0; k<iLow; k++) sB += low.contours[k].length;
                    
                    triangulateRobust(upPoly, lowPoly, sA, sB);

                } else if (childIndices.length === 0) {
                     // --- CASE 2: Disappearing Island (Cap) ---
                     // The shape disappears at the lower level. We must cap it at the CURRENT (Upper) level.
                     // The normal must face DOWN (into the void being cut).
                     
                     let sA = up.startIdx; 
                     for(let k=0; k<iUp; k++) sA += up.contours[k].length;

                     const tris = THREE.ShapeUtils.triangulateShape(upPoly, []);
                     tris.forEach(t => {
                         // Reverse winding for Downward normal (since input is CCW/Up)
                         rawIndices.push(sA + t[0], sA + t[2], sA + t[1]);
                     });

                } else {
                    // --- CASE 3: Split into Multiple Islands (Loft with Holes) ---
                    // Generates the web/shoulder connecting the single outer parent to multiple inner children.
                    
                    const holes = childIndices.map(i => low.contours[i]);
                    // ShapeUtils expects holes to be opposite winding (CW). Our polys are CCW.
                    const holesReversed = holes.map(h => [...h].reverse());

                    const tris = THREE.ShapeUtils.triangulateShape(upPoly, holesReversed);
                    
                    let sA = up.startIdx; 
                    for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                    
                    tris.forEach(t => {
                        // Map local triangulation indices back to global buffer
                        // Indices < upPoly.length belong to the Parent (Up layer)
                        // Indices >= upPoly.length belong to Children (Low layer)
                        const resolve = (localIdx: number) => {
                            if (localIdx < upPoly.length) {
                                return sA + localIdx;
                            } else {
                                let rem = localIdx - upPoly.length;
                                for(let c=0; c<childIndices.length; c++) {
                                    const hLen = holes[c].length;
                                    if (rem < hLen) {
                                        // It's in child c
                                        const realChildIdx = childIndices[c];
                                        let sB = low.startIdx;
                                        for(let k=0; k<realChildIdx; k++) sB += low.contours[k].length;
                                        
                                        // Because we reversed the hole for triangulation, we must invert index logic
                                        // to match the original (CCW) points in the buffer.
                                        // Reversed: index 0 is Original: len-1
                                        return sB + ((hLen - 1) - rem);
                                    }
                                    rem -= hLen;
                                }
                            }
                            return sA; // Fallback
                        };
                        
                        rawIndices.push(resolve(t[0]), resolve(t[2]), resolve(t[1]));
                    });
                }
            });
        }
    } else {
        // ... (Primitive logic remains unchanged) ...
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

        let topologyValid = true;
        layers.forEach((layer) => {
            const points = getContour(layer.offset);
            if (points.length !== vertsPerLayer) topologyValid = false;
            if (!topologyValid) return;
            points.forEach(p => rawVertices.push(p.x, layer.z, -p.y));
        });
        if (!topologyValid) return null;

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