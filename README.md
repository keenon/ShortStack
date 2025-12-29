# ShortStack CAD 🥞

**A specialized 2.5D CAD tool for designing electro-mechanical assemblies, sandwich composites, and robot chassis.**

## The Philosophy

ShortStack was born out of frustrations with general-purpose CAD when building robot and exoskeleton prototypes. It bridges the gap between PCB layout software and mechanical CAD.

1.  **Subtractive First:** For flat materials (carbon fiber, plywood, delrin, foam), laser and waterjet cutting are substantially faster than 3D printing. ShortStack is optimized for **2D and 2.5D** workflows.
2.  **Routing is not an Afterthought:** Most hardware failures stem from poor cable management. ShortStack treats wire routing and internal channels as first-class citizens.
3.  **"PCBA" for Mechanics:** Design your mechanics like a circuit board. Create **Footprints** for components (motors, servos), assign them to specific material layers, and arrange them on a global **Board Outline**.

## Key Features

-   **Layered Stackup Editor:** Define materials, thicknesses, and manufacturing types (Cut vs. Carved/Printed). Visualize complex sandwich panels (e.g., Carbon-Foam-Carbon).
-   **Parametric Math Engine:** Don't just type numbers. Use variables and math expressions (e.g., `width / 2 + clearance`) driven by `mathjs`.
-   **Recursive Footprints:** Build complex assemblies by nesting footprints inside other footprints.
-   **Wire Guides:** Define virtual "snap" points and channels to ensure your wiring pathways are mathematically perfect.
-   **Real-time 3D Preview:** Powered by **Manifold-3D** and **Three.js**, get instant feedback on boolean operations, ball-nose endmill fillets, and layer alignments.
-   **Production Ready Exports:**
    -   **DXF / SVG:** For laser cutters, waterjets, and CNC routers.
    -   **STL:** For 3D printing cores or visualization in other CAD suites.

## Installation

### Users
Download the latest installer for macOS, Windows, or Linux from the [Releases Page](../../releases).

*Note: The app supports auto-updates, so you will be notified when a new version is available.*

### Developers

ShortStack is built with [Tauri](https://tauri.app/), [React](https://reactjs.org/), and [Rust](https://www.rust-lang.org/).

**Prerequisites:**
-   Node.js (v18+)
-   Rust (stable)
-   OS-specific build tools (Xcode for Mac, Visual Studio C++ build tools for Windows, etc.)

**Setup:**

```bash
# Install dependencies
npm install

# Run in development mode (Hot Reloading)
npm run tauri dev
# OR
make dev
```

**Building for Production:**

```bash
# Build a local installer
npm run tauri build
# OR
make
```

## Workflow Guide

### 1. The Stackup
Define your material layers. 
- **Cut:** Goes all the way through (e.g., Carbon Fiber skins).
- **Carve:** Partial depth operations (e.g., routing channels in a Foam core).
- **Color:** Assign colors to visualize layers easily.

### 2. Parameters
Set global variables (e.g., `MotorDia = 28mm`, `WireWidth = 5mm`). Use these in any input field to keep your design parametric.

### 3. Footprint Library
Create reusable components.
- Shapes: Circles, Rectangles (rounded), Lines (paths).
- **Assigned Layers:** Map shapes to specific stackup layers (e.g., "Cut this circle only on the Top Carbon layer").
- **Depth & Radius:** For carved layers, specify cut depth and endmill radius for accurate 3D preview generation.

### 4. Layout & Export
Arrange your footprints within the Board Outline.
- Use **Wire Guides** to snap path lines between components.
- Toggle the **3D View** to check for collisions or routing errors.
- Click **Export** on specific layers to generate manufacturing files.

## Project Structure

- `src/`: React Frontend (UI, Editors, Three.js Rendering).
  - `components/Footprint3DView.tsx`: Manifold-3D implementation for boolean geometry.
  - `components/ExpressionEditor.tsx`: Math evaluation logic.
- `src-tauri/`: Rust Backend.
  - `lib.rs`: Handles file I/O and geometry processing (geo-types, svg, dxf generation).

## License

[MIT](LICENSE)