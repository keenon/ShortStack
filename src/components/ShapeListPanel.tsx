// src/components/FootprintEditor.tsx
import { useState } from "react";
import { Footprint, FootprintShape, StackupLayer, FootprintReference } from "../types";
import { isFootprintOptionValid, getRecursiveLayers } from "../utils/footprintUtils";
import { IconCircle, IconRect, IconLine, IconGuide, IconOutline, IconFootprint, IconPolygon } from "./Icons";

// 4. SHAPE LIST PANEL
const ShapeListPanel = ({
  footprint,
  allFootprints,
  selectedShapeIds, // UPDATED: Multi-select
  onSelect,
  onDelete,
  onRename,
  onMove,
  stackup,
  isShapeVisible,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedShapeIds: string[]; // UPDATED: Multi-select
  onSelect: (id: string, multi: boolean) => void; // UPDATED
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  stackup: StackupLayer[];
  isShapeVisible: (shape: FootprintShape) => boolean;
}) => {
  const [collapsed, setCollapsed] = useState(false);

  const getIcon = (type: string) => {
      switch(type) {
          case "circle": return <IconCircle className="shape-icon" />;
          case "rect": return <IconRect className="shape-icon" />;
          case "line": return <IconLine className="shape-icon" />;
          case "polygon": return <IconPolygon className="shape-icon" />;
          case "wireGuide": return <IconGuide className="shape-icon" />;
          case "boardOutline": return <IconOutline className="shape-icon" />;
          case "footprint": return <IconFootprint className="shape-icon" />;
          case "union": return <div className="shape-icon" style={{fontWeight:'bold', width:16, textAlign:'center'}}>U</div>;
          default: return null;
      }
  };

  return (
    <div className="fp-left-subpanel" style={{ flex: collapsed ? '0 0 auto' : 1, minHeight: 'auto', transition: 'flex 0.2s' }}>
      <div 
        onClick={() => setCollapsed(!collapsed)} 
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: collapsed ? 0 : '10px' }}
      >
          <h3 style={{ margin: 0, userSelect: 'none' }}>Objects</h3>
          <span style={{ fontSize: '0.8em', color: '#888' }}>{collapsed ? "▶" : "▼"}</span>
      </div>
      
      {!collapsed && (
        <div className="shape-list-container">
            {footprint.shapes.map((shape, index) => {
            // If not a board, hide outline shapes in the list
            if (!footprint.isBoard && shape.type === "boardOutline") return null;

            const visible = isShapeVisible(shape);
            
            let hasError = false;
            if (shape.type === "footprint") {
                const refId = (shape as FootprintReference).footprintId;
                const target = allFootprints.find(f => f.id === refId);
                if (!target) hasError = true;
                // CHANGE: Only validate direct loop, allow isBoard
                else if (!isFootprintOptionValid(footprint.id, target, allFootprints)) {
                    hasError = true;
                }
            }

            // Determine which layers are used (recursively for footprints)
            let usedLayers: StackupLayer[] = [];
            if (shape.type === "footprint") {
                usedLayers = getRecursiveLayers((shape as FootprintReference).footprintId, allFootprints, stackup);
            } else if (shape.type === "boardOutline") {
                // Show layers explicitly assigned to this outline
                const assignments = footprint.boardOutlineAssignments || {};
                usedLayers = stackup.filter(l => assignments[l.id] === shape.id);
            } else {
                usedLayers = stackup.filter(l => shape.assignedLayers && shape.assignedLayers[l.id] !== undefined);
            }
            
            const isGuide = shape.type === "wireGuide";

            return (
            <div key={shape.id}
                className={`shape-item ${selectedShapeIds.includes(shape.id) ? "selected" : ""} ${!visible ? "is-hidden" : ""} ${hasError ? "error-item" : ""}`}
                onClick={(e) => onSelect(shape.id, e.metaKey || e.ctrlKey)}
                style={hasError ? { border: '1px solid red' } : {}}
            >
                {getIcon(shape.type)}
                
                <div className="shape-layer-indicators">
                {usedLayers.map(layer => (
                    <div key={layer.id} className="layer-indicator-dot" style={{ backgroundColor: layer.color }} title={layer.name} />
                ))}
                {isGuide && (
                    <div className="layer-indicator-dot" style={{ backgroundColor: '#0f0', borderRadius: '50%' }} title="Wire Guide" />
                )}
                </div>

                <input type="text" value={shape.name} onChange={(e) => onRename(shape.id, e.target.value)} className="shape-name-edit" />
                {hasError && <span style={{color:'red', marginRight:'5px'}} title="Invalid Reference">⚠</span>}

                <div className="shape-actions" style={{ display: 'flex', gap: '2px' }}>
                    <button className="icon-btn btn-up" onClick={(e) => { e.stopPropagation(); onMove(index, -1); }} disabled={index === 0} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Move Up">↑</button>
                    <button className="icon-btn btn-down" onClick={(e) => { e.stopPropagation(); onMove(index, 1); }} disabled={index === footprint.shapes.length - 1} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Move Down">↓</button>
                    <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(shape.id); }} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Delete">✕</button>
                </div>
            </div>
            )})}
            {footprint.shapes.length === 0 && <div className="empty-state-small">No shapes added.</div>}
        </div>
      )}
    </div>
  );
};

export default ShapeListPanel;