export interface Parameter {
  id: string;
  key: string;
  value: number;
  unit: "mm" | "in"; // Added unit
}