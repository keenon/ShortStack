import { FootprintRect } from "../types";
import { evaluateExpression, getPolyOutlinePoints } from "../utils/footprintUtils";
import { createLineShape, flattenShapes, shapeToManifold } from "./meshUtils";

export function computeToolpath(id: string, payload: any, manifoldModule: any) {
    if (!manifoldModule) throw new Error("Manifold not initialized");
    const { shapes, params, contextFp, allFootprints, settings, layerThickness, layerId, bottomZ, resolution = 32 } = payload;
    const { CrossSection } = manifoldModule;
    const garbage: any[] = [];
    const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

    const toolpaths: number[][] = [];
    
    // 1. Settings
    const toolDiameter = evaluateExpression(settings.toolDiameterExpression, params);
    const toolRadius = toolDiameter / 2;
    const stepDown = Math.max(0.1, evaluateExpression(settings.stepDownExpression, params));
    const stepOverRaw = evaluateExpression(settings.stepOverExpression, params);
    const stockDepthRaw = evaluateExpression(settings.stockDepthExpression, params);
    
    const localLayerTopZ = layerThickness;
    const localStockTopZ = Math.max(stockDepthRaw, localLayerTopZ);
    
    const chuckDiameter = evaluateExpression(settings.chuckDiameterExpression, params);
    const chuckRadius = chuckDiameter / 2;
    const stepOver = Math.min(stepOverRaw, toolDiameter * 0.95); 
    
    const localSafeZ = localStockTopZ + 5; 
    
    // 2. Flatten and Resolve Shapes
    const flatShapes = flattenShapes(contextFp, contextFp, shapes, allFootprints, params);

    // 1.5. Surfacing (Facing) Pass
    if (Math.abs(localStockTopZ - localLayerTopZ) > 0.01) {
        let surfCS: any = null;
        const surfMargin = Math.max(toolRadius, chuckRadius + 2.0);

        if (contextFp.isBoard) {
            const assignments = contextFp.boardOutlineAssignments || {};
            const assignedId = assignments[layerId];
            let outlineShape = contextFp.shapes.find((s: any) => s.id === assignedId) as any;
            if (!outlineShape) outlineShape = contextFp.shapes.find((s: any) => s.type === "boardOutline") as any;
            
            if (outlineShape) {
                const originX = evaluateExpression(outlineShape.x, params);
                const originY = evaluateExpression(outlineShape.y, params);
                const pts = getPolyOutlinePoints(outlineShape.points, 0, 0, params, contextFp, allFootprints, resolution);
                const absPts = pts.map(p => [p.x + originX, p.y + originY]);
                
                if (absPts.length > 2) {
                    const baseCS = collect(new CrossSection([absPts], "EvenOdd"));
                    surfCS = collect(baseCS.offset(surfMargin, "Round"));
                }
            }
        }

        if (!surfCS) {
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            flatShapes.forEach((item) => {
                const s = item.shape;
                const x = item.x; 
                const y = item.y;
                if (s.type === 'rect') {
                    const w = evaluateExpression((s as FootprintRect).width, params);
                    const h = evaluateExpression((s as FootprintRect).height, params);
                    const r = item.rotation * (Math.PI/180);
                    const cos = Math.cos(r), sin = Math.sin(r);
                    const hw = w/2, hh = h/2;
                    [{x:-hw, y:-hh}, {x:hw, y:-hh}, {x:hw, y:hh}, {x:-hw, y:hh}].forEach(p => {
                        const px = x + p.x*cos - p.y*sin;
                        const py = y + p.x*sin + p.y*cos;
                        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
                        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
                    });
                } else {
                    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                }
            });
            if (minX === Infinity) { minX = 0; maxX = 100; minY = 0; maxY = 100; }
            
            minX -= surfMargin; maxX += surfMargin; 
            minY -= surfMargin; maxY += surfMargin;
            
            const width = maxX - minX;
            const height = maxY - minY;
            surfCS = collect(CrossSection.square([width, height], true));
            surfCS = collect(surfCS.translate([(minX + maxX)/2, (minY + maxY)/2]));
        }

        let currentSurfZ = 0; 
        const totalSurfDepth = localStockTopZ - localLayerTopZ;
        
        let surfOffset = surfCS;
        const surfContours: number[][] = [];
        
        while(!surfOffset.isEmpty()) {
                const polys = surfOffset.toPolygons();
                polys.forEach((poly: number[][]) => {
                if (poly.length > 2) {
                        const p = [...poly];
                        if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) p.push(p[0]);
                        surfContours.push(p.flat());
                }
                });
                surfOffset = collect(surfOffset.offset(-stepOver, "Round"));
        }
        
        while (currentSurfZ < totalSurfDepth - 0.001) {
            currentSurfZ += stepDown;
            if (currentSurfZ > totalSurfDepth) currentSurfZ = totalSurfDepth;
            
            const localZ = localStockTopZ - currentSurfZ;
            const visZ = localZ + bottomZ;
            const visSafeZ = visZ + 5;
            
            surfContours.forEach(flatPoly => {
                    const line3D: number[] = [];
                    for(let k=0; k<flatPoly.length; k+=2) {
                        line3D.push(flatPoly[k], visZ, -flatPoly[k+1]); 
                    }
                    if (line3D.length > 0) {
                        toolpaths.push([line3D[0], visSafeZ, line3D[2], line3D[0], visZ, line3D[2]]);
                        toolpaths.push(line3D);
                        const l = line3D.length;
                        toolpaths.push([line3D[l-3], visZ, line3D[l-1], line3D[l-3], visSafeZ, line3D[l-1]]);
                    }
            });
        }
    }
    
    interface Region { cs: any; depth: number; }
    let regions: Region[] = [];

    flatShapes.forEach(item => {
        const s = item.shape;
        if (!s.assignedLayers || s.assignedLayers[layerId] === undefined) return;

        const assignment = s.assignedLayers[layerId];
        const depthExpr = (typeof assignment === "object") ? assignment.depth : assignment;
        const targetDepth = Math.min(layerThickness, evaluateExpression(depthExpr, params));
        
        if (targetDepth <= 0.001) return;
        
        let shapeCS: any = null;
        const itemTransform = { x: item.relativeTransform.x, y: item.relativeTransform.y, angle: item.relativeTransform.rotation };

        if (s.type === "circle") {
            const d = evaluateExpression((s as any).diameter, params);
            if(d>0) shapeCS = collect(CrossSection.circle(d/2, resolution));
        } else if (s.type === "rect") {
            const w = evaluateExpression((s as any).width, params);
            const h = evaluateExpression((s as any).height, params);
            if(w>0 && h>0) shapeCS = collect(CrossSection.square([w, h], true));
        } else if (s.type === "line") {
            const t = evaluateExpression((s as any).thickness, params);
            const validT = t > 0 ? t : 0.01;
            const lShape = createLineShape(s as any, params, item.contextFp, allFootprints, validT, resolution, itemTransform);
            if (lShape) shapeCS = collect(shapeToManifold(manifoldModule, lShape, resolution));
        } else if (s.type === "polygon") {
            const poly = s as any;
            const pts = getPolyOutlinePoints(poly.points, 0, 0, params, item.contextFp, allFootprints, resolution, itemTransform);
            if (pts.length > 2) {
                shapeCS = collect(new CrossSection([pts.map(p => [p.x, p.y])], "EvenOdd"));
            }
        }

        if (shapeCS) {
            shapeCS = collect(shapeCS.rotate(item.rotation));
            shapeCS = collect(shapeCS.translate([item.x, item.y]));

            const nextRegions: Region[] = [];
            regions.forEach(r => {
                const diff = collect(r.cs.subtract(shapeCS));
                if (!diff.isEmpty()) {
                    nextRegions.push({ cs: diff, depth: r.depth });
                }
            });
            nextRegions.push({ cs: collect(shapeCS), depth: targetDepth });
            regions = nextRegions;
        }
    });

    regions.forEach(reg => {
        const pocketBounds = collect(reg.cs.offset(-toolRadius, "Round"));
        if (pocketBounds.isEmpty()) return;

        let currentOffset = pocketBounds;
        const pocketPaths: number[][][] = []; 

        while (!currentOffset.isEmpty()) {
            const polys = currentOffset.toPolygons();
            const passContours: number[][] = [];
            
            polys.forEach((poly: number[][]) => {
                if (poly.length > 2) {
                    const p = [...poly];
                    if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) {
                        p.push(p[0]);
                    }
                    passContours.push(p.flat()); 
                }
            });
            
            if (passContours.length > 0) pocketPaths.push(passContours);
            const nextOffset = currentOffset.offset(-stepOver, "Round");
            currentOffset = collect(nextOffset);
        }

        let currentZ = 0;
        while (currentZ < reg.depth - 0.001) {
            currentZ += stepDown;
            if (currentZ > reg.depth) currentZ = reg.depth;
            
            const localZ = localLayerTopZ - currentZ;
            const visZ = localZ + bottomZ;
            const visSafeZ = localSafeZ + bottomZ;
            
            pocketPaths.forEach(contours => {
                contours.forEach(flatPoly => {
                    const line3D: number[] = [];
                    for(let k=0; k<flatPoly.length; k+=2) {
                        line3D.push(flatPoly[k], visZ, -flatPoly[k+1]);
                    }
                    
                    if (line3D.length > 0) {
                        const startX = line3D[0];
                        const startY_Vis = line3D[2];
                        const entryPath = [startX, visSafeZ, startY_Vis, startX, visZ, startY_Vis];
                        toolpaths.push(entryPath);
                        toolpaths.push(line3D);
                        const endX = line3D[line3D.length-3];
                        const endY_Vis = line3D[line3D.length-1];
                        const exitPath = [endX, visZ, endY_Vis, endX, visSafeZ, endY_Vis];
                        toolpaths.push(exitPath);
                    }
                });
            });
        }
    });

    if (contextFp.isBoard) {
        const assignments = contextFp.boardOutlineAssignments || {};
        const assignedId = assignments[layerId];
        let outlineShape = contextFp.shapes.find((s: any) => s.id === assignedId) as any;
        if (!outlineShape) outlineShape = contextFp.shapes.find((s: any) => s.type === "boardOutline") as any;

        if (outlineShape) {
            let outlineCS: any = null;
            const originX = evaluateExpression(outlineShape.x, params);
            const originY = evaluateExpression(outlineShape.y, params);
            
            const pts = getPolyOutlinePoints(outlineShape.points, 0, 0, params, contextFp, allFootprints, resolution);
            const absPts = pts.map(p => [p.x + originX, p.y + originY]);
            
            if (absPts.length > 2) {
                outlineCS = collect(new CrossSection([absPts], "EvenOdd"));
                const moatMax = Math.max(toolRadius, chuckRadius + 2.0);
                const moatContours: number[][] = [];
                
                let currentOffset = toolRadius;
                while(currentOffset <= moatMax + 0.001) {
                    const offCS = collect(outlineCS.offset(currentOffset, "Round"));
                    const offPolys = offCS.toPolygons();
                    offPolys.forEach((poly: number[][]) => {
                        if (poly.length > 2) {
                            const p = [...poly];
                            if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) p.push(p[0]);
                            moatContours.push(p.flat());
                        }
                    });
                    
                    if (currentOffset >= moatMax) break;
                    currentOffset += stepOver;
                    if (currentOffset > moatMax) currentOffset = moatMax;
                }

                let currentZ = 0;
                const targetD = layerThickness + 0.5; 
                
                while (currentZ < targetD - 0.001) {
                    currentZ += stepDown;
                    if (currentZ > targetD) currentZ = targetD;
                    const localZ = localLayerTopZ - currentZ;
                    const visZ = localZ + bottomZ;
                    const visSafeZ = localSafeZ + bottomZ;

                    moatContours.forEach(flatPoly => {
                        const line3D: number[] = [];
                        for(let k=0; k<flatPoly.length; k+=2) {
                            line3D.push(flatPoly[k], visZ, -flatPoly[k+1]);
                        }
                        if (line3D.length > 0) {
                            const startX = line3D[0];
                            const startY_Vis = line3D[2];
                            toolpaths.push([startX, visSafeZ, startY_Vis, startX, visZ, startY_Vis]); 
                            toolpaths.push(line3D);
                            const endX = line3D[line3D.length-3];
                            const endY_Vis = line3D[line3D.length-1];
                            toolpaths.push([endX, visZ, endY_Vis, endX, visSafeZ, endY_Vis]);
                        }
                    });
                }
            }
        }
    }

    self.postMessage({ id, type: "success", payload: toolpaths });
    garbage.forEach(g => { try { g.delete(); } catch(e) {} });
}
