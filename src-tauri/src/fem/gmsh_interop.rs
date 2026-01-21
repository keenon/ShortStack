
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use crate::fem::mesh::TetMesh;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Mutex;
use std::io::{BufRead, BufReader};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::process::{CommandEvent, CommandChild};

// Global handle to allow aborting the running Gmsh process
static GMSH_CHILD: Mutex<Option<CommandChild>> = Mutex::new(None);

// Data structures matching Typescript
#[derive(Deserialize, Debug)]
pub struct FeaRequest {
    pub footprint: serde_json::Value,
    pub stackup: Vec<serde_json::Value>,
    pub params: Vec<serde_json::Value>,
    pub mesh_size: f64,
    pub target_layer_id: Option<String>,
    pub part_index: Option<usize>,
}

#[derive(Serialize, Debug)]
pub struct FeaResult {
    pub mesh: TetMesh,
    pub volume: f64,
    pub surface_area: f64,
    pub logs: String,
}

/// Helper to resolve a parameter string to a f64 value
/// Checks the 'params' list for keys, otherwise attempts float parse.
fn resolve_param(val: &serde_json::Value, params: &[serde_json::Value]) -> f64 {
    // 1. If it's already a number, return it
    if let Some(n) = val.as_f64() {
        return n;
    }
    
    // 2. If string, try to parse or look up
    if let Some(s) = val.as_str() {
        // Try direct parse
        if let Ok(n) = s.parse::<f64>() {
            return n;
        }
        
        // Try Parameter Lookup (Simple exact match)
        for p in params {
            if let (Some(k), Some(v)) = (p.get("key").and_then(|x| x.as_str()), p.get("value").and_then(|x| x.as_f64())) {
                if k == s {
                    // Check unit
                    if let Some(unit) = p.get("unit").and_then(|u| u.as_str()) {
                        if unit == "in" { return v * 25.4; }
                    }
                    return v;
                }
            }
        }
    }
    
    // Default fallback
    0.0
}

/// Generates a Gmsh .geo script using OpenCASCADE kernel
fn generate_geo_script(req: &FeaRequest, output_msh_path: &str) -> String {
    let mut script = String::new();
    
    // Header
    script.push_str("SetFactory(\"OpenCASCADE\");\\n");
    
    // Performance Optimization: Use all available threads
    script.push_str("General.NumThreads = 0; // 0 = Auto-detect all cores\\n");
    script.push_str("Mesh.MaxNumThreads1D = 0;\\n");
    script.push_str("Mesh.MaxNumThreads2D = 0;\\n");
    script.push_str("Mesh.MaxNumThreads3D = 0;\\n");
    
    // Geometry Healing: Fix "BRep contains more volumes" errors
    // This removes microscopic artifacts that cause HXT to fail and fallback to single-threaded Delaunay
    script.push_str("Geometry.OccFixDegenerated = 1;\\n");
    script.push_str("Geometry.OccFixSmallEdges = 1;\\n");
    script.push_str("Geometry.OccFixSmallFaces = 1;\\n");
    script.push_str("Geometry.Tolerance = 1e-6;\\n"); 
    
    script.push_str("Mesh.Algorithm3D = 10; // HXT (Parallel Tetrahedral)\\n");
    
    // Use user-defined mesh size directly
    let target_size = if req.mesh_size > 0.0 { req.mesh_size } else { 5.0 };
    
    // Min size allows adaptation around small curves (set to 10% of target)
    // Max size constrains the bulk of the volume
    script.push_str(&format!("Mesh.CharacteristicLengthMin = {};\n", target_size * 0.1));
    script.push_str(&format!("Mesh.CharacteristicLengthMax = {};\n", target_size));

    // 1. Identify Target Layer Thickness
    let target_layer_id = req.target_layer_id.as_deref().unwrap_or("");
    let mut layer_thickness = 1.0; // Default
    
    for layer in &req.stackup {
        if let Some(id) = layer.get("id").and_then(|s| s.as_str()) {
            if id == target_layer_id {
                if let Some(expr) = layer.get("thicknessExpression") {
                    layer_thickness = resolve_param(expr, &req.params);
                }
                break;
            }
        }
    }

    // Safety Check: Zero thickness causes OpenCASCADE crash
    if layer_thickness.abs() < 1e-5 {
        println!("[Rust] WARNING: Layer thickness resolved to 0.0. Defaulting to 1.0 to prevent crash.");
        layer_thickness = 1.0;
    }

    // --- GEOMETRY CONSTRUCTION ---
    // Strategy: "Painter's Algorithm" with CSG
    // 1. Create Base Volume from Board Outline (0 to Thickness)
    // 2. For each shape (in order):
    //    a. CUT: Subtract the shape's profile infinitely (clears previous info).
    //    b. ADD: Union the shape's profile from 0 to (Thickness - Depth).
    
    let mut current_vol = 1; // We will track the main volume tag
    let mut entity_counter = 100; // Counter for temp objects

    // A. Base Board Outline
    script.push_str("// --- Base Board Outline ---\n");
    
    let mut outline_created = false;
    let shapes = req.footprint.get("shapes").and_then(|v| v.as_array());
    
    if let Some(list) = shapes {
        for shape in list {
            if shape.get("type").and_then(|s| s.as_str()) == Some("boardOutline") {
                // Resolve Origin
                let origin_x = resolve_param(shape.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                let origin_y = resolve_param(shape.get("y").unwrap_or(&serde_json::Value::Null), &req.params);

                if let Some(points) = shape.get("points").and_then(|p| p.as_array()) {
                    if points.len() >= 3 {
                        let mut point_tags = Vec::new();
                        let start_pt_tag = entity_counter;
                        
                        // 1. Create Points
                        for pt in points {
                            let px = resolve_param(pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                            let py = resolve_param(pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                            
                            // Absolute Position = Shape Origin + Point Local
                            let abs_x = origin_x + px;
                            let abs_y = origin_y + py;
                            
                            script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, abs_x, abs_y));
                            point_tags.push(entity_counter);
                            entity_counter += 1;
                        }

                        // 2. Create Lines / Beziers
                        let mut line_tags = Vec::new();
                        let num = points.len();
                        
                        for i in 0..num {
                            let curr_idx = i;
                            let next_idx = (i + 1) % num;
                            
                            let curr_pt = &points[curr_idx];
                            let next_pt = &points[next_idx];
                            
                            let p_curr_tag = point_tags[curr_idx];
                            let p_next_tag = point_tags[next_idx];

                            // Check for Handles
                            // handleOut on current, handleIn on next
                            let h_out_opt = curr_pt.get("handleOut").filter(|v| !v.is_null());
                            let h_in_opt = next_pt.get("handleIn").filter(|v| !v.is_null());

                            if h_out_opt.is_some() || h_in_opt.is_some() {
                                // Bezier Curve - Force Cubic (4 Points) for Stability
                                // P0 = Curr
                                // P1 = Curr + HandleOut (or P0 if missing)
                                // P2 = Next + HandleIn (or P3 if missing)
                                // P3 = Next
                                
                                let mut bezier_ctrl_tags = Vec::new();
                                bezier_ctrl_tags.push(p_curr_tag); // P0

                                // --- P1 ---
                                if let Some(h_out) = h_out_opt {
                                    let hx = resolve_param(h_out.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_out.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let cpx = resolve_param(curr_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let cpy = resolve_param(curr_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, origin_x + cpx + hx, origin_y + cpy + hy));
                                    bezier_ctrl_tags.push(entity_counter);
                                    entity_counter += 1;
                                } else {
                                    // Missing HandleOut -> P1 = P0
                                    bezier_ctrl_tags.push(p_curr_tag);
                                }

                                // --- P2 ---
                                if let Some(h_in) = h_in_opt {
                                    let hx = resolve_param(h_in.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_in.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let npx = resolve_param(next_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let npy = resolve_param(next_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, origin_x + npx + hx, origin_y + npy + hy));
                                    bezier_ctrl_tags.push(entity_counter);
                                    entity_counter += 1;
                                } else {
                                    // Missing HandleIn -> P2 = P3
                                    bezier_ctrl_tags.push(p_next_tag);
                                }

                                bezier_ctrl_tags.push(p_next_tag); // P3
                                
                                // Create Cubic BSpline (More robust in OpenCASCADE than Bezier)
                                let ctrl_str = bezier_ctrl_tags.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ");
                                script.push_str(&format!("BSpline({}) = {{{}}};\n", entity_counter, ctrl_str));
                                line_tags.push(entity_counter);
                                entity_counter += 1;

                            } else {
                                // Straight Line
                                script.push_str(&format!("Line({}) = {{{}, {}}};\n", entity_counter, p_curr_tag, p_next_tag));
                                line_tags.push(entity_counter);
                                entity_counter += 1;
                            }
                        }

                        // 3. Curve Loop and Surface
                        let loop_tag = entity_counter;
                        let line_str = line_tags.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ");
                        script.push_str(&format!("Curve Loop({}) = {{{}}};\n", loop_tag, line_str));
                        entity_counter += 1;

                        let surf_tag = entity_counter;
                        script.push_str(&format!("Plane Surface({}) = {{{}}};\n", surf_tag, loop_tag));
                        // No increment needed yet, surf_tag is used below
                        
                        // 4. Extrude
                        script.push_str(&format!("base_out[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", layer_thickness, surf_tag));
                        script.push_str("v_main = base_out[1];\n");
                        
                        entity_counter += 10; // Bump safety
                        outline_created = true;
                        break; // Stop after first outline found
                    }
                }
            }
        }
    }

    if !outline_created {
        // Fallback Base (100x100 rect)
        script.push_str(&format!("Rectangle({}) = {{-50, -50, 0, 100, 100, 0}};\n", entity_counter));
        script.push_str(&format!("base_out[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", layer_thickness, entity_counter));
        script.push_str("v_main = base_out[1];\n");
        entity_counter += 1;
    }
    // B. Process Shapes
    // Logic: Separate Splitters from Normal shapes.
    // Normal shapes run in REVERSE order (Bottom -> Top priority).
    // Splitters run LAST (Always Top priority) to ensure they cut through everything.
    let shapes = req.footprint.get("shapes").and_then(|v| v.as_array());
    if let Some(source_list) = shapes {
        let mut final_execution_list = Vec::new();
        let mut splitters = Vec::new();
        
        for shape in source_list {
            let id = shape.get("id").and_then(|s| s.as_str()).unwrap_or("");
            if id.starts_with("temp_split_") {
                splitters.push(shape);
            } else {
                final_execution_list.push(shape);
            }
        }
        
        // 1. Standard Shapes (Reversed)
        final_execution_list.reverse();
        
        // 2. Splitters (Appended to end)
        final_execution_list.extend(splitters);

        for (i, shape) in final_execution_list.iter().enumerate() {
            let shape_type = shape.get("type").and_then(|s| s.as_str()).unwrap_or("");
            // Skip outline (already handled) and wireGuides
            if shape_type == "boardOutline" || shape_type == "wireGuide" { continue; }

            // Get Cut Depth
            // Logic: Shape -> assignedLayers -> [target_layer_id] -> depth (or object with depth)
            let assigned = shape.get("assignedLayers");
            let mut depth_expr = serde_json::Value::Null;
            
            if let Some(map) = assigned {
                if let Some(target_layer_id) = req.target_layer_id.as_deref() {
                    if let Some(val) = map.get(target_layer_id) {
                        // Value can be string "5" or object {depth: "5", ...}
                        if val.is_object() {
                            depth_expr = val.get("depth").cloned().unwrap_or(serde_json::Value::Null);
                        } else {
                            depth_expr = val.clone();
                        }
                    }
                }
            }

            // If not assigned to this layer, skip
            if depth_expr.is_null() { continue; }

            let depth = resolve_param(&depth_expr, &req.params);
            
            // Define Shape Profile Surface
            let x = resolve_param(shape.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
            let y = resolve_param(shape.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
            let s_tag = entity_counter;
            entity_counter += 1;
            
            let mut created = false;

            match shape_type {
                "rect" => {
                    let w = resolve_param(shape.get("width").unwrap_or(&serde_json::Value::Null), &req.params);
                    let h = resolve_param(shape.get("height").unwrap_or(&serde_json::Value::Null), &req.params);
                    let r = resolve_param(shape.get("cornerRadius").unwrap_or(&serde_json::Value::Null), &req.params);
                    script.push_str(&format!("Rectangle({}) = {{{}, {}, 0, {}, {}, {}}};\n", s_tag, x - w/2.0, y - h/2.0, w, h, r));
                    created = true;
                },
                "circle" => {
                    let d = resolve_param(shape.get("diameter").unwrap_or(&serde_json::Value::Null), &req.params);
                    let r = d / 2.0;
                    script.push_str(&format!("Disk({}) = {{{}, {}, 0, {}}};\n", s_tag, x, y, r));
                    created = true;
                },
                "polygon" => {
                    if let Some(pts_json) = shape.get("points").and_then(|p| p.as_array()) {
                        // 1. Parse all points first
                        let mut raw_points: Vec<(f64, f64)> = Vec::new();
                        for pt in pts_json {
                            let px = resolve_param(pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                            let py = resolve_param(pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                            raw_points.push((x + px, y + py));
                        }

                        // 2. Dedup Loop (Prevent zero-length lines)
                        // If end == start, remove end. If adjacent dups, remove.
                        if raw_points.len() >= 3 {
                            let mut clean_points = Vec::new();
                            clean_points.push(raw_points[0]);
                            
                            for i in 1..raw_points.len() {
                                let last = clean_points.last().unwrap();
                                let curr = raw_points[i];
                                let dist = ((curr.0 - last.0).powi(2) + (curr.1 - last.1).powi(2)).sqrt();
                                if dist > 1e-5 {
                                    clean_points.push(curr);
                                }
                            }
                            
                            // Check closure (if last == first)
                            let first = clean_points[0];
                            let last = clean_points.last().unwrap();
                            let dist_close = ((first.0 - last.0).powi(2) + (first.1 - last.1).powi(2)).sqrt();
                            if dist_close < 1e-5 && clean_points.len() > 1 {
                                clean_points.pop();
                            }

                            if clean_points.len() >= 3 {
                                let mut line_loop_tags = Vec::new();
                                let mut p_tags = Vec::new();
                                
                                // Create Gmsh Points
                                for (cx, cy) in clean_points {
                                    script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, cx, cy));
                                    p_tags.push(entity_counter);
                                    entity_counter += 1;
                                }
                                
                                // Create Lines
                                for i in 0..p_tags.len() {
                                    let p1 = p_tags[i];
                                    let p2 = p_tags[(i + 1) % p_tags.len()];
                                    script.push_str(&format!("Line({}) = {{{}, {}}};\n", entity_counter, p1, p2));
                                    line_loop_tags.push(entity_counter);
                                    entity_counter += 1;
                                }
                                
                                let ll_tag = entity_counter;
                                let lines_str = line_loop_tags.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ");
                                script.push_str(&format!("Curve Loop({}) = {{{}}};\n", ll_tag, lines_str));
                                entity_counter += 1;
                                
                                script.push_str(&format!("Plane Surface({}) = {{{}}};\n", s_tag, ll_tag));
                                created = true;
                            }
                        }
                    }
                },
                _ => {} 
            }

            if created {
                // 1. CUT: Subtract infinite column
                // Move surface down significantly to ensure thorough cut
                // Extrude up to Thickness + large margin to ensure we clear any previous "islands"
                // Using 1000.0 as safety margin
                let cut_depth = layer_thickness + 1000.0;
                let cut_start_z = -500.0;
                
                script.push_str(&format!("v_cut_list[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", cut_depth, s_tag));
                script.push_str("v_cut = v_cut_list[1];\n");
                script.push_str(&format!("Translate {{0, 0, {}}} {{ Volume{{v_cut}}; }}\n", cut_start_z)); // Shift down
                
                // Boolean Difference
                script.push_str("res_cut[] = BooleanDifference{ Volume{v_main}; Delete; }{ Volume{v_cut}; Delete; };\n");
                script.push_str("v_main = res_cut[0];\n");

                // 2. ADD: Add back material if depth < thickness
                let remaining_height = layer_thickness - depth;
                if remaining_height > 1e-4 {
                    // We need the surface again. Since Extrude might consume/modify, recreate or copy?
                    // OpenCASCADE Factory Extrude usually keeps base unless deleted? 
                    // Actually we deleted v_cut which depended on s_tag.
                    // Safest: Re-create surface.
                    let s_keep_tag = entity_counter; 
                    entity_counter += 1;
                    
                    // Re-emit geometry command
                    match shape_type {
                        "rect" => {
                            let w = resolve_param(shape.get("width").unwrap_or(&serde_json::Value::Null), &req.params);
                            let h = resolve_param(shape.get("height").unwrap_or(&serde_json::Value::Null), &req.params);
                            let r = resolve_param(shape.get("cornerRadius").unwrap_or(&serde_json::Value::Null), &req.params);
                            script.push_str(&format!("Rectangle({}) = {{{}, {}, 0, {}, {}, {}}};\n", s_keep_tag, x - w/2.0, y - h/2.0, w, h, r));
                        },
                        "circle" => {
                            let d = resolve_param(shape.get("diameter").unwrap_or(&serde_json::Value::Null), &req.params);
                            let r = d / 2.0;
                            script.push_str(&format!("Disk({}) = {{{}, {}, 0, {}}};\n", s_keep_tag, x, y, r));
                        },
                        _ => {}
                    }

                    // Extrude Keeper Column
                    script.push_str(&format!("v_keep_list[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", remaining_height, s_keep_tag));
                    script.push_str("v_keep = v_keep_list[1];\n");
                    
                    // Boolean Union
                    script.push_str("res_union[] = BooleanUnion{ Volume{v_main}; Delete; }{ Volume{v_keep}; Delete; };\n");
                    script.push_str("v_main = res_union[0];\n");
                }
            }
        }
    }

    script.push_str("Mesh 3;\n");
    script.push_str("Mesh.Format = 10; // Auto (4.1)\n");
    script.push_str(&format!("Save \"{}\";\n", output_msh_path.replace("\\", "/")));
    
    script
}

/// Parses a Gmsh .msh file (Format 4.1 ASCII) using Streaming IO to reduce memory usage
fn parse_msh(path: &PathBuf) -> Result<TetMesh, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // State machine
    let mut section = "NONE";
    
    // Node Block State
    let mut nodes_in_block_remaining = 0;
    let mut node_tags_buffer = Vec::new();
    let mut reading_node_coords = false;
    
    // Element Block State
    let mut elems_in_block_remaining = 0;
    let mut current_elem_type = 0;
    
    let mut node_map = HashMap::new(); // Tag -> Index
    
    let mut lines = reader.lines();
    
    while let Some(line_res) = lines.next() {
        let line = line_res.map_err(|e| e.to_string())?;
        let trim = line.trim();
        
        if trim.is_empty() { continue; }
        
        // Section Headers
        if trim.starts_with("$") {
            if trim == "$Nodes" { section = "NODES_HEADER"; continue; }
            if trim == "$EndNodes" { section = "NONE"; continue; }
            if trim == "$Elements" { section = "ELEMS_HEADER"; continue; }
            if trim == "$EndElements" { section = "NONE"; continue; }
            // Skip other sections
            if !trim.starts_with("$End") { section = "SKIP"; }
            continue;
        }
        
        if section == "SKIP" { continue; }
        
        if section == "NODES_HEADER" {
            // Header: numEntityBlocks numNodes minNodeTag maxNodeTag
            section = "NODES_BLOCK_HEADER"; 
            continue;
        }
        
        if section == "NODES_BLOCK_HEADER" {
            // Block Header: entityDim entityTag parametric numNodesInBlock
            let parts: Vec<&str> = trim.split_whitespace().collect();
            if parts.len() == 4 {
                nodes_in_block_remaining = parts[3].parse::<usize>().unwrap_or(0);
                if nodes_in_block_remaining > 0 {
                    section = "NODES_TAGS";
                    node_tags_buffer.clear();
                    reading_node_coords = false;
                }
            }
            continue;
        }
        
        if section == "NODES_TAGS" {
            let tag = trim.parse::<usize>().unwrap_or(0);
            node_tags_buffer.push(tag);
            
            if node_tags_buffer.len() == nodes_in_block_remaining {
                section = "NODES_COORDS";
                reading_node_coords = true;
            }
            continue;
        }
        
        if section == "NODES_COORDS" {
            let coords: Vec<f64> = trim.split_whitespace()
                .map(|s| s.parse::<f64>().unwrap_or(0.0))
                .collect();
            
            if coords.len() >= 3 {
                // Map the tag from the buffer (FIFO)
                let tag_idx = node_tags_buffer.len() - nodes_in_block_remaining;
                let tag = node_tags_buffer[tag_idx];
                
                node_map.insert(tag, vertices.len());
                vertices.push([coords[0], coords[1], coords[2]]);
                
                nodes_in_block_remaining -= 1;
                if nodes_in_block_remaining == 0 {
                    section = "NODES_BLOCK_HEADER"; // Expect next block
                }
            }
            continue;
        }
        
        if section == "ELEMS_HEADER" {
            section = "ELEMS_BLOCK_HEADER";
            continue;
        }
        
        if section == "ELEMS_BLOCK_HEADER" {
             // Block Header: entityDim entityTag elementType numElementsInBlock
             let parts: Vec<&str> = trim.split_whitespace().collect();
             if parts.len() >= 4 {
                 current_elem_type = parts[2].parse::<usize>().unwrap_or(0);
                 elems_in_block_remaining = parts[3].parse::<usize>().unwrap_or(0);
                 
                 // If not a Tet (4 or 11), we just skip the lines
                 section = "ELEMS_DATA";
             }
             continue;
        }
        
        if section == "ELEMS_DATA" {
            if current_elem_type == 4 || current_elem_type == 11 {
                // Parse Tet
                let e_parts: Vec<usize> = trim.split_whitespace()
                    .map(|s| s.parse().unwrap_or(0))
                    .collect();
                
                if e_parts.len() > 1 {
                    let node_tags = &e_parts[1..];
                    if node_tags.len() >= 4 {
                         let mut idx = [0usize; 10];
                         for (k, tag) in node_tags.iter().enumerate() {
                             if k < 10 {
                                 idx[k] = *node_map.get(tag).unwrap_or(&0);
                             }
                         }
                         indices.push(idx);
                    }
                }
            }
            
            elems_in_block_remaining -= 1;
            if elems_in_block_remaining == 0 {
                section = "ELEMS_BLOCK_HEADER";
            }
            continue;
        }
    }

    Ok(TetMesh { vertices, indices })
}

#[tauri::command]
pub async fn abort_gmsh() -> Result<(), String> {
    let mut guard = GMSH_CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        println!("[Rust] Aborting Gmsh process...");
        child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn run_gmsh_pipeline(app_handle: tauri::AppHandle, req: FeaRequest) -> Result<FeaResult, String> {
    println!("[Rust] run_gmsh_pipeline INVOKED. Target Layer: {:?}", req.target_layer_id);
    use tauri::Manager;

    // 1. Setup Paths
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_dir.exists() {
        let _ = fs::create_dir_all(&app_dir);
    }
    
    // Generate unique timestamp for permanent debug history
    let start = SystemTime::now();
    let since_the_epoch = start.duration_since(UNIX_EPOCH).unwrap_or_default();
    let timestamp = since_the_epoch.as_secs();

    let geo_filename = format!("debug_model_{}.geo", timestamp);
    let msh_filename = format!("debug_model_{}.msh", timestamp);

    let geo_path = app_dir.join(&geo_filename);
    let msh_path = app_dir.join(&msh_filename);
    
    // PRINT PATH FOR USER
    println!("\n[Rust] ===================================================");
    println!("[Rust] DEBUG: .geo file saved to:");
    println!("[Rust] {:?}", geo_path);
    println!("[Rust] ===================================================\n");

    // 2. Generate Script
    let script = generate_geo_script(&req, msh_path.to_str().unwrap());
    println!("[Rust] Generated .geo script ({} bytes)", script.len());
    
    fs::write(&geo_path, &script).map_err(|e| format!("Failed to write .geo: {}", e))?;

    // 3. Resolve Sidecar
    let sidecar_command = app_handle.shell().sidecar("gmsh").map_err(|e| format!("Sidecar error: {}", e))?;
    
    // 4. Execute Sidecar (Streaming)
    println!("[Rust] Spawning 'gmsh' sidecar...");
    let (mut rx, child) = sidecar_command
        .args(&[geo_path.to_str().unwrap(), "-"])
        .spawn()
        .map_err(|e| format!("Failed to spawn gmsh: {}", e))?;

    // Store child for aborting
    {
        let mut guard = GMSH_CHILD.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let mut full_log = String::new();
    let mut error_log = String::new();
    
    // Listen for events
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                print!("{}", line); // Pipe to terminal
                full_log.push_str(&line);
                
                // Emit raw log line for frontend details view
                let _ = app_handle.emit("gmsh_log", line.to_string());
                
                // Parse Progress: "Info : [ 20%]" 
                if line.contains("[") && line.contains("%]") {
                    if let Some(start) = line.find('[') {
                        if let Some(end) = line.find("%]") {
                            if end > start {
                                let pct_str = &line[start+1..end].trim();
                                if let Ok(pct) = pct_str.parse::<f64>() {
                                    let _ = app_handle.emit("gmsh_progress", serde_json::json!({
                                        "message": format!("Meshing... {}%", pct),
                                        "percent": pct
                                    }));
                                }
                            }
                        }
                    }
                } else if line.contains("Meshing 1D") {
                     let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Meshing Curves...", "percent": 5.0 }));
                } else if line.contains("Meshing 2D") {
                     let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Meshing Surfaces...", "percent": 20.0 }));
                } else if line.contains("Meshing 3D") {
                     let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Meshing Volume...", "percent": 50.0 }));
                } else if line.contains("Writing") {
                     let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Writing Mesh...", "percent": 95.0 }));
                }
            }
            CommandEvent::Stderr(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                eprint!("{}", line); // Pipe to terminal
                full_log.push_str(&line);
                error_log.push_str(&line);
                
                // Emit raw log line
                let _ = app_handle.emit("gmsh_log", line.to_string());
            }
            _ => {}
        }
    }

    // Clear child handle
    {
        let mut guard = GMSH_CHILD.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }
    
    // Check if output file exists to determine success (since exit code might be lost in streaming or simple close)
    if !msh_path.exists() {
         println!("[Rust] Gmsh ERROR LOG:\n{}", error_log);
         let short_log = error_log.lines().take(15).collect::<Vec<_>>().join("\n");
         return Err(format!("Gmsh failed to generate mesh.\nLast logs:\n{}", short_log));
    }

    // 5. Parse Output
    println!("[Rust] Parsing .msh file...");
    let mut mesh = parse_msh(&msh_path)?;
    println!("[Rust] Mesh Parsed. Verts: {}, Elements: {}", mesh.vertices.len(), mesh.indices.len());

    // 6. Filter Part (Splitting Logic)
    // CLEANUP: Remove temporary files to save space
    // let _ = fs::remove_file(&geo_path);
    // let _ = fs::remove_file(&msh_path);

    let target_part = req.part_index.unwrap_or(0);
    println!("[Rust] Filtering mesh for Part Index: {}", target_part);
    mesh.filter_components(target_part);

    // 7. Calculate Stats
    let (volume, surface_area) = mesh.compute_metrics();

    Ok(FeaResult {
        mesh,
        volume,
        surface_area,
        logs: full_log,
    })
}
