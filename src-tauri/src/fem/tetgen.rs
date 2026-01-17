use std::os::raw::{c_double, c_int};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct TetrahedralizedMesh {
    pub vertices: Vec<[f64; 3]>, // 3D points
    pub indices: Vec<usize>,     // Flattened tet indices
}

// 1. Define the Struct exactly as it is in C++
#[repr(C)]
struct MeshResult {
    points: *mut c_double,
    num_points: c_int,
    tetrahedra: *mut c_int,
    num_tetrahedra: c_int,
}

// 2. Define the External C functions
unsafe extern "C" {
    unsafe fn tetrahedralize_mesh(
        in_vertices: *const c_double, 
        num_vertices: c_int, 
        in_faces: *const c_int, 
        num_faces: c_int
    ) -> *mut MeshResult; // Returns a pointer to the struct

    unsafe fn free_mesh_result(result: *mut MeshResult);
}

#[tauri::command]
pub async fn cmd_tetrahedralize(vertices: Vec<f64>, faces: Vec<i32>) -> Result<TetrahedralizedMesh, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let num_verts = (vertices.len() / 3) as i32;
        let num_faces = (faces.len() / 3) as i32;

        // ... Existing unsafe logic ...
        unsafe {
            // 1. Call C++
            let result_ptr = tetrahedralize_mesh(
                vertices.as_ptr(), 
                num_verts, 
                faces.as_ptr(), 
                num_faces
            );

            if result_ptr.is_null() {
                return Err("TetGen returned a null pointer.".into());
            }

            let res = &*result_ptr;

            if res.num_tetrahedra == 0 {
                free_mesh_result(result_ptr);
                return Err("TetGen failed to generate elements.".into());
            }

            // 2. Copy Vertices
            let point_slice = std::slice::from_raw_parts(res.points, (res.num_points * 3) as usize);
            let out_vertices: Vec<[f64; 3]> = point_slice
                .chunks_exact(3)
                .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                .collect();

            // 3. Copy Indices
            let tet_slice = std::slice::from_raw_parts(res.tetrahedra, (res.num_tetrahedra * 4) as usize);
            let out_indices: Vec<usize> = tet_slice.iter().map(|&x| x as usize).collect();

            // 4. Free
            free_mesh_result(result_ptr);

            Ok(TetrahedralizedMesh {
                vertices: out_vertices,
                indices: out_indices,
            })
        }
    })
    .await
    .map_err(|e| e.to_string())? // Handle JoinError
}
