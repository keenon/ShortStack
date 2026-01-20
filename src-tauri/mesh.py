import gmsh
import math
import sys

gmsh.initialize()
if '-nopopup' in sys.argv:
    gmsh.option.setNumber("General.Terminal", 1)

try:
    # 0. DEBUGGING: Turn on Verbosity
    # If it hangs again, this will tell you exactly which Surface # is guilty.
    gmsh.option.setNumber("General.Verbosity", 5)

    # 1. Merge Manifold STL
    filename = "square1.stl" 
    gmsh.merge(filename)
    try:
        # "PhysicalGroup" = 0 means process the entire model
        gmsh.plugin.setNumber("Orientation", "PhysicalGroup", 0)
        # "iView" = -1 means process the current active view/model
        gmsh.plugin.setNumber("Orientation", "iView", -1)
        gmsh.plugin.run("Orientation")
        print("Mesh orientation normalized.")
    except Exception as e:
        print(f"Warning: Orientation plugin failed: {e}")

    # 2. Classify (Standard CAD settings)
    angle = 40 
    includeBoundary = True 
    forceParametrizablePatches = False
    curveAngle = 180 
    gmsh.model.mesh.classifySurfaces(angle * math.pi / 180., 
                                     includeBoundary, 
                                     forceParametrizablePatches, 
                                     curveAngle * math.pi / 180.)

    # 3. Create Geometry
    gmsh.model.mesh.createGeometry()

    # 4. ROBUST MESHING OPTIONS
    
    # --- FIX 1: The Algorithm Switch ---
    # Algo 6 (Frontal) hangs on bad patches. 
    # Algo 1 (MeshAdapt) is robust against discrete surface errors.
    gmsh.option.setNumber("Mesh.Algorithm", 1) 
    
    # Algo 10 (HXT) for 3D is still the best choice.
    gmsh.option.setNumber("Mesh.Algorithm3D", 10)

    # --- FIX 2: The Safety Clamp ---
    # If your STL has a tiny "noise spike," curvature sizing might ask for
    # a 0.000001 sized element, causing an infinite refinement loop.
    # Set Min to a reasonable lower bound for your physics (e.g., 1/100th of part size).
    gmsh.option.setNumber("Mesh.MeshSizeMin", 0.05) 
    gmsh.option.setNumber("Mesh.MeshSizeMax", 2.0)
    
    # Keep curvature on, but moderate it
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 20)

    # --- Optimization ---
    # Since we switched to Algo 1, we rely on Netgen to clean up the quality.
    gmsh.option.setNumber("Mesh.Optimize", 1) 
    gmsh.option.setNumber("Mesh.OptimizeNetgen", 1)

    # 5. Generate
    print("Starting 2D Meshing (Algorithm: MeshAdapt)...")
    gmsh.model.mesh.generate(2)
    
    print("Starting 3D Meshing (Algorithm: HXT)...")
    surfaces = gmsh.model.getEntities(2)
    surface_tags = [s[1] for s in surfaces]
    
    l = gmsh.model.geo.addSurfaceLoop(surface_tags)
    gmsh.model.geo.addVolume([l])
    gmsh.model.geo.synchronize()
    
    gmsh.model.mesh.generate(3)

    gmsh.write("fea_ready_robust.msh")
    print("Done.")

except Exception as e:
    print(f"Error: {e}")

gmsh.finalize()