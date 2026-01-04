// src/utils/footprintUtils.ts
import * as math from "mathjs";
import * as THREE from "three"; // Added THREE import
import { Footprint, Parameter, StackupLayer, LayerAssignment, FootprintReference, Point, FootprintWireGuide, FootprintRect } from "../types";

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
    fp.shapes.forEach(s => {
        // IGNORE CHILD BOARD OUTLINES
        if (s.type === "boardOutline") return;

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
    let currentFp = rootFootprint;
    
    // Accumulate transform from root to the guide
    let transform = { x: 0, y: 0, angle: 0 }; 

    for (let i = 0; i < path.length; i++) {
        const id = path[i];
        const shape = currentFp.shapes.find(s => s.id === id);
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
             const resolveHandle = (h?: {x: string, y: string}) => {
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
             
             currentFp = nextFp;
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