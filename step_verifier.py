import sys
import os

# OCP is the package installed by 'pip install cadquery-ocp'
from OCP.STEPControl import STEPControl_Reader
# Added IFSelect_CountByItem to the imports
from OCP.IFSelect import (IFSelect_RetDone, IFSelect_RetError, 
                          IFSelect_RetFail, IFSelect_RetVoid,
                          IFSelect_CountByItem)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE

def analyze_shape_geometry(shape):
    """
    Performs a topological and geometric analysis of the loaded shape.
    """
    # Initialize the analyzer with the shape
    analyzer = BRepCheck_Analyzer(shape)
    
    if analyzer.IsValid():
        print("[Geometry] Shape Geometry is VALID.")
        return True
    
    print("[Geometry] Shape Geometry is INVALID. Analyzing details...")
    
    # Analyze Faces
    # We iterate through faces to see which specific ones are causing issues
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = exp.Current()
        if not analyzer.IsValid(face):
            # If a face is invalid, we flag it.
            print(f"  - Invalid Face detected.")
        exp.Next()

    # Analyze Edges
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        edge = exp.Current()
        if not analyzer.IsValid(edge):
            print(f"  - Invalid Edge detected.")
        exp.Next()
        
    return False

def verify_step_file(filename):
    if not os.path.exists(filename):
        print(f"Error: File '{filename}' not found.")
        return

    print(f"Verifying: {filename}")
    print("-" * 60)

    # 1. Initialize Reader
    reader = STEPControl_Reader()
    
    # 2. Read File (Syntax and Schema Check)
    # This parses the ASCII structure of the STEP file
    status = reader.ReadFile(filename)
    
    if status == IFSelect_RetDone:
        print("[Syntax] File read successfully.")
    elif status == IFSelect_RetError:
        print("[Syntax] Error: Syntax error in file (e.g., missing brackets, bad header).")
        return
    elif status == IFSelect_RetFail:
        print("[Syntax] Error: Failure reading file (logical error).")
        return
    elif status == IFSelect_RetVoid:
        print("[Syntax] Error: The file is empty or nothing was read.")
        return
    else:
        print(f"[Syntax] Unknown read status: {status}")
        return

    # 3. Check for specific syntax errors/warnings in the log
    num_fails = reader.NbRootsForTransfer()
    
    # PrintCheckLoad dumps the internal parser log to stdout
    # FIXED: Passed the actual Enum value IFSelect_CountByItem instead of integer 1
    reader.PrintCheckLoad(True, IFSelect_CountByItem)

    # 4. Transfer to Shape (Translation Check)
    # Converts abstract STEP entities into 3D Geometry
    reader.TransferRoots()
    
    shape = reader.OneShape()
    if shape.IsNull():
        print("[Translation] Error: Could not translate STEP entities into a Shape.")
        print("             This often indicates missing dependencies or unsupported entities.")
        return
    else:
        print("[Translation] STEP entities successfully translated to Shape.")

    # 5. Validate Geometry (BRep Check)
    # Checks for self-intersections, open shells (if solid), bad orientation, etc.
    analyze_shape_geometry(shape)
    
    print("-" * 60)

if __name__ == "__main__":
    verify_step_file("/Users/keenonwerling/Desktop/Sandwich_step.step")