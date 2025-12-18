// src/components/LayoutEditor.tsx
import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { Footprint, FootprintInstance, Parameter, StackupLayer } from "../types";
import './LayoutEditor.css';

interface Props {
  layout: FootprintInstance[];
  setLayout: React.Dispatch<React.SetStateAction<FootprintInstance[]>>;
  footprints: Footprint[];
  params: Parameter[];
  stackup: StackupLayer[];
}

export default function LayoutEditor({ layout, setLayout, footprints, params, stackup }: Props) {
  // Viewport state for zooming/panning
  const [viewBox, setViewBox] = useState({ x: -100, y: -100, width: 200, height: 200 });
  const [viewMode, setViewMode] = useState<"2D" | "3D">("2D");
  
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewBoxRef = useRef(viewBox);

  // Dragging State Refs
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragStartViewBox = useRef({ x: 0, y: 0 });

  useEffect(() => {
    viewBoxRef.current = viewBox;
  }, [viewBox]);

  // --- 2D CANVAS NAVIGATION LOGIC (Adapted from FootprintEditor) ---
  
  useLayoutEffect(() => {
    if (!wrapperRef.current || viewMode !== "2D") return;
    const updateDimensions = () => {
        if (!wrapperRef.current) return;
        const { width, height } = wrapperRef.current.getBoundingClientRect();
        if (width === 0 || height === 0) return;
        setViewBox(prev => {
            const newHeight = prev.width / (width / height);
            const centerX = prev.x + prev.width / 2;
            const centerY = prev.y + prev.height / 2;
            return { x: centerX - prev.width / 2, y: centerY - newHeight / 2, width: prev.width, height: newHeight };
        });
    };
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(wrapperRef.current);
    updateDimensions(); 
    return () => observer.disconnect();
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== "2D") return;
    const element = wrapperRef.current; 
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = element.getBoundingClientRect();
        const ratioX = (e.clientX - rect.left) / rect.width;
        const ratioY = (e.clientY - rect.top) / rect.height;
        const userX = viewBoxRef.current.x + ratioX * viewBoxRef.current.width;
        const userY = viewBoxRef.current.y + ratioY * viewBoxRef.current.height;
        const scale = e.deltaY > 0 ? 1.1 : 1 / 1.1;
        const newWidth = viewBoxRef.current.width * scale;
        const newHeight = viewBoxRef.current.height * scale;
        setViewBox({ x: userX - ratioX * newWidth, y: userY - ratioY * newHeight, width: newWidth, height: newHeight });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [viewMode]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (viewMode !== "2D" || e.button !== 0) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragStartViewBox.current = { x: viewBox.x, y: viewBox.y };
    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
  };

  const handleGlobalMouseMove = (e: MouseEvent) => {
    if (!isDragging.current || !wrapperRef.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const rect = wrapperRef.current.getBoundingClientRect();
    const scaleX = viewBoxRef.current.width / rect.width;
    const scaleY = viewBoxRef.current.height / rect.height;
    setViewBox(prev => ({ ...prev, x: dragStartViewBox.current.x - dx * scaleX, y: dragStartViewBox.current.y - dy * scaleY }));
  };

  const handleGlobalMouseUp = () => {
    isDragging.current = false;
    window.removeEventListener('mousemove', handleGlobalMouseMove);
    window.removeEventListener('mouseup', handleGlobalMouseUp);
  };

  const resetView = () => {
    if (!wrapperRef.current) return;
    const { width, height } = wrapperRef.current.getBoundingClientRect();
    const newWidth = 200;
    const newHeight = newWidth * (height / width);
    setViewBox({ x: -newWidth / 2, y: -newHeight / 2, width: newWidth, height: newHeight });
  };

  const gridSize = Math.pow(10, Math.floor(Math.log10(Math.max(viewBox.width / 10, 1e-6))));

  return (
    <div className="layout-editor-container">
      {/* 1. LEFT PANEL: FOOTPRINT INSTANCES */}
      <div className="layout-sidebar-left">
        <h3>Footprints</h3>
        <div className="layout-list-placeholder">
          {/* List of placed footprints goes here */}
          <p className="empty-hint">No footprints placed.</p>
        </div>
      </div>

      {/* 2. CENTER PANEL: 2D/3D VISUALIZER */}
      <div className="layout-center">
        <div className="view-toggle-bar">
          <button className={`view-toggle-btn ${viewMode === "2D" ? "active" : ""}`} onClick={() => setViewMode("2D")}>2D Layout</button>
          <button className={`view-toggle-btn ${viewMode === "3D" ? "active" : ""}`} onClick={() => setViewMode("3D")}>3D Preview</button>
        </div>

        <div className="layout-canvas-wrapper" ref={wrapperRef}>
          <button className="canvas-home-btn" onClick={resetView} title="Reset View">🏠</button>
          
          {viewMode === "2D" ? (
            <svg className="layout-canvas" viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`} onMouseDown={handleMouseDown}>
              <defs>
                <pattern id="layout-grid" width={gridSize} height={gridSize} patternUnits="userSpaceOnUse">
                  <path d={`M ${gridSize} 0 L 0 0 0 ${gridSize}`} fill="none" stroke="#333" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                </pattern>
              </defs>
              <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#layout-grid)" />
              <line x1={viewBox.x} y1="0" x2={viewBox.x + viewBox.width} y2="0" stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <line x1="0" y1={viewBox.y} x2="0" y2={viewBox.y + viewBox.height} stroke="#444" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              
              {/* Footprint instances will be rendered here */}
            </svg>
          ) : (
            <div className="layout-3d-placeholder">
              <p>3D World Preview coming soon...</p>
            </div>
          )}
          <div className="canvas-hint">Grid: {parseFloat(gridSize.toPrecision(1))}mm | Scroll to Zoom | Drag to Pan</div>
        </div>
      </div>

      {/* 3. RIGHT PANEL: PROPERTIES */}
      <div className="layout-sidebar-right">
        <h3>Properties</h3>
        <div className="properties-placeholder">
          <p className="empty-hint">Select a footprint to edit.</p>
        </div>
      </div>
    </div>
  );
}