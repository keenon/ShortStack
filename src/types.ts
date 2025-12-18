// src/types.ts
export interface Parameter {
  id: string;
  key: string;
  value: number;
  unit: "mm" | "in";
}

export type ManufacturingType = "Cut" | "Carved/Printed";
export type CarveSide = "Top" | "Bottom";

export interface StackupLayer {
  id: string;
  name: string;
  type: ManufacturingType;
  thicknessExpression: string;
  color: string;
  carveSide: CarveSide;
}

// --- FOOTPRINT TYPES ---

export type ShapeType = "circle" | "rect";

export interface BaseShape {
  id: string;
  type: ShapeType;
  name: string;
  assignedLayers: Record<string, string>;
}

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
  angle: string;
}

export type FootprintShape = FootprintCircle | FootprintRect;

export interface Footprint {
  id: string;
  name: string;
  shapes: FootprintShape[];
}

export interface FootprintInstance {
  id: string;
  footprintId: string; // References Footprint.id
  name: string;        // Custom name for this instance
  x: string;           // Expression
  y: string;           // Expression
  angle: string;       // Expression
}

export interface ProjectData {
  params: Parameter[];
  stackup: StackupLayer[];
  footprints: Footprint[];
  layout: FootprintInstance[]; // Added layout state
}