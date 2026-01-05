// src/components/ShapeListPanel.tsx
import { useState, useRef } from "react";
import { Footprint, FootprintShape, StackupLayer, FootprintReference } from "../types";
import { isFootprintOptionValid, getRecursiveLayers } from "../utils/footprintUtils";
import { IconCircle, IconRect, IconLine, IconGuide, IconOutline, IconFootprint, IconPolygon, IconText } from "./Icons";

// Helper Icon for the Drag Handle
const IconGrip = ({ className }: { className?: string }) => (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 3H11V21H9V3ZM13 3H15V21H13V3Z" />
    </svg>
);

const ShapeListPanel = ({
  footprint,
  allFootprints,
  selectedShapeIds,
  onSelect,
  onDelete,
  onRename,
  onReorder,
  stackup,
  isShapeVisible,
}: {
  footprint: Footprint;
  allFootprints: Footprint[];
  selectedShapeIds: string[];
  onSelect: (id: string, multi: boolean) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onReorder: (dragIndex: number, hoverIndex: number) => void;
  stackup: StackupLayer[];
  isShapeVisible: (shape: FootprintShape) => boolean;
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Drag State
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemIndex = useRef<number | null>(null);

  const getIcon = (type: string) => {
      switch(type) {
          case "circle": return <IconCircle className="shape-icon" />;
          case "rect": return <IconRect className="shape-icon" />;
          case "line": return <IconLine className="shape-icon" />;
          case "polygon": return <IconPolygon className="shape-icon" />;
          case "wireGuide": return <IconGuide className="shape-icon" />;
          case "boardOutline": return <IconOutline className="shape-icon" />;
          case "footprint": return <IconFootprint className="shape-icon" />;
          case "text": return <IconText className="shape-icon" />;
          case "union": return <div className="shape-icon" style={{fontWeight:'bold', width:16, textAlign:'center'}}>U</div>;
          default: return null;
      }
  };

  // --- DRAG HANDLERS ---
  
  const handleDragStart = (e: React.DragEvent, index: number, id: string) => {
      // Prevent drag if we are currently editing text in this item
      if (renamingId === id) {
          e.preventDefault();
          return;
      }

      dragItemIndex.current = index;
      
      // CRITICAL: Restrict effect to 'move' only. 
      // This helps browser know 'copy' (green plus) is not an option.
      e.dataTransfer.effectAllowed = "move";
      
      if (!selectedShapeIds.includes(id)) {
          onSelect(id, false);
      }
      
      e.dataTransfer.setData("text/plain", index.toString());
  };

  // Handler for individual Items
  const handleDragOver = (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation(); // Stop bubbling to container to keep precise index
      e.dataTransfer.dropEffect = "move"; // Enforce "Move" cursor
      
      if (dragOverIndex !== index) {
          setDragOverIndex(index);
      }
  };

  // Handler for the Container (covers gaps)
  const handleContainerDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move"; // Enforce "Move" cursor even in gaps
  };

  const handleContainerDragLeave = (e: React.DragEvent) => {
      // Only clear if we actually left the container, not just entered a child
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOverIndex(null);
      }
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      e.stopPropagation();
      
      const dragIndex = dragItemIndex.current;
      if (dragIndex !== null && dragIndex !== dropIndex) {
          onReorder(dragIndex, dropIndex);
      }
      
      setDragOverIndex(null);
      dragItemIndex.current = null;
  };

  const displayShapes = footprint.shapes.map((s, i) => ({ ...s, originalIndex: i }))
    .filter(s => footprint.isBoard || s.type !== "boardOutline");

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
        <div 
            className="shape-list-container" 
            onDragLeave={handleContainerDragLeave}
            onDragOver={handleContainerDragOver} // Catch-all for gaps
            onDrop={(e) => {
                // Catch drops in empty space (append to end)
                e.preventDefault();
                if (dragItemIndex.current !== null) {
                    onReorder(dragItemIndex.current, footprint.shapes.length);
                }
                setDragOverIndex(null);
                dragItemIndex.current = null;
            }}
        >
            {displayShapes.map((shape, visualIndex) => {
                const visible = isShapeVisible(shape);
                const isRenaming = renamingId === shape.id;
                
                let hasError = false;
                if (shape.type === "footprint") {
                    const refId = (shape as FootprintReference).footprintId;
                    const target = allFootprints.find(f => f.id === refId);
                    if (!target || !isFootprintOptionValid(footprint.id, target, allFootprints)) {
                        hasError = true;
                    }
                }

                let usedLayers: StackupLayer[] = [];
                if (shape.type === "footprint") {
                    usedLayers = getRecursiveLayers((shape as FootprintReference).footprintId, allFootprints, stackup);
                } else if (shape.type === "boardOutline") {
                    const assignments = footprint.boardOutlineAssignments || {};
                    usedLayers = stackup.filter(l => assignments[l.id] === shape.id);
                } else {
                    usedLayers = stackup.filter(l => shape.assignedLayers && shape.assignedLayers[l.id] !== undefined);
                }
                
                const isGuide = shape.type === "wireGuide";
                const isDragTarget = dragOverIndex === visualIndex;

                return (
                    <div 
                        key={shape.id}
                        draggable={true}
                        onDragStart={(e) => handleDragStart(e, shape.originalIndex, shape.id)}
                        onDragOver={(e) => handleDragOver(e, visualIndex)}
                        onDrop={(e) => handleDrop(e, shape.originalIndex)}
                        
                        className={`shape-item ${selectedShapeIds.includes(shape.id) ? "selected" : ""} ${!visible ? "is-hidden" : ""} ${hasError ? "error-item" : ""}`}
                        style={{ 
                            border: '1px solid transparent',
                            borderColor: hasError ? 'red' : (selectedShapeIds.includes(shape.id) ? '#646cff' : 'transparent'),
                            borderTopColor: isDragTarget ? '#00ffff' : (hasError ? 'red' : (selectedShapeIds.includes(shape.id) ? '#646cff' : 'transparent')),
                            marginTop: isDragTarget ? '4px' : '0'
                        }}
                        onClick={(e) => onSelect(shape.id, e.metaKey || e.ctrlKey)}
                    >
                        <div className="drag-handle" style={{ cursor: 'grab', marginRight: '4px', opacity: 0.5 }}>
                            <IconGrip />
                        </div>

                        {getIcon(shape.type)}
                        
                        <div className="shape-layer-indicators">
                            {usedLayers.map(layer => (
                                <div key={layer.id} className="layer-indicator-dot" style={{ backgroundColor: layer.color }} title={layer.name} />
                            ))}
                            {isGuide && (
                                <div className="layer-indicator-dot" style={{ backgroundColor: '#0f0', borderRadius: '50%' }} title="Wire Guide" />
                            )}
                        </div>

                        {/* RENAME LOGIC */}
                        {isRenaming ? (
                            <input 
                                type="text" 
                                value={shape.name} 
                                onChange={(e) => onRename(shape.id, e.target.value)} 
                                className="shape-name-edit" 
                                autoFocus
                                onBlur={() => setRenamingId(null)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                    if (e.key === 'Escape') setRenamingId(null);
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                            />
                        ) : (
                            <span 
                                className="shape-name-display"
                                onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingId(shape.id);
                                }}
                            >
                                {shape.name}
                            </span>
                        )}

                        {hasError && <span style={{color:'red', marginRight:'5px'}} title="Invalid Reference">⚠</span>}

                        <div className="shape-actions" style={{ display: 'flex', gap: '2px' }}>
                            <button className="icon-btn danger" onClick={(e) => { e.stopPropagation(); onDelete(shape.id); }} style={{ width: '24px', height: '24px', fontSize: '0.9em' }} title="Delete">✕</button>
                        </div>
                    </div>
                );
            })}
            
            {/* Empty space filler for easier dragging to bottom */}
            {displayShapes.length > 0 && (
                 <div style={{ minHeight: '30px', flexGrow: 1 }} />
            )}
            
            {footprint.shapes.length === 0 && <div className="empty-state-small">No shapes added.</div>}
        </div>
      )}
    </div>
  );
};

export default ShapeListPanel;