
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use crate::fem::mesh::TetMesh;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

// Data structures matching Typescript
#[derive(Deserialize, Debug)]
pub struct FeaRequest {
    pub footprint: serde_json::Value,
    pub stackup: Vec<serde_json::Value>,
    pub params: Vec<serde_json::Value>,
    pub quality: f64,
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
    script.push_str("SetFactory(\"OpenCASCADE\");\n");
    script.push_str("Mesh.Algorithm3D = 10; // HXT\n");
    
    let mesh_size = if req.quality > 0.0 { 10.0 / req.quality } else { 5.0 };
    script.push_str(&format!("Mesh.CharacteristicLengthMin = {};\n", mesh_size * 0.2));
    script.push_str(&format!("Mesh.CharacteristicLengthMax = {};\n", mesh_size));

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
                                // Bezier Curve
                                // Control Points need to be created as Gmsh Points
                                let mut bezier_ctrl_tags = Vec::new();
                                bezier_ctrl_tags.push(p_curr_tag);

                                // CP1 = Curr + HandleOut
                                if let Some(h_out) = h_out_opt {
                                    let hx = resolve_param(h_out.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_out.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    // Get Curr Abs pos (we don't store it readily above, re-calc)
                                    let cpx = resolve_param(curr_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let cpy = resolve_param(curr_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let cp1_x = origin_x + cpx + hx;
                                    let cp1_y = origin_y + cpy + hy;
                                    
                                    script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, cp1_x, cp1_y));
                                    bezier_ctrl_tags.push(entity_counter);
                                    entity_counter += 1;
                                }

                                // CP2 = Next + HandleIn
                                if let Some(h_in) = h_in_opt {
                                    let hx = resolve_param(h_in.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_in.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let npx = resolve_param(next_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let npy = resolve_param(next_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let cp2_x = origin_x + npx + hx;
                                    let cp2_y = origin_y + npy + hy;
                                    
                                    script.push_str(&format!("Point({}) = {{{}, {}, 0, 1.0}};\n", entity_counter, cp2_x, cp2_y));
                                    bezier_ctrl_tags.push(entity_counter);
                                    entity_counter += 1;
                                }

                                bezier_ctrl_tags.push(p_next_tag);
                                
                                // Create Bezier
                                let ctrl_str = bezier_ctrl_tags.iter().map(|t| t.to_string()).collect::<Vec<_>>().join(", ");
                                script.push_str(&format!("Bezier({}) = {{{}}};\n", entity_counter, ctrl_str));
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
    let shapes = req.footprint.get("shapes").and_then(|v| v.as_array());
    if let Some(shape_list) = shapes {
        for (i, shape) in shape_list.iter().enumerate() {
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
                _ => {} // Lines/Polys need point parsing, skipping for MVP
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

/// Parses a Gmsh .msh file (Format 4.1 ASCII) into our TetMesh struct
fn parse_msh(path: &PathBuf) -> Result<TetMesh, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    let mut reading_nodes = false;
    let mut reading_elements = false;
    
    // Gmsh 4.1 Parsing state
    let mut _num_entity_blocks = 0;
    let mut _num_nodes = 0;
    let mut _min_node_tag = 0;
    let mut _max_node_tag = 0;
    
    let mut node_map = HashMap::new(); // Tag -> Index
    
    let mut iter = lines.iter();
    while let Some(line) = iter.next() {
        if line.starts_with("$Nodes") {
            reading_nodes = true;
            // 4.1 Header: numEntityBlocks numNodes minNodeTag maxNodeTag
            let header = iter.next().unwrap_or(&""); 
            let parts: Vec<&str> = header.split_whitespace().collect();
            if parts.len() >= 4 {
                _num_entity_blocks = parts[0].parse().unwrap_or(0);
                _num_nodes = parts[1].parse().unwrap_or(0);
                _min_node_tag = parts[2].parse().unwrap_or(0);
                _max_node_tag = parts[3].parse().unwrap_or(0);
            }
            continue;
        }
        if line.starts_with("$EndNodes") { reading_nodes = false; continue; }
        
        if line.starts_with("$Elements") {
            reading_elements = true;
            iter.next(); // Skip header
            continue;
        }
        if line.starts_with("$EndElements") { reading_elements = false; continue; }

        if reading_nodes {
            // 4.1 Node Blocks: 
            // Line 1: entityDim entityTag parametric numNodesInBlock
            // Next N lines: nodeTag
            // Next N lines: x y z
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 4 {
                let num_nodes_in_block = parts[3].parse::<usize>().unwrap_or(0);
                
                // Read Tags
                let mut tags = Vec::new();
                for _ in 0..num_nodes_in_block {
                    if let Some(tag_line) = iter.next() {
                        tags.push(tag_line.trim().parse::<usize>().unwrap_or(0));
                    }
                }
                
                // Read Coords
                for t in tags {
                    if let Some(coord_line) = iter.next() {
                        let coords: Vec<f64> = coord_line.split_whitespace()
                            .map(|s| s.parse::<f64>().unwrap_or(0.0))
                            .collect();
                        if coords.len() >= 3 {
                            node_map.insert(t, vertices.len());
                            vertices.push([coords[0], coords[1], coords[2]]);
                        }
                    }
                }
            }
        }

        if reading_elements {
            // 4.1 Element Blocks
            // Line 1: entityDim entityTag elementType numElementsInBlock
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                let elem_type = parts[2].parse::<usize>().unwrap_or(0);
                let num_elems = parts[3].parse::<usize>().unwrap_or(0);
                
                // Type 4 (4-node tet) or 11 (10-node tet)
                if elem_type == 4 || elem_type == 11 {
                    for _ in 0..num_elems {
                        if let Some(elem_line) = iter.next() {
                            let e_parts: Vec<usize> = elem_line.split_whitespace()
                                .map(|s| s.parse().unwrap_or(0))
                                .collect();
                            
                            // e_parts: [elemTag, node1, node2, ...]
                            if e_parts.len() > 1 {
                                let node_tags = &e_parts[1..];
                                // We take first 4 for visualization, or 10 for physics
                                // Visualizer expects 4 currently, but we can store 10 and truncate later
                                if node_tags.len() >= 4 {
                                    let mut idx = [0usize; 10]; // Pad with 0
                                    for (k, tag) in node_tags.iter().enumerate() {
                                        if k < 10 {
                                            idx[k] = *node_map.get(tag).unwrap_or(&0);
                                        }
                                    }
                                    indices.push(idx);
                                }
                            }
                        }
                    }
                } else {
                    // Skip lines for other element types
                    for _ in 0..num_elems { iter.next(); }
                }
            }
        }
    }

    Ok(TetMesh { vertices, indices })
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
    
    // 4. Execute Sidecar
    println!("[Rust] Executing 'gmsh' sidecar...");
    let output = sidecar_command
        .args(&[geo_path.to_str().unwrap(), "-"])
        .output()
        .await
        .map_err(|e| format!("Failed to run gmsh process: {}", e.to_string()))?;

    if !output.status.success() {
        let err_log = String::from_utf8_lossy(&output.stderr);
        let out_log = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Gmsh exited with error.\nSTDERR: {}\nSTDOUT: {}", err_log, out_log));
    }

    // 5. Parse Output
    println!("[Rust] Parsing .msh file...");
    let mesh = parse_msh(&msh_path)?;
    println!("[Rust] Mesh Parsed. Verts: {}, Elements: {}", mesh.vertices.len(), mesh.indices.len());

    // 6. Calculate Stats
    let (volume, surface_area) = mesh.compute_metrics();

    Ok(FeaResult {
        mesh,
        volume,
        surface_area,
        logs: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}
