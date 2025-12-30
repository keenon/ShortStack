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

export type ShapeType = "circle" | "rect" | "line" | "footprint" | "wireGuide" | "boardOutline";

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

export interface FootprintWireGuide extends BaseShape {
  type: "wireGuide";
  x: string;
  y: string;
  handleIn?: { x: string; y: string };
  handleOut?: { x: string; y: string };
}

export interface FootprintBoardOutline extends BaseShape {
  type: "boardOutline";
  x: string;
  y: string;
  points: Point[];
}

export interface Point {
  id: string;
  x: string;
  y: string;
  // Control points are relative to the anchor point (x, y)
  handleIn?: { x: string; y: string };  // "Left" / Incoming handle
  handleOut?: { x: string; y: string }; // "Right" / Outgoing handle
  snapTo?: string; // ID path to a Wire Guide (e.g., "refId:guideId")
}

export interface FootprintLine extends BaseShape {
  type: "line";
  x: string;
  y: string;
  thickness: string;
  points: Point[];
}

export interface FootprintReference extends BaseShape {
  type: "footprint";
  x: string;
  y: string;
  angle: string;
  footprintId: string; // The ID of the child footprint
}

export type FootprintShape = FootprintCircle | FootprintRect | FootprintLine | FootprintReference | FootprintWireGuide | FootprintBoardOutline;

export interface FootprintMesh {
  id: string;
  name: string;
  content: string; // Base64 encoded file content
  format: "stl" | "step" | "obj" | "glb";
  renderingType: "solid" | "wireframe" | "hidden";
  color?: string;
  // Position
  x: string; 
  y: string; 
  z: string;
  // Rotation (Euler Angles in Degrees)
  rotationX: string; 
  rotationY: string; 
  rotationZ: string;
}

export interface Footprint {
  id: string;
  name: string;
  shapes: FootprintShape[];
  meshes?: FootprintMesh[]; // NEW: Meshes
  isBoard?: boolean;      // NEW: Marks if this footprint is a standalone board
  boardOutline?: Point[]; // DEPRECATED: Points for legacy single outline
  boardOutlineAssignments?: Record<string, string>; // Maps LayerID -> ShapeID
}

export interface FootprintInstance {
  id: string;
  footprintId: string; // References Footprint.id
  name: string;        // Custom name for this instance
  x: string;           // Expression
  y: string;           // Expression
  angle: string;       // Expression
}

// Board Outline types (Global Project Board)
export interface BoardOutline {
  points: Point[];
}

export interface ProjectData {
  params: Parameter[];
  stackup: StackupLayer[];
  footprints: Footprint[];
}