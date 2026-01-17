import { FootprintRect } from "../types";
import { evaluateExpression, getPolyOutlinePoints } from "../utils/footprintUtils";
import { createLineShape, flattenShapes, shapeToManifold } from "./meshUtils";

// --- G-CODE GENERATOR & PARSER ---

class GCodeGenerator {
    private lines: string[] = [];
    private currentX: number = 0;
    private currentY: number = 0;
    private currentZ: number = 0;
    private currentFeed: number = 0;
    private safeZ: number = 5;
    private isRetracted: boolean = true;
    private precision: number = 4;

    constructor(
        safeZ: number, 
        spindleRpm: number, 
        feedRate: number, 
        private plungeRate: number
    ) {
        this.safeZ = safeZ;
        this.lines.push("%");
        this.lines.push("G90 G17 G21"); // Absolute, XY Plane, mm
        this.lines.push(`G0 Z${this.fmt(safeZ)}`);
        this.lines.push(`S${Math.round(spindleRpm)} M3`);
        this.lines.push(`F${this.fmt(feedRate)}`);
        this.currentFeed = feedRate;
        this.currentZ = safeZ;
    }

    private fmt(n: number): string {
        return n.toFixed(this.precision);
    }

    public addComment(text: string) {
        this.lines.push(`; ${text}`);
    }

    public moveToSafeZ() {
        if (!this.isRetracted || Math.abs(this.currentZ - this.safeZ) > 0.001) {
            this.lines.push(`G0 Z${this.fmt(this.safeZ)}`);
            this.currentZ = this.safeZ;
            this.isRetracted = true;
        }
    }

    public rapidTo(x: number, y: number) {
        this.moveToSafeZ();
        this.lines.push(`G0 X${this.fmt(x)} Y${this.fmt(y)}`);
        this.currentX = x;
        this.currentY = y;
    }

    public plunge(z: number) {
        this.lines.push(`G1 Z${this.fmt(z)} F${this.fmt(this.plungeRate)}`);
        this.lines.push(`F${this.fmt(this.currentFeed)}`); 
        this.currentZ = z;
        this.isRetracted = false;
    }

    // Fits G2/G3 arcs to a sequence of points
    public tracePath(points: number[]) {
        if (points.length < 2) return;

        // Ensure we are at start
        const startX = points[0];
        const startY = points[1]; 
        
        const distSq = (startX - this.currentX)**2 + (startY - this.currentY)**2;
        if (distSq > 0.0001 || this.isRetracted) {
            this.rapidTo(startX, startY);
        }

        let i = 0;
        // Process segments
        while (i < points.length - 2) { 
            const arc = this.fitArc(points, i);
            
            if (arc) {
                const cmd = arc.direction === 'CW' ? 'G2' : 'G3';
                // I, J are relative to start point
                const I = arc.center.x - points[i];
                const J = arc.center.y - points[i+1];
                
                this.lines.push(`${cmd} X${this.fmt(arc.end.x)} Y${this.fmt(arc.end.y)} I${this.fmt(I)} J${this.fmt(J)}`);
                
                this.currentX = arc.end.x;
                this.currentY = arc.end.y;
                i = arc.nextIndex;
            } else {
                const nextX = points[i+2];
                const nextY = points[i+3];
                this.lines.push(`G1 X${this.fmt(nextX)} Y${this.fmt(nextY)}`);
                this.currentX = nextX;
                this.currentY = nextY;
                i += 2;
            }
        }
    }

    private fitArc(points: number[], startIndex: number): { center: {x:number, y:number}, end: {x:number, y:number}, nextIndex: number, direction: 'CW' | 'CCW' } | null {
        if (startIndex + 5 >= points.length) return null;

        const p1 = { x: points[startIndex], y: points[startIndex+1] };
        const p2 = { x: points[startIndex+2], y: points[startIndex+3] };
        const p3 = { x: points[startIndex+4], y: points[startIndex+5] };

        const circle = this.getCircleFrom3Points(p1, p2, p3);
        if (!circle) return null; 

        // Limits for plausible arcs
        if (circle.r > 10000 || circle.r < 0.1) return null;

        const tol = 0.02; // Tolerance for fitting
        if (!this.isPointOnCircle(p2, circle, tol)) return null;

        let lastValidIndex = startIndex + 4;
        
        // Greedily consume points that fit the arc
        for (let k = startIndex + 6; k < points.length; k += 2) {
            const pNext = { x: points[k], y: points[k+1] };
            if (this.isPointOnCircle(pNext, circle, tol)) {
                lastValidIndex = k;
            } else {
                break;
            }
        }
        
        // Vector Cross Product to determine direction
        const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
        const direction = cross < 0 ? 'CW' : 'CCW';

        return {
            center: { x: circle.x, y: circle.y },
            end: { x: points[lastValidIndex], y: points[lastValidIndex+1] },
            nextIndex: lastValidIndex,
            direction
        };
    }

    private getCircleFrom3Points(p1: {x:number,y:number}, p2: {x:number,y:number}, p3: {x:number,y:number}) {
        const x1 = p1.x, y1 = p1.y;
        const x2 = p2.x, y2 = p2.y;
        const x3 = p3.x, y3 = p3.y;

        const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        if (Math.abs(D) < 1e-6) return null; 

        const centerX = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / D;
        const centerY = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / D;
        
        const r = Math.sqrt((centerX - x1)**2 + (centerY - y1)**2);
        return { x: centerX, y: centerY, r };
    }

    private isPointOnCircle(p: {x:number, y:number}, c: {x:number, y:number, r:number}, tolerance: number): boolean {
        const d = Math.sqrt((p.x - c.x)**2 + (p.y - c.y)**2);
        return Math.abs(d - c.r) <= tolerance;
    }

    public getGCode(): string {
        this.moveToSafeZ();
        this.lines.push("M5");
        this.lines.push("M30");
        this.lines.push("%");
        return this.lines.join("\n");
    }
}

// Re-interprets the text G-code back into 3D polylines for visualization
function parseGCodeToMeshLines(gcode: string): number[][] {
    const segments: number[][] = [];
    let currentPoly: number[] = [];
    
    let x = 0, y = 0, z = 0; 
    let lastMode = 'G0';
    
    const lines = gcode.split('\n');
    const reCmd = /([GXYZIJ])([-\d\.]+)/g;
    
    const finishPoly = () => {
        if (currentPoly.length > 0) {
            segments.push(currentPoly);
            currentPoly = [];
        }
    };

    for(const line of lines) {
        const clean = line.split(';')[0].trim();
        if(!clean || clean === '%') continue;
        
        let match;
        const params: Record<string, number> = {};
        const cmds: string[] = [];
        reCmd.lastIndex = 0;
        
        while ((match = reCmd.exec(clean)) !== null) {
            const letter = match[1];
            const val = parseFloat(match[2]);
            if (letter === 'G') cmds.push(`G${val}`); 
            else params[letter] = val;
        }
        
        let moveType = cmds.find(c => ['G0','G1','G2','G3'].includes(c));
        
        // Modal state handling
        if (!moveType) {
            if (params.X !== undefined || params.Y !== undefined || params.Z !== undefined) {
                 moveType = lastMode;
            } else {
                 continue; // Just feedrate or other setup
            }
        } else {
            lastMode = moveType;
        }

        const targetX = params.X !== undefined ? params.X : x;
        const targetY = params.Y !== undefined ? params.Y : y;
        const targetZ = params.Z !== undefined ? params.Z : z;

        // --- Visualization Logic ---
        // Coordinates: Map (X, Y, Z) -> (x, z, -y) to match visualizer system

        if (moveType === 'G0') {
             // If XY changes (Rapid Traverse), break the line (don't draw spiderwebs)
             const distXY = Math.abs(targetX - x) + Math.abs(targetY - y);
             if (distXY > 0.001) {
                 finishPoly();
             } else if (Math.abs(targetZ - z) > 0.001) {
                 // Vertical Rapid (Retract/Plunge) - Draw this
                 if (currentPoly.length === 0) currentPoly.push(x, z, -y);
                 currentPoly.push(targetX, targetZ, -targetY);
             }
        }
        else if (moveType === 'G1') {
             if (currentPoly.length === 0) currentPoly.push(x, z, -y);
             currentPoly.push(targetX, targetZ, -targetY);
        }
        else if (moveType === 'G2' || moveType === 'G3') {
             // Arc Interpolation
             const I = params.I || 0;
             const J = params.J || 0;
             const cx = x + I;
             const cy = y + J;
             const r = Math.sqrt(I*I + J*J);
             
             const startAngle = Math.atan2(y - cy, x - cx);
             const endAngle = Math.atan2(targetY - cy, targetX - cx);
             
             let diff = endAngle - startAngle;
             // Adjust for direction
             if (moveType === 'G2') { // CW
                 if (diff >= 0) diff -= 2 * Math.PI;
                 if (diff < -2 * Math.PI) diff += 2 * Math.PI;
             } else { // CCW
                 if (diff <= 0) diff += 2 * Math.PI;
                 if (diff > 2 * Math.PI) diff -= 2 * Math.PI;
             }
             
             const segments = Math.max(8, Math.ceil(Math.abs(diff) * r)); // Adaptive res
             if (currentPoly.length === 0) currentPoly.push(x, z, -y);
             
             for(let i=1; i<=segments; i++) {
                 const t = i/segments;
                 const ang = startAngle + diff * t;
                 const px = cx + r * Math.cos(ang);
                 const py = cy + r * Math.sin(ang);
                 const pz = z + (targetZ - z) * t; // Helical support
                 currentPoly.push(px, pz, -py);
             }
        }
        
        x = targetX;
        y = targetY;
        z = targetZ;
    }
    
    finishPoly();
    return segments;
}

// --- MAIN WORKER ---

export function computeToolpath(id: string, payload: any, manifoldModule: any) {
    if (!manifoldModule) throw new Error("Manifold not initialized");
    const { shapes, params, contextFp, allFootprints, settings, layerThickness, layerId, bottomZ, resolution = 32 } = payload;
    const { CrossSection } = manifoldModule;
    const garbage: any[] = [];
    const collect = <T>(obj: T): T => { if(obj && (obj as any).delete) garbage.push(obj); return obj; };
    
    // 1. Settings & Generator Initialization
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
    
    const feedRate = evaluateExpression(settings.feedrateExpression, params) || 1000;
    const spindleRpm = evaluateExpression(settings.spindleRpmExpression, params) || 12000;
    const plungeRate = feedRate * 0.4;
    const safeHeight = 5.0;
    
    // Visualization Z Levels (Absolute)
    const visStockTop = localStockTopZ + bottomZ;
    const visSafeZ = visStockTop + safeHeight;

    const gcode = new GCodeGenerator(visSafeZ, spindleRpm, feedRate, plungeRate);

    // 2. Flatten and Resolve Shapes
    const flatShapes = flattenShapes(contextFp, contextFp, shapes, allFootprints, params);

    // 1.5. Surfacing (Facing) Pass
    if (Math.abs(localStockTopZ - localLayerTopZ) > 0.01) {
        gcode.addComment("Operation: Surfacing / Facing");
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
        
        // Generate surfacing contours
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
            const cutZ = localZ + bottomZ;
            
            surfContours.forEach(flatPoly => {
                gcode.rapidTo(flatPoly[0], flatPoly[1]);
                gcode.plunge(cutZ);
                gcode.tracePath(flatPoly);
            });
        }
    }
    
    // 3. Pocketing Regions
    interface Region { cs: any; depth: number; }
    let regions: Region[] = [];

    gcode.addComment("Operation: Pocketing Features");

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
                    if (Math.abs(p[0][0] - p[p.length-1][0]) > 1e-6 || Math.abs(p[0][1] - p[p.length-1][1]) > 1e-6) p.push(p[0]);
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
            const cutZ = localZ + bottomZ;
            
            pocketPaths.forEach(contours => {
                contours.forEach(flatPoly => {
                    gcode.rapidTo(flatPoly[0], flatPoly[1]);
                    gcode.plunge(cutZ);
                    gcode.tracePath(flatPoly);
                });
            });
        }
    });

    // 4. Board Cutout / Moat
    if (contextFp.isBoard) {
        gcode.addComment("Operation: Board Cutout");
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
                    const cutZ = localZ + bottomZ;

                    moatContours.forEach(flatPoly => {
                         gcode.rapidTo(flatPoly[0], flatPoly[1]);
                         gcode.plunge(cutZ);
                         gcode.tracePath(flatPoly);
                    });
                }
            }
        }
    }

    const outputGCode = gcode.getGCode();
    // Parse the generated G-code back into visual mesh lines to debug that the GCode looks correct
    const toolpaths = parseGCodeToMeshLines(outputGCode);

    self.postMessage({ id, type: "success", payload: { toolpaths, gcode: outputGCode } });
    garbage.forEach(g => { try { g.delete(); } catch(e) {} });
}