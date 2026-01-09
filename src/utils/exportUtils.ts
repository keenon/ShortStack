// src/utils/exportUtils.ts
import { Footprint, FootprintShape, Parameter, StackupLayer, FootprintReference, FootprintUnion, FootprintCircle, FootprintRect, FootprintLine, FootprintPolygon } from "../types";
import { evaluateExpression, resolvePoint, getTransformAlongLine, offsetPolygonContour } from "./footprintUtils";
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
             let overrideInputFillet = 0;
             let effectiveDepth = 0;
             
             if (assigned) {
                 if (layer.type === "Cut") {
                     overrideDepth = layerThickness;
                 } else {
                     const val = evaluateExpression(typeof assigned === 'object' ? assigned.depth : assigned, params);
                     overrideDepth = Math.max(0, val);
                     effectiveDepth = overrideDepth;
                     if (typeof assigned === 'object') {
                         overrideRadius = evaluateExpression(assigned.endmillRadius, params);
                         overrideInputFillet = evaluateExpression(assigned.inputFillet, params);
                     }
                 }
             }

             if (layer.type === "Carved/Printed" && overrideRadius > 0 && viewRef) {
                 // For complex unions with radii, we use the 2D contour generator from the worker if available
                 const contourPoints = await viewRef.computeUnionOutline(
                     u.shapes, params, contextFootprint, allFootprints, { x: gx, y: gy, rotation: transform.angle + evaluateExpression(u.angle, params) }
                 );
                 // Note: this path bypasses hierarchical structure, flattening the union into polygons
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
                         if (overrideInputFillet > 0) child.input_fillet = overrideInputFillet;
                     });
                 }
                 result = result.concat(childrenExport);
             }
        } else {
             const explicitAssignment = shape.assignedLayers && shape.assignedLayers[layer.id] !== undefined;
             if (!forceInclude && !explicitAssignment) continue;
             
             let depth = 0;
             let endmillRadius = 0;
             let inputFillet = 0;
             
             if (explicitAssignment) {
                 if (layer.type === "Cut") {
                     depth = layerThickness;
                 } else {
                     const assign = shape.assignedLayers![layer.id];
                     const val = evaluateExpression(typeof assign === 'object' ? assign.depth : assign, params);
                     depth = Math.max(0, val);
                     if (typeof assign === 'object') {
                         endmillRadius = evaluateExpression(assign.endmillRadius, params);
                         inputFillet = evaluateExpression(assign.inputFillet, params);
                     }
                 }
             } else {
                 depth = (layer.type === "Cut") ? layerThickness : 0; 
             }

             if (!forceInclude && depth <= 0.0001) continue;

             const exportObj: any = { x: gx, y: gy, depth: depth };
             if (layer.type === "Carved/Printed") {
                 if (endmillRadius > 0) exportObj.endmill_radius = endmillRadius;
                 if (inputFillet > 0) exportObj.input_fillet = inputFillet;
             }

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
                
                // For polygon, if we have radii, we should probably output the base polygon 
                // and let the expanding logic handle offsets, rather than slicing here (which is for 3D stacks).
                // But `slicePolygonContours` was used for *depth maps*.
                // For *profile cuts* (Waterline), we want the single contour at a depth.
                // We'll output the raw polygon and handle slicing in `sliceExportShapes`.
                
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

/**
 * Filters a list of export shapes to only those that intersect a specific Z-depth slice,
 * and modifies their geometry to account for chamfers/fillets at that depth.
 */
export function sliceExportShapes(allShapes: any[], sliceZ: number, layerThickness: number): any[] {
    const sliced: any[] = [];

    for (const shape of allShapes) {
        const totalDepth = shape.depth || 0;
        
        // If the shape doesn't reach this slice (it's shallower than the current Z), skip
        // Standard pocket starts at Z=0 and goes to Z=totalDepth.
        if (sliceZ >= totalDepth - 0.0001) continue;

        // Calculate Offset at this specific Z
        let offset = 0;
        const inputFillet = shape.input_fillet || 0;
        const endmillRadius = shape.endmill_radius || 0;

        // 1. Input Fillet (Top Chamfer)
        // Active from Z=0 to Z=inputFillet
        if (inputFillet > 0.001 && sliceZ < inputFillet) {
            // Formula: (r - x)^2 + (r - z)^2 = r^2  => x (offset)
            // Or simpler trig:
            // At Z=0, offset = -radius (Wide). At Z=radius, offset = 0 (Nominal).
            // Circular profile (quarter circle):
            // dist_from_center_of_fillet = inputFillet - sliceZ
            // width_from_vertical_wall = sqrt(r^2 - dist^2)
            // offset = width_from_vertical_wall - r  (Negative = wider)
            const dist = inputFillet - sliceZ;
            const w = Math.sqrt(Math.max(0, inputFillet * inputFillet - dist * dist));
            offset += (w - inputFillet); // Negative value
        }

        // 2. Endmill Radius (Bottom Ball/Fillet)
        // Active from Z = (TotalDepth - endmillRadius) to TotalDepth
        const bottomStart = totalDepth - endmillRadius;
        if (endmillRadius > 0.001 && sliceZ > bottomStart) {
            // At Z=bottomStart, offset = 0.
            // At Z=TotalDepth, offset = radius (closed/narrow).
            const heightFromBottom = totalDepth - sliceZ;
            // width = sqrt(r^2 - (r-h)^2)
            // offset = r - width (Positive = narrower)
            const dist = endmillRadius - heightFromBottom;
            const w = Math.sqrt(Math.max(0, endmillRadius * endmillRadius - dist * dist));
            offset += (endmillRadius - w);
        }

        // Clone and modify
        // We set depth to layerThickness because for this slice (sheet), it is a through cut.
        const newShape = { ...shape, depth: layerThickness };
        
        // Apply Offset
        if (Math.abs(offset) > 0.0001) {
            if (newShape.shape_type === "circle") {
                newShape.diameter -= 2 * offset;
                if (newShape.diameter <= 0.001) continue; // Closed up
            } else if (newShape.shape_type === "rect") {
                newShape.width -= 2 * offset;
                newShape.height -= 2 * offset;
                if (newShape.width <= 0.001 || newShape.height <= 0.001) continue;
                if (newShape.corner_radius) newShape.corner_radius = Math.max(0, newShape.corner_radius - offset);
            } else if (newShape.shape_type === "line") {
                newShape.thickness -= 2 * offset;
                if (newShape.thickness <= 0.001) continue;
            } else if (newShape.shape_type === "polygon") {
                const vecPts = newShape.points.map((p:any) => new THREE.Vector2(p.x, p.y));
                // offsetPolygonContour returns THREE.Vector2[]
                const offPts = offsetPolygonContour(vecPts, offset);
                if (offPts.length < 3) continue;
                newShape.points = offPts.map(p => ({ x: p.x, y: p.y }));
            }
        }

        sliced.push(newShape);
    }

    return sliced;
}