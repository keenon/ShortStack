
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use crate::fem::mesh::{TetMesh, SimpleTriMesh, parse_2d_triangle_mesh, get_target_shell_centroid};
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
    script.push_str("SetFactory(\"OpenCASCADE\");\n");
    
    // Performance Optimization: Use all available threads
    script.push_str("General.NumThreads = 0; // 0 = Auto-detect all cores\n");
    script.push_str("Mesh.MaxNumThreads1D = 0;\n");
    script.push_str("Mesh.MaxNumThreads2D = 0;\n");
    script.push_str("Mesh.MaxNumThreads3D = 0;\n");
    
    // Geometry Healing: Fix "BRep contains more volumes" errors
    // This removes microscopic artifacts that cause HXT to fail and fallback to single-threaded Delaunay
    // script.push_str("Geometry.OccFixDegenerated = 1;\n");
    // script.push_str("Geometry.OccFixSmallEdges = 1;\n");
    // script.push_str("Geometry.OccFixSmallFaces = 1;\n");
    // script.push_str("Geometry.Tolerance = 1e-6;\n"); 
    
    script.push_str("Mesh.Algorithm3D = 10; // HXT (Parallel Tetrahedral)\n");
    
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

    // --- GEOMETRY CONSTRUCTION (Optimized) ---
    // Strategy: "Painter's Algorithm" with CSG using Gmsh Auto-Indexing (newp, newl, etc.)
    // We map Layer IDs to short codes (L0, L1...) to keep .geo variable names concise.
    
    // 1. Build Layer Short-Name Map
    let mut layer_name_map = HashMap::new();
    for (i, l) in req.stackup.iter().enumerate() {
        if let Some(id) = l.get("id").and_then(|s| s.as_str()) {
            layer_name_map.insert(id.to_string(), format!("L{}", i));
        }
    }
    
    // Helper to sanitize shape names for variables
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect()
    };

    let layer_var = if target_layer_id.is_empty() { 
        "L_Main".to_string() 
    } else { 
        layer_name_map.get(target_layer_id).cloned().unwrap_or_else(|| "L_Target".to_string())
    };

    script.push_str(&format!("// --- Context: {} ---\n", layer_var));

    // A. Base Board Outline
    script.push_str("// [Operation] Generating Base Board Stock\n");
    
    let mut outline_created = false;
    let shapes = req.footprint.get("shapes").and_then(|v| v.as_array());
    
    if let Some(list) = shapes {
        for shape in list {
            if shape.get("type").and_then(|s| s.as_str()) == Some("boardOutline") {
                let origin_x = resolve_param(shape.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                let origin_y = resolve_param(shape.get("y").unwrap_or(&serde_json::Value::Null), &req.params);

                if let Some(points) = shape.get("points").and_then(|p| p.as_array()) {
                    if points.len() >= 3 {
                        script.push_str("// Creating Outline Points\n");
                        let mut point_vars = Vec::new();
                        
                        for (i, pt) in points.iter().enumerate() {
                            let px = resolve_param(pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                            let py = resolve_param(pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                            
                            let p_var = format!("p_{}_out_{}", layer_var, i);
                            script.push_str(&format!("{} = newp; Point({}) = {{{}, {}, 0, 1.0}};\n", p_var, p_var, origin_x + px, origin_y + py));
                            point_vars.push(p_var);
                        }

                        script.push_str("// Creating Outline Curves\n");
                        let mut line_vars = Vec::new();
                        let num = points.len();
                        
                        for i in 0..num {
                            let curr_idx = i;
                            let next_idx = (i + 1) % num;
                            
                            let curr_pt = &points[curr_idx];
                            let next_pt = &points[next_idx];
                            
                            let p_curr = &point_vars[curr_idx];
                            let p_next = &point_vars[next_idx];

                            let h_out_opt = curr_pt.get("handleOut").filter(|v| !v.is_null());
                            let h_in_opt = next_pt.get("handleIn").filter(|v| !v.is_null());

                            let line_var = format!("l_{}_out_{}", layer_var, i);

                            if h_out_opt.is_some() || h_in_opt.is_some() {
                                let mut bezier_ctrl = Vec::new();
                                bezier_ctrl.push(p_curr.clone());

                                if let Some(h_out) = h_out_opt {
                                    let hx = resolve_param(h_out.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_out.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let cpx = resolve_param(curr_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let cpy = resolve_param(curr_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let cp_var = format!("cp_{}_{}_a", layer_var, i);
                                    script.push_str(&format!("{} = newp; Point({}) = {{{}, {}, 0, 1.0}};\n", cp_var, cp_var, origin_x + cpx + hx, origin_y + cpy + hy));
                                    bezier_ctrl.push(cp_var);
                                } else {
                                    bezier_ctrl.push(p_curr.clone());
                                }

                                if let Some(h_in) = h_in_opt {
                                    let hx = resolve_param(h_in.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let hy = resolve_param(h_in.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let npx = resolve_param(next_pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let npy = resolve_param(next_pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    
                                    let cp_var = format!("cp_{}_{}_b", layer_var, i);
                                    script.push_str(&format!("{} = newp; Point({}) = {{{}, {}, 0, 1.0}};\n", cp_var, cp_var, origin_x + npx + hx, origin_y + npy + hy));
                                    bezier_ctrl.push(cp_var);
                                } else {
                                    bezier_ctrl.push(p_next.clone());
                                }

                                bezier_ctrl.push(p_next.clone());
                                
                                script.push_str(&format!("{} = newl; Bezier({}) = {{{}}};\n", line_var, line_var, bezier_ctrl.join(", ")));
                            } else {
                                script.push_str(&format!("{} = newl; Line({}) = {{{}, {}}};\n", line_var, line_var, p_curr, p_next));
                            }
                            line_vars.push(line_var);
                        }

                        let ll_var = format!("ll_{}_out", layer_var);
                        let s_var = format!("s_{}_out", layer_var);
                        
                        script.push_str(&format!("{} = newll; Curve Loop({}) = {{{}}};\n", ll_var, ll_var, line_vars.join(", ")));
                        script.push_str(&format!("{} = news; Plane Surface({}) = {{{}}};\n", s_var, s_var, ll_var));
                        
                        script.push_str("// Extruding Base Stock\n");
                        script.push_str(&format!("out_{}[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", layer_var, layer_thickness, s_var));
                        // Track volume list to support multi-body results
                        script.push_str(&format!("v_main_list[] = out_{}[1];\n", layer_var));
                        
                        outline_created = true;
                        break;
                    }
                }
            }
        }
    }

    if !outline_created {
        script.push_str("// [Fallback] No outline found, creating 100x100 stock\n");
        script.push_str("s_fallback = news; Rectangle(s_fallback) = {-50, -50, 0, 100, 100, 0};\n");
        script.push_str(&format!("out_fallback[] = Extrude {{0, 0, {}}} {{ Surface{{s_fallback}}; }};\n", layer_thickness));
        script.push_str("v_main_list[] = out_fallback[1];\n");
    }

    // B. Process Shapes
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
        
        final_execution_list.reverse();
        final_execution_list.extend(splitters);

        for (i, shape) in final_execution_list.iter().enumerate() {
            let shape_type = shape.get("type").and_then(|s| s.as_str()).unwrap_or("");
            if shape_type == "boardOutline" || shape_type == "wireGuide" { continue; }

            let assigned = shape.get("assignedLayers");
            let mut depth_expr = serde_json::Value::Null;
            
            if let Some(map) = assigned {
                if let Some(target_layer_id) = req.target_layer_id.as_deref() {
                    if let Some(val) = map.get(target_layer_id) {
                        if val.is_object() {
                            depth_expr = val.get("depth").cloned().unwrap_or(serde_json::Value::Null);
                        } else {
                            depth_expr = val.clone();
                        }
                    }
                }
            }

            if depth_expr.is_null() { continue; }

            let depth = resolve_param(&depth_expr, &req.params);
            
            let x = resolve_param(shape.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
            let y = resolve_param(shape.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
            
            // Short unique identifier for shape vars
            let shape_raw_name = shape.get("name").and_then(|s| s.as_str()).unwrap_or("shp");
            let shape_var = format!("s_{}_{}_{}", layer_var, i, sanitize(shape_raw_name));
            
            let mut created = false;

            script.push_str(&format!("\n// [Operation] Processing Shape: {} ({})\n", shape_raw_name, shape_type));

            match shape_type {
                "rect" => {
                    let w = resolve_param(shape.get("width").unwrap_or(&serde_json::Value::Null), &req.params);
                    let h = resolve_param(shape.get("height").unwrap_or(&serde_json::Value::Null), &req.params);
                    let r = resolve_param(shape.get("cornerRadius").unwrap_or(&serde_json::Value::Null), &req.params);
                    
                    script.push_str(&format!("{} = news; Rectangle({}) = {{{}, {}, 0, {}, {}, {}}};\n", shape_var, shape_var, x - w/2.0, y - h/2.0, w, h, r));
                    created = true;
                },
                "circle" => {
                    let d = resolve_param(shape.get("diameter").unwrap_or(&serde_json::Value::Null), &req.params);
                    let r = d / 2.0;
                    script.push_str(&format!("{} = news; Disk({}) = {{{}, {}, 0, {}}};\n", shape_var, shape_var, x, y, r));
                    created = true;
                },
                "polygon" => {
                    if let Some(pts_json) = shape.get("points").and_then(|p| p.as_array()) {
                        let mut raw_points: Vec<(f64, f64)> = Vec::new();
                        for pt in pts_json {
                            let px = resolve_param(pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                            let py = resolve_param(pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                            raw_points.push((x + px, y + py));
                        }

                        // Sanitize points (dedup)
                        if raw_points.len() >= 3 {
                            let mut clean = Vec::new();
                            clean.push(raw_points[0]);
                            for k in 1..raw_points.len() {
                                let last = clean.last().unwrap();
                                let curr = raw_points[k];
                                let d = ((curr.0 - last.0).powi(2) + (curr.1 - last.1).powi(2)).sqrt();
                                if d > 1e-5 { clean.push(curr); }
                            }
                            // Close loop check
                            let first = clean[0];
                            let last = clean.last().unwrap();
                            if ((first.0 - last.0).powi(2) + (first.1 - last.1).powi(2)).sqrt() < 1e-5 && clean.len() > 1 {
                                clean.pop();
                            }

                            if clean.len() >= 3 {
                                script.push_str("// Polygon Points\n");
                                let mut p_tags = Vec::new();
                                for (k, (cx, cy)) in clean.iter().enumerate() {
                                    let p_var = format!("{}_p{}", shape_var, k);
                                    script.push_str(&format!("{} = newp; Point({}) = {{{}, {}, 0, 1.0}};\n", p_var, p_var, cx, cy));
                                    p_tags.push(p_var);
                                }
                                
                                let mut l_tags = Vec::new();
                                for k in 0..p_tags.len() {
                                    let p1 = &p_tags[k];
                                    let p2 = &p_tags[(k + 1) % p_tags.len()];
                                    let l_var = format!("{}_l{}", shape_var, k);
                                    script.push_str(&format!("{} = newl; Line({}) = {{{}, {}}};\n", l_var, l_var, p1, p2));
                                    l_tags.push(l_var);
                                }
                                
                                let ll_var = format!("{}_ll", shape_var);
                                script.push_str(&format!("{} = newll; Curve Loop({}) = {{{}}};\n", ll_var, ll_var, l_tags.join(", ")));
                                script.push_str(&format!("{} = news; Plane Surface({}) = {{{}}};\n", shape_var, shape_var, ll_var));
                                created = true;
                            }
                        }
                    }
                },
                _ => {} 
            }

            if created {
                let cut_depth = layer_thickness + 1000.0;
                let cut_start_z = -500.0;
                let v_cut_var = format!("v_cut_{}", i);
                let list_cut_var = format!("out_cut_{}", i);
                
                script.push_str("// Creating Cut Volume (Subtraction)\n");
                script.push_str(&format!("{}[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", list_cut_var, cut_depth, shape_var));
                script.push_str(&format!("{} = {}[1];\n", v_cut_var, list_cut_var));
                script.push_str(&format!("Translate {{0, 0, {}}} {{ Volume{{{}}}; }}\n", cut_start_z, v_cut_var));
                
                script.push_str(&format!("res_cut_{}[] = BooleanDifference{{ Volume{{ v_main_list[] }}; Delete; }}{{ Volume{{{}}}; Delete; }};\n", i, v_cut_var));
                script.push_str(&format!("v_main_list[] = res_cut_{}[];\n", i));

                // 2. ADD (Keep)
                let remaining_height = layer_thickness - depth;
                if remaining_height > 1e-4 {
                    script.push_str("// Creating Keep Volume (Add back partial depth)\n");
                    // Re-create surface 
                    let shape_keep_var = format!("{}_keep", shape_var);
                    match shape_type {
                        "rect" => {
                            let w = resolve_param(shape.get("width").unwrap_or(&serde_json::Value::Null), &req.params);
                            let h = resolve_param(shape.get("height").unwrap_or(&serde_json::Value::Null), &req.params);
                            let r = resolve_param(shape.get("cornerRadius").unwrap_or(&serde_json::Value::Null), &req.params);
                            script.push_str(&format!("{} = news; Rectangle({}) = {{{}, {}, 0, {}, {}, {}}};\n", shape_keep_var, shape_keep_var, x - w/2.0, y - h/2.0, w, h, r));
                        },
                        "circle" => {
                            let d = resolve_param(shape.get("diameter").unwrap_or(&serde_json::Value::Null), &req.params);
                            let r = d / 2.0;
                            script.push_str(&format!("{} = news; Disk({}) = {{{}, {}, 0, {}}};\n", shape_keep_var, shape_keep_var, x, y, r));
                        },
                        "polygon" => {
                            if let Some(pts_json) = shape.get("points").and_then(|p| p.as_array()) {
                                let mut raw_points: Vec<(f64, f64)> = Vec::new();
                                for pt in pts_json {
                                    let px = resolve_param(pt.get("x").unwrap_or(&serde_json::Value::Null), &req.params);
                                    let py = resolve_param(pt.get("y").unwrap_or(&serde_json::Value::Null), &req.params);
                                    raw_points.push((x + px, y + py));
                                }

                                // Sanitize points (dedup)
                                if raw_points.len() >= 3 {
                                    let mut clean = Vec::new();
                                    clean.push(raw_points[0]);
                                    for k in 1..raw_points.len() {
                                        let last = clean.last().unwrap();
                                        let curr = raw_points[k];
                                        let d = ((curr.0 - last.0).powi(2) + (curr.1 - last.1).powi(2)).sqrt();
                                        if d > 1e-5 { clean.push(curr); }
                                    }
                                    let first = clean[0];
                                    let last = clean.last().unwrap();
                                    if ((first.0 - last.0).powi(2) + (first.1 - last.1).powi(2)).sqrt() < 1e-5 && clean.len() > 1 {
                                        clean.pop();
                                    }

                                    if clean.len() >= 3 {
                                        script.push_str(&format!("// Polygon Keep Surface for {}\n", shape_keep_var));
                                        let mut p_tags = Vec::new();
                                        for (k, (cx, cy)) in clean.iter().enumerate() {
                                            let p_var = format!("{}_p{}", shape_keep_var, k);
                                            script.push_str(&format!("{} = newp; Point({}) = {{{}, {}, 0, 1.0}};\n", p_var, p_var, cx, cy));
                                            p_tags.push(p_var);
                                        }
                                        
                                        let mut l_tags = Vec::new();
                                        for k in 0..p_tags.len() {
                                            let p1 = &p_tags[k];
                                            let p2 = &p_tags[(k + 1) % p_tags.len()];
                                            let l_var = format!("{}_l{}", shape_keep_var, k);
                                            script.push_str(&format!("{} = newl; Line({}) = {{{}, {}}};\n", l_var, l_var, p1, p2));
                                            l_tags.push(l_var);
                                        }
                                        
                                        let ll_var = format!("{}_ll", shape_keep_var);
                                        script.push_str(&format!("{} = newll; Curve Loop({}) = {{{}}};\n", ll_var, ll_var, l_tags.join(", ")));
                                        script.push_str(&format!("{} = news; Plane Surface({}) = {{{}}};\n", shape_keep_var, shape_keep_var, ll_var));
                                    }
                                }
                            }
                        },
                        _ => {}
                    }

                    let v_keep_var = format!("v_keep_{}", i);
                    let list_keep_var = format!("out_keep_{}", i);

                    script.push_str(&format!("{}[] = Extrude {{0, 0, {}}} {{ Surface{{{}}}; }};\n", list_keep_var, remaining_height, shape_keep_var));
                    script.push_str(&format!("{} = {}[1];\n", v_keep_var, list_keep_var));
                    
                    script.push_str(&format!("res_union_{}[] = BooleanUnion{{ Volume{{ v_main_list[] }}; Delete; }}{{ Volume{{{}}}; Delete; }};\n", i, v_keep_var));
                    script.push_str(&format!("v_main_list[] = res_union_{}[];\n", i));
                }
            }
        }
    }

    script.push_str("Mesh.ElementOrder = 2; // Force 2nd Order (Tet10)\n"); // Script finished (Mesh commands handled by pipeline)
    script
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

fn parse_msh(path: &PathBuf) -> Result<TetMesh, String> {
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
        
        // --- NODES ---
        if section == "NODES_HEADER" { section = "NODES_BLOCK_HEADER"; continue; }
        if section == "NODES_BLOCK_HEADER" {
            let parts: Vec<&str> = trim.split_whitespace().collect();
            if parts.len() >= 4 {
                nodes_in_block = parts[3].parse().unwrap_or(0);
                if nodes_in_block > 0 {
                    section = "NODES_TAGS";
                    node_tags_buffer.clear();
                }
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
        
        // --- ELEMENTS ---
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
            // Check for Element Type 11 (10-node Tetrahedron)
            if current_elem_type == 11 && e_parts.len() > 1 {
                let node_tags = &e_parts[1..];
                if node_tags.len() >= 10 {
                     let mut idx = [0usize; 10];
                     for k in 0..10 {
                         idx[k] = *node_map.get(&node_tags[k]).unwrap_or(&0);
                     }
                     indices.push(idx);
                }
            } 
            // Also check for Type 4 (4-node Tet) as fallback?
            // If we get linear tets, we can't safely fill a [usize; 10]. 
            // We assume the geo script enforced Order=2.
            
            elems_in_block -= 1;
            if elems_in_block == 0 { section = "ELEMS_BLOCK_HEADER"; }
            continue;
        }
    }

    Ok(TetMesh { vertices, indices })
}

#[tauri::command]
pub async fn run_gmsh_pipeline(app_handle: tauri::AppHandle, req: FeaRequest) -> Result<FeaResult, String> {
    println!("[Rust] run_gmsh_pipeline INVOKED. Target Part Index: {:?}", req.part_index);
    use tauri::Manager;

    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_dir.exists() { let _ = fs::create_dir_all(&app_dir); }
    
    let start = SystemTime::now();
    let timestamp = start.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let geo_path = app_dir.join(format!("model_{}.geo", timestamp));
    let msh_2d_path = app_dir.join(format!("model_{}_2d.msh", timestamp));
    let msh_3d_path = app_dir.join(format!("model_{}_3d.msh", timestamp));

    // --- PHASE 1: Generate Geometry and 2D Mesh ---
    let mut script = generate_geo_script(&req, msh_2d_path.to_str().unwrap());
    
    // Append 2D mesh command
    script.push_str("Mesh 2;\n");
    script.push_str("Mesh.Format = 10;\n"); // MSH 4.1
    script.push_str(&format!("Save \"{}\";\n", msh_2d_path.to_str().unwrap().replace("\\", "/")));
    
    fs::write(&geo_path, &script).map_err(|e| format!("Failed to write .geo: {}", e))?;

    println!("[Rust] Running Gmsh Phase 1 (2D Surface Mesh)...");
    let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Analyzing Geometry (2D Pass)...", "percent": 10.0 }));

    let sidecar = app_handle.shell().sidecar("gmsh").map_err(|e| e.to_string())?;
    let (mut rx, child) = sidecar.args(&[geo_path.to_str().unwrap(), "-"]).spawn().map_err(|e| e.to_string())?;
    
    { *GMSH_CHILD.lock().unwrap() = Some(child); }
    
    // Wait for Phase 1
    while let Some(e) = rx.recv().await { 
        match e {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                print!("{}", String::from_utf8_lossy(&b));
            }
            _ => {}
        }
    }

    if !msh_2d_path.exists() {
        return Err("Gmsh failed to generate 2D mesh for analysis.".to_string());
    }

    // --- PHASE 2: Analyze Volumes ---
    println!("[Rust] Analyzing Volumes...");
    let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Identifying Volumes...", "percent": 30.0 }));

    let mesh_2d = parse_2d_triangle_mesh(&msh_2d_path)?;
    let _ = app_handle.emit("debug_mesh_2d", &mesh_2d);

    let target_idx = req.part_index.unwrap_or(0);
    let target_centroid = get_target_shell_centroid(&mesh_2d, target_idx);

    let mut centroid_script = String::new();
    if let Some(c) = target_centroid {
        println!("[Rust] DEBUG: Computed Shell Centroid: {:.4}, {:.4}, {:.4}", c.0, c.1, c.2);

        centroid_script.push_str("\n// --- FILTERING STEP ---\n");
        // Use high precision for coordinates
        centroid_script.push_str(&format!("target_x = {:.6}; target_y = {:.6}; target_z = {:.6};\n", c.0, c.1, c.2));
        
        centroid_script.push_str(r#"
        Printf("--- GMSH FILTERING DEBUG ---");
        Printf("Target Centroid: (%g, %g, %g)", target_x, target_y, target_z);
        
        v_list[] = Volume{:};
        count = #v_list[];
        Printf("Found %g Volumes in total.", count);
        
        best_dist = 1e22; 
        best_vol = -1;
        
        max_idx = count - 1;
        
        If (count > 0)
            For i In {0 : max_idx}
                vol_id = v_list[i];
                bb[] = BoundingBox Volume{ vol_id };
                
                // Simple Bounding Box Center
                mx = (bb[0]+bb[3])/2; 
                my = (bb[1]+bb[4])/2; 
                mz = (bb[2]+bb[5])/2;
                
                dist = Sqrt((mx-target_x)^2 + (my-target_y)^2 + (mz-target_z)^2);
                Printf("Checking Volume %g | BB Center: (%g, %g, %g) | Dist: %g", vol_id, mx, my, mz, dist);
                
                If (dist < best_dist)
                    best_dist = dist; 
                    best_vol = vol_id;
                EndIf
            EndFor
        EndIf
        
        Printf(">>> Result: Keeping Volume %g (Closest Dist: %g)", best_vol, best_dist);

        If (best_vol != -1)
            del_list[] = {};
            
            If (count > 0)
                For i In {0 : max_idx}
                    If (v_list[i] != best_vol) 
                        del_list[] += v_list[i]; 
                        Printf("Marking Volume %g for DELETION", v_list[i]);
                    EndIf
                EndFor
            EndIf
            
            If (#del_list[] > 0)
                Recursive Delete { Volume{ del_list[] }; }
                Printf("Deleted %g Volumes.", #del_list[]);
            Else
                Printf("No Volumes to delete (Only 1 existed?).");
            EndIf
        Else
             Printf("ERROR: Could not find best volume.");
        EndIf
        Printf("--- END FILTERING DEBUG ---");
        "#);
    } else {
        println!("[Rust] WARNING: No target centroid found. Skipping filtering (Mesh will contain all parts).");
    }

    // --- PHASE 3: 3D Mesh ---
    println!("[Rust] Running Gmsh Phase 2 (3D Volume Mesh)...");
    let _ = app_handle.emit("gmsh_progress", serde_json::json!({ "message": "Meshing 3D Volume...", "percent": 50.0 }));

    let final_geo_path = app_dir.join(format!("model_{}_final.geo", timestamp));
    // Use Include to restore state
    let mut final_script = format!("Include \"{}\";\n", geo_path.to_str().unwrap().replace("\\", "/"));
    
    // final_script.push_str("Delete Mesh;\n"); 
    final_script.push_str(&centroid_script);
    final_script.push_str("Mesh 3;\n");
    final_script.push_str("Mesh.Format = 10;\n");
    final_script.push_str(&format!("Save \"{}\";\n", msh_3d_path.to_str().unwrap().replace("\\", "/")));

    fs::write(&final_geo_path, &final_script).map_err(|e| e.to_string())?;

    let sidecar2 = app_handle.shell().sidecar("gmsh").map_err(|e| e.to_string())?;
    let (mut rx2, child2) = sidecar2.args(&[final_geo_path.to_str().unwrap(), "-"]).spawn().map_err(|e| e.to_string())?;
    
    { *GMSH_CHILD.lock().unwrap() = Some(child2); }
    
    let mut full_log = String::new();
    while let Some(e) = rx2.recv().await {
        match e {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                let s = String::from_utf8_lossy(&b);
                print!("{}", s);
                full_log.push_str(&s);
                let _ = app_handle.emit("gmsh_log", s.to_string());
            }
            _ => {}
        }
    }

    if !msh_3d_path.exists() {
         return Err(format!("Gmsh failed to generate 3D mesh.\nLogs:\n{}", full_log));
    }

    // Parse Result
    let mesh = parse_msh(&msh_3d_path)?;
    let (volume, surface_area) = mesh.compute_metrics();

    Ok(FeaResult {
        mesh,
        volume,
        surface_area,
        logs: full_log,
    })
}