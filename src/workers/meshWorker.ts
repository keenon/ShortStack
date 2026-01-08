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
import { evaluateExpression, resolvePoint, getPolyOutlinePoints, getTransformAlongLine } from "../utils/footprintUtils";
import { Footprint, Parameter, FootprintShape, FootprintRect, FootprintLine, FootprintPolygon, FootprintReference, FootprintUnion, Point, FootprintBoardOutline } from "../types";

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

    // Scale curve fidelity based on resolution
    const curveDivisions = Math.max(4, Math.ceil(resolution / 2));

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

            const sp = curve.getPoints(curveDivisions);
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
    // Scale arc divisions based on resolution
    const arcDivisions = Math.max(3, Math.ceil(resolution / 4));

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

function createLineShape(shape: FootprintLine, params: Parameter[], contextFp: Footprint, allFootprints: Footprint[], thicknessOverride: number | undefined, resolution: number): THREE.Shape | null {
  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;
  const pts = getLineOutlinePoints(shape, params, thickVal, resolution, contextFp, allFootprints);
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
        if (shape.type === "wireGuide" || shape.type === "boardOutline" || shape.type === "text") return;

        // FIX: Force Line origin to 0,0 to match 2D renderer and Export logic
        const localX = (shape.type === "line") ? 0 : evaluate(shape.x, params);
        const localY = (shape.type === "line") ? 0 : evaluate(shape.y, params);

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

        if (shape.type === "line") {
            const line = shape as any; // FootprintLine
            // Push the line itself
            result.push({ shape: shape, x: globalX, y: globalY, rotation: globalRotation, originalId: shape.id, contextFp, unionId: currentUnionId });

            if (line.tieDowns) {
                line.tieDowns.forEach((td: any) => {
                    const target = allFootprints.find(f => f.id === td.footprintId);
                    if (target) {
                        const dist = evaluate(td.distance, params);
                        const rotOffset = evaluate(td.angle, params);
                        
                        const tf = getTransformAlongLine(line, dist, params, contextFp, allFootprints);
                        if (tf) {
                            const tdLocalX = tf.x;
                            const tdLocalY = tf.y;
                            const tdLocalRot = tf.angle - 90 + rotOffset;
                            
                            const parentRad = (transform.rotation * Math.PI) / 180;
                            const pCos = Math.cos(parentRad);
                            const pSin = Math.sin(parentRad);
                            
                            const rotX = tdLocalX * pCos - tdLocalY * pSin;
                            const rotY = tdLocalX * pSin + tdLocalY * pCos;
                            
                            const tdGlobalX = globalX + rotX;
                            const tdGlobalY = globalY + rotY;
                            const tdGlobalRot = transform.rotation + tdLocalRot;
                            
                            const children = flattenShapes(
                                target, 
                                target.shapes, 
                                allFootprints, 
                                params, 
                                { x: tdGlobalX, y: tdGlobalY, rotation: tdGlobalRot }, 
                                depth + 1, 
                                currentUnionId 
                            );
                            result = result.concat(children);
                        }
                    }
                });
            }
        } else if (shape.type === "footprint") {
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
                    locateFile: ((path: string) => path.endsWith('.wasm') ? payload.manifoldWasmUrl : path) as any
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
             const { content, format, name } = payload; // content is base64
             const meshName = name || "mesh";

             report(`Loading mesh ${meshName} (1/2)...`, 0.1);

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

             report(`Optimizing mesh ${meshName} (2/2)...`, 0.8);

             if (geometry) {
                 const nonIndexed = geometry.toNonIndexed();
                 const indexed = mergeVertices(nonIndexed);
                 
                 // Report 1.0 just before success to ensure bar fills
                 report(`Loaded ${meshName}`, 1.0);

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

            const { layer, footprint, allFootprints, params, thickness, bounds, layerIndex, totalLayers, resolution = 32 } = payload;
            const { Manifold, CrossSection } = manifoldModule;
            const garbage: any[] = [];
            const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

            const layerStr = `layer ${layer.name} (${layerIndex + 1}/${totalLayers})`;
            report(`Initializing ${layerStr}...`, 0);

            try {
                // DEBUG: Log Inputs
                console.log(`[Worker] Computing Layer "${layer.name}" (Type: ${layer.type})`);
                console.log(`[Worker] Bounds:`, JSON.stringify(bounds));
                console.log(`[Worker] Thickness:`, thickness);

                // UPDATED: Origin Logic
                // We enforce (0,0) as the global origin to match the React view.
                const centerX = 0;
                const centerZ = 0;
                
                // However, if we need to generate a stock block (no outline),
                // we must center that block around the actual shapes (the bounds center).
                const boundsCenterX = (bounds.minX + bounds.maxX) / 2;
                const boundsCenterZ = (bounds.minY + bounds.maxY) / 2;
                const width = bounds.maxX - bounds.minX;
                const depth = bounds.maxY - bounds.minY; 

                const isBoard = footprint.isBoard;
                
                // Resolve Assigned Board Outline to determine origin context
                const assignments = footprint.boardOutlineAssignments || {};
                const assignedId = assignments[layer.id];
                let outlineShape = footprint.shapes.find((s: any) => s.id === assignedId) as FootprintBoardOutline | undefined;
                if (!outlineShape) {
                    outlineShape = footprint.shapes.find((s: any) => s.type === "boardOutline") as FootprintBoardOutline | undefined;
                }
                
                // 1. Generate Base
                let base: any;
                let boardShape: THREE.Shape | null = null;
                
                if (isBoard && outlineShape) {
                    boardShape = createBoardShape(outlineShape, params, footprint, allFootprints);
                }

                if (boardShape) {
                    const cs = collect(shapeToManifold(manifoldModule, boardShape, resolution));
                    const ext = collect(cs.extrude(thickness));
                    const rotated = collect(ext.rotate([-90, 0, 0]));
                    // Board shape is already at global (0,0), so local transform is just centering Z (height)
                    base = collect(rotated.translate([0, -thickness/2, 0]));
                } else {
                    // Create Default Cube Stock
                    // Manifold.cube makes a cube at 0,0,0. 
                    // We must translate it to the "actual" center of the design so it covers the shapes.
                    let cube = collect(Manifold.cube([width, thickness, depth], true));
                    // Translate to bounds center (accounting for Z flip: Z in 3D is -Y in 2D space for Manifold logic here usually)
                    // Wait, Manifold 3D space: X=X, Y=Y, Z=Z.
                    // React View: X=X, Y=Height, Z=Z.
                    // Our coordinate transform below maps: Manifold X = Global X, Manifold Z = -Global Y.
                    // So we translate the Cube X by boundsCenterX, and Cube Z by -boundsCenterZ (which is boundsCenterY in 2D).
                    // Correct: boundsCenterZ variable holds 2D Y center. So we negate it for 3D Z.
                    base = collect(cube.translate([boundsCenterX, 0, -boundsCenterZ]));
                }

                // DEBUG: Check Base Generation
                if (!base) {
                    throw new Error(`[Worker] Failed to generate base stock for layer ${layer.name}`);
                }
                const baseMeshCheck = base.getMesh();
                console.log(`[Worker] Base Stock Vertices: ${baseMeshCheck.vertProperties.length}`);

                // Keep a reference to the un-modified base to use as a clipping mask
                // Because Manifold operations return NEW objects, this reference remains "pure"
                const boundaryMask = base;

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
                const totalOps = executionList.length;

                // 4. CSG Execution Loop
                executionList.forEach((exec, idx) => {
                    const primaryItem = exec.shapes[0];
                    const shape = primaryItem.shape;
                    const shapeName = shape.name || (exec.type === "union" ? "Union" : "Shape");
                    const itemStr = `${shapeName} (${idx + 1}/${totalOps})`;
                    
                    // Basic progress calculation
                    const basePercent = (idx / totalOps) * 0.9;
                    
                    // Determine Parameters
                    let actualDepth = thickness;
                    let endmillRadius = 0;
                    let inputRadius = 0;

                    if (layer.type === "Cut") {
                        actualDepth = thickness; 
                    } else {
                        const assignment = shape.assignedLayers![layer.id];
                        const valExpr = (typeof assignment === 'object') ? assignment.depth : (assignment as string);
                        const radiusExpr = (typeof assignment === 'object') ? assignment.endmillRadius : "0";
                        const inputExpr = (typeof assignment === 'object') ? assignment.inputFillet : "0";

                        const val = evaluateExpression(valExpr, params);
                        endmillRadius = evaluateExpression(radiusExpr, params);
                        inputRadius = evaluateExpression(inputExpr, params);
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
                    if (inputRadius < 0) inputRadius = 0;

                    const isThroughCut = actualDepth >= thickness - CSG_EPSILON;
                    const effectiveBottomRadius = isThroughCut ? 0 : safeRadius;
                    const hasToolProfile = effectiveBottomRadius > CSG_EPSILON || inputRadius > CSG_EPSILON;
                    const shouldGenTool = hasToolProfile;

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
                            if (d > 0) cs = collect(CrossSection.circle(d/2, resolution));
                        } else if (s.type === "rect") {
                            const w = evaluateExpression((s as FootprintRect).width, params);
                            const h = evaluateExpression((s as FootprintRect).height, params);
                            const crRaw = evaluateExpression((s as FootprintRect).cornerRadius, params);
                            const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2 - 0.001));
                            
                            if (w > 0 && h > 0) {
                                cs = collect(CrossSection.square([w, h], true));
                                const segments = Math.max(3, Math.ceil(resolution / 4));
                                if (cr > 0.001) cs = collect(cs.offset(-cr, "Round", segments)).offset(cr, "Round", segments);
                            }
                        } else if (s.type === "line") {
                            const t = evaluateExpression((s as FootprintLine).thickness, params);
                            const validT = t > 0 ? t : 0.01;
                            const lShape = createLineShape(s as FootprintLine, params, item.contextFp, allFootprints, validT, resolution);
                            if (lShape) cs = collect(shapeToManifold(manifoldModule, lShape, resolution));
                        } else if (s.type === "polygon") {
                            const poly = s as FootprintPolygon;
                            const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, resolution);
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

                        // Report Boolean Op
                        report(`Boolean operation for ${itemStr} on ${layerStr}...`, basePercent);

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
                            if (shouldGenTool) fillHeight += safeRadius;

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
                            if (!shouldGenTool && actualDepth > CSG_EPSILON) {
                                // FIXED: Handle coplanar faces for through-cuts by extending tool height
                                let toolDepth = actualDepth;
                                let toolOffset = 0;

                                if (isThroughCut) {
                                    // OVERCUT to ensure robust boolean difference
                                    toolDepth = thickness + 1.0; 
                                    toolOffset = 0; // Centered at 0 to cut through both top (-t/2) and bottom (t/2)
                                } else {
                                    toolDepth = actualDepth;
                                    toolOffset = layer.carveSide === "Top"
                                        ? (thickness / 2 - actualDepth / 2)
                                        : (-thickness / 2 + actualDepth / 2);
                                }

                                const toolCut = collect(collect(componentCS.extrude(toolDepth)).translate([0, 0, -toolDepth/2]));
                                const toolAligned = collect(toolCut.rotate([-90, 0, 0]));
                                const moved = collect(toolAligned.translate([0, toolOffset, 0]));
                                
                                // SAFE DIFFERENCE OPERATION
                                const nextBase = collect(Manifold.difference(base, moved));
                                
                                // Check if the operation destroyed the mesh
                                let opFailed = false;
                                try {
                                    // Use efficient check if available, or fallback to getMesh
                                    const nextVerts = (nextBase.numVert && typeof nextBase.numVert === 'function') 
                                        ? nextBase.numVert() 
                                        : nextBase.getMesh().vertProperties.length;
                                        
                                    if (nextVerts === 0) {
                                        // Check if it was ALREADY empty
                                        const prevVerts = (base.numVert && typeof base.numVert === 'function')
                                            ? base.numVert()
                                            : base.getMesh().vertProperties.length;
                                            
                                        if (prevVerts > 0) {
                                            opFailed = true;
                                        }
                                    }
                                } catch (e) {
                                    // Fallback safety
                                    console.warn("[Worker] Mesh validation failed, assuming success", e);
                                }

                                if (opFailed) {
                                    console.error(`[Worker] 🚨 CRITICAL: Mesh vanished after cutting "${shapeName}". Reverting this operation to preserve board.`);
                                    console.error(`[Worker]    Debug Data -> Depth: ${toolDepth}, Thickness: ${thickness}, ToolOffset: ${toolOffset}`);
                                    // Do NOT update 'base'. We skip this cut.
                                } else {
                                    base = nextBase;
                                }
                            }
                        }

                        // Fillet/Chamfer Tool Subtraction
                        if (shouldGenTool && !isRestorative) {
                            // Report Tool Op
                            report(`Generating tool for ${itemStr} on ${layerStr}...`, basePercent + 0.05);

                            const result = generateProceduralTool(
                                manifoldModule, 
                                shape, 
                                params, 
                                actualDepth,
                                inputRadius,
                                effectiveBottomRadius,
                                primaryItem.contextFp,
                                allFootprints,
                                resolution,
                                componentCS
                            );

                            // --- DO NOT DELETE FAILURE HANDLING ---
                            if (result && !result.manifold) {
                                // If the tool failed to become a manifold, we send the raw tool geometry
                                // back to the main thread immediately so the user can see what's wrong.
                                report(`Error: Manifold failure on ${shapeName}`, 1.0);
                                
                                self.postMessage({ 
                                    id, type: "success", 
                                    payload: { 
                                        vertProperties: result.vertProperties, 
                                        triVerts: result.triVerts,
                                        isFailedTool: true, // Flag for the renderer
                                        errorShapeName: shapeName
                                    } 
                                });
                                // We throw to break out of the disjointComponents loop 
                                // and stop processing this layer further.
                                throw new Error(`Stopped: Manifold failure on ${shapeName}`);
                            }

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

                                // --- DIAGNOSTIC: CHECK FOR VANISHED MESH (FILLET) ---
                                {
                                    const _diagMesh = base.getMesh();
                                    if (_diagMesh.vertProperties.length === 0) {
                                        console.error(`[Worker] 🚨 CRITICAL: Mesh vanished after fillet subtract on "${shapeName}"`);
                                    }
                                }
                                // ----------------------------------------------------
                            }
                        }
                    });
                });

                // --- FINAL CLIPPING STEP ---
                // This ensures any "leaking" geometry from fillets or re-adds 
                // is perfectly trimmed to the original board outline.
                report(`Clipping to board boundary...`, 0.92);
                base = collect(manifoldModule.Manifold.intersection(base, boundaryMask));

                report(`Finalizing mesh for ${layerStr}...`, 0.95);

                const mesh = base.getMesh();
                
                // DEBUG: Final Result
                console.log(`[Worker] Final Mesh "${layer.name}": ${mesh.vertProperties.length} verts, ${mesh.triVerts.length} tris`);

                report(`Layer ${layer.name}: Complete`, 1.0);

                self.postMessage({ 
                    id, type: "success", 
                    payload: { 
                        vertProperties: mesh.vertProperties, 
                        triVerts: mesh.triVerts 
                    } 
                });

            } finally {
                garbage.forEach(g => { try { g.delete(); } catch(e) {} });
            }
        }
        else if (type === "computeUnionOutline") {
            if (!manifoldModule) throw new Error("Manifold not initialized");
            const { shapes, params, contextFp, allFootprints, transform } = payload;
            const { CrossSection } = manifoldModule;
            const garbage: any[] = [];
            const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

            try {
                // Pass shapes directly to flatten logic
                // We use a dummy union wrapper to reuse flattenShapes if needed, or just iterate.
                // flattenShapes handles recursion.
                const flatShapes = flattenShapes(contextFp, shapes, allFootprints, params, transform);
                
                let combinedCS: any = null;

                flatShapes.forEach(item => {
                    const s = item.shape;
                    // Standard 2D coordinate space (x=x, y=y)
                    // Visual/Export space: Y is up/down depending on convention, but here we just process math.
                    
                    let cs = null;
                    if (s.type === "circle") {
                        const d = evaluateExpression((s as any).diameter, params);
                        if (d > 0) cs = collect(CrossSection.circle(d/2, 32));
                    } else if (s.type === "rect") {
                        const w = evaluateExpression((s as FootprintRect).width, params);
                        const h = evaluateExpression((s as FootprintRect).height, params);
                        const crRaw = evaluateExpression((s as FootprintRect).cornerRadius, params);
                        const cr = Math.max(0, Math.min(crRaw, Math.min(w, h) / 2 - 0.001));
                        if (w > 0 && h > 0) {
                            cs = collect(CrossSection.square([w, h], true));
                            if (cr > 0.001) cs = collect(cs.offset(-cr, "Round", 8)).offset(cr, "Round", 8);
                        }
                    } else if (s.type === "line") {
                        const t = evaluateExpression((s as FootprintLine).thickness, params);
                        const validT = t > 0 ? t : 0.01;
                        const lShape = createLineShape(s as FootprintLine, params, item.contextFp, allFootprints, validT, 32);
                        if (lShape) cs = collect(shapeToManifold(manifoldModule, lShape));
                    } else if (s.type === "polygon") {
                        const poly = s as FootprintPolygon;
                        const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, 32);
                        if (pts.length > 2) {
                            cs = collect(new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
                        }
                    }

                    if (cs) {
                        cs = collect(cs.rotate(item.rotation));
                        // In 2D, we just use X and Y.
                        // Wait, computeLayer used: localZ = centerZ - item.y. This was for 3D mapping where Y is Z.
                        // Here we are purely 2D for export.
                        // The transform passed in typically puts Y in "Visual" space (where +Y is Up).
                        // Export expects "Math" space usually, then SVG flips it.
                        // We just need to be consistent. 
                        // flattenShapes returns global X and Y.
                        cs = collect(cs.translate([item.x, item.y]));

                        if (!combinedCS) combinedCS = cs;
                        else combinedCS = collect(combinedCS.add(cs));
                    }
                });

                let contours: {x:number, y:number}[][] = [];
                if (combinedCS) {
                    const polys = combinedCS.toPolygons(); // Returns [ [[x,y]...] ... ]
                    // Convert float arrays to objects
                    contours = polys.map((poly: number[][]) => poly.map((pt: number[]) => ({ x: pt[0], y: pt[1] })));
                }

                self.postMessage({ id, type: "success", payload: contours });

            } finally {
                garbage.forEach(g => { try { g.delete(); } catch(e) {} });
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

    // Scale resolution for bezier steps
    const curveDivisions = Math.max(4, Math.ceil(resolution / 2));

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

            const sp = curve.getPoints(curveDivisions);
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

// ----------------------------------------------------------------------
// GENERALIZED PROCEDURAL TOOL GENERATOR (Input & Bottom Fillets)
// ----------------------------------------------------------------------

function generateProceduralTool(
    manifoldModule: any,
    shape: FootprintShape, 
    params: Parameter[],
    depth: number, 
    topRadius: number,
    bottomRadius: number,
    contextFp: Footprint,
    allFootprints: Footprint[],
    resolution = 32,
    overrideCS?: any
) {
    const rawVertices: number[] = [];
    const rawIndices: number[] = [];

    // --- 1. CALCULATE VERTICAL STEPS ---
    const steps: { z: number, offset: number }[] = [];
    const arcSteps = Math.max(3, Math.ceil(resolution / 4));

    // A. Top Fillet (Input)
    if (topRadius > 0.001) {
        // CRUCIAL: Generate steps Top-Down (Z=0 -> Z=-topRadius) to match 
        // the sequence of the rest of the tool.
        for(let i=0; i<=arcSteps; i++) {
            // Invert theta: Start at PI/2 (Top/Wide) and go down to 0 (Bottom/Nominal)
            const theta = (Math.PI / 2) * (1 - i / arcSteps);
            
            // At theta = PI/2: sin=1 -> z=0.         cos=0 -> off=-topRadius (Wide)
            // At theta = 0:    sin=0 -> z=-topRadius. cos=1 -> off=0 (Nominal)
            const z = -topRadius + topRadius * Math.sin(theta);
            const off = -topRadius + topRadius * Math.cos(theta); 
            steps.push({ z, offset: off });
        }
    } else {
        steps.push({ z: 0, offset: 0 });
    }

    // B. Vertical Wall & Bottom Fillet
    const availableDepth = depth - topRadius;
    const safeBottomR = Math.min(bottomRadius, availableDepth);
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

    // Remove duplicates
    for(let i=steps.length-1; i>0; i--) {
        if (Math.abs(steps[i].z - steps[i-1].z) < 0.0001) {
            steps.splice(i, 1);
        }
    }

    // --- 2. TRIANGULATION LOGIC ---
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

    // --- 3. GENERATE CONTOURS ---
    
    // Helper to get contour for a specific offset
    const getContourFromShape = (offset: number): THREE.Vector2[] => {
        let rawPoints: THREE.Vector2[] = [];
        
        if (shape.type === "circle") {
            const d = evaluateExpression((shape as any).diameter, params);
            // offset > 0 (shrink), offset < 0 (grow)
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
            rawPoints = getLineOutlinePoints(shape as FootprintLine, params, effectiveT, resolution, contextFp, allFootprints);
        }

        if (rawPoints.length > 0) {
            // Ensure CCW
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

    // --- 4. PREPARE LAYERS ---
    
    // Determine boundary based on minimum offset (widest point)
    let minOffset = 0;
    steps.forEach(s => minOffset = Math.min(minOffset, s.offset));

    let baseCSforComplex: any = null;

    if (overrideCS || shape.type === "polygon") {
        if (overrideCS) {
            baseCSforComplex = overrideCS;
        } else {
            const poly = shape as FootprintPolygon;
            const baseData = getPolyOutlineWithFeatures(poly.points, 0, 0, params, contextFp, allFootprints, resolution);
            const pts = baseData.points;
            if (pts.length >= 3) {
                baseCSforComplex = new manifoldModule.CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd");
            }
        }
    }

    const layerData: { z: number, contours: THREE.Vector2[][], startIdx: number }[] = [];
    let totalVerts = 0;

    steps.forEach(step => {
        let processedPolys: THREE.Vector2[][] = [];
        
        if (baseCSforComplex) {
            // Complex shape logic
            let cs = baseCSforComplex;
            if (Math.abs(step.offset) > 0.001) {
                // If negative offset (input), Miter is better. If positive (ball), Round might be better, 
                // but usually Miter is cleaner for general offsets.
                cs = baseCSforComplex.offset(-step.offset, "Miter", 2.0);
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
                
                // Manifold generates holes with negative area. 
                // We assume tool slices should be solid. 
                // Discard holes or extremely small artifacts.
                if (area < 0) return null; 
                if (Math.abs(area) < 0.00001) return null;

                // Do NOT reverse here. If it was positive (solid), keep it.
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
    // Top cap
    triangulateFlat(layerData[0].contours, layerData[0].startIdx, false);
    // Bottom cap
    triangulateFlat(layerData[layerData.length - 1].contours, layerData[layerData.length - 1].startIdx, true);

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
                
                if (d < minDist) {
                    minDist = d;
                    bestUp = iUp;
                }
            });

            if (bestUp !== -1) {
                upToLow.get(bestUp)!.push(iLow);
            }
        });

        upToLow.forEach((childIndices, iUp) => {
            const upPoly = up.contours[iUp];
            
            if (childIndices.length === 1) {
                const iLow = childIndices[0];
                const lowPoly = low.contours[iLow];
                
                let sA = up.startIdx; 
                for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                
                let sB = low.startIdx; 
                for(let k=0; k<iLow; k++) sB += low.contours[k].length;
                
                triangulateRobust(upPoly, lowPoly, sA, sB);

            } else if (childIndices.length === 0) {
                 let sA = up.startIdx; 
                 for(let k=0; k<iUp; k++) sA += up.contours[k].length;

                 const tris = THREE.ShapeUtils.triangulateShape(upPoly, []);
                 tris.forEach(t => {
                     rawIndices.push(sA + t[0], sA + t[2], sA + t[1]);
                 });

            } else {
                const holes = childIndices.map(i => low.contours[i]);
                const holesReversed = holes.map(h => [...h].reverse());

                const tris = THREE.ShapeUtils.triangulateShape(upPoly, holesReversed);
                
                let sA = up.startIdx; 
                for(let k=0; k<iUp; k++) sA += up.contours[k].length;
                
                tris.forEach(t => {
                    const resolve = (localIdx: number) => {
                        if (localIdx < upPoly.length) {
                            return sA + localIdx;
                        } else {
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
        console.error("Failed to create tool manifold", e);
        return { manifold: null, vertProperties, triVerts };
    }
}