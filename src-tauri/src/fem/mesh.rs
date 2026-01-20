
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use nalgebra::{Vector3};
use super::tet10::Tet10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TetMesh {
    pub vertices: Vec<[f64; 3]>,
    pub indices: Vec<[usize; 10]>, // 10-node connectivity
}

impl TetMesh {
    pub fn new(vertices: Vec<[f64; 3]>, indices: Vec<[usize; 10]>) -> Self {
        Self { vertices, indices }
    }

    /// Computes total Volume and Surface Area (of boundary faces)
    pub fn compute_metrics(&self) -> (f64, f64) {
        let mut total_volume = 0.0;
        let mut face_counts: HashMap<[usize; 3], usize> = HashMap::new();

        for element_indices in &self.indices {
            // 1. Calculate Volume
            // Use 4 corners of the tet: indices 0, 1, 2, 3
            if element_indices.len() < 4 { continue; }
            
            let p0 = Vector3::from(self.vertices[element_indices[0]]);
            let p1 = Vector3::from(self.vertices[element_indices[1]]);
            let p2 = Vector3::from(self.vertices[element_indices[2]]);
            let p3 = Vector3::from(self.vertices[element_indices[3]]);

            let v1 = p1 - p0;
            let v2 = p2 - p0;
            let v3 = p3 - p0;

            // Volume = 1/6 * |(p1-p0) . ((p2-p0) x (p3-p0))|
            total_volume += (v1.dot(&v2.cross(&v3))).abs() / 6.0;

            // 2. Tally Faces for Surface Area
            // Faces: (0,1,2), (0,3,1), (1,3,2), (2,3,0)
            let faces = [
                [element_indices[0], element_indices[1], element_indices[2]],
                [element_indices[0], element_indices[3], element_indices[1]],
                [element_indices[1], element_indices[3], element_indices[2]],
                [element_indices[2], element_indices[3], element_indices[0]],
            ];

            for f in faces {
                let mut key = f;
                key.sort_unstable(); // Sort to identify unique face
                *face_counts.entry(key).or_insert(0) += 1;
            }
        }

        let mut total_surface_area = 0.0;

        for (face_indices, count) in face_counts {
            // Boundary faces appear exactly once
            if count == 1 {
                let p0 = Vector3::from(self.vertices[face_indices[0]]);
                let p1 = Vector3::from(self.vertices[face_indices[1]]);
                let p2 = Vector3::from(self.vertices[face_indices[2]]);

                let v1 = p1 - p0;
                let v2 = p2 - p0;
                
                // Area = 0.5 * |cross_product|
                total_surface_area += 0.5 * v1.cross(&v2).norm();
            }
        }

        (total_volume, total_surface_area)
    }

    /// Checks the quality of all elements in the mesh.
    /// Returns a list of indices of "bad" elements (Jacobian < threshold).
    pub fn check_jacobian_quality(&self, threshold: f64) -> Vec<usize> {
        let mut bad_elements = Vec::new();

        // Barycentric coords for corners
        let corners = [
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];

        for (elem_idx, element_indices) in self.indices.iter().enumerate() {
            let mut nodes = [Vector3::zeros(); 10];
            for i in 0..10 {
                let v = self.vertices[element_indices[i]];
                nodes[i] = Vector3::new(v[0], v[1], v[2]);
            }

            let mut min_det_j = f64::MAX;

            for xi in &corners {
                let local_derivs = Tet10::shape_function_derivatives(xi);
                let j = Tet10::jacobian(&nodes, &local_derivs);
                let det = j.determinant();
                if det < min_det_j {
                    min_det_j = det;
                }
            }

            if min_det_j < threshold {
                bad_elements.push(elem_idx);
            }
        }

        bad_elements
    }

    /// Filters the mesh to keep only the Nth largest connected component.
    /// Returns true if successful, false if index out of bounds.
    pub fn filter_components(&mut self, rank: usize) -> bool {
        if self.indices.is_empty() { return false; }

        // 1. Build Adjacency Graph (Tet -> Neighbors)
        // Two tets are neighbors if they share a face (3 nodes)
        let mut face_to_elems: HashMap<[usize; 3], Vec<usize>> = HashMap::new();
        
        for (idx, nodes) in self.indices.iter().enumerate() {
            let faces = [
                [nodes[0], nodes[1], nodes[2]],
                [nodes[0], nodes[3], nodes[1]],
                [nodes[1], nodes[3], nodes[2]],
                [nodes[2], nodes[3], nodes[0]],
            ];
            for f in faces {
                let mut key = f;
                key.sort_unstable();
                face_to_elems.entry(key).or_default().push(idx);
            }
        }

        // Build Adjacency List
        let mut adj: Vec<Vec<usize>> = vec![vec![]; self.indices.len()];
        for elems in face_to_elems.values() {
            if elems.len() == 2 {
                adj[elems[0]].push(elems[1]);
                adj[elems[1]].push(elems[0]);
            }
        }

        // 2. Find Connected Components (BFS)
        let mut visited = HashSet::new();
        let mut components: Vec<Vec<usize>> = Vec::new();

        for i in 0..self.indices.len() {
            if !visited.contains(&i) {
                let mut component = Vec::new();
                let mut queue = VecDeque::new();
                queue.push_back(i);
                visited.insert(i);

                while let Some(curr) = queue.pop_front() {
                    component.push(curr);
                    for &neighbor in &adj[curr] {
                        if visited.insert(neighbor) {
                            queue.push_back(neighbor);
                        }
                    }
                }
                components.push(component);
            }
        }

        // 3. Calculate Volume for each component to sort them
        let mut comp_stats: Vec<(usize, f64)> = components.iter().enumerate().map(|(i, indices)| {
            let mut vol = 0.0;
            for &idx in indices {
                let el = &self.indices[idx];
                 let p0 = Vector3::from(self.vertices[el[0]]);
                 let p1 = Vector3::from(self.vertices[el[1]]);
                 let p2 = Vector3::from(self.vertices[el[2]]);
                 let p3 = Vector3::from(self.vertices[el[3]]);
                 vol += ((p1 - p0).dot(&(p2 - p0).cross(&(p3 - p0)))).abs() / 6.0;
            }
            (i, vol)
        }).collect();

        // Sort Descending by Volume
        comp_stats.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

        if rank >= comp_stats.len() {
            return false; 
        }

        // 4. Rebuild Mesh with only selected component
        let selected_comp_idx = comp_stats[rank].0;
        let selected_elem_indices = &components[selected_comp_idx];

        let mut new_indices = Vec::new();
        let mut new_vertices = Vec::new();
        let mut old_to_new_vert = HashMap::new();

        for &old_elem_idx in selected_elem_indices {
            let old_nodes = self.indices[old_elem_idx];
            let mut new_nodes = [0usize; 10];
            
            for (k, &old_v_idx) in old_nodes.iter().enumerate() {
                if let Some(&mapped) = old_to_new_vert.get(&old_v_idx) {
                    new_nodes[k] = mapped;
                } else {
                    let new_id = new_vertices.len();
                    new_vertices.push(self.vertices[old_v_idx]);
                    old_to_new_vert.insert(old_v_idx, new_id);
                    new_nodes[k] = new_id;
                }
            }
            new_indices.push(new_nodes);
        }

        self.vertices = new_vertices;
        self.indices = new_indices;
        true
    }
}
