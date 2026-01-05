// src/utils/footprintUtils.ts
import * as math from "mathjs";
import * as THREE from "three"; // Added THREE import
import { Footprint, Parameter, StackupLayer, LayerAssignment, FootprintReference, Point, FootprintWireGuide, FootprintRect, FootprintShape, FootprintUnion, FootprintText } from "../types";

export function modifyExpression(expression: string, delta: number): string {
  if (delta === 0) return expression;
  
  let trimmed = expression ? expression.trim() : "0";
  if (trimmed === "") trimmed = "0";

  // Check for simple number (integer or float)
  if (/^[-+]?[0-9]*\.?[0-9]+$/.test(trimmed)) {
      const val = parseFloat(trimmed);
      if (!isNaN(val)) {
          return parseFloat((val + delta).toFixed(4)).toString();
      }
  }

  // Check for ends with "+ number"
  const plusMatch = trimmed.match(/^(.*)\+\s*([0-9]*\.?[0-9]+)$/);
  if (plusMatch) {
      const prefix = plusMatch[1];
      const numStr = plusMatch[2];
      const val = parseFloat(numStr);
      if (!isNaN(val)) {
          const newVal = val + delta;
          if (newVal >= 0) {
              return `${prefix}+ ${parseFloat(newVal.toFixed(4))}`;
          } else {
              return `${prefix}- ${parseFloat(Math.abs(newVal).toFixed(4))}`;
          }
      }
  }

  // Check for ends with "- number"
  const minusMatch = trimmed.match(/^(.*)\-\s*([0-9]*\.?[0-9]+)$/);
  if (minusMatch) {
      const prefix = minusMatch[1];
      const numStr = minusMatch[2];
      const val = parseFloat(numStr);
      if (!isNaN(val)) {
          // Expression: prefix - val
          // New: prefix - val + delta  => prefix - (val - delta)
          const newVal = val - delta;
          if (newVal >= 0) {
               return `${prefix}- ${parseFloat(newVal.toFixed(4))}`;
          } else {
               // val - delta is negative (e.g. 5 - 10 = -5).
               // prefix - (-5) => prefix + 5
               return `${prefix}+ ${parseFloat(Math.abs(newVal).toFixed(4))}`;
          }
      }
  }

  // Fallback: Append + delta
  const absDelta = Math.abs(delta);
  const fmtDelta = parseFloat(absDelta.toFixed(4));
  if (delta >= 0) {
      return `${trimmed} + ${fmtDelta}`;
  } else {
      return `${trimmed} - ${fmtDelta}`;
  }
}

// Evaluate math expressions to numbers (for visualization only)
export function evaluateExpression(expression: string | LayerAssignment | undefined | null, params: Parameter[]): number {
  if (!expression) return 0;

  let exprStr = "";
  if (typeof expression === 'object') {
      if ('depth' in expression) {
          exprStr = expression.depth;
      } else {
          return 0; 
      }
  } else {
      exprStr = String(expression);
  }

  if (!exprStr || !exprStr.trim()) return 0;
  
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      // Treat parameters as pure numbers in mm
      const val = p.unit === "in" ? p.value * 25.4 : p.value;
      scope[p.key] = val;
    });
    const result = math.evaluate(exprStr, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0; // Return 0 on error for visualizer
  }
}

export function interpolateColor(hex: string, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  // If full depth, plain black
  if (r === 1) return "black";
  // If 0 depth, pure layer color
  if (r === 0) return hex;

  let c = hex.trim();
  if (c.startsWith("#")) c = c.substring(1);
  if (c.length === 3) c = c.split("").map(char => char + char).join("");
  // Fallback
  if (c.length !== 6) return "black";

  const num = parseInt(c, 16);
  const red = (num >> 16) & 0xff;
  const green = (num >> 8) & 0xff;
  const blue = num & 0xff;

  // Mix with black (0,0,0) -> target = color * (1-r)
  const f = 1 - r;
  return `rgb(${Math.round(red * f)}, ${Math.round(green * f)}, ${Math.round(blue * f)})`;
}

// Helper for Midpoint calculation
export const isNumeric = (str: string) => {
    const s = str.trim();
    if (s === "") return false;
    return !isNaN(Number(s));
};

export const calcMid = (v1: string, v2: string) => {
    if (isNumeric(v1) && isNumeric(v2)) {
        return parseFloat(((Number(v1) + Number(v2)) / 2).toFixed(4)).toString();
    }
    return `(${v1} + ${v2}) / 2`;
};

// NEW: AABB Interface
export interface Rect { x1: number, y1: number, x2: number, y2: number }

// NEW: Check if two rectangles intersect
export function doRectsIntersect(r1: Rect, r2: Rect): boolean {
    const r1MinX = Math.min(r1.x1, r1.x2);
    const r1MaxX = Math.max(r1.x1, r1.x2);
    const r1MinY = Math.min(r1.y1, r1.y2);
    const r1MaxY = Math.max(r1.y1, r1.y2);

    const r2MinX = Math.min(r2.x1, r2.x2);
    const r2MaxX = Math.max(r2.x1, r2.x2);
    const r2MinY = Math.min(r2.y1, r2.y2);
    const r2MaxY = Math.max(r2.y1, r2.y2);

    return !(r2MinX > r1MaxX || 
             r2MaxX < r1MinX || 
             r2MinY > r1MaxY || 
             r2MaxY < r1MinY);
}

// NEW: Calculate AABB for a shape in Visual Coordinates (where Y is inverted)
export function getShapeAABB(
    shape: FootprintShape,
    params: Parameter[],
    rootFootprint: Footprint,
    allFootprints: Footprint[],
    pX = 0, pY = 0, pA = 0 // Added parent transform params
): Rect | null {
    const lx = (shape.type === "line") ? 0 : evaluateExpression((shape as any).x, params);
    const ly = (shape.type === "line") ? 0 : evaluateExpression((shape as any).y, params);
    const la = (shape.type === "rect" || shape.type === "footprint" || shape.type === "union" || shape.type === "text") ? evaluateExpression((shape as any).angle, params) : 0;

    const rad = -pA * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Global Math Position
    const gx = pX + (lx * cos - ly * sin);
    const gy = pY + (lx * sin + ly * cos);
    const gA = pA + la;

    if (shape.type === "union") {
        const union = shape as FootprintUnion;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let valid = false;

        union.shapes.forEach(child => {
            const childBounds = getShapeAABB(child, params, union as unknown as Footprint, allFootprints, gx, gy, gA);
            if (childBounds) {
                valid = true;
                minX = Math.min(minX, childBounds.x1, childBounds.x2); maxX = Math.max(maxX, childBounds.x1, childBounds.x2);
                minY = Math.min(minY, childBounds.y1, childBounds.y2); maxY = Math.max(maxY, childBounds.y1, childBounds.y2);
            }
        });
        return valid ? { x1: minX, y1: minY, x2: maxX, y2: maxY } : null;
    }

    if (shape.type === "footprint") {
        const ref = shape as FootprintReference;
        const target = allFootprints.find(f => f.id === ref.footprintId);
        if (!target) return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let valid = false;

        target.shapes.forEach(child => {
            const childBounds = getShapeAABB(child, params, target, allFootprints, gx, gy, gA);
            if (childBounds) {
                valid = true;
                minX = Math.min(minX, childBounds.x1, childBounds.x2); 
                maxX = Math.max(maxX, childBounds.x1, childBounds.x2);
                minY = Math.min(minY, childBounds.y1, childBounds.y2); 
                maxY = Math.max(maxY, childBounds.y1, childBounds.y2);
            }
        });
        return valid ? { x1: minX, y1: minY, x2: maxX, y2: maxY } : null;
    }

    if (shape.type === "circle") {
        const cx = gx;
        const cy = -gy; // Visual Y
        const r = evaluateExpression((shape as any).diameter, params) / 2;
        return { x1: cx - r, y1: cy - r, x2: cx + r, y2: cy + r };
    }

    if (shape.type === "rect") {
        const cx = gx;
        const cy = -gy;
        const w = evaluateExpression((shape as any).width, params);
        const h = evaluateExpression((shape as any).height, params);
        const hw = w / 2; const hh = h / 2;
        const rrad = -gA * (Math.PI / 180);
        const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);

        const corners = [{x:hw, y:hh}, {x:-hw, y:hh}, {x:-hw, y:-hh}, {x:hw, y:-hh}].map(p => ({
            x: cx + (p.x * rcos - p.y * rsin),
            y: cy + (p.x * rsin + p.y * rcos)
        }));

        return {
            x1: Math.min(...corners.map(p => p.x)),
            y1: Math.min(...corners.map(p => p.y)),
            x2: Math.max(...corners.map(p => p.x)),
            y2: Math.max(...corners.map(p => p.y))
        };
    }

    let points: Point[] = (shape as any).points || [];
    if (shape.type === "wireGuide") {
        const r = 2;
        return { x1: gx - r, y1: -gy - r, x2: gx + r, y2: -gy + r };
    }

    if (points.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        const rrad = -pA * (Math.PI / 180);
        const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);

        points.forEach(p => {
            const res = resolvePoint(p, rootFootprint, allFootprints, params);
            const mx = lx + res.x;
            const my = ly + res.y;
            const fx = pX + (mx * rcos - my * rsin);
            const fy = -(pY + (mx * rsin + my * rcos));
            minX = Math.min(minX, fx); maxX = Math.max(maxX, fx);
            minY = Math.min(minY, fy); maxY = Math.max(maxY, fy);
        });
        return { x1: minX - 1, y1: minY - 1, x2: maxX + 1, y2: maxY + 1 };
    }
    if (shape.type === "text") {
            const textShape = shape as FootprintText;
            const fontSize = evaluateExpression(textShape.fontSize, params);
            const content = textShape.text || "";
            const lines = content.split('\n');
            
            const maxLineLen = Math.max(...lines.map(l => l.length), 1);
            const width = maxLineLen * fontSize * 0.6; 
            // Calculate exact height based on the same 1.2 multiplier
            const height = lines.length * fontSize * 1.2;

            let offsetX = 0;
            if (textShape.anchor === "middle") offsetX = -width / 2;
            if (textShape.anchor === "end") offsetX = -width;
            
            const rrad = -gA * (Math.PI / 180);
            const rcos = Math.cos(rrad);
            const rsin = Math.sin(rrad);

            // Coordinate logic: 
            // First line baseline is at 0. 
            // Last line baseline is at (N-1) * FS * 1.2.
            // We offset the box slightly so 0,0 is at the top-left of the first line.
            const localCorners = [
                { x: offsetX, y: fontSize * 0.8 },           // Top of text
                { x: offsetX + width, y: fontSize * 0.8 },   // Top Right
                { x: offsetX + width, y: -height + (fontSize * 0.8) }, // Bottom Right
                { x: offsetX, y: -height + (fontSize * 0.8) }          // Bottom Left
            ];

            // ... map corners as before ...
            const corners = localCorners.map(p => ({
                x: gx + (p.x * rcos - p.y * rsin),
                y: -gy + (p.x * rsin + p.y * rcos) // -gy flip for visual coordinate system
            }));

            return {
                x1: Math.min(...corners.map(p => p.x)),
                y1: Math.min(...corners.map(p => p.y)),
                x2: Math.max(...corners.map(p => p.x)),
                y2: Math.max(...corners.map(p => p.y))
            };
    }
    return null;
}

// NEW: Helper to check if point is in rect
function isPointInRect(p: {x:number, y:number}, r: Rect) {
    const minX = Math.min(r.x1, r.x2);
    const maxX = Math.max(r.x1, r.x2);
    const minY = Math.min(r.y1, r.y2);
    const maxY = Math.max(r.y1, r.y2);
    return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
}

// NEW: Helper to check segment intersection
function doSegmentsIntersect(p0: {x:number, y:number}, p1: {x:number, y:number}, p2: {x:number, y:number}, p3: {x:number, y:number}): boolean {
    const s1_x = p1.x - p0.x;     const s1_y = p1.y - p0.y;
    const s2_x = p3.x - p2.x;     const s2_y = p3.y - p2.y;
    const s = (-s1_y * (p0.x - p2.x) + s1_x * (p0.y - p2.y)) / (-s2_x * s1_y + s1_x * s2_y);
    const t = ( s2_x * (p0.y - p2.y) - s2_y * (p0.x - p2.x)) / (-s2_x * s1_y + s1_x * s2_y);
    return (s >= 0 && s <= 1 && t >= 0 && t <= 1);
}

// NEW: Check if segment intersects rect (or is contained)
function segmentIntersectsRect(p1: {x:number, y:number}, p2: {x:number, y:number}, r: Rect): boolean {
    if (isPointInRect(p1, r) || isPointInRect(p2, r)) return true;
    
    const minX = Math.min(r.x1, r.x2);
    const maxX = Math.max(r.x1, r.x2);
    const minY = Math.min(r.y1, r.y2);
    const maxY = Math.max(r.y1, r.y2);
    
    // 4 Box Segments
    const boxSegs = [
        [{x:minX, y:minY}, {x:maxX, y:minY}],
        [{x:maxX, y:minY}, {x:maxX, y:maxY}],
        [{x:maxX, y:maxY}, {x:minX, y:maxY}],
        [{x:minX, y:maxY}, {x:minX, y:minY}]
    ];
    
    return boxSegs.some(s => doSegmentsIntersect(p1, p2, s[0], s[1]));
}

// NEW: Advanced Intersection Check
// Returns true if:
// 1. Box intersects shape edges
// 2. Shape is fully inside Box
// Returns FALSE if:
// 1. Box is strictly INSIDE a closed shape (e.g. inside a board outline)
// 2. No overlap at all
export function isShapeInSelection(
    selectionBox: Rect,
    shape: FootprintShape,
    params: Parameter[],
    rootFootprint: Footprint,
    allFootprints: Footprint[],
    pX = 0, pY = 0, pA = 0 // Added parent transform params
): boolean {
    const aabb = getShapeAABB(shape, params, rootFootprint, allFootprints, pX, pY, pA);
    if (!aabb || !doRectsIntersect(selectionBox, aabb)) return false;

    // Narrow Phase
    const boxMinX = Math.min(selectionBox.x1, selectionBox.x2);
    const boxMaxX = Math.max(selectionBox.x1, selectionBox.x2);
    const boxMinY = Math.min(selectionBox.y1, selectionBox.y2);
    const boxMaxY = Math.max(selectionBox.y1, selectionBox.y2);

    const lx = (shape.type === "line") ? 0 : evaluateExpression((shape as any).x, params);
    const ly = (shape.type === "line") ? 0 : evaluateExpression((shape as any).y, params);
    const la = (shape.type === "rect" || shape.type === "footprint" || shape.type === "union") ? evaluateExpression((shape as any).angle, params) : 0;
    
    const rad = -pA * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const gx = pX + (lx * cos - ly * sin);
    const gy = pY + (lx * sin + ly * cos);
    const gA = pA + la;

    // RECURSIVE CHECK FOR UNIONS (The requested fix)
    if (shape.type === "union") {
        const u = shape as FootprintUnion;
        return u.shapes.some(child => 
            isShapeInSelection(selectionBox, child, params, u as unknown as Footprint, allFootprints, gx, gy, gA)
        );
    }

    if (shape.type === "footprint") {
        const ref = shape as FootprintReference;
        const target = allFootprints.find(f => f.id === ref.footprintId);
        if (!target) return false;
        return target.shapes.some(child => 
            isShapeInSelection(selectionBox, child, params, target, allFootprints, gx, gy, gA)
        );
    }

    if (shape.type === "circle") {
        const r = evaluateExpression((shape as any).diameter, params) / 2;
        const closeX = Math.max(boxMinX, Math.min(gx, boxMaxX));
        const closeY = Math.max(boxMinY, Math.min(-gy, boxMaxY));
        const distSq = (gx - closeX)**2 + (-gy - closeY)**2;
        if (distSq > r*r) return false;
        const corners = [{x:boxMinX, y:boxMinY}, {x:boxMaxX, y:boxMinY}, {x:boxMaxX, y:boxMaxY}, {x:boxMinX, y:boxMaxY}];
        return !corners.every(c => (c.x-gx)**2 + (c.y+gy)**2 < r*r);
    }

    if (shape.type === "wireGuide") return true;

    let segments: {p1: {x:number, y:number}, p2: {x:number, y:number}}[] = [];
    
    if (shape.type === "rect") {
        const w = evaluateExpression((shape as any).width, params);
        const h = evaluateExpression((shape as any).height, params);
        const rrad = -gA * (Math.PI / 180);
        const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);
        const hw = w/2; const hh = h/2;
        const pts = [{x:hw,y:hh},{x:-hw,y:hh},{x:-hw,y:-hh},{x:hw,y:-hh}].map(p => ({
            x: gx + (p.x * rcos - p.y * rsin), y: -gy + (p.x * rsin + p.y * rcos)
        }));
        for(let i=0; i<4; i++) segments.push({p1: pts[i], p2: pts[(i+1)%4]});
    }
    else if (shape.type === "text") {
        const textShape = shape as FootprintText;
        const fs = evaluateExpression(textShape.fontSize, params);
        const lines = (textShape.text || "").split('\n');
        const maxLineLen = Math.max(...lines.map(l => l.length), 1);
        
        // Matches the math used in getShapeAABB
        const w = maxLineLen * fs * 0.6;
        const h = lines.length * fs * 1.2;
        
        let offsetX = 0;
        if (textShape.anchor === "middle") offsetX = -w / 2;
        if (textShape.anchor === "end") offsetX = -w;

        const rrad = -gA * (Math.PI / 180);
        const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);
        
        // Baseline adjustment to match the visual box
        const topY = fs * 0.8;
        
        const pts = [
            { x: offsetX, y: topY },           // Top Left
            { x: offsetX + w, y: topY },       // Top Right
            { x: offsetX + w, y: topY - h },   // Bottom Right
            { x: offsetX, y: topY - h }        // Bottom Left
        ].map(p => ({
            x: gx + (p.x * rcos - p.y * rsin),
            y: -gy + (p.x * rsin + p.y * rcos)
        }));

        for(let i=0; i<4; i++) segments.push({p1: pts[i], p2: pts[(i+1)%4]});
    } 
    else {
        const ptsRaw = (shape as any).points || [];
        if (ptsRaw.length < 2) return false;
        const visualPoints = ptsRaw.map((p: any) => {
             const res = resolvePoint(p, rootFootprint, allFootprints, params);
             const rrad = -pA * (Math.PI / 180);
             const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);
             const mx = lx + res.x; const my = ly + res.y;
             return {
                 x: pX + (mx * rcos - my * rsin),
                 y: -(pY + (mx * rsin + my * rcos)),
                 hOut: res.handleOut ? {x: res.handleOut.x * rcos - res.handleOut.y * rsin, y: -(res.handleOut.x * rsin + res.handleOut.y * rcos)} : undefined,
                 hIn: res.handleIn ? {x: res.handleIn.x * rcos - res.handleIn.y * rsin, y: -(res.handleIn.x * rsin + res.handleIn.y * rcos)} : undefined
             };
        });
        const isClosed = (shape.type !== "line");
        for(let i=0; i < (isClosed ? visualPoints.length : visualPoints.length - 1); i++) {
            const curr = visualPoints[i]; const next = visualPoints[(i+1) % visualPoints.length];
            if (curr.hOut || next.hIn) {
                const p0 = curr; const p3 = next;
                const p1 = { x: curr.x + (curr.hOut?.x||0), y: curr.y + (curr.hOut?.y||0) };
                const p2 = { x: next.x + (next.hIn?.x||0), y: next.y + (next.hIn?.y||0) };
                let prevP = p0;
                for(let s=1; s<=8; s++) {
                    const t = s/8;
                    const tp = {x: bezier1D(p0.x, p1.x, p2.x, p3.x, t), y: bezier1D(p0.y, p1.y, p2.y, p3.y, t)};
                    segments.push({p1: prevP, p2: tp}); prevP = tp;
                }
            } else segments.push({p1: curr, p2: next});
        }
    }
    return segments.some(s => segmentIntersectsRect(s.p1, s.p2, selectionBox));
}

// NEW: Cubic Bezier calculation for 1D coordinate
export function bezier1D(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const mt = 1 - t;
    return (mt * mt * mt * p0) + (3 * mt * mt * t * p1) + (3 * mt * t * t * p2) + (t * t * t * p3);
}

export function getRecursiveLayers(
  footprintId: string, 
  allFootprints: Footprint[], 
  stackup: StackupLayer[], 
  visited = new Set<string>()
): StackupLayer[] {
    if (visited.has(footprintId)) return [];
    visited.add(footprintId);
    
    const fp = allFootprints.find(f => f.id === footprintId);
    if (!fp) return [];

    const layerIds = new Set<string>();
    
    // Find layers in current footprint
    const extractLayers = (shapes: FootprintShape[]) => {
        shapes.forEach(s => {
            // IGNORE CHILD BOARD OUTLINES
            if (s.type === "boardOutline") return;

            if (s.type === "footprint") {
                const childRef = s as FootprintReference;
                const childLayers = getRecursiveLayers(childRef.footprintId, allFootprints, stackup, visited);
                childLayers.forEach(l => layerIds.add(l.id));
            } else if (s.type === "union") {
                Object.keys(s.assignedLayers || {}).forEach(k => layerIds.add(k));
                if (Object.keys(s.assignedLayers || {}).length === 0) {
                    extractLayers((s as FootprintUnion).shapes);
                }
            } else {
                Object.keys(s.assignedLayers || {}).forEach(k => layerIds.add(k));
            }
        });
    }

    extractLayers(fp.shapes);

    // Return unique layers sorted by stackup order
    return stackup.filter(l => layerIds.has(l.id));
}

export function isFootprintOptionValid(
    currentFootprintId: string, 
    candidateFootprint: Footprint, 
    allFootprints: Footprint[]
): boolean {
    if (candidateFootprint.id === currentFootprintId) return false; // Direct recursion
    // ALLOW BOARDS AS CHILDREN (Removed isBoard check)

    // Check for circular dependency: candidate -> ... -> current
    const visited = new Set<string>();
    const stack = [candidateFootprint];

    while(stack.length > 0) {
        const fp = stack.pop()!;
        if (fp.id === currentFootprintId) return false; // Found a path back to current
        
        if (visited.has(fp.id)) continue;
        visited.add(fp.id);

        // Find children of fp
        fp.shapes.forEach(s => {
            if (s.type === "footprint") {
                const childId = (s as FootprintReference).footprintId;
                const childFp = allFootprints.find(f => f.id === childId);
                if (childFp) stack.push(childFp);
            }
        });
    }

    return true;
}

// --- SNAP TO GUIDE UTILS ---

export interface WireGuideDefinition {
    pathId: string; // ID path "ref1:ref2:guideId" or just "guideId" for local
    label: string;  // "Guide Name" or "Ref Name > Guide Name"
}

// Recursively find all wire guides available to the current footprint
export function getAvailableWireGuides(
    rootFootprint: Footprint,
    allFootprints: Footprint[]
): WireGuideDefinition[] {
    const results: WireGuideDefinition[] = [];

    function recurse(shapes: FootprintShape[], pathIds: string[], names: string[]) {
        shapes.forEach(s => {
            if (s.type === "wireGuide") {
                // If it's a wire guide, add it
                const fullId = [...pathIds, s.id].join(":");
                const fullName = [...names, s.name].join(" > ");
                results.push({ pathId: fullId, label: fullName });
            } else if (s.type === "footprint") {
                // If it's a reference, dive in
                const ref = s as FootprintReference;
                const child = allFootprints.find(f => f.id === ref.footprintId);
                if (child) {
                    recurse(child.shapes, [...pathIds, s.id], [...names, s.name]);
                }
            } else if (s.type === "union") {
                recurse((s as FootprintUnion).shapes, [...pathIds, s.id], [...names, s.name]);
            }
        });
    }

    recurse(rootFootprint.shapes, [], []);
    return results;
}

// Find a wire guide object by its path string
export function findWireGuideByPath(
    pathId: string | undefined,
    rootFootprint: Footprint,
    allFootprints: Footprint[]
): FootprintWireGuide | null {
    if (!pathId) return null;
    const path = pathId.split(":");
    let currentShapes = rootFootprint.shapes;

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const shape = currentShapes.find(s => s.id === id);
        if (!shape) return null;

        if (shape.type === "wireGuide") {
            return shape as FootprintWireGuide;
        } else if (shape.type === "footprint") {
            const ref = shape as FootprintReference;
            const nextFp = allFootprints.find(f => f.id === ref.footprintId);
            if (!nextFp) return null;
            currentShapes = nextFp.shapes;
        } else if (shape.type === "union") {
            currentShapes = (shape as FootprintUnion).shapes;
        } else {
            return null;
        }
    }
    return null;
}

// Calculate the resolved position of a point. 
// If it snaps to a guide, recursively calculate the guide's global position.
// Otherwise evaluate local expression.
export function resolvePoint(
    point: Point,
    rootFootprint: Footprint,
    allFootprints: Footprint[],
    params: Parameter[]
): { x: number, y: number, handleIn?: {x: number, y: number}, handleOut?: {x: number, y: number} } {
    
    // Helper to evaluate local handles
    const evalHandle = (h?: {x: string, y: string}) => h ? {
        x: evaluateExpression(h.x, params),
        y: evaluateExpression(h.y, params)
    } : undefined;

    // Default: Evaluate local params
    const defaultRes = {
        x: evaluateExpression(point.x, params),
        y: evaluateExpression(point.y, params),
        handleIn: evalHandle(point.handleIn),
        handleOut: evalHandle(point.handleOut),
    };

    if (!point.snapTo) return defaultRes;

    const path = point.snapTo.split(":");
    let currentShapes = rootFootprint.shapes;
    
    // Accumulate transform from root to the guide
    let transform = { x: 0, y: 0, angle: 0 }; 

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const shape = currentShapes.find(s => s.id === id);
        if (!shape) return defaultRes;

        if (shape.type === "wireGuide") {
             const wg = shape as FootprintWireGuide;
             const lx = evaluateExpression(wg.x, params);
             const ly = evaluateExpression(wg.y, params);
             
             // Current accumulated rotation
             const rad = (transform.angle * Math.PI) / 180;
             const cos = Math.cos(rad);
             const sin = Math.sin(rad);
             
             // Anchor point is translated and rotated
             const gx = transform.x + (lx * cos - ly * sin);
             const gy = transform.y + (lx * sin + ly * cos);

             // Handles are VECTORS: they only rotate, they do not translate
             // UPDATED: Project single Wire Guide handle to symmetric in/out handles for the snapped point
             // BUT use the POSITIVE vector for BOTH handles to create a "pinch" effect
             if (wg.handle) {
                 const hx = evaluateExpression(wg.handle.x, params);
                 const hy = evaluateExpression(wg.handle.y, params);
                 
                 const rotX = hx * cos - hy * sin;
                 const rotY = hx * sin + hy * cos;

                 return {
                     x: gx,
                     y: gy,
                     handleOut: { x: rotX, y: rotY },
                     handleIn: { x: rotX, y: rotY } // Changed from negative to positive for pinch
                 };
             }

             return { x: gx, y: gy };

        } else if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const nextFp = allFootprints.find(f => f.id === ref.footprintId);
             if (!nextFp) return defaultRes;

             const lx = evaluateExpression(ref.x, params);
             const ly = evaluateExpression(ref.y, params);
             const la = evaluateExpression(ref.angle, params);

             const rad = (transform.angle * Math.PI) / 180;
             const cos = Math.cos(rad);
             const sin = Math.sin(rad);
             
             // Move the origin of the next footprint into the current frame
             transform.x += (lx * cos - ly * sin);
             transform.y += (lx * sin + ly * cos);
             transform.angle += la;
             
             currentShapes = nextFp.shapes;
        } else if (shape.type === "union") {
            const u = shape as FootprintUnion;
            const lx = evaluateExpression(u.x, params);
            const ly = evaluateExpression(u.y, params);
            const la = evaluateExpression(u.angle, params);

            const rad = (transform.angle * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            
            transform.x += (lx * cos - ly * sin);
            transform.y += (lx * sin + ly * cos);
            transform.angle += la;
            
            currentShapes = u.shapes;
        } else {
            return defaultRes;
        }
    }
    
    return defaultRes;
}

// ------------------------------------------------------------------
// POLYGON GEOMETRY UTILS
// ------------------------------------------------------------------

/**
 * Discretize a generic polygon-like shape (with optional Bezier segments) 
 * into a consistent vertex list.
 */
export function getPolyOutlinePoints(
    points: Point[],
    originX: number,
    originY: number,
    params: Parameter[],
    contextFp: Footprint,
    allFootprints: Footprint[],
    resolution: number
): THREE.Vector2[] {
    if (points.length < 3) return [];

    const pathPoints: THREE.Vector2[] = [];

    for (let i = 0; i < points.length; i++) {
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
    }

    return pathPoints;
}

/**
 * Inward vertex offsetting algorithm for polygons with collision clamping.
 * Used for creating gradients for ball-nose cuts.
 */
export function offsetPolygonContour(points: THREE.Vector2[], offset: number): THREE.Vector2[] {
    if (offset <= 0) return points;
    const len = points.length;
    const epsilon = 0.05; // Margin to avoid zero-area faces and Z-fighting

    // 1. Compute Miter directions and initial unconstrained candidates
    const info = points.map((p, i) => {
        const prev = points[(i - 1 + len) % len];
        const next = points[(i + 1) % len];
        
        // Edge directions
        const v1 = new THREE.Vector2().subVectors(p, prev).normalize();
        const v2 = new THREE.Vector2().subVectors(next, p).normalize();
        
        // Normals (inward for CCW)
        const n1 = new THREE.Vector2(-v1.y, v1.x);
        const n2 = new THREE.Vector2(-v2.y, v2.x);
        
        // Miter vector
        const miter = new THREE.Vector2().addVectors(n1, n2).normalize();
        const dot = miter.dot(n1);
        const safeDot = Math.max(dot, 0.1); 
        const scale = 1.0 / safeDot;
        
        const candidate = new THREE.Vector2().copy(p).addScaledVector(miter, offset * scale);
        
        return { pOrig: p, miter, candidate };
    });

    const result: THREE.Vector2[] = [];

    // 2. Apply Constraints: Project to valid half-space of neighbor miters
    for (let i = 0; i < len; i++) {
        let pos = info[i].candidate.clone();
        
        // Check against Previous Neighbor's Miter Line
        const prev = info[(i - 1 + len) % len];
        {
            const barrierN = new THREE.Vector2(-prev.miter.y, prev.miter.x);
            const refVec = new THREE.Vector2().subVectors(info[i].pOrig, prev.pOrig);
            if (refVec.dot(barrierN) < 0) barrierN.negate();

            const vec = new THREE.Vector2().subVectors(pos, prev.pOrig);
            const dist = vec.dot(barrierN);
            if (dist < epsilon) pos.addScaledVector(barrierN, epsilon - dist);
        }

        // Check against Next Neighbor's Miter Line
        const next = info[(i + 1) % len];
        {
            const barrierN = new THREE.Vector2(-next.miter.y, next.miter.x);
            const refVec = new THREE.Vector2().subVectors(info[i].pOrig, next.pOrig);
            if (refVec.dot(barrierN) < 0) barrierN.negate();

            const vec = new THREE.Vector2().subVectors(pos, next.pOrig);
            const dist = vec.dot(barrierN);
            if (dist < epsilon) pos.addScaledVector(barrierN, epsilon - dist);
        }

        result.push(pos);
    }

    return result;
}

/**
 * Converts a Rectangle (with optional corner radius and rotation) 
 * into a set of Polygon points with appropriate Bezier handles.
 * UPDATED: Now uses symbolic math to preserve expressions.
 */
export function convertRectToPolyPoints(
    rect: FootprintRect, 
    params: Parameter[]
): Point[] {
    // 1. Determine topology based on CURRENT value of cornerRadius
    // (We still evaluate to check if it's rounded, but logic is symbolic)
    const currentR = evaluateExpression(rect.cornerRadius, params);
    const isRounded = currentR > 0.001;

    // 2. Get Raw Strings (fallback to "0")
    const W = rect.width && rect.width.trim() ? rect.width : "0";
    const H = rect.height && rect.height.trim() ? rect.height : "0";
    const X = rect.x && rect.x.trim() ? rect.x : "0";
    const Y = rect.y && rect.y.trim() ? rect.y : "0";
    const R = rect.cornerRadius && rect.cornerRadius.trim() ? rect.cornerRadius : "0";
    const A = rect.angle && rect.angle.trim() ? rect.angle : "0";
    
    // Constant for cubic bezier 90deg arc approx: (4/3)*tan(pi/8)
    const K = "0.55228475"; 

    // Define Symbolic Point Structure
    interface SymPoint { x: string, y: string, hIn?: {x:string, y:string}, hOut?: {x:string, y:string} }
    let verts: SymPoint[] = [];

    // Helper: Simplify expression string using mathjs
    const S = (expr: string) => {
        try {
            return math.simplify(expr).toString();
        } catch (e) {
            return expr; // Fallback to raw string if invalid syntax
        }
    };

    if (!isRounded) {
        // 4 Corners: Clockwise starting Bottom Right to match visual expectation
        // 1. Bottom Right: (W/2, -H/2)
        // 2. Bottom Left: (-W/2, -H/2)
        // 3. Top Left: (-W/2, H/2)
        // 4. Top Right: (W/2, H/2)
        verts = [
            { x: `(${W}) / 2`, y: `-(${H}) / 2` },
            { x: `-(${W}) / 2`, y: `-(${H}) / 2` },
            { x: `-(${W}) / 2`, y: `(${H}) / 2` },
            { x: `(${W}) / 2`, y: `(${H}) / 2` }
        ];
    } else {
        // 8 Points for Rounded Rect (Clockwise)
        const KR = `${K} * (${R})`;
        const hw = `(${W}) / 2`;
        const hh = `(${H}) / 2`;

        verts = [
            // 1. Right Edge, near Bottom
            { 
                x: hw, 
                y: `-(${hh}) + (${R})`, 
                hOut: { x: "0", y: `-(${KR})` } 
            },
            // 2. Bottom Edge, near Right
            { 
                x: `(${hw}) - (${R})`, 
                y: `-${hh}`, 
                hIn: { x: KR, y: "0" } 
            },
            // 3. Bottom Edge, near Left
            { 
                x: `-(${hw}) + (${R})`, 
                y: `-${hh}`, 
                hOut: { x: `-(${KR})`, y: "0" } 
            },
            // 4. Left Edge, near Bottom
            { 
                x: `-(${hw})`, 
                y: `-(${hh}) + (${R})`, 
                hIn: { x: "0", y: `-(${KR})` } 
            },
            // 5. Left Edge, near Top
            { 
                x: `-(${hw})`, 
                y: `(${hh}) - (${R})`, 
                hOut: { x: "0", y: KR } 
            },
            // 6. Top Edge, near Left
            { 
                x: `-(${hw}) + (${R})`, 
                y: hh, 
                hIn: { x: `-(${KR})`, y: "0" } 
            },
            // 7. Top Edge, near Right
            { 
                x: `(${hw}) - (${R})`, 
                y: hh, 
                hOut: { x: KR, y: "0" } 
            },
            // 8. Right Edge, near Top
            { 
                x: hw, 
                y: `(${hh}) - (${R})`, 
                hIn: { x: "0", y: KR } 
            }
        ];
    }

    // 3. Apply Rotation and Translation Symbolically
    // We append 'deg' to the angle so mathjs handles it as degrees for sin/cos
    const ang = `(${A}) deg`;
    const cosA = `cos(${ang})`;
    const sinA = `sin(${ang})`;

    const transform = (p: SymPoint): Point => {
        const lx = p.x;
        const ly = p.y;
        
        // Rotate (CW rotation formula for standard math, but check coordinate system)
        // Canvas/SVG Y is down, but here usually Y is up in math logic. 
        // We use standard rotation: x' = x cos - y sin, y' = x sin + y cos
        // Note: X and Y are included because the polygon origin will be set to (0,0)
        const gx = `${X} + (${lx}) * ${cosA} - (${ly}) * ${sinA}`;
        const gy = `${Y} + (${lx}) * ${sinA} + (${ly}) * ${cosA}`;
        
        let hIn, hOut;
        
        // Handles are vectors, they rotate but do not translate
        if (p.hIn) {
            hIn = {
                x: S(`(${p.hIn.x}) * ${cosA} - (${p.hIn.y}) * ${sinA}`),
                y: S(`(${p.hIn.x}) * ${sinA} + (${p.hIn.y}) * ${cosA}`)
            };
        }
        if (p.hOut) {
            hOut = {
                x: S(`(${p.hOut.x}) * ${cosA} - (${p.hOut.y}) * ${sinA}`),
                y: S(`(${p.hOut.x}) * ${sinA} + (${p.hOut.y}) * ${cosA}`)
            };
        }

        return {
            id: crypto.randomUUID(),
            x: S(gx),
            y: S(gy),
            handleIn: hIn,
            handleOut: hOut
        };
    };

    return verts.map(transform);
}

// Point rotation helper
export function rotatePoint(
    point: { x: number, y: number },
    center: { x: number, y: number },
    angleRad: number
): { x: number, y: number } {
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + (dx * cos - dy * sin),
        y: center.y + (dx * sin + dy * cos)
    };
}