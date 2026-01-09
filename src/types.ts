// src/types.ts
export interface Parameter {
  id: string;
  key: string;
  expression: string; // NEW: Stores the formula (e.g., "Length / 2")
  value: number;      // NEW: Stores the evaluated result (e.g., 10.5)
  unit: "mm" | "in";
  isFavorite?: boolean; // NEW: Fusion 360 Favorite flag
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

export type ShapeType = "circle" | "rect" | "line" | "footprint" | "wireGuide" | "boardOutline" | "polygon" | "union" | "text";;

export interface LayerAssignment {
    depth: string;
    endmillRadius: string;
    inputFillet?: string; // Expression for top fillet/chamfer radius
}

export interface BaseShape {
  id: string;
  type: ShapeType;
  name: string;
  locked?: boolean; // Lock flag
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
  handle?: { x: string; y: string }; // Single handle for flow direction
}

export interface FootprintBoardOutline extends BaseShape {
  type: "boardOutline";
  x: string;
  y: string;
  points: Point[];
}

export interface FootprintPolygon extends BaseShape {
  type: "polygon";
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
  flipDirection?: boolean; // NEW: Invert the flow direction from the guide
  junctionOffset?: string; // NEW: Offset perpendicular to flow (for junctions)
}

export interface TieDown {
  id: string;
  footprintId: string;
  distance: string; // Expression for distance along wire
  angle: string;    // Expression for offset rotation
}

export interface FootprintLine extends BaseShape {
  type: "line";
  x: string;
  y: string;
  thickness: string;
  points: Point[];
  tieDowns?: TieDown[];
}

export interface FootprintReference extends BaseShape {
  type: "footprint";
  x: string;
  y: string;
  angle: string;
  footprintId: string; // The ID of the child footprint
}

export interface FootprintUnion extends BaseShape {
  type: "union";
  x: string;
  y: string;
  angle: string;
  shapes: FootprintShape[];
}

export interface FootprintText extends BaseShape {
  type: "text";
  x: string;
  y: string;
  angle: string;
  text: string;
  fontSize: string;
  anchor: "start" | "middle" | "end";
}

export type FootprintShape = FootprintCircle | FootprintRect | FootprintLine | FootprintReference | FootprintWireGuide | FootprintBoardOutline | FootprintPolygon | FootprintUnion | FootprintText;

export interface MeshAsset {
  id: string;
  name: string;
  content: string; // Base64 encoded file content
  format: "stl" | "step" | "obj" | "glb";
}

export interface FootprintMesh {
  id: string;
  name: string;
  meshId: string; // NEW: References MeshAsset.id
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
  meshes: MeshAsset[]; // NEW: Global library\n  fabPlans?: FabricationPlan[];
  fabPlans?: FabricationPlan[];
}
// --- FABRICATION TYPES ---
export type CutFabricationMethod = "Laser cut";
export type CarvedFabricationMethod = "CNC" | "Waterline laser cut" | "3D printed";
export type FabricationMethod = CutFabricationMethod | CarvedFabricationMethod;

export type WaterlineStartSide = "Cut side" | "Back side";
export type WaterlineRounding = "Round up" | "Round down";

export interface WaterlineSettings {
  sheetThicknessExpression: string;
  startSide: WaterlineStartSide;
  rounding: WaterlineRounding;
}

export interface FabricationPlan {
  id: string;
  name: string;
  footprintId: string;
  layerMethods: Record<string, FabricationMethod>;
  waterlineSettings: Record<string, WaterlineSettings>;
}
