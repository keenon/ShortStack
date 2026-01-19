use std::os::raw::{c_double, c_int, c_char};
use serde::Serialize;
use super::mesh_utils::weld_mesh;
use std::ffi::CString;

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

#[tauri::command]
pub async fn cmd_tetrahedralize(vertices: Vec<f64>, options: String, target_len: Option<f64>) -> Result<TetrahedralizedMesh, String> {
    
    // 1. Manually spawn a thread with LARGE STACK SIZE (8MB)
    let builder = std::thread::Builder::new()
        .name("tetgen-worker".into())
        .stack_size(8 * 1024 * 1024);

    let handle = builder.spawn(move || {
        // --- STEP 1: Initial Weld ---
        // Converts triangle soup to a connected mesh
        let (mut verts, mut faces) = weld_mesh(&vertices, 1e-5);

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