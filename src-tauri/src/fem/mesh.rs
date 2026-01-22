
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet, VecDeque}, fs, io::{BufRead, BufReader}, path::PathBuf};
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

/// Temporary structure for 2D analysis pass
#[derive(Serialize, Clone, Debug)]
pub struct SimpleTriMesh {
    pub vertices: Vec<[f64; 3]>,
    pub indices: Vec<[usize; 3]>,
}

pub fn parse_2d_triangle_mesh(path: &PathBuf) -> Result<SimpleTriMesh, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    let mut node_map = HashMap::new();
    let mut section = "NONE";
    let mut nodes_in_block = 0;
    let mut node_tags_buffer = Vec::new();
    let mut elems_in_block = 0;
    let mut current_elem_type = 0;
    
    for line_res in reader.lines() {
        let line = line_res.map_err(|e| e.to_string())?;
        let trim = line.trim();
        if trim.is_empty() { continue; }
        if trim.starts_with("$") {
            if trim == "$Nodes" { section = "NODES_HEADER"; continue; }
            if trim == "$Elements" { section = "ELEMS_HEADER"; continue; }
            if !trim.starts_with("$End") { section = "SKIP"; }
            continue;
        }
        if section == "SKIP" { continue; }
        
        // Nodes
        if section == "NODES_HEADER" { section = "NODES_BLOCK_HEADER"; continue; }
        if section == "NODES_BLOCK_HEADER" {
            let parts: Vec<&str> = trim.split_whitespace().collect();
            if parts.len() >= 4 {
                nodes_in_block = parts[3].parse().unwrap_or(0);
                if nodes_in_block > 0 { section = "NODES_TAGS"; node_tags_buffer.clear(); }
            }
            continue;
        }
        if section == "NODES_TAGS" {
            let tag = trim.parse::<usize>().unwrap_or(0);
            node_tags_buffer.push(tag);
            if node_tags_buffer.len() == nodes_in_block { section = "NODES_COORDS"; }
            continue;
        }
        if section == "NODES_COORDS" {
            let coords: Vec<f64> = trim.split_whitespace().map(|s| s.parse().unwrap_or(0.0)).collect();
            if coords.len() >= 3 {
                let tag = node_tags_buffer[node_tags_buffer.len() - nodes_in_block];
                node_map.insert(tag, vertices.len());
                vertices.push([coords[0], coords[1], coords[2]]);
                nodes_in_block -= 1;
                if nodes_in_block == 0 { section = "NODES_BLOCK_HEADER"; }
            }
            continue;
        }
        
        // Elements
        if section == "ELEMS_HEADER" { section = "ELEMS_BLOCK_HEADER"; continue; }
        if section == "ELEMS_BLOCK_HEADER" {
            let parts: Vec<&str> = trim.split_whitespace().collect();
            if parts.len() >= 4 {
                current_elem_type = parts[2].parse().unwrap_or(0);
                elems_in_block = parts[3].parse().unwrap_or(0);
                section = "ELEMS_DATA";
            }
            continue;
        }
        if section == "ELEMS_DATA" {
            let e_parts: Vec<usize> = trim.split_whitespace().map(|s| s.parse().unwrap_or(0)).collect();
            let node_tags = if e_parts.len() > 1 { &e_parts[1..] } else { &[] };
            
            // Type 2 = 3-node Triangle
            if current_elem_type == 2 && node_tags.len() >= 3 {
                let n1 = *node_map.get(&node_tags[0]).unwrap_or(&0);
                let n2 = *node_map.get(&node_tags[1]).unwrap_or(&0);
                let n3 = *node_map.get(&node_tags[2]).unwrap_or(&0);
                indices.push([n1, n2, n3]);
            }
            // Type 9 = 6-node Triangle (Order 2). Nodes 0-2 are corners.
            else if current_elem_type == 9 && node_tags.len() >= 6 {
                let n1 = *node_map.get(&node_tags[0]).unwrap_or(&0);
                let n2 = *node_map.get(&node_tags[1]).unwrap_or(&0);
                let n3 = *node_map.get(&node_tags[2]).unwrap_or(&0);
                indices.push([n1, n2, n3]);
            }

            elems_in_block -= 1;
            if elems_in_block == 0 { section = "ELEMS_BLOCK_HEADER"; }
            continue;
        }
    }
    Ok(SimpleTriMesh { vertices, indices })
}

pub fn get_target_shell_info(mesh: &SimpleTriMesh, rank: usize) -> Option<((f64, f64, f64), f64, Vec<usize>)> {
    let num_tris = mesh.indices.len();
    let mut adj: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut edge_map: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    
    // Build Graph
    for (i, tri) in mesh.indices.iter().enumerate() {
        for &(u, v) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
            let key = if u < v { (u, v) } else { (v, u) };
            edge_map.entry(key).or_default().push(i);
        }
    }
    for (_, tris) in edge_map {
        for &t1 in &tris {
            for &t2 in &tris {
                if t1 != t2 { adj.entry(t1).or_default().push(t2); }
            }
        }
    }
    
    // Flood Fill
    let mut visited = vec![false; num_tris];
    let mut shells = Vec::new();
    for i in 0..num_tris {
        if !visited[i] {
            let mut stack = vec![i];
            visited[i] = true;
            let mut comp = Vec::new();
            while let Some(c) = stack.pop() {
                comp.push(c);
                if let Some(neighbors) = adj.get(&c) {
                    for &n in neighbors {
                        if !visited[n] { visited[n] = true; stack.push(n); }
                    }
                }
            }
            shells.push(comp);
        }
    }
    
    // Calculate Stats & Sort
    let mut stats = shells.into_iter().map(|comp| {
        let mut vol = 0.0;
        let mut cx = 0.0; let mut cy = 0.0; let mut cz = 0.0;
        let mut v_count = 0.0;
        
        for &idx in &comp {
            let t = mesh.indices[idx];
            let p1 = mesh.vertices[t[0]];
            let p2 = mesh.vertices[t[1]];
            let p3 = mesh.vertices[t[2]];
            
            let v321 = p3[0] * p2[1] * p1[2];
            let v231 = p2[0] * p3[1] * p1[2];
            let v312 = p3[0] * p1[1] * p2[2];
            let v132 = p1[0] * p3[1] * p2[2];
            let v213 = p2[0] * p1[1] * p3[2];
            let v123 = p1[0] * p2[1] * p3[2];
            vol += (1.0 / 6.0) * (-v321 + v231 + v312 - v132 - v213 + v123);
            
            cx += p1[0]+p2[0]+p3[0];
            cy += p1[1]+p2[1]+p3[1];
            cz += p1[2]+p2[2]+p3[2];
            v_count += 3.0;
        }
        ((cx/v_count, cy/v_count, cz/v_count), vol.abs(), comp)
    }).collect::<Vec<_>>();
    
    stats.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    
    if rank < stats.len() {
        let (centroid, vol, indices) = stats.remove(rank);
        Some((centroid, vol, indices))
    } else {
        None
    }
}