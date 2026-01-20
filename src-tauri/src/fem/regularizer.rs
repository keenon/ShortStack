use std::collections::HashMap;
use nalgebra::Vector3;
use meshopt::{VertexDataAdapter, SimplifyOptions};

pub fn regularize(
    vertices: &[f64], 
    indices: &[usize], 
    target_edge_len: f64
) -> (Vec<f64>, Vec<usize>) {
    
    // 1. Convert to Vector3 for math operations
    let mut verts: Vec<Vector3<f64>> = vertices
        .chunks_exact(3)
        .map(|c| Vector3::new(c[0], c[1], c[2]))
        .collect();
    let mut tris = indices.to_vec();

    // 2. Statistics
    let surface_area = calculate_surface_area(&verts, &tris);
    
    // Equilateral triangle area = 0.433 * L^2
    let ideal_tri_area = 0.433 * target_edge_len * target_edge_len;
    let target_tri_count = (surface_area / ideal_tri_area) as usize;
    let current_tri_count = tris.len() / 3;

    println!("Regularizer: Current Tris: {}, Target: {}", current_tri_count, target_tri_count);

    // 3. DECIMATE (Simplify) if too dense
    if current_tri_count > target_tri_count {
        println!("Regularizer: Decimating...");
        let (d_verts, d_tris) = decimate_mesh(&verts, &tris, target_tri_count, target_edge_len * 0.25);
        verts = d_verts;
        tris = d_tris;
    }

    // 4. SUBDIVIDE if too sparse
    let max_len_sq = (target_edge_len * 1.5).powi(2);
    let max_iters = 3;
    
    for i in 0..max_iters {
        let (new_verts, new_tris, split_count) = subdivide_long_edges(&verts, &tris, max_len_sq);
        verts = new_verts;
        tris = new_tris;
        if split_count == 0 { break; }
        println!("Regularizer: Subdivision Pass {} - Split {} edges", i+1, split_count);
    }

    // 5. Prune Degenerates & Duplicates (Fixes "self-intersecting facets" errors)
    let (p_verts, p_tris) = prune_mesh(&verts, &tris);
    
    // 6. Flatten
    let flat_verts: Vec<f64> = p_verts.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
    
    (flat_verts, p_tris)
}

fn calculate_surface_area(verts: &[Vector3<f64>], indices: &[usize]) -> f64 {
    let mut area = 0.0;
    for tri in indices.chunks_exact(3) {
        let v0 = verts[tri[0]];
        let v1 = verts[tri[1]];
        let v2 = verts[tri[2]];
        area += ((v1 - v0).cross(&(v2 - v0))).norm() * 0.5;
    }
    area
}

fn decimate_mesh(verts: &[Vector3<f64>], indices: &[usize], target_count: usize, target_error: f64) -> (Vec<Vector3<f64>>, Vec<usize>) {
    // meshopt expects f32, so we convert f64 -> f32
    let verts_f32: Vec<f32> = verts.iter().flat_map(|v| [v.x as f32, v.y as f32, v.z as f32]).collect();
    let indices_u32: Vec<u32> = indices.iter().map(|&i| i as u32).collect();

    let target_index_count = target_count * 3;
    
    // --- MESHOPT FIX ---
    // Cast f32 slice to u8 slice safely
    let vertex_data = bytemuck::cast_slice(&verts_f32);
    // Stride is 12 bytes (3 * f32)
    let adapter = VertexDataAdapter::new(vertex_data, 12, 0).expect("Failed to create vertex adapter");

    let simplified_indices = meshopt::simplify(
        &indices_u32, 
        &adapter, 
        target_index_count, 
        target_error as f32,
        SimplifyOptions::Regularize,
        None
    );
    // -------------------

    // Rebuild compact mesh
    let mut unique_map: HashMap<u32, usize> = HashMap::new();
    let mut new_verts = Vec::new();
    let mut new_indices = Vec::new();

    for &old_idx in &simplified_indices {
        let new_idx = *unique_map.entry(old_idx).or_insert_with(|| {
            let idx = new_verts.len();
            new_verts.push(verts[old_idx as usize]);
            idx
        });
        new_indices.push(new_idx);
    }

    (new_verts, new_indices)
}

fn subdivide_long_edges(
    verts: &[Vector3<f64>], 
    indices: &[usize], 
    max_len_sq: f64
) -> (Vec<Vector3<f64>>, Vec<usize>, usize) {
    let mut new_verts = verts.to_vec();
    let mut new_indices = Vec::with_capacity(indices.len());
    let mut edge_split_map: HashMap<(usize, usize), usize> = HashMap::new();

    // 1. Identify splits
    for tri in indices.chunks_exact(3) {
        let edges = [(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])];
        for (a, b) in edges {
            let key = if a < b { (a, b) } else { (b, a) };
            if !edge_split_map.contains_key(&key) {
                // Use squared distance check for perf
                let dist_sq = (verts[a] - verts[b]).norm_squared();
                if dist_sq > max_len_sq {
                    let mid = (verts[a] + verts[b]) * 0.5;
                    let idx = new_verts.len();
                    new_verts.push(mid);
                    edge_split_map.insert(key, idx);
                }
            }
        }
    }

    let split_count = edge_split_map.len();
    if split_count == 0 {
        return (new_verts, indices.to_vec(), 0);
    }

    // 2. Re-triangulate
    for tri in indices.chunks_exact(3) {
        let (v0, v1, v2) = (tri[0], tri[1], tri[2]);
        
        let get_mid = |a, b| -> Option<usize> {
            let key = if a < b { (a, b) } else { (b, a) };
            edge_split_map.get(&key).copied()
        };

        let m01 = get_mid(v0, v1);
        let m12 = get_mid(v1, v2);
        let m20 = get_mid(v2, v0);

        match (m01, m12, m20) {
            (None, None, None) => {
                new_indices.extend_from_slice(&[v0, v1, v2]);
            },
            (Some(m), None, None) => {
                new_indices.extend_from_slice(&[v0, m, v2]);
                new_indices.extend_from_slice(&[m, v1, v2]);
            },
            (None, Some(m), None) => {
                new_indices.extend_from_slice(&[v1, m, v0]);
                new_indices.extend_from_slice(&[m, v2, v0]);
            },
            (None, None, Some(m)) => {
                new_indices.extend_from_slice(&[v2, m, v1]);
                new_indices.extend_from_slice(&[m, v0, v1]);
            },
            (Some(m1), Some(m2), Some(m3)) => {
                new_indices.extend_from_slice(&[v0, m1, m3]);
                new_indices.extend_from_slice(&[m1, v1, m2]);
                new_indices.extend_from_slice(&[m2, v2, m3]);
                new_indices.extend_from_slice(&[m1, m2, m3]);
            },
            (Some(m1), Some(m2), None) => {
                new_indices.extend_from_slice(&[v0, m1, v2]);
                new_indices.extend_from_slice(&[m1, m2, v2]);
                new_indices.extend_from_slice(&[m1, v1, m2]);
            },
            (None, Some(m2), Some(m3)) => {
                new_indices.extend_from_slice(&[v0, v1, m3]);
                new_indices.extend_from_slice(&[m3, v1, m2]);
                new_indices.extend_from_slice(&[m3, m2, v2]);
            },
            (Some(m1), None, Some(m3)) => {
                new_indices.extend_from_slice(&[v0, m1, m3]);
                new_indices.extend_from_slice(&[m3, m1, v1]);
                new_indices.extend_from_slice(&[m3, v1, v2]);
            }
        }
    }

    (new_verts, new_indices, split_count)
}



/// Removes zero-area triangles and duplicate faces
fn prune_mesh(verts: &[Vector3<f64>], indices: &[usize]) -> (Vec<Vector3<f64>>, Vec<usize>) {
    let mut unique_faces = std::collections::HashSet::new();
    let mut valid_indices = Vec::with_capacity(indices.len());
    
    for chunk in indices.chunks_exact(3) {
        let (idx0, idx1, idx2) = (chunk[0], chunk[1], chunk[2]);
        if idx0 == idx1 || idx1 == idx2 || idx2 == idx0 { continue; }

        let v0 = verts[idx0];
        let v1 = verts[idx1];
        let v2 = verts[idx2];
        
        // Area Check (Cross product magnitude)
        let area_sq = (v1 - v0).cross(&(v2 - v0)).norm_squared();
        if area_sq < 1e-12 { continue; } // Too small

        // Duplicate Check (Sorted Indices)
        let mut key = [idx0, idx1, idx2];
        key.sort_unstable();
        
        if unique_faces.insert(key) {
            valid_indices.push(idx0);
            valid_indices.push(idx1);
            valid_indices.push(idx2);
        }
    }

    // Re-compact vertices
    let mut unique_map: HashMap<usize, usize> = HashMap::new();
    let mut new_verts = Vec::new();
    let mut final_indices = Vec::with_capacity(valid_indices.len());

    for idx in valid_indices {
        let new_idx = *unique_map.entry(idx).or_insert_with(|| {
            let k = new_verts.len();
            new_verts.push(verts[idx]);
            k
        });
        final_indices.push(new_idx);
    }
    
    (new_verts, final_indices)
}
