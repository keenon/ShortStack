import { Footprint, Parameter, StackupLayer, FootprintSplitLine, Point, FootprintShape } from "../types";
import { 
    evaluateExpression, 
    resolvePoint, 
    collectGlobalObstacles, 
    bezier1D 
} from "./footprintUtils";

// --- PURE GEOMETRY HELPERS ---

export function generateDovetailPoints(
    startX: number, startY: number, 
    endX: number, endY: number, 
    count: number, 
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
    const segmentLen = len / count;

    for (let i = 0; i < count; i++) {
        const centerDist = (i + 0.5) * segmentLen;
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
        const count = Math.round(evaluateExpression(sl.dovetailCount, params));
        const width = evaluateExpression(sl.dovetailWidth, params);
        const height = evaluateExpression((sl as any).dovetailHeight, params) || (width * 0.8);
        const flip = !!(sl as any).flip;
        const dx = ex - sx; const dy = ey - sy;
        const len = Math.sqrt(dx*dx + dy*dy);
        const axisX = len > 0 ? dx/len : 1;
        const axisY = len > 0 ? dy/len : 0;
        const dovetailPts = generateDovetailPoints(sx, sy, ex, ey, count, width, height, flip);
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
    outlinePoints.forEach(p => {
        let mask = 0;
        for(let i=0; i<lineDefs.length; i++) if (getSide(p, i) === 1) mask |= (1 << i);
        if (!pointBins.has(mask)) pointBins.set(mask, []);
        pointBins.get(mask)!.push(p);
    });
    lineDefs.forEach((l, k) => {
        l.boundaryPoints.forEach(p => {
            let baseMask = 0;
            for(let j=0; j<lineDefs.length; j++) if (j !== k && getSide(p, j) === 1) baseMask |= (1 << j);
            [baseMask, baseMask | (1 << k)].forEach(m => {
                if (!pointBins.has(m)) pointBins.set(m, []);
                pointBins.get(m)!.push(p);
            });
        });
    });

    const results: any[] = [];
    pointBins.forEach((pts) => {
        if (pts.length < 3) return;
        const hull = computeConvexHull(pts);
        let minArea = Infinity; let bestCorners: {x:number, y:number}[] = [];
        let bestW = 0, bestH = 0;
        for (let i = 0; i < hull.length; i++) {
            const p1 = hull[i]; const p2 = hull[(i + 1) % hull.length];
            const dx = p2.x - p1.x; const dy = p2.y - p1.y; const len = Math.sqrt(dx*dx + dy*dy);
            if (len < 1e-6) continue;
            const ux = dx / len; const uy = dy / len; const vx = -uy; const vy = ux;
            let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
            for (const p of hull) {
                const u = p.x * ux + p.y * uy; const v = p.x * vx + p.y * vy;
                minU = Math.min(minU, u); maxU = Math.max(maxU, u);
                minV = Math.min(minV, v); maxV = Math.max(maxV, v);
            }
            if ((maxU-minU)*(maxV-minV) < minArea) {
                minArea = (maxU-minU)*(maxV-minV); bestW = maxU-minU; bestH = maxV-minV;
                bestCorners = [ {x:minU*ux+minV*vx, y:minU*uy+minV*vy}, {x:maxU*ux+minV*vx, y:maxU*uy+minV*vy}, {x:maxU*ux+maxV*vx, y:maxU*uy+maxV*vy}, {x:minU*ux+maxV*vx, y:minU*uy+maxV*vy} ];
            }
        }
        const excess = Math.min(Math.max(0, bestW-bedSize.width)+Math.max(0, bestH-bedSize.height), Math.max(0, bestW-bedSize.height)+Math.max(0, bestH-bedSize.width));
        results.push({ valid: excess < 1.0, excess, corners: bestCorners, hull });
    });
    return { parts: results, maxExcess: results.reduce((max, p) => Math.max(max, p.excess), 0) };
}

// --- SEARCH ALGORITHMS ---

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
              const pts = generateDovetailPoints(cS.x, cS.y, cE.x, cE.y, c, width);
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

export function autoComputeSplit(
    footprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[],
    stackup: StackupLayer[],
    bedSize: { width: number, height: number },
    options: { clearance: number, desiredCuts: number } = { clearance: 2.0, desiredCuts: 1 },
    ignoredLayerIds: string[] = []
): { success: boolean, shapes?: FootprintSplitLine[], maxExcess?: number, debugLines?: any[], log?: string } {
    const outlinePoints = getTessellatedBoardOutline(footprint, params, allFootprints);
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
    outlinePoints.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); });
    const width = maxX - minX; const height = maxY - minY;
    const bedW = bedSize.width - 5; const bedH = bedSize.height - 5;
    const cutsX = Math.max(0, Math.ceil(width / bedW) - 1); const cutsY = Math.max(0, Math.ceil(height / bedH) - 1);

    const generatedShapes: FootprintSplitLine[] = [];
    const optimizeAndPush = (centerX: number, centerY: number, isVertical: boolean) => {
        const u = isVertical ? {x:0, y:1} : {x:1, y:0};
        const res = findSafeSplitLine(footprint, allFootprints, params, stackup, {x:centerX-u.x*2000, y:centerY-u.y*2000}, {x:centerX+u.x*2000, y:centerY+u.y*2000}, bedSize, { searchRadius: 20, angleRange: 0 }, ignoredLayerIds);
        if (res.result) {
            const r = res.result;
            generatedShapes.push({
                id: crypto.randomUUID(), type: "splitLine", name: "Auto Split",
                x: r.start.x.toFixed(4), y: r.start.y.toFixed(4),
                endX: (r.end.x - r.start.x).toFixed(4), endY: (r.end.y - r.start.y).toFixed(4),
                dovetailCount: r.count.toString(), dovetailWidth: r.width.toString(),
                assignedLayers: {}, ignoredLayerIds: ignoredLayerIds
            } as any);
        }
    };

    if (cutsX > 0) for(let i=1; i<=cutsX; i++) optimizeAndPush(minX + (width/(cutsX+1))*i, (minY+maxY)/2, true);
    if (cutsY > 0) for(let i=1; i<=cutsY; i++) optimizeAndPush((minX+maxX)/2, minY + (height/(cutsY+1))*i, false);
    
    const sizeCheck = checkSplitPartSizes({ ...footprint, shapes: [...footprint.shapes.filter(s=>s.type==="boardOutline"), ...generatedShapes] }, params, allFootprints, bedSize);
    return { success: sizeCheck.maxExcess < 1.0, shapes: generatedShapes, maxExcess: sizeCheck.maxExcess, debugLines: [], log: `Auto-Split Done: ${generatedShapes.length} cuts.` };
}
