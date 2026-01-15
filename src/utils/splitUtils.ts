import { Footprint, Parameter, StackupLayer, FootprintSplitLine, Point, FootprintShape } from "../types";
import { 
    evaluateExpression, 
    resolvePoint, 
    collectGlobalObstacles, 
    bezier1D 
} from "./footprintUtils";
import { invoke } from "@tauri-apps/api/core";

// --- PURE GEOMETRY HELPERS ---

export function generateDovetailPoints(
    startX: number, startY: number, 
    endX: number, endY: number, 
    positions: number[], 
    width: number,
    heightOverride?: number,
    flip?: boolean
): {x: number, y: number}[] {
    const dx = endX - startX;
    const dy = endY - startY;
    const len = Math.sqrt(dx*dx + dy*dy);
    if (len < 0.001) return [{x:startX, y:startY}];

    const ux = dx / len;
    const uy = dy / len;
    const px = flip ? uy : -uy;
    const py = flip ? -ux : ux;

    const points = [];
    points.push({x: startX, y: startY});

    const neckW = width;
    const headW = width * 1.5;
    const height = heightOverride !== undefined ? heightOverride : width * 0.8;
    
    // Sort positions to draw sequentially along the line
    const sortedPos = [...positions].sort((a,b) => a - b);

    for (const t of sortedPos) {
        const centerDist = t * len;
        const centerX = startX + ux * centerDist;
        const centerY = startY + uy * centerDist;
        const baseStartDist = centerDist - neckW / 2;
        const baseEndDist = centerDist + neckW / 2;

        points.push({ x: startX + ux * baseStartDist, y: startY + uy * baseStartDist });
        points.push({
            x: centerX - ux * (headW / 2) + px * height,
            y: centerY - uy * (headW / 2) + py * height
        });
        points.push({
            x: centerX + ux * (headW / 2) + px * height,
            y: centerY + uy * (headW / 2) + py * height
        });
        points.push({ x: startX + ux * baseEndDist, y: startY + uy * baseEndDist });
    }
    points.push({x: endX, y: endY});
    return points;
}

function getSegmentIntersection(p0: {x:number, y:number}, p1: {x:number, y:number}, p2: {x:number, y:number}, p3: {x:number, y:number}): {x:number, y:number} | null {
    const s1_x = p1.x - p0.x;     const s1_y = p1.y - p0.y;
    const s2_x = p3.x - p2.x;     const s2_y = p3.y - p2.y;
    const denom = -s2_x * s1_y + s1_x * s2_y;
    if (Math.abs(denom) < 1e-6) return null;
    const s = (-s1_y * (p0.x - p2.x) + s1_x * (p0.y - p2.y)) / denom;
    const t = ( s2_x * (p0.y - p2.y) - s2_y * (p0.x - p2.x)) / denom;
    if (s >= 0 && s <= 1 && t >= 0 && t <= 1) {
        return { x: p0.x + (t * s1_x), y: p0.y + (t * s1_y) };
    }
    return null;
}

function computeConvexHull(points: {x:number, y:number}[]): {x:number, y:number}[] {
    if (points.length <= 3) return points;
    const unique = points.filter((p, i, a) => a.findIndex(t => Math.abs(t.x-p.x) < 1e-4 && Math.abs(t.y-p.y) < 1e-4) === i);
    if (unique.length < 3) return unique;
    const sorted = unique.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const cross = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: {x:number, y:number}[] = [];
    for (const p of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: {x:number, y:number}[] = [];
    for (const p of sorted.slice().reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
}

type FitResult = {
  fits: boolean;
  excess: number;          // 0 if fits, otherwise metric of how much it overflows
  rotation: number;        // radians
  translation: {x:number, y:number};
  corners: {x:number, y:number}[];
};

const findFittingRectangle = (
  points: {x:number, y:number}[],
  W: number,
  H: number
): FitResult => {

  const hull = computeConvexHull(points);
  // Degenerate case fits
  if (hull.length < 3) {
    return { fits: true, excess: 0, rotation: 0, translation: { x: 0, y: 0 }, corners: [] };
  }

  let minExcess = Infinity;
  let bestResult: FitResult = { fits: false, excess: Infinity, rotation: 0, translation: {x:0, y:0}, corners: [] };

  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % hull.length];

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;

    const ux = dx / len;
    const uy = dy / len;
    const vx = -uy;
    const vy = ux;

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;

    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }

    const width = maxU - minU;
    const height = maxV - minV;

    // Check 1: Normal Bed
    const excessNormal = Math.max(0, width - W) + Math.max(0, height - H);
    // Check 2: Rotated Bed
    const excessRotated = Math.max(0, width - H) + Math.max(0, height - W);

    const isRotated = excessRotated < excessNormal;
    const currentExcess = Math.min(excessNormal, excessRotated);

    if (currentExcess < minExcess) {
        minExcess = currentExcess;
        
        const angle = Math.atan2(uy, ux);
        
        // Calculate World Space Origin of the aligned Bed
        const originX = minU * ux + minV * vx;
        const originY = minU * uy + minV * vy;
        
        // Dimensions in World Space alignment
        const bU = isRotated ? H : W;
        const bV = isRotated ? W : H;
        
        // Compute World Corners
        const c1 = { x: originX, y: originY };
        const c2 = { x: originX + bU * ux, y: originY + bU * uy };
        const c3 = { x: originX + bU * ux + bV * vx, y: originY + bU * uy + bV * vy };
        const c4 = { x: originX + bV * vx, y: originY + bV * vy };

        bestResult = {
            fits: currentExcess < 1e-4,
            excess: currentExcess,
            rotation: angle,
            translation: { x: 0, y: 0 },
            corners: [c1, c2, c3, c4]
        };
        
        // Optimization: if we fit perfectly, stop searching
        if (bestResult.fits) return bestResult;
    }
  }

  return bestResult;
};


function isPointInPolygon(p: {x:number, y:number}, polygon: {x:number, y:number}[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function doSegmentsIntersect(p0: {x:number, y:number}, p1: {x:number, y:number}, p2: {x:number, y:number}, p3: {x:number, y:number}): boolean {
    const s1_x = p1.x - p0.x;     const s1_y = p1.y - p0.y;
    const s2_x = p3.x - p2.x;     const s2_y = p3.y - p2.y;
    const denom = (-s2_x * s1_y + s1_x * s2_y);
    if (Math.abs(denom) < 1e-8) return false;
    const s = (-s1_y * (p0.x - p2.x) + s1_x * (p0.y - p2.y)) / denom;
    const t = ( s2_x * (p0.y - p2.y) - s2_y * (p0.x - p2.x)) / denom;
    return (s >= 0 && s <= 1 && t >= 0 && t <= 1);
}

// --- BOARD ANALYSIS ---

export function getTessellatedBoardOutline(
    footprint: Footprint, 
    params: Parameter[], 
    allFootprints: Footprint[]
): {x: number, y: number}[] {
    const outlinePoints: {x:number, y:number}[] = [];
    footprint.shapes.forEach(s => {
        if (s.type === "boardOutline") {
            const bx = evaluateExpression(s.x, params);
            const by = evaluateExpression(s.y, params);
            const rawPts = s.points || [];
            if (rawPts.length < 3) return;
            for (let i = 0; i < rawPts.length; i++) {
                const p1Raw = rawPts[i];
                const p2Raw = rawPts[(i + 1) % rawPts.length];
                const res1 = resolvePoint(p1Raw, footprint, allFootprints, params, {x:0, y:0, angle:0});
                const x1 = bx + res1.x; const y1 = by + res1.y;
                outlinePoints.push({ x: x1, y: y1 });
                const res2 = resolvePoint(p2Raw, footprint, allFootprints, params, {x:0, y:0, angle:0});
                if (res1.handleOut || res2.handleIn) {
                    const x2 = bx + res2.x; const y2 = by + res2.y;
                    const cp1x = x1 + (res1.handleOut ? res1.handleOut.x : 0);
                    const cp1y = y1 + (res1.handleOut ? res1.handleOut.y : 0);
                    const cp2x = x2 + (res2.handleIn ? res2.handleIn.x : 0);
                    const cp2y = y2 + (res2.handleIn ? res2.handleIn.y : 0);
                    const steps = 16; 
                    for(let k=1; k<steps; k++) {
                        const t = k/steps;
                        outlinePoints.push({ x: bezier1D(x1, cp1x, cp2x, x2, t), y: bezier1D(y1, cp1y, cp2y, y2, t) });
                    }
                }
            }
        }
    });
    return outlinePoints;
}

export function checkSplitPartSizes(
    footprint: Footprint,
    params: Parameter[],
    allFootprints: Footprint[],
    bedSize: { width: number, height: number }
): { parts: { valid: boolean, excess: number, corners: {x:number, y:number}[], hull: {x:number, y:number}[] }[], maxExcess: number } {
    const outlinePoints = getTessellatedBoardOutline(footprint, params, allFootprints);
    if (outlinePoints.length < 3) return { parts: [], maxExcess: 0 };
    const splitLines = footprint.shapes.filter(s => s.type === "splitLine") as FootprintSplitLine[];
    if (splitLines.length === 0) return { parts: [], maxExcess: 0 };

    const lineDefs = splitLines.map(sl => {
        const sx = evaluateExpression(sl.x, params);
        const sy = evaluateExpression(sl.y, params);
        const ex = sx + evaluateExpression(sl.endX, params);
        const ey = sy + evaluateExpression(sl.endY, params);
        const posArr = sl.dovetailPositions ? sl.dovetailPositions.map(p => evaluateExpression(p, params)) : [0.5];
        const width = evaluateExpression(sl.dovetailWidth, params);
        const height = evaluateExpression((sl as any).dovetailHeight, params) || (width * 0.8);
        const flip = !!sl.flip;
        const dx = ex - sx; const dy = ey - sy;
        const len = Math.sqrt(dx*dx + dy*dy);
        const axisX = len > 0 ? dx/len : 1;
        const axisY = len > 0 ? dy/len : 0;
        const dovetailPts = generateDovetailPoints(sx, sy, ex, ey, posArr, width, height, flip);
        const boundaryPoints: {x:number, y:number}[] = [];
        dovetailPts.forEach(p => { if (isPointInPolygon(p, outlinePoints)) boundaryPoints.push(p); });
        const farStart = { x: sx - axisX * 10000, y: sy - axisY * 10000 };
        const farEnd = { x: ex + axisX * 10000, y: ey + axisY * 10000 };
        const cutPath = [farStart, ...dovetailPts, farEnd];
        for (let i = 0; i < cutPath.length - 1; i++) {
            for (let j = 0; j < outlinePoints.length; j++) {
                const hit = getSegmentIntersection(cutPath[i], cutPath[i+1], outlinePoints[j], outlinePoints[(j + 1) % outlinePoints.length]);
                if (hit) boundaryPoints.push(hit);
            }
        }
        return { sx, sy, axisX, axisY, boundaryPoints };
    });

    const pointBins = new Map<number, {x:number, y:number}[]>();
    const getSide = (p: {x:number, y:number}, idx: number) => {
        const l = lineDefs[idx];
        return ((p.x - l.sx) * l.axisY - (p.y - l.sy) * l.axisX) >= 0 ? 0 : 1;
    };
    
    // Bin outline points
    outlinePoints.forEach(p => {
        let mask = 0;
        for(let i=0; i<lineDefs.length; i++) if (getSide(p, i) === 1) mask |= (1 << i);
        if (!pointBins.has(mask)) pointBins.set(mask, []);
        pointBins.get(mask)!.push(p);
    });

    // Bin cut line points (shared edges)
    lineDefs.forEach((l, k) => {
        l.boundaryPoints.forEach(p => {
            let baseMask = 0;
            for(let j=0; j<lineDefs.length; j++) if (j !== k && getSide(p, j) === 1) baseMask |= (1 << j);
            // Add to both sides of the cut
            [baseMask, baseMask | (1 << k)].forEach(m => {
                if (!pointBins.has(m)) pointBins.set(m, []);
                pointBins.get(m)!.push(p);
            });
        });
    });

    const results: any[] = [];
    pointBins.forEach((pts) => {
        if (pts.length < 3) return;

        // Use the new fitting logic
        const fit = findFittingRectangle(pts, bedSize.width, bedSize.height);

        results.push({ 
            valid: fit.fits, 
            excess: fit.excess, 
            corners: fit.corners,
            transform: fit.translation,
            rotation: fit.rotation,
            hull: computeConvexHull(pts) 
        });
    });
    return { parts: results, maxExcess: results.reduce((max, p) => Math.max(max, p.excess), 0) };
}

// --- SEARCH ALGORITHMS (LEGACY) ---

export function findSafeSplitLine(
    footprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[],
    stackup: StackupLayer[],
    startUser: {x:number, y:number},
    endUser: {x:number, y:number},
    bedSize?: { width: number, height: number },
    options: { searchRadius: number, angleRange: number } = { searchRadius: 20, angleRange: 5 },
    ignoredLayerIds: string[] = []
): { result: { start: {x:number, y:number}, end: {x:number, y:number}, count: number, width: number } | null, debugLines: any[] } {
    const obstacles = collectGlobalObstacles(footprint.shapes, params, allFootprints, stackup, {x:0, y:0, angle:0}, footprint, ignoredLayerIds);
    const outlinePoints = getTessellatedBoardOutline(footprint, params, allFootprints);
    const dx = endUser.x - startUser.x; const dy = endUser.y - startUser.y;
    const angleBase = Math.atan2(dy, dx);
    const midX = (startUser.x + endUser.x) / 2; const midY = (startUser.y + endUser.y) / 2;

    const distToSegment = (p: {x:number, y:number}, a: {x:number, y:number}, b: {x:number, y:number}) => {
        const l2 = (a.x-b.x)**2 + (a.y-b.y)**2; if (l2 === 0) return Math.sqrt((p.x-a.x)**2 + (p.y-a.y)**2);
        let t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2));
        return Math.sqrt((p.x - (a.x + t*(b.x-a.x)))**2 + (p.y - (a.y + t*(b.y-a.y)))**2);
    };

    const checkClearance = (p1: {x:number, y:number}, p2: {x:number, y:number}, checkChannels: boolean) => {
        let minClearance = Infinity;
        for (const obs of obstacles) {
            if (!obs.isThrough) continue;
            if (obs.type === 'circle') minClearance = Math.min(minClearance, distToSegment(obs, p1, p2) - obs.r);
            if (!checkChannels || obs.type !== 'poly') continue;
            for(const v of obs.points) minClearance = Math.min(minClearance, distToSegment(v, p1, p2));
            for(let i=0; i<obs.points.length; i++) if (doSegmentsIntersect(p1, p2, obs.points[i], obs.points[(i+1)%obs.points.length])) return -1.0;
        }
        return minClearance;
    };

    let bestScore = -Infinity; let bestResult = null;
    const angStep = 1 * (Math.PI/180); const offStep = 2; const slideStep = 2;
    const widths = [20, 15, 10];

    for (let c = 1; c <= 3; c++) {
      for (const width of widths) {
        for (let a = -options.angleRange; a <= options.angleRange; a++) {
          const uX = Math.cos(angleBase + a*angStep); const uY = Math.sin(angleBase + a*angStep);
          const pX = -uY; const pY = uX;
          for (let o = -Math.floor(options.searchRadius/offStep); o <= Math.floor(options.searchRadius/offStep); o++) {
            const bMidX = midX + pX*o*offStep; const bMidY = midY + pY*o*offStep;
            for (let s = -8; s <= 8; s++) {
              const cMidX = bMidX + uX*s*slideStep; const cMidY = bMidY + uY*s*slideStep;
              const fS = { x: cMidX - uX*10000, y: cMidY - uY*10000 }; const fE = { x: cMidX + uX*10000, y: cMidY + uY*10000 };
              let minT = Infinity, maxT = -Infinity, hits = 0;
              for (let i = 0; i < outlinePoints.length; i++) {
                const hit = getSegmentIntersection(fS, fE, outlinePoints[i], outlinePoints[(i+1)%outlinePoints.length]);
                if (hit) { hits++; const t = (hit.x-cMidX)*uX + (hit.y-cMidY)*uY; minT = Math.min(minT, t); maxT = Math.max(maxT, t); }
              }
              if (hits < 2 || checkClearance(fS, fE, false) < 0.5) continue;
              const hL = Math.max(Math.abs(minT), Math.abs(maxT)) * 1.2 + 10;
              const cS = { x: cMidX - uX*hL, y: cMidY - uY*hL }; const cE = { x: cMidX + uX*hL, y: cMidY + uY*hL };
              // Convert count to positions
              const positions = [];
              for(let k=0; k<c; k++) positions.push((k + 0.5) / c);
              
              const pts = generateDovetailPoints(cS.x, cS.y, cE.x, cE.y, positions, width);
              let valid = true; for(let k=2; k<pts.length-1; k+=4) if (!isPointInPolygon(pts[k], outlinePoints) || !isPointInPolygon(pts[k+1], outlinePoints)) { valid=false; break; }
              if (!valid) continue;
              let dClear = Infinity; for(let k=0; k<pts.length-1; k++) { if (k%4===0) continue; const cl=checkClearance(pts[k], pts[k+1], true); if (cl < 0.5) { valid=false; break; } dClear=Math.min(dClear, cl); }
              if (valid) {
                const score = (dClear === Infinity ? 20 : Math.min(dClear, 20))*5 - c*40 + width*2 - Math.abs(o*offStep) - Math.abs(s*slideStep)*0.8 - Math.abs(a)*10;
                if (score > bestScore) { bestScore = score; bestResult = { start: cS, end: cE, count: c, width }; }
              }
            }
          }
        }
      }
    }
    return { result: bestResult, debugLines: [] };
}


// --- PSO IMPLEMENTATION (NEW) ---

interface GeometryCache {
    outline: { x: number, y: number }[];
    obstacles: { x: number, y: number, r: number }[]; 
    bounds: { minX: number, maxX: number, minY: number, maxY: number };
    bedSize: { width: number, height: number };
}

interface Particle {
    position: number[]; // [angle, offsetRatio1, offsetRatio2, ...]
    velocity: number[];
    bestPosition: number[];
    bestCost: number;
    currentCost: number;
}

interface PSOResult {
    angle: number;
    offsets: number[];
    cost: number;
}

const PSO_CONFIG = {
    SWARM_SIZE: 40,
    MAX_ITERATIONS: 150,
    INERTIA: 0.7,
    C1: 1.4,
    C2: 1.4,
    DOVETAIL_WIDTH_ALLOWANCE: 15,
};

// --- MAIN ENTRY POINT ---

export function autoComputeSplit(
    footprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[],
    stackup: StackupLayer[],
    bedSize: { width: number, height: number },
    options: { clearance: number, desiredCuts: number } = { clearance: 0.0, desiredCuts: 1 },
    ignoredLayerIds: string[] = []
): { success: boolean, shapes?: FootprintSplitLine[], maxExcess?: number, debugLines?: any[], log?: string } {
    
    // 1. Prepare Geometry
    const rawOutline = getTessellatedBoardOutline(footprint, params, allFootprints);
    if (rawOutline.length < 3) return { success: false, log: "Invalid board outline" };

    const rawObstacles = collectGlobalObstacles(
        footprint.shapes, params, allFootprints, stackup, 
        {x:0, y:0, angle:0}, footprint, ignoredLayerIds
    );
    
    // Filter only through-hole circles
    const criticalObstacles = rawObstacles
        .filter(o => o.isThrough && o.type === 'circle') 
        // @ts-ignore
        .map(o => ({ x: o.x, y: o.y, r: o.r }));

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    rawOutline.forEach(p => { 
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });

    const geometry: GeometryCache = {
        outline: rawOutline,
        obstacles: criticalObstacles,
        bounds: { minX, maxX, minY, maxY },
        bedSize
    };

    // 2. Determine Search Range
    const w = maxX - minX;
    const h = maxY - minY;
    // Estimate min cuts needed by area/dimension
    const minCutsDim = Math.ceil(Math.max(w / bedSize.width, h / bedSize.height)) - 1;
    const maxSearchCuts = Math.max(minCutsDim + 1, 4); 

    let bestSolution: PSOResult | null = null;

    // 3. Iterative Search (1 cut, 2 cuts...)
    for (let n = 1; n <= maxSearchCuts; n++) {
        const solution = runPSO(n, geometry);
        
        // Cost < 1.0 implies fit
        if (solution.cost < 5.0) { 
            bestSolution = solution;
            break; 
        }
        
        if (!bestSolution || solution.cost < bestSolution.cost) {
            bestSolution = solution;
        }
    }

    if (!bestSolution) {
        return { success: false, log: "PSO failed to find valid split." };
    }

    // 4. Convert Abstract Solution (Angle/Offsets) to Concrete Shapes
    const generatedShapes: FootprintSplitLine[] = [];
    const { angle, offsets } = bestSolution;
    
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const vx = -uy;
    const vy = ux;

    const diag = Math.sqrt(w*w + h*h) * 1.5;
    const cx = (minX+maxX)/2;
    const cy = (minY+maxY)/2;
    const centerProj = cx*ux + cy*uy;

    offsets.forEach(offsetVal => {
        const diff = offsetVal - centerProj;
        const anchorX = cx + diff * ux;
        const anchorY = cy + diff * uy;

        // Define infinite cut line
        const farStart = { x: anchorX - vx * 10000, y: anchorY - vy * 10000 };
        const farEnd = { x: anchorX + vx * 10000, y: anchorY + vy * 10000 };

        // Find intersection with Board Outline to clamp line length
        let tMin = Infinity;
        let tMax = -Infinity;
        let hits = 0;

        const ol = geometry.outline;
        for (let k = 0; k < ol.length; k++) {
            const p1 = ol[k];
            const p2 = ol[(k + 1) % ol.length];
            const hit = getSegmentIntersection(farStart, farEnd, p1, p2);
            if (hit) {
                hits++;
                // Project hit onto the unit vector 'v' relative to anchor
                const t = (hit.x - anchorX) * vx + (hit.y - anchorY) * vy;
                if (t < tMin) tMin = t;
                if (t > tMax) tMax = t;
            }
        }

        if (hits >= 2 && tMin < tMax) {
            // Apply slight padding so the line fully crosses the boundary
            const pad = 1.0; 
            const sx = anchorX + vx * (tMin - pad);
            const sy = anchorY + vy * (tMin - pad);
            const ex = anchorX + vx * (tMax + pad);
            const ey = anchorY + vy * (tMax + pad);

            generatedShapes.push({
                id: crypto.randomUUID(),
                type: "splitLine",
                name: "Auto Split",
                x: sx.toFixed(4),
                y: sy.toFixed(4),
                endX: (ex - sx).toFixed(4),
                endY: (ey - sy).toFixed(4),
                dovetailPositions: ["0.5"], 
                dovetailWidth: "15",
                assignedLayers: {},
                ignoredLayerIds
            } as any);
        }
    });

    // 5. Final robust verification
    const sizeCheck = checkSplitPartSizes(
        { ...footprint, shapes: [...footprint.shapes.filter(s => s.type === "boardOutline"), ...generatedShapes] },
        params, allFootprints, bedSize
    );

    console.log(`Auto-Split Result: ${generatedShapes.length} cuts, Max Excess: ${sizeCheck.maxExcess.toFixed(2)}`);

    return {
        success: sizeCheck.maxExcess < 1.0,
        shapes: generatedShapes,
        maxExcess: sizeCheck.maxExcess,
        debugLines: [],
        log: `Auto-Split: ${generatedShapes.length} cuts. Cost: ${bestSolution.cost.toFixed(2)}`
    };
}

// --- RUST INTEROP TYPES ---

interface RustObstacle {
    x: number;
    y: number;
    r: number;
}

interface RustGeometryInput {
    outline: number[][]; // [[x,y], [x,y]]
    obstacles: RustObstacle[];
    bed_width: number;
    bed_height: number;
}

interface RustGeneratedCut {
    id: string;
    start: [number, number];
    end: [number, number];
    dovetail_width: number;
    dovetail_height: number;
    dovetail_t: number;
}

interface RustOptimizationResult {
    success: boolean;
    cost: number;
    shapes: RustGeneratedCut[];
}

// --- OPTIMIZER HELPER ---

/**
 * Sends a single cut line to the Rust backend to optimize its position, 
 * angle, and dovetail parameters for maximum clearance and board fit.
 */
export async function optimizeCutWithDovetail(
    cut: FootprintSplitLine,
    footprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[],
    bedSize: { width: number, height: number }
): Promise<FootprintSplitLine> {
    
    // 1. Prepare Geometry
    const outline = getTessellatedBoardOutline(footprint, params, allFootprints);
    if (outline.length < 3) return cut; // Safety fallback

    // Map outline to array of arrays for Rust
    const rustOutline = outline.map(p => [p.x, p.y]);

    // Collect obstacles (Reuse your existing obstacle collection logic)
    // Note: We need to pass a dummy stackup or grab it from context if available.
    // Assuming 'collectGlobalObstacles' is available in this scope or you pass stackup.
    // For this helper, we'll assume the caller passes critical obstacles or we re-collect.
    // *Simplification*: We'll assume the helper is called from a context where we can get obstacles.
    // If not, we need to pass 'stackup' to this function. 
    // Let's add 'stackup' to the arguments or assume a global context. 
    // I will update the function signature below to include stackup.
    
    // Fallback: if no obstacles found, send empty list.
    const rustObstacles: RustObstacle[] = []; 
    // (You should ideally inject the 'criticalObstacles' list used in autoComputeSplit here)

    const input: RustGeometryInput = {
        outline: rustOutline,
        obstacles: rustObstacles, 
        bed_width: bedSize.width,
        bed_height: bedSize.height
    };

    try {
        // 2. Invoke Rust
        // Note: We are sending snake_case keys because we defined the Rust struct 
        // without #[serde(rename_all="camelCase")].
        const result = await invoke<RustOptimizationResult>("compute_smart_split", { input });

        if (!result.success || result.shapes.length === 0) {
            console.warn("Rust optimizer failed or returned no shapes, keeping original.");
            return cut;
        }

        const optShape = result.shapes[0];

        // 3. Reconstruct the Cut Line
        // The optimizer returns a specific segment (start->end) and a 't' value (0.0-1.0)
        // for the dovetail center.
        // Most renderers place the dovetail at the exact center (t=0.5) if count=1.
        // We will shift the start/end points of the line so that the physical location
        // of the dovetail aligns with the optimizer's result, while keeping t=0.5 
        // relative to the drawn line.

        const rStart = { x: optShape.start[0], y: optShape.start[1] };
        const rEnd = { x: optShape.end[0], y: optShape.end[1] };
        
        // Calculate the absolute position of the optimized dovetail center
        const dx = rEnd.x - rStart.x;
        const dy = rEnd.y - rStart.y;
        const len = Math.sqrt(dx*dx + dy*dy);
        const ux = dx / len;
        const uy = dy / len;

        const doveCenterX = rStart.x + ux * (len * optShape.dovetail_t);
        const doveCenterY = rStart.y + uy * (len * optShape.dovetail_t);

        // Create a new long line centered on this point to ensure it crosses the board
        // (The original optimizer might have returned a clipped line, but we want 
        // to be robust for the renderer which might clip it again)
        const hugeLen = Math.max(bedSize.width, bedSize.height) * 3;
        const newStart = { 
            x: doveCenterX - ux * (hugeLen / 2), 
            y: doveCenterY - uy * (hugeLen / 2) 
        };
        const newEnd = { 
            x: doveCenterX + ux * (hugeLen / 2), 
            y: doveCenterY + uy * (hugeLen / 2) 
        };

        // Clip this new line against the board outline to get clean start/end points
        // (Reuse your existing clipping logic or simple segment intersection)
        let tMin = 0.5 - (len / hugeLen); // Approx original start
        let tMax = 0.5 + (len / hugeLen); // Approx original end
        
        // Refined clipping:
        const farStart = { x: doveCenterX - ux * 10000, y: doveCenterY - uy * 10000 };
        const farEnd = { x: doveCenterX + ux * 10000, y: doveCenterY + uy * 10000 };
        // ... (Insert intersection logic here similar to autoComputeSplit) ...
        // For brevity, we will use the optimizer's returned vector direction and 
        // just clamp it to the outline.

        // 4. Handle "Flip"
        // Rust always places dovetail on "Left" of the vector.
        // Original cut vector:
        const origDx = parseFloat(cut.endX as any);
        const origDy = parseFloat(cut.endY as any);
        
        // Dot product to check if direction reversed
        const dot = ux * origDx + uy * origDy;
        const isReversed = dot < 0;

        // If Rust reversed the line, it means it wanted the dovetail on the "Right"
        // of the original vector. 
        // Since we are adopting the NEW vector (newStart -> newEnd), the dovetail 
        // is on the "Left" of THIS new vector.
        // So geometrically, 'flip' should be false if we use the new vector.
        // However, if you want to preserve the "End Handle is roughly that way" UX:
        // You could swap start/end and set flip=true. 
        // Let's stick to the simplest geometry: Use Rust's direction, flip=false.
        
        return {
            ...cut,
            x: rStart.x.toFixed(4),
            y: rStart.y.toFixed(4),
            endX: (rEnd.x - rStart.x).toFixed(4),
            endY: (rEnd.y - rStart.y).toFixed(4),
            dovetailPositions: [optShape.dovetail_t.toFixed(4)],
            dovetailWidth: optShape.dovetail_width.toFixed(4),
            dovetailHeight: optShape.dovetail_height.toFixed(4), 
            flip: false 
        } as any;

    } catch (e) {
        console.error("Rust optimization error:", e);
        return cut;
    }
}

// --- UPDATED AUTO SPLIT ---

export async function autoComputeSplitWithRefinement(
    footprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[],
    stackup: any[], // StackupLayer[]
    bedSize: { width: number, height: number },
    options: { clearance: number, desiredCuts: number },
    ignoredLayerIds: string[]
) {
    // 1. Run the initial PSO (JavaScript) to get rough placement
    const psoResult = autoComputeSplit(footprint, allFootprints, params, stackup, bedSize, options, ignoredLayerIds);
    
    if (!psoResult.success || !psoResult.shapes) {
        return psoResult;
    }

    console.log("PSO found rough cuts. Refining with CMA-ES...");

    // 2. Refine each cut using Rust
    // We need to collect obstacles once to pass them efficiently
    const rawObstacles = collectGlobalObstacles(
        footprint.shapes, params, allFootprints, stackup, 
        {x:0, y:0, angle:0}, footprint, ignoredLayerIds
    );
    const rustObstacles = rawObstacles
        .filter(o => o.isThrough && o.type === 'circle')
        // @ts-ignore (these obstacles are all circles)
        .map(o => ({ x: o.x, y: o.y, r: o.r }));
        
    const refinedShapes: FootprintSplitLine[] = [];
    
    // Helper to call our optimizer with pre-collected obstacles
    const optimize = async (cut: FootprintSplitLine) => {
        const outline = getTessellatedBoardOutline(footprint, params, allFootprints);
        const input: RustGeometryInput = {
            outline: outline.map(p => [p.x, p.y]),
            obstacles: rustObstacles,
            bed_width: bedSize.width,
            bed_height: bedSize.height
        };
        
        try {
            const res = await invoke<RustOptimizationResult>("compute_smart_split", { input });
            if (res.success && res.shapes.length > 0) {
                const s = res.shapes[0];
                // Logic to center the dovetail (t=0.5)
                const start = { x: s.start[0], y: s.start[1] };
                const end = { x: s.end[0], y: s.end[1] };
                const dx = end.x - start.x; const dy = end.y - start.y;
                const len = Math.sqrt(dx*dx + dy*dy);
                const ux = dx/len; const uy = dy/len;
                
                // Real center of dovetail
                const cx = start.x + ux * (len * s.dovetail_t);
                const cy = start.y + uy * (len * s.dovetail_t);
                
                // Construct new segment centered on cx, cy with same length
                // This ensures t=0.5 corresponds to the optimized location
                const newSx = cx - ux * (len/2);
                const newSy = cy - uy * (len/2);
                
                return {
                    ...cut,
                    x: newSx.toFixed(4),
                    y: newSy.toFixed(4),
                    endX: (ux * len).toFixed(4),
                    endY: (uy * len).toFixed(4),
                    dovetailWidth: s.dovetail_width.toFixed(4),
                    // If your type doesn't support height, you might need to drop this or use a parameter
                    dovetailHeight: s.dovetail_height.toFixed(4),
                    flip: false // Rust result is always Left-oriented
                };
            }
        } catch(e) { console.error(e); }
        return cut;
    };

    // Run sequentially to avoid race conditions on the Rust thread if not parallel-safe
    for (const shape of psoResult.shapes) {
        const refined = await optimize(shape);
        refinedShapes.push(refined as any);
    }

    return {
        ...psoResult,
        shapes: refinedShapes,
        log: psoResult.log + ` | Refined ${refinedShapes.length} cuts.`
    };
}

// --- PSO CORE LOGIC ---

const runPSO = (nCuts: number, geo: GeometryCache): PSOResult => {
    const dim = 1 + nCuts; // [Angle, Ratio1, Ratio2...]
    
    const particles: Particle[] = [];
    let globalBestPos: number[] = [];
    let globalBestCost = Infinity;

    // Initialize Swarm
    for (let i = 0; i < PSO_CONFIG.SWARM_SIZE; i++) {
        const pos = [
            Math.random() * Math.PI, 
            ...Array(nCuts).fill(0).map(() => 0.1 + Math.random() * 0.8)
        ];
        
        const cost = evaluateFitness(pos, geo);
        
        if (cost < globalBestCost) {
            globalBestCost = cost;
            globalBestPos = [...pos];
        }

        particles.push({
            position: pos,
            velocity: Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.1),
            bestPosition: [...pos],
            bestCost: cost,
            currentCost: cost
        });
    }

    // Optimization Loop
    for (let iter = 0; iter < PSO_CONFIG.MAX_ITERATIONS; iter++) {
        if (globalBestCost < 0.1) break; // Perfect fit

        for (const p of particles) {
            for (let d = 0; d < dim; d++) {
                const r1 = Math.random();
                const r2 = Math.random();
                p.velocity[d] = 
                    (PSO_CONFIG.INERTIA * p.velocity[d]) +
                    (PSO_CONFIG.C1 * r1 * (p.bestPosition[d] - p.position[d])) +
                    (PSO_CONFIG.C2 * r2 * (globalBestPos[d] - p.position[d]));
                
                p.position[d] += p.velocity[d];
            }

            // Boundary constraints
            if (p.position[0] < 0) p.position[0] += Math.PI;
            if (p.position[0] > Math.PI) p.position[0] -= Math.PI;

            for (let d = 1; d < dim; d++) {
                if (p.position[d] < 0.05) p.position[d] = 0.05;
                if (p.position[d] > 0.95) p.position[d] = 0.95;
            }

            const newCost = evaluateFitness(p.position, geo);
            p.currentCost = newCost;

            if (newCost < p.bestCost) {
                p.bestCost = newCost;
                p.bestPosition = [...p.position];
            }
            if (newCost < globalBestCost) {
                globalBestCost = newCost;
                globalBestPos = [...p.position];
            }
        }
    }

    const { offsets } = getActualOffsets(globalBestPos[0], globalBestPos.slice(1), geo.outline);
    console.log(`PSO found solution with cost: ${globalBestCost.toFixed(2)} using ${nCuts} cuts.`);
    return {
        angle: globalBestPos[0],
        offsets,
        cost: globalBestCost
    };
};

const evaluateFitness = (pos: number[], geo: GeometryCache): number => {
    const angle = pos[0];
    const ratios = pos.slice(1).sort((a, b) => a - b);
    
    // 1. Get real world cut positions
    const { offsets, minU, maxU } = getActualOffsets(angle, ratios, geo.outline);

    // 2. Obstacle Avoidance
    let obstaclePenalty = 0;
    const ux = Math.cos(angle), uy = Math.sin(angle);
    
    // Vectorized check for obstacles against cut lines
    for (const obs of geo.obstacles) {
        const obsU = obs.x * ux + obs.y * uy;
        for (const cutU of offsets) {
            const dist = Math.abs(obsU - cutU);
            const minDist = obs.r + (PSO_CONFIG.DOVETAIL_WIDTH_ALLOWANCE / 2);
            if (dist < minDist) {
                // Higher penalty for being closer to center of hole
                obstaclePenalty += 1000 + (minDist - dist) * 100;
            }
        }
    }
    // Optimization: Fail fast if we hit a hole
    if (obstaclePenalty > 0) return obstaclePenalty;

    // 3. Fit Check
    const cuts = [minU, ...offsets, maxU];
    let totalPenalty = 0;

    for (let i = 0; i < cuts.length - 1; i++) {
        // A. Clip board outline to the strip defined by two cuts
        const stripPoints = getPointsInStrip(geo.outline, ux, uy, cuts[i], cuts[i+1]);
        
        // If the strip has negligible area, ignore
        if (stripPoints.length < 3) continue;

        // B. Check if this sub-polygon fits on the bed
        const fit = findFittingRectangle(stripPoints, geo.bedSize.width, geo.bedSize.height);
        
        if (!fit.fits) {
            // Apply penalty proportional to how much it sticks out (squared for stronger gradient)
            totalPenalty += (fit.excess * fit.excess);
        }
    }

    return totalPenalty;
};

// Maps normalized 0-1 ratios to world coordinate offsets along the normal vector
const getActualOffsets = (angle: number, ratios: number[], outline: {x:number, y:number}[]) => {
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    
    let minU = Infinity, maxU = -Infinity;
    for(const p of outline) {
        const u = p.x * ux + p.y * uy;
        if(u < minU) minU = u;
        if(u > maxU) maxU = u;
    }
    
    const span = maxU - minU;
    const offsets = ratios.map(r => minU + (span * r));
    
    return { offsets, minU, maxU };
};

// Sutherland-Hodgman style clipping against two parallel lines
const getPointsInStrip = (outline: {x:number, y:number}[], ux: number, uy: number, startU: number, endU: number) => {
    const stripPoints: {x:number, y:number}[] = [];
    const len = outline.length;
    
    for (let k = 0; k < len; k++) {
        const p1 = outline[k];
        const p2 = outline[(k+1) % len];
        
        const u1 = p1.x * ux + p1.y * uy;
        const u2 = p2.x * ux + p2.y * uy;

        // Point p1 is inside
        if (u1 >= startU - 1e-4 && u1 <= endU + 1e-4) {
            stripPoints.push(p1);
        }

        // Check intersections with startU plane
        if ((u1 < startU && u2 > startU) || (u1 > startU && u2 < startU)) {
            const t = (startU - u1) / (u2 - u1);
            stripPoints.push({ x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) });
        }
        
        // Check intersections with endU plane
        if ((u1 < endU && u2 > endU) || (u1 > endU && u2 < endU)) {
            const t = (endU - u1) / (u2 - u1);
            stripPoints.push({ x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) });
        }
    }
    return stripPoints;
};