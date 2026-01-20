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

// @ts-ignore
import initOCCT from "occt-import-js";
import Module from "manifold-3d";
import { computeAnalyzablePart, computeLayer, computeUnionOutline } from "./layerOperations";
import { loadMesh, convertFile } from "./fileOperations";
import { computeToolpath } from "./toolpathOperations";

let occt: any = null;
let manifoldModule: any = null;

self.onmessage = async (e: MessageEvent) => {
    const { id, type, payload } = e.data;

    const report = (msg: string, percent: number) => {
        self.postMessage({ 
            type: "progress", 
            id, 
            payload: { 
                message: msg, 
                percent,
                layerIndex: payload.layerIndex 
            } 
        });
    };

    try {
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
                return;
            }
            self.postMessage({ id, type: "success", payload: "initialized" });
        }
        
        else if (type === "loadMesh") {
             await loadMesh(id, payload, report);
        }
        
        else if (type === "computeLayer") {
            computeLayer(id, payload, manifoldModule, report);
        }

        else if (type === "computeUnionOutline") {
            computeUnionOutline(id, payload, manifoldModule);
        }
        
        else if (type === "convert") {
            await convertFile(id, payload, occt, report);
        }
        
        else if (type === "computeToolpath") {
            if (!manifoldModule) throw new Error("Manifold not initialized");
            const { shapes, params, contextFp, allFootprints, settings, layerThickness, layerId, bottomZ, carveSide, resolution = 32 } = payload;
            const { CrossSection } = manifoldModule;
            const garbage: any[] = [];
            const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };

            const toolpaths: number[][] = [];
            
            // 1. Settings
            const toolDiameter = evaluateExpression(settings.toolDiameterExpression, params);
            const toolRadius = toolDiameter / 2;
            const stepDown = Math.max(0.1, evaluateExpression(settings.stepDownExpression, params));
            const stepOverRaw = evaluateExpression(settings.stepOverExpression, params);
            
            // --- NEW: Parse Stock & Chuck Settings ---
            const stockDepthRaw = evaluateExpression(settings.stockDepthExpression, params);
            
            // LOCAL Z COORDINATES (0 = Bottom of Layer, Thickness = Top of Layer)
            const localLayerTopZ = layerThickness;
            const localStockTopZ = Math.max(stockDepthRaw, localLayerTopZ);
            
            const chuckDiameter = evaluateExpression(settings.chuckDiameterExpression, params);
            const chuckRadius = chuckDiameter / 2;
            // Default logic: if stepOver > toolDiameter, clamp it. If user intended mm, it works. 
            const stepOver = Math.min(stepOverRaw, toolDiameter * 0.95); 
            
            const localSafeZ = localStockTopZ + 5; // 5mm clearance above stock
            
            // 2. Flatten and Resolve Shapes (MOVED UP FOR BOUNDS CALCULATION)
            const flatShapes = flattenShapes(contextFp, contextFp, shapes, allFootprints, params);

            // 1.5. Surfacing (Facing) Pass
            // If the stock is higher than the layer top, we must face it off first.
            if (Math.abs(localStockTopZ - localLayerTopZ) > 0.01) {
                // Calculate Bounding Box of the Board
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                
                const allPoints: Point[] = [];
                // Collect points from flattened shapes to determine bounds correctly
                flatShapes.forEach((item) => {
                    const s = item.shape;
                    if ((s as any).points) allPoints.push(...(s as any).points);
                    if (s.type === 'rect') {
                        const w = evaluateExpression((s as FootprintRect).width, params);
                        const h = evaluateExpression((s as FootprintRect).height, params);
                        
                        // Use Resolved Global Transforms from flatShapes
                        const x = item.x;
                        const y = item.y;
                        const r = item.rotation * (Math.PI / 180);
                        
                        const cos = Math.cos(r);
                        const sin = Math.sin(r);
                        const hw = w/2; 
                        const hh = h/2;
                        
                        // Relative corners
                        const corners = [
                           {x: -hw, y: -hh}, {x: hw, y: -hh},
                           {x: hw, y: hh}, {x: -hw, y: hh}
                        ];
                        
                        corners.forEach(c => {
                           // Rotate then Translate
                           const rx = x + (c.x * cos - c.y * sin);
                           const ry = y + (c.x * sin + c.y * cos);
                           minX = Math.min(minX, rx); maxX = Math.max(maxX, rx);
                           minY = Math.min(minY, ry); maxY = Math.max(maxY, ry);
                        });
                    }
                });
                
                // If checking points
                if (minX === Infinity) { minX = 0; maxX = 100; minY = 0; maxY = 100; }
                
                // Add margins for the surfacing block
                const margin = toolDiameter * 2;
                minX -= margin; maxX += margin; minY -= margin; maxY += margin;
                
                // Create Surfacing Shape (Rectangle)
                const width = maxX - minX;
                const height = maxY - minY;
                
                // Use Manifold to generate pocketing for this rect
                let surfCS = collect(CrossSection.square([width, height], true));
                surfCS = collect(surfCS.translate([(minX + maxX)/2, (minY + maxY)/2])); // Center it (Note Y flip for Manifold logic)

                // Generate Surfacing Toolpaths
                // We cut from StockTop down to LayerTop
                let currentSurfZ = 0; // Relative to Stock Top
                const totalSurfDepth = localStockTopZ - localLayerTopZ;
                
                // Surfacing pocket loop
                let surfOffset = surfCS;
                const surfContours: number[][] = [];
                
                // Calculate concentric paths for the block
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
                
                // Generate Z moves for surfacing
                // We cut from Stock Top down to Layer Top
                while (currentSurfZ < totalSurfDepth - 0.001) {
                    currentSurfZ += stepDown;
                    if (currentSurfZ > totalSurfDepth) currentSurfZ = totalSurfDepth;
                    
                    // Local Z Height (cutting down)
                    const localZ = localStockTopZ - currentSurfZ;
                    // Visual Z Height (Global)
                    const visZ = localZ + bottomZ;
                    const visSafeZ = visZ + 5;
                    
                    surfContours.forEach(flatPoly => {
                         const line3D: number[] = [];
                         // Map X,Y to X,Z,-Y (Vis uses -Y for depth)
                         for(let k=0; k<flatPoly.length; k+=2) {
                             line3D.push(flatPoly[k], visZ, -flatPoly[k+1]); 
                         }
                         if (line3D.length > 0) {
                             // Entry
                             toolpaths.push([line3D[0], visSafeZ, line3D[2], line3D[0], visZ, line3D[2]]);
                             // Cut
                             toolpaths.push(line3D);
                             // Exit
                             const l = line3D.length;
                             toolpaths.push([line3D[l-3], visZ, line3D[l-1], line3D[l-3], visSafeZ, line3D[l-1]]);
                         }
                    });
                }
            }


            
            // 3. Build Depth Map (Non-Overlapping Regions)
            // Strategy: Iterate shapes last-to-first (or first-to-last?).
            // User requirement: "shallow shape depth can override overlapping shapes with deeper depth, depending on the shape list order!"
            // Interpretation: Later shapes in the list are "on top" or higher priority.
            // If Shape A (Depth 5) is first, Shape B (Depth 2) is second.
            // If they overlap, the overlap area should be Depth 2.
            // Algorithm: 
            //   Regions = []
            //   For each Shape S:
            //     Subtract S from all Existing Regions (splitting them if needed).
            //     Add S as a new Region.
            
            interface Region { cs: any; depth: number; }
            let regions: Region[] = [];

            flatShapes.forEach(item => {
                const s = item.shape;
                if (!s.assignedLayers || s.assignedLayers[layerId] === undefined) return;

                const assignment = s.assignedLayers[layerId];
                const depthExpr = (typeof assignment === "object") ? assignment.depth : assignment;
                const targetDepth = Math.min(layerThickness, evaluateExpression(depthExpr, params));
                
                if (targetDepth <= 0.001) return;

                // Create Shape CrossSection
                // Coordinate Transform: Shift global X/Y to Worker Local (0,0 centered at global origin)
                // Note: flattenShapes returns Global X/Y.
                // In computeLayer, we used `centerX=0`, so local=global.
                // BUT we flipped Y for Manifold? `localZ = centerZ - item.y`.
                // Here we want 2D toolpaths (X, Y).
                // Let's stick to the coordinate system used by the visualizer: 2D Y is Up.
                // FlattenShapes returns standard Math coordinates (Y Up).
                // Visualizer expects [x, z, -y] for 3D lines.
                // So here we process in (X, Y).
                
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

                    // Update Regions Map
                    const nextRegions: Region[] = [];
                    
                    // Subtract new shape from all existing regions
                    regions.forEach(r => {
                        // FIX: Use .subtract() instead of .difference()
                        const diff = collect(r.cs.subtract(shapeCS));
                        if (!diff.isEmpty()) {
                            nextRegions.push({ cs: diff, depth: r.depth });
                        }
                    });
                    
                    // Add new shape
                    nextRegions.push({ cs: collect(shapeCS), depth: targetDepth });
                    regions = nextRegions;
                }
            });

            // 4. Generate Toolpaths for Each Disjoint Region
            regions.forEach(reg => {
                // Offset Inwards by Tool Radius to define pocket bounds
                const pocketBounds = collect(reg.cs.offset(-toolRadius, "Round"));
                
                if (pocketBounds.isEmpty()) return; // Too small for tool

                // Generate Clearing Paths (Pocketing)
                let currentOffset = pocketBounds;
                const pocketPaths: number[][][] = []; // List of contours

                // Generate concentric passes
                while (!currentOffset.isEmpty()) {
                    const polys = currentOffset.toPolygons(); // number[][][]
                    const passContours: number[][] = [];
                    
                    polys.forEach((poly: number[][]) => {
                        // Close loop if needed
                        if (poly.length > 2) {
                            const p = [...poly];
                            // Ensure closure
                            if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) {
                                p.push(p[0]);
                            }
                            // Map 2D (x,y) to 3D flat line
                            // We store just the 2D path here, we'll extrude to Z levels later
                            passContours.push(p.flat()); // [x,y, x,y...]
                        }
                    });
                    
                    if (passContours.length > 0) pocketPaths.push(passContours);
                    
                    // Step In
                    const nextOffset = currentOffset.offset(-stepOver, "Round");
                    currentOffset = collect(nextOffset);
                }

                // Generate Z-Moves for this Pocket
                // We clear the whole pocket at each Z level before moving deeper? 
                // Or clear full depth for one contour? 
                // Standard is "Level by Level": clear entire area at Z1, then Z2.
                
                let currentZ = 0;
                while (currentZ < reg.depth - 0.001) {
                    currentZ += stepDown;
                    if (currentZ > reg.depth) currentZ = reg.depth;
                    
                    // Local Z: Start at Layer Top, go down by currentZ
                    const localZ = localLayerTopZ - currentZ;
                    
                    // Visual Z
                    const visZ = localZ + bottomZ;
                    const visSafeZ = localSafeZ + bottomZ;
                    
                    // Add paths for this level
                    pocketPaths.forEach(contours => {
                        contours.forEach(flatPoly => {
                            const line3D: number[] = [];
                            // Convert [x,y, x,y] to [x, zHeight, -y]
                            for(let k=0; k<flatPoly.length; k+=2) {
                                line3D.push(flatPoly[k], visZ, -flatPoly[k+1]);
                            }
                            
                            if (line3D.length > 0) {
                                // Add Travel moves
                                const startX = line3D[0];
                                const startY_Vis = line3D[2]; // -y
                                
                                // Retract/Rapid Connection
                                const entryPath = [
                                    startX, visSafeZ, startY_Vis, // Start high
                                    startX, visZ, startY_Vis // Plunge
                                ];
                                toolpaths.push(entryPath);
                                
                                // Cut Path
                                toolpaths.push(line3D);
                                
                                // Retract at end
                                const endX = line3D[line3D.length-3];
                                const endY_Vis = line3D[line3D.length-1];
                                const exitPath = [
                                    endX, visZ, endY_Vis,
                                    endX, visSafeZ, endY_Vis
                                ];
                                toolpaths.push(exitPath);
                            }
                        });
                    });
                }
            });

            // 5. Final Profile Cut (Board Outline) with Chuck Clearance
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
                        
                        // We generate a "Moat" around the outline to ensure the chuck fits
                        // Loop from Tool Radius up to Chuck Radius + Margin
                        const moatMax = Math.max(toolRadius, chuckRadius + 2.0);
                        const moatContours: number[][] = [];
                        
                        // Generate all offset contours first
                        // We cut from Inside (Outline) -> Out (Moat Edge) so dimensions are cut first
                        let currentOffset = toolRadius;
                        while(currentOffset <= moatMax + 0.001) {
                            const offCS = collect(outlineCS.offset(currentOffset, "Round"));
                            const offPolys = offCS.toPolygons();
                            offPolys.forEach((poly: number[][]) => {
                                if (poly.length > 2) {
                                    const p = [...poly];
                                    if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) p.push(p[0]);
                                    // Flatten
                                    moatContours.push(p.flat());
                                }
                            });
                            
                            if (currentOffset >= moatMax) break;
                            currentOffset += stepOver;
                            if (currentOffset > moatMax) currentOffset = moatMax; // Ensure final cleanup pass
                        }

                        let currentZ = 0;
                        const targetD = layerThickness + 0.5; // Cut slightly through
                        
                        while (currentZ < targetD - 0.001) {
                            currentZ += stepDown;
                            if (currentZ > targetD) currentZ = targetD;
                            
                            // Local Z
                            const localZ = localLayerTopZ - currentZ;
                            
                            // Visual Z
                            const visZ = localZ + bottomZ;
                            const visSafeZ = localSafeZ + bottomZ;

                            moatContours.forEach(flatPoly => {
                                const line3D: number[] = [];
                                // Map to Vis Coords (X, Z, -Y)
                                for(let k=0; k<flatPoly.length; k+=2) {
                                    line3D.push(flatPoly[k], visZ, -flatPoly[k+1]);
                                }
                                if (line3D.length > 0) {
                                    // Connect
                                    const startX = line3D[0];
                                    const startY_Vis = line3D[2];
                                    toolpaths.push([startX, visSafeZ, startY_Vis, startX, visZ, startY_Vis]); // Entry
                                    toolpaths.push(line3D); // Cut
                                    const endX = line3D[line3D.length-3];
                                    const endY_Vis = line3D[line3D.length-1];
                                    toolpaths.push([endX, visZ, endY_Vis, endX, visSafeZ, endY_Vis]); // Exit
                                }
                            });
                        }
                    }
                }
            }

            self.postMessage({ id, type: "success", payload: toolpaths });
            
            // Cleanup
            garbage.forEach(g => { try { g.delete(); } catch(e) {} });
        }

        else if (type === "computeAnalyzablePart") {
            const result = computeAnalyzablePart(payload, manifoldModule);
            self.postMessage({ id, type: "success", payload: result });
        }

    } catch (err: any) {
        self.postMessage({ id, type: "error", error: err.message || "Unknown worker error" });
    }
};
