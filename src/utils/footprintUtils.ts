// src/utils/footprintUtils.ts
import * as math from "mathjs";
import { Footprint, Parameter, StackupLayer, LayerAssignment, FootprintReference, FootprintShape, Point, FootprintWireGuide } from "../types";

export const BOARD_OUTLINE_ID = "BOARD_OUTLINE";

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
    fp.shapes.forEach(s => {
        if (s.type === "footprint") {
            const childRef = s as FootprintReference;
            const childLayers = getRecursiveLayers(childRef.footprintId, allFootprints, stackup, visited);
            childLayers.forEach(l => layerIds.add(l.id));
        } else {
            Object.keys(s.assignedLayers || {}).forEach(k => layerIds.add(k));
        }
    });

    // Return unique layers sorted by stackup order
    return stackup.filter(l => layerIds.has(l.id));
}

export function isFootprintOptionValid(
    currentFootprintId: string, 
    candidateFootprint: Footprint, 
    allFootprints: Footprint[]
): boolean {
    if (candidateFootprint.id === currentFootprintId) return false; // Direct recursion
    if (candidateFootprint.isBoard) return false; // Cannot add standalone boards

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

    function recurse(fp: Footprint, pathIds: string[], names: string[]) {
        fp.shapes.forEach(s => {
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
                    recurse(child, [...pathIds, s.id], [...names, s.name]);
                }
            }
        });
    }

    recurse(rootFootprint, [], []);
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
    let currentFp = rootFootprint;

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const shape = currentFp.shapes.find(s => s.id === id);
        if (!shape) return null;

        if (shape.type === "wireGuide") {
            return shape as FootprintWireGuide;
        } else if (shape.type === "footprint") {
            const ref = shape as FootprintReference;
            const nextFp = allFootprints.find(f => f.id === ref.footprintId);
            if (!nextFp) return null;
            currentFp = nextFp;
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
    
    // Default: Evaluate local params
    const defaultRes = {
        x: evaluateExpression(point.x, params),
        y: evaluateExpression(point.y, params),
        handleIn: point.handleIn ? { 
            x: evaluateExpression(point.handleIn.x, params), 
            y: evaluateExpression(point.handleIn.y, params) 
        } : undefined,
        handleOut: point.handleOut ? { 
            x: evaluateExpression(point.handleOut.x, params), 
            y: evaluateExpression(point.handleOut.y, params) 
        } : undefined,
    };

    if (!point.snapTo) return defaultRes;

    const path = point.snapTo.split(":");
    
    let currentFp = rootFootprint;
    // Accumulate transform from root to the guide
    let transform = { x: 0, y: 0, angle: 0 }; 

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        
        const shape = currentFp.shapes.find(s => s.id === id);
        if (!shape) return defaultRes; // Broken link

        if (shape.type === "wireGuide") {
             // We reached the guide. Calculate its position in its local space, then transform to root.
             const wg = shape as FootprintWireGuide;
             const lx = evaluateExpression(wg.x, params);
             const ly = evaluateExpression(wg.y, params);
             
             // Apply accumulated transform
             const rad = (transform.angle * Math.PI) / 180;
             const cos = Math.cos(rad);
             const sin = Math.sin(rad);
             
             const gx = transform.x + (lx * cos - ly * sin);
             const gy = transform.y + (lx * sin + ly * cos);

             // Handles are vectors, only rotate
             const resolveHandle = (h?: {x:string, y:string}) => {
                 if (!h) return undefined;
                 const hx = evaluateExpression(h.x, params);
                 const hy = evaluateExpression(h.y, params);
                 return {
                     x: hx * cos - hy * sin,
                     y: hx * sin + hy * cos
                 };
             };

             return {
                 x: gx,
                 y: gy,
                 handleIn: resolveHandle(wg.handleIn),
                 handleOut: resolveHandle(wg.handleOut)
             };

        } else if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const nextFp = allFootprints.find(f => f.id === ref.footprintId);
             if (!nextFp) return defaultRes; // Missing footprint ref

             const lx = evaluateExpression(ref.x, params);
             const ly = evaluateExpression(ref.y, params);
             const la = evaluateExpression(ref.angle, params);

             // Compose Transform
             // New Center = Old Center + Rotate(RefPosition)
             const rad = (transform.angle * Math.PI) / 180;
             const cos = Math.cos(rad);
             const sin = Math.sin(rad);
             
             transform.x += (lx * cos - ly * sin);
             transform.y += (lx * sin + ly * cos);
             transform.angle += la;
             
             currentFp = nextFp;
        } else {
            return defaultRes; // Should not happen if path is valid
        }
    }
    
    return defaultRes;
}