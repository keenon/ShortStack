use std::collections::HashMap;

/// Quantizes float coordinates to merge vertices closer than epsilon.
pub fn weld_mesh(raw_vertices: &[f64], epsilon: f64) -> (Vec<f64>, Vec<i32>) {
    let mut unique_map: HashMap<(i64, i64, i64), i32> = HashMap::new();
    let mut welded_verts: Vec<f64> = Vec::new();
    let mut indices: Vec<i32> = Vec::with_capacity(raw_vertices.len() / 3);

    // Inverse epsilon for integer quantization
    let scale = 1.0 / epsilon;

    for chunk in raw_vertices.chunks(3) {
        if chunk.len() < 3 { break; } // Safety check
        let x = chunk[0];
        let y = chunk[1];
        let z = chunk[2];

        // Quantize to integer keys
        let key = (
            (x * scale).round() as i64,
            (y * scale).round() as i64,
            (z * scale).round() as i64
        );

        if let Some(&idx) = unique_map.get(&key) {
            indices.push(idx);
        } else {
            let new_idx = (welded_verts.len() / 3) as i32;
            unique_map.insert(key, new_idx);
            welded_verts.push(x);
            welded_verts.push(y);
            welded_verts.push(z);
            indices.push(new_idx);
        }
    }

    (welded_verts, indices)
}

/// Extracts the boundary triangles (faces shared by only 1 tetrahedron).
/// Returns a flat list of indices representing triangles [v0, v1, v2, v0, v1, v2...]
pub fn extract_surface(indices: &[usize]) -> Vec<usize> {
    // Key: Sorted Face Indices [A, B, C]
    // Value: Count
    let mut face_counts: HashMap<[usize; 3], usize> = HashMap::new();

    // Iterate over every tetrahedron (chunks of 4)
    for tet in indices.chunks_exact(4) {
        let (n0, n1, n2, n3) = (tet[0], tet[1], tet[2], tet[3]);

        // The 4 faces of a tet
        let faces = [
            [n0, n2, n1], // Note: Winding order might need adjustment depending on renderer, 
            [n0, n1, n3], // but for counting, sorting handles it.
            [n1, n2, n3],
            [n2, n0, n3],
        ];

        for f in faces {
            // Sort to ensure [1, 2, 3] is same as [3, 1, 2] for identification
            let mut key = f;
            key.sort_unstable();
            
            *face_counts.entry(key).or_insert(0) += 1;
        }
    }

    // Collect faces that appear exactly once
    let mut surface_indices = Vec::new();

    // We need to recover the original winding or just use the sorted key.
    // For visual debugging, the sorted key might result in flipped normals 50% of the time.
    // A robust implementation tracks the original face winding.
    // However, for a quick visualization fix, we'll re-iterate the tets.
    
    // Pass 2: Re-scan to keep valid winding order
    let mut final_counts: HashMap<[usize; 3], usize> = HashMap::new();
    
    // We already know which keys are boundary, but we want the winding from the Tet.
    // Actually, simply checking the map is faster.
    
    for tet in indices.chunks_exact(4) {
        let (n0, n1, n2, n3) = (tet[0], tet[1], tet[2], tet[3]);

        let raw_faces = [
            vec![n0, n1, n2], // Was n0, n2, n1
            vec![n0, n3, n1], // Was n0, n1, n3
            vec![n1, n3, n2], // Was n1, n2, n3
            vec![n2, n3, n0], // Was n2, n0, n3
        ];

        for f in raw_faces {
            let mut key = [f[0], f[1], f[2]];
            key.sort_unstable();
            
            // If count is 1, it's a boundary face
            if let Some(&count) = face_counts.get(&key) {
                if count == 1 {
                    surface_indices.extend_from_slice(&f);
                    // Remove from map so we don't add it twice (though count==1 implies unique ownership)
                    // But strictly, a face belongs to only one tet if count==1, so we are good.
                }
            }
        }
    }

    surface_indices
}