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

export type ShapeType = "circle" | "rect" | "line";

export interface LayerAssignment {
    depth: string;
    endmillRadius: string;
}

export interface BaseShape {
  id: string;
  type: ShapeType;
  name: string;
  // assignedLayers maps LayerID -> { depth, endmillRadius }
  // We include 'string' in the type for backward compatibility during load, 
  // but it is normalized to LayerAssignment in the app.
  assignedLayers: Record<string, LayerAssignment | string>;
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
  cornerRadius: string;
}

export interface Point {
  id: string;
  x: string;
  y: string;
  // Control points are relative to the anchor point (x, y)
  handleIn?: { x: string; y: string };  // "Left" / Incoming handle
  handleOut?: { x: string; y: string }; // "Right" / Outgoing handle
}

export interface FootprintLine extends BaseShape {
  type: "line";
  x: string;
  y: string;
  thickness: string;
  points: Point[];
}

export type FootprintShape = FootprintCircle | FootprintRect | FootprintLine;

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

// Board Outline types
export interface BoardOutline {
  points: Point[];
}

export interface ProjectData {
  params: Parameter[];
  stackup: StackupLayer[];
  footprints: Footprint[];
  layout: FootprintInstance[];
  boardOutline: BoardOutline; 
}