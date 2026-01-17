# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development (hot reload)
npm run tauri dev
# or
make dev

# Production build
npm run tauri build
# or
make

# Clean build artifacts
make clean

# Generate app icons
make icon
# or with custom source: make icon ICON_SOURCE=./my-logo.png
```

## Architecture Overview

ShortStack is a Tauri-based 2.5D CAD application for designing electro-mechanical assemblies, sandwich composites, and robot chassis. It uses a React frontend with Three.js for visualization and a Rust backend for geometry processing and file exports.

### Frontend (React/TypeScript)

**Main Entry**: `src/App.tsx` - Manages project state, file I/O, and tab navigation between editors

**Core Editors**:
- `StackupEditor` - Define material layers with thickness, color, and manufacturing type (Cut vs Carved/Printed)
- `FootprintLibrary` + `FootprintEditor` - Create/edit reusable component footprints
- `ParametersEditor` - Manage global parametric variables
- `FabricationEditor` - Configure export settings and fabrication plans

**3D Visualization**: `Footprint3DView.tsx` - Three.js renderer using react-three-fiber, communicates with `meshWorker.ts` via Web Workers for Manifold-3D boolean operations

**Type System**: `src/types.ts` - All core data types including:
- `Parameter` - Parametric variables with expressions
- `StackupLayer` - Material layer definitions
- `Footprint` - Reusable component with shapes and meshes
- `FootprintShape` - Union type for all shape primitives (circle, rect, line, polygon, boardOutline, wireGuide, union, text, splitLine)

**Expression Evaluation**: Uses `mathjs` for parametric expressions. Parameters can reference other parameters and all dimension fields accept expressions.

### Backend (Rust/Tauri)

**Location**: `src-tauri/src/`

**Key Modules**:
- `lib.rs` - Main Tauri commands, SVG/DXF export logic, shape-to-polygon conversion
- `geometry.rs` - Geometry types for optimization
- `optimizer.rs` - CMA-ES based split line optimization

**Tauri Commands**:
- `export_layer_files` - Generate SVG/DXF/STL exports
- `compute_smart_split` - Optimize split line placement
- `get_debug_eval` - Debug split evaluation

**Key Dependencies**:
- `csgrs` - CSG operations for 2D geometry
- `geo` - Geometric types and algorithms
- `cmaes` - Evolution strategy optimizer

### Data Flow

1. User edits are stored in React state (`params`, `stackup`, `footprints`, `meshAssets`)
2. Changes auto-save to JSON project files via Tauri filesystem plugin
3. 3D preview computed in Web Worker using Manifold-3D WASM
4. Exports processed in Rust backend (SVG depth maps, DXF profiles, STL passthrough)

### Project File Format

JSON structure with:
- `params`: Array of Parameter objects
- `stackup`: Array of StackupLayer objects
- `footprints`: Array of Footprint objects (one can be marked `isBoard: true`)
- `meshes`: Array of MeshAsset objects (base64 encoded STL/STEP/OBJ/GLB)
- `fabPlans`: Array of FabricationPlan objects

### Key Patterns

- Shape coordinates use expression strings, not raw numbers
- Recursive footprints: FootprintReference shapes can nest other footprints
- Board outlines defined as shapes within a footprint (not separate entity)
- Layer assignments map layer IDs to depth/endmill radius/fillet settings
- Wire guides provide snap points for routing paths between components
