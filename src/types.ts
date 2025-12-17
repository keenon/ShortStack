// src/types.ts
export interface Parameter {
  id: string;
  key: string;
  value: number;
  unit: "mm" | "in";
}

export type ManufacturingType = "Cut" | "Carved/Printed";

export interface StackupLayer {
  id: string;
  name: string;
  type: ManufacturingType;
  thicknessExpression: string;
  color: string;
}

// --- NEW TYPES FOR FOOTPRINT EDITOR ---

export type ShapeType = "circle" | "rect";

export interface BaseShape {
  id: string;
  type: ShapeType;
  name: string;
  // Key is layerId, Value is depthExpression (or empty string/ignored if not Carved)
  assignedLayers: Record<string, string>;
}

// Properties are strings to allow expressions (e.g., "Width / 2")
export interface FootprintCircle extends BaseShape {
  type: "circle";
  x: string;
  y: string;
  diameter: string;
}

export interface FootprintRect extends BaseShape {
  type: "rect";
  x: string;
  y: string;
  width: string;
  height: string;
}

export type FootprintShape = FootprintCircle | FootprintRect;

export interface Footprint {
  id: string;
  name: string;
  shapes: FootprintShape[];
}

export interface ProjectData {
  params: Parameter[];
  stackup: StackupLayer[];
  footprints: Footprint[];
}