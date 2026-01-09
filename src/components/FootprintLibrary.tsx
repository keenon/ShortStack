// src/components/FootprintLibrary.tsx
import { useState, useRef } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { Footprint, Parameter, StackupLayer, MeshAsset } from "../types";
import FootprintEditor from "./FootprintEditor";
import { IconOutline, IconFootprint, IconDuplicate } from "./Icons";
import './FootprintLibrary.css';

const IconGrip = ({ className }: { className?: string }) => (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <path d="M9 3H11V21H9V3ZM13 3H15V21H13V3Z" />
    </svg>
);

interface Props {
  footprints: Footprint[];
  setFootprints: React.Dispatch<React.SetStateAction<Footprint[]>>;
  params: Parameter[];
  stackup: StackupLayer[];
  meshAssets: MeshAsset[];
  onRegisterMesh: (asset: MeshAsset) => void;
}

export default function FootprintLibrary({ footprints, setFootprints, params, stackup, meshAssets, onRegisterMesh }: Props) {
  const [editStack, setEditStack] = useState<string[]>([]);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragItemIndex = useRef<number | null>(null);

  const addFootprint = () => {
    const newFp: Footprint = { id: crypto.randomUUID(), name: "New Footprint", shapes: [] };
    setFootprints([...footprints, newFp]);
    setEditStack([newFp.id]);
  };

  const deleteFootprint = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await ask("Delete this footprint?", { title: "Confirm", kind: "warning" });
    if (confirmed) {
      setFootprints((prev) => prev.filter((fp) => fp.id !== id));
      if (editStack.includes(id)) setEditStack([]);
    }
  };

  const handleReorder = (dragIndex: number, dropIndex: number) => {
    if (dragIndex === dropIndex) return;
    const next = [...footprints];
    const [movedItem] = next.splice(dragIndex, 1);
    const targetIndex = dragIndex < dropIndex ? dropIndex - 1 : dropIndex;
    next.splice(targetIndex, 0, movedItem);
    setFootprints(next);
  };

  const duplicateFootprint = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const source = footprints.find(f => f.id === id);
    if (!source) return;
    const clone: Footprint = JSON.parse(JSON.stringify(source));
    clone.id = crypto.randomUUID();
    let baseName = source.name.replace(/ \(\d+\)$/, "");
    let counter = 1;
    let newName = `${baseName} (${counter})`;
    while (footprints.some(f => f.name === newName)) { counter++; newName = `${baseName} (${counter})`; }
    clone.name = newName;
    const index = footprints.findIndex(f => f.id === id);
    const next = [...footprints];
    next.splice(index + 1, 0, clone);
    setFootprints(next);
  };

  const onDragStart = (e: React.DragEvent, index: number) => {
    dragItemIndex.current = index;
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragOverIndex !== index) setDragOverIndex(index);
  };

  const onDrop = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragItemIndex.current !== null) {
      handleReorder(dragItemIndex.current, index);
    }
    setDragOverIndex(null);
    dragItemIndex.current = null;
  };

  const activeId = editStack.length > 0 ? editStack[editStack.length - 1] : null;
  const activeFootprint = footprints.find((fp) => fp.id === activeId);

  if (activeFootprint) {
    return (
      <FootprintEditor
        key={activeFootprint.id}
        footprint={activeFootprint}
        allFootprints={footprints} 
        onUpdate={(upd) => setFootprints(prev => prev.map(f => f.id === upd.id ? upd : f))}
        onClose={() => setEditStack(prev => prev.slice(0, -1))}
        onEditChild={(id) => setEditStack(prev => [...prev, id])}
        params={params}
        stackup={stackup}
        meshAssets={meshAssets}
        onRegisterMesh={onRegisterMesh}
      />
    );
  }

  return (
    <div className="editor-content">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0 }}>Footprint Library</h2>
        <button onClick={addFootprint}>+ New Footprint</button>
      </div>

      <table className="unified-editor-table">
        <thead>
          <tr>
            <th className="col-grip"></th>
            <th className="col-type">Type</th>
            <th className="col-name">Footprint Name</th>
            <th className="col-info">Shapes</th>
            <th className="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody onDragLeave={() => setDragOverIndex(null)}>
          {footprints.map((fp, index) => (
            <tr 
              key={fp.id} 
              draggable
              onDragStart={(e) => onDragStart(e, index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={(e) => onDrop(e, index)}
              onClick={() => setEditStack([fp.id])}
              className={`footprint-row ${dragOverIndex === index ? "drag-over" : ""}`}
            >
              <td className="col-grip drag-handle-cell"><IconGrip /></td>
              <td className="col-type" style={{ textAlign: "center" }}>
                  {fp.isBoard ? <div style={{ color: "#646cff" }}><IconOutline size={18} /></div> : <div style={{ color: "#888" }}><IconFootprint size={18} /></div>}
              </td>
              <td className="col-name name-cell">{fp.name}</td>
              <td className="col-info">{fp.shapes.length}</td>
              <td className="col-actions actions-cell">
                  <button className="icon-btn" onClick={(e) => duplicateFootprint(e, fp.id)} title="Duplicate"><IconDuplicate /></button>
                  <button className="danger icon-btn" onClick={(e) => deleteFootprint(fp.id, e)}>✕</button>
              </td>
            </tr>
          ))}
          {/* BOTTOM DROP TARGET */}
          {footprints.length > 0 && (
            <tr
                onDragOver={(e) => onDragOver(e, footprints.length)}
                onDrop={(e) => onDrop(e, footprints.length)}
                className={`drop-zone-row ${dragOverIndex === footprints.length ? "drag-over" : ""}`}
            >
                <td colSpan={5}></td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}