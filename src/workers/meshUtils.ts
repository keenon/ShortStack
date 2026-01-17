import * as THREE from "three";
import { Footprint, Parameter, FootprintLine, FootprintShape, FootprintBoardOutline, FootprintReference, FootprintUnion } from "../types";
import { evaluateExpression, resolvePoint, getTransformAlongLine } from "../utils/footprintUtils";

// --- HELPERS & GEOMETRY UTILS ---

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary_string = self.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    const chunk = 8192; 
    for (let i = 0; i < len; i += chunk) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(i + chunk, len))));
    }
    return self.btoa(binary);
}

export function evaluate(expression: string, params: Parameter[]): number {
  return evaluateExpression(expression, params);
}

// --- GEOMETRY UTILS ---

export function getLineOutlinePoints(
    shape: FootprintLine, 
    params: Parameter[], 
    thickness: number, 
    resolution: number,
    rootFp: Footprint,
    allFootprints: Footprint[],
    parentTransform?: { x: number, y: number, angle: number }
): THREE.Vector2[] {
    const points = shape.points;
    if (points.length < 2) return [];

    const halfThick = thickness / 2;
    const pathPoints: THREE.Vector2[] = [];

    // Scale curve fidelity based on resolution
    const curveDivisions = Math.max(4, Math.ceil(resolution / 2));

    for (let i = 0; i < points.length - 1; i++) {
        const currRaw = points[i];
        const nextRaw = points[i+1];
        
        const curr = resolvePoint(currRaw, rootFp, allFootprints, params, parentTransform);
        const next = resolvePoint(nextRaw, rootFp, allFootprints, params, parentTransform);

        const x1 = curr.x;
        const y1 = curr.y;
        const x2 = next.x;
        const y2 = next.y;

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

            const sp = curve.getPoints(curveDivisions);
            if (pathPoints.length > 0) sp.shift();
            sp.forEach(p => pathPoints.push(p));
        } else {
            if (pathPoints.length === 0) pathPoints.push(new THREE.Vector2(x1, y1));
            pathPoints.push(new THREE.Vector2(x2, y2));
        }
    }

    if (pathPoints.length < 2) return [];

    const leftPts: THREE.Vector2[] = [];
    const rightPts: THREE.Vector2[] = [];

    for (let i = 0; i < pathPoints.length; i++) {
        const p = pathPoints[i];
        let tangent: THREE.Vector2;
        
        if (i === 0) {
            const next = pathPoints[i+1];
            tangent = new THREE.Vector2().subVectors(next, p).normalize();
        } else if (i === pathPoints.length - 1) {
            const prev = pathPoints[i-1];
            tangent = new THREE.Vector2().subVectors(p, prev).normalize();
        } else {
            const prev = pathPoints[i-1];
            const next = pathPoints[i+1];
            const t1 = new THREE.Vector2().subVectors(p, prev).normalize();
            const t2 = new THREE.Vector2().subVectors(next, p).normalize();
            tangent = new THREE.Vector2().addVectors(t1, t2).normalize();
        }

        const normal = new THREE.Vector2(-tangent.y, tangent.x);
        leftPts.push(new THREE.Vector2(p.x + normal.x * halfThick, p.y + normal.y * halfThick));
        rightPts.push(new THREE.Vector2(p.x - normal.x * halfThick, p.y - normal.y * halfThick));
    }

    const contour: THREE.Vector2[] = [];
    // Scale arc divisions based on resolution
    const arcDivisions = Math.max(3, Math.ceil(resolution / 4));

    for (let i = 0; i < leftPts.length; i++) contour.push(leftPts[i]);

    {
        const lastIdx = pathPoints.length - 1;
        const pLast = pathPoints[lastIdx];
        const vLast = new THREE.Vector2().subVectors(leftPts[lastIdx], pLast);
        const startAng = Math.atan2(vLast.y, vLast.x);
        for (let i = 1; i <= arcDivisions; i++) {
            const t = i / arcDivisions;
            const ang = startAng - t * Math.PI; 
            contour.push(new THREE.Vector2(
                pLast.x + Math.cos(ang) * halfThick,
                pLast.y + Math.sin(ang) * halfThick
            ));
        }
    }

    for (let i = rightPts.length - 1; i >= 0; i--) contour.push(rightPts[i]);

    {
        const pFirst = pathPoints[0];
        const vFirst = new THREE.Vector2().subVectors(rightPts[0], pFirst);
        const startAng = Math.atan2(vFirst.y, vFirst.x);
        for (let i = 1; i < arcDivisions; i++) {
            const t = i / arcDivisions;
            const ang = startAng - t * Math.PI;
            contour.push(new THREE.Vector2(
                pFirst.x + Math.cos(ang) * halfThick,
                pFirst.y + Math.sin(ang) * halfThick
            ));
        }
    }

    return contour;
}

export function createLineShape(shape: FootprintLine, params: Parameter[], rootFp: Footprint, allFootprints: Footprint[], thicknessOverride: number | undefined, resolution: number, parentTransform?: { x: number, y: number, angle: number }): THREE.Shape | null {
  const thickVal = thicknessOverride !== undefined ? thicknessOverride : evaluate(shape.thickness, params);
  if (thickVal <= 0) return null;
  const pts = getLineOutlinePoints(shape, params, thickVal, resolution, rootFp, allFootprints, parentTransform);
  if (pts.length < 3) return null;
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  for(let i=1; i<pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
  s.closePath();
  return s;
}

export function createBoardShape(outlineShape: FootprintBoardOutline, params: Parameter[], rootFootprint: Footprint, allFootprints: Footprint[]): THREE.Shape | null {
    const points = outlineShape.points;
    if (!points || points.length < 3) return null;
    const shape = new THREE.Shape();
    const originX = evaluateExpression(outlineShape.x, params);
    const originY = evaluateExpression(outlineShape.y, params);
    const p0Raw = points[0];
    const p0 = resolvePoint(p0Raw, rootFootprint, allFootprints, params);
    shape.moveTo(originX + p0.x, originY + p0.y);
    for(let i = 0; i < points.length; i++) {
        const currRaw = points[i];
        const nextRaw = points[(i + 1) % points.length];
        const curr = resolvePoint(currRaw, rootFootprint, allFootprints, params);
        const next = resolvePoint(nextRaw, rootFootprint, allFootprints, params);
        const x2 = next.x;
        const y2 = next.y;
        if (curr.handleOut || next.handleIn) {
            const x1 = curr.x;
            const y1 = curr.y;
            const cp1x = x1 + (curr.handleOut ? curr.handleOut.x : 0);
            const cp1y = y1 + (curr.handleOut ? curr.handleOut.y : 0);
            const cp2x = x2 + (next.handleIn ? next.handleIn.x : 0);
            const cp2y = y2 + (next.handleIn ? next.handleIn.y : 0);
            shape.bezierCurveTo(originX + cp1x, originY + cp1y, originX + cp2x, originY + cp2y, originX + x2, originY + y2);
        } else {
            shape.lineTo(originX + x2, originY + y2);
        }
    }
    return shape;
}

export function shapeToManifold(wasm: any, shape: THREE.Shape, resolution = 32) {
    let points = shape.getPoints(resolution);
    if (points.length > 1 && points[0].distanceTo(points[points.length-1]) < 0.001) points.pop();
    const contour = points.map(p => [p.x, p.y]);
    const holes = shape.holes.map(h => {
        let hPts = h.getPoints(resolution);
        if (hPts.length > 1 && hPts[0].distanceTo(hPts[hPts.length-1]) < 0.001) hPts.pop();
        return hPts.map(p => [p.x, p.y]);
    });
    return new wasm.CrossSection([contour, ...holes], "EvenOdd");
}

export interface FlatShape {
    shape: FootprintShape;
    x: number;
    y: number;
    rotation: number;
    originalId: string;
    contextFp: Footprint;
    unionId?: string;
    relativeTransform: { x: number, y: number, rotation: number };
}

export function flattenShapes(
    contextFp: Footprint,
    rootFp: Footprint,
    shapes: FootprintShape[], 
    allFootprints: Footprint[], 
    params: Parameter[],
    transform = { x: 0, y: 0, rotation: 0 },
    depth = 0,
    currentUnionId: string | undefined = undefined,
    relativeTransform = { x: 0, y: 0, rotation: 0 }
): FlatShape[] {
    if (depth > 10) return [];
    let result: FlatShape[] = [];
    shapes.forEach(shape => {
        if (shape.type === "wireGuide" || shape.type === "boardOutline" || shape.type === "text") return;

        const localX = (shape.type === "line") ? 0 : evaluate(shape.x, params);
        const localY = (shape.type === "line") ? 0 : evaluate(shape.y, params);

        const rad = (transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const globalX = transform.x + (localX * cos - localY * sin);
        const globalY = transform.y + (localX * sin + localY * cos);
        let localRotation = 0;
        if (shape.type === "rect" || shape.type === "footprint" || shape.type === "union") {
            localRotation = evaluate((shape as any).angle, params);
        }
        const globalRotation = transform.rotation + localRotation;

        const relRad = (relativeTransform.rotation * Math.PI) / 180;
        const relCos = Math.cos(relRad);
        const relSin = Math.sin(relRad);
        const relX = relativeTransform.x + (localX * relCos - localY * relSin);
        const relY = relativeTransform.y + (localX * relSin + localY * relCos);
        const relRotation = relativeTransform.rotation + localRotation;
        const currentRelTransform = { x: relX, y: relY, rotation: relRotation };

        if (shape.type === "line") {
            const line = shape as any; // FootprintLine
            result.push({ 
                shape: shape, x: globalX, y: globalY, rotation: globalRotation, 
                originalId: shape.id, contextFp, unionId: currentUnionId,
                relativeTransform: currentRelTransform
            });

            if (line.tieDowns) {
                line.tieDowns.forEach((td: any) => {
                    const target = allFootprints.find(f => f.id === td.footprintId);
                    if (target) {
                        const dist = evaluate(td.distance, params);
                        const rotOffset = evaluate(td.angle, params);
                        
                        const tf = getTransformAlongLine(line, dist, params, rootFp, allFootprints);
                        if (tf) {
                            const tdLocalX = tf.x;
                            const tdLocalY = tf.y;
                            const tdLocalRot = tf.angle - 90 + rotOffset;
                            
                            const rotX = tdLocalX * cos - tdLocalY * sin;
                            const rotY = tdLocalX * sin + tdLocalY * cos;
                            const tdGlobalX = globalX + rotX;
                            const tdGlobalY = globalY + rotY;
                            const tdGlobalRot = transform.rotation + tdLocalRot;

                            const children = flattenShapes(
                                target, 
                                rootFp, 
                                target.shapes, 
                                allFootprints, 
                                params, 
                                { x: tdGlobalX, y: tdGlobalY, rotation: tdGlobalRot }, 
                                depth + 1, 
                                undefined,
                                { x: 0, y: 0, rotation: 0 }
                            );
                            result = result.concat(children);
                        }
                    }
                });
            }
        } else if (shape.type === "footprint") {
            const ref = shape as FootprintReference;
            const target = allFootprints.find(f => f.id === ref.footprintId);
            if (target) {
                const children = flattenShapes(target, rootFp, target.shapes, allFootprints, params, { x: globalX, y: globalY, rotation: globalRotation }, depth + 1, currentUnionId, { x: 0, y: 0, rotation: 0 });
                result = result.concat(children);
            }
        } else if (shape.type === "union") {
            const u = shape as FootprintUnion;
            const effectiveUnionId = currentUnionId || u.id;
            const children = flattenShapes(contextFp, rootFp, u.shapes, allFootprints, params, { x: globalX, y: globalY, rotation: globalRotation }, depth + 1, effectiveUnionId, currentRelTransform);
            if (Object.keys(u.assignedLayers || {}).length > 0) {
                children.forEach(c => { c.shape = { ...c.shape, assignedLayers: u.assignedLayers }; });
            }
            result = result.concat(children);
        } else {
            result.push({ 
                shape: shape, x: globalX, y: globalY, rotation: globalRotation, 
                originalId: shape.id, contextFp, unionId: currentUnionId,
                relativeTransform: currentRelTransform
            });
        }
    });
    return result;
}
