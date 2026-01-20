import * as THREE from "three";
import { FootprintBoardOutline, FootprintRect, FootprintLine, FootprintPolygon, FootprintSplitLine, Point, Footprint, Parameter, StackupLayer, FootprintReference, FootprintUnion } from "../types";
import { evaluateExpression, getPolyOutlinePoints, generateDovetailPoints, resolvePoint } from "../utils/footprintUtils";
import { createBoardShape, createLineShape, flattenShapes, shapeToManifold, FlatShape, getLineOutlinePoints, evaluate } from "./meshUtils";
import { generateProceduralTool } from "./proceduralTool";

// SHARED LOGIC: Generates the Manifold geometry for a layer
// Extracts the core logic previously found inside computeLayer so it can be reused for analysis.
function generateLayerManifold(
    manifoldModule: any,
    payload: any,
    garbage: any[],
    report: (msg: string, pct: number) => void
) {
    const { Manifold, CrossSection } = manifoldModule;
    const { layer, footprint, allFootprints, params, thickness, bounds, layerIndex, totalLayers, resolution = 32 } = payload;
    
    // Helper to track disposables
    const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

    const layerStr = layer.name; 

    console.log(`[Worker] Computing Layer "${layer.name}" (Type: ${layer.type})`);
    
    const centerX = 0;
    const centerZ = 0;
    
    // Default bounds if missing (e.g. analysis mode)
    const bMinX = bounds ? bounds.minX : -100;
    const bMaxX = bounds ? bounds.maxX : 100;
    const bMinY = bounds ? bounds.minY : -100;
    const bMaxY = bounds ? bounds.maxY : 100;

    const boundsCenterX = (bMinX + bMaxX) / 2;
    const boundsCenterZ = (bMinY + bMaxY) / 2;
    const width = bMaxX - bMinX;
    const depth = bMaxY - bMinY; 

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
        const itemStr = `${shapeName}`;
        
        const basePercent = totalOps > 0 ? (idx / totalOps) * 0.9 : 0;
        
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

            report(`Boolean operation for ${itemStr}...`, basePercent);

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
                report(`Generating tool for ${itemStr}...`, basePercent + 0.05);

                const itemTransform = { x: primaryItem.relativeTransform.x, y: primaryItem.relativeTransform.y, angle: primaryItem.relativeTransform.rotation };

                const result = generateProceduralTool(
                    manifoldModule, shape, params, actualDepth, inputRadius, effectiveBottomRadius,
                    footprint, allFootprints, resolution, componentCS, itemTransform
                );

                if (result && !result.manifold) {
                    report(`Error: Manifold failure on ${shapeName}`, 1.0);
                    // We can't postMessage here easily, so we throw to be caught by caller
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

    return base;
}

export function computeLayer(id: string, payload: any, manifoldModule: any, report: (msg: string, pct: number) => void) {
    if (!manifoldModule) throw new Error("Manifold not initialized");
    const garbage: any[] = [];
    
    try {
        const base = generateLayerManifold(manifoldModule, payload, garbage, report);

        report(`Finalizing mesh...`, 0.95);
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

        console.log(`[Worker] Final Mesh: ${mesh.vertProperties.length} verts`);
        report(`Complete`, 1.0);

        self.postMessage({ 
            id, type: "success", 
            payload: { 
                vertProperties: mesh.vertProperties, 
                triVerts: mesh.triVerts,
                volume: volume
            } 
        });

    } catch(e: any) {
        console.error(e);
        throw e;
    } finally {
        garbage.forEach(g => { try { g.delete(); } catch(e) {} });
    }
}

export function computeAnalyzablePart(payload: any, manifoldModule: any, report: (msg: string, pct: number) => void) {
    if (!manifoldModule) return null;
    const garbage: any[] = [];
    
    try {
        // 1. Resolve Layer Context
        const layer = payload.stackup.find((l: any) => l.id === payload.layerId);
        if(!layer) throw new Error("Layer not found");
        
        const thickness = evaluateExpression(layer.thicknessExpression, payload.params);
        
        // 2. Synthetic Bounds (Analysis usually assumes Board Outline or large stock)
        const syntheticPayload = {
            ...payload,
            layer,
            thickness,
            bounds: { minX: -1000, maxX: 1000, minY: -1000, maxY: 1000 },
            resolution: 32,
            enableSplit: true // Ensure split logic runs so we can verify split parts
        };

        // If report is not passed (legacy call), mock it
        const safeReport = report || ((msg: string, pct: number) => console.log(msg));

        safeReport("Generating Manifold Geometry...", 0.1);
        const base = generateLayerManifold(manifoldModule, syntheticPayload, garbage, safeReport);
        
        safeReport("Decomposing Parts...", 0.9);
        
        // 3. Decompose and Sort
        const components = base.decompose();
        const sortedComponents = [];
        
        for (let i=0; i<components.length; i++) {
            const comp = components[i];
            const vol = comp.volume();
            sortedComponents.push({ mesh: comp, volume: vol });
        }
        
        // Sort descending by volume (Index 0 = Largest/Main Board)
        sortedComponents.sort((a, b) => b.volume - a.volume);
        
        // Select requested part
        const reqIndex = payload.partIndex || 0;
        const selected = (reqIndex < sortedComponents.length) ? sortedComponents[reqIndex] : sortedComponents[0];
        
        console.log(`[Worker] Analysis: Selected part ${reqIndex} of ${sortedComponents.length}. Vol: ${selected.volume}`);
        safeReport(`Processing Part ${reqIndex + 1}/${sortedComponents.length}...`, 0.95);

        const finalManifold = selected.mesh;
        const mesh = finalManifold.getMesh();

        return {
            volume: finalManifold.volume(),
            surfaceArea: finalManifold.surfaceArea(),
            meshData: {
                vertices: Array.from(mesh.vertProperties),
                indices: Array.from(mesh.triVerts)
            }
        };

    } catch(e) {
        console.error(e);
        throw e;
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
