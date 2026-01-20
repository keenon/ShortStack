use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use nalgebra::{Vector3, Matrix3, SVector};
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
            // We use the 4 corner nodes of the 10-node tet (indices 0,1,2,3) for linear approximation volume
            // or we could use higher order integration, but linear is usually sufficient for general metrics.
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
            // The 4 faces of a tet defined by corners: (0,2,1), (0,1,3), (1,2,3), (2,0,3)
            // We sort indices to identify unique faces regardless of winding
            let faces = [
                [element_indices[0], element_indices[2], element_indices[1]],
                [element_indices[0], element_indices[1], element_indices[3]],
                [element_indices[1], element_indices[2], element_indices[3]],
                [element_indices[2], element_indices[0], element_indices[3]],
            ];

            for f in faces {
                let mut key = f;
                key.sort_unstable(); // Sort to make key unique
                *face_counts.entry(key).or_insert(0) += 1;
            }
        }

        let mut total_surface_area = 0.0;

        for (face_indices, count) in face_counts {
            // A count of 1 means the face is on the boundary (shared by only 1 tet)
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

        // Check Jacobian at the 4 corner nodes (standard quality check)
        // Reference corners in Barycentric coords (L1, L2, L3, L4)
        let corners = [
            [1.0, 0.0, 0.0, 0.0], // Node 0
            [0.0, 1.0, 0.0, 0.0], // Node 1
            [0.0, 0.0, 1.0, 0.0], // Node 2
            [0.0, 0.0, 0.0, 1.0], // Node 3
        ];

        for (elem_idx, element_indices) in self.indices.iter().enumerate() {
            // Gather node coordinates
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

            // A negative or near-zero Jacobian indicates a distorted or inverted element
            if min_det_j < threshold {
                bad_elements.push(elem_idx);
            }
        }

        bad_elements
    }
}

// --- Inverse Mapping Implementation ---

impl Tet10 {
    /// Maps a point in World Space (x,y,z) to Reference Space (r,s,t) / (L1..L4)
    /// Uses Newton-Raphson iteration.
    /// Returns None if the point is outside the element or convergence fails.
    pub fn world_to_reference(
        target: Vector3<f64>, 
        node_coords: &[Vector3<f64>; 10]
    ) -> Option<[f64; 4]> {
        // Initial Guess: Centroid
        let mut xi = Vector3::new(0.25, 0.25, 0.25);
        
        let max_iter = 10;
        let tol = 1e-6;
        let range_tol = 1e-3; // Tolerance for being "slightly" outside

        for _ in 0..max_iter {
            // 1. Calculate current L coords based on current xi (r,s,t)
            // L1 = 1 - r - s - t, L2=r, L3=s, L4=t
            let l = [1.0 - xi.x - xi.y - xi.z, xi.x, xi.y, xi.z];
            
            // 2. Evaluate Position
            let n = Tet10::shape_functions(&l);
            let mut curr_pos = Vector3::zeros();
            for i in 0..10 {
                curr_pos += node_coords[i] * n[i];
            }

            // 3. Check Convergence
            let residual = curr_pos - target;
            if residual.norm() < tol {
                // Converged! 
                // CRITICAL FIX: We must now check if these coordinates 
                // are physically inside the tetrahedron.
                let inside = l.iter().all(|&v| v >= -range_tol && v <= 1.0 + range_tol);
                
                return if inside {
                    Some(l)
                } else {
                    None // Mathematically valid, but physically outside
                };
            }

            // 4. Update via Jacobian
            let local_derivs = Tet10::shape_function_derivatives(&l);
            let j = Tet10::jacobian(node_coords, &local_derivs);

            if let Some(j_inv) = j.try_inverse() {
                let delta = -j_inv * residual;
                xi += delta;
            } else {
                return None; // Singular Jacobian
            }
        }

        None // Did not converge within max_iter
    }
}