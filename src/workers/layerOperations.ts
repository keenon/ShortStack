import * as THREE from "three";
import { FootprintBoardOutline, FootprintRect, FootprintLine, FootprintPolygon, FootprintSplitLine, Point, Footprint, Parameter, StackupLayer, FootprintReference, FootprintUnion } from "../types";
import { evaluateExpression, getPolyOutlinePoints, generateDovetailPoints, resolvePoint } from "../utils/footprintUtils";
import { createBoardShape, createLineShape, flattenShapes, shapeToManifold, FlatShape, getLineOutlinePoints, evaluate } from "./meshUtils";
import { generateProceduralTool } from "./proceduralTool";

// Helper to convert Three.Shape to Manifold Polygons
function shapeToPolygons(shape: THREE.Shape, resolution: number): number[][][] {
    const res = resolution || 32;
    const polys: number[][][] = [];
    
    // Outer contour
    const pts = shape.getPoints(res).map(p => [p.x, p.y]);
    // Close loop if needed (Manifold expects implied closed loops, but robust against dupe start/end)
    if (pts.length > 0 && (Math.abs(pts[0][0] - pts[pts.length-1][0]) > 1e-5 || Math.abs(pts[0][1] - pts[pts.length-1][1]) > 1e-5)) {
        // Points are distinct, keep them
    } else {
        pts.pop(); // Remove duplicate end point
    }
    polys.push(pts);

    // Holes
    if (shape.holes && shape.holes.length > 0) {
        shape.holes.forEach(h => {
            const hPts = h.getPoints(res).map(p => [p.x, p.y]);
            if (hPts.length > 0) {
                if (Math.abs(hPts[0][0] - hPts[hPts.length-1][0]) < 1e-5 && Math.abs(hPts[0][1] - hPts[hPts.length-1][1]) < 1e-5) {
                    hPts.pop();
                }
                polys.push(hPts); // Manifold handles winding automatically usually, or we ensure CCW/CW
            }
        });
    }
    
    return polys;
}

// Recursive function to collect shapes for a specific layer
function collectShapesForLayer(
    fp: Footprint, 
    allFootprints: Footprint[], 
    params: Parameter[], 
    layerId: string, 
    transform = { x: 0, y: 0, angle: 0 }
): { positives: THREE.Shape[], negatives: THREE.Shape[] } {
    let positives: THREE.Shape[] = [];
    let negatives: THREE.Shape[] = [];

    // Helper to evaluate basic geometry
    // Note: We duplicate some logic from meshUtils/footprintUtils to keep this worker standalone
    // Ideally, import `createLineShape`, `createBoardShape` from meshUtils if available in worker context.
    // For this snippet, I will assume we can generate THREE.Shapes.

    fp.shapes.forEach(s => {
        // --- TRANSFORMS ---
        const lx = (s.type === "line") ? 0 : evaluateExpression((s as any).x, params);
        const ly = (s.type === "line") ? 0 : evaluateExpression((s as any).y, params);
        const la = (s.type === "rect" || s.type === "footprint" || s.type === "union") ? evaluateExpression((s as any).angle, params) : 0;

        const rad = (transform.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        const gx = transform.x + (lx * cos - ly * sin);
        const gy = transform.y + (lx * sin + ly * cos);
        const ga = transform.angle + la;

        // --- RECURSION ---
        if (s.type === "footprint") {
            const ref = s as FootprintReference;
            const target = allFootprints.find(f => f.id === ref.footprintId);
            if (target) {
                const res = collectShapesForLayer(target, allFootprints, params, layerId, { x: gx, y: gy, angle: ga });
                positives.push(...res.positives);
                negatives.push(...res.negatives);
            }
            return;
        }

        if (s.type === "union") {
            const u = s as FootprintUnion;
            // Unions act as pass-through containers unless they have specific layer assignments overriding children
            // For simplicity, we recurse into them.
            const res = collectShapesForLayer({ ...fp, shapes: u.shapes }, allFootprints, params, layerId, { x: gx, y: gy, angle: ga });
            positives.push(...res.positives);
            negatives.push(...res.negatives);
            return;
        }

        // --- LAYER CHECK ---
        // 1. Board Outline: If this is a board and this shape is THE outline for this layer
        if (s.type === "boardOutline" && fp.isBoard && fp.boardOutlineAssignments?.[layerId] === s.id) {
            // Generate Shape
            const shape = new THREE.Shape();
            // ... (Simple Box fallback if complex logic missing, or implement getBoardShape logic)
            // Assuming points logic from utils:
            const points = (s as any).points || [];
            if(points.length > 2) {
                // Apply transform to points
                const tPoints = points.map((p: any) => {
                    const resolved = resolvePoint(p, fp, allFootprints, params);
                    // Rotate and Translate
                    const rx = resolved.x * cos - resolved.y * sin;
                    const ry = resolved.x * sin + resolved.y * cos;
                    return { x: gx + rx, y: gy + ry };
                });
                shape.moveTo(tPoints[0].x, tPoints[0].y);
                for(let i=1; i<tPoints.length; i++) shape.lineTo(tPoints[i].x, tPoints[i].y);
                shape.closePath();
                positives.push(shape);
            }
            return;
        }

        // 2. Standard Shapes
        // Check assignment
        const assigned = s.assignedLayers?.[layerId];
        if (!assigned && s.type !== "splitLine") return;

        // If split line, it is a negative on ALL layers (usually)
        const isNegative = s.type === "splitLine" || (s.type !== "boardOutline" && assigned); 
        
        // Generate THREE.Shape based on type (Circle, Rect, etc.)
        const shape = new THREE.Shape();
        
        if (s.type === "rect") {
            const w = evaluateExpression((s as any).width, params);
            const h = evaluateExpression((s as any).height, params);
            // Draw rect centered at 0,0, rotate, translate
            // We can use shape.absellipse for rounded rects or simple moveTo/lineTo
            // Simplified:
            const corners = [
                {x:-w/2, y:-h/2}, {x:w/2, y:-h/2}, {x:w/2, y:h/2}, {x:-w/2, y:h/2}
            ];
            const rrad = -(ga * Math.PI / 180); // Visual flip
            const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);
            
            const tCorners = corners.map(p => ({
                x: gx + (p.x * rcos - p.y * rsin),
                y: gy + (p.x * rsin + p.y * rcos) // Note: Y flip logic might differ based on coordinate system consistency
            }));
            
            shape.moveTo(tCorners[0].x, tCorners[0].y);
            tCorners.slice(1).forEach(p => shape.lineTo(p.x, p.y));
            shape.closePath();
        } 
        else if (s.type === "circle") {
            const r = evaluateExpression((s as any).diameter, params) / 2;
            shape.absarc(gx, gy, r, 0, Math.PI * 2, false);
        }
        else if (s.type === "splitLine") {
            // Split lines are thin rectangles
            // ... implementation of split line geometry ...
            const sx = evaluateExpression((s as any).x, params);
            const sy = evaluateExpression((s as any).y, params);
            const ex = evaluateExpression((s as any).endX, params);
            const ey = evaluateExpression((s as any).endY, params);
            
            // Transform to global
            const p1x = gx; // already transformed lx/ly
            const p1y = gy;
            // Vector rotation
            const p2x = gx + (ex * cos - ey * sin);
            const p2y = gy + (ex * sin + ey * cos);
            
            // Create a thin rectangle along this vector
            const thick = 0.5; // Default kerf
            const dx = p2x - p1x;
            const dy = p2y - p1y;
            const len = Math.sqrt(dx*dx + dy*dy);
            const nx = -dy/len * thick/2;
            const ny = dx/len * thick/2;
            
            shape.moveTo(p1x + nx, p1y + ny);
            shape.lineTo(p2x + nx, p2y + ny);
            shape.lineTo(p2x - nx, p2y - ny);
            shape.lineTo(p1x - nx, p1y - ny);
            shape.closePath();
            
            negatives.push(shape);
            return;
        }

        // Add to appropriate list
        // Note: For "Cut" layers, shapes are typically holes (negatives) in the board outline.
        // For "3D Print" layers, shapes might be additives (positives) OR holes.
        // Convention: 
        // - Board Outline is Positive.
        // - Assigned Shapes on a Board are Negatives (Holes).
        // - Shapes without a Board Outline context are Positives (Additives).
        
        if (fp.isBoard) {
            negatives.push(shape); // Cut out of the board
        } else {
            positives.push(shape); // Additive shape
        }
    });

    return { positives, negatives };
}

export function computeAnalyzablePart(payload: any, manifoldModule: any) {
    const { footprint, allFootprints, stackup, params, layerId } = payload;
    const layer = stackup.find((l: StackupLayer) => l.id === layerId);
    
    if (!layer || !manifoldModule) return null;

    const thickness = evaluateExpression(layer.thicknessExpression, params);
    
    // 1. Collect Shapes
    const { positives, negatives } = collectShapesForLayer(footprint, allFootprints, params, layerId);

    // 2. Build Manifolds
    const toManifold = (s: THREE.Shape) => {
        const polys = shapeToPolygons(s, 32);
        return manifoldModule.extrude(polys, thickness, 0, 0, [1,1]);
    };

    let result = null;

    // A. Start with Positives (Union)
    if (positives.length > 0) {
        result = toManifold(positives[0]);
        for(let i=1; i<positives.length; i++) {
            const next = toManifold(positives[i]);
            result = manifoldModule.union(result, next);
        }
    }

    // B. Subtract Negatives
    if (negatives.length > 0) {
        let negUnion = toManifold(negatives[0]);
        for(let i=1; i<negatives.length; i++) {
            const next = toManifold(negatives[i]);
            negUnion = manifoldModule.union(negUnion, next);
        }
        
        if (result) {
            result = manifoldModule.difference(result, negUnion);
        }
    }

    if (!result) return { volume: 0, surfaceArea: 0, meshData: null };

    // 3. Decompose (if split lines caused separation)
    // Manifold 'decompose' splits disjoint meshes
    const components = result.decompose();
    
    // For now, we return the metrics of the *combined* result, 
    // or we could return an array of components if the UI supports selecting sub-parts.
    // The prompt implies selecting "The one we want to analyze".
    // Let's assume we return the largest component by volume for analysis if split.
    
    let bestComp = components[0];
    let maxVol = -1;
    
    // Find largest volume component
    for (let i=0; i<components.length; i++) {
        const vol = components[i].getProperties().volume;
        if (vol > maxVol) {
            maxVol = vol;
            bestComp = components[i];
        }
    }
    
    const finalManifold = bestComp; // Or 'result' if we want all
    const props = finalManifold.getProperties();
    const mesh = finalManifold.getMesh();

    return {
        volume: props.volume,
        surfaceArea: props.surfaceArea,
        meshData: {
            vertices: Array.from(mesh.vertProperties),
            indices: Array.from(mesh.triVerts)
        }
    };
}

export function computeLayer(id: string, payload: any, manifoldModule: any, report: (msg: string, pct: number) => void) {
    if (!manifoldModule) throw new Error("Manifold not initialized");

    const { layer, footprint, allFootprints, params, thickness, bounds, layerIndex, totalLayers, resolution = 32 } = payload;
    const { Manifold, CrossSection } = manifoldModule;
    const garbage: any[] = [];
    const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

    const layerStr = `layer ${layer.name} (${layerIndex + 1}/${totalLayers})`;
    report(`Initializing ${layerStr}...`, 0);

    try {
        console.log(`[Worker] Computing Layer "${layer.name}" (Type: ${layer.type})`);
        
        const centerX = 0;
        const centerZ = 0;
        
        const boundsCenterX = (bounds.minX + bounds.maxX) / 2;
        const boundsCenterZ = (bounds.minY + bounds.maxY) / 2;
        const width = bounds.maxX - bounds.minX;
        const depth = bounds.maxY - bounds.minY; 

        const isBoard = footprint.isBoard;
        
        const assignments = footprint.boardOutlineAssignments || {};
        const assignedId = assignments[layer.id];
        let outlineShape = footprint.shapes.find((s: any) => s.id === assignedId) as FootprintBoardOutline | undefined;
        if (!outlineShape) {
            outlineShape = footprint.shapes.find((s: any) => s.type === "boardOutline") as FootprintBoardOutline | undefined;
        }
        
        let base: any;
        let boardShape: THREE.Shape | null = null;
        
        if (isBoard && outlineShape) {
            boardShape = createBoardShape(outlineShape, params, footprint, allFootprints);
        }

        if (boardShape) {
            const cs = collect(shapeToManifold(manifoldModule, boardShape, resolution));
            const ext = collect(cs.extrude(thickness));
            const rotated = collect(ext.rotate([-90, 0, 0]));
            base = collect(rotated.translate([0, -thickness/2, 0]));
        } else {
            let cube = collect(Manifold.cube([width, thickness, depth], true));
            base = collect(cube.translate([boundsCenterX, 0, -boundsCenterZ]));
        }

        if (!base) {
            throw new Error(`[Worker] Failed to generate base stock for layer ${layer.name}`);
        }
        
        const boundaryMask = base;
        const flatShapes = flattenShapes(footprint, footprint, footprint.shapes, allFootprints, params);
        
        interface ExecutionItem { type: "single" | "union"; shapes: FlatShape[]; unionId?: string; }
        const executionList: ExecutionItem[] = [];
        const unionMap = new Map<string, ExecutionItem>();
        
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

        executionList.forEach((exec, idx) => {
            const primaryItem = exec.shapes[0];
            const shape = primaryItem.shape;
            const shapeName = shape.name || (exec.type === "union" ? "Union" : "Shape");
            const itemStr = `${shapeName} (${idx + 1}/${totalOps})`;
            
            const basePercent = (idx / totalOps) * 0.9;
            
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

            let combinedCS: any = null;

            exec.shapes.forEach(item => {
                const s = item.shape;
                
                const localX = item.x - centerX;
                const localZ = centerZ - item.y; 

                const snapContextTransform = { x: item.relativeTransform.x, y: item.relativeTransform.y, angle: item.relativeTransform.rotation };

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
                    const lShape = createLineShape(s as FootprintLine, params, item.contextFp, allFootprints, validT, resolution, snapContextTransform);
                    if (lShape) cs = collect(shapeToManifold(manifoldModule, lShape, resolution));
                } else if (s.type === "polygon") {
                    const poly = s as FootprintPolygon;
                    const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, resolution, snapContextTransform);
                    if (pts.length > 2) {
                        cs = collect(new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
                    }
                }

                if (cs) {
                    cs = collect(cs.rotate(item.rotation));
                    cs = collect(cs.translate([localX, -localZ]));
                    if (!combinedCS) combinedCS = cs;
                    else combinedCS = collect(combinedCS.add(cs));
                }
            });

            if (!combinedCS) return;

            const disjointComponents = combinedCS.decompose(); 
            
            disjointComponents.forEach((rawComponent: any, k: number) => {
                const componentCS = collect(rawComponent);

                report(`Boolean operation for ${itemStr} on ${layerStr}...`, basePercent);

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

                if (isRestorative) {
                    const throughHeight = thickness + 0.2; 
                    const toolCutThrough = collect(collect(componentCS.extrude(throughHeight)).translate([0, 0, -throughHeight/2]));
                    const toolAligned = collect(toolCutThrough.rotate([-90, 0, 0])); 
                    
                    const diff = collect(Manifold.difference(base, toolAligned));
                    base = diff;

                    let fillHeight = thickness - actualDepth;
                    if (shouldGenTool) fillHeight += safeRadius;

                    if (fillHeight > CSG_EPSILON) {
                        const toolFill = collect(collect(componentCS.extrude(fillHeight)).translate([0, 0, -fillHeight/2]));
                        const fillAligned = collect(toolFill.rotate([-90, 0, 0]));
                        const fillY = layer.carveSide === "Top" ? (-thickness / 2 + fillHeight / 2) : (thickness / 2 - fillHeight / 2);
                        const moved = collect(fillAligned.translate([0, fillY, 0]));
                        base = collect(Manifold.union(base, moved));
                    }
                } else {
                    if (!shouldGenTool && actualDepth > CSG_EPSILON) {
                        let toolDepth = actualDepth;
                        let toolOffset = 0;
                        if (isThroughCut) {
                            toolDepth = thickness + 1.0; 
                            toolOffset = 0; 
                        } else {
                            toolDepth = actualDepth;
                            toolOffset = layer.carveSide === "Top" ? (thickness / 2 - actualDepth / 2) : (-thickness / 2 + actualDepth / 2);
                        }

                        const toolCut = collect(collect(componentCS.extrude(toolDepth)).translate([0, 0, -toolDepth/2]));
                        const toolAligned = collect(toolCut.rotate([-90, 0, 0]));
                        const moved = collect(toolAligned.translate([0, toolOffset, 0]));
                        
                        const nextBase = collect(Manifold.difference(base, moved));
                        
                        let opFailed = false;
                        try {
                            const nextVerts = (nextBase.numVert && typeof nextBase.numVert === 'function') 
                                ? nextBase.numVert() 
                                : nextBase.getMesh().vertProperties.length;
                            if (nextVerts === 0) {
                                const prevVerts = (base.numVert && typeof base.numVert === 'function')
                                    ? base.numVert()
                                    : base.getMesh().vertProperties.length;
                                if (prevVerts > 0) opFailed = true;
                            }
                        } catch (e) {
                            console.warn("[Worker] Mesh validation failed, assuming success", e);
                        }

                        if (opFailed) {
                            console.error(`[Worker] 🚨 CRITICAL: Mesh vanished after cutting "${shapeName}". Reverting this operation to preserve board.`);
                        } else {
                            base = nextBase;
                        }
                    }
                }

                if (shouldGenTool) {
                    report(`Generating tool for ${itemStr} on ${layerStr}...`, basePercent + 0.05);

                    const itemTransform = { x: primaryItem.relativeTransform.x, y: primaryItem.relativeTransform.y, angle: primaryItem.relativeTransform.rotation };

                    const result = generateProceduralTool(
                        manifoldModule, shape, params, actualDepth, inputRadius, effectiveBottomRadius,
                        footprint, allFootprints, resolution, componentCS, itemTransform
                    );

                    if (result && !result.manifold) {
                        report(`Error: Manifold failure on ${shapeName}`, 1.0);
                        self.postMessage({ 
                            id, type: "success", 
                            payload: { 
                                vertProperties: result.vertProperties, 
                                triVerts: result.triVerts,
                                isFailedTool: true,
                                errorShapeName: shapeName
                            } 
                        });
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

                        const _diagMesh = base.getMesh();
                        if (_diagMesh.vertProperties.length === 0) {
                            console.error(`[Worker] 🚨 CRITICAL: Mesh vanished after fillet subtract on "${shapeName}"`);
                        }
                    }
                }
            });
        });

        report(`Clipping to board boundary...`, 0.92);
        base = collect(manifoldModule.Manifold.intersection(base, boundaryMask));

        if (payload.enableSplit) {
            report(`Applying fabrication split...`, 0.94);
            const splitShapes = footprint.shapes.filter((s: any) => s.type === "splitLine");
            const targetIds: string[] | undefined = payload.splitLineIds;

            splitShapes.forEach((s: any) => {
                if (targetIds && targetIds.length > 0 && !targetIds.includes(s.id)) return;

                const sl = s as FootprintSplitLine;
                const startX = evaluate(sl.x, params);
                const startY = evaluate(sl.y, params);
                const endX = startX + evaluate(sl.endX, params);
                const endY = startY + evaluate(sl.endY, params);
                const positions = (sl.dovetailPositions || []).map(p => evaluate(p, params));
                const dWidth = evaluate(sl.dovetailWidth, params);
                const dHeight = evaluate(sl.dovetailHeight, params);
                const flip = !!sl.flip;
                const pts = generateDovetailPoints(startX, startY, endX, endY, positions, dWidth, dHeight, flip);
                
                const linePoints: Point[] = pts.map(p => ({ id: "temp", x: p.x.toString(), y: p.y.toString() }));
                const mockLine: FootprintLine = {
                    id: "temp_split", type: "line", name: "split",
                    x: "0", y: "0", thickness: (payload.splitKerf || 0.5).toString(), points: linePoints, assignedLayers: {}
                };

                const cutterPts = getLineOutlinePoints(mockLine, params, payload.splitKerf || 0.5, resolution, footprint, allFootprints);
                if (cutterPts.length >= 3) {
                    const polyArr = cutterPts.map(p => [p.x, p.y]).map(pt => [pt[0] - centerX, -(centerZ - pt[1])]);
                    let cutterCS = collect(new CrossSection([polyArr], "EvenOdd"));
                    const cutterH = thickness + 10;
                    const cutter3D = collect(collect(cutterCS.extrude(cutterH)).translate([0, 0, -cutterH/2]));
                    base = collect(Manifold.difference(base, collect(cutter3D.rotate([-90, 0, 0]))));
                }
            });
        }

        report(`Finalizing mesh for ${layerStr}...`, 0.95);

        const mesh = base.getMesh();

        let volume = 0;
        const numProp = mesh.numProp || 3;
        
        for (let i = 0; i < mesh.triVerts.length; i += 3) {
            const i1 = mesh.triVerts[i] * numProp;
            const i2 = mesh.triVerts[i+1] * numProp;
            const i3 = mesh.triVerts[i+2] * numProp;
            
            const v1x = mesh.vertProperties[i1]; const v1y = mesh.vertProperties[i1+1]; const v1z = mesh.vertProperties[i1+2];
            const v2x = mesh.vertProperties[i2]; const v2y = mesh.vertProperties[i2+1]; const v2z = mesh.vertProperties[i2+2];
            const v3x = mesh.vertProperties[i3]; const v3y = mesh.vertProperties[i3+1]; const v3z = mesh.vertProperties[i3+2];
            
            volume += v1x * (v2y * v3z - v2z * v3y) + v1y * (v2z * v3x - v2x * v3z) + v1z * (v2x * v3y - v2y * v3x);
        }
        volume = Math.abs(volume) / 6.0;

        console.log(`[Worker] Final Mesh "${layer.name}": ${mesh.vertProperties.length} verts, ${mesh.triVerts.length} tris, Vol: ${volume.toFixed(2)}`);
        report(`Layer ${layer.name}: Complete`, 1.0);

        self.postMessage({ 
            id, type: "success", 
            payload: { 
                vertProperties: mesh.vertProperties, 
                triVerts: mesh.triVerts,
                volume: volume
            } 
        });

    } finally {
        garbage.forEach(g => { try { g.delete(); } catch(e) {} });
    }
}

export function computeUnionOutline(id: string, payload: any, manifoldModule: any) {
    if (!manifoldModule) throw new Error("Manifold not initialized");
    const { shapes, params, contextFp, allFootprints, transform } = payload;
    const { CrossSection } = manifoldModule;
    const garbage: any[] = [];
    const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

    try {
        const flatShapes = flattenShapes(contextFp, contextFp, shapes, allFootprints, params, transform);
        let combinedCS: any = null;

        flatShapes.forEach(item => {
            const s = item.shape;
            const itemTransform = { x: item.relativeTransform.x, y: item.relativeTransform.y, angle: item.relativeTransform.rotation };
            
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
                const lShape = createLineShape(s as FootprintLine, params, item.contextFp, allFootprints, validT, 32, itemTransform);
                if (lShape) cs = collect(shapeToManifold(manifoldModule, lShape));
            } else if (s.type === "polygon") {
                const poly = s as FootprintPolygon;
                const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, 32, itemTransform);
                if (pts.length > 2) {
                    cs = collect(new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
                }
            }

            if (cs) {
                cs = collect(cs.rotate(item.rotation));
                cs = collect(cs.translate([item.x, item.y]));
                if (!combinedCS) combinedCS = cs;
                else combinedCS = collect(combinedCS.add(cs));
            }
        });

        let contours: {x:number, y:number}[][] = [];
        if (combinedCS) {
            const polys = combinedCS.toPolygons(); 
            contours = polys.map((poly: number[][]) => poly.map((pt: number[]) => ({ x: pt[0], y: pt[1] })));
        }

        self.postMessage({ id, type: "success", payload: contours });

    } finally {
        garbage.forEach(g => { try { g.delete(); } catch(e) {} });
    }
}
