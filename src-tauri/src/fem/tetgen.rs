use std::os::raw::{c_double, c_int, c_char};
use serde::Serialize;
use super::mesh_utils::weld_mesh;
use std::ffi::CString;
use std::process::{Command, Stdio};
use std::fs::File;
use std::io::{Write, Read};

#[derive(Serialize, Clone)]
pub struct TetrahedralizedMesh {
    pub vertices: Vec<[f64; 3]>, // 3D points
    pub indices: Vec<usize>,     // Flattened tet indices
    pub surface_indices: Vec<usize>, // Flattened surface triangle indices
}

// MATCHING C++ LAYOUT: Pointers first!
#[repr(C)]
struct MeshResult {
    points: *mut c_double,      // 8 bytes
    tetrahedra: *mut c_int,     // 8 bytes
    num_points: c_int,          // 4 bytes
    num_tetrahedra: c_int,      // 4 bytes
}

unsafe extern "C" {
    fn tetrahedralize_mesh(
        in_vertices: *const c_double, 
        num_vertices: c_int, 
        in_faces: *const c_int, 
        num_faces: c_int,
        options: *const c_char // Match the char* options
    ) -> *mut MeshResult;

    fn free_mesh_result(result: *mut MeshResult);
}

#[derive(Serialize)]
pub struct SurfaceMesh {
    pub vertices: Vec<f64>,
}

fn write_stl_ascii(path: &str, verts: &[f64]) -> Result<(), String> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    writeln!(file, "solid gmsh_tmp").map_err(|e| e.to_string())?;
    
    // We assume simple triangle soup input (every 3 vertices = 1 face)
    for chunk in verts.chunks(9) {
        if chunk.len() < 9 { break; }
        // Normal (dummy)
        writeln!(file, "facet normal 0 0 0").map_err(|e| e.to_string())?;
        writeln!(file, "  outer loop").map_err(|e| e.to_string())?;
        writeln!(file, "    vertex {:.6} {:.6} {:.6}", chunk[0], chunk[1], chunk[2]).map_err(|e| e.to_string())?;
        writeln!(file, "    vertex {:.6} {:.6} {:.6}", chunk[3], chunk[4], chunk[5]).map_err(|e| e.to_string())?;
        writeln!(file, "    vertex {:.6} {:.6} {:.6}", chunk[6], chunk[7], chunk[8]).map_err(|e| e.to_string())?;
        writeln!(file, "  endloop").map_err(|e| e.to_string())?;
        writeln!(file, "endfacet").map_err(|e| e.to_string())?;
    }
    writeln!(file, "endsolid gmsh_tmp").map_err(|e| e.to_string())?;
    Ok(())
}

fn read_stl_ascii(path: &str) -> Result<Vec<f64>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;

    let mut vertices = Vec::new();
    
    // Very naive ASCII STL parser for Gmsh output
    for line in content.lines() {
        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.len() == 4 && parts[0] == "vertex" {
            if let (Ok(x), Ok(y), Ok(z)) = (parts[1].parse::<f64>(), parts[2].parse::<f64>(), parts[3].parse::<f64>()) {
                vertices.push(x);
                vertices.push(y);
                vertices.push(z);
            }
        }
    }
    Ok(vertices)
}

#[tauri::command]
pub async fn cmd_repair_mesh(vertices: Vec<f64>, target_len: f64) -> Result<SurfaceMesh, String> {
    let in_file = "temp_input.stl";
    let out_file = "temp_output.stl";
    let geo_file = "temp_repair.geo";
    
    // 1. Write Input STL
    write_stl_ascii(in_file, &vertices)?;

    // 2. Write Geo Script
    // Based on "Automated Computational Geometry Pipelines" best practices
    let mut geo_content = String::new();
    
    geo_content.push_str("General.NumThreads = 0; // Use all cores\\n");
    geo_content.push_str("General.Verbosity = 5;  // Info level\\n");
    geo_content.push_str("General.Terminal = 1;   // Force terminal output\\n");
    
    // --- INPUT & CLASSIFICATION ---
    geo_content.push_str(&format!("Merge \"{}\";\\n", in_file));
    
    // ClassifySurfaces{angle, includeBoundary, forReparametrization, curveAngle}
    // 40 degrees separates features well. 
    // forReparametrization=1 is CRITICAL: it converts discrete triangles into parametrizable patches.
    geo_content.push_str("ClassifySurfaces{40 * Pi/180, 1, 1, 180 * Pi/180};\\n");
    geo_content.push_str("CreateGeometry;\\n");
    
    // --- TOPOLOGY DEFINITION (Good Practice) ---
    // Gather all surfaces into a loop. This helps Gmsh understand the scope.
    geo_content.push_str("Surface Loop(1) = Surface{:};\\n");
    
    // --- MESHING CONFIG ---
    // Algorithm 6 (Frontal-Delaunay 2D) is best for high quality surface remeshing.
    geo_content.push_str("Mesh.Algorithm = 6;\\n");
    geo_content.push_str("Mesh.Optimize = 1;\\n");
    
    // --- NORMALIZATION SETTINGS ---
    // Force Gmsh to ignore the input mesh density (MeshSizeFromPoints=0).
    // This is what actually "cleans" the mesh topology.
    geo_content.push_str("Mesh.MeshSizeFromPoints = 0;\\n");
    geo_content.push_str("Mesh.MeshSizeExtendFromBoundary = 0;\\n");
    geo_content.push_str("Mesh.MeshSizeFromCurvature = 0;\\n");
    
    if target_len > 0.0 {
        geo_content.push_str(&format!("Mesh.MeshSizeMax = {};\\n", target_len));
        geo_content.push_str(&format!("Mesh.MeshSizeMin = {};\\n", target_len * 0.1));
    } else {
        // Fallback if no length specified: use a heuristic or let Gmsh calculate based on bbox
        // For now, we rely on defaults if 0, but usually 0 implies "don't care", 
        // yet MeshSizeFromPoints=0 requires SOME constraint. 
        // We'll leave it to Gmsh's internal characteristic length calculation if target_len is 0.
    }

    // Generate 2D Surface Mesh
    geo_content.push_str("Mesh 2;\\n");
    geo_content.push_str(&format!("Save \"{}\";\\n", out_file));
    geo_content.push_str("Exit;\\n");

    {
        let mut f = File::create(geo_file).map_err(|e| e.to_string())?;
        f.write_all(geo_content.as_bytes()).map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
    }

    println!("Running Gmsh repair (headless) on {} vertices...", vertices.len() / 3);

    // 3. Run Gmsh
    // ADDED: -nopopup flag to prevent GUI
    let status = Command::new("./gmsh")
        .arg(geo_file)
        .arg("-nopopup") // <-- FIX: Headless mode
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|e| format!("Failed to execute gmsh: {}", e))?;

    if !status.success() {
        return Err("Gmsh process exited with error code. See console for details.".into());
    }

    // 4. Read Result
    if !std::path::Path::new(out_file).exists() {
        return Err("Gmsh failed to generate output file.".into());
    }

    let new_verts = read_stl_ascii(out_file)?;

    // Cleanup
    let _ = std::fs::remove_file(in_file);
    let _ = std::fs::remove_file(out_file);
    let _ = std::fs::remove_file(geo_file);

    println!("Gmsh repair complete. New vertex count: {}", new_verts.len() / 3);

    Ok(SurfaceMesh { vertices: new_verts })
}

#[tauri::command]
pub async fn cmd_tetrahedralize(vertices: Vec<f64>, options: String, target_len: Option<f64>) -> Result<TetrahedralizedMesh, String> {
    
    // 1. Manually spawn a thread with LARGE STACK SIZE (8MB)
    let builder = std::thread::Builder::new()
        .name("tetgen-worker".into())
        .stack_size(8 * 1024 * 1024);

    let handle = builder.spawn(move || {
        // --- STEP 1: Initial Weld ---
        // Converts triangle soup to a connected mesh
        // ADAPTIVE WELD: Use 1% of target length to snap seams, or default to 0.01mm
        let weld_epsilon = target_len.map(|l| l * 0.01).unwrap_or(1e-2); 
        let (mut verts, mut faces) = weld_mesh(&vertices, weld_epsilon);

        // --- STEP 2: Regularization (Optional) ---
        if let Some(len) = target_len {
            if len > 0.0 {
                // Convert i32 faces to usize for the regularizer
                let faces_usize: Vec<usize> = faces.iter().map(|&x| x as usize).collect();
                
                // Run Decimation/Subdivision
                let (reg_verts, reg_faces) = crate::fem::regularizer::regularize(&verts, &faces_usize, len);
                
                // Update buffers
                verts = reg_verts;
                faces = reg_faces.iter().map(|&x| x as i32).collect();
            }
        }

        let num_verts = (verts.len() / 3) as i32;
        let num_faces = (faces.len() / 3) as i32;
        
        let c_options = CString::new(options).map_err(|_| "Invalid options string")?;

        unsafe {
            // --- STEP 3: C++ Call ---
            let result_ptr = tetrahedralize_mesh(
                verts.as_ptr(), 
                num_verts, 
                faces.as_ptr(), 
                num_faces,
                c_options.as_ptr()
            );

            if result_ptr.is_null() {
                return Err("TetGen returned null.".into());
            }

            let res = &*result_ptr;
            if res.num_tetrahedra == 0 {
                free_mesh_result(result_ptr);
                return Err("TetGen failed to generate elements.".into());
            }
            
            // Safety Check for "Mesh Explosion"
            if res.num_tetrahedra > 3_000_000 {
                 free_mesh_result(result_ptr);
                 return Err(format!("Mesh Explosion: Generated {} tetrahedra. Try increasing Max Edge Length.", res.num_tetrahedra));
            }

            // --- STEP 4: Copy Results ---
            let point_slice = std::slice::from_raw_parts(res.points, (res.num_points * 3) as usize);
            let out_vertices: Vec<[f64; 3]> = point_slice
                .chunks_exact(3)
                .map(|c| [c[0], c[1], c[2]])
                .collect();

            let tet_slice = std::slice::from_raw_parts(res.tetrahedra, (res.num_tetrahedra * 4) as usize);
            let out_indices: Vec<usize> = tet_slice.iter().map(|&x| x as usize).collect();
            
            // --- STEP 5: Extract Surface ---
            let surface_indices = crate::fem::mesh_utils::extract_surface(&out_indices);
            
            // --- STEP 6: Free Memory ---
            free_mesh_result(result_ptr);

            Ok(TetrahedralizedMesh {
                vertices: out_vertices,
                indices: out_indices,
                surface_indices,
            })
        }
    }).map_err(|e| e.to_string())?;

    handle.join().map_err(|_| "Thread panicked".to_string())?
}