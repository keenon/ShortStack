// src/utils/exportUtils.ts
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintUnion, FootprintCircle, FootprintRect, FootprintLine, FootprintPolygon, FootprintBoardOutline } from "../types";
import { evaluateExpression, resolvePoint, getTransformAlongLine, getPolyOutlinePoints, offsetPolygonContour } from "./footprintUtils";
import { Footprint3DViewHandle } from "../components/Footprint3DView";
import * as THREE from "three";

export async function collectExportShapesAsync(
    contextFootprint: Footprint, 
    shapes: FootprintShape[],
    allFootprints: Footprint[],
    params: Parameter[],
    layer: StackupLayer,
    layerThickness: number,
    viewRef: Footprint3DViewHandle | null,
    transform = { x: 0, y: 0, angle: 0 },
    forceInclude = false,
    localTransform = { x: 0, y: 0, angle: 0 }
): Promise<any[]> {
    let result: any[] = [];
    const reversedShapes = [...shapes].reverse();

    for (const shape of reversedShapes) {
        if (shape.type === "wireGuide" || shape.type === "boardOutline") continue;

        const lx = (shape.type === "line") ? 0 : evaluateExpression(shape.x, params);
        const ly = (shape.type === "line") ? 0 : evaluateExpression(shape.y, params);
        const la = (shape.type === "rect" || shape.type === "footprint" || shape.type === "union") ? evaluateExpression((shape as any).angle, params) : 0;
        
        const rad = (transform.angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const gx = transform.x + (lx * cos - ly * sin);
        const gy = transform.y + (lx * sin + ly * cos);

        const lRad = (localTransform.angle * Math.PI) / 180;
        const lCos = Math.cos(lRad);
        const lSin = Math.sin(lRad);
        
        const clx = localTransform.x + (lx * lCos - ly * lSin);
        const cly = localTransform.y + (lx * lSin + ly * lCos);
        const cla = localTransform.angle + la;
        const currentLocal = { x: clx, y: cly, angle: cla };

        if (shape.type === "footprint") {
             const ref = shape as FootprintReference;
             const target = allFootprints.find(f => f.id === ref.footprintId);
             if (target) {
                 const localAngle = evaluateExpression(ref.angle, params);
                 const globalAngle = transform.angle + localAngle;
                 const children = await collectExportShapesAsync(
                     target, target.shapes, allFootprints, params, layer, layerThickness, viewRef,
                     { x: gx, y: gy, angle: globalAngle }, forceInclude, { x: 0, y: 0, angle: 0 }
                 );
                 result = result.concat(children);
             }
        } else if (shape.type === "union") {
             const u = shape as FootprintUnion;
             const assigned = u.assignedLayers?.[layer.id];
             let overrideDepth = -1;
             let overrideRadius = 0;
             let effectiveDepth = 0;
             
             if (assigned) {
                 if (layer.type === "Cut") {
                     overrideDepth = layerThickness;
                 } else {
                     const val = evaluateExpression(typeof assigned === 'object' ? assigned.depth : assigned, params);
                     overrideDepth = Math.max(0, val);
                     effectiveDepth = overrideDepth;
                     if (typeof assigned === 'object') overrideRadius = evaluateExpression(assigned.endmillRadius, params);
                 }
             }

             if (layer.type === "Carved/Printed" && overrideRadius > 0 && viewRef) {
                 const contourPoints = await viewRef.computeUnionOutline(
                     u.shapes, params, contextFootprint, allFootprints, { x: gx, y: gy, rotation: transform.angle + evaluateExpression(u.angle, params) }
                 );
                 const sliceResult = slicePolygonContours(contourPoints, effectiveDepth, overrideRadius, 0, 0, 0);
                 result = result.concat(sliceResult);
             } else {
                 const uAngle = evaluateExpression(u.angle, params);
                 const globalAngle = transform.angle + uAngle;
                 const shouldForceChildren = forceInclude || !!assigned;
                 const childrenExport = await collectExportShapesAsync(
                     contextFootprint, u.shapes, allFootprints, params, layer, layerThickness, viewRef,
                     { x: gx, y: gy, angle: globalAngle }, shouldForceChildren, currentLocal
                 );
                 if (overrideDepth >= 0) {
                     childrenExport.forEach(child => {
                         child.depth = overrideDepth;
                         if (overrideRadius > 0) child.endmill_radius = overrideRadius;
                     });
                 }
                 result = result.concat(childrenExport);
             }
        } else {
             const explicitAssignment = shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined;
             if (!forceInclude && !explicitAssignment) continue;
             
             let depth = 0;
             let endmillRadius = 0;
             
             if (explicitAssignment) {
                 if (layer.type === "Cut") {
                     depth = layerThickness;
                 } else {
                     const assign = shape.assignedLayers![layer.id];
                     const val = evaluateExpression(typeof assign === 'object' ? assign.depth : assign, params);
                     depth = Math.max(0, val);
                     if (typeof assign === 'object') endmillRadius = evaluateExpression(assign.endmillRadius, params);
                 }
             } else {
                 depth = (layer.type === "Cut") ? layerThickness : 0; 
             }

             if (!forceInclude && depth <= 0.0001) continue;

             const exportObj: any = { x: gx, y: gy, depth: depth };
             if (layer.type === "Carved/Printed" && endmillRadius > 0) exportObj.endmill_radius = endmillRadius;

             if (shape.type === "circle") {
                 exportObj.shape_type = "circle";
                 exportObj.diameter = evaluateExpression((shape as FootprintCircle).diameter, params);
                 result.push(exportObj);
             } else if (shape.type === "rect") {
                 exportObj.shape_type = "rect";
                 exportObj.width = evaluateExpression((shape as FootprintRect).width, params);
                 exportObj.height = evaluateExpression((shape as FootprintRect).height, params);
                 exportObj.angle = transform.angle + evaluateExpression((shape as FootprintRect).angle, params);
                 exportObj.corner_radius = evaluateExpression((shape as FootprintRect).cornerRadius, params);
                 result.push(exportObj);
             } else if (shape.type === "line") {
                exportObj.shape_type = "line";
                const lineShape = shape as FootprintLine;
                exportObj.thickness = evaluateExpression(lineShape.thickness, params);
                
                if (lineShape.tieDowns) {
                    for (const td of lineShape.tieDowns) {
                        const target = allFootprints.find(f => f.id === td.footprintId);
                        if (target) {
                            const dist = evaluateExpression(td.distance, params);
                            const rotOffset = evaluateExpression(td.angle, params);
                            const tf = getTransformAlongLine(lineShape, dist, params, contextFootprint, allFootprints, currentLocal);
                            if (tf) {
                                const rx = tf.x * cos - tf.y * sin;
                                const ry = tf.x * sin + tf.y * cos;
                                const tdGx = gx + rx;
                                const tdGy = gy + ry;
                                const tdAngle = transform.angle + (tf.angle - 90 + rotOffset);
                                const children = await collectExportShapesAsync(
                                    target, target.shapes, allFootprints, params, layer, layerThickness, viewRef,
                                    { x: tdGx, y: tdGy, angle: tdAngle }, forceInclude
                                );
                                result = result.concat(children);
                            }
                        }
                    }
                }

                exportObj.points = lineShape.points.map(p => {
                    const resolved = resolvePoint(p, contextFootprint, allFootprints, params, currentLocal);
                    const rx = resolved.x * cos - resolved.y * sin;
                    const ry = resolved.x * sin + resolved.y * cos;
                    const rotateVec = (v?: {x: number, y: number}) => v ? { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos } : undefined;
                    return { x: gx + rx, y: gy + ry, handle_in: rotateVec(resolved.handleIn), handle_out: rotateVec(resolved.handleOut) };
                });
                result.push(exportObj);
            } else if (shape.type === "polygon") {
                const poly = shape as FootprintPolygon;
                if (endmillRadius <= 0.001 || layer.type === "Cut") {
                    exportObj.shape_type = "polygon";
                    exportObj.points = poly.points.map(p => {
                        const resolved = resolvePoint(p, contextFootprint, allFootprints, params, currentLocal);
                        const shapeGlobalRad = (transform.angle + la) * (Math.PI / 180);
                        const sCos = Math.cos(shapeGlobalRad);
                        const sSin = Math.sin(shapeGlobalRad);
                        const rx = resolved.x * sCos - resolved.y * sSin;
                        const ry = resolved.x * sSin + resolved.y * sCos;
                        const rotateVec = (v?: {x: number, y: number}) => v ? { x: v.x * sCos - v.y * sSin, y: v.x * sSin + v.y * sCos } : undefined;
                        return { x: gx + rx, y: gy + ry, handle_in: rotateVec(resolved.handleIn), handle_out: rotateVec(resolved.handleOut) };
                    });
                    result.push(exportObj);
                } else {
                    const basePoints = getPolyOutlinePoints(poly.points, 0, 0, params, contextFootprint, allFootprints, 32, currentLocal, { x: 0, y: 0 });
                    const shapeGlobalRad = (transform.angle + la) * (Math.PI / 180);
                    const sCos = Math.cos(shapeGlobalRad);
                    const sSin = Math.sin(shapeGlobalRad);
                    const contour = basePoints.map(p => ({ x: gx + (p.x * sCos - p.y * sSin), y: gy + (p.x * sSin + p.y * sCos) }));
                    const slices = slicePolygonContours([contour], depth, endmillRadius, 0, 0, 0);
                    result = result.concat(slices);
                }
            }
        }
    }
    return result;
}

function slicePolygonContours(contours: {x:number, y:number}[][], depth: number, endmillRadius: number, tx = 0, ty = 0, rot = 0): any[] {
    const result: any[] = [];
    const rad = (rot * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    contours.forEach(contourPts => {
        const basePoints = contourPts.map(p => new THREE.Vector2(p.x, p.y));
        if (basePoints.length < 3) return;
        let area = 0;
        for (let i = 0; i < basePoints.length; i++) {
            const j = (i + 1) % basePoints.length;
            area += basePoints[i].x * basePoints[j].y - basePoints[j].x * basePoints[i].y;
        }
        if (area < 0) basePoints.reverse();
        const safeR = Math.min(endmillRadius, depth);
        const steps = 8;
        const baseDepth = depth - safeR;
        const layers: { z: number, offset: number }[] = [];
        if (baseDepth > 0.001) layers.push({ z: baseDepth, offset: 0 });
        for(let i=1; i<=steps; i++) {
            const theta = (i / steps) * (Math.PI / 2);
            layers.push({ z: baseDepth + Math.sin(theta) * safeR, offset: (1 - Math.cos(theta)) * safeR });
        }
        layers.forEach(layer => {
            const offsetPts = offsetPolygonContour(basePoints, layer.offset);
            if (offsetPts.length < 3) return;
            const outputPoints = offsetPts.map(p => ({ x: tx + (p.x * cos - p.y * sin), y: ty + (p.x * sin + p.y * cos), handle_in: undefined, handle_out: undefined }));
            result.push({ shape_type: "polygon", x: 0, y: 0, depth: layer.z, endmill_radius: 0, points: outputPoints });
        });
    });
    return result;
}