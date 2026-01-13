// src/utils/footprintUtils.ts
import { create, all } from "mathjs";
import * as THREE from "three"; // Added THREE import
import { Footprint, Parameter, StackupLayer, LayerAssignment, FootprintReference, Point, FootprintWireGuide, FootprintRect, FootprintShape, FootprintUnion, FootprintText, FootprintLine } from "../types";

// --- CUSTOM MATHJS INSTANCE ---
export const math = create(all);

// Capture original functions to use in overrides
const _add = math.add as any;
const _subtract = math.subtract as any;

// Override add/subtract to support "Implicit Millimeters"
// This allows "10 + 5mm" to evaluate to "15mm" instead of throwing an error.
math.import({
    add: function(a: any, b: any) {
        // Check if operands are Units
        const aIsUnit = a && a.isUnit;
        const bIsUnit = b && b.isUnit;
        const aIsNum = typeof a === 'number';
        const bIsNum = typeof b === 'number';

        // If adding Unit + Number, treat Number as mm
        if (aIsUnit && bIsNum) return _add(a, math.unit(b, 'mm'));
        if (aIsNum && bIsUnit) return _add(math.unit(a, 'mm'), b);
        
        return _add(a, b);
    },
    subtract: function(a: any, b: any) {
        const aIsUnit = a && a.isUnit;
        const bIsUnit = b && b.isUnit;
        const aIsNum = typeof a === 'number';
        const bIsNum = typeof b === 'number';

        // If subtracting Unit/Number, treat Number as mm
        if (aIsUnit && bIsNum) return _subtract(a, math.unit(b, 'mm'));
        if (aIsNum && bIsUnit) return _subtract(math.unit(a, 'mm'), b);
        
        return _subtract(a, b);
    }
}, { override: true });

export function modifyExpression(expression: string | undefined | null, delta: number): string {
  // If no change or delta is negligible, return original
  if (Math.abs(delta) < 0.0001) return expression || "0";
  
  // Robustly handle empty, null, or undefined expressions
  let trimmed = (expression || "0").trim();
  if (trimmed === "") trimmed = "0";

  // 1. Check for simple numeric strings (e.g., "10.5")
  if (/^[-+]?[0-9]*\.?[0-9]+$/.test(trimmed)) {
      const val = parseFloat(trimmed);
      if (!isNaN(val)) {
          return parseFloat((val + delta).toFixed(4)).toString();
      }
  }

  // 2. Check if expression ends with "+ [number]" (e.g., "Width + 10")
  const plusMatch = trimmed.match(/^(.*)\+\s*([0-9]*\.?[0-9]+)$/);
  if (plusMatch) {
      const prefix = plusMatch[1];
      const val = parseFloat(plusMatch[2]) + delta;
      return val >= 0 
        ? `${prefix}+ ${parseFloat(val.toFixed(4))}` 
        : `${prefix}- ${parseFloat(Math.abs(val).toFixed(4))}`;
  }

  // 3. Check if expression ends with "- [number]" (e.g., "Width - 5")
  const minusMatch = trimmed.match(/^(.*)\-\s*([0-9]*\.?[0-9]+)$/);
  if (minusMatch) {
      const prefix = minusMatch[1];
      const val = parseFloat(minusMatch[2]) - delta; 
      return val >= 0 
        ? `${prefix}- ${parseFloat(val.toFixed(4))}` 
        : `${prefix}+ ${parseFloat(Math.abs(val).toFixed(4))}`;
  }

  // 4. Fallback: Parametric append (e.g., "Width/2" -> "Width/2 + 5")
  const fmtDelta = parseFloat(Math.abs(delta).toFixed(4));
  return delta >= 0 ? `${trimmed} + ${fmtDelta}` : `${trimmed} - ${fmtDelta}`;
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

// --- PARAMETER RESOLUTION & CYCLE DETECTION ---

// Helper to extract dependencies from an expression string
export function getDependencies(expression: string): string[] {
    if (!expression || !expression.trim()) return [];
    try {
        const node = math.parse(expression);
        const deps = new Set<string>();
        node.traverse((n: any) => {
            if (n.isSymbolNode) {
                deps.add(n.name);
            }
        });
        return Array.from(deps);
    } catch (e) {
        return [];
    }
}

// Check if source depends on target (source -> ... -> target)
// Returns true if a path exists from sourceKey to targetKey
export function dependsOn(sourceKey: string, targetKey: string, params: Parameter[]): boolean {
    if (sourceKey === targetKey) return true;
    
    // BFS
    const visited = new Set<string>();
    const stack = [sourceKey];
    
    const paramMap = new Map<string, Parameter>();
    params.forEach(p => paramMap.set(p.key, p));

    while(stack.length > 0) {
        const current = stack.pop()!;
        if (current === targetKey) return true;
        
        if (visited.has(current)) continue;
        visited.add(current);
        
        const p = paramMap.get(current);
        if (!p) continue;
        
        const deps = getDependencies(p.expression);
        deps.forEach(d => stack.push(d));
    }
    return false;
}

// Solve all parameters in topological order
export function resolveParameters(params: Parameter[]): Parameter[] {
    // 1. Build Graph
    const graph = new Map<string, string[]>();
    const paramMap = new Map<string, Parameter>();
    
    params.forEach(p => {
        paramMap.set(p.key, p);
        graph.set(p.key, getDependencies(p.expression));
    });
    
    // 2. Topological Sort
    const sorted: string[] = [];
    const visited = new Set<string>();
    const temp = new Set<string>();
    
    const visit = (node: string) => {
        if (temp.has(node)) return; // Cycle detected (ignore this branch)
        if (visited.has(node)) return;
        
        temp.add(node);
        const deps = graph.get(node) || [];
        deps.forEach(d => {
            if (paramMap.has(d)) visit(d);
        });
        temp.delete(node);
        visited.add(node);
        sorted.push(node);
    }
    
    params.forEach(p => {
        if (!visited.has(p.key)) visit(p.key);
    });
    
    // 3. Evaluate in Order
    const resolvedParams = params.map(p => ({...p})); // Clone
    const resolvedMap = new Map<string, Parameter>();
    resolvedParams.forEach(p => resolvedMap.set(p.key, p));
    
    // Evaluation Scope (Always in mm)
    const scope: Record<string, number> = {};
    
    sorted.forEach(key => {
        const p = resolvedMap.get(key);
        if (!p) return;
        
        try {
            const result = math.evaluate(p.expression, scope);
            
            // Handle mathjs types (Number or Unit)
            // Strategy: Convert everything to Base Unit (mm) for the Scope.
            // Convert to Target Unit for the stored Value.
            
            if (typeof result === 'number') {
                // Heuristic: If it's a raw number with no symbols in expr, assume it is already in Target Unit.
                // If it involves variables (which are in mm), assume result is in mm.
                const hasSymbols = getDependencies(p.expression).length > 0;
                
                if (!hasSymbols) {
                    // Constant: "10" -> 10 [Target Unit]
                    // Scope: 10 * conversion
                    p.value = result;
                    scope[p.key] = p.unit === 'in' ? result * 25.4 : result;
                } else {
                    // Calculated: "A + 10" -> Result assumed MM
                    // Value: Result / conversion
                    const valInMm = result;
                    p.value = p.unit === 'in' ? valInMm / 25.4 : valInMm;
                    scope[p.key] = valInMm;
                }
            } else if (result && typeof result.toNumber === 'function') {
                // It's a Unit (e.g. "1 inch")
                const valInMm = result.toNumber('mm');
                p.value = p.unit === 'in' ? valInMm / 25.4 : valInMm;
                scope[p.key] = valInMm;
            } else {
                p.value = 0;
                scope[p.key] = 0;
            }
        } catch (e) {
            p.value = 0;
            scope[p.key] = 0;
        }
    });
    
    return resolvedParams;
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
    pX = 0, pY = 0, pA = 0, // Parent GLOBAL Transform
    localTransform = { x: 0, y: 0, angle: 0 } // NEW: Parent LOCAL Transform (relative to rootFootprint)
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

    // Calculate LOCAL transform for children (Relative to current rootFootprint)
    // We must accumulate localTransform
    const lRad = (localTransform.angle * Math.PI) / 180;
    const lCos = Math.cos(lRad);
    const lSin = Math.sin(lRad);
    const nextLocalX = localTransform.x + (lx * lCos - ly * lSin);
    const nextLocalY = localTransform.y + (lx * lSin + ly * lCos);
    const nextLocalA = localTransform.angle + la;
    const currentLocalTransform = { x: nextLocalX, y: nextLocalY, angle: nextLocalA };

    if (shape.type === "union") {
        const union = shape as FootprintUnion;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let valid = false;

        union.shapes.forEach(child => {
            const childBounds = getShapeAABB(
                child, params, rootFootprint, allFootprints, 
                gx, gy, gA, 
                currentLocalTransform // Pass accumulated local transform
            );
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
            const childBounds = getShapeAABB(
                child, params, target, allFootprints, 
                gx, gy, gA, 
                { x: 0, y: 0, angle: 0 } // RESET Local Transform when entering a new footprint context
            );
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
            // CRITICAL FIX: Pass currentLocalTransform to resolvePoint
            // This ensures points are resolved relative to THIS shape's origin within the current rootFootprint.
            const res = resolvePoint(p, rootFootprint, allFootprints, params, currentLocalTransform);
            
            // res is Local (x,y)
            const mx = res.x;
            const my = res.y;
            
            // Transform Local (mx, my) by Shape Global Transform (gx, gy, gA)
            // But wait, the rotation matrix used below (rcos, rsin) uses rrad = -pA?
            // This assumes points are relative to the Container, not the Shape?
            // The code below: `mx = lx + res.x`.
            // lx is Shape X in Container.
            // If res.x is Local to Shape, then `lx + res.x` is Local to Container.
            // Then we rotate by Container Angle (pA).
            // This is correct IF `resolvePoint` returns Local to Shape.
            
            // However, `getShapeAABB` logic previously assumed `res.x` was relative to Shape.
            // `resolvePoint` now guarantees it returns Local to Shape.
            
            const shapeRelX = lx + mx;
            const shapeRelY = ly + my;
            
            const fx = pX + (shapeRelX * rcos - shapeRelY * rsin);
            const fy = -(pY + (shapeRelX * rsin + shapeRelY * rcos)); // Visual Y flip
            
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
    pX = 0, pY = 0, pA = 0, // Global Transform
    localTransform = { x: 0, y: 0, angle: 0 } // NEW: Local Context Transform
): boolean {
    const aabb = getShapeAABB(shape, params, rootFootprint, allFootprints, pX, pY, pA, localTransform);
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

    // Calculate LOCAL transform for children
    const lRad = (localTransform.angle * Math.PI) / 180;
    const lCos = Math.cos(lRad);
    const lSin = Math.sin(lRad);
    const nextLocalX = localTransform.x + (lx * lCos - ly * lSin);
    const nextLocalY = localTransform.y + (lx * lSin + ly * lCos);
    const nextLocalA = localTransform.angle + la;
    const currentLocalTransform = { x: nextLocalX, y: nextLocalY, angle: nextLocalA };

    // RECURSIVE CHECK FOR UNIONS
    if (shape.type === "union") {
        const u = shape as FootprintUnion;
        return u.shapes.some(child => 
            isShapeInSelection(selectionBox, child, params, u as unknown as Footprint, allFootprints, gx, gy, gA, currentLocalTransform)
        );
    }

    if (shape.type === "footprint") {
        const ref = shape as FootprintReference;
        const target = allFootprints.find(f => f.id === ref.footprintId);
        if (!target) return false;
        return target.shapes.some(child => 
            isShapeInSelection(selectionBox, child, params, target, allFootprints, gx, gy, gA, { x: 0, y: 0, angle: 0 })
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
        
        // Removed shapeGlobalTransform, use currentLocalTransform logic
        const visualPoints = ptsRaw.map((p: any) => {
             // CRITICAL FIX: Pass currentLocalTransform to resolvePoint
             const res = resolvePoint(p, rootFootprint, allFootprints, params, currentLocalTransform);
             
             // res is Local to Shape (0,0)
             // lx, ly are Shape Local to Container (already factored into gx, gy)
             // So we construct Global from Shape Global (gx, gy) + Rot(res)
             
             // BUT, `isShapeInSelection` loops over Container coordinates?
             // In AABB we did: `mx = lx + res.x` (Local to Container).
             // Let's do that here to be consistent with rotation logic.
             // We need Container Transform (pX, pY, pA).
             // `lx, ly` is Shape Local.
             // `res.x` is Shape Relative.
             
             const mx = lx + res.x; 
             const my = ly + res.y;
             
             // Rotation logic using Parent Transform
             const rrad = -pA * (Math.PI / 180);
             const rcos = Math.cos(rrad); const rsin = Math.sin(rrad);

             const vx = pX + (mx * rcos - my * rsin);
             const vy = -(pY + (mx * rsin + my * rcos)); // Visual Y
             
             const rotHandle = (h?: {x: number, y: number}) => {
                 if (!h) return undefined;
                 return {
                     x: h.x * rcos - h.y * rsin,
                     y: -(h.x * rsin + h.y * rcos)
                 };
             };

             return {
                 x: vx,
                 y: vy,
                 hOut: rotHandle(res.handleOut),
                 hIn: rotHandle(res.handleIn)
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
    params: Parameter[],
    // NEW: Context transform: Where is the current shape relative to the root?
    // Passing this allows us to "unsnap" global coordinates back to the shape's local space.
    // This is critical for shapes inside unions or transformed references.
    parentTransform: { x: number, y: number, angle: number } = { x: 0, y: 0, angle: 0 }
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
    let guideTransform = { x: 0, y: 0, angle: 0 }; 
    let foundGuide: FootprintWireGuide | null = null;

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const shape = currentShapes.find(s => s.id === id);
        if (!shape) return defaultRes;

        if (shape.type === "wireGuide") {
             const wg = shape as FootprintWireGuide;
             const lx = evaluateExpression(wg.x, params);
             const ly = evaluateExpression(wg.y, params);
             
             // Current accumulated rotation
             const rad = (guideTransform.angle * Math.PI) / 180;
             const cos = Math.cos(rad);
             const sin = Math.sin(rad);
             
             // Anchor point is translated and rotated
             guideTransform.x += (lx * cos - ly * sin);
             guideTransform.y += (lx * sin + ly * cos);
             foundGuide = wg;
             break; // Found it

        } 
        
        let lx = 0, ly = 0, la = 0;

        if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const nextFp = allFootprints.find(f => f.id === ref.footprintId);
             if (!nextFp) return defaultRes;

             lx = evaluateExpression(ref.x, params);
             ly = evaluateExpression(ref.y, params);
             la = evaluateExpression(ref.angle, params);
             currentShapes = nextFp.shapes;
        } else if (shape.type === "union") {
            const u = shape as FootprintUnion;
            lx = evaluateExpression(u.x, params);
            ly = evaluateExpression(u.y, params);
            la = evaluateExpression(u.angle, params);
            currentShapes = u.shapes;
        } else {
            return defaultRes;
        }

        const rad = (guideTransform.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        
        // Move the origin of the next footprint into the current frame
        guideTransform.x += (lx * cos - ly * sin);
        guideTransform.y += (lx * sin + ly * cos);
        guideTransform.angle += la;
    }
    
    if (!foundGuide) return defaultRes;

    // --- NEW LOGIC: INVERSE TRANSFORM ---
    // We have Guide Global (guideTransform) and Parent Global (parentTransform).
    // We need Point Local (relative to parent).
    // Local = InverseParent * Global
    
    const pRad = parentTransform.angle * (Math.PI / 180);
    const pCos = Math.cos(pRad);
    const pSin = Math.sin(pRad);
    
    // Handles are VECTORS: they only rotate, they do not translate
    // UPDATED: Project single Wire Guide handle to symmetric in/out handles for the snapped point
    // BUT use the POSITIVE vector for BOTH handles to create a "pinch" effect
    // FIX: Initialize with default (local) handles so they persist if guide handles are missing
    let handleIn = defaultRes.handleIn;
    let handleOut = defaultRes.handleOut;

    if (foundGuide.handle) {
         const hx = evaluateExpression(foundGuide.handle.x, params);
         const hy = evaluateExpression(foundGuide.handle.y, params);
         
         // Guide vector in Global Space (rotated by guide accumulated angle)
         const gRad = guideTransform.angle * Math.PI / 180;
         const globalHX = hx * Math.cos(gRad) - hy * Math.sin(gRad);
         const globalHY = hx * Math.sin(gRad) + hy * Math.cos(gRad);
         
         // Apply Junction Offset (Perpendicular shift)
         const offset = evaluateExpression(point.junctionOffset, params);
         if (Math.abs(offset) > 0.0001) {
             const len = Math.sqrt(globalHX * globalHX + globalHY * globalHY);
             if (len > 0) {
                 // Normalize and rotate 90 degrees (-y, x) for left perpendicular relative to flow
                 const perpX = -globalHY / len;
                 const perpY = globalHX / len;
                 guideTransform.x += perpX * offset;
                 guideTransform.y += perpY * offset;
             }
         }

         // Map Vector to Local Space (Rotate by -pAngle)
         const localHX_raw = globalHX * pCos + globalHY * pSin;
         const localHY_raw = -globalHX * pSin + globalHY * pCos;

         // Apply Flip Direction
         const flip = !!point.flipDirection;
         const localHX = flip ? -localHX_raw : localHX_raw;
         const localHY = flip ? -localHY_raw : localHY_raw;

         handleOut = { x: localHX, y: localHY };
         handleIn = { x: localHX, y: localHY }; 
    }

    // Translate relative to parent (Done AFTER applying offsets to guideTransform)
    const relX = guideTransform.x - parentTransform.x;
    const relY = guideTransform.y - parentTransform.y;
    
    // Rotate backwards (-pAngle)
    const localX = relX * pCos + relY * pSin;
    const localY = -relX * pSin + relY * pCos;

    return { x: localX, y: localY, handleIn, handleOut };
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
    resolution: number,
    // NEW: Optional parent transform for correct snapping context in recursion
    parentTransform: { x: number, y: number, angle: number } = { x: 0, y: 0, angle: 0 },
    // NEW: Optional shape position to normalize snapped points relative to shape origin
    shapePosition: { x: number, y: number } = { x: 0, y: 0 }
): THREE.Vector2[] {
    if (points.length < 3) return [];

    const pathPoints: THREE.Vector2[] = [];

    // Helper: Normalize Resolved Point to be Relative to Shape Origin
    const normalize = (p: Point) => {
        const res = resolvePoint(p, contextFp, allFootprints, params, parentTransform);
        if (p.snapTo) {
            // res is Absolute in Container (Union). 
            // We want Relative to Shape Origin (which is at shapePosition inside container).
            return { 
                x: res.x - shapePosition.x, 
                y: res.y - shapePosition.y, 
                handleIn: res.handleIn, 
                handleOut: res.handleOut 
            };
        } else {
            // res is Relative to Shape (because p.x/y are relative)
            return res;
        }
    };

    for (let i = 0; i < points.length; i++) {
        const currRaw = points[i];
        const nextRaw = points[(i + 1) % points.length];

        const curr = normalize(currRaw);
        const next = normalize(nextRaw);

        // Add originX/Y? 
        // Typically originX/Y passed to this function are 0,0 if we want local coords.
        // If we want global, originX/Y are passed as global coords.
        // Since we normalized snapped points to be relative to shape, adding originX/Y works for both cases.
        
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
        
        // Handles are VECTORS, they rotate but do not translate
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

/**
 * Calculates the bounding box of the entire footprint in Visual Coordinates.
 */

// Calculate point and tangent at specific distance along a polyline/bezier path
// Cubic Bezier Derivative (1st derivative)
function bezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
    const mt = 1 - t;
    return 3 * mt * mt * (p1 - p0) + 
           6 * mt * t * (p2 - p1) + 
           3 * t * t * (p3 - p2);
}

// Linear Interpolation for Angles (Degrees) handling wrap-around (-180 to 180)
// FIXED: Use correct logic for shortest path interpolation
function lerpAngle(start: number, end: number, t: number): number {
    let diff = end - start;
    // Normalize diff to -180 to 180 to take the shortest path
    while (diff <= -180) diff += 360;
    while (diff > 180) diff -= 360;
    return start + diff * t;
}

interface PathTransform {
    x: number;
    y: number;
    angle: number; // In degrees, standard math (CCW from East)
}

// NEW: Calculate point and tangent at specific distance along a polyline/bezier path
// Uses 1st order interpolation for angles to prevent "chunky" rotation when sliding.
export function getTransformAlongLine(
    shape: FootprintLine,
    distanceParam: number,
    params: Parameter[],
    contextFp: Footprint,
    allFootprints: Footprint[],
    // Optional parent transform if needed for recursive context
    parentTransform: { x: number, y: number, angle: number } = { x: 0, y: 0, angle: 0 }
): PathTransform | null {
    const points = shape.points;
    if (points.length < 2) return null;

    // 1. Discretize the entire path into linear segments
    // We store startAngle AND endAngle for interpolation
    const segments: { 
        x: number, y: number, 
        dist: number, 
        len: number,
        angleStart: number, 
        angleEnd: number 
    }[] = [];
    
    let totalLength = 0;
    
    // Helper to push segment with explicit angles
    const addSeg = (p1: {x:number, y:number}, p2: {x:number, y:number}, angStart: number, angEnd: number) => {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx*dx + dy*dy);
        if (len === 0) return;
        
        segments.push({
            x: p1.x,
            y: p1.y,
            dist: totalLength,
            len: len,
            angleStart: angStart,
            angleEnd: angEnd
        });
        totalLength += len;
    };

    const STEPS = 20; // Increase this for higher position fidelity

    for(let i=0; i<points.length-1; i++) {
        // Pass parentTransform to resolvePoint for nested contexts
        const curr = resolvePoint(points[i], contextFp, allFootprints, params, parentTransform);
        const next = resolvePoint(points[i+1], contextFp, allFootprints, params, parentTransform);

        // NOTE: resolvePoint returns coordinates relative to Shape Origin (if snapped and normalized)
        // or relative to shape if not snapped.
        // Wait, resolvePoint with parentTransform returns coordinates Local to the Shape's Container (relative to parent).
        // If we want coordinates relative to the line itself, we might need to adjust.
        // But FootprintLine has `x,y` (usually 0,0).
        // If the line has non-zero x,y, `resolvePoint` math in other places adds it.
        // Here we just use the resolved points which are consistent with each other.

        if (curr.handleOut || next.handleIn) {
            const p0 = curr;
            const p3 = next;
            const p1 = { x: p0.x + (p0.handleOut?.x||0), y: p0.y + (p0.handleOut?.y||0) };
            const p2 = { x: p3.x + (p3.handleIn?.x||0), y: p3.y + (p3.handleIn?.y||0) };

            let prevBez = p0;
            
            // Calculate initial tangent for t=0
            const dx0 = bezierDerivative(p0.x, p1.x, p2.x, p3.x, 0);
            const dy0 = bezierDerivative(p0.y, p1.y, p2.y, p3.y, 0);
            let prevAngle = Math.atan2(dy0, dx0) * (180 / Math.PI);

            for(let s=1; s<=STEPS; s++) {
                const t = s/STEPS;
                
                // Position
                const tx = bezier1D(p0.x, p1.x, p2.x, p3.x, t);
                const ty = bezier1D(p0.y, p1.y, p2.y, p3.y, t);
                const currentBez = { x: tx, y: ty };
                
                // Exact Derivative Tangent at t (End of this micro-segment)
                const dxt = bezierDerivative(p0.x, p1.x, p2.x, p3.x, t);
                const dyt = bezierDerivative(p0.y, p1.y, p2.y, p3.y, t);
                
                // Safety check for zero derivative (e.g., overlapping handles)
                let currentAngle = prevAngle; 
                if (Math.abs(dxt) > 1e-5 || Math.abs(dyt) > 1e-5) {
                    currentAngle = Math.atan2(dyt, dxt) * (180 / Math.PI);
                }

                addSeg(prevBez, currentBez, prevAngle, currentAngle);
                
                prevBez = currentBez;
                prevAngle = currentAngle;
            }
        } else {
            // Straight line: Constant Angle
            const dx = next.x - curr.x;
            const dy = next.y - curr.y;
            const ang = Math.atan2(dy, dx) * (180 / Math.PI);
            addSeg(curr, next, ang, ang);
        }
    }

    // 2. Clamp distance
    const d = Math.max(0, Math.min(distanceParam, totalLength));

    // 3. Find Segment
    for(let i=segments.length-1; i>=0; i--) {
        const seg = segments[i];
        if (d >= seg.dist - 0.0001) { 
            const remaining = d - seg.dist;
            const ratio = Math.min(1, Math.max(0, remaining / seg.len));
            
            // Interpolate Angle (Smooth rotation)
            const angle = lerpAngle(seg.angleStart, seg.angleEnd, ratio);
            
            // Interpolate Position (Linear walk along chord)
            // We find the endpoint of the current segment to lerp position
            let nextX, nextY;
            if (i < segments.length - 1) {
                nextX = segments[i+1].x;
                nextY = segments[i+1].y;
            } else {
                // Fallback for the very last segment: project based on length
                // (or just assume the segment is valid and calculate vector)
                const rad = seg.angleEnd * (Math.PI / 180);
                nextX = seg.x + Math.cos(rad) * seg.len;
                nextY = seg.y + Math.sin(rad) * seg.len;
            }
            
            const x = seg.x + (nextX - seg.x) * ratio;
            const y = seg.y + (nextY - seg.y) * ratio;
            
            return { x, y, angle };
        }
    }

    return null;
}


/**
 * Calculates the total length of a FootprintLine including Bezier segments.
 */
export function getLineLength(
    shape: FootprintLine,
    params: Parameter[],
    contextFp: Footprint,
    allFootprints: Footprint[],
    parentTransform: { x: number, y: number, angle: number } = { x: 0, y: 0, angle: 0 }
): number {
    const points = shape.points;
    if (points.length < 2) return 0;
    let totalLength = 0;
    const STEPS = 20;
    for (let i = 0; i < points.length - 1; i++) {
        const curr = resolvePoint(points[i], contextFp, allFootprints, params, parentTransform);
        const next = resolvePoint(points[i + 1], contextFp, allFootprints, params, parentTransform);
        if (curr.handleOut || next.handleIn) {
            const p0 = curr;
            const p3 = next;
            const p1 = { x: p0.x + (p0.handleOut?.x || 0), y: p0.y + (p0.handleOut?.y || 0) };
            const p2 = { x: p3.x + (p3.handleIn?.x || 0), y: p3.y + (p3.handleIn?.y || 0) };
            let prevX = p0.x; let prevY = p0.y;
            for (let s = 1; s <= STEPS; s++) {
                const t = s / STEPS;
                const tx = bezier1D(p0.x, p1.x, p2.x, p3.x, t);
                const ty = bezier1D(p0.y, p1.y, p2.y, p3.y, t);
                totalLength += Math.sqrt((tx - prevX) ** 2 + (ty - prevY) ** 2);
                prevX = tx; prevY = ty;
            }
        } else {
            totalLength += Math.sqrt((next.x - curr.x) ** 2 + (next.y - curr.y) ** 2);
        }
    }
    return totalLength;
}

export function getFootprintAABB(
    footprint: Footprint,
    params: Parameter[],
    allFootprints: Footprint[]
): Rect | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let found = false;

    // 1. Process Shapes
    footprint.shapes.forEach(shape => {
        // Skip virtual guides for framing
        if (shape.type === "wireGuide") return;
        // Skip board outlines if the footprint isn't acting as a board
        if (shape.type === "boardOutline" && !footprint.isBoard) return;

        const aabb = getShapeAABB(shape, params, footprint, allFootprints);
        if (aabb) {
            found = true;
            minX = Math.min(minX, aabb.x1, aabb.x2);
            maxX = Math.max(maxX, aabb.x1, aabb.x2);
            minY = Math.min(minY, aabb.y1, aabb.y2);
            maxY = Math.max(maxY, aabb.y1, aabb.y2);
        }
    });

    // 2. Process Mesh Origins (at least ensure their 2D anchor is in frame)
    (footprint.meshes || []).forEach(m => {
        found = true;
        const mx = evaluateExpression(m.x, params);
        const my = -evaluateExpression(m.y, params); // Inverted for visual
        minX = Math.min(minX, mx); maxX = Math.max(maxX, mx);
        minY = Math.min(minY, my); maxY = Math.max(maxY, my);
    });

    if (!found) return null;

    return { x1: minX, y1: minY, x2: maxX, y2: maxY };
}


// NEW: Calculate closest distance on wire to a target point
export function getClosestDistanceAlongLine(
    shape: FootprintLine,
    targetPoint: { x: number, y: number },
    params: Parameter[],
    contextFp: Footprint,
    allFootprints: Footprint[],
    parentTransform: { x: number, y: number, angle: number } = { x: 0, y: 0, angle: 0 }
): { distance: number, closestPoint: { x: number, y: number } } {
    const points = shape.points;
    if (points.length < 2) return { distance: 0, closestPoint: { x: 0, y: 0 } };

    let bestDist = Infinity;
    let bestTotalDist = 0;
    let bestPoint = { x: 0, y: 0 };

    let currentTotalLength = 0;
    const STEPS = 20;

    // Helper: Project point P onto Segment AB
    const project = (p: {x:number,y:number}, a: {x:number,y:number}, b: {x:number,y:number}) => {
        const ax = p.x - a.x; const ay = p.y - a.y;
        const bx = b.x - a.x; const by = b.y - a.y;
        const t = (ax * bx + ay * by) / (bx * bx + by * by);
        const sat = Math.max(0, Math.min(1, t));
        return {
            t: sat,
            x: a.x + sat * bx,
            y: a.y + sat * by,
            distSq: (a.x + sat * bx - p.x)**2 + (a.y + sat * by - p.y)**2,
            len: Math.sqrt(bx*bx + by*by)
        };
    };

    for(let i=0; i<points.length-1; i++) {
        // Pass parentTransform to resolvePoint
        const curr = resolvePoint(points[i], contextFp, allFootprints, params, parentTransform);
        const next = resolvePoint(points[i+1], contextFp, allFootprints, params, parentTransform);

        if (curr.handleOut || next.handleIn) {
            const p0 = curr;
            const p3 = next;
            const p1 = { x: p0.x + (p0.handleOut?.x||0), y: p0.y + (p0.handleOut?.y||0) };
            const p2 = { x: p3.x + (p3.handleIn?.x||0), y: p3.y + (p3.handleIn?.y||0) };

            let prevBez = p0;
            for(let s=1; s<=STEPS; s++) {
                const t = s/STEPS;
                const tx = bezier1D(p0.x, p1.x, p2.x, p3.x, t);
                const ty = bezier1D(p0.y, p1.y, p2.y, p3.y, t);
                const currentBez = { x: tx, y: ty };

                const proj = project(targetPoint, prevBez, currentBez);
                if (proj.distSq < bestDist) {
                    bestDist = proj.distSq;
                    bestTotalDist = currentTotalLength + proj.t * proj.len;
                    bestPoint = { x: proj.x, y: proj.y };
                }

                currentTotalLength += proj.len;
                prevBez = currentBez;
            }
        } else {
            const proj = project(targetPoint, curr, next);
            if (proj.distSq < bestDist) {
                bestDist = proj.distSq;
                bestTotalDist = currentTotalLength + proj.t * proj.len;
                bestPoint = { x: proj.x, y: proj.y };
            }
            currentTotalLength += proj.len;
        }
    }

    return { distance: bestTotalDist, closestPoint: bestPoint };
}

/**
 * Ensures that if a footprint is marked as a board, it has at least one outline
 * and every layer in the stackup is assigned to a valid outline.
 */
export function repairBoardAssignments(
    footprint: Footprint,
    stackup: StackupLayer[]
): Footprint {
    if (!footprint.isBoard) return footprint;

    const outlines = footprint.shapes.filter(s => s.type === "boardOutline");
    if (outlines.length === 0) return footprint;

    const newAssignments = { ...(footprint.boardOutlineAssignments || {}) };
    let modified = false;

    stackup.forEach(layer => {
        const currentAssignment = newAssignments[layer.id];
        const targetExists = footprint.shapes.some(s => s.id === currentAssignment && s.type === "boardOutline");

        if (!currentAssignment || !targetExists) {
            newAssignments[layer.id] = outlines[0].id;
            modified = true;
        }
    });

    return modified ? { ...footprint, boardOutlineAssignments: newAssignments } : footprint;
}


// --- NEW: Convert Export/Sliced Shape back to FootprintShape ---
export function convertExportShapeToFootprintShape(exportShape: any): FootprintShape {
    const base = {
        id: crypto.randomUUID(),
        name: "Sliced Shape",
        assignedLayers: {}, // No assignment needed, layer is explicit in the stack context
        locked: true
    };

    const fmt = (n: number) => n.toFixed(4);

    if (exportShape.shape_type === "rect") {
        return {
            ...base,
            type: "rect",
            x: fmt(exportShape.x),
            y: fmt(exportShape.y),
            width: fmt(exportShape.width),
            height: fmt(exportShape.height),
            angle: fmt(exportShape.angle || 0),
            cornerRadius: fmt(exportShape.corner_radius || 0)
        } as FootprintRect;
    } 
    else if (exportShape.shape_type === "circle") {
        return {
            ...base,
            type: "circle",
            x: fmt(exportShape.x),
            y: fmt(exportShape.y),
            diameter: fmt(exportShape.diameter)
        } as FootprintCircle;
    }
    else if (exportShape.shape_type === "polygon") {
        const points: Point[] = (exportShape.points || []).map((p: any) => ({
            id: crypto.randomUUID(),
            x: fmt(p.x),
            y: fmt(p.y),
            handleIn: p.handle_in ? { x: fmt(p.handle_in.x), y: fmt(p.handle_in.y) } : undefined,
            handleOut: p.handle_out ? { x: fmt(p.handle_out.x), y: fmt(p.handle_out.y) } : undefined
        }));
        
        return {
            ...base,
            type: "polygon",
            x: "0", y: "0", // Points are already absolute in export shape
            points
        } as FootprintPolygon;
    }
    
    // Fallback for lines or unknown, treat as polygon if points exist
    if (exportShape.points) {
         const points: Point[] = (exportShape.points || []).map((p: any) => ({
            id: crypto.randomUUID(),
            x: fmt(p.x),
            y: fmt(p.y)
        }));
        return { ...base, type: "polygon", x: "0", y: "0", points } as FootprintPolygon;
    }

    throw new Error(`Unknown export shape type: ${exportShape.shape_type}`);
}

