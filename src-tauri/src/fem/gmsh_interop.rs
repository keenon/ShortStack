
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;
use crate::fem::mesh::TetMesh; // Assuming this exists from previous context

// Data structures matching your Typescript interfaces
#[derive(Deserialize, Debug)]
pub struct FeaRequest {
    pub footprint: serde_json::Value,
    pub stackup: Vec<serde_json::Value>,
    pub params: Vec<serde_json::Value>,
    pub quality: f64,
    pub target_layer_id: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct FeaResult {
    pub mesh: TetMesh,
    pub volume: f64,
    pub surface_area: f64,
    pub logs: String,
}

/// Generates a Gmsh .geo script using OpenCASCADE kernel
fn generate_geo_script(req: &FeaRequest, output_msh_path: &str) -> String {
    let mut script = String::new();
    
    // Header: Use OpenCASCADE for Boolean operations
    script.push_str("SetFactory(\"OpenCASCADE\");\n");
    script.push_str("Mesh.Algorithm3D = 10; // HXT algorithm (parallel, robust)\n");
    
    // Determine Global Mesh Size based on quality param (heuristic)
    let mesh_size = if req.quality > 0.0 { 10.0 / req.quality } else { 5.0 };
    script.push_str(&format!("Mesh.CharacteristicLengthMin = {};\n", mesh_size * 0.5));
    script.push_str(&format!("Mesh.CharacteristicLengthMax = {};\n", mesh_size));

    // --- GEOMETRY GENERATION ---
    // In a real implementation, you would traverse req.footprint['shapes']
    // recursively, resolving expressions via `meval` or similar in Rust.
    // For this proof of concept, we mock a simple boolean operation.
    
    // Example: Plate with a hole
    script.push_str("// --- Base Plate ---\n");
    script.push_str("Rectangle(1) = {-50, -50, 0, 100, 100, 5};\n"); // Rounded rect support in OCC
    
    script.push_str("// --- Cutout Hole ---\n");
    script.push_str("Disk(2) = {0, 0, 0, 20};\n");
    
    script.push_str("// --- Boolean Cut (2D Surface) ---\n");
    script.push_str("BooleanDifference(3) = { Surface{1}; Delete; }{ Surface{2}; Delete; };\n");
    
    script.push_str("// --- Extrusion (3D) ---\n");
    // Extrude the resulting surface (3) by 5mm in Z
    script.push_str("Extrude {0, 0, 5} { Surface{3}; }\n");

    // --- MESH GENERATION COMMANDS ---
    script.push_str("Mesh 3;\n"); // Generate 3D Mesh
    // Save format 4.1 (ASCII)
    script.push_str("Mesh.Format = 10;\n"); 
    script.push_str(&format!("Save \"{}\";\n", output_msh_path.replace("\\", "/")));
    
    script
}

/// Parses a Gmsh .msh file (Format 4.1 ASCII) into our TetMesh struct
fn parse_msh(path: &PathBuf) -> Result<TetMesh, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    
    // VERY Basic Parser for Gmsh 4.1
    // A robust parser would handle sections $Nodes and $Elements more gracefully
    
    let mut reading_nodes = false;
    let mut reading_elements = false;
    
    // Maps Gmsh Node Tag -> Index in our vertices vector
    let mut node_map = std::collections::HashMap::new(); 
    
    let mut iter = lines.iter();
    while let Some(line) = iter.next() {
        if line.starts_with("$Nodes") {
            reading_nodes = true;
            // Skip header info line in 4.1
            iter.next(); 
            continue;
        }
        if line.starts_with("$EndNodes") { reading_nodes = false; continue; }
        
        if line.starts_with("$Elements") {
            reading_elements = true;
            // Skip header info
            iter.next();
            continue;
        }
        if line.starts_with("$EndElements") { reading_elements = false; continue; }

        if reading_nodes {
            // Gmsh 4.1 Node logic is complex (blocks). 
            // Simplified logic: If line looks like "tag x y z", parse it.
            // Note: This is simplified. Real Gmsh 4.1 has blocks. 
            // For production, use format 2.2 (`Mesh.MshFileVersion = 2.2;`) 
            // or a proper parser crate. 
            // Here we assume 2.2 for simplicity of parsing implementation below:
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() == 4 {
                if let (Ok(id), Ok(x), Ok(y), Ok(z)) = (parts[0].parse::<usize>(), parts[1].parse::<f64>(), parts[2].parse::<f64>(), parts[3].parse::<f64>()) {
                    node_map.insert(id, vertices.len());
                    vertices.push([x, y, z]);
                }
            }
        }

        if reading_elements {
            // Format 2.2 Element: id type tags... node1 node2 ...
            // Type 4 = 4-node Tet
            // Type 11 = 10-node Tet
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() > 3 {
                let elem_type = parts[1].parse::<usize>().unwrap_or(0);
                
                // Handling 10-node Tetrahedrons
                if elem_type == 11 {
                    // Extract last 10 items
                    let count = parts.len();
                    if count >= 10 {
                        let raw_nodes = &parts[count-10..count];
                        let mut tet_indices = [0usize; 10];
                        let mut valid = true;
                        for (i, node_str) in raw_nodes.iter().enumerate() {
                            let tag = node_str.parse::<usize>().unwrap_or(0);
                            if let Some(&idx) = node_map.get(&tag) {
                                tet_indices[i] = idx;
                            } else {
                                valid = false;
                            }
                        }
                        if valid {
                            indices.push(tet_indices);
                        }
                    }
                }
            }
        }
    }

    Ok(TetMesh { vertices, indices })
}

#[tauri::command]
pub async fn run_gmsh_meshing(app_handle: tauri::AppHandle, req: FeaRequest) -> Result<FeaResult, String> {
    use tauri::Manager;

    // 1. Setup Paths
    let app_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_dir.exists() {
        let _ = fs::create_dir_all(&app_dir);
    }
    
    let geo_path = app_dir.join("temp_model.geo");
    let msh_path = app_dir.join("temp_model.msh");

    // 2. Generate Script
    // We force Gmsh 2.2 format for easier parsing in the mock function above
    let mut script = generate_geo_script(&req, msh_path.to_str().unwrap());
    script.push_str("Mesh.MshFileVersion = 2.2;\n");
    
    fs::write(&geo_path, &script).map_err(|e| format!("Failed to write .geo: {}", e))?;

    // 3. Resolve Sidecar
    // Note: In Tauri v2, sidecars are strictly managed. 
    // You must define `gmsh` in tauri.conf.json -> bundle -> externalBin
    let sidecar_command = app_handle.shell().sidecar("gmsh").map_err(|e| e.to_string())?;
    
    // 4. Execute Sidecar
    // args: path_to_geo, "-" (non-interactive)
    let output = sidecar_command
        .args(&[geo_path.to_str().unwrap(), "-"])
        .output()
        .await
        .map_err(|e| format!("Failed to run gmsh: {}", e.to_string()))?;

    if !output.status.success() {
        return Err(format!("Gmsh failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    // 5. Parse Output
    let mesh = parse_msh(&msh_path)?;

    // 6. Calculate Stats via Mesh Math
    let (volume, surface_area) = mesh.compute_metrics();

    Ok(FeaResult {
        mesh,
        volume,
        surface_area,
        logs: String::from_utf8_lossy(&output.stdout).to_string(),
    })
}
