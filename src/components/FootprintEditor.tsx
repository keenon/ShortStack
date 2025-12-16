// src/components/FootprintEditor.tsx
import React, { useState } from "react";
import * as math from "mathjs";
import { Footprint, FootprintShape, Parameter, FootprintCircle, FootprintRect } from "../types";
import ExpressionEditor from "./ExpressionEditor";
import './FootprintEditor.css';

interface Props {
  footprint: Footprint;
  onUpdate: (updatedFootprint: Footprint) => void;
  onClose: () => void;
  params: Parameter[];
}

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------

// Evaluate math expressions to numbers (for visualization only)
function evaluateExpression(expression: string, params: Parameter[]): number {
  if (!expression.trim()) return 0;
  try {
    const scope: Record<string, any> = {};
    params.forEach((p) => {
      scope[p.key] = math.unit(p.value, p.unit);
    });
    const result = math.evaluate(expression, scope);
    if (typeof result === "number") return result;
    if (result && typeof result.toNumber === "function") return result.toNumber("mm");
    return 0;
  } catch (e) {
    return 0; // Return 0 on error for visualizer
  }
}

// ------------------------------------------------------------------
// SUB-COMPONENTS
// ------------------------------------------------------------------

// 1. SHAPE RENDERER (SVG)
//    Add new shape cases here in the future
const ShapeRenderer = ({
  shape,
  isSelected,
  params,
  onSelect,
}: {
  shape: FootprintShape;
  isSelected: boolean;
  params: Parameter[];
  onSelect: (id: string) => void;
}) => {
  const commonProps = {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(shape.id);
    },
    fill: isSelected ? "rgba(100, 108, 255, 0.5)" : "rgba(255, 255, 255, 0.1)",
    stroke: isSelected ? "#646cff" : "#888",
    strokeWidth: isSelected ? 1 : 0.5,
    style: { cursor: "pointer" },
  };

  if (shape.type === "circle") {
    const r = evaluateExpression(shape.diameter, params) / 2;
    const cx = evaluateExpression(shape.x, params);
    const cy = evaluateExpression(shape.y, params);
    return <circle cx={cx} cy={cy} r={r} {...commonProps} />;
  }

  if (shape.type === "rect") {
    const w = evaluateExpression(shape.width, params);
    const h = evaluateExpression(shape.height, params);
    const x = evaluateExpression(shape.x, params);
    const y = evaluateExpression(shape.y, params);
    // Draw from center logic or top-left? SVG is top-left usually.
    // Let's assume the user inputs Center X/Y.
    // To draw a centered rect in SVG we offset by w/2, h/2.
    return (
      <rect
        x={x - w / 2}
        y={y - h / 2}
        width={w}
        height={h}
        {...commonProps}
      />
    );
  }

  return null;
};

// 2. PROPERTIES PANEL
//    Add new shape property inputs here
const PropertiesPanel = ({
  shape,
  updateShape,
  params,
}: {
  shape: FootprintShape;
  updateShape: (id: string, field: string, val: string) => void;
  params: Parameter[];
}) => {
  return (
    <div className="properties-panel">
      <h3>{shape.type.toUpperCase()} Properties</h3>
      
      <div className="prop-group">
        <label>Name</label>
        <input 
            type="text" 
            value={shape.name} 
            onChange={(e) => updateShape(shape.id, "name", e.target.value)}
        />
      </div>

      <div className="prop-group">
        <label>Center X</label>
        <ExpressionEditor
          value={shape.x}
          onChange={(val) => updateShape(shape.id, "x", val)}
          params={params}
          placeholder="0"
        />
      </div>

      <div className="prop-group">
        <label>Center Y</label>
        <ExpressionEditor
          value={shape.y}
          onChange={(val) => updateShape(shape.id, "y", val)}
          params={params}
          placeholder="0"
        />
      </div>

      {shape.type === "circle" && (
        <div className="prop-group">
          <label>Diameter</label>
          <ExpressionEditor
            value={(shape as FootprintCircle).diameter}
            onChange={(val) => updateShape(shape.id, "diameter", val)}
            params={params}
            placeholder="10"
          />
        </div>
      )}

      {shape.type === "rect" && (
        <>
          <div className="prop-group">
            <label>Width</label>
            <ExpressionEditor
              value={(shape as FootprintRect).width}
              onChange={(val) => updateShape(shape.id, "width", val)}
              params={params}
              placeholder="10"
            />
          </div>
          <div className="prop-group">
            <label>Height</label>
            <ExpressionEditor
              value={(shape as FootprintRect).height}
              onChange={(val) => updateShape(shape.id, "height", val)}
              params={params}
              placeholder="10"
            />
          </div>
        </>
      )}
    </div>
  );
};

// ------------------------------------------------------------------
// MAIN COMPONENT
// ------------------------------------------------------------------

export default function FootprintEditor({ footprint, onUpdate, onClose, params }: Props) {
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);

  // --- ACTIONS ---

  const addShape = (type: "circle" | "rect") => {
    const base = {
      id: crypto.randomUUID(),
      name: `New ${type}`,
    };

    let newShape: FootprintShape;

    if (type === "circle") {
      newShape = { ...base, type: "circle", x: "0", y: "0", diameter: "10" };
    } else {
      newShape = { ...base, type: "rect", x: "0", y: "0", width: "10", height: "10" };
    }

    onUpdate({
        ...footprint,
        shapes: [...footprint.shapes, newShape]
    });
    setSelectedShapeId(newShape.id);
  };

  const updateShape = (shapeId: string, field: string, val: string) => {
    onUpdate({
        ...footprint,
        shapes: footprint.shapes.map((s) =>
            s.id === shapeId ? { ...s, [field]: val } : s
        ),
    });
  };

  const deleteShape = (shapeId: string) => {
     onUpdate({
        ...footprint,
        shapes: footprint.shapes.filter(s => s.id !== shapeId)
     });
     setSelectedShapeId(null);
  };

  const updateFootprintName = (name: string) => {
    onUpdate({ ...footprint, name });
  };

  // --- DERIVED STATE ---
  const activeShape = footprint.shapes.find((s) => s.id === selectedShapeId);

  // --- RENDER: EDITOR VIEW ---
  return (
    <div className="footprint-editor-container">
      {/* Header Toolbar */}
      <div className="fp-toolbar">
        <button className="secondary" onClick={onClose}>
          ← Back
        </button>
        <input 
            className="toolbar-name-input"
            type="text"
            value={footprint.name}
            onChange={(e) => updateFootprintName(e.target.value)}
        />
        <div className="spacer" />
        <button onClick={() => addShape("circle")}>+ Circle</button>
        <button onClick={() => addShape("rect")}>+ Rect</button>
      </div>

      <div className="fp-workspace">
        {/* LEFT: VISUAL EDITOR */}
        <div className="fp-canvas-wrapper">
          <svg 
            className="fp-canvas" 
            viewBox="-50 -50 100 100" 
            onClick={() => setSelectedShapeId(null)}
          >
            {/* Grid Definition */}
            <defs>
              <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
                <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#333" strokeWidth="0.5" />
              </pattern>
            </defs>
            
            {/* Grid Background */}
            <rect x="-500" y="-500" width="1000" height="1000" fill="url(#grid)" />
            
            {/* Axis Lines */}
            <line x1="-500" y1="0" x2="500" y2="0" stroke="#444" strokeWidth="1" />
            <line x1="0" y1="-500" x2="0" y2="500" stroke="#444" strokeWidth="1" />

            {/* Shapes */}
            {footprint.shapes.map((shape) => (
              <ShapeRenderer
                key={shape.id}
                shape={shape}
                isSelected={shape.id === selectedShapeId}
                params={params}
                onSelect={setSelectedShapeId}
              />
            ))}
          </svg>
          <div className="canvas-hint">Grid: 10mm | (0,0) Center</div>
        </div>

        {/* RIGHT: PROPERTIES PANEL */}
        <div className="fp-sidebar">
          {activeShape ? (
            <>
              <PropertiesPanel 
                shape={activeShape} 
                updateShape={updateShape} 
                params={params} 
              />
              <div style={{marginTop: '20px', borderTop: '1px solid #444', paddingTop: '10px'}}>
                <button className="danger" style={{width: '100%'}} onClick={() => deleteShape(activeShape.id)}>
                    Delete Shape
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <p>Select a shape to edit properties.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}